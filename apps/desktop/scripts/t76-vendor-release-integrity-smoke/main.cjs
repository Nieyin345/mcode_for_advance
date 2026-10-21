"use strict";
/** T76: isolated GenOffice/Node-RED release resource and license integrity smoke. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  prepareGenofficeResources, EDITOR_APPS,
} = require("../../build/stage-genoffice-resources.cjs");
const {
  hashFile, hashTree, createNodeRedLicenseInventory, writeNodeRedLicenseInventory, BASE_COMMIT, VERSION,
} = require("../../build/stage-node-red-resources.cjs");
const verifyGenoffice = require("../../build/verify-genoffice-editors-after-pack.cjs");
const verifyNodeRed = require("../../build/verify-node-red-after-pack.cjs");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t76-vendor-release-"));
let total = 0;
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content === undefined ? "fixture" : content);
}
function verify(label, fn) {
  fn();
  total++;
  console.log("  ok  " + label);
}
function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
function hashManifest(root) {
  const inventory = writeNodeRedLicenseInventory(root);
  const lock = path.join(root, "package-lock.json");
  const license = path.join(root, "LICENSE");
  const pkg = path.join(root, "packages", "node_modules", "node-red", "package.json");
  const editor = path.join(root, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js");
  put(path.join(root, "manifest.json"), JSON.stringify({
    format: "mcode.node-red.release.v1",
    version: VERSION,
    sourceCommit: BASE_COMMIT,
    editorSha256: hashFile(editor),
    packageSha256: hashFile(pkg),
    lockSha256: hashFile(lock),
    licenseSha256: hashFile(license),
    licenseInventorySha256: inventory.sha256,
    packageTreeSha256: hashTree(path.join(root, "packages"), "mcode.node-red.packages.tree.v1"),
    dependenciesTreeSha256: hashTree(path.join(root, "node_modules"), "mcode.node-red.dependencies.tree.v1"),
  }, null, 2) + "\n");
  return inventory.inventory;
}
function makeNodeRedPackage(root, rel, name, version, license, licenseText = true) {
  const dir = path.join(root, ...rel.split("/"));
  put(path.join(dir, "package.json"), JSON.stringify({ name, version, ...(license ? { license } : {}) }, null, 2));
  if (licenseText) put(path.join(dir, "LICENSE"), "License text for " + name + " (" + version + ").\n");
  return dir;
}
function makeNodeRedFixture(root, { pause = false, missingExpressLicense = false } = {}) {
  fs.mkdirSync(root, { recursive: true });
  put(path.join(root, "LICENSE"), "Node-RED Apache-2.0 license fixture.\n");
  const lockPackages = {
    "": { name: "node-red", version: VERSION },
    "node_modules/express": { name: "express", version: "4.0.0", license: "MIT" },
  };
  makeNodeRedPackage(root, "node_modules/express", "express", "4.0.0", "MIT", !missingExpressLicense);
  if (pause) {
    lockPackages["node_modules/pause"] = { name: "pause", version: "0.0.1", resolved: "https://registry.invalid/pause-0.0.1.tgz" };
    makeNodeRedPackage(root, "node_modules/pause", "pause", "0.0.1", null, false);
  }
  put(path.join(root, "package-lock.json"), JSON.stringify({
    name: "node-red", version: VERSION, lockfileVersion: 3, packages: lockPackages,
  }, null, 2) + "\n");
  makeNodeRedPackage(root, "packages/node_modules/node-red", "node-red", VERSION, "Apache-2.0");
  makeNodeRedPackage(root, "packages/node_modules/@node-red/editor-client", "@node-red/editor-client", VERSION, "Apache-2.0");
  makeNodeRedPackage(root, "packages/node_modules/@node-red/runtime", "@node-red/runtime", VERSION, "Apache-2.0");
  makeNodeRedPackage(root, "packages/node_modules/@node-red/editor-api", "@node-red/editor-api", VERSION, "Apache-2.0");
  put(path.join(root, "node_modules/express/index.js"), "module.exports = 'express fixture';\n");
  put(path.join(root, "packages/node_modules/@node-red/runtime/index.js"), "module.exports = 'runtime fixture';\n");
  put(path.join(root, "packages/node_modules/@node-red/editor-client/public/red/red.min.js"), "window.nodeRedEditor = true;\n");
  return hashManifest(root);
}

try {
  const repoRoot = path.join(base, "genoffice-repo");
  const appDir = path.join(repoRoot, "apps", "desktop");
  const vendor = path.join(repoRoot, "genoffice");
  const stage = path.join(appDir, ".tmp", "genoffice-release");
  const sidecarName = process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  const sourceSidecar = path.join(vendor, "apps", "sheets", "native", "xlsx-engine", "target", "release", sidecarName);

  put(path.join(vendor, "packages/cli/dist/genoffice.cjs"), "module.exports = 'fixture';\n");
  put(path.join(vendor, "packages/cli/dist/node_modules/mock/index.js"), "module.exports = true;\n");
  put(path.join(vendor, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  for (const file of ["LICENSE", "NOTICE"]) put(path.join(vendor, file), "GenOffice fixture " + file + "\n");
  put(path.join(vendor, "node_modules/@embedpdf/pdfium/LICENSE"), "PDFium fixture license\n");
  put(path.join(vendor, "node_modules/@embedpdf/pdfium/LICENSE.pdfium"), "PDFium upstream fixture license\n");
  for (const name of ["sheets", "slides"]) {
    put(path.join(vendor, "apps", name, "out/preload/index.js"), "// original preload fixture for " + name + "\n");
  }
  put(sourceSidecar, "native xlsx sidecar fixture\n");
  for (const name of EDITOR_APPS) {
    const renderer = path.join(vendor, "apps", name, "out", "renderer");
    put(path.join(renderer, "index.html"),
      "<html><script type=\"module\" src=\"./assets/" + name + ".js\"></script>" +
      "<link rel=\"stylesheet\" href=\"./assets/" + name + ".css\"></html>");
    put(path.join(renderer, "assets", name + ".js"), "window.vendor = '" + name + "';\n");
    put(path.join(renderer, "assets", name + ".css"), "." + name + "{}\n");
  }
  fs.mkdirSync(appDir, { recursive: true });

  verify("staging records full renderer, native preload, and xlsx-sidecar digests", () => {
    const result = prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true });
    assert.equal(result.editorsBundled, true);
    const marker = JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8"));
    assert.deepEqual(Object.keys(marker.editorAssetsSha256).sort(), [...EDITOR_APPS].sort());
    assert.deepEqual(Object.keys(marker.editorPreloadSha256).sort(), ["sheets", "slides"]);
    assert.equal(marker.nativeSidecar, sidecarName);
    assert.match(marker.nativeSidecarSha256, /^[0-9a-f]{64}$/);
  });

  const out = path.join(base, "genoffice-win-unpacked");
  const resources = path.join(out, "resources", "genoffice");
  fs.mkdirSync(path.dirname(resources), { recursive: true });
  fs.cpSync(stage, resources, { recursive: true });

  verify("afterPack accepts six renderers plus intact Sheets/Slides preloads and sidecar", () => {
    const result = verifyGenoffice({ appOutDir: out });
    assert.deepEqual(result, { editorsBundled: true, editors: [...EDITOR_APPS] });
  });

  verify("afterPack rejects same-size GenOffice CLI and dependency-tree tampering", () => {
    const cli = path.join(resources, "cli", "genoffice.cjs");
    const originalCli = fs.readFileSync(cli);
    fs.writeFileSync(cli, Buffer.alloc(originalCli.length, 0x58));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /packaged CLI digest mismatch/i);
    put(cli, originalCli);
    const dep = path.join(resources, "cli", "node_modules", "mock", "index.js");
    const originalDep = fs.readFileSync(dep);
    fs.writeFileSync(dep, Buffer.alloc(originalDep.length, 0x59));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /CLI dependency tree digest mismatch/i);
    put(dep, originalDep);
    assert.deepEqual(verifyGenoffice({ appOutDir: out }).editors, [...EDITOR_APPS]);
  });

  verify("afterPack rejects same-size PDFium WASM and GenOffice license tampering", () => {
    const wasm = path.join(resources, "wasm", "pdfium.wasm");
    const originalWasm = fs.readFileSync(wasm);
    fs.writeFileSync(wasm, Buffer.from([0, 97, 115, 109, 2, 0, 0, 0]));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /PDFium WASM digest mismatch/i);
    put(wasm, originalWasm);
    const license = path.join(resources, "licenses", "GenOffice-LICENSE");
    const originalLicense = fs.readFileSync(license);
    fs.writeFileSync(license, Buffer.alloc(originalLicense.length, 0x58));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /license resource digest mismatch/i);
    put(license, originalLicense);
    assert.deepEqual(verifyGenoffice({ appOutDir: out }).editors, [...EDITOR_APPS]);
  });

  verify("afterPack rejects a missing xlsx-sidecar and accepts the restored original", () => {
    const file = path.join(resources, "native", sidecarName);
    const original = fs.readFileSync(file);
    fs.rmSync(file);
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /xlsx-sidecar.*missing/i);
    put(file, original);
    assert.deepEqual(verifyGenoffice({ appOutDir: out }).editors, [...EDITOR_APPS]);
  });

  verify("afterPack rejects same-size xlsx-sidecar tampering", () => {
    const file = path.join(resources, "native", sidecarName);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x42));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /sidecar digest mismatch/i);
    put(file, original);
    assert.deepEqual(verifyGenoffice({ appOutDir: out }).editors, [...EDITOR_APPS]);
  });

  verify("afterPack rejects missing native preload entry and same-size preload tampering", () => {
    const file = path.join(resources, "apps", "sheets", "out", "preload", "index.js");
    const original = fs.readFileSync(file);
    fs.rmSync(file);
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /preload entry missing|Missing GenOffice editor directory/i);
    put(file, original);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x41));
    assert.throws(() => verifyGenoffice({ appOutDir: out }), /preload integrity digest mismatch/i);
    put(file, original);
    assert.deepEqual(verifyGenoffice({ appOutDir: out }).editors, [...EDITOR_APPS]);
  });

  verify("a missing source sidecar fails staging before replacing the previous complete stage", () => {
    const markerBefore = fs.readFileSync(path.join(stage, "availability.json"));
    const stagedSidecar = fs.readFileSync(path.join(stage, "native", sidecarName));
    const saved = sourceSidecar + ".t76-saved";
    fs.renameSync(sourceSidecar, saved);
    try {
      assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }), /missing|sidecar/i);
      assert.deepEqual(fs.readFileSync(path.join(stage, "availability.json")), markerBefore);
      assert.deepEqual(fs.readFileSync(path.join(stage, "native", sidecarName)), stagedSidecar);
    } finally {
      fs.renameSync(saved, sourceSidecar);
    }
  });

  verify("a non-regular/unreadable PDFium resource fails staging without replacing the previous stage", () => {
    const wasm = path.join(vendor, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm");
    const markerBefore = fs.readFileSync(path.join(stage, "availability.json"));
    const stagedSidecar = fs.readFileSync(path.join(stage, "native", sidecarName));
    const saved = wasm + ".t76-saved";
    fs.renameSync(wasm, saved);
    try {
      fs.mkdirSync(wasm);
      assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }), /PDFium WASM|regular file|invalid/i);
      assert.deepEqual(fs.readFileSync(path.join(stage, "availability.json")), markerBefore);
      assert.deepEqual(fs.readFileSync(path.join(stage, "native", sidecarName)), stagedSidecar);
    } finally {
      fs.rmSync(wasm, { recursive: true, force: true });
      fs.renameSync(saved, wasm);
    }
  });

  verify("a preload ancestor junction to an unreviewed sibling is rejected before staging", () => {
    const preload = path.join(vendor, "apps", "slides", "out", "preload");
    const saved = path.join(vendor, "apps", "slides", "out", ".preload-for-t76");
    const outside = path.join(repoRoot, "unreviewed-preload");
    put(path.join(outside, "index.js"), "// outside the vendor checkout\n");
    fs.renameSync(preload, saved);
    try {
      fs.symlinkSync(outside, preload, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true }), /symlink|junction|ancestor|unsafe/i);
      assert.deepEqual(fs.readFileSync(path.join(stage, "availability.json")), fs.readFileSync(path.join(resources, "availability.json")));
    } finally {
      fs.rmSync(preload, { recursive: true, force: true });
      fs.renameSync(saved, preload);
    }
  });

  verify("CLI-only opt-out removes native sidecar and preload resources", () => {
    const result = prepareGenofficeResources({ appDir, repoRoot, include: false });
    assert.equal(result.editorsBundled, false);
    assert.equal(fs.existsSync(path.join(stage, "native")), false);
    assert.equal(fs.existsSync(path.join(stage, "apps")), false);
    const fallback = path.join(base, "genoffice-cli-only");
    const fallbackResources = path.join(fallback, "resources", "genoffice");
    fs.mkdirSync(path.dirname(fallbackResources), { recursive: true });
    fs.cpSync(stage, fallbackResources, { recursive: true });
    assert.deepEqual(verifyGenoffice({ appOutDir: fallback }), { editorsBundled: false });
  });

  const strictAppDir = path.join(repoRoot, "strict-app");
  const strictStage = path.join(strictAppDir, ".tmp", "genoffice-release");
  const strictOut = path.join(base, "genoffice-strict-unpacked");
  const strictResources = path.join(strictOut, "resources", "genoffice");
  const separator = "-".repeat(72);
  const thirdPartyNotice = [
    "@embedpdf/pdfium",
    "Copyright 2014 PDFium Authors",
    "Apache License",
    separator,
    "example-package v1.0.0 — MIT",
    separator,
    "MIT License",
    "Copyright Example Contributors",
    "Permission is hereby granted, free of charge, to any person obtaining a copy.",
    "",
  ].join("\n");
  put(path.join(vendor, "apps/shell/build/THIRD-PARTY-NOTICES.txt"), thirdPartyNotice);
  put(path.join(strictAppDir, "package.json"), JSON.stringify({ name: "strict-license-fixture", private: true }));
  put(path.join(strictAppDir, "node_modules/electron/package.json"), JSON.stringify({ name: "electron", version: "40.0.0" }));
  put(path.join(strictAppDir, "node_modules/electron/dist/LICENSES.chromium.html"), "Chromium license fixture 40.0.0\n");
  prepareGenofficeResources({ appDir: strictAppDir, repoRoot, include: true, includeEditors: true, requireCompleteLicenseBundle: true });
  fs.mkdirSync(path.dirname(strictResources), { recursive: true });
  fs.cpSync(strictStage, strictResources, { recursive: true });

  verify("strict GenOffice release accepts the complete six-file license bundle", () => {
    withEnv({ MCODE_INCLUDE_GENOFFICE_BUNDLE: "1" }, () => {
      const result = verifyGenoffice({ appOutDir: strictOut });
      assert.deepEqual(result, { editorsBundled: true, editors: [...EDITOR_APPS] });
    });
    const marker = JSON.parse(fs.readFileSync(path.join(strictResources, "availability.json"), "utf8"));
    assert.equal(marker.licenseBundleVersion, 2);
    assert.equal(marker.chromiumLicenseElectronVersion, "40.0.0");
    assert.equal(marker.licenseAssetsSha256["GenOffice-THIRD-PARTY-NOTICES.txt"].length, 64);
    assert.equal(marker.licenseAssetsSha256["LICENSES.chromium.html"].length, 64);
  });

  verify("strict GenOffice afterPack rejects same-size Chromium license tampering", () => {
    const file = path.join(strictResources, "licenses", "LICENSES.chromium.html");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x43));
    withEnv({ MCODE_INCLUDE_GENOFFICE_BUNDLE: "1" }, () => {
      assert.throws(() => verifyGenoffice({ appOutDir: strictOut }), /license resource digest mismatch/i);
    });
    put(file, original);
    withEnv({ MCODE_INCLUDE_GENOFFICE_BUNDLE: "1" }, () => {
      assert.deepEqual(verifyGenoffice({ appOutDir: strictOut }), { editorsBundled: true, editors: [...EDITOR_APPS] });
    });
  });

  const nodeRedValid = path.join(base, "node-red-valid");
  const validInventory = makeNodeRedFixture(nodeRedValid);
  verify("Node-RED afterPack accepts a complete synthetic package/license inventory", () => {
    const result = verifyNodeRed.verifyNodeRedResource(nodeRedValid);
    assert.equal(result.version, VERSION);
    assert.equal(result.sourceCommit, BASE_COMMIT);
    assert.equal(result.licenseCoverage.releaseEligible, true);
    assert.equal(result.licenseCoverage.packageCount, validInventory.summary.packageCount);
  });

  verify("Node-RED afterPack rejects root LICENSE tampering", () => {
    const file = path.join(nodeRedValid, "LICENSE");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x58));
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /licenseSha256 digest mismatch/i);
    put(file, original);
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).licenseCoverage.releaseEligible, true);
  });

  verify("Node-RED afterPack rejects a deleted root LICENSE", () => {
    const file = path.join(nodeRedValid, "LICENSE");
    const saved = file + ".t76-saved";
    fs.renameSync(file, saved);
    try {
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /LICENSE|ENOENT/i);
    } finally {
      fs.renameSync(saved, file);
    }
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED afterPack rejects version drift in the release manifest", () => {
    const file = path.join(nodeRedValid, "manifest.json");
    const original = fs.readFileSync(file);
    const marker = JSON.parse(original.toString("utf8"));
    marker.version = "5.0.7";
    put(file, JSON.stringify(marker, null, 2) + "\n");
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /manifest\/version\/commit mismatch/i);
    put(file, original);
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED afterPack rejects editor JS tampering", () => {
    const file = path.join(nodeRedValid, "packages/node_modules/@node-red/editor-client/public/red/red.min.js");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x45));
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /editorSha256 digest mismatch/i);
    put(file, original);
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED afterPack rejects runtime source tampering outside package.json", () => {
    const file = path.join(nodeRedValid, "packages/node_modules/@node-red/runtime/index.js");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x52));
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /runtime\/editor package tree digest mismatch/i);
    put(file, original);
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED afterPack rejects production dependency source tampering", () => {
    const file = path.join(nodeRedValid, "node_modules/express/index.js");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x51));
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /production dependency tree digest mismatch/i);
    put(file, original);
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED afterPack rejects a dependency path escaping through a junction", () => {
    const dep = path.join(nodeRedValid, "node_modules", "express");
    const saved = path.join(nodeRedValid, "node_modules", "express-real");
    const outside = path.join(base, "unreviewed-express");
    makeNodeRedPackage(base, "unreviewed-express", "express", "4.0.0", "MIT");
    fs.renameSync(dep, saved);
    try {
      fs.symlinkSync(outside, dep, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(nodeRedValid), /symlink|junction|ancestor|unsafe/i);
    } finally {
      fs.rmSync(dep, { recursive: true, force: true });
      fs.renameSync(saved, dep);
    }
    assert.equal(verifyNodeRed.verifyNodeRedResource(nodeRedValid).version, VERSION);
  });

  verify("Node-RED release gate rejects unknown pause@0.0.1 license rather than assuming a license", () => {
    const root = path.join(base, "node-red-unknown-license");
    const inventory = makeNodeRedFixture(root, { pause: true });
    assert.equal(inventory.summary.unknownLicenseMetadata, 1);
    assert.equal(inventory.summary.missingLicenseText, 1);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), error =>
      /pause@0\.0\.1/.test(error.message) && /unknown-license/.test(error.message));
  });

  verify("Node-RED release gate rejects known SPDX metadata without packaged license text", () => {
    const root = path.join(base, "node-red-missing-license-text");
    const inventory = makeNodeRedFixture(root, { missingExpressLicense: true });
    assert.equal(inventory.summary.unknownLicenseMetadata, 0);
    assert.equal(inventory.summary.missingLicenseText, 1);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), error =>
      /express@4\.0\.0/.test(error.message) && /license-text-missing/.test(error.message));
  });

  const existingStage = path.resolve(__dirname, "../../.tmp/node-red-release");
  if (fs.existsSync(existingStage)) {
    verify("current Node-RED stage license audit reports exact missing/unknown package metadata (read-only)", () => {
      const inventory = createNodeRedLicenseInventory(existingStage);
      assert.ok(inventory.summary.packageCount > 0);
      assert.equal(inventory.inventoryType, "license-coverage-audit-not-sbom");
      assert.equal(inventory.summary.releaseEligible, false);
      const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
      assert.ok(pause && pause.status === "unknown-license");
      const missing = inventory.packages.filter(item => !item.licenseTextPresent);
      assert.ok(missing.length > 0);
      console.log("    Node-RED license inventory summary: " + JSON.stringify(inventory.summary));
      console.log("    missing license text: " + missing.map(item => item.name + "@" + item.version + " [" + item.status + "] (" + item.path + ")").join("; "));
      console.log("    unknown license metadata: " + inventory.packages.filter(item => item.status === "unknown-license")
        .map(item => item.name + "@" + item.version + " (" + item.path + ")").join("; "));
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(existingStage), /licenseSha256 digest mismatch|third-party-license-inventory/i);
    });
  } else {
    console.log("  skip current Node-RED stage audit: .tmp/node-red-release is not available");
  }

  console.log("t76-vendor-release-integrity-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
