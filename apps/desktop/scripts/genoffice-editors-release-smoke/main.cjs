"use strict";
/** ARC-007: six original GenOffice renderers are a release resource, not a CLI capability. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareGenofficeResources, EDITOR_APPS } = require("../../build/stage-genoffice-resources.cjs");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-original-office-test-"));
const repoRoot = path.join(base, "repo");
const appDir = path.join(repoRoot, "apps", "desktop");
const vendor = path.join(repoRoot, "genoffice");
const stage = path.join(appDir, ".tmp", "genoffice-release");
let total = 0;
function put(file, bytes = "fixture") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function verify(label, fn) { fn(); total++; console.log("  ok  " + label); }
function createCli() {
  put(path.join(vendor, "packages/cli/dist/genoffice.cjs"));
  put(path.join(vendor, "packages/cli/dist/node_modules/mock/index.js"));
  put(path.join(vendor, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  for (const name of ["LICENSE", "NOTICE"]) put(path.join(vendor, name));
  for (const name of ["LICENSE", "LICENSE.pdfium"]) {
    put(path.join(vendor, "node_modules/@embedpdf/pdfium", name));
  }
}
function renderDir(name) { return path.join(vendor, "apps", name, "out", "renderer"); }
function makeRenderer(name) {
  put(path.join(renderDir(name), "index.html"), `<html><script type="module" src="./assets/${name}.js"></script><link rel="stylesheet" href="./assets/${name}.css"></html>`);
  put(path.join(renderDir(name), "assets", name + ".js"), "window.vendor = true;");
  put(path.join(renderDir(name), "assets", name + ".css"), ".vendor{}");
}
try {
  fs.mkdirSync(appDir, { recursive: true });
  createCli();
  verify("default opt-in remains the old CLI-only mode", () => {
    const r = prepareGenofficeResources({ appDir, repoRoot, include: true });
    assert.equal(r.bundled, true);
    assert.equal(r.editorsBundled, false);
    assert.equal(fs.existsSync(path.join(stage, "apps")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, "availability.json"))).editors, []);
  });
  const cliBefore = fs.readFileSync(path.join(stage, "cli", "genoffice.cjs"));
  verify("editor opt-in cannot bypass explicit CLI bundle inclusion", () => {
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, includeEditors: true }),
      /require|CLI/i);
    assert.deepEqual(fs.readFileSync(path.join(stage, "cli", "genoffice.cjs")), cliBefore);
  });
  verify("missing vendor editor assets reject without overwriting previous CLI stage", () => {
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }),
      /renderer|missing/i);
    assert.deepEqual(fs.readFileSync(path.join(stage, "cli", "genoffice.cjs")), cliBefore);
    assert.equal(fs.existsSync(path.join(stage, "apps")), false);
  });
  for (const name of EDITOR_APPS.slice(0, -1)) makeRenderer(name);
  verify("five-out-of-six original apps are not a 'full Office' build", () => {
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }),
      /html|renderer|missing/i);
    assert.deepEqual(fs.readFileSync(path.join(stage, "cli", "genoffice.cjs")), cliBefore);
  });
  makeRenderer("html");
  verify("all six vendor original renderer trees are staged unmodified", () => {
    const r = prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true });
    assert.equal(r.editorsBundled, true);
    const marker = JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8"));
    assert.deepEqual(marker.editors, [...EDITOR_APPS]);
    assert.equal(marker.editorsBundled, true);
    for (const name of EDITOR_APPS) {
      assert.equal(fs.readFileSync(path.join(stage, "apps", name, "out/renderer/index.html"), "utf8"),
        `<html><script type="module" src="./assets/${name}.js"></script><link rel="stylesheet" href="./assets/${name}.css"></html>`);
      assert.equal(fs.readFileSync(path.join(stage, "apps", name, "out/renderer/assets", name + ".js"), "utf8"),
        "window.vendor = true;");
    }
  });
  verify("renamed/corrupt index fails before any existing vendor renderer stage changes", () => {
    const previously = fs.readFileSync(path.join(stage, "apps/docs/out/renderer/index.html"));
    fs.renameSync(path.join(renderDir("html"), "index.html"), path.join(renderDir("html"), "renamed.html"));
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }),
      /index|missing/i);
    assert.deepEqual(fs.readFileSync(path.join(stage, "apps/docs/out/renderer/index.html")), previously);
  });
  makeRenderer("html");
  verify("stale Vite index referencing a missing JS asset cannot replace previous release stage", () => {
    const previously = fs.readFileSync(path.join(stage, "apps/docs/out/renderer/index.html"));
    fs.rmSync(path.join(renderDir("html"), "assets", "html.js"));
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }),
      /missing.*asset|asset.*missing/i);
    assert.deepEqual(fs.readFileSync(path.join(stage, "apps/docs/out/renderer/index.html")), previously);
  });
  put(path.join(renderDir("html"), "assets", "html.js"), "window.vendor = true;");
  verify("opt-out removes all previous editor assets and marks unavailable", () => {
    const r = prepareGenofficeResources({ appDir, repoRoot, include: false });
    assert.equal(r.bundled, false);
    assert.equal(r.editorsBundled, false);
    assert.equal(fs.existsSync(path.join(stage, "apps")), false);
    assert.equal(fs.existsSync(path.join(stage, "cli")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8")).editors, []);
  });
  verify("validates boolean options rather than treating untrusted strings as yes", () => {
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: "true" }),
      /boolean/i);
    assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: "true" }),
      /boolean/i);
  });
  console.log("genoffice-editors-release-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
