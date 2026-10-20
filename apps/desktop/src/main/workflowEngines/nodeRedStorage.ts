/**
 * 【ARC-006 MERGE-1 第一步】**Node-RED flow 的宿主侧存储适配器（纯逻辑）**。
 *
 * ## 它解决什么
 *
 * 台账 P1-6：Node-RED 的 `flows.json` 与 Mcode 的 `WorkflowDoc/revision` 是**两套
 * 数据**——迁移器产出的 flow 一旦交给引擎，就没有宿主侧的 revision/CAS，两个客户端
 * 同时保存会后写赢；读坏档会静默变成空对象。本模块把「每条 flow 的保存/读取/列举」
 * 收成**一个可测的纯逻辑层**：
 *
 *   - 存储落点走 {@link resolveProjectFlowDir}（项目隔离，P1-7 已落地）；
 *   - 每条 flow 一个文件：`<projectDir>/flows/<safe-flow-id>.json`；
 *   - 单文件原子写走 `@main/lib/atomicFile.ts`（temp + fsync + rename）；
 *   - **保存带 CAS**：`expectedRevision` 与盘上现算的 revision 不一致 → `conflict`
 *     + `currentRevision`，**不写**；
 *   - **读坏档不装空**：坏 JSON / 形状不对 → `corrupt`（带原因），调用方必须显式处置。
 *
 * ## revision 算法
 *
 * 对 flow **规范化后的内容**做 SHA-256：
 *   - 对象键排序（插入顺序不影响 revision）；
 *   - `undefined` 字段丢弃（JSON 里本来也不存在）；
 *   - **数组顺序保留**（`wires` 的端口顺序、`nodes` 的文档顺序都是语义）。
 * 与 `workflowTrust.ts` 的 `workflowRevision` 同一套 canonical 规则（那边按
 * `WorkflowDoc` 的形状剪掉 updatedAt/icon/坐标；这边是 flow 形状，全量参与——flow
 * 里的坐标也是引擎要落盘的数据，不属于"执行无关"）。
 *
 * ## CAS 语义（逐条）
 *
 * | `expectedRevision` | 盘上 | 结果 |
 * |---|---|---|
 * | `null` | 不存在 | 创建，`{ ok: true, revision, created: true }` |
 * | `null` | 存在 | `conflict` + `currentRevision`（"以为在新建，其实有人先写了"） |
 * | 字符串 | 不存在 | `conflict` + `currentRevision: null`（"以为在改，其实被删了"） |
 * | 字符串 | 一致 | 覆盖写，`{ ok: true, revision }` |
 * | 字符串 | 不一致 | `conflict` + `currentRevision`（**不写**） |
 *
 * **并发**：同一 `(projectId, flowId)` 的保存经由进程内串行队列排队（读-比-写是
 * 一个临界区）；跨进程的 CAS 需要文件锁，属后续切片（见文件尾）。
 *
 * ## docId 不可漂移
 *
 * `flowId` 就是 Mcode 的 `WorkflowDoc.id`（与 `executorOwnership` 同一键）。保存时：
 *   - flow 的 `x-mcode.docId` 缺失 → 补上（等于 flowId）；
 *   - 已有且 ≠ flowId → 拒绝（`doc-id-drift`）；
 *   - 盘上已有同名 flow 且 docId 与本次不同 → 拒绝（防把另一条 workdoc 的内容写进
 *     这条 flow 的文件）。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { bindProjectDirectoryIdentity, ensureProjectDirectoryNoLinks, resolveProjectFlowDir } from "./projectFlowDir.js";
import type { NodeRedFlow } from "./flowMigration.js";
import {
  flowExecutableUnderTrust,
  type FlowExecutableResult,
  type FlowTrustRawReader,
} from "./flowTrustGate.js";

/** flow 文件所在子目录（相对项目目录）。 */
export const FLOWS_SUBDIR = "flows";

/** flowId 的长度上限与字符约束（与 projectId 同一档；flowId 也会进文件名）。 */
const MAX_FLOW_ID_LENGTH = 200;

export type NodeRedStorageResult<T> =
  | T
  | { ok: false; kind: "invalid-project" | "invalid-flow-id" | "missing" | "corrupt" | "conflict" | "doc-id-drift" | "io-error"; reason: string; currentRevision?: string | null };

export interface FlowFileRecord {
  flow: NodeRedFlow;
  revision: string;
}

/** 规范化：对象键排序、丢 undefined、数组保序（与 workflowTrust 的 canonical 同规）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .filter((key) => fields[key] !== undefined)
        .map((key) => [key, canonical(fields[key])]),
    );
  }
  return value;
}

/** flow 内容的 revision：规范化 JSON 的 SHA-256。 */
export function flowRevision(flow: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(flow))).digest("hex");
}

/** flowId 校验（空、空白首尾、路径分隔符、`.`/`..`、控制字符、超长 → 拒绝）。 */
export function validateFlowId(flowId: unknown): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof flowId !== "string") return { ok: false, reason: `flowId 必须是字符串（收到 ${typeof flowId}）` };
  if (flowId.trim().length === 0) return { ok: false, reason: "flowId 不能为空" };
  if (flowId !== flowId.trim()) return { ok: false, reason: "flowId 首尾不能包含空白字符" };
  if (flowId.length > MAX_FLOW_ID_LENGTH) return { ok: false, reason: `flowId 过长（${flowId.length} > ${MAX_FLOW_ID_LENGTH}）` };
  if (flowId === "." || flowId === "..") return { ok: false, reason: `flowId 不能是 ${JSON.stringify(flowId)}` };
  if (/[\\/]/.test(flowId)) return { ok: false, reason: "flowId 不能含路径分隔符（/ 或 \\）" };
  if (/^[A-Za-z]:/.test(flowId)) return { ok: false, reason: "flowId 不能是盘符路径" };
  if (/[\u0000-\u001f\u007f]/.test(flowId)) return { ok: false, reason: "flowId 不能含控制字符" };
  // Node UTF-8 把所有孤立 UTF-16 surrogate 都编码成同一 U+FFFD。
  // 不拒绝时两个本不相同的 id 会散列到同一文件，造成数据身份冲突。
  if (/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(flowId)) {
    return { ok: false, reason: "flowId 不能包含孤立 UTF-16 代理项" };
  }
  return { ok: true, id: flowId };
}

/** flowId → 文件名片段：白名单折叠 + 哈希后缀（防折叠碰撞，与 projectFlowDir 同规）。 */
export function safeFlowFileName(flowId: string): string {
  const folded = flowId.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const base = folded.length > 0 ? folded.slice(0, 40) : "flow";
  const hash = createHash("sha256").update(flowId, "utf8").digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/** 形状校验：必须是带 `nodes` 数组的对象（否则算 corrupt，不猜）。 */
function looksLikeFlow(value: unknown): value is NodeRedFlow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const flow = value as Record<string, unknown>;
  if (!Array.isArray(flow["nodes"])) return false;
  // Node-RED 以节点 id 作为 wires/部署关联的唯一身份。空/重复 id
  // 不仅是不完整的 JSON；后续节点定位和批准 revision 都会指向歧义对象。
  // 只校验引擎必需的身份边界，不在此复制 Node-RED 的全部节点 schema。
  const seen = new Set<string>();
  return flow["nodes"].every((n) => {
    if (n === null || typeof n !== "object" || Array.isArray(n)) return false;
    const id = (n as Record<string, unknown>)["id"];
    const type = (n as Record<string, unknown>)["type"];
    if (typeof id !== "string" || id.trim().length === 0
        || typeof type !== "string" || type.trim().length === 0
        || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 已落盘 flow 的 docId 是其身份，不能只用 nodes[] 判定可执行。 */
function storedDocId(flow: NodeRedFlow): string | null {
  const meta: unknown = (flow as { "x-mcode"?: unknown })["x-mcode"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const docId: unknown = (meta as Record<string, unknown>)["docId"];
  return typeof docId === "string" ? docId : null;
}

/* ── 进程内串行队列：同一文件路径的"读-比-写"是一个临界区 ── */
const writeChains = new Map<string, Promise<unknown>>();

/** 只读诊断：当前正在串行处理的不同 flow 数量（完成后必须归零）。 */
export function pendingFlowSaveQueues(): number { return writeChains.size; }

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 链尾只保留"完成"信号；失败不能卡住后来的任务。
  // Map 里放的是 settled，不是 next；清理也必须比对同一份 Promise。
  const settled = next.then(() => undefined, () => undefined);
  writeChains.set(key, settled);
  void settled.then(() => {
    if (writeChains.get(key) === settled) writeChains.delete(key);
  });
  return next;
}

export interface SaveFlowOptions {
  /** 上一次读到的 revision；`null` = 期望**新建**（盘上不应存在）。 */
  expectedRevision: string | null;
}

export type SaveFlowResult =
  | { ok: true; flowId: string; revision: string; created: boolean }
  | Extract<NodeRedStorageResult<never>, { ok: false }>;

export type LoadFlowResult =
  | { ok: true; flow: NodeRedFlow; revision: string }
  | Extract<NodeRedStorageResult<never>, { ok: false }>;

export interface ListFlowsEntry {
  flowId: string;
  revision: string | null;
  docId: string | null;
  corrupt: boolean;
  reason?: string;
}

export type ListFlowsResult =
  | { ok: true; entries: ListFlowsEntry[] }
  | Extract<NodeRedStorageResult<never>, { ok: false }>;

/**
 * 一个项目目录上的 flow 存储。`engineDir` 是引擎数据根（生产 = `dataDirOf`），
 * 每条 flow 一个文件 `<projectDir>/flows/<safe>.json`。
 */
export class NodeRedFlowStorage {
  constructor(private readonly engineDir: string) {}

  /** 项目目录（不存在时创建）。非法 projectId → 抛错（与 projectFlowDir 同口径）。 */
  projectDir(projectId: string | null | undefined): string {
    const resolved = resolveProjectFlowDir(this.engineDir, projectId);
    if (!resolved.ok) throw new Error(`非法 projectId：${resolved.reason}`);
    ensureProjectDirectoryNoLinks(this.engineDir, resolved.dir, resolved.legacy);
    if (!resolved.legacy) bindProjectDirectoryIdentity(resolved.dir, resolved.projectId);
    return resolved.dir;
  }

  /** A read must not create a never-used project directory/identity marker.
   * Once the directory exists, all read paths still pass projectDir() for
   * the normal full-ID marker and no-link checks. */
  private projectExistsForRead(projectId: string | null | undefined): boolean {
    const resolved = resolveProjectFlowDir(this.engineDir, projectId);
    if (!resolved.ok) throw new Error(`非法 projectId：${resolved.reason}`);
    try {
      lstatSync(resolved.dir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Ensure the final flows/ component is a real directory, not a junction.
   * A trusted project/ marker says nothing about user-editable descendants.
   * Both read and write entry points must pass through this same boundary. */
  private flowsDirOf(projectId: string | null | undefined, create = true): string {
    const dir = join(this.projectDir(projectId), FLOWS_SUBDIR);
    const check = (): boolean => {
      try {
        const stat = lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Node-RED flows/ 不是独立目录（链接或特殊文件），拒绝跨目录读写");
        }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    };
    if (!check() && create) mkdirSync(dir);
    // Verify again after creation, including when the directory already existed.
    check();
    return dir;
  }

  private filePathOf(projectId: string | null | undefined, flowId: string): string {
    return join(this.flowsDirOf(projectId), `${safeFlowFileName(flowId)}.json`);
  }

  /** 读一条 flow；不存在 → `missing`，坏档 → `corrupt`（**绝不**返回空对象）。 */
  loadFlow(projectId: string | null | undefined, flowId: string): LoadFlowResult {
    const valid = validateFlowId(flowId);
    if (!valid.ok) return { ok: false, kind: "invalid-flow-id", reason: valid.reason };
    let dir: string;
    try {
      if (!this.projectExistsForRead(projectId)) {
        return { ok: false, kind: "missing", reason: `「${flowId}」不存在` };
      }
      // A read must not create flows/, but it must check the same no-link
      // fence as the saving/listing paths before inspecting any flow bytes.
      dir = this.flowsDirOf(projectId, false);
    } catch (err) {
      return { ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) };
    }
    const file = join(dir, `${safeFlowFileName(valid.id)}.json`);
    // The file name is a capability boundary: never load a symlink, shared
    // hardlink, directory or special file as trusted flow bytes. A hardlink
    // can alias a valid-looking JSON file outside this managed project.
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        return { ok: false, kind: "corrupt", reason: "flow 存档必须是独立普通文件，拒绝链接或特殊文件" };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, kind: "missing", reason: `「${flowId}」不存在` };
      }
      return { ok: false, kind: "io-error", reason: err instanceof Error ? err.message : String(err) };
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, kind: "io-error", reason: err instanceof Error ? err.message : String(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, kind: "corrupt", reason: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!looksLikeFlow(parsed)) {
      return { ok: false, kind: "corrupt", reason: "形状不是 Node-RED flow（缺 nodes[] 或节点缺 id/type）" };
    }
    const docId = storedDocId(parsed);
    if (docId !== valid.id) {
      return { ok: false, kind: "corrupt",
        reason: `磁盘 flow 的 x-mcode.docId（${JSON.stringify(docId)}）与请求 flowId（${valid.id}）不一致；拒绝错绑身份` };
    }
    return { ok: true, flow: parsed, revision: flowRevision(parsed) };
  }

  /**
   * CAS 保存。读-比-写在一个进程内临界区里；不一致 → `conflict` + `currentRevision`，不写。
   */
  saveFlow(
    projectId: string | null | undefined,
    flowId: string,
    flow: NodeRedFlow,
    options: SaveFlowOptions,
  ): Promise<SaveFlowResult> {
    const valid = validateFlowId(flowId);
    if (!valid.ok) return Promise.resolve({ ok: false, kind: "invalid-flow-id", reason: valid.reason });
    // Snapshot untrusted caller input *before* entering the asynchronous
    // per-file save queue. Otherwise the caller can change nodes or metadata
    // after validation, and the queue would persist different bytes.
    // JSON round-trip also rejects cycles/BigInt/getters that cannot become
    // a durable Node-RED JSON archive, instead of rejecting via Promise throw.
    let inputSnapshot: NodeRedFlow;
    try {
      inputSnapshot = JSON.parse(JSON.stringify(flow)) as NodeRedFlow;
    } catch (err) {
      return Promise.resolve({
        ok: false, kind: "corrupt",
        reason: `待保存 flow 无法序列化为 JSON：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    // Validate the exact snapshot to be stored, not a mutable caller object.
    if (!looksLikeFlow(inputSnapshot)) {
      return Promise.resolve({ ok: false, kind: "corrupt", reason: "待保存 flow 形状非法（缺 nodes[] 或节点缺 id/type）" });
    }
    const suppliedMeta: unknown = (inputSnapshot as { "x-mcode"?: unknown })["x-mcode"];
    if (suppliedMeta !== undefined && suppliedMeta !== null &&
        (typeof suppliedMeta !== "object" || Array.isArray(suppliedMeta))) {
      return Promise.resolve({ ok: false, kind: "corrupt", reason: "x-mcode 元数据必须是对象" });
    }
    // Runtime IPC/MCP inputs are not guaranteed to satisfy the TS signature.
    // Validate before even creating the per-project flows/ directory.
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return Promise.resolve({ ok: false, kind: "io-error", reason: "保存参数必须包含 expectedRevision" });
    }
    const expected = options.expectedRevision;
    if (expected !== null && typeof expected !== "string") {
      return Promise.resolve({ ok: false, kind: "io-error", reason: "expectedRevision 必须是字符串或 null" });
    }
    // docId 一致性（本次写入的内容自身）：缺失补上，不同 → 拒绝。
    const meta = (inputSnapshot as { "x-mcode"?: Record<string, unknown> })["x-mcode"];
    if (meta !== undefined && meta !== null && typeof meta === "object") {
      const docId = meta["docId"];
      if (docId !== undefined && docId !== valid.id) {
        return Promise.resolve({
          ok: false,
          kind: "doc-id-drift",
          reason: `flow 的 x-mcode.docId（${JSON.stringify(docId)}）与 flowId（${valid.id}）不一致`,
        });
      }
    }
    // Only a completely validated payload may claim a project identity or
    // create its flows/ directory. In particular, a drifted docId is a
    // rejected request, not a reason to materialize new project metadata.
    let file: string;
    try {
      file = this.filePathOf(projectId, valid.id);
    } catch (err) {
      return Promise.resolve({ ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) });
    }

    return serialize(file, async () => {
      try {
        return await withOsFileLease(file, async () => {
      // 盘上现状
      let current: FlowFileRecord | null = null;
      if (existsSync(file)) {
        const loaded = this.loadFlow(projectId, valid.id);
        if (!loaded.ok) {
          // 坏档：**拒绝覆盖**（那会把用户还能手工抢救的内容写没）。调用方需先显式处置。
          return {
            ok: false as const,
            kind: loaded.kind === "missing" ? ("io-error" as const) : loaded.kind,
            reason: `盘上已有一份无法解析的 flow，拒绝覆盖：${loaded.reason}`,
            currentRevision: null,
          };
        }
        current = { flow: loaded.flow, revision: loaded.revision };
      }
      const currentRevision = current?.revision ?? null;
      if (expected !== currentRevision) {
        return {
          ok: false as const,
          kind: "conflict" as const,
          reason:
            expected === null
              ? `期望新建，但盘上已有「${valid.id}」`
              : currentRevision === null
                ? `期望修订 ${expected.slice(0, 12)}…，但盘上已不存在「${valid.id}」`
                : `修订冲突：期望 ${expected.slice(0, 12)}…，当前 ${currentRevision.slice(0, 12)}…`,
          currentRevision,
        };
      }
      // 盘上 docId 不可漂移（防止把另一条 workflow 的内容写进这条 flow 的文件）。
      const currentDocId = (current?.flow as { "x-mcode"?: Record<string, unknown> } | undefined)?.["x-mcode"]?.["docId"];
      if (typeof currentDocId === "string" && currentDocId !== valid.id) {
        return {
          ok: false as const,
          kind: "doc-id-drift" as const,
          reason: `盘上「${valid.id}」的 x-mcode.docId 是 ${JSON.stringify(currentDocId)}，与 flowId 不一致`,
          currentRevision,
        };
      }
      // 补齐 docId 再落盘（迁移器已有；手写 flow 也统一收口）。
      const nextFlow: NodeRedFlow = {
        ...inputSnapshot,
        "x-mcode": { ...(meta ?? {}), docId: valid.id },
      } as NodeRedFlow;
      const revision = flowRevision(nextFlow);
      try {
        await atomicReplaceFile(file, JSON.stringify(nextFlow, null, 2));
      } catch (err) {
        return { ok: false as const, kind: "io-error" as const, reason: err instanceof Error ? err.message : String(err), currentRevision };
      }
      return { ok: true as const, flowId: valid.id, revision, created: current === null };
        });
      } catch (err) {
        // Lease acquisition and directory revalidation may fail after the
        // request has already joined the queue. The public save API promises
        // an explicit result, not an unhandled rejected Promise.
        return { ok: false as const, kind: "io-error" as const,
          reason: `Flow 保存的跨进程租约/磁盘操作失败：${err instanceof Error ? err.message : String(err)}`,
          currentRevision: null };
      }
    });
  }

  /**
   * **可执行性判据**（MERGE-1 / P1-6）：这条 flow 的**这一版**能否在 trust 下执行。
   *
   * 顺序（与 `flowTrustGate.ts` 文件头一致）：调用方先过 owner 判据（身份），
   * 再过这里（内容许可）。本方法只回答后者：
   *   - 盘上不存在 / 读不出 → `missing` / `corrupt` 原样返回（不把"读不到"说成"没审批"）；
   *   - 盘上 revision 现算（不信任文件内自报值）后交给 `flowExecutableUnderTrust`：
   *     `untrusted` / `trust-corrupt` / `revision-mismatch` 三态可区分。
   *
   * @param readTrust 审批记录原文的读取面（生产 = `SettingRepo.get(workflow.review.v1.<id>)`；
   *                  测试注入）。不 import `workflowTrust.ts` 是为了让本模块保持叶子
   *                  （那边拖进 SettingRepo → DB）。
   */
  executableUnderTrust(
    projectId: string | null | undefined,
    flowId: string,
    readTrust: FlowTrustRawReader,
  ): { ok: true; approvedRevision: string } | { ok: false; kind: string; reason: string; approvedRevision?: string | null; currentRevision?: string | null } {
    const loaded = this.loadFlow(projectId, flowId);
    if (!loaded.ok) {
      return { ok: false, kind: loaded.kind, reason: loaded.reason, currentRevision: null };
    }
    let rawTrust: string | null | undefined;
    try {
      rawTrust = readTrust(flowId);
    } catch (err) {
      return { ok: false, kind: "io-error",
        reason: `审批记录读取失败，拒绝执行：${err instanceof Error ? err.message : String(err)}`,
        currentRevision: loaded.revision };
    }
    const trust: FlowExecutableResult = flowExecutableUnderTrust(loaded.revision, rawTrust);
    if (!trust.ok) {
      return {
        ok: false,
        kind: trust.reason,
        reason: trust.detail,
        approvedRevision: trust.approvedRevision,
        currentRevision: trust.currentRevision,
      };
    }
    return { ok: true, approvedRevision: trust.approvedRevision };
  }

  /** 只读清单：坏档**不静默跳过**，作为 `corrupt: true` 的条目如实列出。 */
  listFlows(projectId: string | null | undefined): ListFlowsResult {
    let dir: string;
    try {
      // Both a never-used project and an empty flows/ must remain untouched.
      // Do not claim a new project identity merely by opening a read-only UI.
      if (!this.projectExistsForRead(projectId)) return { ok: true, entries: [] };
      dir = this.flowsDirOf(projectId, false);
    } catch (err) {
      return { ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) };
    }
    const entries: ListFlowsEntry[] = [];
    if (!existsSync(dir)) return { ok: true, entries };
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch (err) {
      return { ok: false, kind: "io-error", reason: err instanceof Error ? err.message : String(err) };
    }
    for (const name of names) {
      const file = join(dir, name);
      let parsed: unknown = null;
      let reason: string | undefined;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error("flow 存档是硬/软链接或特殊文件，拒绝信任和执行");
        }
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      const wellFormed = reason === undefined && looksLikeFlow(parsed);
      const docId = wellFormed ? storedDocId(parsed as NodeRedFlow) : null;
      // 不可信文档可伪造 docId，必须核对该身份映射出的文件名恰是实际路径。
      const identityValid = docId !== null && validateFlowId(docId).ok
        && `${safeFlowFileName(docId)}.json` === name;
      const corrupt = !wellFormed || !identityValid;
      if (reason === undefined && !wellFormed) {
        reason = "磁盘 flow 形状非法（缺 nodes[] 或节点缺 id/type），需人工恢复";
      } else if (reason === undefined && !identityValid) {
        reason = `磁盘文件名与 x-mcode.docId 不匹配（声明：${JSON.stringify(docId)}），需人工恢复`;
      }
      entries.push({
        flowId: corrupt ? name.replace(/\.json$/, "") : docId!,
        revision: corrupt ? null : flowRevision(parsed),
        docId,
        corrupt,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    return { ok: true, entries };
  }
}
