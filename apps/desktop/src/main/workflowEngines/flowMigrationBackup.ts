/**
 * 【ARC-006 Gate C】**迁移前的无损备份**：把原始 WorkflowDoc 的字节写进
 * `<数据根>/workflow-migrations/<safe-id>-<id-hash>-<时间戳>-<nonce>.json`。
 *
 * ## 三条纪律
 *
 * 1. **逐字节等于原文**：调用方给的就是原文的字节（`Uint8Array`）；本模块**不**
 *    re-serialize（那会改空白/键序，备份就不再是"原文"）。文本入口
 *    {@link backupWorkflowDocText} 只做 UTF-8 编码，不做 JSON 往返。
 * 2. **原子写**：temp + fsync + rename，走 `@main/lib/atomicFile.ts` 的唯一实现
 *    （失败不留半份，也不退回非原子写）。
 * 3. **数据根注入**：本模块不 import `dataRoot()`（那会拖进 electron）；调用方给根。
 *    无头套件因此可以直接指到临时目录。
 *
 * ## 文件名
 *
 * `<sanitized-id>-<id-hash>-<ISO 时间戳>-<nonce>.json`：`:` / `.` 折成 `-`；
 * 原 ID 哈希区分 `a/b` 与 `a:b` 等折叠碰撞；随机 UUID 使同一 id、同一毫秒、
 * 不同原文的连续迁移产生独立备份，绝不覆盖以前的可抢救字节。
 * 文件名前缀限制为 48 字符，避免超长 ID 触发 Windows 文件名长度限制。
 *
 * ## 它不做什么
 *
 * 不删旧备份、不做目录配额、不碰 `<数据根>` 里的其它内容。保留策略是 Gate C 存储
 * 切片的事，本切片只保证"迁移之前，原文一定有一份可读的字节"。
 */
import { lstat, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

/** 备份目录名（相对数据根）。 */
export const WORKFLOW_MIGRATIONS_DIR = "workflow-migrations";

export interface WorkflowMigrationBackup {
  /** 备份文件的绝对路径。 */
  path: string;
  /** 写进文件的字节数。 */
  bytes: number;
  /** 备份内容的 SHA-256（十六进制）—— 调用方可用它与原文比对。 */
  sha256: string;
}

/** 按原始 id + 备份事件生成不可覆盖的安全文件名（不是仅按毫秒作唯一键）。 */
export function backupFileName(id: string, at: Date): string {
  const safe = (id.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workflow").slice(0, 48);
  const idHash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${safe}-${idHash}-${stamp}-${randomUUID()}.json`;
}

/**
 * 备份一份工作流文档的**原始字节**。
 *
 * @param dataRoot 数据根（`<root>/workflow-migrations/` 会在需要时创建）
 * @param id 工作流 id（只用于文件名；文档内容以 `bytes` 为准）
 * @param bytes 原文的 UTF-8 字节（**不是** re-serialize 的结果）
 * @param options.at 时间戳（测试注入；默认当前时间）
 */
export async function backupWorkflowDocBytes(
  dataRoot: string,
  id: string,
  bytes: Uint8Array,
  options: { at?: Date } = {},
): Promise<WorkflowMigrationBackup> {
  // Validate the supplied managed root BEFORE recursive mkdir of its child.
  // Otherwise an attacker-replaced dataRoot Junction causes our first write
  // to create workflow-migrations outside the Host's intended data root.
  await mkdir(dataRoot, { recursive: true });
  const rootInfo = await lstat(dataRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("工作流数据根不是普通目录（拒绝符号链接或 junction）");
  }
  const dir = join(dataRoot, WORKFLOW_MIGRATIONS_DIR);
  await mkdir(dir, { recursive: true });
  // `mkdir({recursive:true})` does NOT reject an existing directory link.
  // If this child is swapped for a junction/symlink, an apparently in-root
  // backup is actually written outside the data root. Never follow it.
  // The supplied dataRoot itself is a trusted host location; this enforces
  // the owned migration-backup subdirectory boundary (not an OS sandbox).
  const directory = await lstat(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("工作流迁移备份目录不是普通目录（拒绝符号链接或 junction）");
  }
  const path = join(dir, backupFileName(id, options.at ?? new Date()));
  await atomicReplaceFile(path, bytes);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * 文本入口：只做 UTF-8 编码，**不**解析再序列化 —— 空白、键序、数字写法都原样落盘，
 * 备份因此逐字节等于调用方手里的那份文本。
 */
export async function backupWorkflowDocText(
  dataRoot: string,
  id: string,
  text: string,
  options: { at?: Date } = {},
): Promise<WorkflowMigrationBackup> {
  return backupWorkflowDocBytes(dataRoot, id, new TextEncoder().encode(text), options);
}
