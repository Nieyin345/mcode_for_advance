/**
 * MAINT C 组跨任务收尾(三项都落在 M33 专有文件 `ipc/library.ts` / `library/fileImport.ts`):
 *
 *  A. M34 请求:删除预览列出的 sha 派生转录产物,`deleteItems(deleteFiles)` 也必须真的删掉
 *     (仍受"别的记录还指着这份 PDF"守卫);
 *  B. OBS-M35-01:`readEntryFile` 读超大文件时必须**先 stat 后读**,文本分支也要有上限;
 *  C. OBS-M35-02:`library:openFile` 对只有 `filePath` 的条目要能打开本体;
 *     高亮保存对已入库的 linked PDF(工作区根外)不能再报"这个位置不允许写入"。
 *
 * 数据根是临时目录;不起 Electron、不碰真实资料库。Run: scripts/maint-c-followup-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

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

const DATA = mkdtempSync(join(tmpdir(), "mcode-maint-cf-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
const SRC = mkdtempSync(join(tmpdir(), "mcode-maint-cf-src-"));

const { initDb, getDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { libraryRoot, markdownPathForHash, markdownDirForHash, toLibraryRelative, ensureLibraryDirs } = await import("@main/library/paths.js");
const { readEntryFile } = await import("@main/library/fileImport.js");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
const { IPC } = await import("@contracts/ipc");
const { openedPaths } = await import("./stubs/electron.js");

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;
registerLibraryHandlers(fakeIpc);
await initDb();
ensureLibraryDirs();
const ROOT = libraryRoot();

function call(channel: string): (raw: unknown) => Promise<any> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel}`);
  return (raw) => Promise.resolve(fn(null, raw));
}
const deletePreview = call(IPC.LIBRARY_DELETE_PREVIEW);
const deleteItems = call(IPC.LIBRARY_DELETE_ITEMS);
const openFile = call(IPC.LIBRARY_OPEN_FILE);
const saveHighlights = call(IPC.LIBRARY_SAVE_HIGHLIGHTS);

/** 直接写库列:仓库层没有"设 pdf/md 路径"的公开方法,本套只需要一条形状确定的记录。 */
function setCols(id: string, cols: { pdf_path?: string; pdf_sha256?: string; md_path?: string }): void {
  const db = getDb();
  for (const [k, val] of Object.entries(cols)) {
    db.run(`UPDATE library_items SET ${k} = ? WHERE id = ?`, [val, id]);
  }
}

try {
  /* ───────── A. 预览列出的 sha 派生产物,删除也要删掉 ───────── */
  console.log("A. 删除预览与实际删除一致");
  const sha = "b".repeat(64);
  const pdfAbs = join(ROOT, "pdf", `${sha}.pdf`);
  mkdirSync(join(ROOT, "pdf"), { recursive: true });
  writeFileSync(pdfAbs, "%PDF-fixture");
  const legacyFlat = markdownPathForHash(sha); // 平的:markdown/<2>/<2>/<sha>.md
  mkdirSync(join(legacyFlat, ".."), { recursive: true });
  writeFileSync(legacyFlat, "# old flat transcript");
  const legacyDir = markdownDirForHash(sha);
  mkdirSync(join(legacyDir, "images"), { recursive: true });
  writeFileSync(join(legacyDir, "full.md"), "![x](images/a.png)");
  writeFileSync(join(legacyDir, "images", "a.png"), "png");

  const A = LibraryRepo.upsert({ title: "A 有两版旧转录" });
  const adoptedDir = join(ROOT, "markdown", "imported", A.id);
  mkdirSync(adoptedDir, { recursive: true });
  writeFileSync(join(adoptedDir, "adopted.md"), "# adopted");
  setCols(A.id, { pdf_path: toLibraryRelative(pdfAbs), pdf_sha256: sha, md_path: toLibraryRelative(join(adoptedDir, "adopted.md")) });

  const preview = await deletePreview({ ids: [A.id] });
  const transcripts = (preview.entries?.[0]?.links ?? []).filter((l: { form: string }) => l.form === "transcript");
  eq("预览列出三份转录产物(平的 + 整包 + 采纳)", transcripts.length, 3);

  const resA = await deleteItems({ ids: [A.id], deleteFiles: true });
  eq("删除本身没有失败项", (resA.failed ?? []).length, 0);
  check("采纳那一包被删", !existsSync(adoptedDir));
  check("预览列出的旧平转录也被删(M34 请求)", !existsSync(legacyFlat), legacyFlat);
  check("预览列出的旧整包也被删(M34 请求)", !existsSync(legacyDir), legacyDir);
  check("PDF 本体被删", !existsSync(pdfAbs));

  // 守卫:另一条记录还指着同一份 PDF 时,sha 派生产物一个字节都不能动。
  writeFileSync(pdfAbs, "%PDF-fixture");
  mkdirSync(join(legacyFlat, ".."), { recursive: true });
  writeFileSync(legacyFlat, "# old flat transcript");
  const B = LibraryRepo.upsert({ title: "B" });
  const C = LibraryRepo.upsert({ title: "C 同一份 PDF" });
  setCols(B.id, { pdf_path: toLibraryRelative(pdfAbs), pdf_sha256: sha });
  setCols(C.id, { pdf_path: toLibraryRelative(pdfAbs), pdf_sha256: sha });
  const resB = await deleteItems({ ids: [B.id], deleteFiles: true });
  eq("有幸存者共享 PDF:不算失败", (resB.failed ?? []).length, 0);
  check("有幸存者共享 PDF:PDF 保留", existsSync(pdfAbs));
  check("有幸存者共享 PDF:sha 派生转录保留", existsSync(legacyFlat));
  check("记录 B 已删", LibraryRepo.get(B.id) === null);

  /* ───────── B. readEntryFile 先 stat 后读;文本分支也有上限 ───────── */
  console.log("B. 超大文件预览");
  const bigTxt = join(SRC, "big.txt");
  const bigBin = join(SRC, "big.bin");
  const twentyOneMb = 21 * 1024 * 1024;
  writeFileSync(bigTxt, Buffer.alloc(twentyOneMb, 0x61));
  writeFileSync(bigBin, Buffer.alloc(twentyOneMb, 0));
  const T = LibraryRepo.upsert({ title: "big txt", entryMode: "linked", filePath: bigTxt });
  const Bn = LibraryRepo.upsert({ title: "big bin", entryMode: "linked", filePath: bigBin });
  const tRes = readEntryFile(T.id) as { type: string; error?: string; text?: string };
  eq("超大文本不再整篇读进主进程(unsupported)", tRes.type, "unsupported");
  check("超大文本给出'太大'提示", Boolean(tRes.error?.includes("太大")), tRes.error);
  const bRes = readEntryFile(Bn.id) as { type: string; error?: string };
  eq("超大二进制 unsupported", bRes.type, "unsupported");
  // 内存证据:读前 stat。用 RSS 增量粗判 —— 21MB 的 readFileSync 会让 RSS 明显跳。
  const rss0 = process.memoryUsage().rss;
  for (let i = 0; i < 5; i++) readEntryFile(Bn.id);
  const rssDelta = process.memoryUsage().rss - rss0;
  check("反复预览超大文件不抬升 RSS(读前 stat)", rssDelta < 15 * 1024 * 1024, { rssDelta });

  /* ───────── C. openFile 走本体;linked PDF 高亮保存不被工作区围栏拒绝 ───────── */
  console.log("C. openFile / 高亮保存");
  const docx = join(SRC, "note.docx");
  writeFileSync(docx, "docx");
  const G = LibraryRepo.upsert({ title: "只有 filePath 的通用条目", entryMode: "linked", filePath: docx });
  const o1 = await openFile({ id: G.id });
  eq("通用条目 openFile ok(OBS-M35-02)", o1.ok, true);
  eq("打开的是本体路径", openedPaths.at(-1), docx);

  const linkedPdf = join(SRC, "outside.pdf");
  writeFileSync(linkedPdf, "%PDF-outside");
  const L = LibraryRepo.upsert({ title: "库外 linked PDF", entryMode: "linked", filePath: linkedPdf });
  eq("linked PDF 已入库", LibraryRepo.get(L.id)?.filePath, linkedPdf);
  const s1 = await saveHighlights({ pdfPath: linkedPdf, highlights: [] });
  eq("已入库的 linked PDF 可保存高亮索引", s1.ok, true);
  const stranger = join(SRC, "stranger.pdf");
  writeFileSync(stranger, "%PDF-stranger");
  const s2 = await saveHighlights({ pdfPath: stranger, highlights: [] });
  eq("未入库、也不在任何工作区根内的路径仍被拒", s2.ok, false);
} finally {
  rmSync(DATA, { recursive: true, force: true });
  rmSync(SRC, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);
