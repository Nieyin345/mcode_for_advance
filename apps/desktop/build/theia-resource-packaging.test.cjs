"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertTheiaExtraResourceSource } = require("./link-theia-runtime.cjs");
const { theiaRootIn } = require("./verify-theia-after-pack.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-theia-resource-root-"));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const repoRoot = path.resolve(__dirname, "../../..");
const runtimeRoot = path.join(repoRoot, "vendor/theia-runtime");
const configPath = path.join(__dirname, "../electron-builder.yml");

test("electron-builder Theia extraResources resolves to the tracked repository-root runtime", () => {
  assert.equal(assertTheiaExtraResourceSource(), runtimeRoot);
});

test("Theia extraResources explicitly includes node_modules before the pack shim restores it", () => {
  const config = fs.readFileSync(configPath, "utf8");
  const start = config.indexOf("from: ../../vendor/theia-runtime");
  assert.notEqual(start, -1);
  const next = config.indexOf("\n  - from:", start + 1);
  const block = config.slice(start, next === -1 ? config.length : next);
  assert.ok(block.includes("to: theia"));
  assert.ok(block.includes('"**/node_modules/**"'));
});

test("Theia afterPack resolves macOS appOutDir parent to Mcode.app/Contents/Resources", () => {
  const out = path.join(temp, "mac-arm64");
  const root = path.join(out, "Mcode.app", "Contents", "Resources", "theia");
  fs.mkdirSync(root, { recursive: true });
  assert.equal(theiaRootIn({ appOutDir: out }), root);
});

test("Theia afterPack rejects ambiguous Windows and macOS resource roots", () => {
  const out = path.join(temp, "ambiguous");
  fs.mkdirSync(path.join(out, "resources", "theia"), { recursive: true });
  fs.mkdirSync(path.join(out, "Mcode.app", "Contents", "Resources", "theia"), { recursive: true });
  assert.throws(() => theiaRootIn({ appOutDir: out }), /multiple packaged Theia resource roots/);
});

test("complete checkout contains the pinned Theia runtime package root", {
  skip: !fs.existsSync(path.join(runtimeRoot, "package.json")),
}, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@theia/monorepo");
  const reflect = JSON.parse(fs.readFileSync(
    path.join(runtimeRoot, "node_modules", "reflect-metadata", "package.json"), "utf8",
  ));
  assert.equal(reflect.name, "reflect-metadata");
  assert.equal(reflect.version, "0.2.2");
});

