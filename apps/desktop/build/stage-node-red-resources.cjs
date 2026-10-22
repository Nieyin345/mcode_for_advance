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

const KNOWN_SPDX_LICENSE_IDS = new Set([
  "0BSD", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "BlueOak-1.0.0", "CC-BY-3.0", "CC0-1.0", "ISC", "MIT", "Python-2.0",
]);
const KNOWN_SPDX_EXCEPTION_IDS = new Set([
  "Autoconf-exception-2.0", "Autoconf-exception-3.0", "Bison-exception-2.2",
  "Bootloader-exception", "Classpath-exception-2.0", "Font-exception-2.0",
  "GCC-exception-2.0", "GCC-exception-3.1", "LLVM-exception", "Linux-syscall-note",
  "OpenSSL-exception", "Qt-GPL-exception-1.0", "Qt-LGPL-exception-1.1",
  "Universal-FOSS-exception-1.0", "WxWindows-exception-3.1",
]);

function normalizeLicenseValue(value) {
  if (typeof value === "string") {
    const expression = value.trim();
    if (!expression) return null;
    return expression === "Apache 2.0" ? "Apache-2.0" : expression;
  }
  if (Array.isArray(value)) {
    const expressions = value.map((item) => normalizeLicenseValue(
      item && typeof item === "object" ? (item.type ?? item.name ?? null) : item
    )).filter(Boolean);
    if (!expressions.length) return null;
    return expressions.length === 1 ? expressions[0] : "(" + expressions.join(" OR ") + ")";
  }
  if (value && typeof value === "object") {
    return normalizeLicenseValue(value.type ?? value.name ?? null);
  }
  return null;
}

function parseSpdxExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("SPDX license expression is missing");
  }
  const text = expression.trim();
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9.-]*|[()]/g) || [];
  if (!tokens.length || tokens.join("") !== text.replace(/\s+/g, "")) {
    throw new Error("Invalid SPDX license expression: " + expression);
  }
  let index = 0;
  function primary() {
    const token = tokens[index++];
    if (token === "(") {
      const value = orExpression();
      if (tokens[index++] !== ")") throw new Error("Unbalanced SPDX expression: " + expression);
      return { licenseIds: value.licenseIds, exceptionIds: value.exceptionIds, simple: false };
    }
    if (!token || token === ")" || token === "AND" || token === "OR" || token === "WITH") {
      throw new Error("Invalid SPDX license expression: " + expression);
    }
    if (!KNOWN_SPDX_LICENSE_IDS.has(token)) {
      throw new Error("Unknown SPDX license identifier: " + token);
    }
    return { licenseIds: [token], exceptionIds: [], simple: true };
  }
  function withExpression() {
    const value = primary();
    if (tokens[index] === "WITH") {
      if (!value.simple) throw new Error("SPDX WITH must follow one license identifier: " + expression);
      index++;
      const exception = tokens[index++];
      if (!exception || !KNOWN_SPDX_EXCEPTION_IDS.has(exception)) {
        throw new Error("Unknown SPDX exception identifier: " + exception);
      }
      value.exceptionIds.push(exception);
    }
    return value;
  }
  function andExpression() {
    let value = withExpression();
    while (tokens[index] === "AND") {
      index++;
      const next = withExpression();
      value = {
        licenseIds: [...value.licenseIds, ...next.licenseIds],
        exceptionIds: [...value.exceptionIds, ...next.exceptionIds],
        simple: false,
      };
    }
    return value;
  }
  function orExpression() {
    let value = andExpression();
    while (tokens[index] === "OR") {
      index++;
      const next = andExpression();
      value = {
        licenseIds: [...value.licenseIds, ...next.licenseIds],
        exceptionIds: [...value.exceptionIds, ...next.exceptionIds],
        simple: false,
      };
    }
    return value;
  }
  const parsed = orExpression();
  if (index !== tokens.length) throw new Error("Invalid SPDX license expression: " + expression);
  return {
    licenseIds: [...new Set(parsed.licenseIds)],
    exceptionIds: [...new Set(parsed.exceptionIds)],
  };
}

function licensePackageKey(name, version) {
  return name + "@" + version;
}

function safeLicenseMaterialPath(root, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
      || relative.split(/[\\/]+/).some((part) => part === ".." || part === ".")) {
    throw new Error("Node-RED license material path is unsafe: " + relative);
  }
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(absoluteRoot, relative);
  const rel = path.relative(absoluteRoot, absoluteFile);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Node-RED license material path escapes root: " + relative);
  }
  let current = absoluteRoot;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      throw new Error("Node-RED license material is missing: " + (label || relative) + " (" + rel + ")");
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Node-RED license material symlink denied: " + current);
  }
  const stat = fs.lstatSync(absoluteFile);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("Node-RED license material missing/empty: " + (label || relative));
  }
  return absoluteFile;
}

function renderNodeRedLicenseNotice(manifest, licenseRoot) {
  const lines = [
    "Node-RED " + manifest.nodeRedVersion + " third-party license materials",
    "Node-RED source commit: " + manifest.nodeRedSourceCommit,
    "Document type: third-party license coverage notice; this is not an SBOM.",
    "Each package mapping is version-bound. License texts are reproduced below from the cited sources.",
    "",
  ];
  for (const entry of manifest.entries) {
    lines.push(
      "================================================================================",
      "Package: " + entry.packageName + "@" + entry.version,
      "SPDX license expression: " + entry.licenseExpression,
      "Package metadata: " + entry.packageSource.registryMetadataUrl,
      "Package source revision: " + entry.packageSource.revision
    );
    if (entry.licenseSourceNote) lines.push("Source note: " + entry.licenseSourceNote);
    if (entry.metadataOverride) {
      lines.push("Reviewed metadata override: " + entry.metadataOverride.reason);
      lines.push("Override evidence: " + entry.metadataOverride.sourceUrl + " @ " + entry.metadataOverride.sourceRevision);
    }
    for (const material of entry.materials) {
      const file = safeLicenseMaterialPath(licenseRoot, material.path, material.sourceFileName);
      const body = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
      lines.push(
        "",
        "--------------------------------------------------------------------------------",
        "License identifier: " + material.licenseId,
        "Original file name: " + material.sourceFileName,
        "Source URL: " + material.sourceUrl,
        "Source revision: " + material.sourceRevision,
        "Local SHA-256: " + material.sha256,
        "",
        body,
        ""
      );
    }
    lines.push("");
  }
  for (const blocker of manifest.blockers) {
    lines.push(
      "================================================================================",
      "RELEASE BLOCKER: " + blocker.packageName + "@" + blocker.version,
      "License expression: UNKNOWN (not inferred)",
      "Evidence: " + blocker.packageSource.registryMetadataUrl,
      "Published package file list: " + blocker.packageSource.unpkgFileListUrl,
      "Reason: " + blocker.reason,
      ""
    );
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

function readNodeRedLicenseManifest(root) {
  const licenseRoot = path.join(path.resolve(root), "licenses", "node-red");
  const manifestPath = path.join(licenseRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const rootStat = fs.lstatSync(licenseRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Node-RED third-party license root is unsafe: " + licenseRoot);
  }
  assertSafeTree(licenseRoot);
  const parsedManifest = JSON.parse(fs.readFileSync(
    safeLicenseMaterialPath(licenseRoot, "manifest.json", "license source manifest"), "utf8"
  ));
  if (parsedManifest.format !== "mcode.node-red.third-party-license-source-manifest.v1"
      || parsedManifest.nodeRedVersion !== VERSION
      || parsedManifest.nodeRedSourceCommit !== BASE_COMMIT
      || parsedManifest.inventoryType !== "license-coverage-audit-not-sbom"
      || !Array.isArray(parsedManifest.entries) || !Array.isArray(parsedManifest.blockers)) {
    throw new Error("Node-RED third-party license source manifest is invalid or for the wrong upstream revision");
  }
  const entryByKey = new Map();
  const blockerByKey = new Map();
  for (const entry of parsedManifest.entries) {
    const key = licensePackageKey(entry.packageName, entry.version);
    if (!entry.packageName || !entry.version || entryByKey.has(key) || blockerByKey.has(key)
        || typeof entry.licenseExpression !== "string" || !entry.packageSource
        || typeof entry.packageSource.registryMetadataUrl !== "string"
        || !entry.packageSource.registryMetadataUrl.startsWith("https://")
        || typeof entry.packageSource.tarballUrl !== "string"
        || !entry.packageSource.tarballUrl.startsWith("https://")
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.packageSource.tarballIntegrity || "")
        || typeof entry.packageSource.repositoryUrl !== "string"
        || !entry.packageSource.repositoryUrl.startsWith("https://")
        || !/^[a-f0-9]{40}$/.test(entry.packageSource.revision || "")
        || !Array.isArray(entry.materials) || !entry.materials.length) {
      throw new Error("Node-RED license source entry is invalid or duplicated: " + key);
    }
    const expression = parseSpdxExpression(entry.licenseExpression);
    const expectedIds = [...new Set(expression.licenseIds)].sort();
    const materialIds = [];
    for (const material of entry.materials) {
      if (!material || typeof material.licenseId !== "string"
          || typeof material.sourceUrl !== "string" || !material.sourceUrl.startsWith("https://")
          || !/^[a-f0-9]{40}$/.test(material.sourceRevision || "")
          || typeof material.sourceFileName !== "string" || !material.sourceFileName
          || typeof material.path !== "string" || !material.path.startsWith("materials/")
          || !/^[a-f0-9]{64}$/.test(material.sha256 || "")) {
        throw new Error("Node-RED license material metadata is invalid: " + key);
      }
      const file = safeLicenseMaterialPath(licenseRoot, material.path, key + " " + material.sourceFileName);
      if (hashFile(file) !== material.sha256) {
        throw new Error("Node-RED license material SHA-256 mismatch: " + key + " " + material.path);
      }
      materialIds.push(material.licenseId);
    }
    if (new Set(materialIds).size !== materialIds.length
        || JSON.stringify([...materialIds].sort()) !== JSON.stringify(expectedIds)) {
      throw new Error("Node-RED license materials do not cover the exact SPDX expression: " + key);
    }
    if (entry.materials.some((material) => material.sourceRevision !== entry.packageSource.revision)
        && (typeof entry.licenseSourceNote !== "string" || !entry.licenseSourceNote.trim())) {
      throw new Error("Node-RED license source revision differs from package revision without an evidence note: " + key);
    }
    if (entry.metadataOverride) {
      const override = entry.metadataOverride;
      const evidence = entry.materials.find((material) => material.sourceFileName === override.fileName
        && material.sourceUrl === override.sourceUrl && material.sourceRevision === override.sourceRevision
        && material.sha256 === override.sha256);
      if (override.reviewed !== true || override.licenseExpression !== entry.licenseExpression
          || typeof override.reason !== "string" || !override.reason
          || typeof override.fileName !== "string"
          || (override.licenseTextFile !== undefined && typeof override.licenseTextFile !== "boolean")
          || (override.licenseTextFile === false && !entry.licenseSourceNote)
          || !evidence) {
        throw new Error("Node-RED license metadata override is not explicitly reviewed/evidenced: " + key);
      }
    }
    entryByKey.set(key, { ...entry, parsedExpression: expression });
  }
  for (const blocker of parsedManifest.blockers) {
    const key = licensePackageKey(blocker.packageName, blocker.version);
    if (!blocker.packageName || !blocker.version || entryByKey.has(key) || blockerByKey.has(key)
        || blocker.status !== "release-blocker" || blocker.licenseExpression !== null
        || typeof blocker.reason !== "string" || !blocker.reason || !blocker.packageSource
        || typeof blocker.packageSource.registryMetadataUrl !== "string"
        || !blocker.packageSource.registryMetadataUrl.startsWith("https://")
        || typeof blocker.packageSource.unpkgFileListUrl !== "string"
        || !blocker.packageSource.unpkgFileListUrl.startsWith("https://")
        || typeof blocker.packageSource.tarballUrl !== "string"
        || !blocker.packageSource.tarballUrl.startsWith("https://")
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(blocker.packageSource.tarballIntegrity || "")
        || blocker.packageSource.revision !== null) {
      throw new Error("Node-RED license release blocker entry is invalid: " + key);
    }
    blockerByKey.set(key, blocker);
  }
  const noticePath = safeLicenseMaterialPath(licenseRoot, "THIRD-PARTY-LICENSES.txt", "third-party license notice");
  if (fs.readFileSync(noticePath, "utf8") !== renderNodeRedLicenseNotice(parsedManifest, licenseRoot)) {
    throw new Error("Node-RED third-party license notice differs from reviewed manifest/materials");
  }
  return {
    manifest: parsedManifest,
    licenseRoot,
    entryByKey,
    blockerByKey,
    usedEntries: new Set(),
    usedBlockers: new Set(),
  };
}
function safePackageJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Node-RED license inventory package metadata invalid: " + file);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function collectPackageEntries(root, modulesRelative, lock, licenseManifestContext) {
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
    const lockEntry = packagePath.startsWith("node_modules/") ? lock.packages?.[packagePath] : null;
    const packageLicense = pkg.license ?? pkg.licenses ?? null;
    const lockLicense = lockEntry?.license ?? null;
    let license = packageLicense ?? lockLicense;
    let licenseExpression = normalizeLicenseValue(license);
    const packageLicenseExpression = normalizeLicenseValue(packageLicense);
    const lockLicenseExpression = normalizeLicenseValue(lockLicense);
    const licenseMetadataConflict = packageLicense != null && lockLicense != null
      && packageLicenseExpression !== lockLicenseExpression;
    const lockEntryMissing = packagePath.startsWith("node_modules/") && !lockEntry;
    const lockVersionMismatch = Boolean(lockEntry?.version && lockEntry.version !== pkg.version);
    const packageKey = licensePackageKey(pkg.name, pkg.version);
    const externalEntry = licenseManifestContext?.entryByKey.get(packageKey) || null;
    const releaseBlocker = licenseManifestContext?.blockerByKey.get(packageKey) || null;
    const packageSourceRecord = externalEntry || releaseBlocker;
    let packageSourceLockMismatch = false;
    let packageSourceLockStatus = "not-mapped";
    if (packageSourceRecord) {
      if (!lockEntry) {
        packageSourceLockMismatch = true;
        packageSourceLockStatus = "missing-lock-entry";
      } else if (lockEntry.resolved || lockEntry.integrity) {
        if (lockEntry.resolved !== packageSourceRecord.packageSource.tarballUrl
            || lockEntry.integrity !== packageSourceRecord.packageSource.tarballIntegrity) {
          packageSourceLockMismatch = true;
          packageSourceLockStatus = "lock-artifact-mismatch";
        } else {
          packageSourceLockStatus = "lock-pinned";
        }
      } else if (packagePath.startsWith("node_modules/npm/node_modules/")) {
        const npmLockEntry = lock.packages?.["node_modules/npm"];
        if (npmLockEntry?.resolved && npmLockEntry?.integrity && npmLockEntry?.version) {
          packageSourceLockStatus = "bundled-under-npm@" + npmLockEntry.version;
        } else {
          packageSourceLockMismatch = true;
          packageSourceLockStatus = "bundled-parent-not-lock-pinned";
        }
      } else {
        packageSourceLockMismatch = true;
        packageSourceLockStatus = "lock-artifact-pin-missing";
      }
    }
    let externalLicenseMetadataMismatch = false;
    let licenseMetadataOverride = null;
    if (externalEntry) {
      licenseManifestContext.usedEntries.add(packageKey);
      if (externalEntry.metadataOverride) {
        if (packageLicense != null || lockLicense != null) {
          if (licenseExpression !== externalEntry.licenseExpression) externalLicenseMetadataMismatch = true;
        } else {
          license = externalEntry.licenseExpression;
          licenseExpression = externalEntry.licenseExpression;
          licenseMetadataOverride = externalEntry.metadataOverride;
        }
        const overrideFile = path.join(packageDir, externalEntry.metadataOverride.fileName);
        const overrideIsLicenseTextFile = externalEntry.metadataOverride.licenseTextFile !== false;
        if (!fs.existsSync(overrideFile) || !fs.lstatSync(overrideFile).isFile()
            || hashFile(overrideFile) !== externalEntry.metadataOverride.sha256) {
          throw new Error("Node-RED reviewed license metadata override file mismatch: " + packageKey);
        }
        if (overrideIsLicenseTextFile
            && !licenseFiles.some((file) => file.name === externalEntry.metadataOverride.fileName
              && file.sha256 === externalEntry.metadataOverride.sha256 && file.licenseText)) {
          throw new Error("Node-RED reviewed license metadata override file mismatch: " + packageKey);
        }
      } else if (!licenseExpression
          || licenseExpression.replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1")
            !== externalEntry.licenseExpression.replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1")) {
        externalLicenseMetadataMismatch = true;
      }
      for (const material of externalEntry.materials) {
        const file = safeLicenseMaterialPath(licenseManifestContext.licenseRoot, material.path, packageKey);
        const fileStat = fs.statSync(file);
        licenseFiles.push({
          name: material.sourceFileName,
          path: "licenses/node-red/" + material.path,
          sha256: material.sha256,
          size: fileStat.size,
          licenseText: true,
          external: true,
          licenseId: material.licenseId,
          sourceUrl: material.sourceUrl,
          sourceRevision: material.sourceRevision,
        });
      }
    }
    if (releaseBlocker) licenseManifestContext.usedBlockers.add(packageKey);
    let parsedSpdx = null;
    let unknownSpdxExpression = false;
    if (licenseExpression) {
      try {
        parsedSpdx = parseSpdxExpression(licenseExpression);
      } catch {
        unknownSpdxExpression = true;
      }
    }
    const localLicenseTextPresent = licenseFiles.some((file) => file.licenseText && !file.external);
    const externalLicenseIds = new Set((externalEntry?.materials || []).map((material) => material.licenseId));
    const externalLicenseTextPresent = Boolean(parsedSpdx && externalEntry && !externalLicenseMetadataMismatch
      && parsedSpdx.licenseIds.every((id) => externalLicenseIds.has(id)));
    const licenseTextPresent = localLicenseTextPresent || externalLicenseTextPresent;
    licenseFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    let status = "collected";
    if (!license) status = "unknown-license";
    else if (unknownSpdxExpression) status = "unknown-spdx-license";
    else if (licenseMetadataConflict || externalLicenseMetadataMismatch) status = "license-metadata-conflict";
    else if (lockEntryMissing || lockVersionMismatch || packageSourceLockMismatch) status = "lock-mismatch";
    else if (!licenseTextPresent) status = "license-text-missing";
    if (releaseBlocker) status = "release-blocker";
    found.push({
      name: pkg.name,
      version: pkg.version,
      path: packagePath,
      packageJsonSha256: hashFile(metadataFile),
      packageLicense,
      lockLicense,
      license,
      licenseExpression,
      licenseMetadataConflict,
      externalLicenseMetadataMismatch,
      unknownSpdxExpression,
      licenseMetadataOverride,
      releaseBlocker: releaseBlocker ? { status: releaseBlocker.status, reason: releaseBlocker.reason } : null,
      externalLicenseMapping: externalEntry ? {
        licenseExpression: externalEntry.licenseExpression,
        materialCount: externalEntry.materials.length,
        packageSourceRevision: externalEntry.packageSource.revision,
      } : null,
      lockEntryMissing,
      lockVersionMismatch,
      packageSourceLockMismatch,
      packageSourceLockStatus,
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
  const licenseManifestContext = readNodeRedLicenseManifest(root);
  const packages = [
    ...collectPackageEntries(root, "node_modules", lock, licenseManifestContext),
    ...collectPackageEntries(root, "packages/node_modules", lock, licenseManifestContext),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const unknownLicenseMetadata = packages.filter(item => !item.license).length;
  const missingLicenseText = packages.filter(item => !item.licenseTextPresent).length;
  const conflictingLicenseMetadata = packages.filter(item => item.licenseMetadataConflict || item.externalLicenseMetadataMismatch).length;
  const missingLockEntries = packages.filter(item => item.lockEntryMissing).length;
  const lockVersionMismatches = packages.filter(item => item.lockVersionMismatch).length;
  const packageSourceLockMismatches = packages.filter(item => item.packageSourceLockMismatch).length;
  const unknownSpdxExpressions = packages.filter(item => item.unknownSpdxExpression).length;
  const unmatchedLicenseManifestEntries = licenseManifestContext
    ? [...licenseManifestContext.entryByKey.keys()].filter(key => !licenseManifestContext.usedEntries.has(key)).length : 0;
  const unmatchedReleaseBlockers = licenseManifestContext
    ? [...licenseManifestContext.blockerByKey.keys()].filter(key => !licenseManifestContext.usedBlockers.has(key)).length : 0;
  const releaseBlockers = packages.filter(item => item.releaseBlocker).length + unmatchedReleaseBlockers;
  const releaseEligible = unknownLicenseMetadata === 0 && missingLicenseText === 0
    && conflictingLicenseMetadata === 0 && missingLockEntries === 0 && lockVersionMismatches === 0
    && packageSourceLockMismatches === 0 && unknownSpdxExpressions === 0 && unmatchedLicenseManifestEntries === 0
    && unmatchedReleaseBlockers === 0 && releaseBlockers === 0;
  return {
    format: "mcode.node-red.third-party-license-inventory.v1",
    inventoryType: "license-coverage-audit-not-sbom",
    sourceCommit: BASE_COMMIT,
    packageLockSha256: hashFile(lockPath),
    licenseSourceManifestSha256: licenseManifestContext
      ? hashFile(path.join(licenseManifestContext.licenseRoot, "manifest.json")) : null,
    packages,
    summary: {
      packageCount: packages.length,
      unknownLicenseMetadata,
      missingLicenseText,
      conflictingLicenseMetadata,
      missingLockEntries,
      lockVersionMismatches,
      packageSourceLockMismatches,
      unknownSpdxExpressions,
      reviewedExternalLicenseMappings: licenseManifestContext ? licenseManifestContext.usedEntries.size : 0,
      unmatchedLicenseManifestEntries,
      releaseBlockers,
      unmatchedReleaseBlockers,
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
  const licenseSource = path.join(__dirname, "vendor-licenses", "node-red");
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
    for (const name of ["manifest.json", "THIRD-PARTY-LICENSES.txt"]) {
      assertFile(path.join(licenseSource, name));
    }
    assertSafeTree(path.join(licenseSource, "materials"));
    const stagedLicenseRoot = path.join(tmp, "licenses", "node-red");
    fs.mkdirSync(stagedLicenseRoot, { recursive: true });
    fs.copyFileSync(path.join(licenseSource, "manifest.json"), path.join(stagedLicenseRoot, "manifest.json"));
    fs.copyFileSync(path.join(licenseSource, "THIRD-PARTY-LICENSES.txt"), path.join(stagedLicenseRoot, "THIRD-PARTY-LICENSES.txt"));
    fs.cpSync(path.join(licenseSource, "materials"), path.join(stagedLicenseRoot, "materials"), {
      recursive: true, dereference: false,
    });
    assertSafeTree(path.join(tmp, "packages"));
    assertSafeTree(path.join(tmp, "node_modules"));
    const packageTreeSha256 = hashTree(path.join(tmp, "packages"), "mcode.node-red.packages.tree.v1");
    const dependenciesTreeSha256 = hashTree(path.join(tmp, "node_modules"), "mcode.node-red.dependencies.tree.v1");
    const thirdPartyLicensesTreeSha256 = hashTree(path.join(tmp, "licenses", "node-red"), "mcode.node-red.licenses.tree.v1");
    const licenseInventory = writeNodeRedLicenseInventory(tmp);
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
      format: "mcode.node-red.release.v1", version: VERSION, sourceCommit: BASE_COMMIT,
      editorSha256: hashFile(path.join(tmp, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js")),
      packageSha256: hashFile(path.join(tmp, "packages", "node_modules", "node-red", "package.json")),
      lockSha256: hashFile(path.join(tmp, "package-lock.json")),
      licenseSha256: hashFile(path.join(tmp, "LICENSE")),
      licenseInventorySha256: licenseInventory.sha256,
      thirdPartyLicenseManifestSha256: hashFile(path.join(tmp, "licenses", "node-red", "manifest.json")),
      thirdPartyLicenseNoticeSha256: hashFile(path.join(tmp, "licenses", "node-red", "THIRD-PARTY-LICENSES.txt")),
      thirdPartyLicensesTreeSha256,
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
  writeNodeRedLicenseInventory, renderNodeRedLicenseNotice, parseSpdxExpression, BASE_COMMIT, VERSION,
};
