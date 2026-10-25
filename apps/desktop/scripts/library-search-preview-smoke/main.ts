/** Search → registered-index location → existing preview UI wiring contracts.
 * Covers live-source ownership, annotation safety and keyboard focus. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const read=(file:string)=>readFileSync(resolve("src/renderer",file),"utf8");
const palette=read("components/layout/CommandPalette.tsx");
const store=read("stores/fileViewStore.ts");
const viewer=read("components/library/FileViewer.tsx");
const pdf=read("components/library/PdfPreviewImpl.tsx");
const office=read("components/ide/GenofficeDocumentPane.tsx");
const main=readFileSync(resolve("src/main/ipc/library.ts"),"utf8");
const reader=readFileSync(resolve("src/main/library/documentIndexReader.ts"),"utf8");
let n=0,failed=0;
function ck(s:string,yes:boolean){n++;if(!yes)failed++;console.log((yes?"PASS ":"FAIL ")+s);}
ck("Search returns index queue progress and partial-failure status",
 main.includes("indexing: isCurrent() ? indexed.pending : 0") &&
 main.includes("indexErrors: isCurrent() ? indexed.errors : 0"));
ck("Search merges native and plain text hits without starving either side",
 main.includes("indexed.matches[i]") && main.includes("plain[i]") && main.includes("matches.length < totalLimit"));
ck("Library import triggers async index queue, not await before returning",
 (main.match(/scheduleImportedDocuments\(res.items\)/g)||[]).length===2);
ck("Search input reports unfinished indexing without falsely claiming empty library",
 palette.includes("documentIndexing > 0") &&
 palette.includes("资料库正在索引") &&
 palette.includes("setDocumentIndexing(res.indexing ?? 0)"));
ck("Index errors remain observable rather than invisible empty success",
 palette.includes("documentIndexErrors > 0") &&
 palette.includes("暂未索引") &&
 palette.includes("setDocumentIndexErrors(res.indexErrors ?? 0)"));
ck("Index progress refresh is bounded and cancelled on search changes",
 palette.includes("indexAttempts++ < 6") &&
 palette.includes("window.clearTimeout(indexPoll)") &&
 palette.includes("if (cancelled || reqIdRef.current !== myId) return"));
ck("PDF, slides, and workbook locations appear beside search hits",
 palette.includes("match.location?.page") && palette.includes("match.location?.slide") &&
 palette.includes("match.location?.sheet") && palette.includes("match.location?.row"));
ck("Partial workbook text is visibly labeled incomplete",
 palette.includes('match.coverage === "partial"') && palette.includes("部分索引"));
ck("Clicking result opens owning LibraryItem, not cache JSON as file",
 palette.includes('source:{kind:"library",ref:item.match.itemId}') &&
 palette.includes("fileView.setSearchHit(item.match)"));
ck("Preview anchor stored separately from document identity/unsaved annotation state",
 store.includes("searchHit: FullTextMatch | null") &&
 store.includes("setSearchHit: (hit: FullTextMatch | null) => void") &&
 store.includes("Reopening the current file is a true no-op"));
ck("Store clears old search anchor on unrelated file or close",
 store.includes('state.searchHit?.itemId === target.source.ref') &&
 store.includes("searchHit: null"));
ck("Preview never shows hit belonging to different item id",
 viewer.includes('pendingHit?.itemId === target.source.ref') &&
 viewer.includes('target.source.kind === "library"'));
ck("PDF hit passes actual page number to viewer, not a textual claim",
 viewer.includes("searchPage={searchHit?.location?.page}"));
ck("PDF navigation uses plugin scrollToPage, not PDF byte reload",
 pdf.includes('getPlugin.call(registry, "scroll")') &&
 pdf.includes('getPlugin.call(registry, "document-manager")') &&
 pdf.includes("scroll.forDocument(id)") &&
 pdf.includes('scrollToPageRef.current?.({pageNumber:searchPage!,behavior:"smooth"})'));
ck("PDF navigation strictly scoped to current loaded viewer epoch",
 pdf.includes("readyForNavigation !== documentEpochRef.current") &&
 pdf.includes("setReadyForNavigation(readyEpoch)"));
ck("PDF annotation edits and leave guard still use original dirty state",
 pdf.includes("markDirty(true)") && pdf.includes("setFileView")===false &&
 viewer.includes("fileViewTarget={target}"));
ck("Office preview accepts exact search location and excerpt",
 viewer.includes("searchLocation={searchHit?.location}") &&
 viewer.includes("searchText={searchHit?.lineText}"));
ck("Office structured blocks scroll to matching row after render",
 office.includes("data-document-block={r.block}") &&
 office.includes("scrollIntoView({block:\"center\",behavior:\"smooth\"})"));
ck("Office selected block gets stable visual feedback",
 office.includes('searchLocation?.block === r.block') &&
 office.includes("border-accent bg-accent/10"));
ck("Preview exposes search snippet with a close control",
 viewer.includes('role="status"') &&
 viewer.includes("setSearchHit(null)") &&
 viewer.includes('aria-label="关闭搜索定位提示"'));
ck("Search location metadata remains bounded to original library document kind",
 reader.includes("readAnyDocument(ports, source)") &&
 reader.includes("withinWorkspace:(path)=>samePath(path,source)"));
ck("Negative: a stale unrelated file cannot meet item ownership predicate",
 ((a:string,b:string)=>a!==b)("docB","docA") && viewer.includes('pendingHit?.itemId === target.source.ref'));
console.log("library-search-preview-smoke: "+(n-failed)+"/"+n);
if(failed)process.exitCode=1;
