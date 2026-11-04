"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  restorePackedNodeModules,
  packagedNodeRedRoots,
} = require("./node-red-nodemodules-shim.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-node-red-packed-shim-"));

function makePackedRoot(appOutDir, relativeRoot, marker) {
  const root = path.join(appOutDir, relativeRoot);
  fs.mkdirSync(path.join(root, "__mcode_node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "__mcode_node_modules", "marker.txt"), marker);
  return root;
}

test("Windows appOutDir restores Node-RED node_modules under resources", () => {
  const out = path.join(temp, "win-unpacked");
  const root = makePackedRoot(out, path.join("resources", "node-red"), "win");
  assert.deepEqual(packagedNodeRedRoots(out), [root]);
  assert.equal(restorePackedNodeModules(out), true);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "marker.txt"), "utf8"), "win");
  assert.equal(restorePackedNodeModules(out), false);
});

test("macOS appOutDir parent restores Node-RED node_modules under Mcode.app/Contents/Resources", () => {
  const out = path.join(temp, "mac-arm64");
  const root = makePackedRoot(out, path.join("Mcode.app", "Contents", "Resources", "node-red"), "mac");
  assert.deepEqual(packagedNodeRedRoots(out), [root]);
  assert.equal(restorePackedNodeModules(out), true);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "marker.txt"), "utf8"), "mac");
});

test("a direct macOS .app appOutDir also resolves Contents/Resources", () => {
  const out = path.join(temp, "direct", "Mcode.app");
  const root = makePackedRoot(out, path.join("Contents", "Resources", "node-red"), "direct-app");
  assert.deepEqual(packagedNodeRedRoots(out), [root]);
  assert.equal(restorePackedNodeModules(out), true);
  assert.equal(fs.readFileSync(path.join(root, "node_modules", "marker.txt"), "utf8"), "direct-app");
});

test("ambiguous Windows and macOS resource roots fail closed", () => {
  const out = path.join(temp, "ambiguous");
  makePackedRoot(out, path.join("resources", "node-red"), "win");
  makePackedRoot(out, path.join("Mcode.app", "Contents", "Resources", "node-red"), "mac");
  assert.throws(() => restorePackedNodeModules(out), /multiple packaged Node-RED resource roots found/);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
