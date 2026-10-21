"use strict";
/**
 * ARC-007: opt-in GenOffice CLI and original six-editor release staging.
 *
 * Default CI installs must remain buildable without the ignored vendor checkout,
 * and must never silently ship an incomplete/stale GenOffice sidecar. Explicit
 * MCODE_INCLUDE_GENOFFICE_BUNDLE=1 requires a reviewed local vendor snapshot.
 * By default we stage only the CLI bundle/dependencies/PDFium/notices. A second
 * explicit opt-in stages the six already-built ORIGINAL vendor renderer assets
 * (not their separate Electron shell/agent loop). Missing editor outputs fail
 * before touching any previously staged resources.
 *
 * electron-builder extraResources copies .tmp/genoffice-release => resources/genoffice.
 * All paths are app-local; never write to the user's Electron data directory.
 */
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { isAbsolute, join, resolve, relative, sep, dirname } = require("node:path");
const EDITOR_APPS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);

function assertWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (isAbsolute(rel) || rel.startsWith("..") || rel.startsWith(sep) || rel === "..") {
    throw new Error("GenOffice resource path escapes its approved root");
  }
}
function assertVendorTreeSafe(repo, dir) {
  // cpSync(dereference:true) would otherwise follow a nested junction into
  // arbitrary workstation files, even when the top-level source is trusted.
  assertWithin(repo, fs.realpathSync.native(dir));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("unsafe vendor symlink/junction in GenOffice CLI dependencies: " + entry.name);
    }
    if (entry.isDirectory()) assertVendorTreeSafe(repo, child);
  }
}
/** Inspect every path component before copying original vendor resources.
 * A junction apps/docs/out -> apps/html/out can stay inside the approved Git
 * checkout while substituting the wrong native editor. CLI node_modules can
 * also point to unreviewed sibling directories inside the *Mcode* repo, which
 * the old assertWithin(repo, realpath) erroneously accepted. Check physical
 * identity for both, not just resolved path containment or nested children. */
function assertNativeVendorPath(vendor, input) {
  assertWithin(vendor, input);
  const rootInfo = fs.lstatSync(vendor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("GenOffice native vendor root unsafe symlink/junction: " + vendor);
  }
  const parts = relative(vendor, input).split(sep).filter(Boolean);
  let current = vendor;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let s;
    try { s = fs.lstatSync(current); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error("GenOffice original renderer/resource missing: " + current);
      throw err;
    }
    if (s.isSymbolicLink() || (index < parts.length - 1 && !s.isDirectory())) {
      throw new Error("GenOffice native resource unsafe ancestor symlink/junction: " + current);
    }
  }
}
function fileReady(file, label) {
  try {
    if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) return;
  } catch {}
  throw new Error(`GenOffice bundle missing required ${label}: ${file}`);
}
function dirReady(dir, label) {
  try {
    if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) return;
  } catch {}
  throw new Error(`GenOffice bundle missing required ${label}: ${dir}`);
}
function noticePackagesWithoutLicenseText(text) {
  const sections = [...text.matchAll(/\n-{72}\n([^\n]+)\n-{72}\n([\s\S]*?)(?=\n-{72}\n|$)/g)];
  return sections
    .filter(([, title, body]) => / v[^\n]+ — /.test(title) && body.trimStart().startsWith("Licensed under "))
    .map(([, title]) => title);
}
function assertThirdPartyNoticeComplete(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const term of ["@embedpdf/pdfium", "Copyright 2014 PDFium Authors", "Apache License"]) {
    if (!text.includes(term)) throw new Error("GenOffice third-party notice is missing required PDFium license term: " + term);
  }
  const missing = noticePackagesWithoutLicenseText(text);
  if (missing.length) {
    throw new Error("GenOffice third-party notice lacks full license text for " + missing.length + " package(s): " +
      missing.join(", ") + ". Prerequisite: add verified upstream license texts and regenerate the notice from the pinned clean GenOffice source; do not synthesize license files from SPDX labels or README text.");
  }
  return { packageSections: [...text.matchAll(/\n-{72}\n([^\n]+ v[^\n]+ — )/g)].length, missingLicenseText: [] };
}
function resolveChromiumLicense(app) {
  const appRequire = createRequire(join(app, "package.json"));
  const electronPackagePath = appRequire.resolve("electron/package.json");
  assertWithin(app, fs.realpathSync.native(electronPackagePath));
  const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, "utf8"));
  if (electronPackage.name !== "electron" || typeof electronPackage.version !== "string") {
    throw new Error("Mcode Electron package metadata is invalid; cannot select its Chromium license file");
  }
  return { path: join(dirname(electronPackagePath), "dist", "LICENSES.chromium.html"), electronVersion: electronPackage.version };
}
/**
 * A renderer index with a dangling Vite entry script is not a working vendor
 * editor. Check generated local script/style references before advertising
 * that the original editor ASSETS (not necessarily its Host RPC) are staged.
 */
function assertRendererAssetsReady(renderer, name) {
  const html = fs.readFileSync(join(renderer, "index.html"), "utf8");
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)];
  if (entryScripts.length === 0) throw new Error(`GenOffice ${name} original renderer has no entry script`);
  const references = [...html.matchAll(/\b(?:src|href)=["'](\.\/assets\/[^"']+)["']/gi)];
  for (const [, ref] of references) {
    const target = resolve(renderer, ref);
    assertWithin(renderer, target);
    fileReady(target, `${name} renderer asset ${ref}`);
  }
  for (const [, script] of entryScripts) {
    if (!script.startsWith("./assets/")) {
      throw new Error(`GenOffice ${name} renderer script is not a local vendor asset`);
    }
  }
}

/**
 * Hash the *entire* vendored renderer tree, not just index.html's script/link.
 * Vite lazy imports, fonts and images may be required at runtime even though
 * no HTML tag references them. Persist a digest of exactly what was staged;
 * afterPack can then refuse truncated or silently modified release assets.
 * No reliance on filesystem enumeration order or path separator.
 */
function hashResourceTree(root, namespace = "mcode.genoffice.resource.tree.v1") {
  const hash = createHash("sha256");
  hash.update(namespace + "\0");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  function visit(dir, subpath = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = subpath ? `${subpath}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`GenOffice renderer has unsafe symlink: ${rel}`);
      if (entry.isDirectory()) { visit(full, rel); continue; }
      if (!entry.isFile()) throw new Error(`GenOffice renderer has unsupported filesystem object: ${rel}`);
      hash.update(rel, "utf8");
      hash.update("\0");
      const fd = fs.openSync(full, "r");
      try {
        const size = fs.fstatSync(fd).size;
        hash.update(String(size));
        hash.update("\0");
        let n, bytes = 0;
        while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          bytes += n;
          hash.update(chunk.subarray(0, n));
        }
        if (bytes !== size) throw new Error(`GenOffice renderer changed during hash: ${rel}`);
      } finally {
        fs.closeSync(fd);
      }
      hash.update("\0");
    }
  }
  visit(root);
  return hash.digest("hex");
}
function hashRendererTree(root) {
  return hashResourceTree(root, "mcode.genoffice.renderer.tree.v1");
}
function hashFile(file) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function prepareGenofficeResources({ appDir, repoRoot, include = false, includeEditors = false, requireCompleteLicenseBundle = false }) {
  if (typeof include !== "boolean" || typeof includeEditors !== "boolean" || typeof requireCompleteLicenseBundle !== "boolean") {
    throw new TypeError("include, includeEditors and requireCompleteLicenseBundle must be boolean");
  }
  if (includeEditors && !include) throw new Error("GenOffice editors require the CLI bundle to be included");
  const app = resolve(appDir);
  const repo = resolve(repoRoot);
  const tmp = join(app, ".tmp");
  const destination = join(tmp, "genoffice-release");
  const vendor = join(repo, "genoffice");
  const cli = join(vendor, "packages", "cli", "dist", "genoffice.cjs");
  const nodeModules = join(vendor, "packages", "cli", "dist", "node_modules");
  const pdfium = join(vendor, "node_modules", "@embedpdf", "pdfium");
  const wasm = join(pdfium, "dist", "pdfium.wasm");
  const thirdPartyNotice = join(vendor, "apps", "shell", "build", "THIRD-PARTY-NOTICES.txt");
  const completeLicenseBundle = include && requireCompleteLicenseBundle;
  const chromiumLicenseInfo = completeLicenseBundle ? resolveChromiumLicense(app) : null;
  const legacyLicenses = [
    [join(vendor, "LICENSE"), "GenOffice-LICENSE"],
    [join(vendor, "NOTICE"), "GenOffice-NOTICE"],
    [join(pdfium, "LICENSE"), "PDFium-LICENSE"],
    [join(pdfium, "LICENSE.pdfium"), "PDFium-LICENSE.pdfium"],
  ];
  const licenses = completeLicenseBundle ? [
    ...legacyLicenses,
    [thirdPartyNotice, "GenOffice-THIRD-PARTY-NOTICES.txt"],
    [chromiumLicenseInfo.path, "LICENSES.chromium.html"],
  ] : legacyLicenses;
  // Validate the entire input BEFORE touching a previous stage.
  // Vite renderer assets are source-built vendor files; never package an
  // incomplete subset (or a symlink to arbitrary workstation/private files).
  const editors = EDITOR_APPS.map((name) => ({
    name, renderer: join(vendor, "apps", name, "out", "renderer"),
  }));
  const nativePreloads = ["sheets", "slides"].map(name => ({
    name, preload: join(vendor, "apps", name, "out", "preload"),
  }));
  const sidecarExe = process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  const sidecarBin = join(vendor, "apps", "sheets", "native", "xlsx-engine", "target", "release", sidecarExe);
  if (includeEditors) {
    for (const { name, renderer } of editors) {
      assertNativeVendorPath(vendor, renderer);
      dirReady(renderer, `${name} original renderer`);
      fileReady(join(renderer, "index.html"), `${name} original renderer index`);
      dirReady(join(renderer, "assets"), `${name} original renderer assets`);
      assertVendorTreeSafe(vendor, renderer);
      assertWithin(vendor, fs.realpathSync.native(renderer));
      assertRendererAssetsReady(renderer, name);
    }
    for (const { name, preload } of nativePreloads) {
      assertNativeVendorPath(vendor, preload);
      dirReady(preload, `${name} original preload`);
      const entry = join(preload, "index.js");
      assertNativeVendorPath(vendor, entry);
      fileReady(entry, `${name} original preload entry`);
      assertVendorTreeSafe(vendor, preload);
    }
    assertNativeVendorPath(vendor, sidecarBin);
    fileReady(sidecarBin, "Rust xlsx-sidecar (required for native Sheets)");
  }
  if (include) {
    fileReady(cli, "CLI");
    dirReady(nodeModules, "CLI node_modules");
    assertVendorTreeSafe(repo, nodeModules);
    fileReady(wasm, "PDFium WASM");
    if (fs.readFileSync(wasm).subarray(0, 4).toString("hex") !== "0061736d") {
      throw new Error("GenOffice PDFium WASM is not a WASM binary");
    }
    for (const [file, name] of licenses) fileReady(file, name);
    const vendorFiles = [cli, nodeModules, wasm, ...licenses.map(([file]) => file)
      .filter(file => !chromiumLicenseInfo || file !== chromiumLicenseInfo.path)];
    for (const file of vendorFiles) {
      assertNativeVendorPath(vendor, file);
      // A vendor's symlink/junction must not redirect the build to arbitrary
      // machine-private files outside the known checkout.
      assertWithin(repo, fs.realpathSync.native(file));
    }
    if (chromiumLicenseInfo) assertWithin(app, fs.realpathSync.native(chromiumLicenseInfo.path));
    if (completeLicenseBundle) assertThirdPartyNoticeComplete(thirdPartyNotice);
  }
  fs.mkdirSync(tmp, { recursive: true });
  const temp = fs.mkdtempSync(join(tmp, ".genoffice-stage-"));
  const backup = join(tmp, ".genoffice-old-" + randomUUID());
  let hadOld = false;
  try {
    if (include) {
      fs.mkdirSync(join(temp, "cli"), { recursive: true });
      fs.mkdirSync(join(temp, "wasm"), { recursive: true });
      fs.mkdirSync(join(temp, "licenses"), { recursive: true });
      fs.copyFileSync(cli, join(temp, "cli", "genoffice.cjs"));
      fs.cpSync(nodeModules, join(temp, "cli", "node_modules"), { recursive: true, dereference: true });
      fs.copyFileSync(wasm, join(temp, "wasm", "pdfium.wasm"));
      for (const [file, name] of licenses) fs.copyFileSync(file, join(temp, "licenses", name));
      if (includeEditors) {
        for (const { name, renderer } of editors) {
          const target = join(temp, "apps", name, "out", "renderer");
          fs.cpSync(renderer, target, { recursive: true, dereference: false });
        }
        for (const { name, preload } of nativePreloads) {
          fs.cpSync(preload, join(temp, "apps", name, "out", "preload"), { recursive: true, dereference: false });
        }
        fs.mkdirSync(join(temp, "native"), { recursive: true });
        fs.copyFileSync(sidecarBin, join(temp, "native", sidecarExe));
      }
    }
    fs.writeFileSync(join(temp, "availability.json"), JSON.stringify({
      format: "mcode.genoffice.resources.v1",
      bundled: include,
      editorsBundled: includeEditors,
      editors: includeEditors ? [...EDITOR_APPS] : [],
      ...(include ? {
        licenseBundleVersion: requireCompleteLicenseBundle ? 2 : 1,
        licenseAssetsSha256: Object.fromEntries(licenses.map(([, name]) => [
          name, hashFile(join(temp, "licenses", name)),
        ])),
        ...(chromiumLicenseInfo ? { chromiumLicenseElectronVersion: chromiumLicenseInfo.electronVersion } : {}),
      } : {}),
      ...(include ? {
        cliSha256: hashFile(join(temp, "cli", "genoffice.cjs")),
        cliDependenciesSha256: hashResourceTree(join(temp, "cli", "node_modules"), "mcode.genoffice.cli-dependencies.tree.v1"),
        pdfiumWasmSha256: hashFile(join(temp, "wasm", "pdfium.wasm")),
      } : {}),
      ...(includeEditors ? {
        editorAssetsSha256: Object.fromEntries(editors.map(({ name }) => [
          name, hashRendererTree(join(temp, "apps", name, "out", "renderer")),
        ])),
        editorPreloadSha256: Object.fromEntries(nativePreloads.map(({ name }) => [
          name, hashResourceTree(join(temp, "apps", name, "out", "preload"), "mcode.genoffice.preload.tree.v1"),
        ])),
        nativeSidecar: sidecarExe,
        nativeSidecarSha256: hashFile(join(temp, "native", sidecarExe)),
      } : {}),
    }) + "\n", "utf8");
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      hadOld = true;
    }
    try {
      fs.renameSync(temp, destination);
    } catch (err) {
      if (hadOld) fs.renameSync(backup, destination);
      throw err;
    }
    if (hadOld) fs.rmSync(backup, { recursive: true, force: true });
    return { bundled: include, editorsBundled: includeEditors, resourceDirectory: destination };
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const setting = process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE ?? "";
    if (setting !== "" && setting !== "0" && setting !== "1") {
      throw new Error("MCODE_INCLUDE_GENOFFICE_BUNDLE must be 0 or 1");
    }
    const editorsSetting = process.env.MCODE_INCLUDE_GENOFFICE_EDITORS ?? "";
    if (editorsSetting !== "" && editorsSetting !== "0" && editorsSetting !== "1") {
      throw new Error("MCODE_INCLUDE_GENOFFICE_EDITORS must be 0 or 1");
    }
    const appDir = resolve(__dirname, "..");
    const result = prepareGenofficeResources({
      appDir, repoRoot: resolve(appDir, "../.."), include: setting === "1",
      includeEditors: editorsSetting === "1", requireCompleteLicenseBundle: true,
    });
    console.log(`GenOffice release sidecar: ${result.bundled ? "CLI staged" : "not included"}; original editors: ${result.editorsBundled ? "six staged" : "not included"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = { prepareGenofficeResources, assertWithin, assertVendorTreeSafe, assertRendererAssetsReady, hashResourceTree, hashRendererTree, hashFile, noticePackagesWithoutLicenseText, assertThirdPartyNoticeComplete, resolveChromiumLicense, EDITOR_APPS };
