"use strict";
/**
 * B-02/B-05: verify the *distributed* native addon bytes, not just afterPack's
 * unpacked staging tree. Read-only; never run or install a distributable.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { find7za } = require("../office-release-audit/nsis-inspector.cjs");

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const RELATIVE_BINARY = "resources/native-fs/mcode_fs.node";

function regularBinary(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > MAX_BINARY_BYTES)
    throw Error("Native FS addon must be a non-empty, regular file below 128 MiB: " + file);
  const data = fs.readFileSync(file);
  return { size: st.size, sha256: createHash("sha256").update(data).digest("hex") };
}
function assertExpected(actual, expected, origin) {
  assert.deepEqual(actual, expected, origin + " differs from the approved native addon");
}
function safeArchive(file, extension) {
  const resolved = path.resolve(file);
  if (path.extname(resolved).toLowerCase() !== extension)
    throw Error("Unexpected distributable extension: " + resolved);
  const st = fs.lstatSync(resolved);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1)
    throw Error("Distributable is missing, empty or symlinked: " + resolved);
  return resolved;
}
function inspectNsis(exe, sourceBinary, unpackedBinary, options = {}) {
  const archive = safeArchive(exe, ".exe");
  const expected = regularBinary(sourceBinary);
  assertExpected(regularBinary(unpackedBinary), expected, "unpacked addon");
  const sevenZip = options.sevenZip || find7za();
  const run = options.run || ((args, maxBuffer) => execFileSync(sevenZip, args, {
    windowsHide: true, timeout: 180000, maxBuffer, encoding: null,
  }));
  // NSIS is a self-extracting wrapper. Avoid wildcard filtering here: some 7-Zip
  // builds apply it to wrapper metadata instead of the embedded application tree.
  const listing = run(["l", "-ba", "-slt", archive], 64 * 1024 * 1024).toString("utf8");
  const paths = listing.split(/\r?\n/).flatMap(line => {
    const m = /^Path = (.+)$/.exec(line);
    return m ? [m[1].replace(/\\/g, "/").toLowerCase()] : [];
  });
  const matches = paths.filter(p => p === RELATIVE_BINARY);
  if (matches.length !== 1) {
    const related = paths.filter(p => p.includes("native-fs") || p.endsWith("mcode_fs.node")).slice(0, 20);
    const sample = paths.filter(p => p.includes("/")).slice(0, 12);
    throw Error("NSIS must contain exactly one native-fs/mcode_fs.node: found " + matches.length
      + (related.length ? "; related entries: " + related.join(", ") : "; no native-fs paths in archive listing")
      + (sample.length ? "; archive path sample: " + sample.join(", ") : ""));
  }
  const data = run(["e", "-so", archive, RELATIVE_BINARY.replace(/\//g, "\\")], expected.size + 1024 * 1024);
  if (!Buffer.isBuffer(data)) throw Error("NSIS binary extraction did not return bytes");
  const packed = { size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  assertExpected(packed, expected, "NSIS embedded addon");
  return { ok: true, archive, addonSha256: packed.sha256, addonSize: packed.size };
}
function realDir(directory) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error("macOS bundle directory is missing or symlinked: " + directory);
}
function verifyMacApp(archiveRoot, expected) {
  const mount = path.resolve(archiveRoot);
  realDir(mount);
  const bundles = fs.readdirSync(mount, { withFileTypes: true }).filter(x => x.name.endsWith(".app"));
  if (bundles.length !== 1 || bundles[0].name !== "Mcode.app")
    throw Error("macOS distributable must contain exactly one Mcode.app");
  const app = path.join(mount, "Mcode.app");
  realDir(app);
  let at = app;
  for (const part of ["Contents", "Resources", "native-fs"]) {
    at = path.join(at, part);
    realDir(at);
  }
  if (!fs.realpathSync(at).startsWith(fs.realpathSync(app) + path.sep))
    throw Error("macOS bundled native-fs resources escape Mcode.app");
  const embedded = regularBinary(path.join(at, "mcode_fs.node"));
  assertExpected(embedded, expected, "macOS embedded addon");
  return { ok: true, addonSha256: embedded.sha256, addonSize: embedded.size };
}
function inspectMacDmg(dmg, sourceBinary, options = {}) {
  if (process.platform !== "darwin" && !options.allowTestPlatform)
    throw Error("DMG inspection requires macOS hdiutil");
  const archive = safeArchive(dmg, ".dmg");
  const expected = regularBinary(sourceBinary);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-nativefs-dmg-"));
  const execute = options.hdiutil || (args => execFileSync("hdiutil", args, {
    windowsHide: true, timeout: 180000, stdio: ["ignore", "pipe", "pipe"],
  }));
  let attached = false;
  try {
    execute(["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive]);
    attached = true;
    return { ...verifyMacApp(mount, expected), archive };
  } finally {
    if (attached) {
      // If detach fails, leave a mounted volume untouched rather than recursively erasing it.
      execute(["detach", mount]);
      fs.rmSync(mount, { recursive: true, force: true });
    } else {
      try { fs.rmdirSync(mount); } catch { /* may be partially mounted: fail closed */ }
    }
  }
}
function inspectMacZip(zip, sourceBinary, options = {}) {
  if (process.platform !== "darwin" && !options.allowTestPlatform)
    throw Error("ZIP inspection requires macOS ditto");
  const archive = safeArchive(zip, ".zip");
  const expected = regularBinary(sourceBinary);
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-nativefs-zip-"));
  const ditto = options.ditto || (args => execFileSync("ditto", args, {
    windowsHide: true, timeout: 180000, stdio: ["ignore", "pipe", "pipe"],
  }));
  try {
    ditto(["-x", "-k", archive, extracted]);
    return { ...verifyMacApp(extracted, expected), archive };
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}
function inspectMacRelease(releaseDir, sourceBinary, options = {}) {
  const dir = path.resolve(releaseDir);
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter(x => x.isFile()).map(x => x.name);
  const dmg = files.filter(n => /^Mcode-[\w.-]+\.dmg$/i.test(n));
  const zip = files.filter(n => /^Mcode-[\w.-]+\.zip$/i.test(n));
  if (dmg.length !== 1 || zip.length !== 1)
    throw Error("Expected exactly one Mcode DMG and one updater ZIP, got " + dmg.length + "/" + zip.length);
  const d = inspectMacDmg(path.join(dir, dmg[0]), sourceBinary, options);
  const z = inspectMacZip(path.join(dir, zip[0]), sourceBinary, options);
  assertExpected({ sha256: d.addonSha256, size: d.addonSize },
    { sha256: z.addonSha256, size: z.addonSize }, "macOS DMG/ZIP addon parity");
  return { ok: true, dmg: d.archive, zip: z.archive, addonSha256: d.addonSha256, addonSize: d.addonSize };
}
if (require.main === module) {
  const [target, arg1, arg2, arg3] = process.argv.slice(2);
  try {
    const result = target === "nsis" ? inspectNsis(arg1, arg2, arg3)
      : target === "mac" ? inspectMacRelease(arg1, arg2)
      : (() => { throw Error("Usage: node verify.cjs nsis <installer.exe> <source-addon.node> <win-unpacked-addon.node> | mac <release-dir> <source-addon.node>"); })();
    console.log("Native FS distributable audit PASS " + JSON.stringify(result));
  } catch (e) {
    console.error("Native FS distributable audit FAIL CLOSED:", e?.stack || String(e));
    process.exitCode = 2;
  }
}
module.exports = { regularBinary, inspectNsis, verifyMacApp, inspectMacDmg, inspectMacZip, inspectMacRelease };
