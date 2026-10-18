/** ARC-007 release sidecar: all writes are confined to an isolated synthetic checkout. */
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { prepareGenofficeResources, assertWithin } = require("../../build/stage-genoffice-resources.cjs");

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
  const desktop = resolve(__dirname, "../..");
  verify("electron-builder ships staged assets outside ASAR as ordinary resources", () => {
    const yaml = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
    assert.match(yaml, /from:\s*\.tmp\/genoffice-release/);
    assert.match(yaml, /to:\s*genoffice/);
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
