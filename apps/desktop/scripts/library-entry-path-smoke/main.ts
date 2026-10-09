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

  const item = LibraryRepo.upsert({ title: "一篇论文" });
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

  const item = LibraryRepo.upsert({ title: "有转录的" });
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

  const item = LibraryRepo.upsert({ title: "一条笔记" });
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

  const item = LibraryRepo.upsert({ title: "只有 PDF" });
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
  const item = LibraryRepo.upsert({ title: "一个目录" });
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
  const item = LibraryRepo.upsert({ title: "文件没了" });
  LibraryRepo.setPdf(item.id, join("papers", "cc", "cc", `${"c".repeat(64)}.pdf`), "c".repeat(64));
  const res = await entryPath({ id: item.id });
  eq("★ 文件被移走 → path null", res.path, null);
  check("★ 说清是「不在了」", (res.error ?? "").includes("不在"), res);
}

{
  // 只有元数据、什么都没有 —— 用户截过那句"这条资料没有关联文件"。
  const item = LibraryRepo.upsert({ title: "还没下 PDF" });
  const res = await entryPath({ id: item.id });
  eq("★ 没有文件 → path null", res.path, null);
  check("★ 那句话是给用户看的", (res.error ?? "").includes("没有关联文件"), res);
}

/* ──────────────── 6. 预览里的图片引用不许借符号链接/junction 越界 ──────────────── */

console.log("\n6. readMarkdown 的图片解析不许越界（符号链接/junction）");

// `library.readMarkdown`(`markdownPreview.ts`)把 md 里 `![]()` 引到的图片读成
// data URL 交给渲染端。md 正文是**外部工具转完挂回来的**、够不着的内容,所以它被当作
// **不可信输入**:解析出的绝对路径必须落在 md 所在目录的**真实**子树里,越界就跳过。
//
// ⚠️ 判据必须是**解析符号链接/junction 之后**的包含性,不能是裸字符串前缀。仓库里
// `fileImport.ts` 的 `readEntryFile` 早就因为同一件事从 `startsWith` 换成了共享的
// `pathWithin`(realpath 解析 + 平台归一),而 `markdownPreview.ts` 这两个判据**各写一份、
// 只做了裸前缀**:于是一份 md 写 `![](evil/x.png)`,而 md 目录下有个名叫 `evil` 的 junction
// 指向库外(或用户别处),图片就被读成 data URL 交出去了 —— 与"屏蔽了 pdf、模型却还能读"
// 同一类漏,只不过这里是把**库外任意文件**的内联给渲染端。
{
  const { execFileSync } = await import("node:child_process");
  const { readMarkdownForPreview } = await import("@main/library/markdownPreview.js");

  const OUTSIDE = join(TMP, "outside");
  mkdirSync(OUTSIDE, { recursive: true });
  const secret = join(OUTSIDE, "secret.png");
  writeFileSync(secret, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x53, 0x45, 0x43]));

  const mdDirRel = join("markdown", "imported", "li_linkescape");
  const mdDirAbs = join(LIB, mdDirRel);
  mkdirSync(join(mdDirAbs, "images"), { recursive: true });
  writeFileSync(join(mdDirAbs, "full.md"), "# 越界引用\n\n![好图](images/ok.png)\n\n![越界](evil/secret.png)\n");
  // 一张**真在目录里**的图 —— 反面断言:收紧判据不能把正常引用也一起挡掉。
  const okBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  writeFileSync(join(mdDirAbs, "images", "ok.png"), okBytes);

  // 在 md 目录里放一个 junction 指向库外。造不出来（权限/平台）就跳过这一档，别把
  // "环境造不出夹具"错报成"被测代码坏了"。
  let planted = true;
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", join(mdDirAbs, "evil"), OUTSIDE], { stdio: "pipe" });
  } catch {
    planted = false;
  }
  if (!planted) {
    check("（跳过:这个环境建不出 junction 夹具）", true);
  } else {
    const item = LibraryRepo.upsert({ title: "带越界图片引用的一篇" });
    await setMdPath(item.id, join(mdDirRel, "full.md"));
    const readMarkdown = handlers.get(IPC.LIBRARY_READ_MARKDOWN);
    if (!readMarkdown) throw new Error("没注册 LIBRARY_READ_MARKDOWN");
    const preview = (await Promise.resolve(readMarkdown(null, { id: item.id }))) as {
      ok: boolean;
      images: Record<string, string>;
      skipped: string[];
    };
    check("预览本身成功", preview.ok, preview);
    // 正面控制:目录里真有的那张照常内联（收紧判定不能连正常引用一起挡掉）。
    check(
      "正常引用真在目录里的图仍然内联",
      preview.images["images/ok.png"]?.startsWith("data:image/png") === true,
      Object.keys(preview.images),
    );
    // ★ 症结:裸前缀判定认不出 junction,库外那份文件被内联进 images。
    check("★ 借 junction 越界的图片**没有**被内联", !preview.images["evil/secret.png"], Object.keys(preview.images));
    check("★ 而是记进 skipped 如实报出", preview.skipped.some((r) => r.includes("evil")), preview.skipped);
  }
}

/* ──────────────── 7. 预览内联的图片引用:三种写法都要认(与 convert 共用一份) ──────────────── */

console.log("\n7. readMarkdown 认全三种图片引用写法（行内 / 引用式 / 裸 HTML）");

// `readMarkdownForPreview` 要内联的图片哪几张,靠的也是"这份 md 引用了哪些本地配图"
// 这条规则。它只有一处实现(`adoptMarkdown.assetRefsOf`,认行内式 / 引用式 / 裸 HTML
// 三种),而与它孪生的 `conversionReport` 早在 commit 3cf0ff22 就换成了共用那份 ——
// 预览这里却是**各写一份**、只扫行内式与 HTML。于是**引用式**写的转录(`![图][id]`
// + `[id]: path`,pandoc / 某些 OCR 工具的默认输出)在预览里**一张图都内联不出来**,
// 而设置页的转录报告反过来算得齐 —— 两处漂移。这一条钉住"三写法都要内联"。
{
  const { readMarkdownForPreview } = await import("@main/library/markdownPreview.js");
  const mdDirRel = join("markdown", "imported", "li_imgforms");
  const mdDirAbs = join(LIB, mdDirRel);
  mkdirSync(join(mdDirAbs, "images"), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(mdDirAbs, "images", "inline.png"), png);
  writeFileSync(join(mdDirAbs, "images", "ref.png"), png);
  writeFileSync(join(mdDirAbs, "images", "html.png"), png);
  writeFileSync(
    join(mdDirAbs, "full.md"),
    [
      "# 三种写法",
      "",
      "![行内](images/inline.png)",
      "",
      "![引用式][a]",
      "",
      '[a]: images/ref.png "标题"',
      "",
      '<img src="images/html.png" alt="裸 HTML">',
      "",
    ].join("\n"),
  );
  const item = LibraryRepo.upsert({ title: "三种图片写法的一篇" });
  await setMdPath(item.id, join(mdDirRel, "full.md"));
  const preview = readMarkdownForPreview(item.id);
  check("预览成功", preview.ok, preview);
  check("★ 行内式内联", preview.images["images/inline.png"]?.startsWith("data:image/png") === true, Object.keys(preview.images));
  // ★ 症结:只扫行内式 + HTML 的那份实现,认不出引用式 —— 这一张内联不进来。
  check("★ 引用式也内联", preview.images["images/ref.png"]?.startsWith("data:image/png") === true, Object.keys(preview.images));
  check("裸 HTML 也内联", preview.images["images/html.png"]?.startsWith("data:image/png") === true, Object.keys(preview.images));
}

/* ──────────────── 收尾 ──────────────── */

// 附:revealFile 必须与 entryPath/openFile 同源地取路径(filePath → pdfPath → mdPath),
// 否则**通用文件条目**(导入的 .docx/图片,只有 filePath)的「在文件夹中打开」会静默失效
// (主进程回「还没有 PDF」,而调用方 `void api…` 无 toast —— 用户点了什么都不发生)。
{
  const { openedDirectories, resetReveal } = await import("./stubs/reveal.js");
  const revealFile = (raw: unknown): Promise<{ ok: boolean; error?: string }> => {
    const fn = handlers.get(IPC.LIBRARY_REVEAL_FILE);
    if (!fn) throw new Error("没注册 LIBRARY_REVEAL_FILE");
    return Promise.resolve(fn(null, raw)) as Promise<{ ok: boolean; error?: string }>;
  };
  resetReveal();
  const sha = "e".repeat(64);
  const rel = join("imported", "ee", "ee", `${sha}.docx`);
  const abs = join(LIB, rel);
  mkdirSync(join(LIB, "imported", "ee", "ee"), { recursive: true });
  writeFileSync(abs, "docx bytes");
  const item = LibraryRepo.upsert({ title: "导入的 Word" });
  LibraryRepo.setFilePath(item.id, rel); // 通用条目只有 filePath,没有 pdfPath

  const res = await revealFile({ id: item.id });
  check("★ 通用文件条目(只有 filePath)的「在文件夹中打开」不再静默失败", res.ok === true, res);
  eq("★ 揭的就是它本体所在的目录", openedDirectories[0], join(LIB, "imported", "ee", "ee"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nlibrary-entry-path-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
