"use strict";
/**
 * Real Windows/macOS electron-builder integration check for the B-02/B-05 addon.
 * The regular native-fs-package-smoke stays fast/cross-platform; this opt-in
 * test exercises electron-builder's actual extraResources copy and afterPack.
 * It builds a tiny disposable Electron app: NEVER the user's Mcode release.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32" && process.platform !== "darwin") {
  console.log("SKIP native-fs-real-package: Windows/macOS Electron package required");
  process.exit(0);
}

const desktop = path.resolve(__dirname, "../..");
const nativeBinary = path.join(desktop, "native", "mcode-fs", "build", "Release", "mcode_fs.node");
assert.ok(fs.statSync(nativeBinary).isFile(), "Build native filesystem addon first");
const scratch = path.join(desktop, ".tmp");
fs.mkdirSync(scratch, { recursive: true });
const fixture = fs.mkdtempSync(path.join(scratch, "native-fs-real-package-"));
const builder = require.resolve("electron-builder/cli.js", { paths: [desktop] });

const config = `"use strict";
const path = require("node:path");
const desktop = ${JSON.stringify(desktop)};
const omitNative = process.env.MCODE_NATIVE_PACKAGE_NEGATIVE === "1";
module.exports = {
  appId: "com.mcode.native-fs-fixture",
  // Use the real macOS bundle name. afterPack must inspect Mcode.app, never a
  // similarly named decoy bundle in the output directory.
  productName: "Mcode",
  electronVersion: require(path.join(desktop, "node_modules", "electron", "package.json")).version,
  electronDist: path.join(desktop, "node_modules", "electron", "dist"),
  npmRebuild: false,
  asar: false,
  files: ["main.js", "package.json"],
  directories: { output: path.join(__dirname, omitNative ? "out-missing-native" : "out") },
  extraResources: omitNative ? [] : [{
    from: path.join(desktop, "native", "mcode-fs", "build", "Release"),
    to: "native-fs", filter: ["mcode_fs.node"],
  }],
  afterPack: path.join(desktop, "build", "verify-native-fs-after-pack.cjs"),
  win: { target: ["dir"], executableName: "McodeNativeFsProbe" },
  mac: { target: ["dir"], identity: null },
};
`;

function build(negative) {
  const child = spawnSync(process.execPath, [
    builder, process.platform === "darwin" ? "--mac" : "--win", "--dir", "--projectDir", fixture,
    "--config", "electron-builder.config.cjs", "--publish", "never",
  ], {
    cwd: desktop,
    env: { ...process.env, MCODE_NATIVE_PACKAGE_NEGATIVE: negative ? "1" : "0" },
    encoding: "utf8",
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  return { status: child.status, output: child.stdout + child.stderr };
}

try {
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
    name: "mcode-native-package-probe", version: "0.0.1",
    description: "Isolated electron-builder native-fs check", main: "main.js",
    author: "Mcode", license: "MIT",
  }, null, 2));
  fs.writeFileSync(path.join(fixture, "main.js"), "// minimal fixture, never launched\n");
  fs.writeFileSync(path.join(fixture, "electron-builder.config.cjs"), config);

  const success = build(false);
  assert.equal(success.status, 0, "Real " + process.platform + " packaging must succeed: " + success.output.slice(-2500));
  assert.match(success.output, /\[verify-native-fs\] PASS/);
  let packed;
  if (process.platform === "darwin") {
    const out = path.join(fixture, "out");
    const macDir = fs.readdirSync(out).find(name => name === "mac" || name.startsWith("mac-"));
    assert.ok(macDir, "electron-builder must create a macOS output directory");
    packed = path.join(out, macDir, "Mcode.app", "Contents", "Resources", "native-fs", "mcode_fs.node");
  } else {
    packed = path.join(fixture, "out", "win-unpacked", "resources", "native-fs", "mcode_fs.node");
  }
  assert.ok(fs.statSync(packed).isFile(), "Real appOutDir must contain native-fs/mcode_fs.node");
  console.log("  ok real electron-builder copies and probes the packed native addon");

  const failure = build(true);
  assert.notEqual(failure.status, 0, "Packaging without native extraResources must fail");
  assert.match(failure.output, /\[verify-native-fs\] packaged native-fs directory missing/);
  console.log("  ok real electron-builder rejects packaging without native-fs");

  console.log("native-fs-real-package: 2/2 PASS");
} finally {
  // The child-process probe does not keep the packaged .node module loaded.
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
