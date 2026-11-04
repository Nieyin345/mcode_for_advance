"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const stage = require("./stage-genoffice-resources.cjs");
const sourceManifest = path.join(root, "apps/desktop/build/vendor-licenses/genoffice/manifest.json");
const sourceLicenses = path.join(path.dirname(sourceManifest), "licenses");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-genoffice-platform-license-"));
const repoRoot = path.join(temp, "repo");
const manifestPath = path.join(repoRoot, "manifest.json");
const licenseRoot = path.join(repoRoot, "licenses");
const vendorRoot = path.join(repoRoot, "genoffice");
const canvasName = "@napi-rs/canvas-win32-x64-msvc";
const canvasVariants = [
  { name: canvasName, os: ["win32"], cpu: ["x64"] },
  { name: "@napi-rs/canvas-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  { name: "@napi-rs/canvas-darwin-x64", os: ["darwin"], cpu: ["x64"] },
];
const canvasNames = new Set(canvasVariants.map(item => item.name));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function buildFixture() {
  const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
  fs.mkdirSync(licenseRoot, { recursive: true });
  fs.mkdirSync(path.join(vendorRoot, "node_modules"), { recursive: true });
  fs.copyFileSync(sourceManifest, manifestPath);
  for (const item of manifest.items.filter(entry => entry.status === "verified")) {
    fs.copyFileSync(path.join(sourceLicenses, item.licenseFile), path.join(licenseRoot, item.licenseFile));
  }

  const canvas = manifest.items.find(item => item.name === canvasName);
  assert.ok(canvas, "reviewed manifest must contain the Windows Canvas optional package");
  const packages = {};
  const canvasItems = [];
  for (const variant of canvasVariants) {
    const item = manifest.items.find(entry => entry.name === variant.name);
    assert.ok(item, "reviewed manifest must contain " + variant.name);
    canvasItems.push(item);
    packages["node_modules/" + variant.name] = {
      version: item.version,
      resolved: item.npmTarballUrl,
      integrity: item.npmTarballIntegrity,
      license: item.spdx,
      optional: true,
      os: variant.os,
      cpu: variant.cpu,
    };
    // Model the current macOS optional package as installed. The Windows x64
    // package intentionally remains absent on Windows x64 to prove the gate
    // rejects a missing package on a compatible host.
    if (process.platform === "darwin" && process.arch === variant.cpu[0]) {
      const file = path.join(vendorRoot, "node_modules", ...variant.name.split("/"), "package.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        name: item.name, version: item.version, license: item.spdx,
      }) + "\n");
    }
  }
  for (const expected of stage.REQUIRED_GENOFFICE_LICENSE_PACKAGES) {
    if (canvasNames.has(expected.name)) continue;
    const item = manifest.items.find(entry => entry.name === expected.name);
    assert.ok(item, "reviewed manifest package " + expected.name);
    const file = path.join(vendorRoot, "node_modules", ...expected.name.split("/"), "package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      name: item.name, version: item.version, license: item.spdx,
    }) + "\n");
  }
  fs.writeFileSync(path.join(vendorRoot, "package-lock.json"), JSON.stringify({
    name: "genoffice",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  }, null, 2) + "\n");
  return { manifest, canvas, canvasItems };
}

const fixture = buildFixture();

function validate() {
  return stage.validateGenofficeLicenseManifest({
    manifestPath,
    licenseRoot,
    vendorRoot,
    repoRoot,
    expectedManifestSha256: sha256(fs.readFileSync(manifestPath)),
    requireComplete: false,
  });
}
function validateWithoutVendor() {
  return stage.validateGenofficeLicenseManifest({
    manifestPath,
    licenseRoot,
    repoRoot,
    expectedManifestSha256: sha256(fs.readFileSync(manifestPath)),
    requireComplete: false,
  });
}

test("the platform-filtered optional package follows the actual host platform", () => {
  if (process.platform === "win32" && process.arch === "x64") {
    assert.throws(() => validate(),
      /GenOffice installed package missing on a compatible platform/);
    return;
  }
  const result = validate();
  assert.equal(result.verifiedCount, 16);
  assert.equal(result.excusedCount, 4);
  assert.equal(result.blockedCount, 0);
});

test("the generated third-party notice restores the full license section omitted by npm platform filtering", () => {
  // Exercise the notice builder independently from the host-specific package
  // installation gate. The validator's real-host behavior is covered above.
  const validation = validateWithoutVendor();
  const platformItems = validation.items.filter(item => canvasNames.has(item.name));
  assert.equal(platformItems.length, canvasVariants.length);
  const variantsByName = new Map(canvasVariants.map(item => [item.name, item]));
  for (const item of platformItems) {
    const variant = variantsByName.get(item.name);
    item.platformExcluded = true;
    item.platformExclusion = { platform: variant.os[0], arch: variant.cpu[0] };
  }
  validation.platformExcludedCount = platformItems.length;
  validation.platformExcludedPackages = platformItems.map(item => ({
    name: item.name, version: item.version, spdx: item.spdx, status: "verified",
    platform: item.platformExclusion.platform, arch: item.platformExclusion.arch,
  }));

  const section = title => "\n" + "-".repeat(72) + "\n" + title +
    "\n" + "-".repeat(72) + "\nupstream placeholder notice body\n";
  const excluded = new Set(platformItems.map(item => item.name + " v" + item.version + " — " + item.spdx));
  const sourceText = "GenOffice upstream notices\n" +
    validation.items.filter(item => !excluded.has(item.name + " v" + item.version + " — " + item.spdx))
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("") +
    validation.excusedPackages
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("");
  const generated = stage.buildCompleteThirdPartyNotice(sourceText, validation);
  stage.assertThirdPartyNoticeMatchesManifest(generated, validation);
  for (const item of platformItems) {
    const title = item.name + " v" + item.version + " — " + item.spdx;
    assert.equal(generated.split(title).length - 1, 1);
    assert.ok(generated.includes(item.licenseText.trimEnd()));
    assert.ok(generated.includes("Source: " + item.licenseSourceUrl));
    assert.ok(generated.includes("License SHA-256: " + item.licenseTextSha256));
  }
});

test("the generated notice restores a signed exception section omitted by npm platform filtering", () => {
  const validation = validateWithoutVendor();
  const canvas = validation.items.find(item => item.name === canvasName);
  const excused = validation.excusedPackages[0];
  assert.ok(canvas && excused);
  canvas.platformExcluded = true;
  canvas.platformExclusion = { platform: "darwin", arch: "arm64" };
  excused.platformExcluded = true;
  excused.platformExclusion = { platform: "darwin", arch: "arm64" };
  validation.platformExcludedCount = 2;
  validation.platformExcludedPackages = [canvas, excused].map(item => ({
    name: item.name, version: item.version, spdx: item.spdx,
    platform: item.platformExclusion.platform, arch: item.platformExclusion.arch,
  }));

  const excluded = new Set([
    canvas.name + " v" + canvas.version + " — " + canvas.spdx,
    excused.name + " v" + excused.version + " — " + excused.spdx,
  ]);
  const section = title => "\n" + "-".repeat(72) + "\n" + title +
    "\n" + "-".repeat(72) + "\nupstream placeholder notice body\n";
  const sourceText = "GenOffice upstream notices\n" +
    validation.items.filter(item => !excluded.has(item.name + " v" + item.version + " — " + item.spdx))
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("") +
    validation.excusedPackages.filter(item => !excluded.has(item.name + " v" + item.version + " — " + item.spdx))
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("");
  const generated = stage.buildCompleteThirdPartyNotice(sourceText, validation);
  stage.assertThirdPartyNoticeMatchesManifest(generated, validation);
  const excusedSection = stage.findNoticeSection(generated,
    excused.name + " v" + excused.version + " — " + excused.spdx);
  assert.ok(excusedSection);
  assert.ok(excusedSection.body.includes("NO LICENSE TEXT WAS SHIPPED WITH THIS VERSION."));
  assert.ok(excusedSection.body.includes(excused.evidence));
  assert.ok(excusedSection.body.includes("Reviewed: " + excused.disposition.reviewedAt));
  assert.ok(excusedSection.body.includes("Platform note: npm omitted this optional package on darwin/arm64."));
});

test("a missing ordinary package notice section remains a hard failure", () => {
  const validation = validateWithoutVendor();
  const canvas = validation.items.find(item => item.name === canvasName);
  const ordinary = validation.items.find(item => item.name !== canvasName);
  assert.ok(canvas && ordinary);
  canvas.platformExcluded = true;
  const section = title => "\n" + "-".repeat(72) + "\n" + title +
    "\n" + "-".repeat(72) + "\nupstream placeholder notice body\n";
  const sourceText = "GenOffice upstream notices\n" +
    validation.items.filter(item => item !== canvas && item !== ordinary)
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("") +
    validation.excusedPackages
      .map(item => section(item.name + " v" + item.version + " — " + item.spdx)).join("");
  assert.throws(() => stage.buildCompleteThirdPartyNotice(sourceText, validation),
    /GenOffice third-party notice package sections do not match the verified source manifest/);
});

test("a missing optional package is rejected when lock constraints include the current host", () => {
  const lockPath = path.join(vendorRoot, "package-lock.json");
  const original = fs.readFileSync(lockPath);
  const changed = JSON.parse(original.toString("utf8"));
  const entry = changed.packages["node_modules/" + canvasName];
  entry.os = [process.platform];
  entry.cpu = [process.arch];
  fs.writeFileSync(lockPath, JSON.stringify(changed, null, 2) + "\n");
  try {
    assert.throws(() => validate(),
      /GenOffice installed package missing on a compatible platform/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
  assert.deepEqual(fs.readFileSync(lockPath), original);
});

test("a missing optional package cannot bypass the reviewed tarball integrity", () => {
  const lockPath = path.join(vendorRoot, "package-lock.json");
  const original = fs.readFileSync(lockPath);
  const changed = JSON.parse(original.toString("utf8"));
  changed.packages["node_modules/" + canvasName].integrity = "sha512-tampered";
  fs.writeFileSync(lockPath, JSON.stringify(changed, null, 2) + "\n");
  try {
    assert.throws(() => validate(),
      /GenOffice missing optional package lock identity differs from reviewed license manifest/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
  assert.deepEqual(fs.readFileSync(lockPath), original);
});

test("a missing package is not excused when the lock entry is not optional", () => {
  const lockPath = path.join(vendorRoot, "package-lock.json");
  const original = fs.readFileSync(lockPath);
  const changed = JSON.parse(original.toString("utf8"));
  changed.packages["node_modules/" + canvasName].optional = false;
  fs.writeFileSync(lockPath, JSON.stringify(changed, null, 2) + "\n");
  try {
    assert.throws(() => validate(),
      /GenOffice missing optional package lock identity differs from reviewed license manifest/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
  assert.deepEqual(fs.readFileSync(lockPath), original);
});

test("malformed npm OS/CPU constraints cannot be treated as proof of platform exclusion", () => {
  const lockPath = path.join(vendorRoot, "package-lock.json");
  const original = fs.readFileSync(lockPath);
  const changed = JSON.parse(original.toString("utf8"));
  changed.packages["node_modules/" + canvasName].os = [""];
  fs.writeFileSync(lockPath, JSON.stringify(changed, null, 2) + "\n");
  try {
    assert.throws(() => validate(),
      /GenOffice optional package lock has malformed OS constraint/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
  assert.deepEqual(fs.readFileSync(lockPath), original);
});

test("the fixture preserves the reviewed package and license inventories", () => {
  const source = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
  assert.equal(source.items.length, stage.REQUIRED_GENOFFICE_LICENSE_PACKAGES.length);
  assert.equal(fixture.canvas.version, "1.0.3");
  assert.equal(fixture.canvas.spdx, "MIT");
  assert.equal(fixture.canvas.npmTarballIntegrityVerified, true);
});

test.after(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
