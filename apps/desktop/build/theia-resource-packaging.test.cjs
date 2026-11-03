"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assertTheiaExtraResourceSource } = require("./link-theia-runtime.cjs");

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

