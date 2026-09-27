/**
 * MAINT-2026-09 / M07 · 本地路径、文件树与快照安全 —— 独占回归。
 *
 * ## 它盯的是什么
 *
 * `main/ipc/files.ts` 的处理器**同时用了两份不同的包含性判定**:
 *
 *  - 外层用共享的 `lib/pathGuard.ts`(`findContainingWorkspaceRoot` /
 *    `isKnownWorkspaceRoot`)—— 在 Windows / macOS 这类**大小写不敏感**的文件系统上
 *    刻意做了大小写归一(那个文件的头注释写明了缘由:Monaco / LSP 交上来的盘符
 *    可能是小写的 `d:\foo`,而项目根存的是 `D:\foo`);
 *  - 内层的"纵深防御"用的却是 `files.ts` 自己的一份私有 `pathWithin`,它是
 *    **大小写敏感**的裸 `resolve()` 前缀比较。
 *
 * 于是同一次调用里两道闸的结论可以相反:外层认下了这条路径、内层又判它越界。
 * 表现是**静默失败** —— `file:writeFile` 返回 `{ ok: false }`(编辑器"存不下去"),
 * `file:rename` 返回 `{ ok: false }`,而渲染端只看得到一个失败,主进程日志里才有
 * 一句 "escapes root"。
 *
 * 本套件直接驱动真实处理器,断言的是**两道闸必须给出同一个结论**。
 *
 * ## 平台
 *
 * 大小写这一组只在大小写不敏感的文件系统(win32 / darwin)上才有意义,别的平台
 * **显式跳过并打印**(不静默略过,也不伪称通过)。与平台无关的那几条(正常路径、
 * 越界、同名前缀兄弟目录)在所有平台都跑。
 *
 * 不起 Electron、不联网、不碰真实项目根:项目根是 mkdtemp 出来的临时目录,
 * 用完即删;数据根桩直接抛(文献库/模版库那一类根在本套件里不存在)。
 *
 * Run: scripts/maint-m07-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { IPC } from "@contracts/ipc";
import { listDirGuarded, readFileGuarded, registerFileHandlers } from "@main/ipc/files.js";
import { projectPaths, warnings } from "./stubs.js";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (Object.is(actual, expected)) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name} — ${JSON.stringify({ actual, expected })}`);
}

/** 大小写不敏感的文件系统 —— 与 pathGuard.ts 的判据一致。 */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/* ── 一个真实的临时项目 ─────────────────────────────────────────────────── */
const base = mkdtempSync(join(tmpdir(), "mcode-maint-m07-"));
// 目录名里同时有大小写字母,才变换得出一个"同一个目录、不同写法"的路径。
const projectRoot = join(base, "M07Proj");
mkdirSync(join(projectRoot, "src"), { recursive: true });
writeFileSync(join(projectRoot, "src", "index.ts"), "export const a = 1;\n", "utf-8");
projectPaths.push(projectRoot);

/** 把项目目录名换个大小写写法。**同一个目录**(在 win32/darwin 上),只是写法不同 ——
 *  这正是 Monaco / LSP 交回来的路径可能长的样子。 */
function caseVariant(p: string): string {
  const name = basename(projectRoot);
  return p.replace(projectRoot, join(dirname(projectRoot), name.toUpperCase()));
}

/* ── 假的 ipcMain:把处理器收下来直接调 ──────────────────────────────────── */
const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
registerFileHandlers({
  handle(channel: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) {
    handlers.set(channel, fn);
  },
} as never);
async function call(channel: string, payload: unknown): Promise<{ ok?: boolean }> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return (await fn(null, payload)) as { ok?: boolean };
}

try {
  /* ── 1. 基线:写法与登记的项目根完全一致时,一切正常(所有平台) ───────── */
  console.log("\n基线:路径写法与登记的项目根一致");
  const exact = join(projectRoot, "src", "index.ts");
  check("readFile 读得到", (await readFileGuarded(exact)).content.includes("export const a"), true);
  check("listDir 列得出 src", (await listDirGuarded(projectRoot, "src")).entries.length, 1);
  check("writeFile 存得下", (await call(IPC.FILE_WRITE, { filePath: exact, content: "export const a = 2;\n" })).ok, true);
  check("写进去的就是新内容", readFileSync(exact, "utf-8").trim(), "export const a = 2;");
  const renamedExact = join(projectRoot, "src", "renamed.ts");
  check("rename 改得动", (await call(IPC.FILE_RENAME, { oldPath: exact, newPath: renamedExact })).ok, true);
  check("改完文件真在新名字上", existsSync(renamedExact), true);

  /* ── 2. 越界仍然要挡住(所有平台) ──────────────────────────────────────── */
  console.log("\n越界仍然要挡住");
  const outside = join(base, "outside.ts");
  writeFileSync(outside, "secret\n", "utf-8");
  check("项目根之外的文件读不到", (await readFileGuarded(outside)).content, "");
  check("项目根之外的文件写不进", (await call(IPC.FILE_WRITE, { filePath: outside, content: "x" })).ok, false);
  check("越界写被挡住后原文件没被改", readFileSync(outside, "utf-8").trim(), "secret");
  const sibling = `${projectRoot}-other`;
  mkdirSync(sibling, { recursive: true });
  check("同名前缀的兄弟目录不算在根里", (await listDirGuarded(sibling, ".")).entries.length, 0);

  /* ── 3. 同一条路径,两道闸必须给出同一个结论 ──────────────────────────── */
  console.log("\n大小写:外层闸认下的路径,内层闸不能反过来判它越界");
  if (!CASE_INSENSITIVE) {
    console.log(`  skip  当前文件系统大小写敏感(${process.platform}),这一组不适用 —— 未执行,不计入通过数`);
  } else {
    const variantFile = caseVariant(renamedExact);
    check("前提:换个大小写写法指的是同一个文件", existsSync(variantFile), true);
    // 外层闸(共享 pathGuard)认下它 —— readFile 走的就是外层闸。
    check("外层闸认下这条路径:readFile 读得到", (await readFileGuarded(variantFile)).content.includes("export const a"), true);
    check("listDir 也认(projectPath 与 dirPath 同一份写法)", (await listDirGuarded(caseVariant(projectRoot), "src")).entries.length, 1);

    warnings.length = 0;
    const wrote = await call(IPC.FILE_WRITE, { filePath: variantFile, content: "export const a = 3;\n" });
    check("writeFile:同一条路径外层认下了,就不能被内层判越界", wrote.ok, true);
    check("writeFile:内容真的落到了盘上", readFileSync(renamedExact, "utf-8").trim(), "export const a = 3;");
    check("writeFile:没有 escapes root 的越界日志", warnings.filter((w) => w.includes("escapes root")).length, 0);

    warnings.length = 0;
    const variantNew = caseVariant(join(projectRoot, "src", "renamed2.ts"));
    const renamed = await call(IPC.FILE_RENAME, { oldPath: variantFile, newPath: variantNew });
    check("rename:同一条路径外层认下了,就不能被内层判越界", renamed.ok, true);
    check("rename:文件真的改了名", existsSync(join(projectRoot, "src", "renamed2.ts")), true);
    check("rename:没有 escapes root 的越界日志", warnings.filter((w) => w.includes("escapes root")).length, 0);
  }

  console.log(`\nmaint-m07-smoke: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) { console.error(`maint-m07-smoke: ${failures} FAILED`); process.exitCode = 1; }
} finally {
  rmSync(base, { recursive: true, force: true });
}

