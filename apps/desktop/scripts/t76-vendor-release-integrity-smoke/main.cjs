"use strict";
/** T76: isolated GenOffice/Node-RED release resource and license integrity smoke. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  prepareGenofficeResources, EDITOR_APPS, NATIVE_PRELOAD_KINDS,
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
  for (const name of NATIVE_PRELOAD_KINDS) {
    put(path.join(vendor, "apps", name, "out/preload/index.js"), "// original preload fixture for " + name + "\n");
  }
  put(sourceSidecar, "native xlsx sidecar fixture\n");
  for (const name of EDITOR_APPS) {
    const renderer = path.join(vendor, "apps", name, "out", "renderer");
    put(path.join(renderer, "index.html"),
      "<html><script type=\"module\" src=\"./assets/" + name + ".js\"></script>" +
      "<link rel=\"stylesheet\" href=\"./assets/" + name + ".css\"></html>");
    // Docs must carry the patch-0013 compiled marker or staging fails closed.
    put(path.join(renderer, "assets", name + ".js"),
      (name === "docs"
        ? "const t=window.desktop.aiToolResult;return{...(typeof t==='function'?{toolResultAck:t}:{})};"
        : "") + "window.vendor = '" + name + "';\n");
    put(path.join(renderer, "assets", name + ".css"), "." + name + "{}\n");
  }
  fs.mkdirSync(appDir, { recursive: true });

  verify("staging records full renderer, native preload, and xlsx-sidecar digests", () => {
    const result = prepareGenofficeResources({ appDir, repoRoot, include: true, includeEditors: true });
    assert.equal(result.editorsBundled, true);
    const marker = JSON.parse(fs.readFileSync(path.join(stage, "availability.json"), "utf8"));
    assert.deepEqual(Object.keys(marker.editorAssetsSha256).sort(), [...EDITOR_APPS].sort());
    assert.deepEqual(Object.keys(marker.editorPreloadSha256).sort(), [...NATIVE_PRELOAD_KINDS].sort());
    assert.equal(marker.nativeSidecar, sidecarName);
    assert.match(marker.nativeSidecarSha256, /^[0-9a-f]{64}$/);
  });

  const out = path.join(base, "genoffice-win-unpacked");
  const resources = path.join(out, "resources", "genoffice");
  fs.mkdirSync(path.dirname(resources), { recursive: true });
  fs.cpSync(stage, resources, { recursive: true });

  verify("afterPack accepts six renderers plus every runtime native preload and sidecar", () => {
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

  /**
   * 一段真实 stage 上跑得通的**自洽性**判据。
   *
   * 【T108】这里从前断言的是「当前这份 stage 是坏的」：
   *   `releaseEligible === false`、`pause.status === "unknown-license"`、`missing.length > 0`。
   * 那三条写于 T10 整合 pause 许可**之前**，T10（782b08fc）把 stage 修好之后它们
   * 就成了反证 —— 而且是**恒红**的：真实产物存在走过的这条分支整整三天没人跑过，
   * 一跑就红。
   *
   * 现在验的是「审计工具在任意一份 stage 上结论自洽」，**stage 是好是坏都该绿**。
   * 这才是工具的正确性；「今天这份是坏的」只是某一天的世界状态。
   */
  function assertStageAuditSelfConsistent(stageDir, label) {
    const inventory = createNodeRedLicenseInventory(stageDir);
    assert.ok(inventory.summary.packageCount > 0, label + ": 审计应至少覆盖一个包");
    assert.equal(inventory.inventoryType, "license-coverage-audit-not-sbom", label + ": 报告类型");
    // 自洽 1：eligible 必须等于**它自己的每一项 blocker 计数都为 0**。
    //
    // 【T108 实测纠正】不能只比 `releaseBlockers === 0` —— 产品里 releaseEligible
    // 是十项计数的合取（stage-node-red-resources.cjs:594），而 releaseBlockers
    // 只是其中一项。只比那一项，在缺许可文本的坏 stage 上会写出一个假的不自洽。
    const summary = inventory.summary;
    const blockersAllZero = summary.unknownLicenseMetadata === 0
      && summary.missingLicenseText === 0
      && summary.conflictingLicenseMetadata === 0
      && summary.missingLockEntries === 0
      && summary.lockVersionMismatches === 0
      && summary.packageSourceLockMismatches === 0
      && summary.unknownSpdxExpressions === 0
      && summary.unmatchedLicenseManifestEntries === 0
      && summary.unmatchedReleaseBlockers === 0
      && summary.releaseBlockers === 0;
    assert.equal(summary.releaseEligible, blockersAllZero,
      label + ": releaseEligible 必须等于「所有 blocker 类计数都为 0」");
    // 自洽 1b：releaseBlockers 必须覆盖「逐包 blocker」，不能漏计。
    assert.ok(summary.releaseBlockers >= inventory.packages.filter(item => item.releaseBlocker).length,
      label + ": releaseBlockers 计数不得小于逐包 blocker 数");
    // 自洽 2：判成 unknown-license 的包，不可能同时带着许可文本。
    for (const pkg of inventory.packages.filter(item => item.status === "unknown-license")) {
      assert.equal(pkg.licenseTextPresent, false,
        label + ": unknown-license 的 " + pkg.name + "@" + pkg.version + " 不该有许可文本");
    }
    // 自洽 3：说 eligible 就不能还剩缺失许可文本的包。
    if (inventory.summary.releaseEligible) {
      assert.equal(inventory.summary.missingLicenseText, 0,
        label + ": 声称 eligible 时不应有缺失许可文本");
      assert.equal(inventory.packages.filter(item => !item.licenseTextPresent).length, 0,
        label + ": 声称 eligible 时不应有 licenseTextPresent=false 的包");
    }
    // 自洽 4：两个工具对同一份数据的结论必须一致 —— 审计说 eligible ⇔ 门禁放行。
    let gateVerdict;
    try {
      verifyNodeRed.verifyNodeRedResource(stageDir);
      gateVerdict = "eligible";
    } catch (error) {
      gateVerdict = /release blocked|license-text-missing|unknown-license|digest mismatch|inventory/i.test(error.message)
        ? "blocked" : "unexpected-error";
      assert.equal(gateVerdict, "blocked",
        label + ": 门禁既不是放行也不是许可类拒绝，说明它自己坏了：" + error.message.slice(0, 200));
    }
    assert.equal(inventory.summary.releaseEligible, gateVerdict === "eligible",
      label + ": 审计的 eligible 结论必须与 verifyNodeRedResource 一致（审计="
      + inventory.summary.releaseEligible + ", 门禁=" + gateVerdict + "）");
    return inventory;
  }

  // 【T108】真实产物存在时走这里。没有断言具体状态 —— 只断言「在这份数据上结论自洽」。
  const existingStage = path.resolve(__dirname, "../../.tmp/node-red-release");
  let realStageCovered = false;
  if (fs.existsSync(existingStage)) {
    verify("current Node-RED stage audit is self-consistent and agrees with the release gate (read-only)", () => {
      const inventory = assertStageAuditSelfConsistent(existingStage, "真实 stage");
      const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
      // pause 可以不在（依赖树会变）。若在，它的状态必须与自己的许可数据一致，
      // 而不是「必须仍然是 unknown-license」（那正是 T10 修掉的旧状态）。
      if (pause) {
        assert.equal(pause.status === "unknown-license", pause.licenseTextPresent === false
          && !pause.license,
          "pause 的状态必须与它自己的 license/licenseTextPresent 自洽");
      }
      console.log("    Node-RED license inventory summary: " + JSON.stringify(inventory.summary));
      console.log("    pause: " + (pause ? pause.status + " license=" + pause.license
        + " text=" + pause.licenseTextPresent : "(不在依赖树里)"));
    });
    realStageCovered = true;
  }

  // 【T108】真实产物不在时，**同一段判据**要在一份合格 fixture 上跑一遍。
  //
  // 从前这里是 `else { console.log("skip ...") }` —— 那条路径写出来三天，
  // 只在真实产物第一次出现的那天才被执行，而那一次是红的。用 fixture 兜住，
  // 无论真实产物在不在，这段判据都有覆盖。
  //
  // 【T108】为了让「else 分支确实执行了同一套判据」可断言（而不是靠读代码相信），
  // 这里记录它跑到没有，并在末尾用一条**显式**断言检查两条路恰好走了一条。
  let selfConsistencyCovered = false;
  if (!realStageCovered) {
    verify("Node-RED stage audit self-consistency holds on a clean fixture stage (real stage absent)", () => {
      const fixtureRoot = path.join(base, "node-red-clean-stage");
      makeNodeRedFixture(fixtureRoot);   // 默认参数 = 一份合格 stage（T108 实测确认）
      // 关键：调的是**同一个** assertStageAuditSelfConsistent，不是另写一份简化版。
      const inventory = assertStageAuditSelfConsistent(fixtureRoot, "合格 fixture");
      // 这条只对**我们自己造的合格 fixture** 断言 eligible —— 用它证明判据不是恒假。
      // 真实 stage 那条分支上没有任何「必须 true / 必须 false」的断言（见上方注释）。
      assert.equal(inventory.summary.releaseEligible, true,
        "合格 fixture 应当 eligible（否则这条兜底覆盖验的是别的东西）");
      selfConsistencyCovered = true;
    });
  }
  // 【T108】两条路必须恰好走一条：真实产物在 → if 走过；不在 → else 走过。
  // 缺了这条，「else 分支被误删」不会有任何断言变红（变异实测：掏空 else 里的
  // 自洽判据后，25/25 仍全绿）。
  verify("the stage self-consistency checks ran on exactly one path (if xor else)", () => {
    assert.equal(realStageCovered !== selfConsistencyCovered, true,
      "真实产物存在时应走 if，不存在时应走 else —— 不能两条都没走");
  });

  // 【T108】反向：同一套自洽判据在**坏** stage 上要能指出问题，不能恒绿。
  // 没有这一条，「自洽」可能退化成「怎么都绿」。
  verify("the same self-consistency checks reject a broken stage (goto control, never tautological)", () => {
    const brokenRoot = path.join(base, "node-red-broken-stage");
    const broken = makeNodeRedFixture(brokenRoot, { missingExpressLicense: true });
    assert.equal(broken.summary.releaseEligible, false, "坏 fixture 不应当 eligible");
    // 把**同一套自洽判据**跑在坏 stage 上，并**直接断言它自己的输出**。
    //
    // 【T108 变异记录】这一步是变异逼出来的：最初这里只做 `assert.throws(门禁)`，
    // 于是把自洽判据删掉/改成恒真都不会红 —— 门禁的 throws 独立兜住了。
    // 现在断言的是 `assertStageAuditSelfConsistent` **返回的 summary**，
    // 删掉它就拿不到 summary，改成恒真也改不出「releaseEligible=false」这个值。
    const brokenAudit = assertStageAuditSelfConsistent(brokenRoot, "坏 fixture");
    assert.equal(brokenAudit.summary.releaseEligible, false,
      "坏 stage 在自洽判据下必须不可发布（自洽 ≠ 恒绿）");
    assert.ok(brokenAudit.summary.missingLicenseText > 0,
      "坏 stage 的自洽判据结果里必须能看见缺失许可文本");
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(brokenRoot),
      /license-text-missing/, "坏 fixture 必须被门禁拒绝");
    const audited = createNodeRedLicenseInventory(brokenRoot);
    assert.equal(audited.summary.releaseEligible, false, "坏 stage 必须不可发布");
    assert.ok(audited.summary.missingLicenseText > 0, "坏 fixture 应当有缺失许可文本");
  });

  console.log("t76-vendor-release-integrity-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
