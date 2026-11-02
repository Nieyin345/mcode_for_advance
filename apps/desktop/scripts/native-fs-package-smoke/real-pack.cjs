"use strict";
/**
 * Real Windows electron-builder integration check for the B-02/B-05 addon.
 * The regular native-fs-package-smoke stays fast/cross-platform; this opt-in
 * test exercises electron-builder's actual extraResources copy and afterPack.
 * It builds a tiny disposable Electron app: NEVER the user's Mcode release.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.error("native-fs-real-package: this integration test requires Windows");
  process.exit(2);
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
const electronBinary = require(path.join(desktop, "node_modules", "electron"));
module.exports = {
  appId: "com.mcode.native-fs-fixture",
  productName: "McodeNativeFsProbe",
  electronVersion: require(path.join(desktop, "node_modules", "electron", "package.json")).version,
  electronDist: path.dirname(electronBinary),
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
};
`;

function build(negative) {
  const child = spawnSync(process.execPath, [
    builder, "--win", "--dir", "--projectDir", fixture,
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
  assert.equal(success.status, 0, "Real Windows packaging must succeed: " + success.output.slice(-2500));
  assert.match(success.output, /\[verify-native-fs\] PASS/);
  const packed = path.join(fixture, "out", "win-unpacked", "resources", "native-fs", "mcode_fs.node");
  assert.ok(fs.statSync(packed).isFile(), "Real appOutDir must contain native-fs/mcode_fs.node");
  console.log("  ok real electron-builder copies and probes the packed native addon");

  const failure = build(true);
  assert.notEqual(failure.status, 0, "Packaging without native extraResources must fail");
  assert.match(failure.output, /\[verify-native-fs\] packaged native-fs directory missing/);
  console.log("  ok real electron-builder rejects packaging without native-fs");

  console.log("native-fs-real-package: 2/2 PASS");
} finally {
  // The child-process probe doesn't keep a Windows .node DLL locked after exit.
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
