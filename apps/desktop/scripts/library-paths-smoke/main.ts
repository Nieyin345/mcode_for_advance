/**
 * Headless smoke for the library's **path guard** (`main/library/paths.ts`).
 *
 * ## The bug this exists for
 *
 * Two call sites ask "is this path outside the library?" and answered it by
 * inspecting the *return value* of `toLibraryRelative`:
 *
 *     if (toLibraryRelative(abs).startsWith("..")) return;   // ← 越界就拒
 *
 * But `toLibraryRelative` is a prefix **strip**, not a prefix **check**:
 *
 *     resolve(absPath).slice(resolve(libraryRoot()).length)
 *
 * For a path *outside* the library that happens to be **longer than the root**,
 * `slice` does not produce `..` — it produces an arbitrary tail of the string.
 * `C:/Windows/System32/drivers/etc/hosts` against a 40-char root yields `""`.
 * So the guard let exactly those paths through and only ever rejected the ones
 * shorter than the root. Both guards were effectively dead, on Windows, for
 * every path the user actually has.
 *
 * ## What it covers
 *
 *  - `isInsideLibrary` — the predicate that means what those call sites meant,
 *    over a table of inside / outside / traversing / prefix-collision paths;
 *  - the two real call sites' *behaviour* (`writeNote` refusing, `dropAbs`
 *    refusing) where they can be reached without a full app;
 *  - `toLibraryRelative` / `fromLibraryRelative` round-tripping, so tightening
 *    the guard cannot quietly break the path storage everything else reads.
 *
 * Run: scripts/library-paths-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数据根换成本脚本自己的临时目录(见 run.sh 的 `--alias`)。**必须在 import 被测模块
 *  之前设好** —— `libraryRoot()` 每次现读,所以顺序上其实不挑,但设早一点更清楚。 */
const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-paths-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const {
  isInsideLibrary,
  libraryRoot,
  toLibraryRelative,
  fromLibraryRelative,
  notePathForId,
  noteRelPathForId,
  pdfPathForHash,
  markdownPathForHash,
  markdownDirForHash,
  markdownArtifact,
  libraryFileExists,
} = await import("@main/library/paths.js");
const { writeNote } = await import("@main/library/notesImport.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { initDb } = await import("@main/store/db.js");

const ROOT = libraryRoot();
console.log(`\nlibrary root = ${ROOT} (${ROOT.length} chars)\n`);

/* ──────────────── 1. 库内 / 库外 ──────────────── */

console.log("isInsideLibrary(这个路径在不在库根下面)");

// 库内
check("库根自己算库内", isInsideLibrary(ROOT));
check("库内的 papers 子目录", isInsideLibrary(join(ROOT, "papers")));
check("库内的具体文件", isInsideLibrary(join(ROOT, "papers", "ab", "cd", "x.pdf")));
check("笔记文件", isInsideLibrary(join(ROOT, "notes", "n1.md")));
check("带 .. 但仍在库内(自己绕回来)", isInsideLibrary(join(ROOT, "notes", "..", "notes", "a.md")));

// **库外,而且比库根长** —— 这一档正是老代码放过去的那一批。
const LONGER_OUTSIDE = [
  ["系统目录", "C:/Windows/System32/drivers/etc/hosts"],
  ["用户文档", "C:/Users/someone/Documents/thesis/final-v2.docx"],
  ["同一个盘上的另一个文件夹", "D:/pictures/holiday/photo.jpg"],
  ["桌面上一个长路径", "C:/Users/someone/Desktop/一些资料/更深的目录/文件.pdf"],
] as const;
for (const [what, p] of LONGER_OUTSIDE) {
  check(`库外(${what},比库根长)—— 必须拒`, !isInsideLibrary(p));
}

// 库外,比库根短:老代码靠"切完是空串"碰巧也拦住了,新写法要一样拦得住。
const SHORTER_OUTSIDE = [
  ["数据根自己(库根的上一级)", resolve(ROOT, "..")],
  ["盘根", "C:/"],
  ["用户目录", "C:/Users/someone"],
] as const;
for (const [what, p] of SHORTER_OUTSIDE) {
  check(`库外(${what},比库根短)—— 必须拒`, !isInsideLibrary(p));
}

// **前缀相同但不是同一个目录**:库根是 `…/library`,这个兄弟目录叫 `…/library-old`。
// `startsWith(库根)` 那种写法会把它误判成库内 —— 这是收口时必须一并挡掉的一档。
const SIBLING = `${ROOT}-old`;
check(`库外的兄弟目录(${SIBLING.slice(-24)}…)—— 必须拒`, !isInsideLibrary(join(SIBLING, "papers", "a.pdf")));

/* ──────────────── 2. 从库内相对路径构造回来的,一定在库内 ──────────────── */

console.log("\n相对路径 ↔ 绝对路径(存库用的是相对路径)");

const rel = "papers/ab/cd/deadbeef.pdf";
eq("相对 → 绝对", fromLibraryRelative(rel), join(ROOT, "papers", "ab", "cd", "deadbeef.pdf"));
eq("绝对 → 相对(绕回来)", toLibraryRelative(fromLibraryRelative(rel)), rel);
check("绕回的路径仍然算库内", isInsideLibrary(fromLibraryRelative(rel)));

// 内容寻址那几个落点也走一遍 —— 它们是 PDF/Markdown 真正存的地方。
const sha = "a".repeat(64);
const pdfAbs = pdfPathForHash(sha);
check("pdfPathForHash 落在库内", isInsideLibrary(pdfAbs));
eq("pdfPathForHash → 相对 → 绝对 原样回来", fromLibraryRelative(toLibraryRelative(pdfAbs)), pdfAbs);
check("markdownPathForHash 落在库内", isInsideLibrary(markdownPathForHash(sha)));
check("markdownDirForHash(MinerU 那一整包)落在库内", isInsideLibrary(markdownDirForHash(sha)));

// 笔记是按 id 命名的(不是内容哈希)—— 它和 md 一起被 `dropAbs` 删。
const noteAbs = notePathForId("lit_abc123");
check("notePathForId 落在库内", isInsideLibrary(noteAbs));
eq("noteRelPathForId 与 toLibraryRelative 一致", noteRelPathForId("lit_abc123"), toLibraryRelative(noteAbs));

/* ──────────────── 3. 老写法在这里是错的(所以上面那些断言有意义) ──────────────── */

console.log("\n老判据(拿 toLibraryRelative 的返回值判越界)确实会放过去");

/** 逐字抄的老判据,只为在这里证明它错。**不要在生产代码里用它。** */
const oldGuardRejects = (p: string): boolean => toLibraryRelative(p).startsWith("..");

for (const [what, p] of LONGER_OUTSIDE) {
  check(
    `老判据对「${what}」判成库内(所以那次收口不是洁癖)`,
    !oldGuardRejects(p),
    { toLibraryRelative: toLibraryRelative(p) },
  );
}

/* ──────────────── 4. 两个真实调用点的行为 ──────────────── */

console.log("\n真实调用点:writeNote 拒掉越界路径");

await initDb();
mkdirSync(join(ROOT, "notes"), { recursive: true });

// 一个正常笔记:先建出来,证明守卫**不是**把什么都拒了。
const item = LibraryRepo.upsert({ kind: "note", title: "正常笔记", source: "note" });
LibraryRepo.setMarkdown(item.id, noteRelPathForId(item.id));
writeFileSync(notePathForId(item.id), "# 正常笔记\n", "utf8");
const good = writeNote(item.id, "# 改过的\n");
eq("正常笔记写得进去", good.ok, true);
eq("内容真的落了盘", libraryFileExists(noteRelPathForId(item.id)), true);

// 记录被写坏(路径指向库外)—— 必须拒,而且**不能碰**那个文件。
//
// 这一条的相对路径是**冲着 `OUTSIDE_FILE` 去的**:`../` 从库根爬一层正好是数据根,
// 而那个文件就在数据根下。所以下面"一个字节都没动"是一条**有牙**的断言 —— 守卫失效
// 的话写下去的就是它(老判据在这里确实拦不住:`abs` 比库根短,`slice` 给回空串,
// 空串不以 `..` 开头)。
const OUTSIDE_FILE = join(DATA, "不该被覆盖.txt");
writeFileSync(OUTSIDE_FILE, "原始内容", "utf8");
const bad = LibraryRepo.upsert({ kind: "note", title: "路径写坏的", source: "note" });
// `setMarkdown` 收的是**库内相对路径**,这里直接往库里塞一条越界的 —— 模拟记录被写坏 /
// 老版本留下的脏数据 / 将来某个新的写入方拼错了路径。
LibraryRepo.setMarkdown(bad.id, "../不该被覆盖.txt");
eq("坏记录解析出来确实指向库外那个文件", fromLibraryRelative("../不该被覆盖.txt"), OUTSIDE_FILE);
const refused = writeNote(bad.id, "被覆盖了");
eq("越界路径被拒", refused.ok, false);
check("而且说了原因", refused.error?.includes("越界") === true, refused.error);
const { readFileSync } = await import("node:fs");
eq("库外那个文件一个字节都没动", readFileSync(OUTSIDE_FILE, "utf-8"), "原始内容");

/* ──────────────── 5. 一份 md 产物占的是文件还是一个目录 ──────────────── */

console.log("\nmarkdownArtifact:删条目时该删什么");

// 三种落点各是一档。判错的后果不是报错,是**磁盘上永远留着一整包配图**(MinerU 与
// 「采纳 Markdown」的正文靠 `![](images/…)` 相对引用,只删那个 .md 就全断链了),
// 或者反过来 —— 该删文件时递归删掉了 `markdown/ab` 那一层,连累别的论文。
const MINERU_MD = join(markdownDirForHash(sha), "full.md"); // MinerU:目录名就是 sha
const IMPORTED_MD = join(ROOT, "markdown", "imported", "li_abc123", "读书笔记.md"); // 采纳:目录名是条目 id
const FLAT_MD = markdownPathForHash(sha); // 平的:markdown/<2>/<2>/<sha>.md

const flat = markdownArtifact(FLAT_MD);
eq("① 平的 → 删那个文件", flat.path, FLAT_MD);
eq("① 不递归", flat.recursive, false);

const mineru = markdownArtifact(MINERU_MD);
eq("② MinerU → 删整个 sha 目录", mineru.path, markdownDirForHash(sha));
eq("② 递归", mineru.recursive, true);

const imported = markdownArtifact(IMPORTED_MD);
eq("③ 采纳的 → 删整个条目目录(不是只删那个 md)", imported.path, join(ROOT, "markdown", "imported", "li_abc123"));
eq("③ 递归", imported.recursive, true);

// ③和①的**层数一样**(都是两层),早先那版按名字猜的判据在这里漏掉 ③。这条钉住
// "层数不能单独当判据" —— 只看层数的话 ③ 会被当成 ①,images/ 又留下。
eq("③ 和 ① 的层数确实一样(所以层数不是判据)",
  relative(join(ROOT, "markdown"), dirname(IMPORTED_MD)).split(sep).length,
  relative(join(ROOT, "markdown"), dirname(FLAT_MD)).split(sep).length);

// 相对路径来自数据库(可被写坏),两种极端都不能把根目录或库外的东西卷进去。
check("库外路径解析出来的东西仍在库外(交给 dropAbs 拦)", !isInsideLibrary("/etc/passwd-md"));
check("库根本身不会被当成某一份产物", markdownArtifact(join(ROOT, "markdown", "x.md")).path !== ROOT);

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
