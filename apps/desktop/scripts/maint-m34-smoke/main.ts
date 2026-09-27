/** Isolated on-disk fixture for the REAL paths.ts and manifest.ts.
 * No app, user DB, model, external download or user-owned file is touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownArtifactsOfItem, markdownArtifact, markdownDirForHash, countImageFiles } from "../../src/main/library/paths.js";
import { attachToChat, writeCollectionManifest, writeItemManifest } from "../../src/main/library/manifest.js";
const data = mkdtempSync(join(tmpdir(), "mcode-m34-fixture-"));
process.env.MCODE_SMOKE_DATA_ROOT = data;
let assertions = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  assertions++;
  const ok = Object.is(actual, expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failed++;
}
try {
  const sha = "a".repeat(64);
  const legacyDir = markdownDirForHash(sha);
  const legacyMd = join(legacyDir, "full.md");
  mkdirSync(join(legacyDir, "images"), { recursive: true });
  writeFileSync(legacyMd, "![fig](images/fig.png)");
  writeFileSync(join(legacyDir, "images", "fig.png"), "fixture");
  // Existing deletion classifier correctly selects the WHOLE directory.
  check("legacy delete target is the package directory", markdownArtifact(legacyMd).path, legacyDir);
  check("legacy delete target is recursive", markdownArtifact(legacyMd).recursive, true);
  const candidates = markdownArtifactsOfItem({ pdfSha256: sha });
  const legacy = candidates.find((a) => a.recursive);
  check("hash-derived preview uses the same deletion target", legacy?.path, legacyDir);
  check("hash-derived preview counts images inside legacy package", legacy && countImageFiles(legacy.path), 1);
  // A bound mdPath is the same artifact, not a second package to display.
  const relativeMd = `markdown/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}/full.md`;
  const bound = markdownArtifactsOfItem({ pdfSha256: sha, mdPath: relativeMd });
  check("legacy package appears once when also referenced by mdPath", bound.filter((a) => a.recursive && a.path === legacyDir).length, 1);
  check("same legacy package has no duplicate full.md entry", bound.some((a) => a.path === legacyMd), false);
  const flat = markdownArtifactsOfItem({ pdfSha256: sha });
  check("flat hash transcript retained", flat.filter((a) => !a.recursive).length, 1);

  // Real attachToChat -> expandLinks -> writeItemManifest -> pushAttach.
  // Only the repository, IPC, suppression and trash feeds are inert stand-ins.
  const lab = {
    items: { A: { id: "A", title: "Entry A" }, B: { id: "B", title: "Entry B" } },
    trashed: new Set(["B"]),
    events: [] as Array<{ key: string }>,
  };
  (globalThis as typeof globalThis & { __m34: typeof lab }).__m34 = lab;
  // Both functions are also called directly by the library item/collection IPC endpoints.
  check("direct item manifest must reject a trashed item", writeItemManifest("B").path, "");
  const collection = writeCollectionManifest("COL");
  const index = readFileSync(collection.path, "utf8");
  check("collection index excludes trashed item", index.includes("Entry B"), false);
  check("collection index keeps live item", index.includes("Entry A"), true);
  check("collection count excludes trashed item", collection.count, 1);
  const linked = attachToChat("session", "i:A");
  check("live entry still attaches", linked.ok, true);
  check("linked trashed item must not attach", lab.events.map((e) => e.key).join(","), "i:A");
  check("skipped trashed link is explained to user", Boolean(linked.error?.includes("回收站")), true);
  lab.trashed.clear();
  lab.events.length = 0;
  check("normal link attach still succeeds", attachToChat("session", "i:A").ok, true);
  check("normal linked item still appears", lab.events.map((e) => e.key).join(","), "i:A,i:B");
  lab.trashed.add("A");
  lab.events.length = 0;
  check("trashed entry itself is rejected", attachToChat("session", "i:A").ok, false);
  check("rejected entry sends no attachment", lab.events.length, 0);
} finally {
  rmSync(data, { recursive: true, force: true }); // Only our unique fixture directory.
}
console.log(`M34: ${assertions - failed}/${assertions} checks pass`);
if (failed) process.exitCode = 1;
