/** MC-024: 真 OS 目录里的并发冲突副本，固定同一 ISO 毫秒而不接触用户文件。 */
import { mkdtemp, writeFile, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictCopyPathFor, writeConflictCopy } from "@main/lib/conflictCopy.js";
let total = 0, fail = 0;
function check(message: string, ok: boolean, actual?: unknown): void {
 total++; if (ok) console.log("  ok   " + message);
 else { fail++; console.log("  FAIL " + message + " — " + JSON.stringify(actual)); }
}
const root = await mkdtemp(join(tmpdir(), "mcode-conflict-race-"));
const originalIso = Date.prototype.toISOString;
try {
 Date.prototype.toISOString = function () { return "2026-10-19T05:05:05.123Z"; };
 const source = join(root, "report.txt");
 await writeFile(source, "preserved original");
 const first = conflictCopyPathFor(source);
 await writeFile(first, "do not overwrite this existing conflict");
 const bodies = Array.from({ length: 12 }, (_, i) => "parallel uncommitted body #" + i);
 const settled = await Promise.allSettled(bodies.map(body => writeConflictCopy(source, body)));
 const paths = settled.flatMap(x => x.status === "fulfilled" ? [x.value] : []);
 check("★ 十二个并发冲突请求都应成功", paths.length === bodies.length, settled.map(x => x.status));
 check("★ 十二个同时出现的同毫秒冲突都返回不同副本路径",
   new Set(paths).size === bodies.length, paths);
 const contents = await Promise.all(paths.map(path => readFile(path, "utf8")));
 check("★ 十二条副本每条保存调用者对应的字节，互不覆盖",
   paths.length === bodies.length && contents.every((value, index) => value === bodies[index]), contents);
 check("★ 原有时间戳冲突副本不得被并发 CAS 请求覆盖",
   (await readFile(first, "utf8")) === "do not overwrite this existing conflict");
 check("★ 原始目标文件不可被冲突副本写入改变",
   (await readFile(source, "utf8")) === "preserved original");
 check("★ 冲突路径是原目录下独立普通文件",
   (await Promise.all(paths.map(path => lstat(path)))).every(x => x.isFile() && x.nlink === 1));
 check("★ 并发冲突副本不得留下 .mcode-stage/.mcode-tmp 临时内容",
   (await readdir(root)).every(name => !name.includes(".mcode-stage") && !name.includes(".mcode-tmp")));

 // 源文件单个名字 224 UTF-16 单位是合法的，直接追加 .conflict-stamp
 // 会超过 Win32/多数文件系统的 255 字符上限，不能因此丢掉未保存正文。
 const longSource = join(root, "L".repeat(220) + ".txt");
 await writeFile(longSource, "long filename original");
 const longWrite = await Promise.allSettled([writeConflictCopy(longSource, "long conflict payload")]);
 check("★ 长合法源文件名的冲突副本仍能被保存",
   longWrite[0]?.status === "fulfilled", longWrite[0]?.status);
 if (longWrite[0]?.status === "fulfilled") {
   check("★ 长文件名新副本保留正文和 .txt 后缀",
     longWrite[0].value.endsWith(".txt")
     && (await readFile(longWrite[0].value, "utf8")) === "long conflict payload");
 }
 check("★ 长文件名冲突不能覆盖原始字节",
   (await readFile(longSource, "utf8")) === "long filename original");

} finally {
 Date.prototype.toISOString = originalIso;
 await rm(root, { recursive: true, force: true });
}
console.log("conflict-copy-race-smoke:" + (total-fail) + "/" + total);
if (fail) process.exitCode = 1;
