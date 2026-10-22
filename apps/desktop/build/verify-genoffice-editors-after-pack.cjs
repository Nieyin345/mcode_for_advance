"use strict";
/**
 * ARC-007 Electron-builder afterPack: keep the original GenOffice renderers
 * together. Staging success alone cannot prove extraResources survived packing.
 * This asserts staged native sidecar/preload presence and digests, not their execution, Host RPC, or AI parity.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  EDITOR_APPS, NATIVE_PRELOAD_KINDS, assertRendererAssetsReady, assertDocsRendererHasAckTransport,
  assertVendorTreeSafe, hashResourceTree, hashRendererTree, hashFile,
  assertThirdPartyNoticeComplete, assertThirdPartyNoticeMatchesManifest,
  validateGenofficeLicenseManifest, REQUIRED_GENOFFICE_LICENSE_PACKAGES,
} = require("./stage-genoffice-resources.cjs");

/** lstat every ancestor: fs.stat/realpath(renderer) alone misses a junction
 * at apps/ or docs/out pointing to a sibling directory within resources. */
function verifyPhysicalDirChain(root, parts = []) {
  let dir = root;
  for (const next of [null, ...parts]) {
    if (next !== null) dir = path.join(dir, next);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (err) {
      if (err?.code === "ENOENT") throw new Error("Missing GenOffice editor directory: " + dir);
      throw err;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe GenOffice resource ancestor symlink/junction: " + dir);
    }
  }
}
/** The same afterPack hook must verify native CLI/PDFium/licences, not only
 * Vite renderer assets. An editor page with a missing engine entrypoint or a
 * zeroed WASM is a broken release even when all six HTML hashes are valid. */
function verifyPackagedNativeRuntime(root, info) {
  const bundled = info.bundled;
  const editorsBundled = info.editorsBundled;
  const nativeRoots = ["cli", "wasm", "licenses"];
  if (!bundled) {
    for (const name of [...nativeRoots, "native"]) {
      if (fs.existsSync(path.join(root, name))) {
        throw new Error("GenOffice native runtime unexpectedly present in opt-out release: " + name);
      }
    }
    for (const key of ["cliSha256", "cliDependenciesSha256", "pdfiumWasmSha256"]) {
      if (info[key] !== undefined) throw new Error("GenOffice opt-out manifest retains stale native integrity metadata: " + key);
    }
    return;
  }
  for (const name of nativeRoots) verifyPhysicalDirChain(root, [name]);
  verifyPhysicalDirChain(root, ["cli", "node_modules"]);
  const required = [
    ["cli/genoffice.cjs", "GenOffice CLI"],
    ["wasm/pdfium.wasm", "PDFium WASM"],
    ["licenses/GenOffice-LICENSE", "GenOffice LICENSE"],
    ["licenses/GenOffice-NOTICE", "GenOffice NOTICE"],
    ["licenses/PDFium-LICENSE", "PDFium LICENSE"],
    ["licenses/PDFium-LICENSE.pdfium", "PDFium LICENSE.pdfium"],
  ];
  for (const [name, label] of required) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error("GenOffice packaged native " + label + " missing: " + file);
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error("GenOffice packaged native " + label + " invalid: " + file);
    }
  }
  const cli = path.join(root, "cli", "genoffice.cjs");
  const dependencies = path.join(root, "cli", "node_modules");
  const wasmFile = path.join(root, "wasm", "pdfium.wasm");
  if (typeof info.cliSha256 !== "string" || !/^[0-9a-f]{64}$/.test(info.cliSha256)
    || typeof info.cliDependenciesSha256 !== "string" || !/^[0-9a-f]{64}$/.test(info.cliDependenciesSha256)
    || typeof info.pdfiumWasmSha256 !== "string" || !/^[0-9a-f]{64}$/.test(info.pdfiumWasmSha256)) {
    throw new Error("GenOffice native CLI/dependency/PDFium integrity manifest is missing or invalid");
  }
  if (hashFile(cli) !== info.cliSha256) throw new Error("GenOffice packaged CLI digest mismatch");
  assertVendorTreeSafe(root, dependencies);
  if (hashResourceTree(dependencies, "mcode.genoffice.cli-dependencies.tree.v1") !== info.cliDependenciesSha256) {
    throw new Error("GenOffice packaged CLI dependency tree digest mismatch");
  }
  const wasm = fs.readFileSync(wasmFile);
  if (wasm.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error("GenOffice packaged PDFium WASM invalid magic");
  }
  if (hashFile(wasmFile) !== info.pdfiumWasmSha256) throw new Error("GenOffice packaged PDFium WASM digest mismatch");
  if (!editorsBundled && fs.existsSync(path.join(root, "native"))) {
    throw new Error("GenOffice native Sheets sidecar unexpectedly present without editor opt-in");
  }
}
function verifyPackagedLicenseAssets(root, info) {
  const strictBuild = process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE === "1";
  if (!info.bundled) {
    if (info.licenseBundleVersion !== undefined || info.licenseAssetsSha256 !== undefined
      || info.chromiumLicenseElectronVersion !== undefined || info.licenseSourceManifestSha256 !== undefined
      || info.licenseSourcePackageCount !== undefined || info.licenseBundleTestFixture !== undefined) {
      throw new Error("GenOffice opt-out manifest retains stale license integrity metadata");
    }
    return;
  }
  const version = info.licenseBundleVersion;
  if (version === undefined) {
    if (strictBuild) throw new Error("GenOffice strict release is missing its license bundle integrity manifest");
    return; // Legacy fixtures remain readable; the release entrypoint always emits a versioned manifest.
  }
  if (![1, 2, 3].includes(version) || (strictBuild && ![2, 3].includes(version))) {
    throw new Error("GenOffice license bundle version is invalid or incomplete for this release mode");
  }
  if (version !== 3 && (info.licenseSourceManifestSha256 !== undefined || info.licenseSourcePackageCount !== undefined)) {
    throw new Error("GenOffice license bundle downgrade discarded its source-manifest version");
  }
  if (version === 2 && strictBuild && info.licenseBundleTestFixture !== true) {
    throw new Error("GenOffice strict release v2 license bundle is missing its reviewed source-manifest provenance");
  }
  if (version !== 2 && info.licenseBundleTestFixture !== undefined) {
    throw new Error("GenOffice license bundle has unexpected test-fixture marker");
  }
  const legacy = ["GenOffice-LICENSE", "GenOffice-NOTICE", "PDFium-LICENSE", "PDFium-LICENSE.pdfium"];
  const complete = [...legacy, "GenOffice-THIRD-PARTY-NOTICES.txt", "LICENSES.chromium.html"];
  let sourceValidation = null;
  let expected = version === 1 ? legacy : complete;
  if (version === 3) {
    if (typeof info.licenseSourceManifestSha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(info.licenseSourceManifestSha256)
        || info.licenseSourcePackageCount !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
      throw new Error("GenOffice v3 license source-manifest digest/package-count metadata is missing or invalid");
    }
    const manifestPath = path.join(root, "licenses", "GenOffice-THIRD-PARTY-LICENSES.json");
    let manifestStat;
    try { manifestStat = fs.lstatSync(manifestPath); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error("GenOffice packaged license source manifest missing: " + manifestPath);
      throw err;
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size === 0
        || hashFile(manifestPath) !== info.licenseSourceManifestSha256) {
      throw new Error("GenOffice packaged license source manifest digest/identity mismatch");
    }
    sourceValidation = validateGenofficeLicenseManifest({
      manifestPath,
      licenseRoot: path.join(root, "licenses", "GenOffice-Third-Party-Licenses"),
      requireComplete: true,
    });
    expected = [
      ...complete,
      "GenOffice-THIRD-PARTY-LICENSES.json",
      ...sourceValidation.items.map(item => "GenOffice-Third-Party-Licenses/" + item.licenseFile),
    ];
  }
  const digests = info.licenseAssetsSha256;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)
    || JSON.stringify(Object.keys(digests).sort()) !== JSON.stringify([...expected].sort())
    || expected.some(name => typeof digests[name] !== "string" || !/^[0-9a-f]{64}$/.test(digests[name]))) {
    throw new Error("GenOffice license asset integrity manifest is missing or invalid");
  }
  for (const name of expected) {
    const file = path.join(root, "licenses", name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error("GenOffice packaged license resource missing: " + file);
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error("GenOffice packaged license resource invalid: " + file);
    }
    if (hashFile(file) !== digests[name]) throw new Error("GenOffice packaged license resource digest mismatch: " + name);
  }
  if (version === 2 || version === 3) {
    if (typeof info.chromiumLicenseElectronVersion !== "string" || !/^\d+\.\d+\.\d+/.test(info.chromiumLicenseElectronVersion)) {
      throw new Error("GenOffice complete license bundle is missing the source Electron version for Chromium licenses");
    }
    const noticePath = path.join(root, "licenses", "GenOffice-THIRD-PARTY-NOTICES.txt");
    assertThirdPartyNoticeComplete(noticePath);
    if (version === 3) assertThirdPartyNoticeMatchesManifest(fs.readFileSync(noticePath, "utf8"), sourceValidation);
  } else if (info.chromiumLicenseElectronVersion !== undefined) {
    throw new Error("GenOffice legacy license manifest has unexpected Chromium license metadata");
  }
}
function verifyPackagedNativeEditors(root, info) {
  const preloadDigests = info.editorPreloadSha256;
  // The expected set comes from the runtime contract, not a hand-written
  // pair: every native kind that gets a vendor WebContentsView must ship its
  // preload. A manifest that omits (or adds) an entry is a broken package.
  const preloadNames = [...NATIVE_PRELOAD_KINDS];
  if (!preloadDigests || typeof preloadDigests !== "object" || Array.isArray(preloadDigests)
    || JSON.stringify(Object.keys(preloadDigests).sort()) !== JSON.stringify([...preloadNames].sort())
    || preloadNames.some(name => typeof preloadDigests[name] !== "string"
      || !/^[0-9a-f]{64}$/.test(preloadDigests[name]))) {
    throw new Error("GenOffice native editor preload integrity manifest is missing or invalid");
  }
  const expectedSidecar = process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  if (info.nativeSidecar !== expectedSidecar
    || typeof info.nativeSidecarSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(info.nativeSidecarSha256)) {
    throw new Error("GenOffice native Sheets sidecar integrity manifest is missing or invalid");
  }
  verifyPhysicalDirChain(root, ["native"]);
  const sidecar = path.join(root, "native", expectedSidecar);
  let sidecarStat;
  try { sidecarStat = fs.lstatSync(sidecar); }
  catch (err) {
    if (err?.code === "ENOENT") throw new Error("GenOffice packaged native Sheets xlsx-sidecar missing: " + sidecar);
    throw err;
  }
  if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink() || sidecarStat.size === 0) {
    throw new Error("GenOffice packaged native Sheets xlsx-sidecar invalid: " + sidecar);
  }
  if (hashFile(sidecar) !== info.nativeSidecarSha256) {
    throw new Error("GenOffice packaged native Sheets xlsx-sidecar digest mismatch");
  }
  for (const name of preloadNames) {
    const preload = path.join(root, "apps", name, "out", "preload");
    verifyPhysicalDirChain(root, ["apps", name, "out", "preload"]);
    assertVendorTreeSafe(root, preload);
    const entry = path.join(preload, "index.js");
    let entryStat;
    try { entryStat = fs.lstatSync(entry); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error(`GenOffice packaged ${name} preload entry missing: ${entry}`);
      throw err;
    }
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.size === 0) {
      throw new Error(`GenOffice packaged ${name} preload entry invalid: ${entry}`);
    }
    if (hashResourceTree(preload, "mcode.genoffice.preload.tree.v1") !== preloadDigests[name]) {
      throw new Error(`GenOffice packaged ${name} preload integrity digest mismatch`);
    }
  }
}
function verifyPackagedGenofficeEditorAssets(resourceRoot) {
  const root = path.resolve(resourceRoot);
  verifyPhysicalDirChain(path.dirname(root), [path.basename(root)]);
  const marker = path.join(root, "availability.json");
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size === 0) {
    throw new Error("GenOffice packaged availability.json missing or unsafe");
  }
  const info = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (info?.format !== "mcode.genoffice.resources.v1"
    || typeof info.bundled !== "boolean"
    || typeof info.editorsBundled !== "boolean"
    || !Array.isArray(info.editors)) {
    throw new Error("GenOffice packaged editor availability manifest invalid");
  }
  verifyPackagedNativeRuntime(root, info);
  verifyPackagedLicenseAssets(root, info);
  if (!info.editorsBundled) {
    if (info.editors.length > 0 || fs.existsSync(path.join(root, "apps"))) {
      throw new Error("GenOffice editor assets unexpectedly present despite editorsBundled=false");
    }
    if (info.editorPreloadSha256 !== undefined || info.nativeSidecar !== undefined
      || info.nativeSidecarSha256 !== undefined) {
      throw new Error("GenOffice opt-out manifest retains stale native editor integrity metadata");
    }
    return { editorsBundled: false };
  }
  if (!info.bundled || JSON.stringify(info.editors) !== JSON.stringify(EDITOR_APPS)) {
    throw new Error("GenOffice six original editors require a complete CLI bundle and exact six-app manifest");
  }
  const nativeEditorIntegrityPresent = info.editorPreloadSha256 !== undefined
    || info.nativeSidecar !== undefined || info.nativeSidecarSha256 !== undefined;
  if (process.env.MCODE_INCLUDE_GENOFFICE_EDITORS === "1" && !nativeEditorIntegrityPresent) {
    throw new Error("GenOffice strict editor release is missing native sidecar/preload integrity metadata");
  }
  // Older synthetic release-readiness fixtures predate native integrity fields.
  // Actual staging always writes these fields when editorsBundled=true.
  if (nativeEditorIntegrityPresent) verifyPackagedNativeEditors(root, info);
  const digests = info.editorAssetsSha256;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)
    || JSON.stringify(Object.keys(digests).sort()) !== JSON.stringify([...EDITOR_APPS].sort())
    || EDITOR_APPS.some((name) => typeof digests[name] !== "string"
      || !/^[0-9a-f]{64}$/.test(digests[name]))) {
    throw new Error("GenOffice original editor resource integrity manifest is missing or invalid");
  }
  for (const name of EDITOR_APPS) {
    const renderer = path.join(root, "apps", name, "out", "renderer");
    verifyPhysicalDirChain(root, ["apps", name, "out", "renderer", "assets"]);
    if (!fs.statSync(renderer).isDirectory()) throw new Error("GenOffice " + name + " renderer directory missing");
    assertVendorTreeSafe(root, renderer);
    assertRendererAssetsReady(renderer, name);
    if (hashRendererTree(renderer) !== digests[name]) {
      throw new Error(`GenOffice ${name} renderer integrity digest mismatch (missing or changed vendor asset)`);
    }
  }
  // Digest agreement only proves the package matches the stage; it cannot
  // prove the stage was built after patch 0013. Re-check the compiled marker
  // so a stale vendor build fails at pack time too.
  assertDocsRendererHasAckTransport(path.join(root, "apps", "docs", "out", "renderer"));
  return { editorsBundled: true, editors: [...EDITOR_APPS] };
}

/**
 * Electron-builder afterPack appOutDir varies: win-unpacked/resources, Linux
 * linux-unpacked/resources, mac/GenOffice.app/Contents/Resources.
 */
function verifyAfterPack(context) {
  if (!context || typeof context.appOutDir !== "string") {
    throw new Error("GenOffice post-pack gate requires Electron appOutDir");
  }
  const out = path.resolve(context.appOutDir);
  const candidates = [path.join(out, "resources", "genoffice")];
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      candidates.push(path.join(out, entry.name, "Contents", "Resources", "genoffice"));
    }
  }
  const matches = candidates.filter((dir) => fs.existsSync(dir));
  if (matches.length !== 1) {
    throw new Error("Expected exactly one packaged GenOffice resources directory, got " + matches.length);
  }
  return verifyPackagedGenofficeEditorAssets(matches[0]);
}

module.exports = verifyAfterPack;
module.exports.verifyPackagedGenofficeEditorAssets = verifyPackagedGenofficeEditorAssets;
module.exports.verifyPackagedLicenseAssets = verifyPackagedLicenseAssets;
module.exports.verifyPhysicalDirChain = verifyPhysicalDirChain;
