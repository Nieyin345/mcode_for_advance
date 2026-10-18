/**
 * 【MC-024】**冲突副本**的唯一实现 —— 写入口 CAS 拒绝时，把"本次尝试写入的正文"
 * 另存到同目录，而不是让它随请求对象一起丢掉。
 *
 * ## 为什么抽成叶子模块
 *
 * 这份逻辑原先私生在 `ipc/files.ts`（桌面 `file.writeFile` 的冲突分支）。Agent 侧的
 * 文本编辑（`mcp/agentTextFiles.ts` 的租约内 CAS、`agent_edit_file` 的
 * `expected_sha256`）是同一判据的下一处：拒绝覆盖时，本次要写的内容同样只在内存里，
 * 工具一返回就没了。两处必须共用同一份命名与落盘规则（同目录、
 * `<stem>.conflict-<ISO 时间戳>[-N]<ext>`、名字被占时派生 `-2/-3`、原子写）——
 * 再抄一份就会出现"桌面那份改了命名/防覆盖、Agent 这份忘了"的分裂。
 *
 * 不 import electron、不 import 任何 `ipc/*`：无头套件加载它不会把 electron 兼容层
 * 拖进来（与 `atomicFile.ts` 同一个理由）。
 */
import { access } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

/** 【MC-024】**冲突副本的路径**：`src/app.ts` → `src/app.conflict-2026-10-18T12-34-56-789Z.ts`。
 *
 *  - 扩展名留在最后，编辑器/语法高亮仍按源文件类型识别；
 *  - ISO 时间戳里的 `:` 和 `.` 换成 `-`（Windows 文件名不允许 `:`），保留 `T`/`Z` 的
 *    ISO 形状，排序即时间序；
 *  - 与 `atomicReplaceFile` 的临时文件模式（`.mcode-tmp`）不重叠 —— 那是"写到一半的
 *    垃圾"，这是"用户这次想写、但被别人抢先"的正文，两者别混。
 *
 *  首次冲突时给时间戳名；同一毫秒内同一路径再次冲突（或第三方已占了同名文件）时，
 *  依次派生 `-2`、`-3` —— 前一次的副本不能被后一次覆盖掉。 */
export function conflictCopyPathFor(filePath: string, attempt = 1): string {
  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = attempt === 1 ? "" : `-${attempt}`;
  return join(dirname(filePath), `${stem}.conflict-${stamp}${suffix}${ext}`);
}

/** 把**本次尝试写入的内容**另存为冲突副本（原子写），返回落盘路径。
 *  只应在 CAS 冲突分支里调用；不碰原文件。 */
export async function writeConflictCopy(filePath: string, content: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const target = conflictCopyPathFor(filePath, attempt);
    try {
      await access(target);
      continue; // 名字已被占（同毫秒第二次冲突 / 第三方文件）→ 派生下一个
    } catch {
      // ENOENT = 名字可用。其它错误交给下面的原子写如实抛。
    }
    await atomicReplaceFile(target, content);
    return target;
  }
}
