/** ARC-007 release sidecar: all writes are confined to an isolated synthetic checkout. */
const assert = require("node:assert/strict");
const { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { prepareGenofficeResources, assertWithin, hashRendererTree } = require("../../build/stage-genoffice-resources.cjs");
const { verifyPackagedGenofficeResources } = require("./check-genoffice-resources.cjs");

const root = mkdtempSync(join(tmpdir(), "mcode-go-release-test-"));
let checks = 0;
const put = (p, data) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p, data); };
const verify = (name, fn) => { fn(); checks++; console.log("ok " + name); };
const fixture = (tag) => {
  const repoRoot = join(root, tag);
  const appDir = join(repoRoot, "apps", "desktop");
  mkdirSync(appDir, { recursive: true });
  return { repoRoot, appDir, target: join(appDir, ".tmp", "genoffice-release") };
};
const seed = (repoRoot) => {
  const vendor = join(repoRoot, "genoffice");
  put(join(vendor, "packages", "cli", "dist", "genoffice.cjs"), "console.log('fake')\n");
  put(join(vendor, "packages", "cli", "dist", "node_modules", "fixture", "package.json"), '{"name":"fixture"}');
  put(join(vendor, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  put(join(vendor, "LICENSE"), "APACHE-LICENSE-FIXTURE");
  put(join(vendor, "NOTICE"), "THIRD-PARTY-NOTICE-FIXTURE");
  put(join(vendor, "node_modules", "@embedpdf", "pdfium", "LICENSE"), "PDFIUM-WRAPPER-LICENSE");
  put(join(vendor, "node_modules", "@embedpdf", "pdfium", "LICENSE.pdfium"), "PDFIUM-LICENSE");
};
try {
  if (process.platform === "win32") {
    verify("Windows cross-drive relative path is never inside a vendor root", () => {
      assert.throws(() => assertWithin("C:\\fake-vendor", "D:\\private-secret"), /escapes|root/i);
      assert.doesNotThrow(() => assertWithin("C:\\fake-vendor", "C:\\fake-vendor\\cli\\file.cjs"));
    });
  }
  const f = fixture("no-vendor");
  verify("without opt-in build succeeds but never ships a CLI", () => {
    const result = prepareGenofficeResources({ repoRoot: f.repoRoot, appDir: f.appDir, include: false });
    assert.equal(result.bundled, false);
    assert.equal(existsSync(join(f.target, "cli", "genoffice.cjs")), false);
  });
  verify("explicit opt-in with missing vendor fails closed", () => {
    assert.throws(() => prepareGenofficeResources({ repoRoot: f.repoRoot, appDir: f.appDir, include: true }), /GenOffice|missing|缺失/i);
    assert.equal(existsSync(join(f.target, "cli", "genoffice.cjs")), false);
  });
  const escaped = fixture("escaped");
  seed(escaped.repoRoot);
  const privateDir = join(root, "outside-private-directory");
  put(join(privateDir, "private.txt"), "PRIVATE FIXTURE BYTES");
  symlinkSync(privateDir, join(escaped.repoRoot, "genoffice", "packages", "cli", "dist", "node_modules", "unauthorized-link"),
    process.platform === "win32" ? "junction" : "dir");
  verify("nested vendor symlink cannot copy private directory into installer", () => {
    assert.throws(() => prepareGenofficeResources({ repoRoot: escaped.repoRoot, appDir: escaped.appDir, include: true }),
      /outside|escapes|symlink|unsafe|root/i);
    assert.equal(existsSync(join(escaped.target, "cli", "node_modules", "unauthorized-link", "private.txt")), false);
  });
  const ok = fixture("complete");
  seed(ok.repoRoot);
  verify("approved fixture contains CLI, runtime dependencies, WASM and licenses", () => {
    const result = prepareGenofficeResources({ repoRoot: ok.repoRoot, appDir: ok.appDir, include: true });
    assert.equal(result.bundled, true);
    assert.equal(readFileSync(join(ok.target, "cli", "genoffice.cjs"), "utf8"), "console.log('fake')\n");
    assert.equal(existsSync(join(ok.target, "cli", "node_modules", "fixture", "package.json")), true);
    assert.equal(readFileSync(join(ok.target, "wasm", "pdfium.wasm")).subarray(0,4).toString("hex"), "0061736d");
    assert.equal(existsSync(join(ok.target, "licenses", "GenOffice-LICENSE")), true);
    assert.equal(existsSync(join(ok.target, "licenses", "PDFium-LICENSE")), true);
  });
  const packageRoot = join(root, "fake-unpacked");
  const installedResource = join(packageRoot, "resources", "genoffice");
  mkdirSync(join(packageRoot, "resources"), { recursive: true });
  cpSync(ok.target, installedResource, { recursive: true });
  const installedMarker = join(installedResource, "availability.json");
  // The real staging pass now emits native CLI/dependency/WASM digests (T76)
  // and the post-0013 Docs ACK markers (T23). Synthetic markers in this suite
  // must extend that staged manifest instead of re-declaring a partial one:
  // a bundled package whose marker drops those fields is exactly what the
  // afterPack gate is supposed to reject, not a valid release fixture.
  const stagedMarker = JSON.parse(readFileSync(installedMarker, "utf8"));
  const markerWith = (patch) => JSON.stringify({ ...stagedMarker, ...patch });
  verify("post-pack gate verifies CLI, dependency tree, WASM and license resources", () => {
    assert.deepEqual(verifyPackagedGenofficeResources(packageRoot), { bundled: true, editorsBundled: false });
  });
  verify("installed CLI junction is rejected", () => {
    const cliDir = join(installedResource, "cli");
    const saved = join(root, "saved-cli");
    renameSync(cliDir, saved);
    symlinkSync(saved, cliDir, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(() => verifyPackagedGenofficeResources(packageRoot));
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
      renameSync(saved, cliDir);
    }
  });
  const editorNames = ["docs", "sheets", "slides", "pdf", "markdown", "html"];
  verify("declared editors cannot pass post-pack check when files are missing", () => {
    put(installedMarker, markerWith({
      editorsBundled: true, editors: editorNames,
    }));
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /docs|editor|renderer|missing/i);
  });
  for (const name of editorNames) {
    const dir = join(installedResource, "apps", name, "out", "renderer");
    put(join(dir, "index.html"), '<html><head><link rel="stylesheet" href="./assets/app.css"></head><body><script type="module" src="./assets/app.js"></script></body></html>');
    put(join(dir, "assets", "app.css"), "html { color: black; }");
    // Docs renderers must carry the patch-0013 ACK transport names the
    // afterPack gate scans for (T23); the other five need no marker.
    put(join(dir, "assets", "app.js"),
      name === "docs" ? "window.desktop.aiToolResult(toolResultAck);" : "console.log('fixture');");
  }
  const lazyAsset = join(installedResource, "apps", "docs", "out", "renderer", "assets", "deferred.js");
  put(lazyAsset, "original vendor lazy chunk");
  put(installedMarker, markerWith({
    editorsBundled: true, editors: editorNames,
    editorAssetsSha256: Object.fromEntries(editorNames.map(name => [
      name, hashRendererTree(join(installedResource, "apps", name, "out", "renderer")),
    ])),
  }));
  verify("all six copied vendor editors pass post-pack resource gate", () => {
    assert.deepEqual(verifyPackagedGenofficeResources(packageRoot), { bundled: true, editorsBundled: true });
  });
  verify("docs renderer without the patch-0013 ACK transport is rejected even with a matching digest", () => {
    const docsJs = join(installedResource, "apps", "docs", "out", "renderer", "assets", "app.js");
    const savedJs = readFileSync(docsJs);
    put(docsJs, "console.log('pre-0013 docs build');");
    try {
      // Re-stamp the digest so only the ACK-marker gate can reject this:
      // a stale-but-self-consistent docs build must still fail closed (T23).
      put(installedMarker, markerWith({
        editorsBundled: true, editors: editorNames,
        editorAssetsSha256: Object.fromEntries(editorNames.map(name => [
          name, hashRendererTree(join(installedResource, "apps", name, "out", "renderer")),
        ])),
      }));
      assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /0013|aiToolResult|toolResultAck/i);
    } finally {
      put(docsJs, savedJs);
      put(installedMarker, markerWith({
        editorsBundled: true, editors: editorNames,
        editorAssetsSha256: Object.fromEntries(editorNames.map(name => [
          name, hashRendererTree(join(installedResource, "apps", name, "out", "renderer")),
        ])),
      }));
    }
  });
  verify("unlisted deferred vendor JS cannot change while post-pack gate stays green", () => {
    const before = readFileSync(lazyAsset);
    put(lazyAsset, "tampered! vendor lazy chunk");
    try {
      assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /digest|integrity|changed|docs/i);
    } finally {
      put(lazyAsset, before);
    }
  });
  verify("packaged six editors cannot be supplied through a linked apps ancestor", () => {
    const apps = join(installedResource, "apps");
    const external = join(root, "external-vendor-apps");
    renameSync(apps, external);
    symlinkSync(external, apps, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /link|symlink|junction|ancestor|directory|unsafe/i);
    } finally {
      rmSync(apps, { recursive: true, force: true });
      renameSync(external, apps);
    }
  });
  verify("packaged editor cannot be supplied through an intermediate out junction", () => {
    const out = join(installedResource, "apps", "docs", "out");
    const external = join(root, "external-docs-out");
    renameSync(out, external);
    symlinkSync(external, out, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /link|symlink|junction|ancestor|directory|unsafe/i);
    } finally {
      rmSync(out, { recursive: true, force: true });
      renameSync(external, out);
    }
  });
  verify("missing asset from just one editor fails the entire package", () => {
    const asset = join(installedResource, "apps", "slides", "out", "renderer", "assets", "app.js");
    rmSync(asset);
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /slides|app\.js|missing/i);
    put(asset, "console.log('restored');");
  });
  verify("inconsistent editorsBundled false cannot hide stale vendor assets", () => {
    put(installedMarker, markerWith({ editorsBundled: false, editors: [] }));
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /stale|editor|apps/i);
  });
  verify("editor list cannot pretend a subset is the full six", () => {
    put(installedMarker, markerWith({ editorsBundled: true, editors: ["docs"] }));
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /six|editor|complete|list/i);
  });
  // Restore CLI-only fixture before subsequent checks.
  rmSync(join(installedResource, "apps"), { recursive: true, force: true });
  put(installedMarker, markerWith({ editorsBundled: false, editors: [] }));
  verify("post-pack gate fails closed if packaged WASM disappears", () => {
    rmSync(join(installedResource, "wasm", "pdfium.wasm"));
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /WASM|pdfium|missing/i);
  });
  verify("incomplete new vendor cannot replace previous valid staged bytes", () => {
    const cli = join(ok.target, "cli", "genoffice.cjs");
    const before = readFileSync(cli);
    rmSync(join(ok.repoRoot, "genoffice", "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"));
    assert.throws(() => prepareGenofficeResources({ repoRoot: ok.repoRoot, appDir: ok.appDir, include: true }), /WASM|GenOffice|缺失/i);
    assert.deepEqual(readFileSync(cli), before);
  });
  verify("opt-out after previous opt-in removes old staged CLI and WASM", () => {
    const result = prepareGenofficeResources({ repoRoot: ok.repoRoot, appDir: ok.appDir, include: false });
    assert.equal(result.bundled, false);
    assert.equal(existsSync(join(ok.target, "cli", "genoffice.cjs")), false);
    assert.equal(existsSync(join(ok.target, "wasm", "pdfium.wasm")), false);
  });
  verify("unbundled packaged resource marker rejects stale CLI payload", () => {
    rmSync(installedResource, { recursive: true, force: true });
    cpSync(ok.target, installedResource, { recursive: true });
    assert.deepEqual(verifyPackagedGenofficeResources(packageRoot), { bundled: false, editorsBundled: false });
    put(join(installedResource, "cli", "genoffice.cjs"), "stale");
    assert.throws(() => verifyPackagedGenofficeResources(packageRoot), /stale|unbundled|absent/i);
  });
  const desktop = resolve(__dirname, "../..");
  verify("electron-builder ships staged assets outside ASAR as ordinary resources", () => {
    const yaml = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
    assert.match(yaml, /from:\s*\.tmp\/genoffice-release/);
    assert.match(yaml, /to:\s*genoffice/);
  });
  verify("post-pack Windows gate invokes the actual sidecar resource verifier", () => {
    const gate = readFileSync(join(desktop, "scripts", "release-readiness-smoke", "check-unpacked.cjs"), "utf8");
    assert.ok(gate.includes("verifyPackagedGenofficeResources("), "Windows post-pack gate omitted GenOffice resources");
  });
  verify("package pipeline prepares resource staging before electron-builder", () => {
    const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
    const script = pkg.scripts.package;
    assert.ok(script.indexOf("stage-genoffice-resources.cjs") >= 0);
    assert.ok(script.indexOf("stage-genoffice-resources.cjs") < script.indexOf("electron-builder"));
  });
  console.log("genoffice-release-smoke: " + checks + "/" + checks + " PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
