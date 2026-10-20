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
 * Node-RED 侧的 npm 安装路由必须先过宿主批准入口；但要注意：
 * `recoverPendingRemovals` **只清已标 pending-remove 的条目**，并不会自动发现/清理
 * 未登记的无主 node_modules 包体。真实引擎启动前枚举未登记可执行体并隔离仍是
 * ARC-006 未完成的信任边界，不能把本清单冒充 OS 级插件沙箱。
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
 * 坏 JSON / 形状不符 → `readState()` 返回显式 `corrupt` + reason（展示时 entries
 * 为空，但**不代表真实空账**）；拒绝写回和自动删除，宿主启动闸门因此拒绝启动。
 *
 * ## 可测性
 *
 * 文件系统操作全部经注入端口（`fs`），时间经 `now()`。无头套件用假 fs 精确制造
 * 「删除失败」并断言 pending-remove 留在盘上；生产装配不传（默认 node:fs）。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rmdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/** Stable Host identity of ONE approved package, shared by the approval
 * route and the exclusive registry write transaction. An absent registry is
 * distinct from an existing registry with no entry for this name. Corrupt
 * registries can never produce an approval fingerprint. */
export function engineNodeTargetFingerprint(state: EngineNodeRegistryState, name: string): string | null {
  if (state.kind === "corrupt") return null;
  if (state.kind === "absent") return "absent";
  return JSON.stringify(state.entries.find((entry) => entry.name === name) ?? null);
}

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
  /** 崩溃备份恢复专用；不提供时拒绝自动恢复，而不假装目录为空。 */
  listDir?(path: string): Promise<string[]>;
  /** 不跟随 symlink：备份必须是普通目录，目标一旦存在就不能自动覆盖。 */
  kindOf?(path: string): Promise<"directory" | "other" | "missing">;
  /** 可选跨 OS 进程的独占写事务：生产默认 fs 实现，测试假 fs 可不实现。
   * 调用方必须把整个读-改-写与包发布都包在同一事务中，不能只锁最后的 rename。 */
  withExclusiveWrite?<T>(path: string, task: () => Promise<T>): Promise<T>;
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
  /**
   * 不同 OS Node/Electron 进程之间，以 mkdir 无 recursive 的原子排它语义获取锁。
   * 拿不到锁必须等待或失败，绝不“假设旧锁已经过期”并清理别的进程的目录。
   * 如果上次进程硬崩溃，必须由宿主/用户在核对现场后人工解锁。
   * 该逻辑不对付有权修改 dataDir 的恶意同机进程，也不保证断电 fsync。
   */
  async withExclusiveWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
    const dataDir = dirname(path);
    await mkdir(dataDir, { recursive: true });
    // 启动验证只保护读侧：在真实安装/撤权/登记事务中，dataDir、
    // node_modules 或 @scope 本身若是 junction/软链接，任何 mkdir/rename/rm
    // 都可能通过父路径访问 dataDir 外的文件。必须在取锁及第一个写盘
    // 动作之前 fail-closed，不能等下次引擎启动才检查。
    const dataInfo = await lstat(dataDir);
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) {
      throw Error("Node-RED 插件清单数据根不是独立普通目录（拒绝目录链接）： " + dataDir);
    }
    const modules = join(dataDir, "node_modules");
    let moduleInfo: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      moduleInfo = await lstat(modules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (moduleInfo !== null) {
      if (!moduleInfo.isDirectory() || moduleInfo.isSymbolicLink()) {
        throw Error("Node-RED 插件安装父目录不是独立普通目录（拒绝链接）： " + modules);
      }
      // Scoped npm names add a second parent component. One scope junction
      // could otherwise let uninstall/rollback delete bytes outside dataDir.
      for (const dir of await readdir(modules, { withFileTypes: true })) {
        if (!dir.name.startsWith("@")) continue;
        const scopePath = join(modules, dir.name);
        const info = await lstat(scopePath);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw Error("Node-RED 插件 npm scope 不是独立普通目录（拒绝链接）： " + scopePath);
        }
      }
    }
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + 4000;
    for (;;) {
      try {
        await mkdir(lockPath); // 没有 recursive：同 OS 目录只能由一个持有者成功创建
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error("Node-RED 插件清单被其他进程占用或旧锁尚未人工核对：" + lockPath);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
      }
    }
    try {
      return await task();
    } finally {
      // 只释放自己成功拿到的目录；不允许 force/recursive，也不自动清理旧锁。
      await rmdir(lockPath);
    }
  },
  async readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFile(path, text) {
    await mkdir(dirname(path), { recursive: true });
    // 每次写清单独占私有暂存：固定 PID 临时名会覆盖上一轮崩溃残留，
    // 同进程多个 registry 实例也会互相踩踏（不等于跨进程账本 CAS）。
    const staging = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(staging, text, { encoding: "utf8", flag: "wx" });
      await rename(staging, path);
    } catch (error) {
      // 只清理我们这次随机创建的暂存，不得破坏他人/先前失败的文件。
      try { await rm(staging, { force: true }); } catch { /* 仍抛出原错 */ }
      throw error;
    }
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
  async listDir(path) {
    return readdir(path);
  },
  async kindOf(path) {
    try {
      const stats = await lstat(path);
      return stats.isDirectory() ? "directory" : "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  },
  async readTree(root) {
    // readdir(root) 会跟随指向 dataDir 外部的 symlink / Windows junction；
    // Dirent.isFile() 也识别不了 nlink>1 的硬链接文件。即使当前内容哈希相同，
    // 外部文件仍可经另一条路径被修改，破坏安装审批的可执行体边界。
    // 每层路径先 lstat；只接受真正的目录及独立普通文件。此静态检查不代替
    // open(O_NOFOLLOW)+fstat 或 OS 权限沙箱，stat/read 之间仍有 TOCTOU。
    const out: Array<{ path: string; bytes: Uint8Array }> = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const dirInfo = await lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
        throw Error(`包体目录不是原生普通目录（链接/结点被替换）：${prefix || "(root)"}`);
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.isFile()) {
          const fileInfo = await lstat(abs);
          if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) {
            throw Error(`包体脚本不是独立普通文件（拒绝硬链接/符号链接/设备文件）：${rel}`);
          }
          out.push({ path: rel, bytes: await readFile(abs) });
        } else {
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
  // ARC-006 Gate E：false 不能成为 installed 可执行体。
  // 只校验 boolean 会让未获批准的包体和 network 权限都实际落地。
  if (request.approvedByUser !== true) {
    return { ok: false, reason: "未取得真人安装审批，拒绝登记或安装可执行节点包" };
  }
  return { ok: true };
}

/**
 * 单 Node/Electron 主进程内，同一份 engine-nodes.json 的读-改-写事务必须串行。
 * 不同 EngineNodeRegistry 实例也共享此锁。跨 OS 进程仍需要独立的文件锁与 CAS；
 * 不能据此宣称多进程/断电完全安全。
 */
const nodeRegistryWriteTails = new Map<string, Promise<void>>();
async function withNodeRegistryWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = nodeRegistryWriteTails.get(key);
  let release!: () => void;
  const tail = new Promise<void>((done) => { release = done; });
  nodeRegistryWriteTails.set(key, tail);
  if (previous !== undefined) await previous;
  try {
    return await operation();
  } finally {
    if (nodeRegistryWriteTails.get(key) === tail) nodeRegistryWriteTails.delete(key);
    release();
  }
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

  /** 同进程共享队列 + 默认真实 FS 的跨 OS 排它；假 FS 端口走其显式实现或内存队列。 */
  private async withWriteTransaction<T>(task: () => Promise<T>): Promise<T> {
    return withNodeRegistryWriteLock(this.path, () =>
      this.fs.withExclusiveWrite !== undefined
        ? this.fs.withExclusiveWrite(this.path, task)
        : task(),
    );
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
      const names = new Set<string>();
      for (const item of v.entries) {
        const parsed = parseEntry(item);
        if (!parsed.ok) return { kind: "corrupt", entries: [], reason: parsed.reason };
        if (names.has(parsed.entry.name)) {
          return { kind: "corrupt", entries: [], reason: `清单存在重复包名，无法唯一确定批准身份：${parsed.entry.name}` };
        }
        names.add(parsed.entry.name);
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
    return this.withWriteTransaction(() => this.recordInstallUnlocked(request));
  }

  private async recordInstallUnlocked(request: EngineNodeInstallRequest):
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
    // pending-remove is an active revocation, not an ordinary installed
    // version. No direct recordInstall, tarball or directory installer may
    // silently turn it back into an approved executable during cleanup.
    if (state.entries.some((item) => item.name === request.name && item.state === "pending-remove")) {
      return { ok: false, reason: `节点包 ${request.name} 正在撤权或卸载，拒绝重新登记批准` };
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
    return this.withWriteTransaction(() => this.uninstallUnlocked(name));
  }

  private async uninstallUnlocked(name: string): Promise<
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
    return this.withWriteTransaction(() => this.recoverPendingRemovalsUnlocked());
  }

  private async recoverPendingRemovalsUnlocked(): Promise<{ recovered: string[]; failed: Array<{ name: string; reason: string }> }> {
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


  /**
   * 崩溃后的旧包恢复，只自动处理一种**能证明安全**的状态：
   * 可信清单含一条已批准 installed 记录、目标目录不存在、只有一个同名隐藏备份，
   * 而备份字节重算 sha256 与该记录完全一致。
   *
   * 若新旧目录同时存在、备份哈希不符、账本损坏/缺失或备份身份不明，一律保留
   * 现场并返回 blocked，宿主必须拒绝启动 Node-RED；不能猜哪个文件可以删。
   */
  async recoverCrashBackups(): Promise<{
    recovered: string[];
    blocked: Array<{ name: string; reason: string }>;
  }> {
    return this.withWriteTransaction(() => this.recoverCrashBackupsUnlocked());
  }

  private async recoverCrashBackupsUnlocked(): Promise<{
    recovered: string[];
    blocked: Array<{ name: string; reason: string }>;
  }> {
    const recovered: string[] = [];
    const blocked: Array<{ name: string; reason: string }> = [];
    const listDir = this.fs.listDir;
    if (!listDir) {
      return { recovered, blocked: [{ name: "*", reason: "当前文件系统未提供崩溃恢复目录扫描端口" }] };
    }
    let names: string[];
    try {
      names = await listDir(this.dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recovered, blocked };
      return { recovered, blocked: [{ name: "*", reason: `检查旧包备份目录失败：${error instanceof Error ? error.message : String(error)}` }] };
    }
    const candidates = names.filter((name) => name.startsWith(".engine-node-rollback-"));
    if (candidates.length === 0) return { recovered, blocked };

    const state = await this.readState();
    if (state.kind !== "ok") {
      return {
        recovered,
        blocked: candidates.map((name) => ({
          name,
          reason: state.kind === "corrupt" ? `无法读取受信清单：${state.reason}` : "受信清单不存在，不能判定旧包身份",
        })),
      };
    }
    const kindOf = this.fs.kindOf;
    const readTree = this.fs.readTree;
    if (!kindOf || !readTree) {
      return {
        recovered,
        blocked: candidates.map((name) => ({ name, reason: "缺少安全的目录类型/包体哈希检查端口" })),
      };
    }
    const claimed = new Map<string, Array<{ filename: string; entry: EngineNodeRecord }>>();
    for (const filename of candidates) {
      const matches = state.entries.filter((entry) =>
        filename.startsWith(`.engine-node-rollback-${sanitizeName(entry.name)}-`) &&
        /^[a-z0-9]+-[a-z0-9]{6,}$/.test(filename.slice(`.engine-node-rollback-${sanitizeName(entry.name)}-`.length)),
      );
      if (matches.length !== 1) {
        blocked.push({ name: filename, reason: "备份名称无法唯一对应受信清单中的插件" });
        continue;
      }
      const entry = matches[0]!;
      const current = claimed.get(entry.name) ?? [];
      current.push({ filename, entry });
      claimed.set(entry.name, current);
    }
    for (const [name, backups] of claimed) {
      if (backups.length !== 1) {
        blocked.push({ name, reason: "同一插件存在多个崩溃备份，不能推断正确的恢复版本" });
        continue;
      }
      const { filename, entry } = backups[0]!;
      if (entry.state !== "installed" || entry.approvedByUser !== true) {
        blocked.push({ name, reason: "原清单记录未被批准或已进入卸载事务，不能自动恢复" });
        continue;
      }
      const backup = join(this.dataDir, filename);
      const target = this.packagePath(name);
      try {
        const [backupKind, targetKind] = await Promise.all([kindOf(backup), kindOf(target)]);
        if (backupKind !== "directory") {
          blocked.push({ name, reason: "备份不是普通目录或已经消失，拒绝跟随软链接" });
          continue;
        }
        if (targetKind !== "missing") {
          blocked.push({ name, reason: "目标与备份同时存在或目标不是目录，需人工核对，禁止覆盖" });
          continue;
        }
        const files = await readTree(backup);
        const digest = files.length === 1 && files[0]?.path === "package.tgz"
          ? sha256OfBytes(files[0].bytes)
          : stableDirectoryHash(files);
        if (digest === null || digest !== entry.sha256) {
          blocked.push({ name, reason: "备份包体 sha256 与受信清单不符，拒绝自动恢复" });
          continue;
        }
        // 只有明确缺失的已批准包允许从唯一的校验通过备份恢复，且不修改清单。
        await this.fs.rename(backup, target);
        recovered.push(name);
      } catch (error) {
        blocked.push({ name, reason: `恢复旧包失败，备份原样保留：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { recovered, blocked };
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
    // 双重检查历史账：旧版本可能登记 approvedByUser:false 的 installed 项，
    // 即使记录尚未迁移，也绝不把 network 权限放出来。
    if (entry === undefined || entry.state !== "installed" || entry.approvedByUser !== true) return false;
    return declaresNetwork(entry.capabilities);
  }


  /**
   * 【ARC-006 Gate E】启动/新安装前核对所有已登记可执行体的磁盘字节。
   * 只有已获真人批准、已安装、原目录可读取、hash 与清单完全匹配才可执行。
   * 数据不一致时**只报 blocked**，绝不自动信任修改后的内容、删除用户数据或刷新哈希。
   *
   * 字节包 installFromBytes 的唯一 package.tgz 使用 sha256(bytes)；
   * 目录包 installFromDirectory 与 stableDirectoryHash 使用相同的路径+内容哈希。
   * 这不会扫描**未登记**包体或提供 OS 进程沙箱；后续 Gate E 仍要封堵该入口。
   */
  async verifyApprovedPackages(): Promise<{
    verified: string[];
    blocked: Array<{ name: string; reason: string }>;
  }> {
    const verified: string[] = [];
    const blocked: Array<{ name: string; reason: string }> = [];
    const state = await this.readState();
    if (state.kind === "corrupt") {
      return { verified, blocked: [{ name: "*", reason: `节点包清单已损坏：${state.reason}` }] };
    }
    if (state.kind === "absent") return { verified, blocked };
    for (const entry of state.entries) {
      if (entry.approvedByUser !== true || entry.state !== "installed") {
        blocked.push({ name: entry.name, reason: "插件没有真人安装批准，或卸载/撤权尚未完成" });
        continue;
      }
      if (!this.fs.readTree) {
        blocked.push({ name: entry.name, reason: "缺少可执行体完整性读取端口" });
        continue;
      }
      try {
        // 一个插件根目录可以是普通目录，但上一级 node_modules（或 @scope）
        // 却是指向 dataDir 外部的 junction/symlink。只检查包根的 lstat 不够。
        // 默认 fs.kindOf 使用 lstat，不跟随链接；即使批准记录与当前字节匹配
        // 也不能从另一个数据域载入可执行体。
        if (this.fs.kindOf) {
          const container = join(this.dataDir, "node_modules");
          const paths = entry.name.startsWith("@")
            ? [container, join(container, entry.name.split("/")[0]!)]
            : [container];
          for (const path of paths) {
            const kind = await this.fs.kindOf(path);
            if (kind !== "directory") {
              throw Error(`可执行体父目录不是独立普通目录（链接/缺失）：${path}`);
            }
          }
        }
        const files = await this.fs.readTree(this.packagePath(entry.name));
        const digest = files.length === 1 && files[0]?.path === "package.tgz"
          ? sha256OfBytes(files[0].bytes)
          : stableDirectoryHash(files);
        if (digest === null || digest !== entry.sha256) {
          blocked.push({ name: entry.name, reason: "可执行体与受信清单哈希不一致，拒绝启动" });
          continue;
        }
        verified.push(entry.name);
      } catch (error) {
        blocked.push({
          name: entry.name,
          reason: `读取可执行体失败/包体不存在：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { verified, blocked };
  }


  /**
   * ARC-006 Gate E: 扫描 dataDir/node_modules 中的 Node-RED 社区节点。
   * contrib 前缀即使清单缺失也可识别；其他包含 package.json 的 node-red.nodes
   * 也必须经真人批准。引擎 node-red / 官方 @node-red/nodes 的供应链另行核验。
   * 只返回阻断诊断，不更改磁盘；扫描→spawn 的 TOCTOU 尚未解决。
   */
  async findUnregisteredNodePackages(): Promise<{
    registered: string[];
    blocked: Array<{ name: string; reason: string }>;
  }> {
    const registered: string[] = [];
    const blocked: Array<{ name: string; reason: string }> = [];
    const state = await this.readState();
    if (state.kind === "corrupt") {
      return { registered, blocked: [{ name: "*", reason: "节点清单不可读：" + state.reason }] };
    }
    if (!this.fs.listDir) {
      return { registered, blocked: [{ name: "*", reason: "缺少安全扫描 node_modules 目录端口" }] };
    }
    const trusted = new Set(state.entries.map((entry) => entry.name));
    const moduleRoot = join(this.dataDir, "node_modules");
    const scopes: string[] = [];
    let topLevel: string[];
    try {
      if (this.fs.kindOf) {
        const containerType = await this.fs.kindOf(moduleRoot);
        if (containerType === "missing") return { registered, blocked };
        if (containerType !== "directory") {
          return { registered, blocked: [{ name: "*", reason: "node_modules 不是普通目录（链接/特殊文件），拒绝执行" }] };
        }
      }
      topLevel = await this.fs.listDir(moduleRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { registered, blocked };
      return { registered, blocked: [{ name: "*", reason: "扫描 node_modules 失败：" + (error instanceof Error ? error.message : String(error)) }] };
    }

    const inspectPackage = async (name: string): Promise<void> => {
      if (!PACKAGE_NAME.test(name)) {
        blocked.push({ name, reason: "目录名称不符合 npm 包规则，不能安全判定可执行体" });
        return;
      }
      if (name === "node-red" || name === "@node-red/nodes") return;
      if (trusted.has(name)) { registered.push(name); return; }
      if (name.startsWith("node-red-contrib-")) {
        blocked.push({ name, reason: "检测到未登记/未经真人批准的 Node-RED 社区可执行节点包" });
        return;
      }
      let raw: string;
      try {
        raw = await this.fs.readFile(join(moduleRoot, name, "package.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        blocked.push({ name, reason: "检查 npm 包声明失败：" + (error instanceof Error ? error.message : String(error)) });
        return;
      }
      try {
        const manifest: unknown = JSON.parse(raw);
        if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
          throw new Error("package.json 必须是普通对象");
        }
        const nodeRed = (manifest as Record<string, unknown>)["node-red"];
        if (typeof nodeRed === "object" && nodeRed !== null &&
            typeof (nodeRed as Record<string, unknown>).nodes === "object" &&
            (nodeRed as Record<string, unknown>).nodes !== null) {
          blocked.push({ name, reason: "package.json 声明 node-red.nodes，但不在宿主真人批准清单" });
        }
      } catch (error) {
        blocked.push({ name, reason: "无法核实 npm 包声明：" + (error instanceof Error ? error.message : String(error)) });
      }
    };
    for (const item of topLevel) {
      if (item.startsWith(".")) continue; // .bin / .staging 不是 npm 插件名
      if (item.startsWith("@")) {
        if (!/^@[a-z0-9][a-z0-9._-]*$/.test(item)) {
          blocked.push({ name: item, reason: "非法 npm scope 名称" });
        } else {
          scopes.push(item);
        }
      } else {
        await inspectPackage(item);
      }
    }
    for (const scope of scopes) {
      let items: string[];
      try {
        if (this.fs.kindOf && await this.fs.kindOf(join(moduleRoot, scope)) !== "directory") {
          blocked.push({ name: scope, reason: "npm scope 父目录不是普通目录（链接/特殊文件）" });
          continue;
        }
        items = await this.fs.listDir(join(moduleRoot, scope));
      } catch (error) {
        blocked.push({ name: scope, reason: "无法列出 npm scope：" + (error instanceof Error ? error.message : String(error)) });
        continue;
      }
      for (const item of items) await inspectPackage(scope + "/" + item);
    }
    return { registered, blocked };
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
   *   5. 若目标已存在，先将旧包 rename 到数据目录中的隐藏备份位，再原子发布新包；
   *   6. 写清单（沿用 `recordInstall`），成功后删除备份；清单写入抛错/拒绝时还原旧包。
   *
   * 进程内异常按同一事务回滚，保住已有可执行体和原账；首次安装失败则清理新包。
   * 但**硬崩溃**可能发生在「旧包进隐藏备份位 → 新包+清单发布」之间；此时旧字节
   * 仍在隐藏备份里，需要额外的崩溃启动恢复和跨进程锁验收，不能把这片当整包交付。
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
    return this.withWriteTransaction(() => this.installFromBytesUnlocked(meta, bytes));
  }

  private async installFromBytesUnlocked(
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
      // 只准备暂存包；已有可执行体由 publishStagedPackage 的备份/还原事务保护。
    } catch (error) {
      try { await fsPort.remove(staging); } catch { /* 清理失败不改变结论 */ }
      return { ok: false, reason: `安装落盘失败，已清理暂存目录：${error instanceof Error ? error.message : String(error)}` };
    }
    return this.publishStagedPackage(meta, staging);
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
    expectedTargetFingerprint?: string,
  ): Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    return this.withWriteTransaction(() =>
      this.installFromDirectoryUnlocked(meta, sourceDir, expectedTargetFingerprint));
  }

  private async installFromDirectoryUnlocked(
    meta: EngineNodeInstallRequest,
    sourceDir: string,
    expectedTargetFingerprint?: string,
  ): Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    const valid = validateInstall(meta);
    if (!valid.ok) return valid;
    // This check is INSIDE the same exclusive transaction that stages and
    // publishes the actual executable. No compliant Registry writer can
    // revoke or replace this approved identity after the guard and before
    // publication, unlike a read performed by the UI approval route.
    if (expectedTargetFingerprint !== undefined) {
      const lockedState = await this.readState();
      const actual = engineNodeTargetFingerprint(lockedState, meta.name);
      if (actual === null || actual !== expectedTargetFingerprint ||
          (lockedState.kind === "ok" &&
            lockedState.entries.some((entry) => entry.name === meta.name && entry.state === "pending-remove"))) {
        return { ok: false, reason: "审批期间节点包登记身份或撤权状态已改变，拒绝使用旧授权发布可执行体" };
      }
    }
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
      // 元数据检查通过后先只准备暂存包；旧包由统一发布事务保护。
    } catch (error) {
      try { await fsPort.remove(staging); } catch { /* 清理失败不改变结论 */ }
      return { ok: false, reason: `安装落盘失败，已清理暂存目录：${error instanceof Error ? error.message : String(error)}` };
    }
    return this.publishStagedPackage(meta, staging);
  }

  /**
   * 统一发布事务（字节包/目录包共用）：绝不先删旧包。
   *
   * 旧包先移到 dataDir 下的隐藏备份位（不在 node_modules，Node-RED 不会加载它）；
   * 新包落位 + 清单成功后才删备份。清单失败/抛异常时恢复旧包，
   * 包括同哈希重装。缺席的旧包（ENOENT）照常首次安装。
   * 这只是进程内失败回滚；崩溃中途的备份恢复及跨进程并发属于后续 Gate E。
   */
  private async publishStagedPackage(
    meta: EngineNodeInstallRequest,
    staging: string,
  ): Promise<{ ok: true; entry: EngineNodeRecord } | { ok: false; reason: string }> {
    const target = this.packagePath(meta.name);
    const backup = join(this.dataDir, `.engine-node-rollback-${sanitizeName(meta.name)}-${randomTag()}`);
    const fsPort = this.fs;
    let hadOld = false;
    let newPlaced = false;
    try {
      // npm scoped packages publish into node_modules/@scope/name. The staging
      // folder is unscoped, so the target's @scope parent may not exist yet.
      // Create the normal parent before rename; if it is a junction/link or
      // special file, do not publish anything there.
      if (meta.name.startsWith("@")) {
        const scope = meta.name.slice(0, meta.name.indexOf("/"));
        const scopeParent = join(this.dataDir, "node_modules", scope);
        await fsPort.mkdir(scopeParent);
        if (fsPort.kindOf && await fsPort.kindOf(scopeParent) !== "directory") {
          throw Error("Node-RED 插件 npm scope 不是普通目录（链接/特殊文件），拒绝发布：" + scopeParent);
        }
      }
      try {
        await fsPort.rename(target, backup);
        hadOld = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fsPort.rename(staging, target);
      newPlaced = true;
      // 发布事务已经占用相同清单锁，禁止再入 public recordInstall 造成死锁。
      const written = await this.recordInstallUnlocked(meta);
      if (!written.ok) throw new Error(written.reason);
      if (hadOld) {
        // 清单已成功发布；备份清理失败不可反过来撤销有效安装。
        // 备份存放在引擎 dataDir，而非 node_modules 下，不会被作为 Node 载入。
        try { await fsPort.remove(backup); } catch { /* 后续维护清理孤立的隐藏备份 */ }
      }
      return written;
    } catch (error) {
      let rollbackError: string | null = null;
      if (newPlaced) {
        try {
          await fsPort.remove(target);
        } catch (removeError) {
          rollbackError = `移走新包失败：${removeError instanceof Error ? removeError.message : String(removeError)}`;
        }
      }
      if (hadOld && rollbackError === null) {
        try {
          await fsPort.rename(backup, target);
        } catch (restoreError) {
          // 不删除 backup：即使最终路径还原失败，也不销毁可供手工恢复的原包。
          rollbackError = `还原旧包失败（原包保留在 ${backup}）：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
        }
      }
      try { await fsPort.remove(staging); } catch { /* 暂存清理失败不能抹掉最初的错误 */ }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `安装落盘失败：${reason}${rollbackError === null ? "" : `；回滚失败：${rollbackError}`}` };
    }
  }

  /** 同名不同哈希 → 拒绝（升级要显式 uninstall + 重装，见 installFromBytes 的说明）。
   *  同哈希重装 = 幂等（允许，覆盖同一份字节）。 */
  private async duplicateCheck(meta: EngineNodeInstallRequest): Promise<{ ok: false; reason: string } | null> {
    const state = await this.readState();
    // ARC-006 Gate E: 安装前就要 fail-closed。若等到 rename 之后由 recordInstall
    // 才拒绝坏账，安装失败的清理会把原有包体也删掉（旧可执行体与坏账一起丢失）。
    if (state.kind === "corrupt") {
      return { ok: false, reason: `可执行体清单已损坏，安装前拒绝替换任何包体：${state.reason}` };
    }
    if (state.kind === "absent") return null;
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
