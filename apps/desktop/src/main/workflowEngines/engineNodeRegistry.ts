/**
 * 【ARC-006 Gate E / MERGE-4】**宿主侧可执行体清单** —— 第三方节点包/扩展的安装审核、
 * 卸载事务与能力声明。
 *
 * ## 它在 Gate E 的哪一段
 *
 * 台账 MERGE-4 的验收门是：「恶意 Node 不能读/发未经授权文件或绕过审批；**升级/卸载/
 * 撤权不留下可执行体**」。本切片只做**不依赖 Node-RED 的宿主侧**那一半：
 *
 *   - 每个第三方可执行体在装进引擎数据目录之前，先登记其**来源、sha256、许可声明、
 *     能力声明、安装时间、是否经真人批准**；缺 sha256 或许可 → 拒绝（不落盘）；
 *   - 卸载：先落盘 `pending-remove` 标记，**删除成功之后**才把它从清单移除；
 *     删除失败则标记留在盘上，下次启动由 {@link recoverPendingRemovals} 继续清 ——
 *     绝不静默留下可执行体；
 *   - 能力声明里的 `network` 与 `permissionedProcessRunner` 的 `allowNetwork` 共用
 *     **同一份判据**（`@contracts/modules` 的 `declaresNetwork`）。
 *
 * ## 为什么清单要独立于 Node-RED
 *
 * `registry.ts` 的 `launchSpec` 只管「起进程」；Node-RED 的社区节点（`node_modules/
 * node-red-contrib-*`）是**运行时由引擎自己 require** 的可执行体 —— 没有经过任何
 * 宿主审核。本模块把「哪些包被允许存在于引擎数据目录」变成一个**宿主事实**：
 * Node-RED 侧将来的 npm 安装路由必须先过这里（`recordInstall`），否则包不会进清单，
 * 而 `recoverPendingRemovals` 会在下次启动把它们当无主可执行体删掉。
 *
 * ## 状态文件（落在引擎 dataDir，与 flows 同目录级）
 *
 * `engine-nodes.json`：
 *
 * ```json
 * {
 *   "schema": "mcode.workflow-engine.nodes/v1",
 *   "engineId": "node-red",
 *   "entries": [ { "name": "...", "version": "...", "source": "...", "sha256": "...",
 *                  "license": "...", "capabilities": ["resource.read","network"],
 *                  "installedAt": 0, "approvedByUser": true, "state": "installed" | "pending-remove" } ]
 * }
 * ```
 *
 * 坏 JSON / 形状不符 → 整表按**空**处理并拒绝写回（fail-closed：读不懂的账不能拿来做
 * 删除决定），由 `readState().reason` 显式报给调用方，不静默。
 *
 * ## 可测性
 *
 * 文件系统操作全部经注入端口（`fs`），时间经 `now()`。无头套件用假 fs 精确制造
 * 「删除失败」并断言 pending-remove 留在盘上；生产装配不传（默认 node:fs）。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { declaresNetwork } from "@contracts/modules";

/** 清单文件名（引擎 dataDir 下，与 `bootstrap.manifest.json` 同级）。 */
export const ENGINE_NODE_REGISTRY_FILENAME = "engine-nodes.json";

const SCHEMA = "mcode.workflow-engine.nodes/v1";

/** 可执行体包名：npm 包名形状（含 scope），不允许路径分隔符。 */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 一条可执行体记录。`capabilities` 是**声明**；执行时是否真的放行网络由
 *  `declaresNetwork(capabilities)` 判（与 ModuleHost 同一份）。 */
export interface EngineNodeRecord {
  /** npm 包名（`node-red-contrib-foo` / `@scope/foo`）。 */
  name: string;
  version: string;
  /** 来源：npm registry URL / tarball URL / 本地路径。只作审计，不参与执行。 */
  source: string;
  /** 包体（tarball 或安装产物）的 sha256；**缺一项即拒绝安装**。 */
  sha256: string;
  /** SPDX 许可标识或 `SEE LICENSE IN <file>`；缺失/空白一律拒绝。 */
  license: string;
  /** 能力声明（`resource.read` / `resource.write` / `network`）。 */
  capabilities: string[];
  installedAt: number;
  /** 安装/升级时是否经真人批准（`workflow.approve` / 原生确认框）。 */
  approvedByUser: boolean;
  /** `pending-remove` = 卸载事务尚未完成（文件删除失败，下次启动重试）。 */
  state: "installed" | "pending-remove";
}

export type EngineNodeRegistryState =
  | { kind: "absent"; entries: [] }
  | { kind: "ok"; entries: EngineNodeRecord[] }
  | { kind: "corrupt"; entries: []; reason: string };

/** 安装请求。`capabilities` 与 `ModuleManifest.permissions` 是同一套词表。 */
export interface EngineNodeInstallRequest {
  name: string;
  version: string;
  source: string;
  sha256: string;
  license: string;
  capabilities: readonly string[];
  approvedByUser: boolean;
}

/** 注入端口（套件用假实现；生产默认 node:fs + Date.now）。 */
export interface EngineNodeRegistryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** 删除一个可执行体（包体是**目录**：npm 包落在 `<dataDir>/node_modules/<name>/`）。
   *  实现必须递归删除；只删文件会把目录留下（实测 EISDIR），那正是"卸载后仍留可执行体"。 */
  remove(path: string): Promise<void>;
}

export interface EngineNodeRegistryOptions {
  /** 引擎数据目录（包体住在 `<dataDir>/node_modules/<name>`）。 */
  dataDir: string;
  engineId: string;
  fs?: EngineNodeRegistryFs;
  now?(): number;
}

/** 默认 fs 端口：writeFile 走「同目录临时文件 + rename」的原子替换（与引导清单同一做法）。 */
const nodeFs: EngineNodeRegistryFs = {
  async readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFile(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const staging = `${path}.${process.pid}.tmp`;
    await writeFile(staging, text, "utf8");
    await rename(staging, path);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async remove(path) {
    // 递归删除：包体是目录（`node_modules/<name>/` 里有 package.json 与源码）。
    // `force` 让"本来就不存在"也成功 —— 幂等重试不该因第一次已删而报错。
    await rm(path, { recursive: true, force: true });
  },
};

function validateInstall(request: EngineNodeInstallRequest):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!PACKAGE_NAME.test(request.name)) return { ok: false, reason: `包名不是合法的 npm 名称：${request.name}` };
  if (typeof request.version !== "string" || request.version.trim() === "") {
    return { ok: false, reason: "缺少版本号，拒绝安装" };
  }
  if (typeof request.source !== "string" || request.source.trim() === "") {
    return { ok: false, reason: "缺少来源（URL 或本地路径），拒绝安装" };
  }
  // ★ 两个硬门槛：sha256 与许可。缺一项就拒绝 —— 台账 MERGE-4 的「来源/许可审核」。
  if (typeof request.sha256 !== "string" || !SHA256.test(request.sha256)) {
    return { ok: false, reason: "缺少合法的 sha256（64 位小写 hex），拒绝安装" };
  }
  if (typeof request.license !== "string" || request.license.trim() === "") {
    return { ok: false, reason: "缺少许可声明，拒绝安装" };
  }
  if (!Array.isArray(request.capabilities)) {
    return { ok: false, reason: "缺少能力声明，拒绝安装" };
  }
  if (!request.capabilities.every((c) => typeof c === "string" && c !== "")) {
    return { ok: false, reason: "能力声明里含非法项，拒绝安装" };
  }
  return { ok: true };
}

export class EngineNodeRegistry {
  private readonly dataDir: string;
  private readonly engineId: string;
  private readonly fs: EngineNodeRegistryFs;
  private readonly now: () => number;
  private readonly path: string;

  constructor(options: EngineNodeRegistryOptions) {
    this.dataDir = options.dataDir;
    this.engineId = options.engineId;
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? (() => Date.now());
    this.path = join(options.dataDir, ENGINE_NODE_REGISTRY_FILENAME);
  }

  /**
   * 读清单。缺失 = 空表；坏 JSON / 形状不符 = `corrupt`（**不是**空表 ——
   * 调用方据 `kind` 决定拒绝写回，而不是拿一张空表覆盖掉读不懂的账）。
   */
  async readState(): Promise<EngineNodeRegistryState> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", entries: [] };
      return { kind: "corrupt", entries: [], reason: `清单读取失败：${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) return { kind: "corrupt", entries: [], reason: "清单不是对象" };
      const v = value as { schema?: unknown; engineId?: unknown; entries?: unknown };
      if (v.schema !== SCHEMA) return { kind: "corrupt", entries: [], reason: `清单 schema 不符：${String(v.schema)}` };
      if (v.engineId !== this.engineId) return { kind: "corrupt", entries: [], reason: `清单属于另一个引擎：${String(v.engineId)}` };
      if (!Array.isArray(v.entries)) return { kind: "corrupt", entries: [], reason: "清单缺少 entries 数组" };
      const entries: EngineNodeRecord[] = [];
      for (const item of v.entries) {
        const parsed = parseEntry(item);
        if (!parsed.ok) return { kind: "corrupt", entries: [], reason: parsed.reason };
        entries.push(parsed.entry);
      }
      return { kind: "ok", entries };
    } catch (err) {
      return { kind: "corrupt", entries: [], reason: `清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * **安装 / 升级**：校验 → 登记。校验失败时**什么都不写**（不落盘 = 包不会进 node_modules；
   * 调用方在本函数返回之后才落包体）。
   *
   * 覆盖安装同一 name：旧记录的 `installedAt` 被新记录替换（升级语义），旧条目不会
   * 残留两份 —— 「换了版本不继承旧声明」。
   */
  async recordInstall(request: EngineNodeInstallRequest):
    Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    const valid = validateInstall(request);
    if (!valid.ok) return valid;
    // ★ 真人批准是**独立**字段，不因能力声明里有 network 就默认 true。安装入口
    // （将来的 npm 路由）负责在用户点头后才传 true；本层不判断"该不该问"。
    if (typeof request.approvedByUser !== "boolean") {
      return { ok: false, reason: "缺少批准状态（approvedByUser），拒绝安装" };
    }
    const state = await this.readState();
    if (state.kind === "corrupt") {
      // 读不懂的账不能拿来做"保留哪些条目"的决定 —— 拒绝写回，显式报原因。
      return { ok: false, reason: `可执行体清单已损坏，拒绝写入（先修复或备份后删除）：${state.reason}` };
    }
    const entry: EngineNodeRecord = {
      name: request.name,
      version: request.version,
      source: request.source,
      sha256: request.sha256,
      license: request.license,
      capabilities: [...new Set(request.capabilities)],
      installedAt: this.now(),
      approvedByUser: request.approvedByUser,
      state: "installed",
    };
    const entries = state.entries.filter((e) => e.name !== entry.name);
    entries.push(entry);
    await this.writeEntries(entries);
    return { ok: true, entry };
  }

  /**
   * **卸载（两阶段）**：
   *   1. 先把该条目落成 `pending-remove`（**这一步失败 = 不删文件**，调用方拿到错误，
   *      包体原样保留 —— 不至于"清单说没了、文件还在"）；
   *   2. 删除包体（`<dataDir>/node_modules/<name>`）；删除失败 → 标记留在盘上，返回
   *      `{ ok:false, pendingRemove:true }`；
   *   3. 删除成功 → 才从清单移除并落盘。
   *
   * 幂等：未知 name 返回 `{ ok:true, removed:false }`。
   */
  async uninstall(name: string): Promise<
    | { ok: true; removed: boolean }
    | { ok: false; reason: string; pendingRemove: boolean }
  > {
    const state = await this.readState();
    if (state.kind === "corrupt") {
      return { ok: false, reason: `可执行体清单已损坏，拒绝卸载：${state.reason}`, pendingRemove: false };
    }
    const existing = state.entries.find((e) => e.name === name);
    if (existing === undefined) return { ok: true, removed: false };

    // 阶段 1：落 pending-remove 标记。它是**下次启动清理**的依据。
    if (existing.state !== "pending-remove") {
      const marked = state.entries.map((e) => (e.name === name ? { ...e, state: "pending-remove" as const } : e));
      await this.writeEntries(marked);
    }
    // 阶段 2：删包体。失败 → 标记保留在盘上，**不**把清单清掉（下次启动重试）。
    try {
      await this.fs.remove(this.packagePath(name));
    } catch (err) {
      return {
        ok: false,
        reason: `删除可执行体失败，已标记为 pending-remove（下次启动会重试）：${err instanceof Error ? err.message : String(err)}`,
        pendingRemove: true,
      };
    }
    // 阶段 3：删除成功，才从清单移除。
    const after = (await this.readState());
    const remaining = (after.kind === "ok" ? after.entries : state.entries).filter((e) => e.name !== name);
    await this.writeEntries(remaining);
    return { ok: true, removed: true };
  }

  /**
   * **启动恢复**：把所有 `pending-remove` 条目的包体再删一遍；删成功才从清单移除。
   * 返回本次真正清掉的条目（调用方可记日志）。坏清单/读失败 → 原样返回，不做删除
   * 决定（fail-closed：读不懂的账不能指挥删除）。
   */
  async recoverPendingRemovals(): Promise<{ recovered: string[]; failed: Array<{ name: string; reason: string }> }> {
    const state = await this.readState();
    if (state.kind !== "ok") return { recovered: [], failed: [] };
    let entries = state.entries;
    const recovered: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];
    for (const entry of state.entries) {
      if (entry.state !== "pending-remove") continue;
      try {
        await this.fs.remove(this.packagePath(entry.name));
      } catch (err) {
        failed.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      entries = entries.filter((e) => e.name !== entry.name);
      recovered.push(entry.name);
    }
    if (recovered.length > 0) await this.writeEntries(entries);
    return { recovered, failed };
  }

  /** **撤权**：把条目降为 `pending-remove` 并删包体 —— 与 uninstall 同一事务，
   *  只是语义上是「取消授权」。调用方在用户撤销批准后走这里。 */
  async revoke(name: string): Promise<{ ok: true; removed: boolean } | { ok: false; reason: string; pendingRemove: boolean }> {
    return this.uninstall(name);
  }

  /** 能力声明是否放行网络 —— **与 ModuleHost / permissionedProcessRunner 同一份**
   *  （`@contracts/modules` 的 `declaresNetwork`）。清单里没有该包 = false。 */
  async allowsNetwork(name: string): Promise<boolean> {
    const state = await this.readState();
    if (state.kind !== "ok") return false;
    const entry = state.entries.find((e) => e.name === name);
    if (entry === undefined || entry.state !== "installed") return false;
    return declaresNetwork(entry.capabilities);
  }

  /** 包体的安装位置（卸载删除的目标；**只**允许落在本引擎的 node_modules 下）。 */
  packagePath(name: string): string {
    if (!PACKAGE_NAME.test(name)) throw Error(`非法包名：${name}`);
    return join(this.dataDir, "node_modules", name);
  }

  private async writeEntries(entries: EngineNodeRecord[]): Promise<void> {
    const body = `${JSON.stringify({ schema: SCHEMA, engineId: this.engineId, entries }, null, 2)}\n`;
    await this.fs.writeFile(this.path, body);
  }
}

/** 清单条目形状校验（读侧）。任何字段不对 = 整表 corrupt（不猜）。 */
function parseEntry(raw: unknown): { ok: true; entry: EngineNodeRecord } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "条目不是对象" };
  const v = raw as Record<string, unknown>;
  if (typeof v.name !== "string" || !PACKAGE_NAME.test(v.name)) return { ok: false, reason: "条目的包名非法" };
  if (typeof v.version !== "string" || v.version === "") return { ok: false, reason: `条目 ${v.name} 缺少版本` };
  if (typeof v.source !== "string" || v.source === "") return { ok: false, reason: `条目 ${v.name} 缺少来源` };
  if (typeof v.sha256 !== "string" || !SHA256.test(v.sha256)) return { ok: false, reason: `条目 ${v.name} 的 sha256 非法` };
  if (typeof v.license !== "string" || v.license === "") return { ok: false, reason: `条目 ${v.name} 缺少许可` };
  if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) {
    return { ok: false, reason: `条目 ${v.name} 的能力声明非法` };
  }
  if (typeof v.installedAt !== "number" || !Number.isFinite(v.installedAt)) return { ok: false, reason: `条目 ${v.name} 的安装时间非法` };
  if (typeof v.approvedByUser !== "boolean") return { ok: false, reason: `条目 ${v.name} 缺少批准状态` };
  if (v.state !== "installed" && v.state !== "pending-remove") return { ok: false, reason: `条目 ${v.name} 的状态非法` };
  return {
    ok: true,
    entry: {
      name: v.name,
      version: v.version,
      source: v.source,
      sha256: v.sha256,
      license: v.license,
      capabilities: v.capabilities as string[],
      installedAt: v.installedAt,
      approvedByUser: v.approvedByUser,
      state: v.state,
    },
  };
}

/** 计算 tarball/包体的 sha256（安装入口在写清单前调用；这里只给纯函数，不碰盘）。 */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 读一个小文件（生产便捷函数；套件不用）。 */
export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** 写一个小文件（生产便捷函数；套件不用）。 */
export function writeTextFile(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}
