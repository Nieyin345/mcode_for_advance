/** T58/T2: mirror a successful, authenticated native POST /flows into existing Mcode docs.
 * Do not fabricate library records for standalone Node-RED tabs or let the
 * editor bypass the shared workflow validation / review / CAS save boundary.
 *
 * ## Not one transaction (T2 / legacy T93 NR-M1)
 *
 * Node-RED commits `POST /flows` to its own `flows.json`; the Mcode SQL library
 * is a **different store**. There is no cross-store atomic commit and this file
 * never claims one. A failed mirror is modelled honestly as the recoverable
 * intermediate state **“native deploy committed, library mirror pending
 * reconciliation”**:
 *
 *   - the pending intent is recorded **durably and synchronously** (before any
 *     await) in `<engine dataDir>/deploy-reconciliation.json`;
 *   - each document is mirrored independently through the same guarded CAS save;
 *     failures are classified as `conflict` (the SQL document changed under us —
 *     never auto-overwritten, not even on automatic retry) or `failed` (save
 *     rejected while the SQL revision is unchanged);
 *   - `retryPending` replays the pending documents against the *current* native
 *     `flows.json`; engine start and the next confirmed deploy invoke it
 *     automatically, so the user never has to compare the two stores by hand;
 *   - one broken document never aborts the rest (partial success is reported
 *     per document; already-mirrored documents are not “rolled back”), and the
 *     executor owner is never released because of a mirror failure.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceFileSync } from "@main/lib/atomicFile.js";
import { log } from "@main/lib/logger.js";
import { flowToWorkflowDoc, type NodeRedNode, type NodeRedFlow } from "./flowMigration.js";
import type { WorkflowDoc } from "@contracts/workflow";
import type { RuntimeEvent, WorkflowNodeResultEvent } from "@contracts/runtime";

export interface NativeLibrarySyncPorts {
  get(id: string): WorkflowDoc | null;
  save(doc: WorkflowDoc, expectedRevision: string): Promise<{ ok: boolean; error?: string }>;
  revision(doc: WorkflowDoc): string;
  changed(id: string): void;
}

const MAX_ERROR_LENGTH = 300;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
}

/** A native deploy is a whole graph: each tagged tab must be isolated by z.
 * Reject missing/ambiguous membership rather than folding unrelated tabs or
 * global config nodes into a WorkflowDoc. Caller already owns POST /flows.
 */
export function nativeLibraryDocsOf(nodes: unknown): WorkflowDoc[] {
  if (!Array.isArray(nodes)) throw new Error("Node-RED deploy payload is not a node list");
  const parsed = nodes as NodeRedNode[];
  const docs: WorkflowDoc[] = [];
  const ids = new Set<string>();
  for (const tab of parsed) {
    if (tab?.type !== "tab" || tab["x-mcode"] === undefined) continue;
    const meta = tab["x-mcode"] as Record<string, unknown>;
    const docId = meta?.docId;
    if (typeof docId !== "string" || !docId || ids.has(docId)) {
      throw new Error("Node-RED deploy has an invalid/duplicate Mcode doc identity");
    }
    // Same identity rule as nodeRedOwnership.nativeFlowIdsOfNodes (this id is
    // also a durable ledger key): bounded length, no control characters.
    if (docId.length > 512 || docId.trim() !== docId || /[\u0000-\u001f\u007f]/.test(docId)) {
      throw new Error("Node-RED deploy has an invalid Mcode doc identity");
    }
    ids.add(docId);
    const members = parsed.filter(n => n.type !== "tab" && n.z === tab.id);
    // Mcode-owned nodes must stay in their original tab. Moving a node to an
    // unrelated tab loses that association and cannot be silently re-imported.
    const flow: NodeRedFlow = {
      id: tab.id,
      label: typeof tab.label === "string" ? tab.label : "",
      nodes: [tab, ...members],
    };
    const doc = flowToWorkflowDoc(flow);
    if (doc.id !== docId) throw new Error("Node-RED document identity mismatch");
    docs.push(doc);
  }
  return docs;
}

/** Whether a native payload carries any Mcode-owned tab at all. Pure and cheap;
 * production uses it to skip the whole mirror (and its ledger) for native-only
 * Node-RED graphs. */
export function nativePayloadHasMcodeTabs(nodes: unknown): boolean {
  return Array.isArray(nodes) && nodes.some(
    (n: unknown) => n !== null && typeof n === "object"
      && (n as NodeRedNode).type === "tab" && (n as NodeRedNode)["x-mcode"] !== undefined,
  );
}

/** One document's mirror outcome. `skipped-native-only` and `skipped-deleted`
 * are *resolved* non-errors: native-only / deleted documents MUST NOT be
 * upserted (T58). `removed` means a retry found the tab no longer in the native
 * canvas, so there is nothing left to mirror. `superseded` means this receipt
 * is older than a deploy already applied (or a newer pending intent) for the
 * same document — a duplicate/late ACK must never overwrite newer content. */
export type MirrorDocStatus = "mirrored" | "conflict" | "failed" | "skipped-native-only" | "skipped-deleted" | "removed" | "superseded";

export interface MirrorDocResult {
  docId: string;
  status: MirrorDocStatus;
  /** SQL revision the save was issued against (null when unknown/absent). */
  expectedRevision: string | null;
  /** SQL revision observed *after* the attempt; differs from expected ⇒ conflict. */
  observedRevision: string | null;
  error?: string;
}

export interface NativeMirrorReport {
  /** Content identity of the native deploy this report belongs to ("" for a
   * retry that re-read the on-disk canvas, or for a no-op). */
  deployId: string;
  at: number;
  /** True when every document is mirrored or legitimately skipped. */
  ok: boolean;
  docs: MirrorDocResult[];
}

/** Mirror exactly one document through the guarded CAS save. Never throws: a
 * rejected save is classified by re-reading the document, so a CAS conflict
 * (someone edited the SQL side, or a previous interrupted attempt already
 * wrote it) is distinguishable from a validation failure without parsing
 * error strings. */
async function mirrorOneDoc(doc: WorkflowDoc, ports: NativeLibrarySyncPorts, saveTimeoutMs = SAVE_TIMEOUT_MS): Promise<MirrorDocResult> {
  let expectedRevision: string | null = null;
  try {
    const existing = ports.get(doc.id);
    if (!existing) {
      return { docId: doc.id, status: "skipped-native-only", expectedRevision: null, observedRevision: null };
    }
    expectedRevision = ports.revision(existing);
    // `saveTimeoutMs <= 0` keeps the T58 compatibility wrapper on the exact
    // original timing (no extra timer/microtask hop): its callers await once.
    const saved = saveTimeoutMs > 0
      ? await withTimeout(ports.save(doc, expectedRevision), saveTimeoutMs, "工作流库保存在限定时间内没有完成")
      : await ports.save(doc, expectedRevision);
    const observed = ports.get(doc.id);
    const observedRevision = observed === null ? null : ports.revision(observed);
    if (saved.ok) {
      ports.changed(doc.id);
      return { docId: doc.id, status: "mirrored", expectedRevision, observedRevision };
    }
    const error = saved.error ?? "rejected";
    if (observed === null) {
      return { docId: doc.id, status: "skipped-deleted", expectedRevision, observedRevision: null, error };
    }
    if (observedRevision !== expectedRevision) {
      return { docId: doc.id, status: "conflict", expectedRevision, observedRevision, error };
    }
    return { docId: doc.id, status: "failed", expectedRevision, observedRevision, error };
  } catch (err) {
    return { docId: doc.id, status: "failed", expectedRevision, observedRevision: null, error: errText(err) };
  }
}

/** T58 compatibility wrapper: throw on the first non-skipped failure and return
 * the ids that were mirrored. Kept for callers/tests that assert the strict
 * fail-fast shape; the production mirror path records per-document results.
 */
export async function syncNativeLibraryDocs(nodes: unknown, ports: NativeLibrarySyncPorts): Promise<string[]> {
  const updated: string[] = [];
  for (const doc of nativeLibraryDocsOf(nodes)) {
    // The compatibility path is awaited by callers that assume one resume point
    // after the save resolves; keep it free of the extra timeout hop.
    const result = await mirrorOneDoc(doc, ports, 0);
    if (result.status === "mirrored") { updated.push(doc.id); continue; }
    if (result.status === "skipped-native-only" || result.status === "skipped-deleted"
      || result.status === "removed" || result.status === "superseded") continue;
    throw new Error(`Node-RED deploy library sync failed for ${doc.id}: ${result.error ?? result.status}`);
  }
  return updated;
}

/* ─────────────────── Durable deploy ↔ library reconciliation ─────────────────── */

/** Ledger file inside the engine data directory (same directory as flows.json). */
export const NATIVE_DEPLOY_RECONCILIATION_FILE = "deploy-reconciliation.json";

export interface PendingNativeMirror {
  docId: string;
  /** Content identity of the native deploy whose mirror is still owed. */
  deployId: string;
  /** Receipt time of that deploy (ms; newer receipts win for the same doc). */
  at: number;
  /** `pending` = recorded but never attempted (crash/queue) — safe to replay.
   * `conflict` = the SQL document changed under the mirror; never auto-
   * overwritten. `failed` = save rejected while the SQL revision was unchanged. */
  status: "pending" | "conflict" | "failed";
  /** SQL revision the deploy intended to replace (null = unknown, fail-closed). */
  expectedRevision: string | null;
  /** SQL revision observed when the failure was classified. */
  observedRevision?: string | null;
  error?: string;
}

export interface NativeDeployReconciliation {
  version: 1;
  updatedAt: number;
  /** Documents where the native deploy is committed but the library mirror is
   * not (yet) applied. Empty = both stores agree as far as this process knows. */
  pending: PendingNativeMirror[];
  /** Last successfully applied deploy per document. Duplicate or late ACKs of
   * an older deploy must never overwrite newer content. */
  applied: Record<string, { at: number; deployId: string; /** Bounded recent successful receipts, for late duplicate detection. */ seen?: string[] }>;

  /** Last non-document error (e.g. an invalid deploy payload whose doc identity
   * cannot be derived); informational, never auto-retried. */
  lastError?: { at: number; message: string };
}

function emptyLedger(): NativeDeployReconciliation {
  return { version: 1, updatedAt: 0, pending: [], applied: {} };
}

function sortPending(pending: PendingNativeMirror[]): PendingNativeMirror[] {
  return [...pending].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
}

/** A docId only becomes a filename-adjacent JSON key; reject control characters
 * so a corrupt ledger can never smuggle formatting tricks into the file. */
function validDocId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeLedger(value: unknown): NativeDeployReconciliation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== 1 || !Array.isArray(raw["pending"])) return null;
  const pending: PendingNativeMirror[] = [];
  for (const item of raw["pending"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const p = item as Record<string, unknown>;
    if (!validDocId(p["docId"])) return null;
    if (typeof p["deployId"] !== "string") return null;
    if (typeof p["at"] !== "number" || !Number.isFinite(p["at"])) return null;
    if (p["status"] !== "pending" && p["status"] !== "conflict" && p["status"] !== "failed") return null;
    if (p["expectedRevision"] !== null && typeof p["expectedRevision"] !== "string") return null;
    if (p["observedRevision"] !== undefined && p["observedRevision"] !== null && typeof p["observedRevision"] !== "string") return null;
    if (p["error"] !== undefined && typeof p["error"] !== "string") return null;
    pending.push({
      docId: p["docId"],
      deployId: p["deployId"],
      at: p["at"],
      status: p["status"],
      expectedRevision: p["expectedRevision"] as string | null,
      ...(p["observedRevision"] === undefined ? {} : { observedRevision: p["observedRevision"] as string | null }),
      ...(typeof p["error"] === "string" ? { error: p["error"] } : {}),
    });
  }
  const updatedAt = typeof raw["updatedAt"] === "number" && Number.isFinite(raw["updatedAt"]) ? raw["updatedAt"] : 0;
  const appliedRaw = raw["applied"] === undefined ? {} : raw["applied"];
  if (!appliedRaw || typeof appliedRaw !== "object" || Array.isArray(appliedRaw)) return null;
  const applied: NativeDeployReconciliation["applied"] = {};
  for (const [docId, mark] of Object.entries(appliedRaw as Record<string, unknown>)) {
    if (!validDocId(docId)) return null;
    if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
    const m = mark as Record<string, unknown>;
    if (typeof m["at"] !== "number" || !Number.isFinite(m["at"]) || typeof m["deployId"] !== "string") return null;
    const seen = m["seen"];
    if (seen !== undefined && (!Array.isArray(seen) || seen.length > 8 ||
      seen.some(id => typeof id !== "string" || id.length !== 64 || !/^[a-f0-9]+$/.test(id)))) return null;
    applied[docId] = { at: m["at"], deployId: m["deployId"],
      ...(seen === undefined ? {} : { seen: seen as string[] }) };
  }
  let lastError: NativeDeployReconciliation["lastError"];
  if (raw["lastError"] !== undefined) {
    const le = raw["lastError"];
    if (!le || typeof le !== "object" || Array.isArray(le)) return null;
    const e = le as Record<string, unknown>;
    if (typeof e["at"] !== "number" || !Number.isFinite(e["at"]) || typeof e["message"] !== "string") return null;
    lastError = { at: e["at"], message: e["message"] };
  }
  return { version: 1, updatedAt, pending: sortPending(pending), applied, ...(lastError !== undefined ? { lastError } : {}) };
}

/** Read the durable reconciliation ledger. Never throws: an unreadable or
 * corrupt ledger is preserved (renamed `*.corrupt-*`) and reported as empty, so
 * a damaged bookkeeping file can never block a deploy or fake pending work. */
export function readNativeDeployReconciliation(dataDir: string): NativeDeployReconciliation {
  const file = join(dataDir, NATIVE_DEPLOY_RECONCILIATION_FILE);
  let raw: string;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      log.error("Node-RED 库镜像对账记录不是独立普通文件，拒绝读取");
      return emptyLedger();
    }
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    log.error(`Node-RED 库镜像对账记录读取失败：${errText(err)}`);
    return emptyLedger();
  }
  try {
    const parsed = normalizeLedger(JSON.parse(raw) as unknown);
    if (parsed !== null) return parsed;
    return quarantineLedger(file, "字段形状不合法");
  } catch (err) {
    return quarantineLedger(file, errText(err));
  }
}

function quarantineLedger(file: string, reason: string): NativeDeployReconciliation {
  try {
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    renameSync(file, backup);
    log.error(`Node-RED 库镜像对账记录损坏（${reason}），原档已保留：${backup}`);
  } catch (err) {
    log.error(`Node-RED 库镜像对账记录损坏（${reason}），且无法保留原档：${errText(err)}`);
  }
  return emptyLedger();
}

function writeLedger(dataDir: string, ledger: NativeDeployReconciliation): void {
  mkdirSync(dataDir, { recursive: true });
  const serialized = JSON.stringify({
    version: 1 as const,
    updatedAt: ledger.updatedAt,
    pending: sortPending(ledger.pending),
    applied: ledger.applied,
    ...(ledger.lastError !== undefined ? { lastError: ledger.lastError } : {}),
  }, null, 2) + "\n";
  atomicReplaceFileSync(join(dataDir, NATIVE_DEPLOY_RECONCILIATION_FILE), serialized);
}

/** Content identity of one native deploy payload (not a CAS): two receipts of
 * the same graph share it, which keeps duplicate ACKs idempotent. */
function nativeDeployIdentity(nodes: unknown): string {
  return createHash("sha256").update(JSON.stringify(nodes)).digest("hex");
}

/** Serialize mirror runs per engine data dir inside this process: a later
 * deploy's guarded save must not interleave with (and be overwritten by) an
 * earlier one. Cross-process mirroring is still not serialized — see T2
 * remaining limitations. */
const mirrorQueues = new Map<string, Promise<unknown>>();

function enqueueMirror<T>(key: string, task: () => Promise<T>): Promise<T> {
  const tail = mirrorQueues.get(key) ?? Promise.resolve();
  const run = tail.then(task);
  const settled = run.then(() => undefined, () => undefined);
  mirrorQueues.set(key, settled);
  // A project can have many managed engine dirs over its lifetime. Retaining
  // settled tails by path would leak a Map entry per directory forever.
  void settled.then(() => {
    if (mirrorQueues.get(key) === settled) mirrorQueues.delete(key);
  });
  return run;
}

/** Upper bound for one document's guarded save. A hung library save must not
 * wedge the whole reconciliation queue forever; it is reported as `failed`
 * (SQL revision unchanged) and remains retryable. Overridable for regression
 * suites that exercise the timeout path. */
const SAVE_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

type NativeNodesRead =
  | { ok: true; nodes: unknown }
  | { ok: false; reason: string };

/** Strict read of the engine's own canvas. Broken/missing/linked files never
 * become an empty graph or get overwritten. */
function readNativeNodesForReconcile(dataDir: string): NativeNodesRead {
  const path = join(dataDir, "flows.json");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "Node-RED 原生 flows.json 不存在" };
    return { ok: false, reason: `Node-RED 原生 flows.json 不可读：${errText(err)}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { ok: false, reason: "Node-RED 原生 flows.json 不是独立普通文件" };
  }
  try {
    return { ok: true, nodes: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch {
    return { ok: false, reason: "Node-RED 原生 flows.json 无法解析" };
  }
}

export interface NativeDeployMirrorOptions {
  /** Engine data directory that owns flows.json and the ledger. */
  dataDir: string;
  /** Library ports, or a lazy provider (production imports the SQL library only
   * when a mirror actually runs, so a headless caller never touches a DB). */
  ports: NativeLibrarySyncPorts | (() => Promise<NativeLibrarySyncPorts>);
  /** Synchronous SQL revision peek used *only* to stamp the deploy-time
   * expected revision into the durable intent (no override authority). */
  revisionOf?: (docId: string) => string | null;
  now?: () => number;
  /** Per-document guarded-save time budget (default {@link SAVE_TIMEOUT_MS}). */
  saveTimeoutMs?: number;
}

export interface RetryNativeMirrorOptions {
  /** Explicit user/agent decision to replace a SQL document that changed under
   * an earlier mirror. Automatic retries (engine start) always pass `false`. */
  acceptNativeRevision?: boolean;
}

/** The single implementation of “native deploy committed → mirror into Mcode SQL
 * library, recording what could not be mirrored”. Used by the production sync
 * wrapper, the start-time/again-deploy reconciliation and by regression suites. */
export class NativeDeployLibraryMirror {
  private readonly dataDir: string;
  private readonly ports: NativeLibrarySyncPorts | (() => Promise<NativeLibrarySyncPorts>);
  private readonly revisionOf?: (docId: string) => string | null;
  private readonly now: () => number;
  private readonly saveTimeoutMs: number;

  constructor(options: NativeDeployMirrorOptions) {
    this.dataDir = options.dataDir;
    this.ports = options.ports;
    this.revisionOf = options.revisionOf;
    this.now = options.now ?? Date.now;
    this.saveTimeoutMs = options.saveTimeoutMs ?? SAVE_TIMEOUT_MS;
  }

  /** Current durable reconciliation state (pending documents only). */
  pending(): NativeDeployReconciliation {
    return readNativeDeployReconciliation(this.dataDir);
  }

  /** Record-and-mirror one committed native deploy.
   *
   * The pending intent is written **synchronously**, before this method returns
   * its promise and before any await: a crash after the native 2xx but while the
   * mirror is queued still leaves durable evidence for retry-at-start. Invalid
   * payloads (unknown document identity) throw synchronously and are recorded as
   * `lastError`; they never create fake pending documents.
   */
  mirrorDeploy(nodes: unknown): Promise<NativeMirrorReport> {
    const currentTime = this.now();
    if (!nativePayloadHasMcodeTabs(nodes)) return Promise.resolve({ deployId: "", at: currentTime, ok: true, docs: [] });
    // Deploys can finish in the same millisecond. Equal "at" previously let
    // one document's newer intent be overwritten by the older receipt; the
    // comparison only guarded strict >. Store a monotonic logical receipt
    // time across restarts, without scheduling a timer or busy-waiting.
    const previousAt = readNativeDeployReconciliation(this.dataDir).updatedAt;
    if (!Number.isSafeInteger(previousAt) || previousAt >= Number.MAX_SAFE_INTEGER - 1) {
      throw Error("Node-RED 对账序列时间戳溢出，拒绝覆盖持久记录");
    }
    const at = Math.max(currentTime, previousAt + 1);
    const deployId = nativeDeployIdentity(nodes);
    let docs: WorkflowDoc[];
    try {
      docs = nativeLibraryDocsOf(nodes);
    } catch (err) {
      this.recordLastError(at, `Node-RED Deploy 载荷无法建立文档身份：${errText(err)}`);
      throw err;
    }
    // The ledger is the crash-recovery handoff between native flows.json and
    // SQL. If it cannot be written, do not silently start a mirror that may
    // vanish mid-flight and never be recoverable after a crash.
    this.recordIntent(docs, deployId, at);
    return enqueueMirror(this.dataDir, async () => {
      const ports = await this.resolvePorts();
      const results: MirrorDocResult[] = [];
      for (const doc of docs) {
        const result = await this.mirrorIfCurrent(doc, deployId, at, ports);
        results.push(result);
        this.applyResult(doc.id, deployId, at, result);
      }
      return { deployId, at, ok: mirrorReportOk(results), docs: results };
    });
  }

  /** A duplicate/late ACK must never overwrite content from a newer deploy or
   * from a deploy already applied for this document. Inside the per-dataDir
   * queue, the ledger knows both facts. */
  private async mirrorIfCurrent(
    doc: WorkflowDoc,
    deployId: string,
    at: number,
    ports: NativeLibrarySyncPorts,
  ): Promise<MirrorDocResult> {
    const ledger = readNativeDeployReconciliation(this.dataDir);
    const applied = ledger.applied[doc.id];
    const pending = ledger.pending.find(entry => entry.docId === doc.id);
    const supersededBy = (applied !== undefined && (applied.at > at || applied.deployId === deployId || applied.seen?.includes(deployId) === true))
      || (pending !== undefined && (pending.at > at
        || (pending.at === at && pending.deployId !== deployId)));
    if (supersededBy) {
      return {
        docId: doc.id, status: "superseded", expectedRevision: null, observedRevision: null,
        error: "该回执早于已应用/待对账的较新部署，已忽略（不覆盖较新内容）",
      };
    }
    return mirrorOneDoc(doc, ports, this.saveTimeoutMs);
  }

  /** Retry every pending document against the **current** native canvas (or an
   * explicitly supplied payload). Idempotent; documents whose native tab is gone
   * are resolved as `removed` instead of being recreated in the library.
   *
   * Overwrite policy (fail-closed):
   *  - `pending` replays only while the SQL revision still equals the revision
   *    recorded at deploy time; an unknown revision with an existing SQL doc is
   *    treated as a conflict (cannot prove nobody edited it);
   *  - `failed` replays only while the SQL revision still equals the revision
   *    observed at failure time;
   *  - `conflict` is never auto-overwritten; passing
   *    `acceptNativeRevision: true` is the explicit manual decision to do so.
   */
  retryPending(nodes?: unknown, options: RetryNativeMirrorOptions = {}): Promise<NativeMirrorReport> {
    const at = this.now();
    if (readNativeDeployReconciliation(this.dataDir).pending.length === 0) {
      return Promise.resolve({ deployId: "", at, ok: true, docs: [] });
    }
    return enqueueMirror(this.dataDir, async () => {
      // Re-read inside the queue: an earlier queued mirror may have resolved
      // entries while this task waited.
      const ledger = readNativeDeployReconciliation(this.dataDir);
      if (ledger.pending.length === 0) return { deployId: "", at, ok: true, docs: [] };
      let nativeNodes: unknown;
      if (nodes !== undefined) {
        nativeNodes = nodes;
      } else {
        const read = readNativeNodesForReconcile(this.dataDir);
        if (!read.ok) {
          this.recordLastError(at, `对账无法读取原生画布：${read.reason}`);
          const docs = ledger.pending.map(p => ({
            docId: p.docId, status: "failed" as const, expectedRevision: p.expectedRevision,
            observedRevision: p.observedRevision ?? null, error: read.reason,
          }));
          return { deployId: "", at, ok: false, docs };
        }
        nativeNodes = read.nodes;
      }
      let docsById: Map<string, WorkflowDoc>;
      try {
        docsById = new Map(nativeLibraryDocsOf(nativeNodes).map(doc => [doc.id, doc]));
      } catch (err) {
        this.recordLastError(at, `对账载荷无法建立文档身份：${errText(err)}`);
        throw err;
      }
      const ports = await this.resolvePorts();
      const nativeDeployId = nativeDeployIdentity(nativeNodes);
      const results: MirrorDocResult[] = [];
      for (const pending of ledger.pending) {
        const doc = docsById.get(pending.docId);
        // An old pending intent MUST NOT silently import a *different*
        // flows.json revision. A native Deploy may have happened while the
        // process was down or before a mirror's retry. Treat it as an
        // explicit reconciliation conflict, not a successful replay of a
        // graph that the recorded user action never deployed.
        // Missing native tabs still resolve as 'removed' (no SQL write).
        const result: MirrorDocResult = doc !== undefined
          && nativeDeployId !== pending.deployId && !options.acceptNativeRevision
          ? { docId: pending.docId, status: "conflict",
              expectedRevision: pending.expectedRevision,
              observedRevision: pending.observedRevision ?? null,
              error: "待对账的 Node-RED Deploy 与当前 flows.json 内容不同；拒绝以新图自动覆盖库，请核对并明确选择原生版本" }
          : await this.retryOne(pending, doc, ports, options);
        results.push(result);
        this.applyResult(pending.docId, pending.deployId, pending.at, result);
      }
      return { deployId: "", at, ok: mirrorReportOk(results), docs: results };
    });
  }

  private async retryOne(
    pending: PendingNativeMirror,
    doc: WorkflowDoc | undefined,
    ports: NativeLibrarySyncPorts,
    options: RetryNativeMirrorOptions,
  ): Promise<MirrorDocResult> {
    if (doc === undefined) {
      return { docId: pending.docId, status: "removed", expectedRevision: pending.expectedRevision, observedRevision: null };
    }
    try {
      const current = ports.get(pending.docId);
      const currentRevision = current === null ? null : ports.revision(current);
      if (current === null) {
        // Deleted in the library since the deploy: never recreate a deleted doc.
        return { docId: pending.docId, status: "skipped-deleted", expectedRevision: pending.expectedRevision, observedRevision: null };
      }
      const baseline = pending.status === "failed" ? pending.observedRevision ?? pending.expectedRevision : pending.expectedRevision;
      const changedSince = baseline !== null && currentRevision !== baseline;
      if ((pending.status === "conflict" || changedSince || baseline === null) && !options.acceptNativeRevision) {
        const reason = pending.status === "conflict" || changedSince
          ? "库中该工作流在 Deploy 之后又被编辑过，未自动覆盖；请重新 Deploy 该图或明确选择以原生版本为准"
          : "无法证明库中该工作流自 Deploy 后未被编辑，未自动覆盖";
        return { docId: pending.docId, status: "conflict", expectedRevision: baseline, observedRevision: currentRevision, error: reason };
      }
      return await mirrorOneDoc(doc, ports, this.saveTimeoutMs);
    } catch (err) {
      // One broken document (e.g. unreadable library) must not abort the rest.
      return { docId: pending.docId, status: "failed", expectedRevision: pending.expectedRevision, observedRevision: null, error: errText(err) };
    }
  }

  private async resolvePorts(): Promise<NativeLibrarySyncPorts> {
    return typeof this.ports === "function" ? this.ports() : this.ports;
  }

  /** Durable intent for every document of this deploy. Newer receipts win; a
   * later deploy owning the same document is never demoted by an older one. */
  private recordIntent(docs: WorkflowDoc[], deployId: string, at: number): void {
    try {
      const ledger = readNativeDeployReconciliation(this.dataDir);
      const byId = new Map(ledger.pending.map(entry => [entry.docId, entry]));
      for (const doc of docs) {
        const existing = byId.get(doc.id);
        if (ledger.applied[doc.id]?.deployId === deployId || ledger.applied[doc.id]?.seen?.includes(deployId)) continue;
        if (existing !== undefined && (existing.at > at
          || (existing.at === at && existing.deployId !== deployId))) continue;
        let expectedRevision: string | null = null;
        try {
          expectedRevision = this.revisionOf?.(doc.id) ?? null;
        } catch {
          expectedRevision = null;
        }
        byId.set(doc.id, {
          docId: doc.id, deployId, at, status: "pending", expectedRevision,
        });
      }
      writeLedger(this.dataDir, {
        ...ledger, version: 1, updatedAt: at, pending: [...byId.values()],
      });
    } catch (err) {
      // Native Deploy has ALREADY committed, but the mirror is not durable.
      // Surface a hard failure to Host/runboard instead of logging and
      // pretending it is a recoverable pending transaction.
      const reason = `Node-RED 已部署，但无法持久记录工作流库对账意图：${errText(err)}；必须人工修复存储后再对账`;
      log.error(reason);
      throw new Error(reason);
    }
  }

  /** Fold one document result into the ledger. Success records an `applied`
   * watermark (newer deploys only) and clears the entry only if it belongs to
   * this deploy or an older one; failure upserts only if no newer deploy already
   * owns the document. */
  private applyResult(docId: string, deployId: string, at: number, result: MirrorDocResult): void {
    // An already-applied/late ACK is read-only. It must not clear an unrelated
    // newer pending intent, even if its wall clock at is later (clock skew).
    if (result.status === "superseded") return;
    try {
      const ledger = readNativeDeployReconciliation(this.dataDir);
      const existing = ledger.pending.find(entry => entry.docId === docId);
      if (existing !== undefined && existing.at > at) return;
      const remaining = ledger.pending.filter(entry => entry.docId !== docId);
      const resolved = result.status === "mirrored" || result.status === "skipped-native-only"
        || result.status === "skipped-deleted" || result.status === "removed";
      if (resolved) {
        // A successful mirror of this deploy advances the applied watermark so a
        // duplicate/late ACK of an OLDER deploy cannot overwrite it later.
        const previous = ledger.applied[docId];
        const applied = result.status === "mirrored" && deployId !== "" && (previous === undefined || previous.at <= at)
          ? { ...ledger.applied, [docId]: { at, deployId,
            seen: [...new Set([...(previous?.seen ?? []), ...(previous ? [previous.deployId] : []), deployId])].slice(-8) } }
          : ledger.applied;
        if (existing === undefined && applied === ledger.applied) return;
        writeLedger(this.dataDir, { ...ledger, version: 1, updatedAt: at, pending: remaining, applied });
        return;
      }
      writeLedger(this.dataDir, {
        ...ledger, version: 1, updatedAt: at,
        pending: [...remaining, {
          docId, deployId, at,
          status: result.status === "conflict" ? "conflict" : "failed",
          expectedRevision: result.expectedRevision,
          observedRevision: result.observedRevision,
          ...(result.error !== undefined ? { error: result.error } : {}),
        }],
      });
    } catch (err) {
      log.warn(`Node-RED 库镜像对账记录更新失败（${docId}）：${errText(err)}`);
    }
  }

  private recordLastError(at: number, message: string): void {
    try {
      const ledger = readNativeDeployReconciliation(this.dataDir);
      writeLedger(this.dataDir, { ...ledger, version: 1, updatedAt: at, lastError: { at, message: message.slice(0, MAX_ERROR_LENGTH) } });
    } catch (err) {
      log.warn(`Node-RED 库镜像对账错误记录失败：${errText(err)}`);
    }
  }
}

function mirrorReportOk(results: MirrorDocResult[]): boolean {
  return results.every(r => r.status === "mirrored" || r.status === "skipped-native-only"
    || r.status === "skipped-deleted" || r.status === "removed" || r.status === "superseded");
}

/** Structural check for an injected mirror port's resolved value. */
export function isNativeMirrorReport(value: unknown): value is NativeMirrorReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v["deployId"] === "string" && typeof v["at"] === "number"
    && typeof v["ok"] === "boolean" && Array.isArray(v["docs"]);
}

/** Human-readable failure sentence for logs / callers. Never claims the native
 * deploy failed and never claims the two stores were one transaction. */
export function describeNativeMirrorFailure(report: NativeMirrorReport, dataDir: string): string {
  const failed = report.docs.filter(d => d.status === "conflict" || d.status === "failed");
  const detail = failed.map(d => {
    const kind = d.status === "conflict" ? "库中已有更新的编辑，未覆盖" : "保存被拒绝";
    return `${d.docId}（${kind}${d.error !== undefined ? `：${d.error}` : ""}）`;
  }).join("；");
  return `原生 Node-RED Deploy 已提交，但 Mcode 工作流库镜像未完成：${detail}。`
    + `对账记录：${join(dataDir, NATIVE_DEPLOY_RECONCILIATION_FILE)}；`
    + "重启引擎或对该图再次 Deploy 会自动重试；完成前两边内容可能不一致。";
}

/** Map a mirror report onto the existing host runboard event channel (the same
 * `@node-red-runboard:` namespace used for native triggers, which also have no
 * chat session). Deploy-time reports surface failures only; retry reports
 * (deployId "") also surface recovered documents so the board can clear them.
 * Pure function: the caller owns the sink. */
export function nativeMirrorEvents(report: NativeMirrorReport): WorkflowNodeResultEvent[] {
  const recovered = report.deployId === "";
  const runId = report.deployId !== "" ? `deploy:${report.deployId}` : `reconcile:${report.at}`;
  const events: WorkflowNodeResultEvent[] = [];
  for (const doc of report.docs) {
    const failed = doc.status === "conflict" || doc.status === "failed";
    if (!failed && !(recovered && doc.status === "mirrored")) continue;
    events.push({
      type: "workflow.node.result",
      sessionId: "@node-red-runboard:" + doc.docId,
      workflowId: doc.docId,
      runId,
      nodeId: "__native-library-mirror__",
      nodeType: "mcode.deploy-reconciliation",
      title: failed ? "Mcode 工作流库镜像未完成" : "Mcode 工作流库镜像已恢复",
      status: failed ? "failed" : "success",
      summary: failed ? "" : "原生 Node-RED 部署已对账写入工作流库",
      ...(failed ? {
        error: doc.status === "conflict"
          ? "原生部署已提交，但库中该工作流在 Deploy 之后又被编辑过，未自动覆盖；重新 Deploy 或明确选择以原生版本为准"
          : `原生部署已提交，但库镜像保存被拒绝：${doc.error ?? "未知原因"}`,
      } : {}),
    } satisfies WorkflowNodeResultEvent);
  }
  return events;
}

export type NativeMirrorEventSink = (event: RuntimeEvent) => void;

/** Production ports import lazily: owner-only unit tests never touch a user DB. */
async function productionNativeLibraryPorts(): Promise<NativeLibrarySyncPorts> {
  const [{ getWorkflow, saveWorkflow }, { workflowSaveVersion }, { notifyWorkflowsChanged }] = await Promise.all([
    import("@main/orchestration/library.js"),
    import("@main/orchestration/workflowSaveVersion.js"),
    import("@main/orchestration/broadcast.js"),
  ]);
  return {
    get: getWorkflow,
    revision: workflowSaveVersion,
    // Native edits are an untrusted external source: always require review
    // again, even if the old Mcode graph was previously approved.
    save: (doc, expectedRevision) => saveWorkflow(doc, { expectedRevision, untrustedOrigin: "import" }),
    changed: id => notifyWorkflowsChanged(`node-red:deploy:${id}`),
  };
}

async function defaultEngineDataDir(): Promise<string> {
  const { dataRoot } = await import("@main/lib/dataRoot.js");
  return join(dataRoot(), "workflow-engines", "node-red");
}

/** Run the full mirror for one confirmed native deploy. Kept non-async so a
 * supplied `dataDir` makes the durable intent synchronous: the runtime calls
 * this in the same turn that received the deploy-final receipt, before the
 * first await and before this function returns its promise. Invalid payloads
 * throw synchronously (no fake pending documents). */
export function runNativeDeployMirror(
  nodes: unknown,
  options: { dataDir?: string; revisionOf?: (docId: string) => string | null } = {},
): Promise<NativeMirrorReport> {
  if (!nativePayloadHasMcodeTabs(nodes)) {
    return Promise.resolve({ deployId: "", at: Date.now(), ok: true, docs: [] });
  }
  const run = (dataDir: string): Promise<NativeMirrorReport> => {
    const mirror = new NativeDeployLibraryMirror({
      dataDir, ports: productionNativeLibraryPorts,
      ...(options.revisionOf !== undefined ? { revisionOf: options.revisionOf } : {}),
    });
    return mirror.mirrorDeploy(nodes);
  };
  if (options.dataDir !== undefined) return run(options.dataDir);
  return defaultEngineDataDir().then(run);
}

/** T58 production entry for a confirmed native deploy. Returns the mirrored
 * document ids; a partial/failed mirror throws *after* the durable intent is
 * written, so callers can log it as “deploy committed, library pending
 * reconciliation” rather than as a deploy failure. */
export function syncDeployedNativeWorkflows(
  nodes: unknown,
  options: { dataDir?: string; revisionOf?: (docId: string) => string | null } = {},
): Promise<string[]> {
  if (!nativePayloadHasMcodeTabs(nodes)) return Promise.resolve([]);
  let dataDirPromise: Promise<string>;
  if (options.dataDir !== undefined) dataDirPromise = Promise.resolve(options.dataDir);
  else dataDirPromise = defaultEngineDataDir();
  const task = dataDirPromise.then(dataDir => {
    const mirror = new NativeDeployLibraryMirror({
      dataDir, ports: productionNativeLibraryPorts,
      ...(options.revisionOf !== undefined ? { revisionOf: options.revisionOf } : {}),
    });
    return mirror.mirrorDeploy(nodes).then(report => ({ dataDir, report }));
  });
  return task.then(({ dataDir, report }) => {
    if (!report.ok) throw new Error(describeNativeMirrorFailure(report, dataDir));
    return report.docs.filter(doc => doc.status === "mirrored").map(doc => doc.docId);
  });
}

/** Retry the durable pending mirrors for one engine data directory. Cheap and
 * side-effect free when nothing is pending (the SQL library is never imported
 * then). Automatic callers pass `acceptNativeRevision: false`. */
export async function reconcileNativeLibraryMirror(
  dataDir: string,
  options: RetryNativeMirrorOptions = {},
): Promise<NativeMirrorReport> {
  const mirror = new NativeDeployLibraryMirror({ dataDir, ports: productionNativeLibraryPorts });
  const report = await mirror.retryPending(undefined, options);
  if (!report.ok) log.error(`Node-RED 原生部署与 Mcode 工作流库对账未完成：${describeNativeMirrorFailure(report, dataDir)}`);
  return report;
}
