/**
 * 【ARC-006 Gate C】**迁移前的无损备份**：把原始 WorkflowDoc 的字节写进
 * `<数据根>/workflow-migrations/<id>-<时间戳>.json`。
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
 * `<sanitized-id>-<ISO 时间戳>.json`：`:` / `.` 在 Windows 文件名里非法或易被误读，
 * 统一折成 `-`（时间戳精确到毫秒且带 `Z`，同一毫秒内同一 id 不会撞 —— 真撞了
 * `atomicReplaceFile` 会覆盖，而两份同一毫秒的备份本来就等价）。
 *
 * ## 它不做什么
 *
 * 不删旧备份、不做目录配额、不碰 `<数据根>` 里的其它内容。保留策略是 Gate C 存储
 * 切片的事，本切片只保证"迁移之前，原文一定有一份可读的字节"。
 */
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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

/** 把 id 折成安全的文件名片段（保留字母数字、`-`、`_`，其余折 `-`）。 */
export function backupFileName(id: string, at: Date): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workflow";
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${safe}-${stamp}.json`;
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
  const dir = join(dataRoot, WORKFLOW_MIGRATIONS_DIR);
  await mkdir(dir, { recursive: true });
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
