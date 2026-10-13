/**
 * 【MC-097 跨进程夹具】—— 一个**独立 OS 进程**的 FILE_WRITE 写者。
 *
 * 由 `main.ts` 用 `spawn(process.execPath, [child.mjs, file, projectRoot, fill, count, expectedVersion])`
 * 各起一个:两个真正独立的进程都对**同一份**文件、拿**同一个** `expectedVersion` 并发写。
 * 断言「恰好一个成功、另一个明确 conflict」—— 只有按路径的宿主级文件租约能给出这个结论,
 * 进程内锁挡不住跨进程。走的是与生产同一份 `registerFileHandlers`(不重写机制)。
 *
 * 内容从 `fill` 字符 + `count` 长度在**子进程内**构造(argv 在 Windows 上有长度上限,几 MB
 * 的正文不能走命令行)。输出一行 JSON 到 stdout:`{"ok":true}` / `{"ok":false,"conflict":true}`
 * / `{"ok":false,"error":"..."}`。
 */
import { IPC } from "@contracts/ipc";
import { registerFileHandlers } from "@main/ipc/files.js";
import { projectPaths } from "./stubs.js";

const [filePath, projectRoot, fill, countStr, expectedVersion] = process.argv.slice(2);
if (!filePath || !projectRoot || !fill || !countStr) {
  process.stdout.write(JSON.stringify({ ok: false, error: "用法: child-write <file> <root> <fill> <count> <expectedVersion>" }) + "\n");
  process.exit(2);
}
// 让被测处理器认得这条路径(登记同一个项目根)。
projectPaths.push(projectRoot);

const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
registerFileHandlers({
  handle(channel: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) {
    handlers.set(channel, fn);
  },
} as never);

const content = fill.repeat(Number.parseInt(countStr, 10) || 1) + "\n";
const fn = handlers.get(IPC.FILE_WRITE);
if (!fn) {
  process.stdout.write(JSON.stringify({ ok: false, error: "FILE_WRITE 未注册" }) + "\n");
  process.exit(2);
}
fn(null, { filePath, content, expectedVersion })
  .then((res) => {
    process.stdout.write(JSON.stringify(res) + "\n");
  })
  .catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
    process.exitCode = 1;
  });
