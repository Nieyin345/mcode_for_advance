"use strict";
/** T87: exact GenOffice patch provenance and fail-closed third-party license closure. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../../..");
const vendor = path.join(root, "genoffice");
const lockPath = path.join(root, "apps/desktop/build/genoffice-upstream.lock.json");
const licenseManifestPath = path.join(root, "apps/desktop/build/vendor-licenses/genoffice/manifest.json");
const licenseRoot = path.join(path.dirname(licenseManifestPath), "licenses");
const vendorNotice = path.join(vendor, "apps/shell/build/THIRD-PARTY-NOTICES.txt");
const upstream = require("../../build/verify-genoffice-upstream.cjs");
const stage = require("../../build/stage-genoffice-resources.cjs");
const afterPack = require("../../build/verify-genoffice-editors-after-pack.cjs");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const originalVendorNoticeHash = sha256(fs.readFileSync(vendorNotice));
const originalVendorHead = execFileSync("git", ["-C", vendor, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const originalVendorStatus = execFileSync("git", ["-C", vendor, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t87-provenance-"));
let total = 0;

function logPass(label) {
  total++;
  console.log("  PASS " + label);
}
function pass(label, fn) {
  fn();
  logPass(label);
}
function rejects(label, fn, pattern) {
  assert.throws(fn, pattern);
  logPass(label);
}
function git(directory, ...args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8", timeout: 60000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error("git " + args.join(" ") + " failed: " +
      (error.stderr ? String(error.stderr) : error.message));
  }
}
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
function createVerifyRoot(name) {
  const repoRoot = path.join(temp, name);
  const nested = path.join(repoRoot, "genoffice");
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["clone", "--local", "--no-hardlinks", vendor, nested], {
    encoding: "utf8", timeout: 120000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
  const copiedLock = path.join(repoRoot, "apps/desktop/build/genoffice-upstream.lock.json");
  copyFile(lockPath, copiedLock);
  for (const entry of lock.patchSeries) {
    copyFile(path.join(root, entry.file), path.join(repoRoot, entry.file));
  }
  return { repoRoot, nested, lockPath: copiedLock };
}
function verifyFixture(fixture) {
  return upstream.assertUpstreamRevision({ repoRoot: fixture.repoRoot, lockPath: fixture.lockPath });
}
function restoreFile(file, original) {
  fs.writeFileSync(file, original);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(sha256(fs.readFileSync(file)), sha256(original));
}
function writeLock(fixture, object) {
  fs.writeFileSync(fixture.lockPath, JSON.stringify(object, null, 2) + "\n");
}
function copyLicenseFixture(name) {
  const dir = path.join(temp, name);
  const licenses = path.join(dir, "licenses");
  const manifest = path.join(dir, "manifest.json");
  fs.mkdirSync(licenses, { recursive: true });
  copyFile(licenseManifestPath, manifest);
  const source = JSON.parse(fs.readFileSync(licenseManifestPath, "utf8"));
  for (const item of source.items.filter(entry => entry.status === "verified")) {
    copyFile(path.join(licenseRoot, item.licenseFile), path.join(licenses, item.licenseFile));
  }
  return { dir, licenses, manifest, source };
}
function validateFixture(fixture, requireComplete = false, expectedManifestSha256) {
  return stage.validateGenofficeLicenseManifest({
    manifestPath: fixture.manifest, licenseRoot: fixture.licenses, requireComplete,
    ...(expectedManifestSha256 ? { expectedManifestSha256 } : {}),
  });
}

try {
  console.log("T87 GenOffice provenance/license smoke");
  const clean = createVerifyRoot("clean-lineage");
  pass("pinned base + approved patch + exact patch-series lineage + clean final tree passes", () => {
    const result = verifyFixture(clean);
    assert.equal(result.baseRevision, lock.baseRevision);
    assert.equal(result.approvedPatchRevision, lock.approvedPatch.revision);
    // 【T39】数量从 lock 派生,不在这里写死 —— 加一条补丁不该要改第二处。
    assert.equal(result.patchCount, lock.patchSeries.length);
    assert.equal(result.revision, lock.revision);
    assert.equal(result.tree, lock.expectedTree);
  });

  const replay = path.join(temp, "patch-replay");
  execFileSync("git", ["clone", "--local", "--no-hardlinks", vendor, replay], {
    encoding: "utf8", timeout: 120000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
  git(replay, "checkout", "--detach", lock.approvedPatch.revision);
  pass("approved patch checkout starts clean at the reviewed first patch", () => {
    assert.equal(git(replay, "rev-parse", "HEAD"), lock.approvedPatch.revision);
    assert.equal(git(replay, "status", "--porcelain", "--untracked-files=all"), "");
  });
  for (const entry of lock.patchSeries) {
    execFileSync("git", ["-C", replay, "apply", "--index", "--whitespace=nowarn", path.join(root, entry.file)], {
      encoding: "utf8", timeout: 60000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
    });
    execFileSync("git", [
      "-C", replay, "-c", "user.name=T87 patch replay", "-c", "user.email=t87-replay@example.invalid",
      "commit", "--no-gpg-sign", "--no-verify", "-m", entry.subject,
    ], { encoding: "utf8", timeout: 60000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const replayTree = git(replay, "rev-parse", "HEAD^{tree}");
    const expectedIntermediateTree = git(vendor, "rev-parse", entry.revision + "^{tree}");
    assert.equal(replayTree, expectedIntermediateTree, "tree mismatch after " + entry.file);
    logPass("patch " + entry.index + "/" + lock.patchSeries.length + " replays to its exact expected tree");
  }
  pass("replayed patch stack reproduces the current clean HEAD tree", () => {
    assert.equal(git(replay, "rev-parse", "HEAD^{tree}"), lock.expectedTree);
    assert.equal(git(vendor, "rev-parse", "HEAD^{tree}"), lock.expectedTree);
    assert.equal(git(replay, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(git(vendor, "status", "--porcelain", "--untracked-files=all"), "");
  });

  const savedLock = fs.readFileSync(clean.lockPath);
  const missingLock = JSON.parse(savedLock.toString("utf8"));
  missingLock.patchSeries.pop();
  writeLock(clean, missingLock);
  rejects("missing patch entry in lock is rejected", () => verifyFixture(clean), /patch series missing|unexpected patch count/i);
  restoreFile(clean.lockPath, savedLock);

  const reorderedLock = JSON.parse(savedLock.toString("utf8"));
  [reorderedLock.patchSeries[0], reorderedLock.patchSeries[1]] = [reorderedLock.patchSeries[1], reorderedLock.patchSeries[0]];
  writeLock(clean, reorderedLock);
  rejects("reordered patch series is rejected", () => verifyFixture(clean), /patch series identity\/order\/hash\/parent mismatch/i);
  restoreFile(clean.lockPath, savedLock);

  const changedPatch = path.join(clean.repoRoot, lock.patchSeries[3].file);
  const changedPatchBytes = fs.readFileSync(changedPatch);
  const tamperedPatchBytes = Buffer.from(changedPatchBytes);
  tamperedPatchBytes[0] ^= 1;
  fs.writeFileSync(changedPatch, tamperedPatchBytes);
  rejects("same-size patch byte tamper is rejected by pinned SHA-256", () => verifyFixture(clean), /SHA-256 mismatch/i);
  restoreFile(changedPatch, changedPatchBytes);
  pass("patch bytes/hash are exact again after mutation restoration", () => {
    assert.equal(sha256(fs.readFileSync(changedPatch)), lock.patchSeries[3].sha256);
  });

  const missingPatch = path.join(clean.repoRoot, lock.patchSeries[4].file);
  const missingPatchBytes = fs.readFileSync(missingPatch);
  fs.unlinkSync(missingPatch);
  rejects("missing patch file is rejected", () => verifyFixture(clean), /missing\/unsafe patch/i);
  restoreFile(missingPatch, missingPatchBytes);
  pass("missing patch restoration preserves exact bytes/hash", () => {
    assert.equal(sha256(fs.readFileSync(missingPatch)), lock.patchSeries[4].sha256);
  });

  const dirtyUntracked = path.join(clean.nested, ".t87-untracked-mutation");
  fs.writeFileSync(dirtyUntracked, "test fixture only");
  rejects("untracked file in nested upstream checkout is rejected", () => verifyFixture(clean), /tracked\/untracked source is dirty/i);
  fs.unlinkSync(dirtyUntracked);

  const trackedFile = path.join(clean.nested, "LICENSE");
  const trackedBytes = fs.readFileSync(trackedFile);
  fs.writeFileSync(trackedFile, Buffer.concat([trackedBytes, Buffer.from("\nT87 test-only mutation\n")]));
  rejects("tracked source mutation is rejected", () => verifyFixture(clean), /tracked\/untracked source is dirty/i);
  restoreFile(trackedFile, trackedBytes);
  pass("tracked file bytes/hash return exactly to baseline after restoration", () => {
    assert.equal(sha256(fs.readFileSync(trackedFile)), sha256(trackedBytes));
    assert.equal(git(clean.nested, "status", "--porcelain", "--untracked-files=all"), "");
  });

  git(clean.nested, "-c", "user.name=T87 test fixture", "-c", "user.email=t87-test@example.invalid",
    "commit", "--allow-empty", "--no-gpg-sign", "-m", "T87 test-only extra commit");
  rejects("extra commit after pinned final HEAD is rejected", () => verifyFixture(clean), /lineage mismatch|final commit mismatch/i);

  const licenseValidation = stage.validateGenofficeLicenseManifest({
    manifestPath: licenseManifestPath, licenseRoot, vendorRoot: vendor, repoRoot: root, requireComplete: false,
  });
  pass("exact 18-package/version/SPDX inventory and all available source hashes validate", () => {
    assert.equal(licenseValidation.verifiedCount, 14);
    assert.equal(licenseValidation.blockedCount, 4);
    assert.deepEqual(licenseValidation.blockedPackages.map(item => item.name), [
      "@electron-internal/extract-zip", "lazy-val", "ot-text-unicode", "react-remove-scroll-bar",
    ]);
  });
  rejects("strict source license gate fails closed with exact unresolved packages", () => {
    stage.validateGenofficeLicenseManifest({
      manifestPath: licenseManifestPath, licenseRoot, vendorRoot: vendor, repoRoot: root, requireComplete: true,
    });
  }, /GenOffice strict release blocked: full upstream license text is unresolved/i);
  rejects("original upstream notice is still rejected for all 18 missing full texts", () => {
    stage.assertThirdPartyNoticeComplete(vendorNotice);
  }, /lacks full license text for 18 package/);
  rejects("notice generator cannot publish partial/placeholder license material", () => {
    stage.buildCompleteThirdPartyNotice(fs.readFileSync(vendorNotice, "utf8"), licenseValidation);
  }, /unresolved/i);

  const fixtureApp = path.join(temp, "stage-fixture", "apps", "desktop");
  rejects("strict staging refuses the incomplete source manifest before creating a stage", () => {
    stage.prepareGenofficeResources({
      appDir: fixtureApp, repoRoot: root, include: true, requireCompleteLicenseBundle: true,
      licenseManifestPath,
    });
  }, /GenOffice strict release blocked: full upstream license text is unresolved/i);
  assert.equal(fs.existsSync(path.join(fixtureApp, ".tmp", "genoffice-release")), false);
  logPass("blocked strict staging leaves its previous/output stage untouched");
  rejects("strict production staging cannot bypass the reviewed source manifest", () => {
    stage.prepareGenofficeResources({
      appDir: fixtureApp, repoRoot: root, include: true, requireCompleteLicenseBundle: true,
    });
  }, /requires the reviewed third-party license source manifest/i);

  const packaged = path.join(temp, "packaged-incomplete");
  const packagedLicenses = path.join(packaged, "licenses");
  fs.mkdirSync(path.join(packagedLicenses, "GenOffice-Third-Party-Licenses"), { recursive: true });
  copyFile(licenseManifestPath, path.join(packagedLicenses, "GenOffice-THIRD-PARTY-LICENSES.json"));
  for (const item of licenseValidation.items) {
    copyFile(item.licensePath, path.join(packagedLicenses, "GenOffice-Third-Party-Licenses", item.licenseFile));
  }
  rejects("afterPack v3 refuses a packaged manifest with unresolved license texts", () => {
    afterPack.verifyPackagedLicenseAssets(packaged, {
      bundled: true, licenseBundleVersion: 3,
      licenseSourceManifestSha256: sha256(fs.readFileSync(path.join(packagedLicenses, "GenOffice-THIRD-PARTY-LICENSES.json"))),
      licenseSourcePackageCount: 18, licenseAssetsSha256: {},
    });
  }, /GenOffice strict release blocked: full upstream license text is unresolved/i);
  const previousBundleFlag = process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE;
  process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE = "1";
  try {
    rejects("strict afterPack rejects v2 provenance downgrade without test-fixture marker", () => {
      afterPack.verifyPackagedLicenseAssets(packaged, {
        bundled: true, licenseBundleVersion: 2, licenseAssetsSha256: {},
      });
    }, /missing its reviewed source-manifest provenance/i);
  } finally {
    if (previousBundleFlag === undefined) delete process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE;
    else process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE = previousBundleFlag;
  }

  const licenseFixture = copyLicenseFixture("license-mutations");
  const fixtureValidation = validateFixture(licenseFixture, false);
  pass("test fixture contains only exact copied license bytes, no generated placeholders", () => {
    assert.equal(fixtureValidation.verifiedCount, 14);
    assert.equal(fixtureValidation.blockedCount, 4);
    for (const item of fixtureValidation.items) {
      assert.deepEqual(fs.readFileSync(path.join(licenseFixture.licenses, item.licenseFile)),
        fs.readFileSync(path.join(licenseRoot, item.licenseFile)));
    }
  });

  const originalFixtureManifest = fs.readFileSync(licenseFixture.manifest);
  const wrongVersionManifest = JSON.parse(originalFixtureManifest.toString("utf8"));
  wrongVersionManifest.items[1].version = "1.0.4";
  fs.writeFileSync(licenseFixture.manifest, JSON.stringify(wrongVersionManifest, null, 2) + "\n");
  const wrongVersionManifestHash = sha256(fs.readFileSync(licenseFixture.manifest));
  rejects("wrong package version mapping is rejected", () =>
    validateFixture(licenseFixture, false, wrongVersionManifestHash), /identity\/version\/SPDX mismatch/i);
  restoreFile(licenseFixture.manifest, originalFixtureManifest);
  pass("manifest bytes/hash are exact again after version-map restoration", () => {
    assert.equal(sha256(fs.readFileSync(licenseFixture.manifest)), sha256(originalFixtureManifest));
  });

  for (const item of fixtureValidation.items) {
    const file = path.join(licenseFixture.licenses, item.licenseFile);
    const original = fs.readFileSync(file);
    fs.unlinkSync(file);
    rejects("deleting " + item.name + " license text is rejected", () => validateFixture(licenseFixture, false), /missing|license source|ENOENT/i);
    restoreFile(file, original);
    assert.equal(sha256(fs.readFileSync(file)), item.licenseTextSha256);
    logPass("restored " + item.name + " license bytes/hash match source manifest");

    const tampered = Buffer.from(original);
    tampered[0] ^= 1;
    fs.writeFileSync(file, tampered);
    rejects("tampering " + item.name + " license text is rejected", () => validateFixture(licenseFixture, false), /SHA-256 mismatch/i);
    restoreFile(file, original);
    assert.equal(sha256(fs.readFileSync(file)), item.licenseTextSha256);
    logPass("restored " + item.name + " license bytes/hash match source manifest after tamper");
  }

  pass("real GenOffice vendor checkout and notice were not modified", () => {
    assert.equal(git(vendor, "rev-parse", "HEAD"), originalVendorHead);
    assert.equal(git(vendor, "status", "--porcelain", "--untracked-files=all"), originalVendorStatus);
    assert.equal(sha256(fs.readFileSync(vendorNotice)), originalVendorNoticeHash);
    assert.equal(fs.readFileSync(licenseManifestPath, "utf8").includes('"releaseEligible": false'), true);
  });

  console.log("T87 provenance/license smoke: " + total + "/" + total + " PASS");
  console.log("Release status: BLOCKED — 14/18 full license texts verified; 4 exact package@version entries still lack authoritative full-text evidence (T11).");
  console.log("Patch replay tree: " + git(replay, "rev-parse", "HEAD^{tree}") + " (expected " + lock.expectedTree + ")");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
