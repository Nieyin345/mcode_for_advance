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
  const packages = {
    ["node_modules/" + canvasName]: {
      version: canvas.version,
      resolved: canvas.npmTarballUrl,
      integrity: canvas.npmTarballIntegrity,
      license: canvas.spdx,
      optional: true,
      os: ["win32"],
      cpu: ["x64"],
    },
  };
  for (const expected of stage.REQUIRED_GENOFFICE_LICENSE_PACKAGES) {
    if (expected.name === canvasName) continue;
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
  return { manifest, canvas };
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

test("the platform-filtered optional package follows the actual host platform", () => {
  if (process.platform === "win32" && process.arch === "x64") {
    assert.throws(() => validate(),
      /GenOffice installed package missing on a compatible platform/);
    return;
  }
  const result = validate();
  assert.equal(result.verifiedCount, 14);
  assert.equal(result.excusedCount, 4);
  assert.equal(result.blockedCount, 0);
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
