"use strict";
/**
 * ARC-007: opt-in GenOffice CLI release staging.
 *
 * Default CI installs must remain buildable without the ignored vendor checkout,
 * and must never silently ship an incomplete/stale GenOffice sidecar. Explicit
 * MCODE_INCLUDE_GENOFFICE_BUNDLE=1 requires a reviewed local vendor snapshot.
 * We stage only its CLI bundle, CLI runtime dependencies, PDFium WASM and
 * redistribution notices (not its separate Electron application/agent loop).
 *
 * electron-builder extraResources copies .tmp/genoffice-release => resources/genoffice.
 * All paths are app-local; never write to the user's Electron data directory.
 */
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { isAbsolute, join, resolve, relative, sep } = require("node:path");

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
function prepareGenofficeResources({ appDir, repoRoot, include = false }) {
  if (typeof include !== "boolean") throw new TypeError("include must be boolean");
  const app = resolve(appDir);
  const repo = resolve(repoRoot);
  const tmp = join(app, ".tmp");
  const destination = join(tmp, "genoffice-release");
  const vendor = join(repo, "genoffice");
  const cli = join(vendor, "packages", "cli", "dist", "genoffice.cjs");
  const nodeModules = join(vendor, "packages", "cli", "dist", "node_modules");
  const pdfium = join(vendor, "node_modules", "@embedpdf", "pdfium");
  const wasm = join(pdfium, "dist", "pdfium.wasm");
  const licenses = [
    [join(vendor, "LICENSE"), "GenOffice-LICENSE"],
    [join(vendor, "NOTICE"), "GenOffice-NOTICE"],
    [join(pdfium, "LICENSE"), "PDFium-LICENSE"],
    [join(pdfium, "LICENSE.pdfium"), "PDFium-LICENSE.pdfium"],
  ];
  // Validate the entire input BEFORE touching a previous stage.
  if (include) {
    fileReady(cli, "CLI");
    dirReady(nodeModules, "CLI node_modules");
    assertVendorTreeSafe(repo, nodeModules);
    fileReady(wasm, "PDFium WASM");
    if (fs.readFileSync(wasm).subarray(0, 4).toString("hex") !== "0061736d") {
      throw new Error("GenOffice PDFium WASM is not a WASM binary");
    }
    for (const [file, name] of licenses) fileReady(file, name);
    for (const path of [cli, nodeModules, wasm, ...licenses.map(([f]) => f)]) {
      // A vendor's symlink/junction must not redirect the build to arbitrary
      // machine-private files outside the known checkout.
      assertWithin(repo, fs.realpathSync.native(path));
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
      for (const [file, name] of licenses) fs.copyFileSync(file, join(temp, "licenses", name));
    }
    fs.writeFileSync(join(temp, "availability.json"), JSON.stringify({
      format: "mcode.genoffice.resources.v1",
      bundled: include,
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
    return { bundled: include, resourceDirectory: destination };
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
    const appDir = resolve(__dirname, "..");
    const result = prepareGenofficeResources({
      appDir, repoRoot: resolve(appDir, "../.."), include: setting === "1",
    });
    console.log(`GenOffice release sidecar: ${result.bundled ? "OPT-IN staged (verify licenses before publication)" : "not included (explicit unavailable)"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = { prepareGenofficeResources, assertWithin };
