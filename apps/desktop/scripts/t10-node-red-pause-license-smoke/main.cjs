"use strict";
/** T10: Node-RED pause@0.0.1 verified-license integration and fail-closed gate smoke. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hashFile, createNodeRedLicenseInventory, writeNodeRedLicenseInventory,
  renderNodeRedLicenseNotice, BASE_COMMIT, VERSION,
} = require("../../build/stage-node-red-resources.cjs");
const verifyNodeRed = require("../../build/verify-node-red-after-pack.cjs");

const SOURCE_ROOT = path.resolve(__dirname, "../../build/vendor-licenses/node-red");
const SOURCE_MANIFEST = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "manifest.json"), "utf8"));
const PAUSE_README_SHA256 = "d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d";
const PAUSE_REVISION = "11d0dcaca51ee8cdf09915be0ba14c41871009b5";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t10-node-red-pause-"));
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
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function pauseEntry(manifest = SOURCE_MANIFEST) {
  return manifest.entries.find(entry => entry.packageName === "pause" && entry.version === "0.0.1");
}
function makePackage(root, relative, name, version, license, { licenseText = false } = {}) {
  const dir = path.join(root, ...relative.split("/"));
  const metadata = { name, version };
  if (license !== null && license !== undefined) metadata.license = license;
  put(path.join(dir, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  if (licenseText) put(path.join(dir, "LICENSE"), "Fixture license text for " + name + "@" + version + ".\n");
  return dir;
}
function copyLicenseTree(root, manifest) {
  const target = path.join(root, "licenses", "node-red");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(SOURCE_ROOT, "materials"), path.join(target, "materials"), {
    recursive: true, dereference: false,
  });
  put(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  put(path.join(target, "THIRD-PARTY-LICENSES.txt"), renderNodeRedLicenseNotice(manifest, target));
  return target;
}
/** Minimal release tree: every manifest entry installed with its real metadata state. */
function makeReleaseTree(root, manifest, { pauseLicense = "mapped", pauseReadme = "real", expressLicenseText = true, finalize = true } = {}) {
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
  makePackage(root, "node_modules/express", "express", "4.0.0", "MIT", { licenseText: expressLicenseText });

  for (const entry of manifest.entries) {
    if (entry.packageName === "pause") continue;
    const relative = entry.packageName === "cookie-signature" && entry.version === "1.0.7"
      ? "node_modules/cookie-signature-v1-0-7"
      : "node_modules/" + entry.packageName;
    const isOverride = Boolean(entry.metadataOverride);
    const dir = makePackage(root, relative, entry.packageName, entry.version,
      isOverride ? null : entry.licenseExpression, { licenseText: true });
    const lockEntry = {
      name: entry.packageName, version: entry.version,
      resolved: entry.packageSource.tarballUrl, integrity: entry.packageSource.tarballIntegrity,
    };
    if (!isOverride) lockEntry.license = entry.licenseExpression;
    lockPackages[relative] = lockEntry;
    if (isOverride) {
      fs.copyFileSync(path.join(SOURCE_ROOT, entry.materials[0].path),
        path.join(dir, entry.metadataOverride.fileName));
    }
  }

  const pause = pauseEntry(SOURCE_MANIFEST);
  const pauseDir = path.join(root, "node_modules", "pause");
  if (pauseLicense === "mapped") {
    makePackage(root, "node_modules/pause", "pause", "0.0.1", null);
    lockPackages["node_modules/pause"] = {
      name: "pause", version: "0.0.1",
      resolved: pause.packageSource.tarballUrl, integrity: pause.packageSource.tarballIntegrity,
    };
    if (pauseReadme === "real") {
      fs.copyFileSync(path.join(SOURCE_ROOT, pause.materials[0].path), path.join(pauseDir, "Readme.md"));
    } else if (pauseReadme === "tampered") {
      const original = fs.readFileSync(path.join(SOURCE_ROOT, pause.materials[0].path));
      fs.writeFileSync(path.join(pauseDir, "Readme.md"), Buffer.alloc(original.length, 0x58));
    } else if (pauseReadme === "absent") {
      // no Readme.md in the package at all
    }
  } else {
    // Unmapped pause (regardless of whether the manifest maps it): no license
    // metadata, no license-bearing content.
    makePackage(root, "node_modules/pause", "pause", "0.0.1", null);
    lockPackages["node_modules/pause"] = {
      name: "pause", version: "0.0.1",
      resolved: "https://registry.npmjs.org/pause/-/pause-0.0.1.tgz",
      integrity: "sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==",
    };
  }
  put(path.join(root, "package-lock.json"), JSON.stringify({
    name: "node-red", version: VERSION, lockfileVersion: 3, packages: lockPackages,
  }, null, 2) + "\n");

  makePackage(root, "packages/node_modules/node-red", "node-red", VERSION, "Apache-2.0", { licenseText: true });
  makePackage(root, "packages/node_modules/@node-red/editor-client", "@node-red/editor-client", VERSION, "Apache-2.0", { licenseText: true });
  makePackage(root, "packages/node_modules/@node-red/runtime", "@node-red/runtime", VERSION, "Apache-2.0", { licenseText: true });
  makePackage(root, "packages/node_modules/@node-red/editor-api", "@node-red/editor-api", VERSION, "Apache-2.0", { licenseText: true });
  put(path.join(root, "packages/node_modules/@node-red/editor-client/public/red/red.min.js"), "fixture editor JS\n");
  copyLicenseTree(root, manifest);
  return finalize ? finalizeReleaseTree(root, manifest) : null;
}
function finalizeReleaseTree(root, manifest) {
  const inventory = writeNodeRedLicenseInventory(root);
  const licenseRoot = path.join(root, "licenses", "node-red");
  const marker = {
    format: "mcode.node-red.release.v1",
    version: VERSION,
    sourceCommit: BASE_COMMIT,
    editorSha256: hashFile(path.join(root, "packages/node_modules/@node-red/editor-client/public/red/red.min.js")),
    packageSha256: hashFile(path.join(root, "packages/node_modules/node-red/package.json")),
    lockSha256: hashFile(path.join(root, "package-lock.json")),
    licenseSha256: hashFile(path.join(root, "LICENSE")),
    licenseInventorySha256: inventory.sha256,
    thirdPartyLicenseManifestSha256: hashFile(path.join(licenseRoot, "manifest.json")),
    thirdPartyLicenseNoticeSha256: hashFile(path.join(licenseRoot, "THIRD-PARTY-LICENSES.txt")),
    thirdPartyLicensesTreeSha256: require("../../build/stage-node-red-resources.cjs")
      .hashTree(licenseRoot, "mcode.node-red.licenses.tree.v1"),
    packageTreeSha256: require("../../build/stage-node-red-resources.cjs")
      .hashTree(path.join(root, "packages"), "mcode.node-red.packages.tree.v1"),
    dependenciesTreeSha256: require("../../build/stage-node-red-resources.cjs")
      .hashTree(path.join(root, "node_modules"), "mcode.node-red.dependencies.tree.v1"),
  };
  put(path.join(root, "manifest.json"), JSON.stringify(marker, null, 2) + "\n");
  return inventory.inventory;
}

try {
  verify("pause@0.0.1 is integrated as a version-bound entry with the exact upstream revision and byte-exact Readme material", () => {
    assert.equal(SOURCE_MANIFEST.blockers.length, 0);
    const pause = pauseEntry();
    assert.ok(pause, "pause@0.0.1 entry must exist");
    assert.equal(pause.licenseExpression, "MIT");
    assert.equal(pause.packageSource.revision, PAUSE_REVISION);
    assert.equal(pause.packageSource.repositoryUrl, "https://github.com/stream-utils/pause");
    assert.equal(pause.packageSource.tarballSha1, "1d408b3fdb76923b9543d96fb4c9dfd535d9cb5d");
    assert.equal(pause.packageSource.tarballIntegrity,
      "sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==");
    assert.equal(pause.materials.length, 1);
    const material = pause.materials[0];
    assert.equal(material.licenseId, "MIT");
    assert.equal(material.sourceRevision, PAUSE_REVISION);
    assert.equal(material.sourceFileName, "Readme.md");
    assert.equal(material.sha256, PAUSE_README_SHA256);
    assert.match(material.sourceUrl, /stream-utils\/pause\/blob\/11d0dcaca51ee8cdf09915be0ba14c41871009b5\/Readme\.md$/);
    const file = path.join(SOURCE_ROOT, material.path);
    assert.equal(hashFile(file), PAUSE_README_SHA256);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /The MIT License/);
    assert.match(text, /Copyright \(c\) 2012 TJ Holowaychuk/);
    assert.match(text, /Permission is hereby granted/);
    assert.match(text, /WITHOUT WARRANTY OF ANY KIND/);
  });

  verify("pause license override is explicit, evidence-bound and declares a non-license-named source file", () => {
    const pause = pauseEntry();
    const override = pause.metadataOverride;
    assert.ok(override, "pause must carry a reviewed metadata override");
    assert.equal(override.reviewed, true);
    assert.equal(override.licenseExpression, "MIT");
    assert.equal(override.fileName, "Readme.md");
    assert.equal(override.licenseTextFile, false);
    assert.equal(override.sha256, PAUSE_README_SHA256);
    assert.equal(override.sourceRevision, PAUSE_REVISION);
    const evidence = pause.materials.find(material =>
      material.sourceFileName === override.fileName
      && material.sourceUrl === override.sourceUrl
      && material.sourceRevision === override.sourceRevision
      && material.sha256 === override.sha256);
    assert.ok(evidence, "override must bind to a real material");
    assert.ok(pause.licenseSourceNote && pause.licenseSourceNote.trim());
  });

  verify("the regenerated notice renders pause@0.0.1 with its MIT text and no release-blocker section", () => {
    const notice = fs.readFileSync(path.join(SOURCE_ROOT, "THIRD-PARTY-LICENSES.txt"), "utf8");
    assert.match(notice, /Package: pause@0\.0\.1/);
    assert.match(notice, /SPDX license expression: MIT/);
    assert.match(notice, /Local SHA-256: d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d/);
    assert.match(notice, /Copyright \(c\) 2012 TJ Holowaychuk/);
    assert.doesNotMatch(notice, /RELEASE BLOCKER/);
    assert.equal(notice, renderNodeRedLicenseNotice(SOURCE_MANIFEST, SOURCE_ROOT));
  });

  const mappedRoot = path.join(base, "mapped");
  const mappedInventory = makeReleaseTree(mappedRoot, SOURCE_MANIFEST);
  verify("a release tree that carries the real pause Readme maps pause to collected and passes afterPack", () => {
    const pause = mappedInventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
    assert.equal(pause.status, "collected");
    assert.equal(pause.license, "MIT");
    assert.equal(pause.licenseExpression, "MIT");
    assert.equal(pause.licenseTextPresent, true);
    assert.equal(pause.licenseMetadataOverride.reviewed, true);
    assert.equal(pause.externalLicenseMetadataMismatch, false);
    assert.equal(mappedInventory.summary.unknownLicenseMetadata, 0);
    assert.equal(mappedInventory.summary.missingLicenseText, 0);
    assert.equal(mappedInventory.summary.releaseEligible, true);
    assert.equal(verifyNodeRed.verifyNodeRedResource(mappedRoot).licenseCoverage.releaseEligible, true);
  });

  verify("negative control: a pause package with no license metadata and no mapping still blocks release", () => {
    const root = path.join(base, "unmapped-pause");
    const manifest = clone(SOURCE_MANIFEST);
    manifest.entries = manifest.entries.filter(entry => !(entry.packageName === "pause"));
    const inventory = makeReleaseTree(root, manifest, { pauseLicense: "unmapped" });
    const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
    assert.equal(pause.status, "unknown-license");
    assert.equal(pause.license, null);
    assert.equal(pause.licenseTextPresent, false);
    assert.equal(inventory.summary.unknownLicenseMetadata, 1);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /pause@0\.0\.1 \[unknown-license/i);
  });

  verify("negative control: an unmapped, unknown-license dependency injected into an otherwise clean tree blocks release", () => {
    const root = path.join(base, "injected-unknown");
    makeReleaseTree(root, SOURCE_MANIFEST);
    makePackage(root, "node_modules/mystery-pkg", "mystery-pkg", "9.9.9", null);
    const inventory = writeNodeRedLicenseInventory(root).inventory;
    const mystery = inventory.packages.find(item => item.name === "mystery-pkg");
    assert.equal(mystery.status, "unknown-license");
    assert.equal(inventory.summary.releaseEligible, false);
    // The on-disk marker is now stale, so afterPack must reject the tree outright.
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /digest mismatch|inventory differs|unknown-license|release blocked/i);
  });

  verify("negative control: removing the pause material makes the gate fail closed again", () => {
    const manifest = clone(SOURCE_MANIFEST);
    const withoutPause = clone(manifest);
    withoutPause.entries = withoutPause.entries.filter(entry => !(entry.packageName === "pause"));
    const root = path.join(base, "missing-pause-material");
    makeReleaseTree(root, withoutPause);
    // Install pause now that the marker/inventory were computed without it.
    makePackage(root, "node_modules/pause", "pause", "0.0.1", null);
    const inventory = createNodeRedLicenseInventory(root);
    const pause = inventory.packages.find(item => item.name === "pause");
    assert.equal(pause.status, "unknown-license");
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /pause@0\.0\.1 \[unknown-license/i);
  });

  verify("pause package-local Readme that differs from the cited upstream bytes is rejected", () => {
    const root = path.join(base, "tampered-pause-readme");
    makeReleaseTree(root, SOURCE_MANIFEST, { pauseReadme: "tampered", finalize: false });
    assert.throws(() => createNodeRedLicenseInventory(root), /reviewed license metadata override file mismatch: pause@0\.0\.1/);
  });

  verify("a missing pause material file is reported with the exact package and file, not a raw ENOENT", () => {
    const root = path.join(base, "missing-material-file");
    makeReleaseTree(root, SOURCE_MANIFEST, { finalize: false });
    fs.rmSync(path.join(root, "licenses", "node-red", "materials", "pause", "0.0.1", "Readme.md"));
    assert.throws(() => createNodeRedLicenseInventory(root),
      error => /license material is missing: pause@0\.0\.1 Readme\.md/.test(error.message)
        && !/^ENOENT/.test(error.message));
  });

  verify("a missing pause material directory is reported with the exact package, not a raw ENOENT", () => {
    const root = path.join(base, "missing-material-dir");
    makeReleaseTree(root, SOURCE_MANIFEST, { finalize: false });
    fs.rmSync(path.join(root, "licenses", "node-red", "materials", "pause"), { recursive: true, force: true });
    assert.throws(() => createNodeRedLicenseInventory(root),
      error => /license material is missing: pause@0\.0\.1/.test(error.message)
        && !/^ENOENT/.test(error.message));
  });

  verify("override with licenseTextFile=false is not believed when the package instead ships a license-named file with other bytes", () => {
    // Guard the licenseTextFile=false escape hatch: it may only skip the
    // license-named-file search, never the package-local byte comparison.
    const root = path.join(base, "readme-grant-but-different-license-file");
    makeReleaseTree(root, SOURCE_MANIFEST);
    const pauseDir = path.join(root, "node_modules", "pause");
    fs.writeFileSync(path.join(pauseDir, "LICENSE"), "A different, unverified license text.\n");
    // pause still has the authentic Readme.md, so the override file check passes and
    // the extra LICENSE file must not change the verdict either way.
    const inventory = createNodeRedLicenseInventory(root);
    const pause = inventory.packages.find(item => item.name === "pause");
    assert.equal(pause.status, "collected");
    assert.equal(pause.license, "MIT");
    // Now make the Readme wrong while adding a license-named file: still rejected.
    const readme = path.join(pauseDir, "Readme.md");
    const original = fs.readFileSync(readme);
    fs.writeFileSync(readme, Buffer.alloc(original.length, 0x5a));
    assert.throws(() => createNodeRedLicenseInventory(root), /reviewed license metadata override file mismatch: pause@0\.0\.1/);
  });

  verify("licenseTextFile=false is load-bearing: without it the readme-only pause package is rejected", () => {
    // The real pause package has no license-named file at all. With the flag the
    // override is accepted (covered above); without it the same tree must fail,
    // which proves the flag is what carries the readme-borne grant.
    const manifest = clone(SOURCE_MANIFEST);
    const pause = pauseEntry(manifest);
    delete pause.metadataOverride.licenseTextFile;
    const root = path.join(base, "readme-only-without-flag");
    makeReleaseTree(root, manifest, { finalize: false });
    assert.throws(() => createNodeRedLicenseInventory(root),
      /reviewed license metadata override file mismatch: pause@0\.0\.1/);
  });

  verify("pause package that ships no Readme at all cannot claim the reviewed override", () => {
    const root = path.join(base, "absent-pause-readme");
    makeReleaseTree(root, SOURCE_MANIFEST, { pauseReadme: "absent", finalize: false });
    assert.throws(() => createNodeRedLicenseInventory(root), /reviewed license metadata override file mismatch: pause@0\.0\.1/);
  });

  verify("a manifest override without the required evidence note or with a wrong expression is rejected as invalid", () => {
    const root = path.join(base, "override-schema");
    const manifest = clone(SOURCE_MANIFEST);
    const pause = pauseEntry(manifest);
    pause.metadataOverride.licenseExpression = "ISC";
    makeReleaseTreePlain(root, manifest);
    assert.throws(() => createNodeRedLicenseInventory(root), /metadata override is not explicitly reviewed\/evidenced/);

    const root2 = path.join(base, "override-note");
    const manifest2 = clone(SOURCE_MANIFEST);
    const pause2 = pauseEntry(manifest2);
    delete pause2.licenseSourceNote;
    makeReleaseTreePlain(root2, manifest2);
    assert.throws(() => createNodeRedLicenseInventory(root2), /license metadata override is not explicitly reviewed\/evidenced: pause@0\.0\.1/);
  });
  function makeReleaseTreePlain(root, manifest) {
    // Build without calling finalizeReleaseTree so schema errors surface in the inventory.
    return makeReleaseTreeNoFinalize(root, manifest);
  }
  function makeReleaseTreeNoFinalize(root, manifest) {
    const original = makeReleaseTree;
    // Reuse the builder's tree construction by finalizing a throwaway, then replacing
    // the license tree with the mutated manifest and dropping the stale marker.
    const tree = path.join(base, "schema-scratch-" + crypto.randomBytes(4).toString("hex"));
    original(tree, SOURCE_MANIFEST);
    fs.cpSync(tree, root, { recursive: true, dereference: false });
    const licenseRoot = path.join(root, "licenses", "node-red");
    put(path.join(licenseRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    put(path.join(licenseRoot, "THIRD-PARTY-LICENSES.txt"), renderNodeRedLicenseNotice(manifest, licenseRoot));
    fs.rmSync(path.join(root, "manifest.json"), { force: true });
    fs.rmSync(path.join(root, "third-party-license-inventory.json"), { force: true });
    return null;
  }

  verify("a material whose SHA-256 does not match the manifest makes the inventory fail closed", () => {
    const root = path.join(base, "material-hash");
    makeReleaseTree(root, SOURCE_MANIFEST);
    const file = path.join(root, "licenses", "node-red", "materials", "pause", "0.0.1", "Readme.md");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 0x59));
    assert.throws(() => createNodeRedLicenseInventory(root), /license material SHA-256 mismatch: pause@0\.0\.1/);
    fs.writeFileSync(file, original);
    assert.equal(hashFile(file), PAUSE_README_SHA256);
    assert.equal(verifyNodeRed.verifyNodeRedResource(root).licenseCoverage.releaseEligible, true);
  });

  console.log("t10-node-red-pause-license-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
