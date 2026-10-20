/**
 * T10 / ARC-006 Gate D: durable executor claims next to native flows.json.
 * Synchronous store operations are required by ExecutorOwnershipStore's CAS
 * contract; persistence is completed BEFORE changing the in-memory map.
 */
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicReplaceFileSync } from "@main/lib/atomicFile.js";
import { log } from "@main/lib/logger.js";
import { nativeFlowIds } from "./nodeRedOwnership.js";
import { isExecutorOwner, type ExecutorOwner, type ExecutorOwnershipRecord, type ExecutorOwnershipStore } from "./executorOwnership.js";

export const OWNERSHIP_FILE = "executor-ownership.json";
type Archive = { version: 1; records: ExecutorOwnershipRecord[]; legacyBlocked?: boolean };
export type OwnershipDiagnostic = { kind: "corrupt" | "recovered" | "stale" | "conflict" | "flows-invalid"; message: string };

function assertOrdinaryFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("executor owner 文件必须是独立普通文件");
  }
}

function parseArchive(raw: string): Archive {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("根结构非法");
  const obj = value as Record<string, unknown>;
  if (obj["version"] !== 1 || !Array.isArray(obj["records"]) ||
      (obj["legacyBlocked"] !== undefined && typeof obj["legacyBlocked"] !== "boolean")) {
    throw new Error("版本或记录列表非法");
  }
  const seen = new Set<string>();
  const records: ExecutorOwnershipRecord[] = [];
  for (const candidate of obj["records"]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("owner 记录非对象");
    }
    const item = candidate as Record<string, unknown>;
    const id = item["flowId"];
    if (typeof id !== "string" || id.length > 512 || !id.trim() || /[\u0000-\u001f\u007f]/.test(id) ||
        !isExecutorOwner(item["owner"]) || seen.has(id) ||
        (item["reason"] !== undefined && typeof item["reason"] !== "string") ||
        (item["claimedAt"] !== undefined && (typeof item["claimedAt"] !== "number" || !Number.isFinite(item["claimedAt"])))) {
      throw new Error("owner 记录非法或重复");
    }
    seen.add(id);
    records.push({
      flowId: id, owner: item["owner"],
      ...(typeof item["reason"] === "string" ? { reason: item["reason"] } : {}),
      ...(typeof item["claimedAt"] === "number" ? { claimedAt: item["claimedAt"] } : {}),
    });
  }
  return { version: 1, records, ...(obj["legacyBlocked"] === true ? { legacyBlocked: true } : {}) };
}

export class FileExecutorOwnershipStore implements ExecutorOwnershipStore {
  private records = new Map<string, ExecutorOwnershipRecord>();
  private blocked = false;
  private readonly diagnosticsLog: OwnershipDiagnostic[] = [];
  /** Native claims recovered on boot may be adopted once by the next engine start. */
  private readonly recoverableNative = new Set<string>();
  readonly filePath: string;

  constructor(readonly dataDir: string) {
    this.filePath = join(dataDir, OWNERSHIP_FILE);
    let archive: Archive | undefined;
    try {
      assertOrdinaryFile(this.filePath);
      archive = parseArchive(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Protect the original bytes before a replacement is ever written.
        const backup = this.filePath + ".corrupt-" + Date.now() + "-" + randomUUID();
        renameSync(this.filePath, backup);
        this.blocked = true;
        this.report("corrupt", "owner 文件损坏，已保留原档 " + backup + "；拒绝旧 runner 自动接管");
      }
    }
    if (archive !== undefined) {
      this.blocked = archive.legacyBlocked === true;
      this.records = new Map(archive.records.map((record) => [record.flowId, { ...record }]));
    }
    // One-time reconciliation: no disk I/O occurs in get()/list().
    try {
      const native = new Set(nativeFlowIds(this.dataDir));
      for (const [id, record] of [...this.records]) {
        if (record.owner === "node-red" && !native.has(id)) {
          this.records.delete(id);
          this.report("stale", "已释放 flows.json 中不存在的 Node-RED stale owner：" + id);
        }
      }
      for (const id of native) {
        const existing = this.records.get(id);
        if (existing?.owner === "mcode") {
          this.blocked = true;
          this.report("conflict", "flows.json 存在原生 flow 但持久 owner 为 mcode：" + id + "；旧 runner 被阻断");
          continue;
        }
        if (!existing) {
          this.records.set(id, { flowId: id, owner: "node-red", reason: "reconciled native flows.json" });
          this.report("recovered", "从 flows.json 恢复 Node-RED owner：" + id);
        }
        this.recoverableNative.add(id);
      }
    } catch (err) {
      this.blocked = true;
      this.report("flows-invalid", "flows.json 不可验证，拒绝旧 runner 自动接管：" +
        (err instanceof Error ? err.message : String(err)));
    }
    // Persist reconstructed/blocked state; error must reach caller and fail closed.
    this.persist(this.records);
  }

  private report(kind: OwnershipDiagnostic["kind"], message: string): void {
    this.diagnosticsLog.push({ kind, message });
    log.warn("[executor-ownership] " + message);
  }

  diagnostics(): { legacyBlocked: boolean; events: OwnershipDiagnostic[] } {
    return { legacyBlocked: this.blocked, events: this.diagnosticsLog.map((event) => ({ ...event })) };
  }

  /** Called by the registry BEFORE an execution/claim is allowed. */
  refuseLegacy(): string | null {
    return this.blocked ? "owner 或 flows.json 的归属状态不可验证，旧 runner 自动接管被禁止" : null;
  }

  takeRecoveredNativeClaim(flowId: string): boolean {
    if (!this.recoverableNative.has(flowId) || this.records.get(flowId)?.owner !== "node-red") return false;
    this.recoverableNative.delete(flowId);
    return true;
  }

  private persist(records: Map<string, ExecutorOwnershipRecord>): void {
    const doc: Archive = { version: 1, records: [...records.values()], ...(this.blocked ? { legacyBlocked: true } : {}) };
    atomicReplaceFileSync(this.filePath, JSON.stringify(doc));
  }

  get(flowId: string): ExecutorOwnershipRecord | null {
    const record = this.records.get(flowId);
    return record === undefined ? null : { ...record };
  }

  insert(record: ExecutorOwnershipRecord): boolean {
    if (this.records.has(record.flowId)) return false;
    const next = new Map(this.records);
    next.set(record.flowId, { ...record });
    this.persist(next); // Disk first. EACCES/ENOSPC must never produce an in-memory claim.
    this.records = next;
    return true;
  }

  remove(flowId: string, owner: ExecutorOwner): boolean {
    if (this.records.get(flowId)?.owner !== owner) return false;
    const next = new Map(this.records);
    next.delete(flowId);
    this.persist(next);
    this.records = next;
    this.recoverableNative.delete(flowId);
    return true;
  }

  list(): ExecutorOwnershipRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
