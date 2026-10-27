/** Production adapter for the unified library's asynchronous binary-text index.
 * Reuses the native GenOffice CLI parser; does not instantiate the vendor app.
 * The CLI path and reader are injected for isolated tests. */
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readAnyDocument, type GenofficePorts } from "@main/document/genofficeCli.js";
import type { IndexInput, IndexReader, IndexSection } from "./documentTextIndex.js";
import { flattenDocumentBlocks } from "./documentTextIndex.js";

export function genofficeLibraryReader(cliPath: string | null): IndexReader {
  return async (input: IndexInput) => {
    if (!cliPath) throw new Error("GenOffice CLI unavailable: indexing deferred");
    const source=resolve(input.path);
    const stat=lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe or non-regular document");
    const canonical=realpathSync.native(source);
    const samePath = (a:string,b:string) => process.platform === "win32"
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
    if (!samePath(canonical,source)) throw new Error("aliased paths are not indexed");
    const ports:GenofficePorts={
      cliPath, timeoutMs:90_000,
      // Indexing has EXACTLY ONE explicitly registered file per job.
      // A directory-scoped workspace allowance here would grant the CLI
      // access to unrelated user files from linked references.
      withinWorkspace:(path)=>samePath(path,source),
    };
    const result=await readAnyDocument(ports, source);
    if (!result.ok) throw new Error("Native parser: "+result.reason.slice(0,300));
    const detail=result.envelope.detail as { items?:unknown; truncated?:boolean; sheetDetail?:unknown; sheetLedger?:unknown };
    const raw=Array.isArray(detail?.items)?detail.items:[];
    if (!raw.length) throw new Error("No extractable text; scanned PDF may require OCR");
    const blocks=raw.filter((x): x is {type?:unknown;text?:unknown;index?:unknown}=>Boolean(x&&typeof x==="object"));
    const extracted=flattenDocumentBlocks(blocks,input.kind,detail);
    // `coverage` 由账目决定（见 flattenDocumentBlocks）：xlsx 只有把每张表都读到
    // 且没被截断时才是 complete；账目缺失时如实回 partial，不猜。
    const coverage=extracted.coverage;
    return {sections:extracted.sections as IndexSection[],coverage};
  };
}
