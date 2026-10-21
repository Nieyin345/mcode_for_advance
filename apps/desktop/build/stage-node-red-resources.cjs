"use strict";
/**
 * T19: reproducible Node-RED 5.0.8 vendor release payload.
 * Isolated clone (gitignored) is the source of truth, never a host-side npm install.
 * This stages the original built editor, upstream Node-RED packages and a clean
 * production-only npm dependency tree outside ASAR. No user data is accessed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const BASE_COMMIT = "935b8d3e12ec8be064f3a72ac6547131f778a7b1";
const VERSION = "5.0.8";
const URL = "https://github.com/node-red/node-red.git";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) {
    throw new Error("Node-RED staging command failed: " + command + " " + args.join(" ") + ": " + (result.error?.message || result.status));
  }
}
function gitOutput(vendor, ...args) {
  const result = spawnSync("git", ["-C", vendor, ...args], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("Node-RED checkout inspection failed: " + result.stderr);
  return result.stdout.trim();
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
function hashTree(root, namespace) {
  const hash = createHash("sha256");
  hash.update(namespace + "\0");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  function visit(dir, subpath = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = subpath ? subpath + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Node-RED release tree symlink denied: " + rel);
      if (entry.isDirectory()) { visit(full, rel); continue; }
      if (!entry.isFile()) throw new Error("Node-RED release tree unsupported filesystem object: " + rel);
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
        if (bytes !== size) throw new Error("Node-RED release file changed during hash: " + rel);
      } finally {
        fs.closeSync(fd);
      }
      hash.update("\0");
    }
  }
  visit(root);
  return hash.digest("hex");
}
const LICENSE_TEXT_NAME = /^(license|licence|copying)(\..*)?$/i;
const LICENSE_RESOURCE_NAME = /^(license|licence|copying|notice)(\..*)?$/i;
function safePackageJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Node-RED license inventory package metadata invalid: " + file);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function collectPackageEntries(root, modulesRelative, lock) {
  const found = [];
  const rootModules = path.join(root, ...modulesRelative.split("/"));
  function scanModules(modulesDir, relativeModules) {
    const rootStat = fs.lstatSync(modulesDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Node-RED license inventory dependency root unsafe: " + modulesDir);
    }
    const entries = fs.readdirSync(modulesDir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
      const full = path.join(modulesDir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("Node-RED license inventory symlink denied: " + full);
      if (!stat.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(full, { withFileTypes: true })
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          if (!scoped.isDirectory()) throw new Error("Node-RED scoped package entry invalid: " + path.join(full, scoped.name));
          const packageDir = path.join(full, scoped.name);
          const packagePath = relativeModules + "/" + entry.name + "/" + scoped.name;
          addPackage(packageDir, packagePath);
        }
      } else {
        addPackage(full, relativeModules + "/" + entry.name);
      }
    }
  }
  function addPackage(packageDir, packagePath) {
    const stat = fs.lstatSync(packageDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Node-RED package directory unsafe: " + packageDir);
    const metadataFile = path.join(packageDir, "package.json");
    const pkg = safePackageJson(metadataFile);
    if (typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version) {
      throw new Error("Node-RED package name/version missing: " + metadataFile);
    }
    const licenseFiles = [];
    for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
      if (!entry.isFile() || !LICENSE_RESOURCE_NAME.test(entry.name)) continue;
      const file = path.join(packageDir, entry.name);
      const fileStat = fs.lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0) {
        throw new Error("Node-RED package license/notice file invalid: " + file);
      }
      licenseFiles.push({
        name: entry.name,
        path: packagePath + "/" + entry.name,
        sha256: hashFile(file),
        size: fileStat.size,
        licenseText: LICENSE_TEXT_NAME.test(entry.name),
      });
    }
    licenseFiles.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const lockEntry = packagePath.startsWith("node_modules/") ? lock.packages?.[packagePath] : null;
    const packageLicense = pkg.license ?? pkg.licenses ?? null;
    const lockLicense = lockEntry?.license ?? null;
    const license = packageLicense ?? lockLicense;
    const licenseMetadataConflict = packageLicense != null && lockLicense != null
      && JSON.stringify(packageLicense) !== JSON.stringify(lockLicense);
    const lockEntryMissing = packagePath.startsWith("node_modules/") && !lockEntry;
    const lockVersionMismatch = Boolean(lockEntry?.version && lockEntry.version !== pkg.version);
    const licenseTextPresent = licenseFiles.some(file => file.licenseText);
    let status = "collected";
    if (!license) status = "unknown-license";
    else if (licenseMetadataConflict) status = "license-metadata-conflict";
    else if (lockEntryMissing || lockVersionMismatch) status = "lock-mismatch";
    else if (!licenseTextPresent) status = "license-text-missing";
    found.push({
      name: pkg.name,
      version: pkg.version,
      path: packagePath,
      packageJsonSha256: hashFile(metadataFile),
      packageLicense,
      lockLicense,
      license,
      licenseMetadataConflict,
      lockEntryMissing,
      lockVersionMismatch,
      licenseTextPresent,
      licenseFiles,
      status,
    });
    const nestedModules = path.join(packageDir, "node_modules");
    if (fs.existsSync(nestedModules)) scanModules(nestedModules, packagePath + "/node_modules");
  }
  scanModules(rootModules, modulesRelative);
  return found;
}
function createNodeRedLicenseInventory(root) {
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const packages = [
    ...collectPackageEntries(root, "node_modules", lock),
    ...collectPackageEntries(root, "packages/node_modules", lock),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const unknownLicenseMetadata = packages.filter(item => !item.license).length;
  const missingLicenseText = packages.filter(item => !item.licenseTextPresent).length;
  const conflictingLicenseMetadata = packages.filter(item => item.licenseMetadataConflict).length;
  const missingLockEntries = packages.filter(item => item.lockEntryMissing).length;
  const lockVersionMismatches = packages.filter(item => item.lockVersionMismatch).length;
  const releaseEligible = unknownLicenseMetadata === 0 && missingLicenseText === 0
    && conflictingLicenseMetadata === 0 && missingLockEntries === 0 && lockVersionMismatches === 0;
  return {
    format: "mcode.node-red.third-party-license-inventory.v1",
    inventoryType: "license-coverage-audit-not-sbom",
    sourceCommit: BASE_COMMIT,
    packageLockSha256: hashFile(lockPath),
    packages,
    summary: {
      packageCount: packages.length,
      unknownLicenseMetadata,
      missingLicenseText,
      conflictingLicenseMetadata,
      missingLockEntries,
      lockVersionMismatches,
      releaseEligible,
    },
  };
}
function writeNodeRedLicenseInventory(root) {
  const inventory = createNodeRedLicenseInventory(root);
  const target = path.join(root, "third-party-license-inventory.json");
  fs.writeFileSync(target, JSON.stringify(inventory, null, 2) + "\n", "utf8");
  return { inventory, sha256: hashFile(target) };
}
function assertFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error("Node-RED release file missing/empty: " + file);
  }
}
function assertSafeTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Node-RED release dependency symlink denied: " + path.join(root, entry.name));
    if (entry.isDirectory()) assertSafeTree(path.join(root, entry.name));
    else if (!entry.isFile()) throw new Error("Node-RED unsupported release file type: " + entry.name);
  }
}
function prepareNodeRedResources({ appDir, repoRoot, install = true } = {}) {
  const app = path.resolve(appDir);
  const vendor = path.join(path.resolve(repoRoot), "node-red");
  const destination = path.join(app, ".tmp", "node-red-release");
  if (!fs.existsSync(vendor)) {
    if (!install) throw new Error("Node-RED vendor checkout missing: " + vendor);
    run("git", ["clone", "--depth", "1", "--branch", VERSION, URL, vendor], path.resolve(repoRoot));
    run("git", ["-C", vendor, "checkout", "-b", "mcode/integration", BASE_COMMIT], path.resolve(repoRoot));
  }
  const commit = gitOutput(vendor, "rev-parse", "HEAD");
  if (commit !== BASE_COMMIT) throw new Error("Node-RED vendor commit mismatch: " + commit);
  if (gitOutput(vendor, "status", "--porcelain", "--untracked-files=all") !== "") {
    throw new Error("Node-RED vendor tracked files are modified; refusing release");
  }
  const packages = path.join(vendor, "packages", "node_modules");
  const pkg = path.join(packages, "node-red", "package.json");
  const editor = path.join(packages, "@node-red", "editor-client", "public", "red", "red.min.js");
  const rootLicense = path.join(vendor, "LICENSE");
  const rootLock = path.join(vendor, "package-lock.json");
  for (const file of [pkg, rootLicense, rootLock]) assertFile(file);
  const meta = JSON.parse(fs.readFileSync(pkg, "utf8"));
  if (meta.name !== "node-red" || meta.version !== VERSION) throw new Error("Node-RED source version mismatch");
  if (install) {
    run("npm", ["ci", "--no-audit", "--no-fund"], vendor);
    run("npm", ["run", "build"], vendor);
  }
  assertFile(editor);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(destination), ".node-red-stage-"));
  const backup = destination + ".old-" + randomUUID();
  let previous = false;
  try {
    // Production-only dependency installation in scratch (never prune vendor).
    fs.mkdirSync(path.join(tmp, "_npm"), { recursive: true });
    fs.copyFileSync(path.join(vendor, "package.json"), path.join(tmp, "_npm", "package.json"));
    fs.copyFileSync(rootLock, path.join(tmp, "_npm", "package-lock.json"));
    if (install) run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(tmp, "_npm"));
    else throw new Error("Node-RED release production dependencies require npm ci");
    const production = path.join(tmp, "_npm", "node_modules");
    assertFile(path.join(production, "express", "package.json"));
    // npm may create .bin links: those are not needed to require production packages.
    fs.cpSync(production, path.join(tmp, "node_modules"), {
      recursive: true, filter: (source) => path.basename(source) !== ".bin", dereference: false,
    });
    fs.rmSync(path.join(tmp, "_npm"), { recursive: true, force: true });
    fs.cpSync(packages, path.join(tmp, "packages", "node_modules"), { recursive: true, dereference: false });
    fs.copyFileSync(rootLicense, path.join(tmp, "LICENSE"));
    fs.copyFileSync(rootLock, path.join(tmp, "package-lock.json"));
    assertSafeTree(path.join(tmp, "packages"));
    assertSafeTree(path.join(tmp, "node_modules"));
    const packageTreeSha256 = hashTree(path.join(tmp, "packages"), "mcode.node-red.packages.tree.v1");
    const dependenciesTreeSha256 = hashTree(path.join(tmp, "node_modules"), "mcode.node-red.dependencies.tree.v1");
    const licenseInventory = writeNodeRedLicenseInventory(tmp);
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
      format: "mcode.node-red.release.v1", version: VERSION, sourceCommit: BASE_COMMIT,
      editorSha256: hashFile(path.join(tmp, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js")),
      packageSha256: hashFile(path.join(tmp, "packages", "node_modules", "node-red", "package.json")),
      lockSha256: hashFile(path.join(tmp, "package-lock.json")),
      licenseSha256: hashFile(path.join(tmp, "LICENSE")),
      licenseInventorySha256: licenseInventory.sha256,
      packageTreeSha256,
      dependenciesTreeSha256,
    }, null, 2) + "\n");
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); previous = true; }
    try { fs.renameSync(tmp, destination); }
    catch (error) { if (previous) fs.renameSync(backup, destination); throw error; }
    if (previous) fs.rmSync(backup, { recursive: true, force: true });
    return destination;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    const staged = prepareNodeRedResources({
      appDir: path.resolve(__dirname, ".."), repoRoot: path.resolve(__dirname, "../../.."),
    });
    const inventory = JSON.parse(fs.readFileSync(path.join(staged, "third-party-license-inventory.json"), "utf8"));
    console.log("Node-RED third-party license coverage:", JSON.stringify(inventory.summary));
    if (!inventory.summary.releaseEligible) {
      console.warn("Node-RED release afterPack gate will reject unresolved third-party license coverage:");
      for (const item of inventory.packages.filter(item => item.status !== "collected")) {
        console.warn("  " + item.name + "@" + item.version + " [" + item.status + "] " + item.path);
      }
    }
    console.log("Staged Node-RED vendor:", staged);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
module.exports = {
  prepareNodeRedResources, hashFile, hashTree, assertSafeTree, createNodeRedLicenseInventory,
  writeNodeRedLicenseInventory, BASE_COMMIT, VERSION,
};
