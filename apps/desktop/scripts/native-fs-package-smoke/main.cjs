"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const binary = process.env.MCODE_NATIVE_FS_PATH ||
  path.resolve(__dirname, "../../native/mcode-fs/build/Release/mcode_fs.node");
const verifier = path.resolve(__dirname, "../../build/verify-native-fs-after-pack.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-native-fs-package-"));
const probe = path.join(temp, "verify.cjs");

function runVerifier(appOutDir) {
  const result = spawnSync(process.execPath, [probe, verifier, appOutDir], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    output: (result.stdout ?? "") + (result.stderr ?? "") +
      (result.error ? "\n" + result.error.message : ""),
  };
}

try {
  assert.ok(fs.statSync(binary).isFile(), "Electron-target native addon must exist before packaging smoke");
  fs.writeFileSync(probe, [
    '"use strict";',
    'const verify = require(process.argv[2]);',
    'verify({ appOutDir: process.argv[3] }).catch((error) => {',
    '  console.error(error);',
    '  process.exitCode = 1;',
    '});',
    "",
  ].join("\n"));

  // electron-builder's appOutDir differs by platform: Windows points at the
  // resources directory; macOS may point at the .app or its Contents folder.
  const appOutDir = path.join(temp, "app-out");
  const relativeResourceRoot = process.platform === "darwin"
    ? path.join("Resources", "native-fs")
    : path.join("resources", "native-fs");
  const resourceRoot = path.join(appOutDir, relativeResourceRoot);
  fs.mkdirSync(resourceRoot, { recursive: true });
  fs.copyFileSync(binary, path.join(resourceRoot, "mcode_fs.node"));

  const valid = runVerifier(appOutDir);
  assert.equal(valid.status, 0, "packaged addon must load and open a pinned root: " + valid.output);
  assert.match(valid.output, /packaged N-API addon exists, loads, and opens a pinned root/);
  console.log("PASS packaged native addon loads and opens a pinned root");

  // If a generic resources directory also exists, prefer the actual app bundle
  // resource path that contains the addon rather than failing on the empty one.
  const fallbackAppOutDir = path.join(temp, "fallback-app-out");
  fs.mkdirSync(path.join(fallbackAppOutDir, "resources", "native-fs"), { recursive: true });
  const fallbackResourceRoot = path.join(fallbackAppOutDir, "Contents", "Resources", "native-fs");
  fs.mkdirSync(fallbackResourceRoot, { recursive: true });
  fs.copyFileSync(binary, path.join(fallbackResourceRoot, "mcode_fs.node"));
  const fallback = runVerifier(fallbackAppOutDir);
  assert.equal(fallback.status, 0, "packaged addon resolver must select the candidate containing the binary: " + fallback.output);
  console.log("PASS packaged addon resolver selects the populated app resource root");

  const missingBinaryRoot = path.join(temp, "missing-binary-app-out");
  fs.mkdirSync(path.join(missingBinaryRoot, relativeResourceRoot), { recursive: true });
  const missingBinary = runVerifier(missingBinaryRoot);
  assert.notEqual(missingBinary.status, 0, "missing addon must fail the packaging gate");
  assert.match(missingBinary.output, /packaged native addon is missing/);
  console.log("PASS missing packaged native addon fails closed");

  const emptyBinaryRoot = path.join(temp, "empty-binary-app-out");
  const emptyResourceRoot = path.join(emptyBinaryRoot, relativeResourceRoot);
  fs.mkdirSync(emptyResourceRoot, { recursive: true });
  fs.writeFileSync(path.join(emptyResourceRoot, "mcode_fs.node"), Buffer.alloc(0));
  const emptyBinary = runVerifier(emptyBinaryRoot);
  assert.notEqual(emptyBinary.status, 0, "empty addon must fail the packaging gate");
  assert.match(emptyBinary.output, /not a non-empty regular file/);
  console.log("PASS empty packaged native addon fails closed");

  const missingRoot = runVerifier(path.join(temp, "missing-app-out"));
  assert.notEqual(missingRoot.status, 0, "missing resource directory must fail the packaging gate");
  assert.match(missingRoot.output, /missing resources\/native-fs/);
  console.log("PASS missing native resource directory fails closed");
} finally {
  // The verifier runs in a child process so Windows releases the loaded .node
  // file before the parent removes the temporary package fixture.
  fs.rmSync(temp, { recursive: true, force: true });
}
