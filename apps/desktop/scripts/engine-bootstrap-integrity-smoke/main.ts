/** ARC-006 Gate B: Node-RED bootstrap installation must preserve old bytes and unrelated temp files.
 * The suite touches ONLY mkdtempSync() synthetic data; no Electron, SDK, user DB or Node-RED process.
 */
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEngineBootstrap, buildManifest, BOOTSTRAP_MANIFEST_FILENAME } from "@main/workflowEngines/bootstrapManifest.js";

let total = 0;
let failures = 0;
function check(message: string, ok: boolean, details?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + message);
  else { failures++; console.log("  FAIL " + message + (details === undefined ? "" : " — " + JSON.stringify(details))); }
}
const root = mkdtempSync(join(tmpdir(), "mcode-bootstrap-collision-"));
const fixed = () => new Date("2026-10-19T01:01:01.000Z");
const content = "// Mcode virtual bootstrap 2";
const bootstrap = join(root, "bootstrap.cjs");
const manifest = join(root, BOOTSTRAP_MANIFEST_FILENAME);
const options = { engineId: "node-red", dataDir: root, content, now: fixed };
const backups = () => readdirSync(root).filter((f) => f.startsWith("bootstrap.cjs.bak-")).sort();
try {
  // A compromised/empty template must never replace a healthy bootstrap or
  // be recorded as a valid installed runtime, even on the very first install.
  const blankInputRoot = join(root, "blank-input-existing");
  mkdirSync(blankInputRoot);
  const existingScript = join(blankInputRoot, "bootstrap.cjs");
  const existingManifest = join(blankInputRoot, BOOTSTRAP_MANIFEST_FILENAME);
  writeFileSync(existingScript, content);
  writeFileSync(existingManifest, JSON.stringify(buildManifest("node-red", content)) + "\n");
  const originalScript = readFileSafe(existingScript);
  const originalManifest = readFileSafe(existingManifest);
  for (const [caseName, supplied] of [["empty", ""], ["whitespace", " \t\n"]] as const) {
    const refusedBlank = ensureEngineBootstrap({ ...options, dataDir: blankInputRoot, content: supplied });
    check(`refuse ${caseName} bootstrap input before any overwrite`, !refusedBlank.ok, refusedBlank);
    check(`refused ${caseName} input preserves installed bootstrap`, readFileSafe(existingScript) === originalScript);
    check(`refused ${caseName} input preserves installed manifest`, readFileSafe(existingManifest) === originalManifest);
  }
  check("invalid bootstrap content creates no historical backup",
    readdirSync(blankInputRoot).filter((item) => item.startsWith("bootstrap.cjs.bak-")).length === 0);
  const firstInstall = join(root, "blank-new-engine");
  mkdirSync(firstInstall);
  const blankInstall = ensureEngineBootstrap({ ...options, dataDir: firstInstall, content: "" });
  check("empty first install is rejected", !blankInstall.ok, blankInstall);
  check("empty first install creates no bootstrap or manifest", readdirSync(firstInstall).length === 0);

  // A. Existing unrelated staging files must not be silently overwritten by a manifest upgrade.
  writeFileSync(bootstrap, content);
  const unrelatedManifestTmp = manifest + ".tmp";
  const unrelatedBootstrapTmp = bootstrap + ".tmp";
  writeFileSync(unrelatedManifestTmp, "UNRELATED_MANIFEST_STAGE");
  writeFileSync(unrelatedBootstrapTmp, "UNRELATED_BOOTSTRAP_STAGE");
  const manifestRepair = ensureEngineBootstrap(options);
  check("manifest repair succeeds", manifestRepair.ok === true, manifestRepair);
  check("manifest repair never overwrites preexisting manifest.tmp", readFileSafe(unrelatedManifestTmp) === "UNRELATED_MANIFEST_STAGE", readFileSafe(unrelatedManifestTmp));
  check("manifest repair still writes a versioned manifest", existsSync(manifest));

  // B. Two updates in the exact same timestamp must preserve BOTH historical copies.
  writeFileSync(bootstrap, "historical version A");
  const one = ensureEngineBootstrap(options);
  check("version A upgrade succeeds", one.ok && one.backupPath !== null, one);
  writeFileSync(bootstrap, "historical version B");
  const two = ensureEngineBootstrap(options);
  check("version B upgrade succeeds", two.ok && two.backupPath !== null, two);
  const names = backups();
  const bytes = names.map((n) => readFileSync(join(root, n), "utf8"));
  check("two same-time upgrades keep TWO non-overwriting backups", names.length === 2 && new Set(names).size === 2, { names });
  check("version A historical bytes still readable", bytes.includes("historical version A"), bytes);
  check("version B historical bytes still readable", bytes.includes("historical version B"), bytes);
  check("bootstrap after upgrades remains the current content", readFileSync(bootstrap, "utf8") === content);
  check("bootstrap unrelated staging file remains intact", readFileSafe(unrelatedBootstrapTmp) === "UNRELATED_BOOTSTRAP_STAGE");

  // C. Repeat manifest-only repair with a stale tmp and ensure new stage does not collide.
  rmSync(manifest);
  const third = ensureEngineBootstrap(options);
  check("repeat manifest repair works with an unrelated stale staging file", third.ok, third);
  check("existing unrelated tmp bytes are never overwritten", readFileSafe(unrelatedManifestTmp) === "UNRELATED_MANIFEST_STAGE");
  check("copy-file exclusive mode is available on this runtime", typeof constants.COPYFILE_EXCL === "number");
  const damagedDir = join(root, "damaged-input");
  mkdirSync(join(damagedDir, BOOTSTRAP_MANIFEST_FILENAME), { recursive: true });
  writeFileSync(join(damagedDir, "bootstrap.cjs"), "OLD_BYTES");
  const refused = ensureEngineBootstrap({ ...options, dataDir: damagedDir });
  check("manifest read error returns a clear failure", !refused.ok && !!refused.reason, refused);
  check("manifest read error must preserve old script", readFileSafe(join(damagedDir, "bootstrap.cjs")) === "OLD_BYTES");
  check("manifest read error must not create backup", readdirSync(damagedDir).filter((x) => x.includes(".bak-")).length === 0);
  // Windows NTFS hardlinks need no symlink privilege. A hardlink whose target
  // lives outside the engine root is still a regular file to lstatSync.
  const externalBytes = join(root, "outside-hardlink-bootstrap.cjs");
  writeFileSync(externalBytes, "OUTSIDE_OLD_BYTES");
  const hardlinkRoot = join(root, "hardlink-script");
  mkdirSync(hardlinkRoot);
  linkSync(externalBytes, join(hardlinkRoot, "bootstrap.cjs"));
  const scriptHardlink = ensureEngineBootstrap({ ...options, dataDir: hardlinkRoot });
  check("hardlinked bootstrap file must fail closed", !scriptHardlink.ok, scriptHardlink);
  check("hardlinked bootstrap never alters outside target", readFileSafe(externalBytes) === "OUTSIDE_OLD_BYTES");
  check("hardlinked bootstrap does not publish a replacement manifest",
    !existsSync(join(hardlinkRoot, BOOTSTRAP_MANIFEST_FILENAME)));
  const externalManifestBytes = join(root, "outside-hardlink-manifest.json");
  const manifestSentinel = JSON.stringify(buildManifest("node-red", content)) + "\n";
  writeFileSync(externalManifestBytes, manifestSentinel);
  const hardlinkManifestRoot = join(root, "hardlink-manifest");
  mkdirSync(hardlinkManifestRoot);
  writeFileSync(join(hardlinkManifestRoot, "bootstrap.cjs"), content);
  linkSync(externalManifestBytes, join(hardlinkManifestRoot, BOOTSTRAP_MANIFEST_FILENAME));
  const manifestHardlink = ensureEngineBootstrap({ ...options, dataDir: hardlinkManifestRoot });
  check("hardlinked manifest must fail closed", !manifestHardlink.ok, manifestHardlink);
  check("hardlinked manifest never alters outside target", readFileSafe(externalManifestBytes) === manifestSentinel);

  const badScriptDir = join(root, "bootstrap-is-dir");
  mkdirSync(join(badScriptDir, "bootstrap.cjs"), { recursive: true });
  const badScriptResult = ensureEngineBootstrap({ ...options, dataDir: badScriptDir });
  check("existing bootstrap directory returns a READ error", !badScriptResult.ok && (badScriptResult.reason ?? "").includes("读取"), badScriptResult);
  check("bootstrap read error does not publish manifest", !existsSync(join(badScriptDir, BOOTSTRAP_MANIFEST_FILENAME)));

  // A managed engine bootstrap must never follow a symlink outside dataDir.
  // The link may point at a healthy script/manifest today and be swapped tomorrow.
  const symlinkRoot = join(root, "link-case");
  mkdirSync(symlinkRoot);
  const external = join(root, "outside-bootstrap.cjs");
  writeFileSync(external, content);
  const link = join(symlinkRoot, "bootstrap.cjs");
  let linkSupported = true;
  try {
    symlinkSync(external, link, "file");
  } catch (err) {
    linkSupported = false;
    console.log("  SKIP symlink test: OS symlink privilege unavailable — " + String(err));
  }
  if (linkSupported) {
    const linked = ensureEngineBootstrap({ ...options, dataDir: symlinkRoot });
    check("managed bootstrap symlink must fail closed", !linked.ok, linked);
    check("rejected link preserves its outside target", readFileSafe(external) === content);
    check("rejected link does not publish manifest", !existsSync(join(symlinkRoot, BOOTSTRAP_MANIFEST_FILENAME)));
    const manifestRoot = join(root, "linked-manifest-case");
    mkdirSync(manifestRoot);
    writeFileSync(join(manifestRoot, "bootstrap.cjs"), content);
    const externalManifest = join(root, "external-manifest.json");
    writeFileSync(externalManifest, JSON.stringify(buildManifest("node-red", content)));
    symlinkSync(externalManifest, join(manifestRoot, BOOTSTRAP_MANIFEST_FILENAME), "file");
    const badLinkManifest = ensureEngineBootstrap({ ...options, dataDir: manifestRoot });
    check("managed manifest symlink must fail closed", !badLinkManifest.ok, badLinkManifest);
    check("rejected manifest symlink preserves outside bytes", readFileSafe(externalManifest) === JSON.stringify(buildManifest("node-red", content)));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
function readFileSafe(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}
console.log(`engine-bootstrap-integrity-smoke: ${total - failures}/${total} 通过`);
if (failures !== 0) process.exitCode = 1;
