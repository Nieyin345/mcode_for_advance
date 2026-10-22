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
/**
 * Editor kinds whose vendor `out/preload/index.js` the shipped host actually
 * mounts. This mirrors the runtime contract in
 * `src/main/document/genofficeViewFactories.ts` (`NativeKind`): the five
 * kinds below get a vendor `WebContentsView` whose `preloadPath` is
 * `apps/<kind>/out/preload/index.js`. `docs` is deliberately absent — the
 * Docs view is created by `documentViewHost.ts` with Mcode's own
 * `out/main/documentViewPreload.js` bridge (which compiles the vendor
 * `mcode-view.ts` source in), so shipping the vendor's standalone docs
 * preload would only add an unused, over-privileged surface. The release
 * smoke asserts this list equals the runtime kinds, so adding a native kind
 * there without staging its preload fails the build instead of shipping a
 * degraded editor.
 */
const NATIVE_PRELOAD_KINDS = Object.freeze(["pdf", "markdown", "html", "sheets", "slides"]);
const GENOFFICE_UPSTREAM_REPOSITORY = "https://github.com/genspark-ai/genoffice";
const GENOFFICE_UPSTREAM_NOTICE = "genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt";
const GENOFFICE_LICENSE_MANIFEST_SHA256 = "bbb9f634477e715bbf1f7a47eecc89e26560aa951c6f283f8b7d1bb6f018f165";

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
function assertThirdPartyNoticeTextComplete(text) {
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
function assertThirdPartyNoticeComplete(file) {
  return assertThirdPartyNoticeTextComplete(fs.readFileSync(file, "utf8"));
}
const REQUIRED_GENOFFICE_LICENSE_PACKAGES = Object.freeze([
  ["@electron-internal/extract-zip", "1.0.5", "BSD-2-Clause"],
  ["@napi-rs/canvas-win32-x64-msvc", "1.0.3", "MIT"],
  ["@nodable/entities", "3.0.0", "MIT"],
  ["@univerjs/protocol", "0.25.1", "Apache-2.0"],
  ["emoji-regex", "8.0.0", "MIT"],
  ["fastdom", "1.0.12", "MIT"],
  ["franc-min", "6.2.0", "MIT"],
  ["hash.js", "1.1.7", "MIT"],
  ["is-potential-custom-element-name", "1.0.1", "MIT"],
  ["isarray", "1.0.0", "MIT"],
  ["lazy-val", "1.0.5", "MIT"],
  ["ot-json1", "1.0.2", "ISC"],
  ["ot-text-unicode", "4.0.0", "ISC"],
  ["punycode", "2.3.1", "MIT"],
  ["react-remove-scroll-bar", "2.3.8", "MIT"],
  ["saxes", "6.0.0", "ISC"],
  ["strictdom", "1.0.1", "MIT"],
  ["unicount", "1.1.0", "ISC"],
].map(([name, version, spdx]) => Object.freeze({ name, version, spdx })));

function validateGenofficeLicenseManifest({
  manifestPath, licenseRoot, vendorRoot, repoRoot, requireComplete = true,
  expectedManifestSha256 = GENOFFICE_LICENSE_MANIFEST_SHA256,
} = {}) {
  if (typeof manifestPath !== "string" || !manifestPath) {
    throw new Error("GenOffice full license bundle requires its source manifest");
  }
  const manifestFile = resolve(manifestPath);
  if (repoRoot) assertNativeVendorPath(resolve(repoRoot), manifestFile);
  fileReady(manifestFile, "GenOffice license source manifest");
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)
      || hashFile(manifestFile) !== expectedManifestSha256) {
    throw new Error("GenOffice license source manifest SHA-256 differs from the reviewed source inventory");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const root = resolve(licenseRoot ?? join(dirname(manifestFile), "licenses"));
  if (manifest.format !== "mcode.genoffice.third-party-license-sources.v1"
      || manifest.repository !== GENOFFICE_UPSTREAM_REPOSITORY
      || manifest.sourceNotice !== GENOFFICE_UPSTREAM_NOTICE
      || manifest.expectedPackageCount !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length
      || !Array.isArray(manifest.items) || manifest.items.length !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("GenOffice license source manifest schema/package inventory mismatch");
  }
  const verified = [];
  const blocked = [];
  for (let index = 0; index < REQUIRED_GENOFFICE_LICENSE_PACKAGES.length; index++) {
    const expected = REQUIRED_GENOFFICE_LICENSE_PACKAGES[index];
    const item = manifest.items[index];
    if (!item || item.name !== expected.name || item.version !== expected.version || item.spdx !== expected.spdx
        || item.packagePath !== "node_modules/" + expected.name + "/package.json"
        || typeof item.upstreamRepository !== "string" || !item.upstreamRepository.startsWith("https://")
        || typeof item.upstreamRevision !== "string" || !item.upstreamRevision
        || typeof item.upstreamSourceUrl !== "string" || !item.upstreamSourceUrl.startsWith("https://")
        || typeof item.npmTarballUrl !== "string" || !item.npmTarballUrl.startsWith("https://registry.npmjs.org/")
        || typeof item.npmTarballIntegrity !== "string"
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.npmTarballIntegrity)
        || item.npmTarballIntegrityVerified !== true
        || !Array.isArray(item.npmTarballLegalLicenseEntries)
        || !["npm-gitHead", "release-tag-plus-source-commit"].includes(item.upstreamRevisionKind)) {
      throw new Error("GenOffice license source identity/version/SPDX mismatch at package index " + (index + 1));
    }
    if (vendorRoot) {
      const packageFile = resolve(vendorRoot, item.packagePath);
      assertNativeVendorPath(resolve(vendorRoot), packageFile);
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      const actualSpdx = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
      if (pkg.name !== item.name || pkg.version !== item.version || actualSpdx !== item.spdx) {
        throw new Error("GenOffice installed package metadata differs from license source manifest: " + item.name);
      }
    }
    if (item.status === "blocked") {
      if (item.licenseFile !== null || item.licenseTextSha256 !== null || item.licenseSourceUrl !== null
          || typeof item.missingEvidence !== "string" || !item.missingEvidence) {
        throw new Error("GenOffice blocked license entry contains a fabricated/incomplete text record: " + item.name);
      }
      blocked.push({ name: item.name, version: item.version, spdx: item.spdx, evidence: item.missingEvidence });
      continue;
    }
    if (item.status !== "verified" || typeof item.licenseFile !== "string"
        || item.licenseFile !== item.licenseFile.split(/[\\/]/).pop()
        || item.licenseFile === "." || item.licenseFile === ".."
        || typeof item.licenseTextSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.licenseTextSha256)
        || typeof item.licenseSourceUrl !== "string" || !item.licenseSourceUrl.startsWith("https://raw.githubusercontent.com/")
        || typeof item.licenseSourceVersion !== "string" || !item.licenseSourceVersion
        || item.licenseSourceKind !== "exact-upstream-source-file") {
      throw new Error("GenOffice verified license entry lacks exact source/file/hash metadata: " + item.name);
    }
    const licenseFile = resolve(root, item.licenseFile);
    assertWithin(root, licenseFile);
    if (repoRoot) assertNativeVendorPath(resolve(repoRoot), licenseFile);
    fileReady(licenseFile, "full upstream license text for " + item.name);
    const text = fs.readFileSync(licenseFile, "utf8");
    if (text.trim().length < 150 || /^(?:Licensed under |SPDX-License-Identifier:)/i.test(text.trim())
        || !/(?:Permission is hereby granted|Permission to use, copy|Apache License|Redistribution and use)/i.test(text)) {
      throw new Error("GenOffice license source is not a full license text: " + item.name);
    }
    const actualHash = hashFile(licenseFile);
    if (actualHash !== item.licenseTextSha256) {
      throw new Error("GenOffice license source SHA-256 mismatch: " + item.name);
    }
    verified.push({ ...item, licensePath: licenseFile, licenseText: text });
  }
  if (manifest.resolvedCount !== verified.length || manifest.blockedCount !== blocked.length
      || manifest.releaseEligible !== (blocked.length === 0)) {
    throw new Error("GenOffice license source manifest summary disagrees with its package entries");
  }
  if (requireComplete && blocked.length) {
    throw new Error("GenOffice strict release blocked: full upstream license text is unresolved for " +
      blocked.map(item => item.name + "@" + item.version + " (" + item.spdx + ")").join(", ") +
      ". Do not infer license text from SPDX metadata or a similar release.");
  }
  return {
    manifest, manifestPath: manifestFile, licenseRoot: root,
    items: verified, verifiedCount: verified.length,
    blockedPackages: blocked, blockedCount: blocked.length,
  };
}

function assertThirdPartyNoticeMatchesManifest(text, validation) {
  if (!validation || validation.blockedCount !== 0
      || validation.verifiedCount !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("GenOffice third-party notice cannot be verified against an incomplete license source manifest");
  }
  const separator = "-".repeat(72);
  const sections = text.split(/(?=^-{72}\r?$)/m);
  for (const item of validation.items) {
    const title = item.name + " v" + item.version + " — " + item.spdx;
    const section = sections.find(chunk => {
      const match = new RegExp("^" + separator + "\\r?\\n([^\\r\\n]+)").exec(chunk);
      return match && match[1] === title;
    });
    if (!section || !section.includes(item.licenseText.trimEnd())
        || !section.includes("Source: " + item.licenseSourceUrl)
        || !section.includes("License SHA-256: " + item.licenseTextSha256)) {
      throw new Error("GenOffice packaged notice does not contain exact full license/source material: " + item.name);
    }
  }
  return { matchedCount: validation.items.length };
}

function buildCompleteThirdPartyNotice(sourceText, validation) {
  if (!validation || validation.blockedCount !== 0
      || validation.verifiedCount !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("Cannot generate a complete GenOffice third-party notice while any upstream license text is unresolved");
  }
  const separator = "-".repeat(72);
  const byTitle = new Map(validation.items.map(item => [
    item.name + " v" + item.version + " — " + item.spdx, item,
  ]));
  let found = 0;
  const chunks = sourceText.split(/(?=^-{72}\r?$)/m);
  const replaced = chunks.map(chunk => {
    const match = new RegExp("^" + separator + "\\r?\\n([^\\r\\n]+)\\r?\\n" + separator + "\\r?\\n([\\s\\S]*)$").exec(chunk);
    if (!match) return chunk;
    const item = byTitle.get(match[1]);
    if (!item) return chunk;
    found++;
    return separator + "\n" + match[1] + "\n" + separator + "\n" +
      item.licenseText.trimEnd() + "\n\nSource: " + item.licenseSourceUrl +
      "\nSource version: " + item.licenseSourceVersion +
      "\nLicense SHA-256: " + item.licenseTextSha256 + "\n";
  });
  if (found !== byTitle.size) {
    throw new Error("GenOffice third-party notice package sections do not match the verified source manifest");
  }
  const text = replaced.join("");
  const missing = noticePackagesWithoutLicenseText(text);
  if (missing.length) throw new Error("GenOffice generated notice still has incomplete package license sections: " + missing.join(", "));
  for (const item of validation.items) {
    const title = item.name + " v" + item.version + " — " + item.spdx;
    const section = text.split(/(?=^-{72}\r?$)/m).find(chunk => {
      const match = new RegExp("^" + separator + "\\r?\\n([^\\r\\n]+)").exec(chunk);
      return match && match[1] === title;
    });
    if (!section || !section.includes(item.licenseText.trimEnd())
        || !section.includes("Source: " + item.licenseSourceUrl)
        || !section.includes("License SHA-256: " + item.licenseTextSha256)) {
      throw new Error("GenOffice generated notice failed exact license-text/source verification: " + item.name);
    }
  }
  return text;
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
 * Patch 0013 (ACK native tool results in a hosted turn) changes the Docs
 * renderer transport — that half only exists in the *built* `out/` assets,
 * not in Mcode's own main-process bundle. Vendor outputs built before the
 * patch therefore pass every hash check (they are internally consistent)
 * while the shipped Docs page silently lacks the in-turn ACK. Detect the
 * stale build by the compiled marker, and fail closed instead of packaging
 * a renderer that cannot answer `mcode:docs:ai-tool-result`.
 *
 * Marker = the two renderer-visible names the patch introduces
 * (`window.desktop.aiToolResult` and the `toolResultAck` option). Minified
 * bundles preserve property names, so both must appear in the entry assets.
 */
const DOCS_ACK_MARKERS = Object.freeze(["aiToolResult", "toolResultAck"]);
function assertDocsRendererHasAckTransport(renderer) {
  const html = fs.readFileSync(join(renderer, "index.html"), "utf8");
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(([, src]) => src);
  const sources = entryScripts.map((src) => fs.readFileSync(join(renderer, src), "utf8"));
  // Deferred chunks may carry the transport too; scan them as well so a
  // marker that moved into a lazy asset is not a false failure.
  const assets = join(renderer, "assets");
  const chunks = fs.readdirSync(assets).filter(name => name.endsWith(".js"))
    .map(name => fs.readFileSync(join(assets, name), "utf8"));
  const corpus = [...sources, ...chunks].join("\n");
  const missing = DOCS_ACK_MARKERS.filter(marker => !corpus.includes(marker));
  if (missing.length) {
    throw new Error(
      "GenOffice docs renderer predates patch 0013 (missing " + missing.join(", ") +
      "): the vendor out/ build is older than the reviewed source. Rebuild the six " +
      "vendor renderers from the pinned HEAD before packaging; do not stage a stale build.",
    );
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

function prepareGenofficeResources({ appDir, repoRoot, include = false, includeEditors = false, requireCompleteLicenseBundle = false, licenseManifestPath }) {
  if (typeof include !== "boolean" || typeof includeEditors !== "boolean" || typeof requireCompleteLicenseBundle !== "boolean") {
    throw new TypeError("include, includeEditors and requireCompleteLicenseBundle must be boolean");
  }
  if (licenseManifestPath !== undefined && (typeof licenseManifestPath !== "string" || !licenseManifestPath)) {
    throw new TypeError("licenseManifestPath must be a non-empty path when provided");
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
  const productionRepo = resolve(__dirname, "../../..");
  const isTestFixtureRoot = resolve(repo).toLowerCase() !== productionRepo.toLowerCase();
  const sourceLicenseManifest = licenseManifestPath ? resolve(licenseManifestPath) : null;
  if (completeLicenseBundle && !sourceLicenseManifest && !isTestFixtureRoot) {
    throw new Error("GenOffice strict release staging requires the reviewed third-party license source manifest");
  }
  const sourceLicenseRoot = sourceLicenseManifest ? join(dirname(sourceLicenseManifest), "licenses") : null;
  const licenseValidation = completeLicenseBundle && sourceLicenseManifest
    ? validateGenofficeLicenseManifest({
      manifestPath: sourceLicenseManifest, licenseRoot: sourceLicenseRoot,
      vendorRoot: vendor, repoRoot: repo, requireComplete: true,
    })
    : null;
  const completeThirdPartyNoticeText = licenseValidation
    ? buildCompleteThirdPartyNotice(fs.readFileSync(thirdPartyNotice, "utf8"), licenseValidation)
    : null;
  const chromiumLicenseInfo = completeLicenseBundle ? resolveChromiumLicense(app) : null;
  const legacyLicenses = [
    [join(vendor, "LICENSE"), "GenOffice-LICENSE", undefined, "vendor"],
    [join(vendor, "NOTICE"), "GenOffice-NOTICE", undefined, "vendor"],
    [join(pdfium, "LICENSE"), "PDFium-LICENSE", undefined, "vendor"],
    [join(pdfium, "LICENSE.pdfium"), "PDFium-LICENSE.pdfium", undefined, "vendor"],
  ];
  const licenses = completeLicenseBundle ? [
    ...legacyLicenses,
    [thirdPartyNotice, "GenOffice-THIRD-PARTY-NOTICES.txt", completeThirdPartyNoticeText, "vendor"],
    [chromiumLicenseInfo.path, "LICENSES.chromium.html", undefined, "app"],
    ...(licenseValidation ? [
      [sourceLicenseManifest, "GenOffice-THIRD-PARTY-LICENSES.json", undefined, "mcode"],
      ...licenseValidation.items.map(item => [
        item.licensePath, "GenOffice-Third-Party-Licenses/" + item.licenseFile, undefined, "mcode",
      ]),
    ] : []),
  ] : legacyLicenses;
  // Validate the entire input BEFORE touching a previous stage.
  // Vite renderer assets are source-built vendor files; never package an
  // incomplete subset (or a symlink to arbitrary workstation/private files).
  const editors = EDITOR_APPS.map((name) => ({
    name, renderer: join(vendor, "apps", name, "out", "renderer"),
  }));
  const nativePreloads = NATIVE_PRELOAD_KINDS.map(name => ({
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
    assertDocsRendererHasAckTransport(join(vendor, "apps", "docs", "out", "renderer"));
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
    const vendorFiles = [cli, nodeModules, wasm, ...licenses
      .filter(([, , , origin]) => origin === "vendor" || origin === undefined)
      .map(([file]) => file)];
    for (const file of vendorFiles) {
      assertNativeVendorPath(vendor, file);
      // A vendor's symlink/junction must not redirect the build to arbitrary
      // machine-private files outside the known checkout.
      assertWithin(repo, fs.realpathSync.native(file));
    }
    if (chromiumLicenseInfo) assertNativeVendorPath(app, chromiumLicenseInfo.path);
    for (const [file, , , origin] of licenses.filter(([, , , origin]) => origin === "mcode")) {
      assertNativeVendorPath(repo, file);
    }
    if (completeLicenseBundle) {
      if (completeThirdPartyNoticeText) assertThirdPartyNoticeTextComplete(completeThirdPartyNoticeText);
      else assertThirdPartyNoticeComplete(thirdPartyNotice);
    }
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
      for (const [file, name, content] of licenses) {
        const target = join(temp, "licenses", name);
        fs.mkdirSync(dirname(target), { recursive: true });
        if (typeof content === "string") fs.writeFileSync(target, content, "utf8");
        else fs.copyFileSync(file, target);
      }
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
        licenseBundleVersion: licenseValidation ? 3 : requireCompleteLicenseBundle ? 2 : 1,
        licenseAssetsSha256: Object.fromEntries(licenses.map(([, name]) => [
          name, hashFile(join(temp, "licenses", name)),
        ])),
        ...(licenseValidation ? {
          licenseSourceManifestSha256: hashFile(join(temp, "licenses", "GenOffice-THIRD-PARTY-LICENSES.json")),
          licenseSourcePackageCount: licenseValidation.verifiedCount,
        } : {}),
        ...(completeLicenseBundle && !licenseValidation && isTestFixtureRoot ? { licenseBundleTestFixture: true } : {}),
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
      licenseManifestPath: join(__dirname, "vendor-licenses", "genoffice", "manifest.json"),
    });
    console.log(`GenOffice release sidecar: ${result.bundled ? "CLI staged" : "not included"}; original editors: ${result.editorsBundled ? "six staged" : "not included"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = {
  prepareGenofficeResources, assertWithin, assertVendorTreeSafe, assertRendererAssetsReady,
  assertDocsRendererHasAckTransport, hashResourceTree, hashRendererTree, hashFile,
  noticePackagesWithoutLicenseText, assertThirdPartyNoticeComplete, assertThirdPartyNoticeTextComplete,
  assertThirdPartyNoticeMatchesManifest, resolveChromiumLicense, validateGenofficeLicenseManifest,
  buildCompleteThirdPartyNotice, REQUIRED_GENOFFICE_LICENSE_PACKAGES, EDITOR_APPS, NATIVE_PRELOAD_KINDS,
  DOCS_ACK_MARKERS,
};
