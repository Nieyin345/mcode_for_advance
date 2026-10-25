/** ARC-005 / unified-library naming and integration boundary verification.
 * This runs on source, not a production user's database. The currently
 * shared ChatPane.tsx is explicitly reserved by another work conversation;
 * source check reports its outstanding terminology separately. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(path),"utf8");
const files = execFileSync("git",["ls-files","-z","--","src","scripts","../../packages/contracts/src"],{encoding:"utf8"})
  .split("\0").filter(Boolean);
let count=0,fail=0;
function check(name:string,pass:boolean) {
 count++;if(!pass)fail++;
 console.log((pass?"PASS ":"FAIL ")+name);
}
const all = files.filter(f=>/\.(?:tsx?|jsx?|sh)$/.test(f));
const exceptions = new Set(["src/renderer/components/chat/ChatPane.tsx","scripts/library-terminology-smoke/main.ts"]);
const references = all.filter(f=>!exceptions.has(f) && read(f).includes("文献库"));
check("No retired literature-library label remains outside concurrently edited ChatPane",
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
 api.includes("项目 / 会话工作树 / 资料库") && !api.includes("文献库"));
check("Deliberate future cleanup target: attached dedup only within one import batch",
 generic.includes("const seen = new Map") &&
 generic.includes('findExisting(abs)') &&
 generic.includes('effectiveMode === "linked"'));
check("Deliberate future cleanup target: PDF is still separately imported",
 importDispatch.includes("importPdfFiles") &&
 contract.includes("pdfPath?: string"));
console.log("library-terminology-smoke: "+(count-fail)+"/"+count);
if(fail)process.exitCode=1;
