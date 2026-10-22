/**
 * T10 / ARC-006 Gate D: durable executor claims next to native flows.json.
 * Synchronous store operations are required by ExecutorOwnershipStore's CAS
 * contract; persistence is completed BEFORE changing the in-memory map.
 *
 * 【T4】跨进程 CAS:每次写(insert/remove/启动对账)都在宿主级同步文件租约
 * (`withOsFileLeaseSync`,与 osFileLease 同一份 `.mcode-lock` 协议)内**重新读盘**、
 * 在新鲜状态上判定、原子写回,再刷新本实例内存。两个 Mcode 进程(或 Mcode +
 * 测试/恢复进程)同时 insert 同一 flowId 时,后者看到前者刚落盘的记录 → 拒绝;
 * 不同 flowId 的并发 insert 不再整表覆盖丢记录。读盘损坏 / 租约超时一律
 * fail-closed(抛错,内存与磁盘都不改),绝不"后写赢"。
 */
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicReplaceFileSync } from "@main/lib/atomicFile.js";
import { withOsFileLeaseSync } from "@main/lib/osFileLease.js";
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

/** The single serializer for the on-disk archive format. Boot reconciliation
 * compares against it instead of re-serializing by hand, so the "did anything
 * change?" test can never drift from what is actually written. */
function serializeArchive(records: Iterable<ExecutorOwnershipRecord>, blocked: boolean): string {
  const doc: Archive = { version: 1, records: [...records], ...(blocked ? { legacyBlocked: true } : {}) };
  return JSON.stringify(doc);
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
    // Boot reconciliation is itself a read-modify-write of the SHARED file: it
    // must run under the cross-process lease and on a fresh read, otherwise a
    // process booting moments later rewrites the file from its stale snapshot
    // and erases claims another process acquired in the meantime (T4).
    withOsFileLeaseSync(this.filePath, () => this.bootstrapLocked());
  }

  /** Constructor body, executed with the ownership file leased. */
  private bootstrapLocked(): void {
    const archive = this.readBootArchive();
    const baseline = archive ?? { version: 1, records: [] };
    this.records = new Map(baseline.records.map((record) => [record.flowId, { ...record }]));
    // Only an archive that actually parsed may clear the corrupt block set by
    // readBootArchive(); ENOENT leaves `blocked` untouched.
    if (archive !== undefined) this.blocked = archive.legacyBlocked === true;
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
    // Persist reconstructed/blocked state ONLY when it differs from disk; an
    // unconditional boot write would clobber concurrent claims (T4). Errors
    // must reach the caller and fail closed.
    const onDisk = serializeArchive(baseline.records, baseline.legacyBlocked === true);
    if (serializeArchive(this.records.values(), this.blocked) !== onDisk) this.writeLocked(this.records);
  }

  /** Read the archive for boot; a damaged file is archived byte-for-byte and
   * routed into the T10 fail-closed rebuild, never silently accepted.
   * Returns `undefined` when no archive could be parsed (ENOENT or corrupt). */
  private readBootArchive(): Archive | undefined {
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
    return archive;
  }

  /** Re-read the on-disk archive while HOLDING the lease. A damaged file here
   * (after boot) is not rebuilt: the write is refused so neither memory nor
   * disk can be silently rewritten from a corrupt baseline. */
  private readFreshLocked(): Archive {
    try {
      assertOrdinaryFile(this.filePath);
      return parseArchive(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      this.report("corrupt", "owner 文件在写入前不可解析，拒绝改写：" +
        (err instanceof Error ? err.message : String(err)));
      throw new Error("executor owner 文件损坏或不可验证，拒绝登记/释放（fail-closed）：" +
        (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Replace the in-memory snapshot with the fresh on-disk one. Blocked state
   * is sticky: once any process observed an unverifiable state, later writers
   * keep `legacyBlocked` set instead of silently clearing it. */
  private adoptLocked(fresh: Archive): Map<string, ExecutorOwnershipRecord> {
    if (fresh.legacyBlocked === true) this.blocked = true;
    const records = new Map(fresh.records.map((record) => [record.flowId, { ...record }]));
    this.records = records;
    return new Map(records);
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

  private writeLocked(records: Map<string, ExecutorOwnershipRecord>): void {
    atomicReplaceFileSync(this.filePath, serializeArchive(records.values(), this.blocked));
  }

  get(flowId: string): ExecutorOwnershipRecord | null {
    const record = this.records.get(flowId);
    return record === undefined ? null : { ...record };
  }

  insert(record: ExecutorOwnershipRecord): boolean {
    return withOsFileLeaseSync(this.filePath, () => {
      const fresh = this.readFreshLocked();
      if (fresh.legacyBlocked === true && record.owner === "mcode") {
        // Another process learned the state is unverifiable after this instance
        // booted. Granting a legacy claim here would be fail-open.
        this.blocked = true;
        throw new Error("executor owner 状态已被另一进程标记为不可验证，拒绝登记 mcode（fail-closed）");
      }
      const next = this.adoptLocked(fresh);
      if (next.has(record.flowId)) return false;
      next.set(record.flowId, { ...record });
      this.writeLocked(next); // Disk first. EACCES/ENOSPC must never produce an in-memory claim.
      this.records = next;
      return true;
    });
  }

  remove(flowId: string, owner: ExecutorOwner): boolean {
    return withOsFileLeaseSync(this.filePath, () => {
      const next = this.adoptLocked(this.readFreshLocked());
      if (next.get(flowId)?.owner !== owner) return false;
      next.delete(flowId);
      this.writeLocked(next);
      this.records = next;
      this.recoverableNative.delete(flowId);
      return true;
    });
  }

  list(): ExecutorOwnershipRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
