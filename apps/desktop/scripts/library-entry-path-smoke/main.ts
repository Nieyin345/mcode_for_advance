/**
 * `library.entryPath` 的回归网 —— **条目 id → 磁盘绝对路径**。
 *
 * ## 为什么要有这一套
 *
 * 这一条 IPC 是"**在主页面里编辑资料库文件**"那条路的关键一跳：中间栏的
 * `FileEditor` 全程按**绝对路径**读写（`file:readFile` / `file:writeFile`），
 * 而资料库只能给 **id**。用户 2026-09-21 的规矩是「不管从哪打开，只要在主页面
 * 显示就得能编辑」，所以资料库双击也落到了 `FileEditor` 上 —— 靠的就是这里。
 *
 * ## 它最容易错在哪儿（每一条都有对应断言）
 *
 *  1. **四条来源只认一条**。资料库的条目形状不统一：通用条目落在 `file_path`，
 *     论文落在 `pdf_path` / `md_path`，而且 `entry_mode` 还分 linked / attached
 *     （前者是绝对路径、后者相对库根）。判据分家的话，表现是**某些条目永远
 *     "没有关联文件"** —— 用户截过那张图。
 *  2. **`which` 名不副实**。指名要 `md` 却悄悄拿 PDF 顶上（或反过来），是个已经
 *     发生过一次的 bug 形态：中间栏从前"点的是 PDF、显示的是转录"。
 *  3. **目录被当成可编辑文件**。目录是"往下翻"那一层，交给 Monaco 只会得到一堆
 *     没意义的操作 —— 所以它必须**如实报 isDir**，让调用方退回预览。
 *  4. **路径算错了不报**。这一条把路径交出去给渲染端，错法安静得多：文件被移走了
 *     还照给路径，编辑器打开是空白，用户以为文件坏了。
 *
 * Run: scripts/library-entry-path-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

/* ──────────────── 0. 起环境 ──────────────── */

const TMP = mkdtempSync(join(tmpdir(), "mcode-entry-path-"));
const DATA = join(TMP, "data");
const PROJECT = join(TMP, "proj");
mkdirSync(DATA, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { IPC } = await import("@contracts/ipc");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
const { initDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { libraryRoot } = await import("@main/library/paths.js");

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;
registerLibraryHandlers(fakeIpc);
await initDb();

const entryPath = (raw: unknown): Promise<{ path: string | null; isDir?: boolean; error?: string }> => {
  const fn = handlers.get(IPC.LIBRARY_ENTRY_PATH);
  if (!fn) throw new Error("没注册 LIBRARY_ENTRY_PATH");
  return Promise.resolve(fn(null, raw)) as Promise<{ path: string | null; isDir?: boolean; error?: string }>;
};

const LIB = libraryRoot();

/** 直接写 `md_path`。`LibraryRepo` **没有** setMd（md 平时是转换产物落的），
 *  而这一套要造"既有 PDF 又有转录"的形状，所以这里写一条最小的 UPDATE。 */
async function setMdPath(id: string, mdRel: string): Promise<void> {
  const { getDb } = await import("@main/store/db.js");
  getDb().run("UPDATE library_items SET md_path = ?, updated_at = ? WHERE id = ?", [
    mdRel,
    Date.now(),
    id,
  ]);
}

/* ──────────────── 1. attached（相对库根）+ pdf/md 两条 ──────────────── */

console.log("\n1. 论文那种形状：attached + pdf_path / md_path");

{
  const sha = "a".repeat(64);
  const rel = join("papers", "aa", "aa", `${sha}.pdf`);
  const abs = join(LIB, rel);
  mkdirSync(join(LIB, "papers", "aa", "aa"), { recursive: true });
  writeFileSync(abs, "%PDF-1.7 fake");

  const item = LibraryRepo.upsert({ kind: "paper", title: "一篇论文", source: "manual" });
  LibraryRepo.setPdf(item.id, rel, sha);

  const res = await entryPath({ id: item.id });
  // ★ 这一条是"双击能编辑"的全部依据：算得出绝对路径。
  check("★ 由 pdf_path 算得出绝对路径", res.path !== null, res);
  eq("★ 而且就是那个文件的位置", res.path, abs);
  check("★ 不是目录", res.isDir !== true, res);
  check("★ 它真的在盘上", res.path !== null && existsSync(res.path), res.path);
}

/* ──────────────── 2. which 指名要哪一份，就给哪一份 ──────────────── */

console.log("\n2. which：指名哪一份就给哪一份，不拿另一样顶");

{
  const sha = "b".repeat(64);
  const pdfRel = join("papers", "bb", "bb", `${sha}.pdf`);
  const mdRel = join("markdown", "bb", "bb", `${sha}.md`);
  mkdirSync(join(LIB, "papers", "bb", "bb"), { recursive: true });
  mkdirSync(join(LIB, "markdown", "bb", "bb"), { recursive: true });
  writeFileSync(join(LIB, pdfRel), "%PDF fake");
  writeFileSync(join(LIB, mdRel), "# 转录");

  const item = LibraryRepo.upsert({ kind: "paper", title: "有转录的", source: "manual" });
  LibraryRepo.setPdf(item.id, pdfRel, sha);
  await setMdPath(item.id, mdRel);

  const bare = await entryPath({ id: item.id });
  check("★ 不指名 → 默认给 PDF（本体）", bare.path?.endsWith(".pdf") === true, bare);
  const wantMd = await entryPath({ id: item.id, which: "md" });
  check("★ 指名 md → 给转录", wantMd.path?.endsWith(".md") === true, wantMd);
  const wantPdf = await entryPath({ id: item.id, which: "pdf" });
  check("★ 指名 pdf → 给 PDF", wantPdf.path?.endsWith(".pdf") === true, wantPdf);
}

/* ──────────────── 3. 只有转录的那些 ──────────────── */

console.log("\n3. 只有转录、没有 PDF 的条目");

{
  const mdRel = join("notes", "only-md.md");
  mkdirSync(join(LIB, "notes"), { recursive: true });
  writeFileSync(join(LIB, mdRel), "# 只有转录");

  const item = LibraryRepo.upsert({ kind: "note", title: "一条笔记", source: "manual" });
  await setMdPath(item.id, mdRel);

  const bare = await entryPath({ id: item.id });
  // 未指名时顺序是 本体 → PDF → 转录，所以这里给的是转录 —— 有东西可看比报错好。
  check("★ 未指名 → 退到转录（总比报错好）", bare.path !== null, bare);
  // ★ 但**指名要 PDF 时不能拿转录顶上** —— 那正是上次那个"点的是 PDF、看到的是转录"。
  const wantPdf = await entryPath({ id: item.id, which: "pdf" });
  eq("★ 指名 pdf 而没有 → 如实报缺，不顶替", wantPdf.path, null);
  check("★ 而且给了一句人话", (wantPdf.error ?? "").length > 0, wantPdf);
}

{
  // ★ **反方向**：有 PDF、没有转录，而用户指名要 md。
  //   这一条是我第一版测试漏掉的 —— 变异（"指名 md 找不着就退回 PDF"）当时
  //   **没被抓住**，因为用例里那条条目两样都有、走不到退回那一支。
  //   反面比正面重要：拿 PDF 顶替转录，用户看到的就是一篇 PDF 却以为自己在读转录。
  const sha = "d".repeat(64);
  const pdfRel = join("papers", "dd", "dd", `${sha}.pdf`);
  mkdirSync(join(LIB, "papers", "dd", "dd"), { recursive: true });
  writeFileSync(join(LIB, pdfRel), "%PDF fake");

  const item = LibraryRepo.upsert({ kind: "paper", title: "只有 PDF", source: "manual" });
  LibraryRepo.setPdf(item.id, pdfRel, sha);

  const wantMd = await entryPath({ id: item.id, which: "md" });
  eq("★ 指名 md 而没有 → 如实报缺（不拿 PDF 顶替）", wantMd.path, null);
  check("★ 而且给了一句人话", (wantMd.error ?? "").length > 0, wantMd);

  const bare = await entryPath({ id: item.id });
  check("未指名 → 给 PDF", bare.path?.endsWith(".pdf") === true, bare);
}

/* ──────────────── 4. 目录必须如实报 isDir ──────────────── */

console.log("\n4. 目录条目：报 isDir，别让调用方把它丢给编辑器");

{
  const dirRel = join("misc", "a-folder");
  mkdirSync(join(LIB, dirRel), { recursive: true });
  const item = LibraryRepo.upsert({ kind: "document", title: "一个目录", source: "manual" });
  LibraryRepo.setFilePath(item.id, dirRel);

  const res = await entryPath({ id: item.id });
  eq("★ 目录报 isDir = true", res.isDir, true);
  check("目录也给出路径", res.path !== null, res);
}

/* ──────────────── 5. 坏情况逐条说清 ──────────────── */

console.log("\n5. 坏情况：逐条说清是哪一种");

{
  const ghost = await entryPath({ id: "li_不存在" });
  eq("★ 找不到条目 → path null", ghost.path, null);
  check("★ 给得出原因", (ghost.error ?? "").length > 0, ghost);
}

{
  // 记录在、文件被移走了 —— 这条不能静默（否则编辑器打开是空白，用户以为坏了）。
  const item = LibraryRepo.upsert({ kind: "paper", title: "文件没了", source: "manual" });
  LibraryRepo.setPdf(item.id, join("papers", "cc", "cc", `${"c".repeat(64)}.pdf`), "c".repeat(64));
  const res = await entryPath({ id: item.id });
  eq("★ 文件被移走 → path null", res.path, null);
  check("★ 说清是「不在了」", (res.error ?? "").includes("不在"), res);
}

{
  // 只有元数据、什么都没有 —— 用户截过那句"这条资料没有关联文件"。
  const item = LibraryRepo.upsert({ kind: "paper", title: "还没下 PDF", source: "search" });
  const res = await entryPath({ id: item.id });
  eq("★ 没有文件 → path null", res.path, null);
  check("★ 那句话是给用户看的", (res.error ?? "").includes("没有关联文件"), res);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(TMP, { recursive: true, force: true });
console.log(`\nlibrary-entry-path-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
