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
 *  - **一个**真实调用点的行为:`writeNote` 拒掉越界路径(§4),而且断言**库外那个
 *    文件一个字节都没动** —— 拒绝本身不算数,没写下去才算;
 *  - `toLibraryRelative` / `fromLibraryRelative` round-tripping, so tightening
 *    the guard cannot quietly break the path storage everything else reads.
 *
 * ## 这里原本写着覆盖了"两个"调用点,那是吹的
 *
 * 另一个调用点是 `ipc/library.ts` 里删条目时那个 **`dropAbs` 局部闭包**(约 351 行),
 * 它拿不到、也起不来(要整个 IPC 环境)。本套实际能做的只有**替它验判据**——
 * `markdownArtifact` 会给它算"该删文件还是整目录"(§5/§6),`isInsideLibrary` 是它
 * 该用的那道闸门。**`dropAbs` 自己的行为至今零覆盖**,而它删的是用户磁盘上的东西。
 * 哪天有人给它补上,记得把这一段改掉。
 *
 * Run: scripts/library-paths-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { expandTilde, resolveBashWriteTargets } from "@main/providers/pi-sdk/bashWriteGuard.js";
import type * as TypeScript from "typescript";

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
  writeLandsInLibrary,
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
// ⚠️ 库根必须**真实存在**:`physicalPath()` 对不存在的路径返回 null(失败关闭),于是
// 物理那一层的用例会"因为根不存在"而红/绿,而不是因为链接 —— 那是不诚实的断言。先落盘。
mkdirSync(ROOT, { recursive: true });
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

/* ──────────── 1b. MC-006:库内合法的点文件名(**不被**当成逃逸)────────────
 *
 * `..` 前缀判据必须带分隔符。裸 `startsWith("..")` 会把库内合法的 `..config` /
 * `..backup` 当成"爬出去了"而拒掉 —— 独立复核实测反例正是这一格。 */
console.log("\nMC-006:库内合法的两点前缀文件名");
check("库内的 `..config`(合法点文件)—— 认作库内", isInsideLibrary(join(ROOT, "..config")));
check("库内的 `..backup` —— 认作库内", isInsideLibrary(join(ROOT, "papers", "..backup")));
check("库内的 `..hidden.txt` —— 认作库内", isInsideLibrary(join(ROOT, "notes", "..hidden.txt")));
// 反向控制:真逃逸仍然拒(`..` 与 `../`)。
check("`../escape` —— 仍拒", !isInsideLibrary(join(ROOT, "..", "escape")));
check("`..` 本身(库根的上一级)—— 仍拒", !isInsideLibrary(join(ROOT, "..")));

/* ──────────── 1c. MC-001:symlink / junction 指向库外必须拒 ────────────
 *
 * 库里的一个链接可以指向库外,而**字面**路径看着仍在库里 —— 纯字面判据对此无感。
 * 独立复核实测:`library/link` 指向外部目录时,旧的纯字面判据返回"在库内"。 */
console.log("\nMC-001:经 symlink / junction 指向库外");
{
  const outsideDir = join(DATA, "outside-lib-target");
  mkdirSync(outsideDir, { recursive: true });
  const linkPath = join(ROOT, "escape-link");
  let made = false;
  try {
    symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    made = true;
  } catch {
    made = false; // 平台不允许(Windows 非管理员)—— 跳过这组,不判红
  }
  if (made) {
    check(
      "★ 经链接指向库外的文件 —— 必须拒(字面在里面,物理在外面)",
      !isInsideLibrary(join(linkPath, "secret.txt")),
    );
  } else {
    check("平台不允许创建链接 —— 跳过物理越界用例(不判红)", true);
  }
}

/* ──────────── 1d. MC-001(反方向):项目里指向库的 junction ────────────
 *
 * 第十三轮独立复查的反例:`isInsideLibrary` 兼了两种语义,**漏判"写进来"**。
 * 项目目录里建一个 `project/alias` → 库根,于是 `project/alias/note.md`:
 *   - `isInsideLibrary` = **false**(字面在库外 —— 它字面上确实是别处的别名);
 *   - `writeLandsInLibrary` = **true**(真实目的地就是那篇库内笔记)。
 * Claude 的 `canUseTool`、Pi 的 `guardToolPath` 与 bash 重定向检查拿的是**后者**,
 * 所以这里两个函数都要按各自的语义给对答案 —— 不是"谁对谁错",是**两问两答**。 */
console.log("\nMC-001:项目里指向库的 junction(反方向 —— 写进来)");
{
  // ⚠️ 库根本身要**真实存在** —— `physicalPath()` 对不存在的路径返回 null(失败关闭),
  // 那样两个判据都会是 false,用例就成了"假红"。先落盘再建链接。
  mkdirSync(join(ROOT, "notes"), { recursive: true });
  const projectDir = join(DATA, "some-project");
  mkdirSync(projectDir, { recursive: true });
  const aliasIntoLib = join(projectDir, "alias");
  let made = false;
  try {
    // 已存在就先删(重跑),再建 junction 指向库根。
    rmSync(aliasIntoLib, { recursive: true, force: true });
    symlinkSync(ROOT, aliasIntoLib, process.platform === "win32" ? "junction" : "dir");
    made = true;
  } catch {
    made = false; // 平台不允许 —— 跳过物理那一半,不判红
  }
  if (made) {
    const viaAlias = join(aliasIntoLib, "notes", "n1.md");
    check(
      "★ 经项目别名写库 —— writeLandsInLibrary 必须为 true(拦下来)",
      writeLandsInLibrary(viaAlias),
    );
    check(
      "同一个路径 isInsideLibrary 为 false —— 它字面上是别处的别名(两问两答,不是矛盾)",
      !isInsideLibrary(viaAlias),
    );
    // 反向控制:库内的正常路径两个函数都该为真,别名不该把正常情况也搞乱。
    check("库内正常笔记路径 —— 两个判据都为 true", isInsideLibrary(join(ROOT, "notes", "n1.md")) && writeLandsInLibrary(join(ROOT, "notes", "n1.md")));
    // 反向控制:库外的普通目录(不指向库)—— 写也不该被判成落进库。
    check("库外的普通目录 —— writeLandsInLibrary 为 false(不许过敏)", !writeLandsInLibrary(join(projectDir, "src", "main.ts")));
    // 反向控制:库内一个链接指向库外 —— "写出去"仍然要拦(旧行为不许被这次改动弄丢)。
    const libLink = join(ROOT, "out-link");
    rmSync(libLink, { recursive: true, force: true });
    const outsideDir2 = join(DATA, "out-target-2");
    mkdirSync(outsideDir2, { recursive: true });
    let made2 = false;
    try {
      symlinkSync(outsideDir2, libLink, process.platform === "win32" ? "junction" : "dir");
      made2 = true;
    } catch {
      made2 = false;
    }
    if (made2) {
      // 库内一个链接指向库外:写它**不会**碰到库(目的地是库外的目录),所以
      // `writeLandsInLibrary` = false —— 这不是漏判,是**判得准**。库外那一段由
      // **项目边界**那一道管(它拦的是"写到项目外"),与"库只读"是两回事。
      // 这条反向控制是防"有人把 writeLandsInLibrary 写成只看字面" —— 那样这里会
      // 变成 true,等于把库内合法的外指链接也一并算作"库内写入"。
      check(
        "库内链接指向库外 —— writeLandsInLibrary 为 false(目的地是库外,库只读管不着)",
        !writeLandsInLibrary(join(libLink, "x.txt")),
      );
      check(
        "同一个链接 isInsideLibrary 也为 false(两个判据都看物理落点)",
        !isInsideLibrary(join(libLink, "x.txt")),
      );
    }
  } else {
    check("平台不允许创建链接 —— 跳过反方向物理用例(不判红)", true);
    check("平台不允许创建链接 —— 跳过别名 isInsideLibrary 用例(不判红)", true);
  }
}

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

/* ──────────────── 4. 一个真实调用点的行为 ──────────────── */

console.log("\n真实调用点:writeNote 拒掉越界路径");

await initDb();
mkdirSync(join(ROOT, "notes"), { recursive: true });

// 一个正常笔记:先建出来,证明守卫**不是**把什么都拒了。
const item = LibraryRepo.upsert({ title: "正常笔记" });
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
const bad = LibraryRepo.upsert({ title: "路径写坏的" });
// `setMarkdown` 收的是**库内相对路径**,这里直接往库里塞一条越界的 —— 模拟记录被写坏 /
// 老版本留下的脏数据 / 将来某个新的写入方拼错了路径。
LibraryRepo.setMarkdown(bad.id, "../不该被覆盖.txt");
eq("坏记录解析出来确实指向库外那个文件", fromLibraryRelative("../不该被覆盖.txt"), OUTSIDE_FILE);
const refused = writeNote(bad.id, "被覆盖了");
eq("越界路径被拒", refused.ok, false);
check("而且说了原因", refused.error?.includes("越界") === true, refused.error);
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
//
// ⚠️ 这一条**替 `dropAbs` 验判据**(它在 `ipc/library.ts` 里是个局部闭包,本套够不着
// —— 见文件头)。也就是说这里证明的是"闸门本身是好的",**不是**"`dropAbs` 用了它"。
// 两者之间那道缝没人守着,别把这一条读成"dropAbs 验过了"。
check("库外路径解析出来的东西仍在库外(dropAbs 该用的那道闸门挡得住)", !isInsideLibrary("/etc/passwd-md"));
check("库根本身不会被当成某一份产物", markdownArtifact(join(ROOT, "markdown", "x.md")).path !== ROOT);

/* ──────────────── 6. 认不出来的落点一律**只删文件** ──────────────── */

console.log("\nmarkdownArtifact · 不认识的形状不能猜成目录");

// 这一段的形状是 2026-09-19 发现的真实数据丢失:`mdPath` 是笔记时是
// `<根>/notes/<id>.md`,而它**不在 `markdown/` 下面** —— 于是"从 markdown 数层数"
// 那条判据数出来是 0 层,落到"整个目录"那一支,算出 `<根>/notes` + 递归。
// 删一篇笔记就把**用户其它所有笔记**一起删了。
//
// 根子上的错是**默认选错了一边**:不认识的时候猜"目录",而猜错的两种后果不对称 ——
// 删少了只是留点垃圾(看得见、还能再删),删多了是不可恢复的。所以判据反过来:
// **只有明确认得出是那两种目录形状时才递归,其余一律只删那个文件。**
const NOTE_MD = join(ROOT, "notes", "li_notekey.md");
const note = markdownArtifact(NOTE_MD);
eq("笔记 → 删那个文件本身", note.path, NOTE_MD);
eq("笔记 → 不递归", note.recursive, false);
check("笔记那条路绝不能碰到 notes/ 目录(那里面是别的笔记)", note.path !== join(ROOT, "notes"));

// 认不出来的落点(NOTES 之外的目录、或者谁手改过数据库)同理 —— 只删文件。
for (const [what, p] of [
  ["库根正下方", join(ROOT, "随便.md")],
  ["exports 里", join(ROOT, "exports", "引文.bib.md")],
  ["markdown 下面但只有一层", join(ROOT, "markdown", "一层", "a.md")],
  ["markdown 下面三层但中间不是 sha", join(ROOT, "markdown", "imported", "li_x", "再来一层", "a.md")],
] as const) {
  const art = markdownArtifact(p);
  eq(`${what} → 只删文件`, art.path, p);
  eq(`${what} → 不递归`, art.recursive, false);
}

// 反过来:两种真目录形状**必须**认出来,否则 images/ 会永远留在磁盘上。
eq("MinerU 那一种仍然递归", markdownArtifact(MINERU_MD).recursive, true);
eq("采纳那一种仍然递归", markdownArtifact(IMPORTED_MD).recursive, true);

// 递归的那两种,删的目录**必须是那个产物的目录**,不能往上多爬一级 ——
// `markdown/<ab>/<cd>/` 那一层是所有同前缀论文共用的。
check(
  "MinerU 删的是 sha 那一层,不是它上面的 markdown/ab/ab",
  markdownArtifact(MINERU_MD).path === markdownDirForHash(sha) &&
    markdownArtifact(MINERU_MD).path !== dirname(markdownDirForHash(sha)),
);
check(
  "采纳删的是条目目录,不是整个 imported/",
  markdownArtifact(IMPORTED_MD).path !== join(ROOT, "markdown", "imported"),
);

/* ──────────────── 7. 「库只读」是**显式**规则,不是项目边界的副产品 ──────────────── */

/**
 * `canUseTool` 里那条库只读拦截不好直接调(在 provider 内部、要整套 SDK 上下文),
 * 所以这里用**源码断言**钉住它的存在与形状 —— 本套件既有的做法之一(§5 末尾那条也是)。
 *
 * ## 为什么这条必须钉
 *
 * 「写只能在项目内」**恰好**等于「库只读」:库根默认在 `<数据根>/library`,与用户的
 * 项目目录不重叠。那是**巧合** —— 一旦库被搬进项目里,那条规则就静默失效,而没有任何
 * 东西会提醒。所以库里那一条是**独立**的显式规则,而且 `bypassPermissions` 也拦
 * (库只读是硬边界,不是权限模式能覆盖的)。这四条就是防它哪天被"顺手删掉"。
 */
console.log("\n库只读是显式规则（不是项目边界的副产品）");
const providerSrc = readFileSync(
  join(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"),
  "utf-8",
);
// ⚠️ 判据要盯**生效的形状**,不是"文本里出现过这个词" —— 第一版写成
// `includes("isInsideLibrary(norm.absPath)")`,结果是变异"把 if 改成 if (false && …)"
// 照样过:字符串还在,规则却已经死了。所以这里剥掉注释后找那条**真的 if 语句**。
//
// 【MC-001,第十三轮复查】判据从 `isInsideLibrary` 换成 `writeLandsInLibrary`:前者
// 要求**字面也在**库下,项目里一个指向库的 junction 字面在库外 → 规则静默漏判。
// 这条断言同时钉住"用的是**职责对**的那个函数" —— 谁把它改回 `isInsideLibrary`,
// 这里就该红。
const providerCode = providerSrc.replace(/\/\/[^\n]*/g, "");
check(
  "canUseTool 里有一条**生效的**库内拒绝（不是被注释/短路掉的）",
  /if\s*\(\s*writeLandsInLibrary\(norm\.absPath\)\s*\)/.test(providerCode),
);
check(
  "库内写入那条拒在 project 边界判定**之前**（bypass 也拦不住它）",
  providerCode.indexOf("writeLandsInLibrary(norm.absPath)") !== -1 &&
    providerCode.indexOf("writeLandsInLibrary(norm.absPath)") <
      providerCode.indexOf("if (!norm.insideProject && !bypass)"),
);
check("拒绝文案说清「资料库是只读的」", providerSrc.includes("资料库是只读的"));
check("…并给出正确出路（先复制进项目再改）", providerSrc.includes("在项目里改"));
// 库只读那条**不是**条件于 bypass 的 —— 它是独立硬边界,不能写成 `… && !bypass`。
// (能在 bypass 下拦,靠的是它跟权限模式无关,而不是靠项目边界顺带。)
check(
  "库只读那条**没有**和 bypass 挂钩(不是 `&& !bypass`)",
  !/writeLandsInLibrary\(norm\.absPath\)\s*&&\s*!?\s*bypass/.test(providerCode),
);

/* ──────────── 8. 真实执行点:两方向别名 × 真实 junction 树（MC-001 完整验收）────────────
 *
 * §1c/§1d 证明的是**判据**在真实 junction 上给对答案;§7 证明的是**调用点文本**里确实
 * 调了那个判据。但 §18.1/§21.2 的验收要求的是「**真实执行点**」—— 不能只证明函数
 * 返回 true/false、或文本里出现过那个名字,而忽略了实际执行点到底有没有调它、调了以后
 * 拦不拦得住。所以这一段把 Pi 的**真** `guardToolPath`(从源码里用 TS AST 抽出来、依赖
 * 注入**真**实现)跑在**真建出来的 junction 树**上,两个方向、严格/默认/bypass 三档都过:
 *
 *   (A) **库内一个链接指向库外**:写它**物理落点在库外** —— 库只读规则**不该**触发
 *       (它根本没碰库),由项目边界/OS 那一层管。这一条防的是"把库只读写成只看字面",
 *       那样 `library/outlink/x` 会被误当成"库内写入"而拒 —— 判得**过宽**,也是错。
 *   (B) **项目里一个别名指向库**:写它**物理落点在库内** —— 库只读规则**必须**触发,
 *       且 strict=false(bypass)也不能放。这正是第十三轮复查记下的漏判点。
 *
 * 最后加两条反向控制:合法项目文件在每一档都必须**写得进去**(守卫不许过敏),以及
 * bash 重定向目标经**真**解析器 + **真**判据也点得中库路径(bash 分支的直接证据)。
 */
console.log("\nMC-001 完整验收:真实 guardToolPath × 真实 junction 树");

// 从真源码里抽出 guardToolPath(与 engine-regressions 抽 guardToolPath 同一手法),
// 依赖注入**真实现**,而不是替身 —— 这样测的是"真执行点 + 真判据"。
{
  const ts = createRequire(join(process.cwd(), "package.json"))("typescript") as typeof TypeScript;
  const extSrc = readFileSync(
    join(process.cwd(), "src/main/providers/pi-sdk/mcodeExtension.ts"),
    "utf-8",
  );
  const extFile = ts.createSourceFile("mcodeExtension.ts", extSrc, ts.ScriptTarget.Latest, true);
  const gDecl = extFile.statements.find(
    (n): n is TypeScript.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === "guardToolPath",
  );
  check("真源码里找得到 guardToolPath", !!gDecl);
  const gJs = ts.transpileModule(
    `${gDecl!.getText(extFile)}\nmodule.exports.guardToolPath = guardToolPath;\n`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const gMod = { exports: {} as { guardToolPath: (cwd: string, raw: string, strict: boolean) =>
    { denied: true; message: string } | { denied: false; path: string } } };
  new Function(
    "normalizeToolFilePath",
    "expandTilde",
    "writeLandsInLibrary",
    "module",
    "exports",
    gJs,
  )(normalizeToolFilePath, expandTilde, writeLandsInLibrary, gMod, gMod.exports);
  const realGuardToolPath = gMod.exports.guardToolPath;

  // 真建一棵树:库根(已在上文落盘)、一个项目目录、一个库外目录。
  const projDir = join(DATA, "proj");
  mkdirSync(join(projDir, "src"), { recursive: true });
  writeFileSync(join(projDir, "src", "main.ts"), "export const ok = 1;\n");
  mkdirSync(join(ROOT, "notes"), { recursive: true });
  writeFileSync(join(ROOT, "notes", "protected.md"), "受保护的库内笔记\n");
  const outsideDir = join(DATA, "outside-of-lib");
  mkdirSync(outsideDir, { recursive: true });

  // (B) 项目里一个别名 → 库根。
  const aliasIntoLib = join(projDir, "alias");
  rmSync(aliasIntoLib, { recursive: true, force: true });
  // (A) 库内一个链接 → 库外。
  const linkOutOfLib = join(ROOT, "outlink");
  rmSync(linkOutOfLib, { recursive: true, force: true });
  let linksMade = false;
  try {
    symlinkSync(ROOT, aliasIntoLib, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(outsideDir, linkOutOfLib, process.platform === "win32" ? "junction" : "dir");
    linksMade = true;
  } catch {
    linksMade = false;
  }

  if (linksMade) {
    const viaAliasB = join(aliasIntoLib, "notes", "protected.md");
    // (B) bypass 档 —— 项目边界关掉了,只有库只读那条硬规则能拦。
    const bBypass = realGuardToolPath(projDir, viaAliasB, false);
    check("★ (B) 项目别名→库:真 guardToolPath 在 **bypass** 档必须拒", bBypass.denied === true, bBypass);
    check("★ …而且拒绝文案点名「资料库」", bBypass.denied === true && /资料库/.test(bBypass.message));
    // (B) 严格/默认档 —— 也必须拒。
    const bStrict = realGuardToolPath(projDir, viaAliasB, true);
    check("★ (B) 项目别名→库:真 guardToolPath 在 **严格** 档必须拒", bStrict.denied === true, bStrict);
    // 真判据对这根别名给的方向也要**真**:
    check("★ (B) 真 writeLandsInLibrary 对项目别名判断为 true(物理落点在库)", writeLandsInLibrary(viaAliasB));
    check("…同路径真 isInsideLibrary 为 false(两问两答,记录语义不变)", !isInsideLibrary(viaAliasB));
    check("…两个判据合起来证明库内笔记**不会被本次改动漏放**", writeLandsInLibrary(viaAliasB) && !isInsideLibrary(viaAliasB));

    // (A) 库内链接 → 库外:写它落点在**库外**,库只读规则**不该**触发。
    const viaOutA = join(linkOutOfLib, "a.txt");
    const aBypass = realGuardToolPath(projDir, viaOutA, false);
    check("(A) 库内链接→库外:bypass 档**不**被库只读规则误拦(落点不在库)", aBypass.denied === false, aBypass);
    check("(A) 真 writeLandsInLibrary 对库外落点为 false(不把库外当成库内)", !writeLandsInLibrary(viaOutA));
    // (A) 严格档由**项目边界**(不是库只读)拦 —— 拒绝语里不该出现「资料库」。
    const aStrict = realGuardToolPath(projDir, viaOutA, true);
    check(
      "(A) 严格档即使拦,拒绝语也**不**该说是资料库(是项目边界在拦,别错报原因)",
      aStrict.denied === false || !/资料库/.test(aStrict.message),
      aStrict,
    );

    // 反向控制:合法项目文件每一档都必须写得进去(守卫不许过敏)。
    check("★ 合法项目文件在 bypass 档可写", realGuardToolPath(projDir, join(projDir, "src", "main.ts"), false).denied === false);
    check("★ 合法项目文件在严格档也可写", realGuardToolPath(projDir, join(projDir, "src", "main.ts"), true).denied === false);

    // bash 分支的直接证据:真 `resolveBashWriteTargets` 解析出的目标,经真判据点得中库。
    const cmd = `printf x > "${viaAliasB}"`;
    const bashTargets = resolveBashWriteTargets(projDir, cmd);
    check(
      "★ bash 重定向(`> 项目别名/库文件`)经真解析器 + 真判据点得中库路径",
      bashTargets.some((t) => writeLandsInLibrary(t.absPath)),
      bashTargets,
    );
    // 反向控制:库内链接→库外 的 bash 目标,真判据不该点中库。
    const bashTargetsA = resolveBashWriteTargets(projDir, `printf x > "${viaOutA}"`);
    check(
      "bash 目标落在库外时真判据不误报(不把库外算成库)",
      !bashTargetsA.some((t) => writeLandsInLibrary(t.absPath)),
      bashTargetsA,
    );
  } else {
    check("平台不允许创建链接 —— 跳过真实执行点两方向用例(不判红)", true);
  }
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
