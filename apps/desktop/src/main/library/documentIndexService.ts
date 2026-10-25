/** One scoped index service for all library document formats.
 * Automatically invalidated by file size/mtime and data-root relocation.
 * The GenOffice CLI reader runs out of process, sequentially; no second
 * Electron app, external cloud or vendor AI instance is started. */
import { isAbsolute, join, resolve } from "node:path";
import { pathWithin } from "@main/lib/realPathWithin.js";
import type { LibraryItem } from "@contracts/library";
import { resolveGenofficeCliPath } from "@main/document/genofficeCli.js";
import { entryRootAbsPath } from "./fileImport.js";
import { libraryRoot } from "./paths.js";
import { LibraryDocumentIndex, documentIndexKind, type IndexInput } from "./documentTextIndex.js";
import { genofficeLibraryReader } from "./documentIndexReader.js";

let instance: LibraryDocumentIndex | null = null;
let instanceRoot: string | null = null;
export function libraryDocumentIndexService(): LibraryDocumentIndex {
  const root=resolve(libraryRoot());
  if (!instance || instanceRoot!==root) {
    instanceRoot=root;
    // Packaged CLI is resolved from process.resourcesPath by the canonical
    // resolver. In development Electron runs from either repo root or
    // apps/desktop; both are checked without importing ipc/document and its
    // native editor dependencies into the lightweight library IPC bundle.
    const cliPath=resolveGenofficeCliPath(resolve(join(process.cwd(),"../..")))
      ?? resolveGenofficeCliPath(process.cwd());
    instance=new LibraryDocumentIndex(root,genofficeLibraryReader(cliPath));
  }
  return instance;
}
export function indexableLibraryDocuments(items:readonly LibraryItem[]):IndexInput[] {
  const records:IndexInput[]=[];
  const root=libraryRoot();
  for(const item of items){
    const path=entryRootAbsPath(item);
    if(!path) continue;
    // Only an explicitly linked absolute file may live outside the library.
    // A forged relative filePath in an attached database record must not
    // become an arbitrary path read through the indexer.
    const externalLinked=item.entryMode==="linked" && !!item.filePath && isAbsolute(item.filePath);
    if (!externalLinked && !pathWithin(root,path)) continue;
    const kind=documentIndexKind(path);
    if(!kind) continue;
    records.push({item,path:resolve(path),kind});
  }
  return records;
}
/** Fire-and-forget after file import; the queue is bounded and only touches
 * item IDs returned from the already-authorized import operation. */
export function scheduleImportedDocuments(items:readonly LibraryItem[]):void {
  const service=libraryDocumentIndexService();
  for (const input of indexableLibraryDocuments(items)) service.enqueue(input);
}
