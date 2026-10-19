/**
 * 读一个 **CLI 任务输出文件** —— 右栏「任务列表」页里点开一条 bash 任务时读的那个文件。
 *
 * ## 为什么单独一个文件
 *
 * 这是一条**读文件**的口子，而"读什么"必须能单独验。主进程那边（`RuntimeManager`）
 * 负责回答"哪个 taskId 对应哪个路径"，**路径合不合法由这里判** —— 两件事分开之后，
 * 校验规则可以喂一堆恶意路径直接钉住（见 `scripts/task-output-smoke`），不用起 Electron、
 * 也不用真的跑一个任务。
 *
 * ## 三层判据，缺一不可
 *
 *  1. **绝对路径**。相对路径会跟着进程的 cwd 跑，那是"用户项目目录"，不该是它的落点。
 *  2. **在 `tasks` 目录下，且以 `.output` 结尾**。CLI 的任务输出固定长这样
 *     （公开文档里的例子：`/private/tmp/claude/<项目>/tasks/<id>.output`）。这一条是
 *     **正向**判据 —— 只认这个形状，而不是"排除几个危险路径"（黑名单永远少一条）。
 *  3. **必须是普通文件，拒绝链接**：`lstatSync` 从输出文件逐级回溯到 `tasks`
 *     目录，拒绝 symlink / Windows junction，并以 `realpathSync` 核实真实目标。
 *
 * ⚠️ 第 2 条只验证词法路径，第三条才检查磁盘上的链接；两道护栏均非
 * 原子 OS 沙箱（链接若在检查与打开之间被恶意替换，仍有 TOCTOU 窗口）。
 * 调用方还必须只传主进程掌握的 CLI 任务输出路径，而不能采信模型自报文件名。
 *
 * ## 只读尾部
 *
 * 与命令节点同一个取舍（`COMMAND_OUTPUT_TAIL_CHARS`）：长任务的输出动辄几兆，
 * 而要看的东西（错误栈、结果）都在尾部。截断**如实报告**，由界面说明。
 */
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { decodeOutput } from "@main/lib/outBuf.js";

/** 只读尾部这么多**字节**。与 `OutBuf` 的窗口同一量级。 */
export const TASK_OUTPUT_TAIL_BYTES = 64 * 1024;

/** 路径合法吗。**导出是为了能单独验**（见文件头）。 */
export function isAllowedTaskOutputPath(p: string): boolean {
  if (typeof p !== "string" || p.trim() === "") return false;
  // ① 绝对路径。Windows 上 `C:\...` 与 POSIX 的 `/...` 都算（`isAbsolute` 认平台）。
  if (!isAbsolute(p)) return false;
  // ② 必须在某个 `tasks` 目录下（判**路径分段**，不是子串 —— `mytasks` 不算）。
  const parts = p.split(/[\\/]/).filter((s) => s !== "");
  const tasksAt = parts.lastIndexOf("tasks");
  // 必须是 `tasks/<文件>` 这个形状：`tasks` 不能是最后一段，且它后面有东西。
  // CLI only reports tasks/<id>.output: an extra directory level makes
  // arbitrary files reachable through a forged task notification path.
  if (tasksAt === -1 || tasksAt !== parts.length - 2) return false;
  // ③ 以 `.output` 结尾。
  const last = parts[parts.length - 1] as string;
  if (!last.endsWith(".output")) return false;
  // ④ 不许出现 `..`（分层目录可以，回退不行）。
  if (parts.some((s) => s === "..")) return false;
  return true;
}

/**
 * 读这个文件的**尾部**。不合法的路径**抛**（不返回空串 —— 那会把"读不到"伪装成"没有输出"）。
 */
export function readTaskOutputFile(filePath: string): { text: string; truncated: boolean } {
  if (!isAllowedTaskOutputPath(filePath)) {
    // 不把路径原样回给调用方（它可能进界面）—— 只说是"不允许的路径"。
    throw new Error("不允许读取这个路径的任务输出");
  }
  let size: number;
  try {
    // A task_notification path can be forged; a lexical tasks/*.output check
    // alone does not stop a symlink or Windows junction inside that tree.
    // Reject links from the output itself up through its nearest tasks folder.
    // Ancestors before tasks may legitimately be OS mounts / home aliases.
    let current = filePath;
    while (true) {
      if (lstatSync(current).isSymbolicLink()) throw new Error("task output link");
      if (basename(current) === "tasks") break;
      const parent = dirname(current);
      if (parent === current) throw new Error("task output root not found");
      current = parent;
    }
    // The physical destination must also have the expected CLI output shape.
    // This is defense-in-depth, not a guarantee against concurrent swaps.
    if (!isAllowedTaskOutputPath(realpathSync.native(filePath))) {
      throw new Error("task output resolved outside tasks");
    }
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    throw new Error("任务输出文件不存在或不可读");
  }
  const start = Math.max(0, size - TASK_OUTPUT_TAIL_BYTES);
  const length = size - start;
  if (length <= 0) return { text: "", truncated: false };

  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    // 解码交给 `outBuf` 那一份**唯一实现**（UTF-8 优先、GBK 兜底）—— CLI 的输出在
    // Windows 上同样可能是控制台代码页。从尾巴开始可能落在多字节字符中间，
    // `decodeOutput` 自己会处理开头的落单续字节。
    return {
      text: decodeOutput(read === length ? buf : buf.subarray(0, read)),
      truncated: start > 0,
    };
  } finally {
    closeSync(fd);
  }
}
