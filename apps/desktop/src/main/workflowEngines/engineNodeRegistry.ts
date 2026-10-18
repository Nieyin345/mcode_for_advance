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
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

/** 注入端口（套件用假实现；生产默认 node:fs + Date.now）。
 *
 *  `readTree` / `writeBytes` 只有**安装入口**用（`installFromBytes` / `installFromDirectory`）；
 *  旧调用方（只登记清单 / 卸载）不需要它们 —— 缺失时安装入口显式拒绝（fail-closed），
 *  不会静默退化成"只登记不落盘"。 */
export interface EngineNodeRegistryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** 删除一个可执行体（包体是**目录**：npm 包落在 `<dataDir>/node_modules/<name>/`）。
   *  实现必须递归删除；只删文件会把目录留下（实测 EISDIR），那正是"卸载后仍留可执行体"。 */
  remove(path: string): Promise<void>;
  /** 写一个**二进制**文件（安装时把包体落到暂存目录）。父目录由实现创建。 */
  writeBytes?(path: string, bytes: Uint8Array): Promise<void>;
  /** 递归读一棵目录树，返回 `{ 相对路径(/-分隔), 内容 }`。symlink / 设备文件一律拒绝
   *  （fail-closed：包体里出现链接就可能把工作区外的内容带进安装目录）。 */
  readTree?(root: string): Promise<Array<{ path: string; bytes: Uint8Array }>>;
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
  async writeBytes(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async readTree(root) {
    const out: Array<{ path: string; bytes: Uint8Array }> = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.isFile()) {
          out.push({ path: rel, bytes: await readFile(abs) });
        } else {
          // symlink / FIFO / 设备文件：包体里出现它们就可能把安装目录外的内容带进来。
          throw Error(`包体里含不支持的文件类型（链接或设备文件）：${rel}`);
        }
      }
    };
    await walk(root, "");
    return out;
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

  /**
   * 【ARC-006 Gate E】**真实安装入口：从字节（tarball / 单文件包）安装**。
   *
   * ## 哈希规则
   *
   * 安装前用**传入字节**现算 sha256，与 `meta.sha256` 比对；不一致立即拒绝 ——
   * 此时**一个字节都还没落盘**（连暂存目录都不建）。这是「下载期校验」的落点：
   * 调用方（将来的 npm 路由）先下载到内存/临时文件，把字节交到这里再核一遍。
   *
   * ## 事务顺序（失败方向即判据）
   *
   *   1. 形状校验（`validateInstall`：包名/版本/来源/sha256/许可/能力/批准）；
   *   2. 字节 sha256 == meta.sha256？（拒绝路径零落盘）；
   *   3. 同名不同哈希 → 显式拒绝（见下）；
   *   4. 写 `<dataDir>/node_modules/.staging-<name>-<随机>/package.tgz`；
   *   5. 原子 rename 到 `<dataDir>/node_modules/<name>`（同盘 rename；失败删暂存目录）；
   *   6. 写清单（沿用 `recordInstall` 的同一事务）。
   *
   * 任一步失败：暂存目录被删（不留半截），清单不写（`recordInstall` 在最后一步才写）。
   * 注意第 5 步与第 6 步之间若崩溃，会出现「包体在、清单无记录」—— 这是**收紧**方向
   * （`recoverPendingRemovals` 只清 pending-remove，不会误删它；下次安装同包会覆盖，
   * 清单随之补上），不会留下「清单说有、实际没有」的假象。
   *
   * ## 同名不同哈希
   *
   * **显式拒绝**，不静默走升级：升级是一次需要重新审核（许可/能力/真人批准）的动作，
   * 自动接受一个哈希不同的包等于让"换掉可执行体"绕过审核。调用方要升级，先
   * `uninstall(name)`（两阶段事务，确保旧可执行体真的被删）再装新版本。
   */
  async installFromBytes(
    meta: EngineNodeInstallRequest,
    bytes: Uint8Array,
  ): Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    const valid = validateInstall(meta);
    if (!valid.ok) return valid;
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "包体不是字节数组，拒绝安装" };
    const actual = sha256OfBytes(bytes);
    if (actual !== meta.sha256) {
      return { ok: false, reason: `包体 sha256 与声明的值不一致（声明 ${meta.sha256}，实际 ${actual}），拒绝安装` };
    }
    const fsPort = this.fs;
    if (fsPort.writeBytes === undefined) {
      return { ok: false, reason: "当前宿主没有安装写盘通道，已拒绝安装（fail-closed）" };
    }
    const duplicate = await this.duplicateCheck(meta);
    if (duplicate !== null) return duplicate;

    const staging = join(this.dataDir, "node_modules", `.staging-${sanitizeName(meta.name)}-${randomTag()}`);
    try {
      await fsPort.mkdir(staging);
      await fsPort.writeBytes(join(staging, "package.tgz"), bytes);
      // 原子落位：先将暂存目录 rename 到最终位置（若目标已存在，先删 —— 只有
      // 同哈希重装会走到这里，删掉的是同一份字节）。
      const target = this.packagePath(meta.name);
      await fsPort.remove(target);
      await fsPort.rename(staging, target);
    } catch (error) {
      try { await fsPort.remove(staging); } catch { /* 清理失败不改变结论 */ }
      return { ok: false, reason: `安装落盘失败，已清理暂存目录：${error instanceof Error ? error.message : String(error)}` };
    }
    // 清单事务（与 recordInstall 同一份实现；它内部会再校验一次形状）。
    const recorded = await this.recordInstall(meta);
    if (!recorded.ok) {
      // 清单没写成 → 包体也不能留（否则是「有可执行体、账上没有」）。
      try { await fsPort.remove(this.packagePath(meta.name)); } catch { /* 同上 */ }
      return recorded;
    }
    return recorded;
  }

  /**
   * 【ARC-006 Gate E】**真实安装入口：从目录（Node-RED 节点包）安装**。
   *
   * ## 哈希规则（稳定哈希）
   *
   * 按**相对路径排序**后，对每个文件累计 `sha256(相对路径 + "\u0000" + sha256(内容) + "
")`。
   * 排序消除了文件系统枚举顺序的随机性；内层是内容哈希而不是内容本身，避免大包
   * 撑爆内存。路径统一用 `/` 分隔（Windows/macOS/Linux 同一份包得到同一个哈希）。
   * 校验时用同一规则对 `meta.sha256` 比对。
   *
   * 其余事务顺序、同名不同哈希的拒绝、失败清理与 {@link installFromBytes} 完全一致；
   * 目录内容按原样复制到暂存目录（保留相对路径），再原子 rename。
   */
  async installFromDirectory(
    meta: EngineNodeInstallRequest,
    sourceDir: string,
  ): Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    const valid = validateInstall(meta);
    if (!valid.ok) return valid;
    const fsPort = this.fs;
    if (fsPort.readTree === undefined || fsPort.writeBytes === undefined) {
      return { ok: false, reason: "当前宿主没有目录安装通道，已拒绝安装（fail-closed）" };
    }
    let files: Array<{ path: string; bytes: Uint8Array }>;
    try {
      files = await fsPort.readTree(sourceDir);
    } catch (error) {
      return { ok: false, reason: `读取包体目录失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (files.length === 0) return { ok: false, reason: "包体目录为空，拒绝安装" };
    const actual = stableDirectoryHash(files);
    if (actual !== meta.sha256) {
      return { ok: false, reason: `包体目录的稳定哈希与声明的值不一致（声明 ${meta.sha256}，实际 ${actual}），拒绝安装` };
    }
    const duplicate = await this.duplicateCheck(meta);
    if (duplicate !== null) return duplicate;

    const staging = join(this.dataDir, "node_modules", `.staging-${sanitizeName(meta.name)}-${randomTag()}`);
    try {
      await fsPort.mkdir(staging);
      for (const file of files) {
        // 相对路径来自 readTree（已拒绝链接）；再挡一次 `..` / 绝对路径（防御纵深）。
        const relative = normalizeRelative(file.path);
        if (relative === null) throw Error(`包体里的路径非法：${file.path}`);
        await fsPort.writeBytes(join(staging, relative), file.bytes);
      }
      const target = this.packagePath(meta.name);
      await fsPort.remove(target);
      await fsPort.rename(staging, target);
    } catch (error) {
      try { await fsPort.remove(staging); } catch { /* 清理失败不改变结论 */ }
      return { ok: false, reason: `安装落盘失败，已清理暂存目录：${error instanceof Error ? error.message : String(error)}` };
    }
    const recorded = await this.recordInstall(meta);
    if (!recorded.ok) {
      try { await fsPort.remove(this.packagePath(meta.name)); } catch { /* 同上 */ }
      return recorded;
    }
    return recorded;
  }

  /** 同名不同哈希 → 拒绝（升级要显式 uninstall + 重装，见 installFromBytes 的说明）。
   *  同哈希重装 = 幂等（允许，覆盖同一份字节）。 */
  private async duplicateCheck(meta: EngineNodeInstallRequest): Promise<{ ok: false; reason: string } | null> {
    const state = await this.readState();
    if (state.kind !== "ok") return null; // absent 正常；corrupt 由 recordInstall 统一拒绝
    const existing = state.entries.find((e) => e.name === meta.name);
    if (existing === undefined) return null;
    if (existing.sha256 === meta.sha256) return null;
    return {
      ok: false,
      reason: `已安装同名包 ${meta.name}（版本 ${existing.version}，sha256 ${existing.sha256}）。换包体必须先卸载（uninstall）再安装，不能静默替换可执行体。`,
    };
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

/**
 * 【ARC-006 Gate E】**目录包的稳定哈希**（与 `installFromDirectory` 的校验同一份）。
 *
 * 规则：按**相对路径**（统一 `/` 分隔）排序；对每个文件累计
 * `sha256(路径 + "\u0000" + sha256(内容) + "
")`。
 *
 * - 排序消除文件系统枚举顺序的随机性（同一份包在任何机器上得到同一个哈希）；
 * - 内层用内容哈希而不是内容本体，避免大包占内存；
 * - 路径统一分隔符：Windows 产出的包与 Linux 产出的包不会因 `\` vs `/` 失配。
 *
 * 返回 `null` 表示输入形状非法（空表 / 重复路径 / 非法路径）—— 调用方必须**拒绝**，
 * 不能拿一个"看起来像哈希"的值继续。
 */
export function stableDirectoryHash(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const normalized: Array<{ path: string; digest: string }> = [];
  const seen = new Set<string>();
  for (const file of files) {
    const relative = normalizeRelative(file.path);
    if (relative === null) return null;
    if (seen.has(relative)) return null; // 重复路径 = 形状非法（复制时会互相覆盖）
    seen.add(relative);
    if (!(file.bytes instanceof Uint8Array)) return null;
    normalized.push({ path: relative, digest: sha256OfBytes(file.bytes) });
  }
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of normalized) {
    hash.update(`${file.path}\u0000${file.digest}\n`);
  }
  return hash.digest("hex");
}

/** 相对路径归一：统一 `/`；拒绝绝对路径、`..` 段、空段、盘符、NUL。非法返回 null。 */
function normalizeRelative(raw: string): string | null {
  if (typeof raw !== "string" || raw === "" || raw.includes("\u0000")) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts = slashed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** 暂存目录名里只用安全字符（包名可能带 `@scope/`，不能原样进文件系统路径）。 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9._-]/gi, "-").slice(0, 80);
}

/** 暂存目录的随机后缀（时间 + 随机，避免并发安装撞名）。 */
function randomTag(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 读一个小文件（生产便捷函数；套件不用）。 */
export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** 写一个小文件（生产便捷函数；套件不用）。 */
export function writeTextFile(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}
