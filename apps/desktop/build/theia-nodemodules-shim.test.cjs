"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  hideTheiaNodeModules,
  restoreTheiaSourceNodeModules,
  restorePackedTheiaNodeModules,
} = require("./theia-nodemodules-shim.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-theia-node-modules-shim-"));

function makeRuntime(root) {
  fs.mkdirSync(path.join(root, "node_modules", "@theia"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "theia-runtime" }));
  fs.writeFileSync(path.join(root, "node_modules", "@theia", "marker.txt"), "theia");
  return root;
}

test("source Theia node_modules rename is reversible and idempotent", () => {
  const root = makeRuntime(path.join(temp, "source"));
  assert.equal(hideTheiaNodeModules(root), true);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  assert.equal(fs.readFileSync(path.join(root, "__mcode_node_modules", "@theia", "marker.txt"), "utf8"), "theia");
  assert.equal(hideTheiaNodeModules(root), false);
  assert.equal(restoreTheiaSourceNodeModules(root), true);
  assert.equal(restoreTheiaSourceNodeModules(root), false);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "@theia", "marker.txt"), "utf8"), "theia");
});

test("Windows packaged resources restore __mcode_node_modules to resources/theia/node_modules", () => {
  const out = path.join(temp, "win-unpacked");
  const root = path.join(out, "resources", "theia");
  fs.mkdirSync(path.join(root, "__mcode_node_modules", "@theia"), { recursive: true });
  fs.writeFileSync(path.join(root, "__mcode_node_modules", "@theia", "marker.txt"), "win");
  assert.equal(restorePackedTheiaNodeModules(out), true);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "@theia", "marker.txt"), "utf8"), "win");
  assert.equal(restorePackedTheiaNodeModules(out), false);
});

test("macOS packaged resources restore __mcode_node_modules inside Contents/Resources", () => {
  const out = path.join(temp, "Mcode.app");
  const root = path.join(out, "Contents", "Resources", "theia");
  fs.mkdirSync(path.join(root, "__mcode_node_modules", "@theia"), { recursive: true });
  fs.writeFileSync(path.join(root, "__mcode_node_modules", "@theia", "marker.txt"), "mac");
  assert.equal(restorePackedTheiaNodeModules(out), true);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "@theia", "marker.txt"), "utf8"), "mac");
});

test("source hide fails closed if both directory names exist", () => {
  const root = makeRuntime(path.join(temp, "ambiguous"));
  fs.mkdirSync(path.join(root, "__mcode_node_modules"));
  assert.throws(() => hideTheiaNodeModules(root), /both source directories exist/);
  assert.ok(fs.existsSync(path.join(root, "node_modules", "@theia", "marker.txt")));
});

test("packed restore fails closed if both directory names exist", () => {
  const out = path.join(temp, "packed-ambiguous");
  const root = path.join(out, "resources", "theia");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "__mcode_node_modules"), { recursive: true });
  assert.throws(() => restorePackedTheiaNodeModules(out), /both packed directories exist/);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
