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
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { resolveProjectFlowDir } from "./projectFlowDir.js";
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
  // 每个节点必须是带 id/type 的对象 —— 只到这一层，不重写引擎的完整 schema。
  return flow["nodes"].every((n) => n !== null && typeof n === "object" && !Array.isArray(n)
    && typeof (n as Record<string, unknown>)["id"] === "string"
    && typeof (n as Record<string, unknown>)["type"] === "string");
}

/* ── 进程内串行队列：同一文件路径的"读-比-写"是一个临界区 ── */
const writeChains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 链尾只保留"完成"信号；失败不能卡住后来的任务。
  writeChains.set(key, next.catch(() => undefined));
  void next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  }).catch(() => undefined);
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
    mkdirSync(resolved.dir, { recursive: true });
    return resolved.dir;
  }

  private flowsDirOf(projectId: string | null | undefined): string {
    const dir = join(this.projectDir(projectId), FLOWS_SUBDIR);
    mkdirSync(dir, { recursive: true });
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
      dir = this.projectDir(projectId);
    } catch (err) {
      return { ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) };
    }
    const file = join(dir, FLOWS_SUBDIR, `${safeFlowFileName(valid.id)}.json`);
    if (!existsSync(file)) return { ok: false, kind: "missing", reason: `「${flowId}」不存在` };
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
    let file: string;
    try {
      file = this.filePathOf(projectId, valid.id);
    } catch (err) {
      return Promise.resolve({ ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) });
    }
    const expected = options.expectedRevision;
    if (expected !== null && typeof expected !== "string") {
      return Promise.resolve({ ok: false, kind: "io-error", reason: "expectedRevision 必须是字符串或 null" });
    }
    // docId 一致性（本次写入的内容自身）：缺失补上，不同 → 拒绝。
    const meta = (flow as { "x-mcode"?: Record<string, unknown> })["x-mcode"];
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

    return serialize(file, async () => {
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
        ...flow,
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
    const trust: FlowExecutableResult = flowExecutableUnderTrust(loaded.revision, readTrust(flowId));
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
      dir = this.flowsDirOf(projectId);
    } catch (err) {
      return { ok: false, kind: "invalid-project", reason: err instanceof Error ? err.message : String(err) };
    }
    const entries: ListFlowsEntry[] = [];
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
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      const corrupt = reason !== undefined || !looksLikeFlow(parsed);
      const docId = !corrupt && typeof (parsed as { "x-mcode"?: { docId?: unknown } })["x-mcode"]?.docId === "string"
        ? ((parsed as { "x-mcode": { docId: string } })["x-mcode"].docId)
        : null;
      entries.push({
        // 清单里没有原始 flowId（文件名是折叠过的）——docId 就是 flowId（保存时强制一致）；
        // 坏档没有 docId，回退到文件名供诊断。
        flowId: docId ?? name.replace(/\.json$/, ""),
        revision: corrupt ? null : flowRevision(parsed),
        docId,
        corrupt,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    return { ok: true, entries };
  }
}
