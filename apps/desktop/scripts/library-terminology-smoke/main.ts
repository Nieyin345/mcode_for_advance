/** Unified-library naming and integration boundary verification.
 * Scans all tracked source and smoke files; does not access the user database. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/* 【UI 重建 2026-10-27】**`git ls-files` 列的是索引，不是磁盘。**
 *
 * 一个文件被 `rm` 掉但那次删除还没提交时，索引里仍然有它 —— 于是这里会拿
 * 一个**不存在的路径**去 readFileSync，整个套件崩在 ENOENT 上。
 * 崩溃看起来像「套件坏了」，实际是「有人刚删了文件还没提交」（多会话常见）。
 *
 * 所以只扫**磁盘上真存在**的文件。删掉的文件没有文本可查，本来也不在扫描范围里。
 * ⚠️ 这不是「忽略错误」：`existsSync` 为假的条目**一条都不会被静默跳过而不记录**——
 * 下面会把它们打出来，让人知道这次扫描少看了什么。 */
const read = (path: string) => readFileSync(resolve(path), "utf8");
const tracked = execFileSync("git",["ls-files","-z","--","src","scripts","../../packages/contracts/src"],{encoding:"utf8"})
  .split("\0").filter(Boolean);
const files: string[] = [];
const missingOnDisk: string[] = [];
for (const f of tracked) {
  try { readFileSync(resolve(f)); files.push(f); }
  catch { missingOnDisk.push(f); }
}
if (missingOnDisk.length > 0) {
  console.log(`NOTE: ${missingOnDisk.length} 个索引内文件在磁盘上不存在（删除未提交），本次不扫描：${missingOnDisk.slice(0, 5).join(", ")}${missingOnDisk.length > 5 ? " …" : ""}`);
}
let count=0,fail=0;
function check(name:string,pass:boolean) {
 count++;if(!pass)fail++;
 console.log((pass?"PASS ":"FAIL ")+name);
}
const all = files.filter(f=>/\.(?:tsx?|jsx?|sh)$/.test(f));
// Compose the retired label so this test does not introduce the same token
// into the repository it is asserting should be clean.
const retired = "文献" + "库";
const references = all.filter(f=>read(f).includes(retired));
check("No retired literature-library label remains in any tracked source or smoke file",
 references.length===0);
if(references.length) console.log("Unexpected old terminology: "+references.join(", "));

const contract=read("../../packages/contracts/src/library.ts");
const importDispatch=read("src/main/library/importDispatch.ts");
const generic=read("src/main/library/fileImport.ts");
const paths=read("src/main/library/paths.ts");
const operations=read("src/main/library/operations.ts");
const manifest=read("src/main/library/manifest.ts");
const labels=read("src/renderer/lib/i18n/zh/library.ts");
const picker=read("src/renderer/components/chat/LibraryPicker.tsx");
const api=read("src/main/ipc/mcp.ts");
check("Unified source contract models generic files, not hard-coded paper kinds",
 contract.includes('entryMode: "linked" | "attached"') &&
 contract.includes("filePath?: string") &&
 contract.includes("export interface LibraryItemLink") &&
 contract.includes("export interface LibraryCollection"));
check("Legacy PDF fields remain deliberately for reading existing records",
 contract.includes("pdfPath?: string") &&
 contract.includes("mdPath?: string") &&
 contract.includes("pdfSha256?: string"));
check("Import router dispatches PDF/Markdown/other files through separate compatible paths",
 importDispatch.includes('ext === ".pdf"') &&
 importDispatch.includes("NOTE_EXTS.has(ext)") &&
 importDispatch.includes("importGenericFiles({ paths: files") &&
 importDispatch.includes('mode: "attached"'));
check("Folders may remain linked; explode import has explicit one-level semantics",
 importDispatch.includes('opts.mode === "folder"') &&
 importDispatch.includes('opts.mode === "explode"') &&
 importDispatch.includes('mode: "linked"'));
check("Attached files are physically copied and linked files preserve original path",
 generic.includes("copyFileSync(abs, dest)") &&
 generic.includes('entryMode: "linked"') &&
 generic.includes('entryMode: "attached"'));
check("Relative library paths retain a physical root containment guard",
 paths.includes("physicalTargetInRoot") &&
 paths.includes("isInsideLibrary"));
check("User and AI assignment operations share one implementation",
 operations.includes("export function assignToCollection") &&
 operations.includes("export function assignImportedToCollections") &&
 manifest.includes("export function writeItemManifest"));
check("Unified library attaches a manifest reference rather than stuffing entire content",
 manifest.includes("manifestDir") &&
 manifest.includes("writeItemManifest") &&
 manifest.includes("aiVisibleFilesOf(item)"));
check("All user-facing library labels use 资料库",
 labels.includes('"library.title": "资料库"') &&
 labels.includes('"library.action.addToContext": "添加资料库到上下文"') &&
 labels.includes('"library.chat.searchPlaceholder": "搜索资料库"'));
check("Chat picker continues using shared library IDs and selection entry points",
 picker.includes("selectedLibraryPickerEntries") &&
 picker.includes("buildLibraryPickerRows"));
check("Visible MCP error is consistent with unified library terminology",
 api.includes("项目 / 会话工作树 / 资料库") && !api.includes(retired));
check("Deliberate future cleanup target: attached dedup only within one import batch",
 generic.includes("const seen = new Map") &&
 generic.includes('findExisting(abs)') &&
 generic.includes('effectiveMode === "linked"'));
check("Deliberate future cleanup target: PDF is still separately imported",
 importDispatch.includes("importPdfFiles") &&
 contract.includes("pdfPath?: string"));
console.log("library-terminology-smoke: "+(count-fail)+"/"+count);
if(fail)process.exitCode=1;
