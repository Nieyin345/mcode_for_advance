/** Save ordering and failure smoke: real renderer queue + real IPC adapter,
 * with only the Electron API stubbed (no access to real user documents). */
import { SerializedFileWrites, isEditingKey, shouldAutosave } from "@renderer/lib/serializedFileWrites.js";
import { markdownFileWrites, textFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { setWriteHandler } from "./stubs/api.js";

let checks = 0;
let failures = 0;
function check(name: string, good: boolean, detail?: unknown): void {
  checks += 1;
  if (!good) failures += 1;
  console.log(`  ${good ? "ok  " : "FAIL"} ${name}${!good && detail != null ? `: ${JSON.stringify(detail)}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

console.log("真实输入闸门");
eq("挂载规范化不能自动写", shouldAutosave(false, "* rewritten", "- original"), false);
eq("没有内容变更不能自动写", shouldAutosave(true, "original", "original"), false);
eq("真实输入且内容变化才写", shouldAutosave(true, "edited", "original"), true);
const key = (name: string, ctrlKey = false, metaKey = false, altKey = false) =>
  isEditingKey({ key: name, ctrlKey, metaKey, altKey });
eq("方向键只是导航", key("ArrowDown"), false);
eq("保存快捷键不是输入", key("s", true), false);
eq("普通文字是输入", key("a"), true);
eq("删除是输入", key("Backspace"), true);
eq("撤销是内容变更", key("z", true), true);
eq("Alt 导航不是文字输入", key("ArrowLeft", false, false, true), false);

console.log("同一路径串行,不同路径独立,关闭后读等待旧写完成");
const pause = deferred();
const disk = new Map<string, string>();
const started: string[] = [];
const q = new SerializedFileWrites(async (path, content) => {
  started.push(`${path}:${content}`);
  if (content === "intermediate") await pause.promise;
  disk.set(path, content);
});
const older = q.enqueue("a.md", "intermediate");
// User undoes the first edit while the write is in flight. The baseline must
// be persisted AFTER it, not just marked clean in local editor state.
const undo = q.enqueue("a.md", "baseline");
const waitingRead = q.waitForPending("a.md").then(() => disk.get("a.md"));
await Promise.resolve();
check("较新写在旧写完成前不会开始", !started.includes("a.md:baseline"), started);
eq("旧写仍在队列中", q.hasPending("a.md"), true);
await q.enqueue("b.md", "other");
eq("其他文件不被慢写阻塞", disk.get("b.md"), "other");
pause.resolve();
await Promise.all([older, undo]);
eq("撤销后的磁盘是基准版本", disk.get("a.md"), "baseline");
eq("切换后的读取不会拿到旧版本", await waitingRead, "baseline");
await Promise.resolve();
eq("队列结算后释放键", q.hasPending("a.md"), false);

console.log("失败不吞错,也不阻止较新版本写入");
const failuresOnPath: string[] = [];
const q2 = new SerializedFileWrites(async (path, content) => {
  if (content === "bad") throw new Error("disk full");
  disk.set(path, content);
});
const bad = q2.enqueue("a.md", "bad").catch((e: Error) => { failuresOnPath.push(e.message); });
const good = q2.enqueue("a.md", "recovered");
await Promise.all([bad, good, q2.waitForPending("a.md")]);
eq("错误传给发起的保存", failuresOnPath[0], "disk full");
eq("后续写仍能落盘", disk.get("a.md"), "recovered");

console.log("Markdown 与 Monaco 共用真实适配器");
eq("两个编辑模式用同一实例", markdownFileWrites, textFileWrites);
const slow = deferred();
const apiStarts: string[] = [];
setWriteHandler(async ({ filePath, content }) => {
  apiStarts.push(`${filePath}:${content}`);
  if (content === "markdown") await slow.promise;
  if (content === "rejected") return { ok: false };
  disk.set(filePath, content);
  return { ok: true };
});
const rich = markdownFileWrites.enqueue("mode.md", "markdown");
const source = textFileWrites.enqueue("mode.md", "source");
await Promise.resolve();
check("源码保存等富文本写完", !apiStarts.includes("mode.md:source"), apiStarts);
slow.resolve();
await Promise.all([rich, source]);
eq("源码保存不会被旧富文本写反盖", disk.get("mode.md"), "source");
let rejected = false;
await textFileWrites.enqueue("mode.md", "rejected").catch(() => { rejected = true; });
eq("IPC 返回 ok:false 是保存失败", rejected, true);
await textFileWrites.enqueue("mode.md", "after-failure");
eq("真实适配器失败后可重试", disk.get("mode.md"), "after-failure");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
