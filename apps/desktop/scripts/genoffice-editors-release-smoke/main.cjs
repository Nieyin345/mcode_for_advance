"use strict";
/** ARC-007: six original GenOffice renderers are a release resource, not a CLI capability. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  prepareGenofficeResources, EDITOR_APPS, NATIVE_PRELOAD_KINDS, hashRendererTree,
} = require("../../build/stage-genoffice-resources.cjs");
const verifyAfterPack = require("../../build/verify-genoffice-editors-after-pack.cjs");

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
  // Every native kind that the runtime mounts needs an original preload
  // entry point plus the Sheets Rust sidecar; stage smoke fixtures must model
  // the same set the runtime contract requires.
  for (const name of NATIVE_PRELOAD_KINDS) {
    put(path.join(vendor, "apps", name, "out/preload/index.js"), "// original vendor preload fixture");
  }
  put(path.join(vendor, "apps/sheets/native/xlsx-engine/target/release", process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar"));
}
function renderDir(name) { return path.join(vendor, "apps", name, "out", "renderer"); }
function expectedAsset(name) {
  // Patch 0013 marker: staging rejects a Docs renderer built before the ACK
  // transport existed, so the fixture carries the same compiled names.
  const marker = name === "docs" ? "const t=window.desktop.aiToolResult;return{...(typeof t==='function'?{toolResultAck:t}:{})};" : "";
  return marker + "window.vendor = true;";
}
function makeRenderer(name) {
  put(path.join(renderDir(name), "index.html"), `<html><script type="module" src="./assets/${name}.js"></script><link rel="stylesheet" href="./assets/${name}.css"></html>`);
  put(path.join(renderDir(name), "assets", name + ".js"), expectedAsset(name));
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
  verify("CLI staging cannot follow a GenOffice node_modules junction into sibling Mcode files", () => {
    const modules = path.join(vendor, "packages/cli/dist/node_modules");
    const saved = path.join(vendor, "packages/cli/dist/.modules-for-test");
    const alien = path.join(repoRoot, "sibling-unreviewed-node-modules");
    put(path.join(alien, "unreviewed", "index.js"), "module.exports = 1;");
    fs.renameSync(modules, saved);
    try {
      fs.symlinkSync(alien, modules, process.platform === "win32" ? "junction" : "dir");
      assert.throws(
        () => prepareGenofficeResources({ appDir, repoRoot, include: true }),
        /symlink|junction|ancestor|unsafe/i,
      );
      assert.equal(fs.readFileSync(path.join(stage, "cli", "genoffice.cjs")).toString(), cliBefore.toString());
    } finally {
      fs.rmSync(modules, { recursive: true, force: true });
      fs.renameSync(saved, modules);
    }
  });
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
  put(path.join(renderDir("docs"), "assets", "deferred-vendor-chunk.js"), "imported vendor capability");
  put(path.join(renderDir("docs"), "assets", "docs-extra-font.woff2"), Buffer.from([3, 4, 5, 6]));
  verify("all six vendor original renderer trees are staged unmodified", () => {
    const r = prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true });
    assert.equal(r.editorsBundled, true);
    const marker = JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8"));
    assert.deepEqual(marker.editors, [...EDITOR_APPS]);
    assert.equal(marker.editorsBundled, true);
    assert.deepEqual(Object.keys(marker.editorAssetsSha256 || {}).sort(), [...EDITOR_APPS].sort());
    for (const name of EDITOR_APPS) {
      assert.equal(fs.readFileSync(path.join(stage, "apps", name, "out/renderer/index.html"), "utf8"),
        `<html><script type="module" src="./assets/${name}.js"></script><link rel="stylesheet" href="./assets/${name}.css"></html>`);
      assert.equal(fs.readFileSync(path.join(stage, "apps", name, "out/renderer/assets", name + ".js"), "utf8"),
        expectedAsset(name));
    }
  });
  verify("staging ships every runtime native preload, not just sheets/slides (T23 gap B)", () => {
    // Bind the expected set to the runtime contract itself: every NativeKind
    // that genofficeViewFactories mounts gets `apps/<kind>/out/preload/index.js`.
    // docs is not a NativeKind — it goes through Mcode's own
    // documentViewPreload — so it must NOT drag the standalone vendor preload in.
    const factories = fs.readFileSync(
      path.join(__dirname, "../../src/main/document/genofficeViewFactories.ts"), "utf8");
    const match = factories.match(/const kinds: readonly NativeKind\[\] = \[([^\]]+)\]/);
    assert.ok(match, "runtime NativeKind list not found in genofficeViewFactories.ts");
    const runtimeKinds = [...match[1].matchAll(/"([a-z]+)"/g)].map(m => m[1]);
    assert.deepEqual([...NATIVE_PRELOAD_KINDS].sort(), [...runtimeKinds].sort());
    const staged = fs.readdirSync(path.join(stage, "apps"))
      .filter(name => fs.existsSync(path.join(stage, "apps", name, "out", "preload", "index.js")))
      .sort();
    assert.deepEqual(staged, [...runtimeKinds].sort());
    assert.equal(fs.existsSync(path.join(stage, "apps", "docs", "out", "preload")), false);
    const marker = JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8"));
    assert.deepEqual(Object.keys(marker.editorPreloadSha256 || {}).sort(), [...runtimeKinds].sort());
  });
  verify("staging rejects a pre-0013 docs renderer instead of packaging a silent degradation (T23 gap C)", () => {
    // Rebuild the docs fixture *without* the ACK transport, as a stale
    // vendor out/ would look. Staging must fail closed and leave the
    // previous stage untouched.
    const docsAsset = path.join(renderDir("docs"), "assets", "docs.js");
    const previousStage = fs.readFileSync(path.join(stage, "availability.json"));
    fs.writeFileSync(docsAsset, "window.vendor = true;");
    try {
      assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }),
        /0013|aiToolResult|toolResultAck/i);
      assert.deepEqual(fs.readFileSync(path.join(stage, "availability.json")), previousStage);
    } finally {
      fs.writeFileSync(docsAsset, expectedAsset("docs"));
    }
  });
  verify("native renderer source cannot be swapped via an in-vendor ancestor junction", () => {
    const docsOut = path.join(vendor,"apps","docs","out");
    const savedOut = path.join(vendor,"apps","docs",".original-out-for-test");
    const htmlOut = path.join(vendor,"apps","html","out");
    const previous = fs.readFileSync(path.join(stage,"apps/docs/out/renderer/index.html"));
    fs.renameSync(docsOut,savedOut);
    try {
      fs.symlinkSync(htmlOut,docsOut,process.platform === "win32" ? "junction" : "dir");
      // Both resolved renderers are *inside* vendor, contain valid Vite
      // assets, and all nested children are safe. Yet docs is now replaced
      // with the *wrong* original editor through an ancestor junction.
      assert.throws(() => prepareGenofficeResources({appDir,repoRoot,include:true,includeEditors:true}),
        /symlink|junction|ancestor|unsafe/i);
      assert.deepEqual(fs.readFileSync(path.join(stage,"apps/docs/out/renderer/index.html")),previous);
    } finally {
      fs.rmSync(docsOut,{recursive:true,force:true});
      fs.renameSync(savedOut,docsOut);
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
  put(path.join(renderDir("html"), "assets", "html.js"), expectedAsset("html"));
  verify("Electron-builder hook actually configured", () => {
    const config = fs.readFileSync(path.join(__dirname, "../../electron-builder.yml"), "utf8");
    // T19 unified afterPack hook retains GenOffice verification and adds Node-RED.
    assert.match(config, /afterPack:\s*\.\/build\/verify-vendor-after-pack\.cjs/);
    const hook = fs.readFileSync(path.join(__dirname, "../../build/verify-vendor-after-pack.cjs"), "utf8");
    assert.match(hook, /verify-genoffice-editors-after-pack\.cjs/);
  });
  const winOut = path.join(base, "win-unpacked");
  const winResources = path.join(winOut, "resources", "genoffice");
  fs.mkdirSync(path.dirname(winResources), { recursive: true });
  fs.cpSync(stage, winResources, { recursive: true });

  verify("afterPack rejects a packaged docs renderer that lost the 0013 ACK transport", () => {
    // A package built by a staging step that predates T23 would have hashed
    // the stale docs renderer consistently, so the digest gate alone cannot
    // catch it. Simulate exactly that: strip the marker and refresh the
    // recorded digest; the 0013 marker check must still fail the package.
    const installedDir = path.join(winResources, "apps", "docs", "out", "renderer");
    const installed = path.join(installedDir, "assets", "docs.js");
    const original = fs.readFileSync(installed);
    const manifestPath = path.join(winResources, "availability.json");
    const manifest = fs.readFileSync(manifestPath);
    fs.writeFileSync(installed, "window.vendor = true;");
    const altered = JSON.parse(manifest.toString("utf8"));
    altered.editorAssetsSha256.docs = hashRendererTree(installedDir);
    fs.writeFileSync(manifestPath, JSON.stringify(altered));
    try {
      assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /0013|aiToolResult|toolResultAck/i);
    } finally {
      fs.writeFileSync(installed, original);
      fs.writeFileSync(manifestPath, manifest);
    }
  });
  verify("post-pack Windows resources contain six complete original editors", () => {
    assert.deepEqual(verifyAfterPack({ appOutDir: winOut }), {
      editorsBundled: true, editors: [...EDITOR_APPS],
    });
  });
  verify("afterPack refuses a package missing any runtime native preload, e.g. pdf (T23 gap B)", () => {
    // A stage produced by the old two-preload rule looks internally
    // consistent; the post-pack gate must still reject it because pdf's
    // vendor preload is absent from both the tree and the manifest.
    const preloadDir = path.join(winResources, "apps", "pdf", "out", "preload");
    const preloadEntry = path.join(preloadDir, "index.js");
    const originalEntry = fs.readFileSync(preloadEntry);
    const manifestPath = path.join(winResources, "availability.json");
    const manifest = fs.readFileSync(manifestPath);
    // Remove both the bytes and the manifest claim, exactly as an older
    // staging run would have left the package.
    fs.rmSync(preloadEntry);
    const altered = JSON.parse(manifest.toString("utf8"));
    delete altered.editorPreloadSha256.pdf;
    fs.writeFileSync(manifestPath, JSON.stringify(altered));
    try {
      assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /preload integrity manifest|pdf/i);
    } finally {
      put(preloadEntry, originalEntry);
      fs.writeFileSync(manifestPath, manifest);
    }
  });
  verify("afterPack refuses six-editor manifest when original CLI entry is missing", () => {
    const file = path.join(winResources, "cli", "genoffice.cjs");
    const original = fs.readFileSync(file);
    fs.rmSync(file);
    try { assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /CLI|genoffice\.cjs|missing/i); }
    finally { put(file, original); }
  });
  verify("afterPack refuses six-editor manifest with invalid PDFium WASM", () => {
    const file = path.join(winResources, "wasm", "pdfium.wasm");
    const original = fs.readFileSync(file);
    put(file, Buffer.alloc(original.length));
    try { assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /WASM|PDFium|invalid/i); }
    finally { put(file, original); }
  });
  verify("afterPack refuses missing GenOffice NOTICE in native install", () => {
    const file = path.join(winResources, "licenses", "GenOffice-NOTICE");
    const original = fs.readFileSync(file);
    fs.rmSync(file);
    try { assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /NOTICE|license|missing/i); }
    finally { put(file, original); }
  });
  verify("afterPack also rejects an in-resource apps ancestor junction", () => {
    const apps = path.join(winResources, "apps");
    const realApps = path.join(winResources, "apps-real");
    fs.renameSync(apps, realApps);
    fs.symlinkSync(realApps, apps, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /symlink|junction|linked|unsafe|ancestor/i);
    } finally {
      fs.rmSync(apps, { recursive: true, force: true });
      fs.renameSync(realApps, apps);
    }
  });
  verify("packager dropping one script fails release rather than delivering a white tab", () => {
    const script = path.join(winResources, "apps", "slides", "out", "renderer", "assets", "slides.js");
    fs.rmSync(script);
    assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /slides|missing|asset/i);
    put(script, expectedAsset("slides"));
  });
  verify("post-pack rejects a missing deferred JS chunk not listed in index.html", () => {
    const file = path.join(winResources, "apps", "docs", "out", "renderer", "assets", "deferred-vendor-chunk.js");
    const original = fs.readFileSync(file);
    fs.rmSync(file);
    assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /docs|integrity|digest|missing/i);
    put(file, original);
  });
  verify("post-pack rejects same-size edits to vendor JS or fonts", () => {
    for (const file of [
      path.join(winResources, "apps", "docs", "out", "renderer", "assets", "deferred-vendor-chunk.js"),
      path.join(winResources, "apps", "docs", "out", "renderer", "assets", "docs-extra-font.woff2"),
    ]) {
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.alloc(original.length, 42));
      assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /docs|integrity|digest/i);
      put(file, original);
    }
  });
  verify("post-pack cannot accept opt-in marker with no editor file integrity proof", () => {
    const manifest = path.join(winResources, "availability.json");
    const original = fs.readFileSync(manifest);
    const altered = JSON.parse(original.toString("utf8"));
    delete altered.editorAssetsSha256;
    fs.writeFileSync(manifest, JSON.stringify(altered));
    assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /integrity|hash|digest/i);
    put(manifest, original);
  });
  verify("post-pack marker cannot claim six editor UIs when only five are listed", () => {
    const manifest = path.join(winResources, "availability.json");
    const correct = fs.readFileSync(manifest, "utf8");
    fs.writeFileSync(manifest, JSON.stringify({
      format: "mcode.genoffice.resources.v1", bundled: true,
      editorsBundled: true, editors: EDITOR_APPS.slice(0, 5),
    }));
    assert.throws(() => verifyAfterPack({ appOutDir: winOut }), /six|manifest/i);
    fs.writeFileSync(manifest, correct);
  });
  verify("macOS .app/Contents/Resources path uses the same vendor asset verifier", () => {
    const macOut = path.join(base, "mac-arm64");
    const appResources = path.join(macOut, "Mcode.app", "Contents", "Resources", "genoffice");
    fs.mkdirSync(path.dirname(appResources), { recursive: true });
    fs.cpSync(stage, appResources, { recursive: true });
    assert.equal(verifyAfterPack({ appOutDir: macOut }).editorsBundled, true);
  });
  verify("opt-out removes all previous editor assets and marks unavailable", () => {
    const r = prepareGenofficeResources({ appDir, repoRoot, include: false });
    assert.equal(r.bundled, false);
    assert.equal(r.editorsBundled, false);
    assert.equal(fs.existsSync(path.join(stage, "apps")), false);
    assert.equal(fs.existsSync(path.join(stage, "cli")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8")).editors, []);
  });
  verify("post-pack CLI-only marker with no apps remains a valid fallback", () => {
    const cliOnly = path.join(base, "linux-unpacked");
    const resources = path.join(cliOnly, "resources", "genoffice");
    fs.mkdirSync(path.dirname(resources), { recursive: true });
    fs.cpSync(stage, resources, { recursive: true });
    assert.deepEqual(verifyAfterPack({ appOutDir: cliOnly }), { editorsBundled: false });
    fs.mkdirSync(path.join(resources, "apps"));
    assert.throws(() => verifyAfterPack({ appOutDir: cliOnly }), /unexpected|assets/i);
  });
  verify("afterPack opt-out cannot retain stale CLI from previous release", () => {
    const out = path.join(base, "no-vendor-unpacked");
    const resources = path.join(out, "resources", "genoffice");
    fs.mkdirSync(path.dirname(resources), { recursive: true });
    fs.cpSync(stage, resources, { recursive: true });
    put(path.join(resources, "cli", "genoffice.cjs"), "stale");
    assert.throws(() => verifyAfterPack({ appOutDir: out }), /unexpected|native|opt-out/i);
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
