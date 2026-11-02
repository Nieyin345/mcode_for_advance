"use strict";
/**
 * B-02/B-05: fail-closed packaging gate regression using real built N-API addon.
 * Isolated temp output trees, no Electron install and no userData access.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const verify = require("../../build/verify-native-fs-after-pack.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-native-pack-smoke-"));
const built = path.resolve("native/mcode-fs/build/Release/mcode_fs.node");
let passed = 0;
function ok(name) { passed++; console.log("  ok " + name); }
function bundle(name, platform) {
  const out = path.join(root, name);
  const resources = platform === "mac" ?
    path.join(out, "Mcode.app", "Contents", "Resources") :
    path.join(out, "resources");
  fs.mkdirSync(resources, { recursive: true });
  return { out, resources, nativeDir: path.join(resources, "native-fs"),
    binary: path.join(resources, "native-fs", "mcode_fs.node") };
}
function installBinary(tree) {
  fs.mkdirSync(tree.nativeDir, { recursive: true });
  fs.copyFileSync(built, tree.binary);
}
function verifyInChild(tree) {
  // Windows holds a loaded .node DLL open until its process exits. The child
  // proves runtime loadability without locking our disposable fixture tree.
  const result = spawnSync(process.execPath,
    [path.resolve("scripts/native-fs-package-smoke/package-probe.cjs"), tree.out],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /packaged N-API addon exists, loads, and opens a pinned root/);
}
async function rejects(name, tree, pattern) {
  await assert.rejects(verify({ appOutDir: tree.out }), pattern);
  ok(name);
}
(async () => {
  assert.equal(fs.statSync(built).isFile(), true, "compile N-API addon first");
  await assert.rejects(verify({}), /appOutDir/);
  ok("rejects a missing or ambiguous appOutDir");
  const win = bundle("windows-pack", "win");
  installBinary(win);
  verifyInChild(win);
  ok("Windows resources native addon opens a pinned directory");
  const mac = bundle("mac-pack", "mac");
  installBinary(mac);
  verifyInChild(mac);
  ok("macOS Mcode.app Resources native addon opens a pinned directory");
  // electron-builder actually passes /.../Mcode.app as appOutDir on macOS.
  verifyInChild({ ...mac, out: path.join(mac.out, "Mcode.app") });
  ok("macOS real appOutDir (.app bundle root) resolves Contents/Resources");

  const missing = bundle("missing-binary", "win");
  fs.mkdirSync(missing.nativeDir);
  await rejects("missing binary fails closed", missing, /addon missing/);
  const empty = bundle("empty-binary", "win");
  fs.mkdirSync(empty.nativeDir);
  fs.writeFileSync(empty.binary, "");
  await rejects("zero-byte binary fails closed", empty, /non-empty regular file/);
  const corrupt = bundle("corrupt-binary", "win");
  fs.mkdirSync(corrupt.nativeDir);
  fs.writeFileSync(corrupt.binary, "not an N-API addon");
  await rejects("corrupt binary fails to load", corrupt, /cannot load/);
  const dirBinary = bundle("directory-binary", "win");
  fs.mkdirSync(dirBinary.binary, { recursive: true });
  await rejects("binary directory fails closed", dirBinary, /non-empty regular file/);
  const missingDir = bundle("missing-directory", "win");
  await rejects("missing native-fs directory fails closed", missingDir, /directory missing/);
  const missingResources = path.join(root, "no-resources");
  fs.mkdirSync(missingResources);
  await assert.rejects(verify({ appOutDir: missingResources }), /no resources directory/);
  ok("missing resources tree fails closed");

  const linked = bundle("linked-binary", "win");
  fs.mkdirSync(linked.nativeDir, { recursive: true });
  try {
    fs.symlinkSync(built, linked.binary, "file");
    await rejects("binary symlink cannot escape packaged tree", linked, /non-empty regular file/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    console.log("  SKIP file symlink creation not permitted on this host");
  }

  // Windows junctions do not need ordinary symlink privileges on most hosts;
  // this checks a real reparse-point escape when file symlinks are forbidden.
  const linkedDirectory = bundle("linked-native-directory", "win");
  const redirect = path.join(root, "outside-native-directory");
  fs.mkdirSync(redirect);
  try {
    fs.symlinkSync(redirect, linkedDirectory.nativeDir,
      process.platform === "win32" ? "junction" : "dir");
    await rejects("native-fs directory junction/symlink fails closed", linkedDirectory, /not a real directory/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "ENOTSUP") throw error;
    console.log("  SKIP directory symlink/junction creation not permitted on this host");
  }

  // A decoy resources tree must never satisfy a DIFFERENT .app bundle.
  // The verifier must select the actual app bundle, not search for any passing
  // native addon under the output directory.
  const macDecoy = bundle("mac-decoy", "mac");
  const decoyInsideApp = path.join(macDecoy.out, "Mcode.app", "resources", "native-fs");
  fs.mkdirSync(decoyInsideApp, { recursive: true });
  fs.copyFileSync(built, path.join(decoyInsideApp, "mcode_fs.node"));
  await rejects("macOS .app cannot pass using a sibling resources decoy",
    { out: path.join(macDecoy.out, "Mcode.app") }, /directory missing/);

  const macParentDecoy = bundle("mac-parent-decoy", "mac");
  const decoyOutsideApp = path.join(macParentDecoy.out, "resources", "native-fs");
  fs.mkdirSync(decoyOutsideApp, { recursive: true });
  fs.copyFileSync(built, path.join(decoyOutsideApp, "mcode_fs.node"));
  await rejects("macOS parent directory cannot pass using Windows resources decoy",
    macParentDecoy, /ambiguous|directory missing/);

  // Checking only resources/ and native-fs/ does not detect a symlink in an
  // ancestor (macOS .app/Contents -> an unrelated external directory).
  const linkedMacApp = path.join(root, "mac-linked-contents", "Mcode.app");
  const externalContents = path.join(root, "outside-contents");
  fs.mkdirSync(linkedMacApp, { recursive: true });
  const externalNative = path.join(externalContents, "Resources", "native-fs");
  fs.mkdirSync(externalNative, { recursive: true });
  fs.copyFileSync(built, path.join(externalNative, "mcode_fs.node"));
  try {
    fs.symlinkSync(externalContents, path.join(linkedMacApp, "Contents"),
      process.platform === "win32" ? "junction" : "dir");
    await rejects("macOS linked Contents ancestor cannot escape packaged bundle",
      { out: linkedMacApp }, /symbolic link|reparse|not a real directory/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "ENOTSUP") throw error;
    console.log("  SKIP app Contents symlink/junction creation not permitted on this host");
  }

  // Even an apparently ordinary final resources directory is outside the
  // output when appOutDir itself is a junction to a different tree.
  const outsideApp = path.join(root, "outside-packaged-app");
  const outsideNative = path.join(outsideApp, "resources", "native-fs");
  fs.mkdirSync(outsideNative, { recursive: true });
  fs.copyFileSync(built, path.join(outsideNative, "mcode_fs.node"));
  const linkedAppRoot = path.join(root, "linked-app-out");
  try {
    fs.symlinkSync(outsideApp, linkedAppRoot,
      process.platform === "win32" ? "junction" : "dir");
    await rejects("packaged appOutDir itself must not be a symlink or junction",
      { out: linkedAppRoot }, /symbolic link|reparse|not a real directory/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "ENOTSUP") throw error;
    console.log("  SKIP app root symlink/junction creation not permitted on this host");
  }

  // Make sure the wiring itself invokes this verifier, independent of other
  // expensive GenOffice/Theia/Node-RED release validators.
  const hook = fs.readFileSync(path.resolve("build/verify-vendor-after-pack.cjs"), "utf8");
  assert.ok(hook.includes('verify-native-fs-after-pack.cjs'));
  assert.ok(hook.includes('await verifyNativeFs(context)'));
  ok("electron-builder afterPack aggregator invokes native package gate");

  console.log("native-fs-package-smoke: " + passed + "/" + passed + " PASS");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(root, { recursive: true, force: true }));
