"use strict";
/** T88: exact-version Node-RED third-party license closure and fail-closed gate smoke. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hashFile, hashTree, createNodeRedLicenseInventory, writeNodeRedLicenseInventory,
  renderNodeRedLicenseNotice, BASE_COMMIT, VERSION,
} = require("../../build/stage-node-red-resources.cjs");
const verifyNodeRed = require("../../build/verify-node-red-after-pack.cjs");

const SOURCE_ROOT = path.resolve(__dirname, "../../build/vendor-licenses/node-red");
const CURRENT_STAGE = path.resolve(__dirname, "../../.tmp/node-red-release");
const SOURCE_MANIFEST = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "manifest.json"), "utf8"));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t88-node-red-license-"));
const positiveManifest = JSON.parse(JSON.stringify(SOURCE_MANIFEST));
positiveManifest.blockers = [];
let total = 0;

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content === undefined ? "fixture\n" : content);
}
function verify(label, fn) {
  fn();
  total++;
  console.log("  ok  " + label);
}
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function copyLicenseTree(root, manifest) {
  const target = path.join(root, "licenses", "node-red");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(SOURCE_ROOT, "materials"), path.join(target, "materials"), {
    recursive: true, dereference: false,
  });
  put(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  put(path.join(target, "THIRD-PARTY-LICENSES.txt",), renderNodeRedLicenseNotice(manifest, target));
  return target;
}
function packageInstallPath(entry) {
  if (entry.packageName === "cookie-signature" && entry.version === "1.0.7") {
    return "node_modules/cookie-signature-v1-0-7";
  }
  return "node_modules/" + entry.packageName;
}
function makePackage(root, relative, name, version, license, licenseText = true) {
  const dir = path.join(root, ...relative.split("/"));
  const metadata = { name, version };
  if (license !== null && license !== undefined) metadata.license = license;
  put(path.join(dir, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  if (licenseText) put(path.join(dir, "LICENSE"), "Fixture license text for " + name + "@" + version + ".\n");
  return dir;
}
function hashManifest(root) {
  const inventory = writeNodeRedLicenseInventory(root);
  const licenseRoot = path.join(root, "licenses", "node-red");
  const pkg = path.join(root, "packages", "node_modules", "node-red", "package.json");
  const editor = path.join(root, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js");
  const marker = {
    format: "mcode.node-red.release.v1",
    version: VERSION,
    sourceCommit: BASE_COMMIT,
    editorSha256: hashFile(editor),
    packageSha256: hashFile(pkg),
    lockSha256: hashFile(path.join(root, "package-lock.json")),
    licenseSha256: hashFile(path.join(root, "LICENSE")),
    licenseInventorySha256: inventory.sha256,
    thirdPartyLicenseManifestSha256: hashFile(path.join(licenseRoot, "manifest.json")),
    thirdPartyLicenseNoticeSha256: hashFile(path.join(licenseRoot, "THIRD-PARTY-LICENSES.txt")),
    thirdPartyLicensesTreeSha256: hashTree(licenseRoot, "mcode.node-red.licenses.tree.v1"),
    packageTreeSha256: hashTree(path.join(root, "packages"), "mcode.node-red.packages.tree.v1"),
    dependenciesTreeSha256: hashTree(path.join(root, "node_modules"), "mcode.node-red.dependencies.tree.v1"),
  };
  put(path.join(root, "manifest.json"), JSON.stringify(marker, null, 2) + "\n");
  return inventory.inventory;
}
function makeFixture(root, {
  manifest = positiveManifest,
  packageEntries = SOURCE_MANIFEST.entries,
  includePause = false,
  finalize = true,
} = {}) {
  fs.mkdirSync(root, { recursive: true });
  put(path.join(root, "LICENSE"), "Node-RED Apache-2.0 license fixture.\n");
  const lockPackages = {
    "": { name: "node-red", version: VERSION },
    "node_modules/express": {
      name: "express", version: "4.0.0", license: "MIT",
      resolved: "https://registry.npmjs.org/express/-/express-4.0.0.tgz",
      integrity: "sha512-illustrative-fixture-integrity",
    },
  };
  makePackage(root, "node_modules/express", "express", "4.0.0", "MIT", true);

  for (const entry of packageEntries) {
    const relative = packageInstallPath(entry);
    const isOverride = Boolean(entry.metadataOverride);
    const dir = makePackage(
      root, relative, entry.packageName, entry.version,
      isOverride ? null : entry.licenseExpression, isOverride
    );
    const lockEntry = {
      name: entry.packageName,
      version: entry.version,
      resolved: entry.packageSource.tarballUrl,
      integrity: entry.packageSource.tarballIntegrity,
    };
    if (!isOverride) lockEntry.license = entry.licenseExpression;
    lockPackages[relative] = lockEntry;
    if (isOverride) {
      const sourceLicense = path.join(SOURCE_ROOT, entry.materials[0].path);
      fs.copyFileSync(sourceLicense, path.join(dir, entry.metadataOverride.fileName));
    }
  }
  if (includePause) {
    const blocker = manifest.blockers.find(item => item.packageName === "pause" && item.version === "0.0.1")
      || SOURCE_MANIFEST.blockers.find(item => item.packageName === "pause" && item.version === "0.0.1");
    assert.ok(blocker, "pause fixture requires the reviewed release-blocker record");
    lockPackages["node_modules/pause"] = {
      name: "pause",
      version: "0.0.1",
      resolved: blocker.packageSource.tarballUrl,
      integrity: blocker.packageSource.tarballIntegrity,
    };
    makePackage(root, "node_modules/pause", "pause", "0.0.1", null, false);
  }
  put(path.join(root, "package-lock.json"), JSON.stringify({
    name: "node-red", version: VERSION, lockfileVersion: 3, packages: lockPackages,
  }, null, 2) + "\n");

  makePackage(root, "packages/node_modules/node-red", "node-red", VERSION, "Apache-2.0", true);
  makePackage(root, "packages/node_modules/@node-red/editor-client", "@node-red/editor-client", VERSION, "Apache-2.0", true);
  makePackage(root, "packages/node_modules/@node-red/runtime", "@node-red/runtime", VERSION, "Apache-2.0", true);
  makePackage(root, "packages/node_modules/@node-red/editor-api", "@node-red/editor-api", VERSION, "Apache-2.0", true);
  put(path.join(root, "packages/node_modules/@node-red/editor-client/public/red/red.min.js"), "fixture editor JS\n");
  copyLicenseTree(root, manifest);
  return finalize ? hashManifest(root) : null;
}

try {
  verify("source manifest binds exact package versions, SPDX expressions, upstream revisions and file SHA-256 values", () => {
    assert.equal(SOURCE_MANIFEST.nodeRedVersion, VERSION);
    assert.equal(SOURCE_MANIFEST.nodeRedSourceCommit, BASE_COMMIT);
    assert.equal(SOURCE_MANIFEST.entries.length, 15);
    assert.equal(SOURCE_MANIFEST.entries.reduce((sum, entry) => sum + entry.materials.length, 0), 16);
    assert.equal(SOURCE_MANIFEST.blockers.length, 1);
    for (const entry of SOURCE_MANIFEST.entries) {
      assert.ok(entry.packageName && entry.version && entry.licenseExpression);
      assert.match(entry.packageSource.registryMetadataUrl, /^https:\/\/registry\.npmjs\.org\//);
      assert.match(entry.packageSource.revision, /^[a-f0-9]{40}$/);
      for (const material of entry.materials) {
        const file = path.join(SOURCE_ROOT, material.path);
        assert.equal(hashFile(file), material.sha256, entry.packageName + "@" + entry.version);
        assert.match(material.sourceUrl, /^https:\/\//);
        assert.match(material.sourceRevision, /^[a-f0-9]{40}$/);
        assert.ok(fs.statSync(file).size > 0);
      }
    }
    const typeFest = SOURCE_MANIFEST.entries.find(entry => entry.packageName === "type-fest" && entry.version === "4.41.0");
    assert.deepEqual(typeFest.materials.map(material => material.licenseId).sort(), ["CC0-1.0", "MIT"]);
    const cliTable = SOURCE_MANIFEST.entries.find(entry => entry.packageName === "cli-table" && entry.version === "0.3.11");
    assert.equal(cliTable.metadataOverride.reviewed, true);
    assert.equal(cliTable.metadataOverride.licenseExpression, "MIT");
    assert.equal(cliTable.metadataOverride.sha256, cliTable.materials[0].sha256);
    const pause = SOURCE_MANIFEST.blockers[0];
    assert.equal(pause.packageName, "pause");
    assert.equal(pause.version, "0.0.1");
    assert.equal(pause.licenseExpression, null);
    assert.equal(pause.status, "release-blocker");
    assert.match(pause.reason, /no SPDX expression is inferred/i);
    const notice = fs.readFileSync(path.join(SOURCE_ROOT, "THIRD-PARTY-LICENSES.txt"), "utf8");
    assert.match(notice, /Apache License/);
    assert.match(notice, /Creative Commons Legal Code/);
    assert.match(notice, /RELEASE BLOCKER: pause@0\.0\.1/);
  });

  const positiveRoot = path.join(base, "positive");
  const positiveInventory = makeFixture(positiveRoot);
  verify("complete exact-version mappings supply all license texts and afterPack accepts a blocker-free fixture", () => {
    assert.equal(positiveInventory.summary.packageCount, 20);
    assert.equal(positiveInventory.summary.reviewedExternalLicenseMappings, 15);
    assert.equal(positiveInventory.summary.unmatchedLicenseManifestEntries, 0);
    assert.equal(positiveInventory.summary.packageSourceLockMismatches, 0);
    assert.equal(positiveInventory.summary.unknownSpdxExpressions, 0);
    assert.equal(positiveInventory.summary.releaseEligible, true);
    for (const entry of positiveInventory.packages.filter(item => item.externalLicenseMapping)) {
      assert.equal(entry.licenseTextPresent, true, entry.name + "@" + entry.version);
      assert.equal(entry.status, "collected", entry.name + "@" + entry.version);
    }
    const typeFest = positiveInventory.packages.find(item => item.name === "type-fest" && item.version === "4.41.0");
    assert.deepEqual(typeFest.licenseFiles.filter(file => file.external).map(file => file.licenseId).sort(), ["CC0-1.0", "MIT"]);
    const cliTable = positiveInventory.packages.find(item => item.name === "cli-table" && item.version === "0.3.11");
    assert.equal(cliTable.licenseExpression, "MIT");
    assert.equal(cliTable.licenseMetadataOverride.reviewed, true);
    assert.equal(verifyNodeRed.verifyNodeRedResource(positiveRoot).licenseCoverage.releaseEligible, true);
  });

  const blockerRoot = path.join(base, "pause-blocker");
  const blockerInventory = makeFixture(blockerRoot, { manifest: SOURCE_MANIFEST, includePause: true });
  verify("pause@0.0.1 remains an explicit release blocker and afterPack rejects it", () => {
    const pause = blockerInventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
    assert.equal(pause.status, "release-blocker");
    assert.equal(pause.license, null);
    assert.match(pause.releaseBlocker.reason, /no authoritative license grant/i);
    assert.equal(blockerInventory.summary.releaseBlockers, 1);
    assert.equal(blockerInventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(blockerRoot), /pause@0\.0\.1 \[release-blocker/i);
  });

  verify("unknown SPDX identifier in the source manifest fails closed", () => {
    const root = path.join(base, "unknown-spdx-manifest");
    const badManifest = JSON.parse(JSON.stringify(positiveManifest));
    badManifest.entries[0].licenseExpression = "Definitely-Not-SPDX";
    makeFixture(root, { manifest: badManifest, finalize: false });
    assert.throws(() => createNodeRedLicenseInventory(root), /Unknown SPDX license identifier: Definitely-Not-SPDX/);
  });

  verify("unknown SPDX identifier in installed package metadata blocks release", () => {
    const root = path.join(base, "unknown-spdx-package");
    makeFixture(root);
    const packagePath = path.join(root, "node_modules/colors/package.json");
    const packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageMetadata.license = "Definitely-Not-SPDX";
    put(packagePath, JSON.stringify(packageMetadata, null, 2) + "\n");
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/colors"].license = "Definitely-Not-SPDX";
    put(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const inventory = hashManifest(root);
    const colors = inventory.packages.find(item => item.name === "colors" && item.version === "1.0.3");
    assert.equal(colors.status, "unknown-spdx-license");
    assert.equal(inventory.summary.unknownSpdxExpressions, 1);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /unknown-spdx expressions=1|colors@1\.0\.3 \[unknown-spdx-license/i);
  });

  verify("package metadata conflicting with the version-bound license mapping blocks release", () => {
    const root = path.join(base, "metadata-conflict");
    makeFixture(root);
    const packagePath = path.join(root, "node_modules/colors/package.json");
    const packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageMetadata.license = "ISC";
    put(packagePath, JSON.stringify(packageMetadata, null, 2) + "\n");
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/colors"].license = "ISC";
    put(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const inventory = hashManifest(root);
    const colors = inventory.packages.find(item => item.name === "colors" && item.version === "1.0.3");
    assert.equal(colors.status, "license-metadata-conflict");
    assert.ok(inventory.summary.conflictingLicenseMetadata > 0);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /colors@1\.0\.3 \[license-metadata-conflict/i);
  });

  verify("lock version mismatch cannot reuse a license mapping for another package version", () => {
    const root = path.join(base, "lock-version-mismatch");
    makeFixture(root);
    const packagePath = path.join(root, "node_modules/agent-base/package.json");
    const packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageMetadata.version = "6.0.3";
    put(packagePath, JSON.stringify(packageMetadata, null, 2) + "\n");
    const inventory = hashManifest(root);
    const agentBase = inventory.packages.find(item => item.name === "agent-base");
    assert.equal(agentBase.version, "6.0.3");
    assert.equal(agentBase.status, "lock-mismatch");
    assert.equal(inventory.summary.lockVersionMismatches, 1);
    assert.equal(inventory.summary.unmatchedLicenseManifestEntries, 1);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /unmatched license manifest entries=1|agent-base@6\.0\.3 \[lock-mismatch/i);
  });

  verify("lock artifact integrity mismatch cannot reuse a license mapping", () => {
    const root = path.join(base, "lock-artifact-mismatch");
    makeFixture(root);
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/colors"].integrity = "sha512-tampered-fixture-integrity";
    put(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const inventory = hashManifest(root);
    const colors = inventory.packages.find(item => item.name === "colors" && item.version === "1.0.3");
    assert.equal(colors.packageSourceLockMismatch, true);
    assert.equal(colors.packageSourceLockStatus, "lock-artifact-mismatch");
    assert.equal(colors.status, "lock-mismatch");
    assert.equal(inventory.summary.packageSourceLockMismatches, 1);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /colors@1\.0\.3 \[lock-mismatch/i);
  });

  verify("missing external license text fails closed instead of being treated as covered", () => {
    const root = path.join(base, "missing-license-text");
    const manifest = JSON.parse(JSON.stringify(positiveManifest));
    manifest.entries = manifest.entries.filter(entry => !(entry.packageName === "cssesc" && entry.version === "3.0.0"));
    makeFixture(root, { manifest, finalize: false });
    fs.rmSync(path.join(root, "licenses/node-red/materials/cssesc/3.0.0/LICENSE-MIT.txt"));
    const inventory = hashManifest(root);
    const cssesc = inventory.packages.find(item => item.name === "cssesc" && item.version === "3.0.0");
    assert.equal(cssesc.status, "license-text-missing");
    assert.equal(cssesc.licenseTextPresent, false);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /cssesc@3\.0\.0 \[license-text-missing/i);
  });

  verify("license material SHA-256 mismatch fails closed", () => {
    const root = path.join(base, "license-hash-mismatch");
    makeFixture(root);
    const file = path.join(root, "licenses/node-red/materials/colors/1.0.3/MIT-LICENSE.txt");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x58));
    assert.notEqual(hashFile(file), sha256(original));
    assert.throws(() => createNodeRedLicenseInventory(root), /license material SHA-256 mismatch/i);
  });

  verify("reviewed cli-table override rejects a package-local LICENSE that differs from the cited source", () => {
    const root = path.join(base, "cli-table-override-mismatch");
    makeFixture(root);
    const file = path.join(root, "node_modules/cli-table/LICENSE");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x4c));
    assert.throws(() => createNodeRedLicenseInventory(root), /reviewed license metadata override file mismatch/i);
  });

  if (fs.existsSync(CURRENT_STAGE)) {
    const stageCopy = path.join(base, "current-stage-copy");
    fs.cpSync(CURRENT_STAGE, stageCopy, { recursive: true, dereference: false });
    copyLicenseTree(stageCopy, SOURCE_MANIFEST);
    const inventory = writeNodeRedLicenseInventory(stageCopy).inventory;
    const markerPath = path.join(stageCopy, "manifest.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const licenseRoot = path.join(stageCopy, "licenses", "node-red");
    marker.format = "mcode.node-red.release.v1";
    marker.version = VERSION;
    marker.sourceCommit = BASE_COMMIT;
    marker.editorSha256 = hashFile(path.join(stageCopy, "packages/node_modules/@node-red/editor-client/public/red/red.min.js"));
    marker.packageSha256 = hashFile(path.join(stageCopy, "packages/node_modules/node-red/package.json"));
    marker.lockSha256 = hashFile(path.join(stageCopy, "package-lock.json"));
    marker.licenseSha256 = hashFile(path.join(stageCopy, "LICENSE"));
    marker.licenseInventorySha256 = hashFile(path.join(stageCopy, "third-party-license-inventory.json"));
    marker.thirdPartyLicenseManifestSha256 = hashFile(path.join(licenseRoot, "manifest.json"));
    marker.thirdPartyLicenseNoticeSha256 = hashFile(path.join(licenseRoot, "THIRD-PARTY-LICENSES.txt"));
    marker.thirdPartyLicensesTreeSha256 = hashTree(licenseRoot, "mcode.node-red.licenses.tree.v1");
    marker.packageTreeSha256 = hashTree(path.join(stageCopy, "packages"), "mcode.node-red.packages.tree.v1");
    marker.dependenciesTreeSha256 = hashTree(path.join(stageCopy, "node_modules"), "mcode.node-red.dependencies.tree.v1");
    put(markerPath, JSON.stringify(marker, null, 2) + "\n");
    verify("isolated copy of the 420-package stage maps every reviewed version and remains blocked only by pause@0.0.1", () => {
      assert.equal(inventory.summary.packageCount, 420);
      assert.equal(inventory.summary.reviewedExternalLicenseMappings, 15);
      assert.equal(inventory.summary.unmatchedLicenseManifestEntries, 0);
      assert.equal(inventory.summary.unknownSpdxExpressions, 0);
      assert.equal(inventory.summary.unknownLicenseMetadata, 1);
      assert.equal(inventory.summary.missingLicenseText, 1);
      assert.equal(inventory.summary.releaseBlockers, 1);
      assert.equal(inventory.summary.releaseEligible, false);
      const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
      assert.equal(pause.status, "release-blocker");
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(stageCopy), /pause@0\.0\.1 \[release-blocker/i);
    });
    verify("afterPack rejects same-size license material tampering and accepts the restored bytes before applying the pause blocker", () => {
      const file = path.join(stageCopy, "licenses/node-red/materials/agent-base/6.0.2/LICENSE");
      const original = fs.readFileSync(file);
      const originalHash = sha256(original);
      fs.writeFileSync(file, Buffer.alloc(original.length, 0x58));
      const mutatedHash = hashFile(file);
      assert.notEqual(mutatedHash, originalHash);
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(stageCopy), /third-party license tree digest mismatch/i);
      fs.writeFileSync(file, original);
      const restoredHash = hashFile(file);
      assert.equal(restoredHash, originalHash);
      assert.throws(() => verifyNodeRed.verifyNodeRedResource(stageCopy), /pause@0\.0\.1 \[release-blocker/i);
      console.log("    mutation SHA-256: " + mutatedHash + "; restored SHA-256: " + restoredHash);
    });
  } else {
    console.log("  skip  current 420-package stage copy: .tmp/node-red-release is unavailable");
  }

  console.log("t88-node-red-license-closure-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
