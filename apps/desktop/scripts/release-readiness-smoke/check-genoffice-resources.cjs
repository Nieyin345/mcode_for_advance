"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

function nonempty(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.size > 0, "Missing GenOffice file: " + file);
}
function nonemptyDir(dir) {
  const stat = fs.lstatSync(dir);
  assert.ok(stat.isDirectory() && fs.readdirSync(dir).length > 0, "Missing GenOffice directory: " + dir);
}
// Reuse one release verifier for ancestor links and original vendor hashes.
const { verifyPackagedGenofficeEditorAssets, verifyPhysicalDirChain } =
  require("../../build/verify-genoffice-editors-after-pack.cjs");
const ORIGINAL_EDITORS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
function verifyPackagedGenofficeResources(unpacked) {
  const root = path.join(unpacked, "resources", "genoffice");
  verifyPhysicalDirChain(unpacked, ["resources", "genoffice"]);
  nonemptyDir(root);
  const marker = path.join(root, "availability.json");
  nonempty(marker);
  const info = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(info.format, "mcode.genoffice.resources.v1");
  assert.equal(typeof info.bundled, "boolean", "Invalid installed sidecar availability");
  assert.equal(typeof info.editorsBundled, "boolean", "Missing GenOffice editorsBundled availability flag");
  assert.ok(Array.isArray(info.editors), "Missing GenOffice editor inventory");
  assert.ok(!info.editorsBundled || info.bundled, "Original editors require the CLI bundle");
  if (info.editorsBundled) {
    assert.deepEqual(info.editors, [...ORIGINAL_EDITORS], "GenOffice six-editor inventory must be complete");
  } else {
    assert.deepEqual(info.editors, [], "Unbundled GenOffice editors inventory must be empty");
    assert.ok(!fs.existsSync(path.join(root, "apps")), "Stale GenOffice editor resources in CLI-only package");
  }
  if (!info.bundled) {
    for (const name of ["cli", "wasm", "licenses"]) {
      assert.ok(!fs.existsSync(path.join(root, name)), "Unbundled GenOffice contains stale " + name);
    }
    return { bundled: false, editorsBundled: false };
  }
  nonemptyDir(path.join(root, "cli"));
  nonemptyDir(path.join(root, "wasm"));
  nonemptyDir(path.join(root, "licenses"));
  nonempty(path.join(root, "cli", "genoffice.cjs"));
  nonemptyDir(path.join(root, "cli", "node_modules"));
  const wasm = path.join(root, "wasm", "pdfium.wasm");
  nonempty(wasm);
  const first = Buffer.alloc(4);
  const fd = fs.openSync(wasm, "r");
  try {
    assert.equal(fs.readSync(fd, first, 0, first.length, 0), first.length);
    assert.equal(first.toString("hex"), "0061736d", "Installed PDFium WASM magic mismatch");
  } finally {
    fs.closeSync(fd);
  }
  for (const name of ["GenOffice-LICENSE", "GenOffice-NOTICE", "PDFium-LICENSE", "PDFium-LICENSE.pdfium"]) {
    nonempty(path.join(root, "licenses", name));
  }
  if (info.editorsBundled) {
    for (const name of ORIGINAL_EDITORS) {
      verifyPhysicalDirChain(root, ["apps", name, "out", "renderer", "assets"]);
    }
    verifyPackagedGenofficeEditorAssets(root);
  }
  return { bundled: true, editorsBundled: info.editorsBundled };
}
module.exports = { verifyPackagedGenofficeResources };
