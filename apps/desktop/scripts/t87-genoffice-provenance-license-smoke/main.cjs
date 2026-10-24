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
    // 【T117】四个上游缺文本的包现在带 `missingEvidenceDisposition` 签字，
    // 进 `excusedCount` 而**不**进 `blockedCount`（后者的语义已收窄为
    // 「未签字的阻塞」）。这里同时钉住两边：挡住「悄悄删掉签字」的退路。
    assert.equal(licenseValidation.blockedCount, 0);
    assert.equal(licenseValidation.excusedCount, 4);
    assert.deepEqual(licenseValidation.excusedPackages.map(item => item.name).sort(), [
      "@electron-internal/extract-zip", "lazy-val", "ot-text-unicode", "react-remove-scroll-bar",
    ]);
  });
  // 【T117】严格门禁**不再**因这四个包失败 —— 它们已逐条签字。原断言验的是
  // 「写死阻塞」那套策略；现在要验的是「签字之外仍然 fail-closed」，
  // 所以把清单复制一份删掉签字再跑（与 t11 同一手法）。
  {
    const unsignedDir = path.join(__dirname, "../../.tmp");
    fs.mkdirSync(unsignedDir, { recursive: true });
    const unsignedPath = path.join(unsignedDir, `t87-unsigned-${process.pid}.json`);
    const unsigned = JSON.parse(fs.readFileSync(licenseManifestPath, "utf8"));
    for (const entry of unsigned.items) delete entry.missingEvidenceDisposition;
    unsigned.excusedCount = 0;
    unsigned.releaseEligible = false;
    fs.writeFileSync(unsignedPath, JSON.stringify(unsigned, null, 2) + "\n");
    const unsignedSha = sha256(fs.readFileSync(unsignedPath));
    try {
      rejects("strict source license gate fails closed with exact unresolved packages", () => {
        stage.validateGenofficeLicenseManifest({
          manifestPath: unsignedPath, licenseRoot, vendorRoot: vendor, repoRoot: root,
          requireComplete: true, expectedManifestSha256: unsignedSha,
        });
      }, /GenOffice strict release blocked: full upstream license text is unresolved/i);
    } finally {
      try { fs.rmSync(unsignedPath, { force: true }); } catch { /* 清不掉不影响结论 */ }
    }
  }
  rejects("original upstream notice is still rejected for all 18 missing full texts", () => {
    stage.assertThirdPartyNoticeComplete(vendorNotice);
  }, /lacks full license text for 18 package/);
  // 【T117】真实清单（14 原文 + 4 签字例外）现在**能**出通知；原来这条断言
  // 「拒绝真实清单」等于要求门禁永远不放行 GenOffice。改成验签字之外仍拒绝。
  {
    const unsignedDir = path.join(__dirname, "../../.tmp");
    fs.mkdirSync(unsignedDir, { recursive: true });
    const unsignedPath = path.join(unsignedDir, `t87-unsigned-notice-${process.pid}.json`);
    const unsigned = JSON.parse(fs.readFileSync(licenseManifestPath, "utf8"));
    for (const entry of unsigned.items) delete entry.missingEvidenceDisposition;
    unsigned.excusedCount = 0;
    unsigned.releaseEligible = false;
    fs.writeFileSync(unsignedPath, JSON.stringify(unsigned, null, 2) + "\n");
    const unsignedSha = sha256(fs.readFileSync(unsignedPath));
    try {
      const unsignedValidation = stage.validateGenofficeLicenseManifest({
        manifestPath: unsignedPath, licenseRoot, vendorRoot: vendor, repoRoot: root,
        requireComplete: false, expectedManifestSha256: unsignedSha,
      });
      rejects("notice generator cannot publish partial/placeholder license material", () => {
        stage.buildCompleteThirdPartyNotice(fs.readFileSync(vendorNotice, "utf8"), unsignedValidation);
      }, /unresolved/i);
    } finally {
      try { fs.rmSync(unsignedPath, { force: true }); } catch { /* 清不掉不影响结论 */ }
    }
  }

  const fixtureApp = path.join(temp, "stage-fixture", "apps", "desktop");
  // 【T117】这条原本验「严格暂存拒绝残缺清单」。真实清单现在带四个签字例外、
  // 不再残缺，而 `prepareGenofficeResources` 把清单 SHA 钉死成
  // `GENOFFICE_LICENSE_MANIFEST_SHA256`（没有注入口），**喂不进改过的副本**。
  //
  // 所以这里改成验两件真实的事：
  //   1. 严格暂存**通过了清单门禁** —— fixture app 里没有 electron，
  //      所以实际抛的是 `Cannot find module 'electron/package.json'`；
  //      这条恰恰证明许可证门禁**没有**再误拒（否则会先抛 strict blocked）；
  //   2. 失败发生在写 stage 之前 —— 目录仍然不存在。
  rejects("strict staging passes the license gate and fails later, before writing a stage", () => {
    stage.prepareGenofficeResources({
      appDir: fixtureApp, repoRoot: root, include: true, requireCompleteLicenseBundle: true,
      licenseManifestPath,
    });
  }, /Cannot find module 'electron\/package\.json'/);
  assert.equal(fs.existsSync(path.join(fixtureApp, ".tmp", "genoffice-release")), false);
  logPass("strict staging fails before creating a stage, and not on the license gate");
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
  // 【T117】这条原本验「afterPack 拒绝残缺清单」。真实清单已带签字例外、不再残缺，
  // 这条路径就永远走不到 strict-blocked 分支。改成验它**真正该守的两件事**：
  //   1. 一份完整、digest 齐全的打包产物**必须通过**（证明没有误拒）；
  //   2. 少一个 digest 就**必须拒绝**（证明它没有变成永远放行）。
  const packagedLegacy = ["GenOffice-LICENSE", "GenOffice-NOTICE", "PDFium-LICENSE", "PDFium-LICENSE.pdfium"];
  const packagedComplete = [...packagedLegacy, "GenOffice-THIRD-PARTY-NOTICES.txt", "LICENSES.chromium.html"];
  // 每份都要**真实内容**：afterPack 会逐份校验 `assertThirdPartyNoticeTextComplete`，
  // 拿 LICENSE 冒充 NOTICES 会被 PDFium 条款检查挡住（我第一版就是这么写的）。
  const packagedSources = {
    "GenOffice-LICENSE": path.join(vendor, "LICENSE"),
    "GenOffice-NOTICE": path.join(vendor, "NOTICE"),
    "PDFium-LICENSE": path.join(vendor, "node_modules/@embedpdf/pdfium/LICENSE"),
    "PDFium-LICENSE.pdfium": path.join(vendor, "node_modules/@embedpdf/pdfium/LICENSE.pdfium"),
    // 打包进产物的通知是**生成后**的完整版（含四个签字例外），不是上游原文。
    "GenOffice-THIRD-PARTY-NOTICES.txt": null,
    // 不依赖 `.tmp/genoffice-release` 里是否有上一次暂存的产物 —— 直接从
    // electron 包取，与 `resolveChromiumLicense` 同一判据。
    "LICENSES.chromium.html": (() => {
      const appDir = path.join(root, "apps", "desktop");
      return stage.resolveChromiumLicense(appDir, root).path;
    })(),
  };
  for (const name of packagedComplete) {
    const from = packagedSources[name];
    if (from) fs.copyFileSync(from, path.join(packagedLicenses, name));
  }
  // 通知用 `buildCompleteThirdPartyNotice` 现生成 —— 与真实打包路径同一份实现。
  fs.writeFileSync(
    path.join(packagedLicenses, "GenOffice-THIRD-PARTY-NOTICES.txt"),
    stage.buildCompleteThirdPartyNotice(fs.readFileSync(vendorNotice, "utf8"), licenseValidation),
    "utf8",
  );
  const packagedManifestPath = path.join(packagedLicenses, "GenOffice-THIRD-PARTY-LICENSES.json");
  const packagedNames = [
    ...packagedComplete,
    "GenOffice-THIRD-PARTY-LICENSES.json",
    ...licenseValidation.items.map(item => "GenOffice-Third-Party-Licenses/" + item.licenseFile),
  ];
  const packagedDigests = {};
  for (const name of packagedNames) packagedDigests[name] = sha256(fs.readFileSync(path.join(packagedLicenses, name)));
  const packagedInfo = {
    bundled: true, licenseBundleVersion: 3,
    licenseSourceManifestSha256: sha256(fs.readFileSync(packagedManifestPath)),
    licenseSourcePackageCount: 18, licenseAssetsSha256: packagedDigests,
    chromiumLicenseElectronVersion: require("electron/package.json").version,
  };
  afterPack.verifyPackagedLicenseAssets(packaged, packagedInfo);
  pass("afterPack accepts a packaged bundle whose digests are complete (no false refusal)", () => {});
  const missingOne = { ...packagedDigests };
  delete missingOne["GenOffice-NOTICE"];
  rejects("afterPack v3 refuses a packaged license set with a missing digest", () => {
    afterPack.verifyPackagedLicenseAssets(packaged, { ...packagedInfo, licenseAssetsSha256: missingOne });
  }, /license asset integrity manifest is missing or invalid/i);
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
    // 【T117】四个上游缺文本的包带签字进 `excusedCount`，不再计入 `blockedCount`。
    assert.equal(fixtureValidation.blockedCount, 0);
    assert.equal(fixtureValidation.excusedCount, 4);
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
    // 【T117】`releaseEligible` 现在是 true（四个包已逐条签字）。原文这条断言
    // 钉的是「仍不可发版」——那是写死阻塞时的判断，与已批准的方案相反。
    assert.equal(fs.readFileSync(licenseManifestPath, "utf8").includes('"releaseEligible": true'), true);
  });

  console.log("T87 provenance/license smoke: " + total + "/" + total + " PASS");
  console.log("Release status: ELIGIBLE — 14 verified texts + 4 signed upstream-omission exceptions (18/18 accounted for).");
  console.log("Patch replay tree: " + git(replay, "rev-parse", "HEAD^{tree}") + " (expected " + lock.expectedTree + ")");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
