/** @smoke-covers src/main/document/slidesExecutor.ts
 * T53: real Rust sidecar + upstream native XLSX save path, independently
 * verified with the Node-only GenOffice CLI reader; the real vendor PPTX
 * engine runs through the production fallback SlidesExecutor. Every output
 * goes to a fresh temporary workspace; neither the sample nor user data is edited.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { XlsxSidecarClient } from "../../../../genoffice/apps/sheets/src/main/xlsx-sidecar-client.js";
import { sheetRead, type GenofficePorts } from "@main/document/genofficeCli.js";
import { saveWorkbookViaSidecar } from "../../../../genoffice/packages/xlsx-gateway/src/gateway/xlsx-package-io.js";
import { VendorSlidesExecutor } from "@main/document/slidesExecutor.js";
import { vendorSlidesModules, vendorAvailable } from "@main/document/slidesVendorModules.js";

let total = 0, failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok  " + name);
  else { failures++; console.error("  FAIL " + name, detail); }
}
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repo = resolve(process.cwd(), "../..");
const fixture = join(repo, "genoffice/apps/shell/build/shell-new/blank.xlsx");
const sidecarBin = join(repo, "genoffice/apps/sheets/native/xlsx-engine/target/release",
  process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar");
const cli = join(repo, "genoffice/packages/cli/dist/genoffice.cjs");
const root = mkdtempSync(join(tmpdir(), "mcode-t53-real-office-"));
const inside = (p: string) => p === root || p.startsWith(root + sep);
const ports: GenofficePorts = { cliPath: cli, withinWorkspace: inside, timeoutMs: 90000 };
const sidecar = new XlsxSidecarClient(sidecarBin);

async function checkXlsx(): Promise<void> {
  check("real sidecar, real XLSX fixture and upstream CLI exist",
    existsSync(sidecarBin) && existsSync(fixture) && existsSync(cli));
  const pristine = join(root, "unchanged.xlsx");
  copyFileSync(fixture, pristine);
  const before = sha256(pristine);
  const raw = await sidecar.open(pristine) as {
    sessionId: string; sheets: Array<{ id: string; name: string }>;
  };
  check("sidecar opens real XLSX metadata and exposes Sheet1",
    typeof raw.sessionId === "string" && raw.sheets[0]?.name === "Sheet1", raw);
  const sheetId = raw.sheets[0]!.id;
  const cell = await sidecar.readRange({
    sessionId: raw.sessionId, sheetId,
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
  });
  check("real sidecar reads an actual cell range", cell !== null, cell);
  await sidecar.close(raw.sessionId);
  check("XLSX: real sidecar open/read/close does not rewrite one byte",
    sha256(pristine) === before);
  const outsideRoot = mkdtempSync(join(tmpdir(), "mcode-t53-outside-"));
  try {
    const outsideFile = join(outsideRoot, "forbidden.xlsx");
    copyFileSync(fixture, outsideFile);
    const outsideBefore = sha256(outsideFile);
    const denied = await sheetRead(ports, outsideFile, undefined, { range: "A1:A1" });
    check("XLSX workspace fence refuses an existing outside file before CLI open",
      !denied.ok && denied.kind === "refused" && sha256(outsideFile) === outsideBefore, denied);
  } finally { rmSync(outsideRoot, {recursive:true,force:true}); }

  const edited = join(root, "edited.xlsx");
  copyFileSync(fixture, edited);
  const originalHash = sha256(edited);
  const firstOpen = await sidecar.open(edited) as { sessionId: string; sheets: Array<{ id: string }> };
  await sidecar.readRange({sessionId: firstOpen.sessionId, sheetId: firstOpen.sheets[0]!.id,
    range:{startRow:0,endRow:0,startColumn:0,endColumn:0}});
  await sidecar.close(firstOpen.sessionId);
  const marker = "T53-native-file-roundtrip-2026";
  // EXACT upstream native Sheets save path: same saveWorkbookViaSidecar helper
  // as sheets-main.ts / native editor, Rust archives with originals preserved.
  const write = await saveWorkbookViaSidecar({
    client: sidecar, sourcePath: edited, targetPath: edited,
    edits: [{ sheetName: "Sheet1", row: 1, column: 1, writeValue: true, cell: { value: marker } }],
  });
  check("original Sheets native save path touched real XLSX entries", write.touchedEntries.length > 0, write);
  check("XLSX edit changed physical ZIP bytes", sha256(edited) !== originalHash);
  // Reader is the independent Node CLI sheetRead, not Rust sidecar, and must
  // observe the VALUE rather than just an 'ok' return from the writer.
  const independent = await sheetRead(ports, edited, undefined,
    { sheet: "Sheet1", range: "B2:B2", maxRows: 1 });
  const detail = independent.ok ? independent.envelope.detail as { rows?: unknown[][] } | undefined : undefined;
  check("independent genofficeCli.sheetRead returns edited B2 value",
    independent.ok && detail?.rows?.[0]?.[0] === marker, independent);
  const reopened = await sidecar.open(edited) as { sessionId: string; sheets: Array<{ id: string }> };
  const nativeRead = await sidecar.readRange({sessionId: reopened.sessionId, sheetId: reopened.sheets[0]!.id,
    range:{startRow:1,endRow:1,startColumn:1,endColumn:1}});
  check("separate real Rust sidecar reopens the physically edited workbook",
    nativeRead !== null, nativeRead);
  await sidecar.close(reopened.sessionId);
}

async function checkPptx(): Promise<void> {
  check("real vendor PPTX engine is installed", vendorAvailable);
  const binary = await vendorSlidesModules.createBlankPptx();
  check("upstream creates genuine PPTX bytes", binary.length > 100 && binary[0] === 0x50);
  const unchanged = join(root, "unchanged.pptx");
  writeFileSync(unchanged, binary);
  const executor = VendorSlidesExecutor.create();
  check("native VendorSlidesExecutor is wired (no unavailable stub)", executor !== null);
  if (!executor) return;
  const first = await executor.openDeck(801, "unchanged", unchanged, 1280);
  check("real vendor executor opens existing PPTX", first !== null, first);
  const before = sha256(unchanged);
  const noEditSave = await executor.saveDeck(801, "unchanged", unchanged);
  check("real vendor saves the unmodified PPTX", !!noEditSave && "bytes" in noEditSave, noEditSave);
  check("PPTX open/no-edit/save is byte-identical", before === sha256(unchanged),
    { before, after: sha256(unchanged) });
  executor.release(801);

  const file = join(root, "edited.pptx");
  writeFileSync(file, binary);
  const open = await executor.openDeck(802, "edited", file, 1280);
  const slides = (open?.openResult as { slides?: unknown[] } | undefined)?.slides;
  check("existing PPTX exposes real rendered slide count", Array.isArray(slides), slides);
  const count = slides?.length ?? 0;
  const add = await executor.addBlankSlide(802, "edited");
  check("original PPTX transaction adds exactly one real slide",
    add !== null && add.slideCount === count + 1, { count, add });
  const save = await executor.saveDeck(802, "edited", file);
  check("native SlidesExecutor writes edited PPTX bytes to disk",
    save !== null && "bytes" in save && sha256(file) !== sha256(unchanged), save);
  executor.release(802);
  // Independent *new session*, reparse from on-disk ZIP; no in-memory model reuse.
  const reopened = VendorSlidesExecutor.create();
  const second = await reopened?.openDeck(803, "reopened", file, 1280);
  const reopenedSlides = (second?.openResult as { slides?: unknown[] } | undefined)?.slides;
  check("PPTX re-open independently sees the persisted extra slide",
    Array.isArray(reopenedSlides) && reopenedSlides.length === count + 1,
    { expected: count + 1, actual: reopenedSlides?.length });
  reopened?.release(803);

  const conflictFile = join(root, "conflict.pptx");
  writeFileSync(conflictFile, binary);
  const conflictExe = VendorSlidesExecutor.create();
  const conflictOpened = await conflictExe?.openDeck(804, "conflict", conflictFile, 1280);
  check("PPTX version conflict fixture opens before external update", conflictOpened !== null, conflictOpened);
  // Deterministic external editor wins. The appended marker intentionally makes
  // the source differ while keeping all writes isolated to the temp worktree.
  writeFileSync(conflictFile, Buffer.concat([Buffer.from(binary),Buffer.from("EXTERNAL") ]));
  const externalHash = sha256(conflictFile);
  const rejected = await conflictExe?.saveDeck(804,"conflict",conflictFile);
  check("PPTX CAS refuses stale save and preserves newer external bytes",
    !!rejected && "reason" in rejected && rejected.reason.includes("VERSION_CONFLICT") &&
    sha256(conflictFile) === externalHash,rejected);
  conflictExe?.release(804);
}

try {
  await checkXlsx();
  await checkPptx();
} catch (error) {
  check("real native office round trip completes", false, String(error));
} finally {
  sidecar.stop();
  rmSync(root, { recursive: true, force: true });
}
console.log("genoffice-native-real-office-smoke:" + (total - failures) + "/" + total + " 通过");
if (failures) process.exitCode = 1;
