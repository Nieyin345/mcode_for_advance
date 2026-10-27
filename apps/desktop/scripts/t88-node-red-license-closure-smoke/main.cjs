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
  // Node 22 on Windows crashes in cpSync's native fast path when the path has
  // non-ASCII characters (nodejs/node#54476, #63970). Passing any filter forces
  // the JS implementation, which is unaffected. Keep filter even though it
  // accepts everything: it is what selects the JS path.
  const materialsTarget = path.join(target, "materials");
  // ⚠️ **先删后拷，不是多余的保险。**
  // Node 22 + Windows 下，`cpSync` 在「非 ASCII 源 + 目标已有同名文件」时会抛错
  // （errno=0，信息还骗人：「The operation completed successfully」），而 `filter`
  // **救不了这一格** —— 它只在目标全新建时有效。
  // 这个函数的调用点里，目标可能已被上一步的整树拷贝建好（t88 的
  // current-stage-copy 就是），所以必须先清掉目标再拷。
  fs.rmSync(materialsTarget, { recursive: true, force: true });
  fs.cpSync(path.join(SOURCE_ROOT, "materials"), materialsTarget, {
    recursive: true, dereference: false, filter: () => true,
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
  includePauseUnknown = false,
  finalize = true,
} = {}) {
  fs.mkdirSync(root, { recursive: true });
  const effectiveManifest = includePauseUnknown
    ? {
        ...manifest,
        entries: manifest.entries.filter(entry => !(entry.packageName === "pause" && entry.version === "0.0.1")),
      }
    : manifest;
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

  const effectivePackageEntries = includePauseUnknown
    ? packageEntries.filter(entry => !(entry.packageName === "pause" && entry.version === "0.0.1"))
    : packageEntries;
  for (const entry of effectivePackageEntries) {
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
  if (includePauseUnknown) {
    // A pause package with no license metadata and no reviewed mapping: the gate
    // must keep failing closed exactly as it did before the pause integration.
    lockPackages["node_modules/pause"] = {
      name: "pause",
      version: "0.0.1",
      resolved: "https://registry.npmjs.org/pause/-/pause-0.0.1.tgz",
      integrity: "sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==",
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
  copyLicenseTree(root, effectiveManifest);
  return finalize ? hashManifest(root) : null;
}

try {
  verify("source manifest binds exact package versions, SPDX expressions, upstream revisions and file SHA-256 values", () => {
    assert.equal(SOURCE_MANIFEST.nodeRedVersion, VERSION);
    assert.equal(SOURCE_MANIFEST.nodeRedSourceCommit, BASE_COMMIT);
    assert.equal(SOURCE_MANIFEST.entries.length, 16);
    assert.equal(SOURCE_MANIFEST.entries.reduce((sum, entry) => sum + entry.materials.length, 0), 17);
    assert.equal(SOURCE_MANIFEST.blockers.length, 0);
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
    const pause = SOURCE_MANIFEST.entries.find(entry => entry.packageName === "pause" && entry.version === "0.0.1");
    assert.equal(pause.licenseExpression, "MIT");
    assert.equal(pause.packageSource.revision, "11d0dcaca51ee8cdf09915be0ba14c41871009b5");
    assert.equal(pause.metadataOverride.reviewed, true);
    assert.equal(pause.metadataOverride.licenseTextFile, false);
    assert.equal(pause.metadataOverride.fileName, "Readme.md");
    assert.equal(pause.materials[0].sha256, "d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d");
    const notice = fs.readFileSync(path.join(SOURCE_ROOT, "THIRD-PARTY-LICENSES.txt"), "utf8");
    assert.match(notice, /Apache License/);
    assert.match(notice, /Creative Commons Legal Code/);
    assert.match(notice, /Package: pause@0\.0\.1/);
    assert.doesNotMatch(notice, /RELEASE BLOCKER/);
  });

  const positiveRoot = path.join(base, "positive");
  const positiveInventory = makeFixture(positiveRoot);
  verify("complete exact-version mappings supply all license texts and afterPack accepts a blocker-free fixture", () => {
    assert.equal(positiveInventory.summary.packageCount, 21);
    assert.equal(positiveInventory.summary.reviewedExternalLicenseMappings, 16);
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
    const pause = positiveInventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
    assert.equal(pause.status, "collected");
    assert.equal(pause.license, "MIT");
    assert.equal(pause.licenseMetadataOverride.reviewed, true);
    assert.equal(verifyNodeRed.verifyNodeRedResource(positiveRoot).licenseCoverage.releaseEligible, true);
  });

  verify("unknown license metadata stays a release blocker even when a reviewed mapping covers every other package", () => {
    const root = path.join(base, "pause-unknown-license");
    const inventory = makeFixture(root, { includePauseUnknown: true });
    const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
    assert.equal(pause.status, "unknown-license");
    assert.equal(pause.license, null);
    assert.equal(pause.licenseTextPresent, false);
    assert.equal(inventory.summary.unknownLicenseMetadata, 1);
    assert.equal(inventory.summary.releaseEligible, false);
    assert.throws(() => verifyNodeRed.verifyNodeRedResource(root), /pause@0\.0\.1 \[unknown-license/i);
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
    // Node 22 在 Windows 上对非 ASCII 路径的 native fast path 会崩（nodejs/node#54476）。
    // 任何 filter 都会强制走 JS 实现 —— 见本文件 :37 的完整说明。
    fs.cpSync(CURRENT_STAGE, stageCopy, { recursive: true, dereference: false, filter: () => true });
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
    verify("isolated copy of the 420-package stage maps every reviewed version and is release-eligible after the pause integration", () => {
      // 420 = Node-RED 5.0.8 vendor 快照里被许可审计覆盖的包数。
      //
      // 出处不是那两个 manifest.json（它们没有这个字段）：
      //   构建产物里的 `.tmp/node-red-release/third-party-license-inventory.json`
      //   的 `summary.packageCount`（`createNodeRedLicenseInventory` 算出来的）。
      //
      // ⚠️ **它红了先查为什么，不要直接把 420 换成新数字。** 包数变化可能是：
      //   ① 有意升级 vendor 版本 → 该改这里的数，并复核 manifest / 许可树；
      //   ② 依赖解析漂移或产物不全 → **那是 bug，改数字等于把 bug 藏起来**。
      // 区分方法（注意：不能拿 `inventory.summary.packageCount` 去和这条比，
      // 那是同一个值，永远相等）。要看**依赖树本身**有没有变：
      //   - `ls <stage>/node_modules | wc -l` → 当前 254（顶层条目，含 @scope 目录）；
      //   - `package-lock.json` 里 `node_modules/` 开头的条目 → 当前 1063
      //     （含嵌套依赖，所以远大于 254）。
      // 记下这两个数做对照，而不是记 420 本身：
      //   - 这两个数都没变而 420 红了 → 审计口径变了，是 bug（②）；
      //   - 这两个数也变了 → 依赖树真变了；结合是否升级 vendor 判断 ① / ②。
      //
      // 为什么保留这个绝对值而不是改成 > 0：它还兼当「确实读到了那份完整产物」的
      // 存在性证明。换成下界后，「目录在但被清空」会静默通过。
      assert.equal(inventory.summary.packageCount, 420);
      assert.equal(inventory.summary.reviewedExternalLicenseMappings, 16);
      assert.equal(inventory.summary.unmatchedLicenseManifestEntries, 0);
      assert.equal(inventory.summary.unknownSpdxExpressions, 0);
      assert.equal(inventory.summary.unknownLicenseMetadata, 0);
      assert.equal(inventory.summary.missingLicenseText, 0);
      assert.equal(inventory.summary.releaseBlockers, 0);
      assert.equal(inventory.summary.releaseEligible, true);
      const pause = inventory.packages.find(item => item.name === "pause" && item.version === "0.0.1");
      assert.equal(pause.status, "collected");
      assert.equal(pause.license, "MIT");
      assert.equal(verifyNodeRed.verifyNodeRedResource(stageCopy).licenseCoverage.releaseEligible, true);
    });
    verify("afterPack rejects same-size license material tampering and accepts the restored bytes", () => {
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
      assert.equal(verifyNodeRed.verifyNodeRedResource(stageCopy).licenseCoverage.releaseEligible, true);
      console.log("    mutation SHA-256: " + mutatedHash + "; restored SHA-256: " + restoredHash);
    });
  } else {
    console.log("  skip  current 420-package stage copy: .tmp/node-red-release is unavailable");
  }

  console.log("t88-node-red-license-closure-smoke: " + total + "/" + total + " PASS");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
