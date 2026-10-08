import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC } from "@contracts/ipc";
import { pathWithin, findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { readFileGuarded, listDirGuarded, registerFileHandlers } from "@main/ipc/files.js";
import { projectPaths } from "../maint-m07-smoke/stubs.js";

const base = mkdtempSync(join(tmpdir(), "mcode-p1-path-"));
const root = join(base, "project");
const outside = join(base, "private");
mkdirSync(root); mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "PRIVATE");
projectPaths.push(root);
const handlers = new Map<string, (evt: unknown, input: unknown) => Promise<any>>();
registerFileHandlers({ handle: (channel: string, fn: (evt: unknown, input: unknown) => Promise<any>) => { handlers.set(channel, fn); } } as never);
const invoke = (channel: string, input: unknown): Promise<any> => handlers.get(channel)!(null, input);
function check(message: string, value: unknown, expected: unknown) {
  if (!Object.is(value, expected)) throw new Error(`${message}: got ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
  console.log("ok", message);
}
try {
  const link = join(root, "portal");
  try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (err) {
    if (process.platform !== "win32") throw err;
    console.log("skip junction creation requires Windows symlink privilege", String(err));
    process.exit(0);
  }
  const target = join(link, "secret.txt");
  check("lexical path lies inside root", target.startsWith(root), true);
  check("linked target refused by shared guard", pathWithin(root, target), false);
  check("linked target refused by workspace guard", findContainingWorkspaceRoot(target), null);
  check("linked target cannot be read", (await readFileGuarded(target)).content, "");
  check("linked target cannot be written", (await invoke(IPC.FILE_WRITE, { filePath: target, content: "ALTERED" })).ok, false);
  check("target unchanged", readFileSync(join(outside, "secret.txt"), "utf8"), "PRIVATE");
  check("linked directory cannot be listed", (await listDirGuarded(root, "portal")).entries.length, 0);
  check("linked nonexistent child cannot be created", (await invoke(IPC.FILE_WRITE, { filePath: join(link, "new.txt"), content: "BAD" })).ok, false);
  check("no outside child created", existsSync(join(outside, "new.txt")), false);
  check("genuine missing descendant allowed", pathWithin(root, join(root, "fresh", "note.txt")), true);
  check("same-prefix sibling refused", pathWithin(root, `${root}-other`), false);
  // file.copy 的 suffix 来自渲染端;`../../escape` 曾能被 join 规范化后写到项目根之外。
  writeFileSync(join(root, "s.txt"), "SRC");
  const copyRes = await invoke(IPC.FILE_COPY, { srcPath: join(root, "s.txt"), destDir: root, suffix: "../../escape" });
  check("copy with traversal suffix still succeeds (sanitized)", copyRes.ok, true);
  check("copy landed inside the project root", existsSync(join(root, "s escape.txt")), true);
  check("traversal suffix did not write outside the root", existsSync(join(base, "escape.txt")), false);
  // 剪贴板粘贴目录**只有一个出口**(`pasteTempDir()`):写(通过 clipboard:saveFile)与
  // 读放行(isPasteTempPath 守卫)必须指向同一个目录。从前两处各写一份字面量,改名漏一处
  // 就"写进 A、放行的却是 B",粘贴的图片在编辑器里打不开。这条盯住它别再分家。
  const filesSrc = readFileSync(join(process.cwd(), "src/main/ipc/files.ts"), "utf8");
  check("粘贴目录名只有一份字面量(读/写共用 pasteTempDir)", (filesSrc.match(/"mcode-pastes"/g) ?? []).length, 1);
  console.log("maint-p1-path-smoke: 15/15 passed");
} finally { rmSync(base, { recursive: true, force: true }); }
