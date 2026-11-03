"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { inspectNsis, inspectMacRelease, inspectMacDmg, inspectMacZip, verifyMacApp } = require("./verify.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-nf-release-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name, data = "NATIVE_BINARY_TEST") => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return p;
  };
  return { dir, file, source: file("source.node"), unpacked: file("unpacked.node"),
    nsis: file("Mcode-1.2.3.exe", "fake-install"), dmg: file("Mcode-1.2.3.dmg", "fake-dmg"),
    zip: file("Mcode-1.2.3.zip", "fake-zip") };
}
function fakeSevenZip(payload, paths = ["resources\\native-fs\\mcode_fs.node"],
  outerPaths = ["$pluginsdir\\app-64.7z"]) {
  return {
    sevenZip: "fake-7z",
    run(args) {
      if (args[0] === "l" && args[3]?.toLowerCase().endsWith(".exe")) {
        assert.deepEqual(args.slice(0, 3), ["l", "-ba", "-slt"]);
        assert.equal(args.length, 4, "NSIS wrapper listing must not use a wildcard filter");
        return Buffer.from(outerPaths.map(p => "Path = " + p).join("\n"));
      }
      if (args[0] === "x") {
        assert.deepEqual(args.slice(0, 3), ["x", "-y", "-bd"]);
        assert.equal(args.length, 6, "extract only the fixed inner app-64.7z payload");
        assert.equal(args[5], "$pluginsdir\\app-64.7z");
        const output = args[3].slice(2);
        const innerArchive = path.join(output, "$pluginsdir", "app-64.7z");
        fs.mkdirSync(path.dirname(innerArchive), { recursive: true });
        fs.writeFileSync(innerArchive, "FAKE_APP_64");
        return Buffer.from("");
      }
      if (args[0] === "l" && args[3]?.toLowerCase().endsWith(".7z")) {
        assert.deepEqual(args.slice(0, 3), ["l", "-ba", "-slt"]);
        assert.equal(args.length, 4, "inspect the extracted inner app archive");
        return Buffer.from(paths.map(p => "Path = " + p).join("\n"));
      }
      if (args[0] === "e") {
        assert.ok(args[2].toLowerCase().endsWith(".7z"), "extract the addon from app-64.7z, not the NSIS wrapper");
        return Buffer.from(payload);
      }
      throw Error("unexpected 7z args");
    },
  };
}
function macFixture(t) {
  const f = fixture(t);
  const bundle = path.join(f.dir, "mac-bundle");
  const addon = path.join(bundle, "Mcode.app", "Contents", "Resources", "native-fs", "mcode_fs.node");
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.copyFileSync(f.source, addon);
  const options = {
    allowTestPlatform: true,
    hdiutil(args) {
      if (args[0] === "attach") fs.cpSync(bundle, args[4], { recursive: true });
      else if (args[0] !== "detach") throw Error("unexpected hdiutil operation");
    },
    ditto(args) {
      assert.deepEqual(args.slice(0, 2), ["-x", "-k"]);
      fs.cpSync(bundle, args[3], { recursive: true });
    },
  };
  return { ...f, bundle, addon, options };
}

test("NSIS: compares exact addon bytes with source and afterPack staging", t => {
  const f = fixture(t);
  const result = inspectNsis(f.nsis, f.source, f.unpacked, fakeSevenZip("NATIVE_BINARY_TEST"));
  assert.equal(result.ok, true);
  assert.equal(result.embeddedArchive, "$pluginsdir/app-64.7z");
  assert.ok(result.embeddedArchiveSize > 0);
  assert.equal(result.addonSize, Buffer.byteLength("NATIVE_BINARY_TEST"));
});
test("NSIS: tampered addon fails closed even if present", t => {
  const f = fixture(t);
  assert.throws(() => inspectNsis(f.nsis, f.source, f.unpacked, fakeSevenZip("CORRUPTED_BYTES")), /differs/);
});
test("NSIS: missing embedded app-64.7z fails closed", t => {
  const f = fixture(t);
  assert.throws(() => inspectNsis(f.nsis, f.source, f.unpacked,
    fakeSevenZip("NATIVE_BINARY_TEST", undefined, [])), /exactly one/);
});
test("NSIS: missing and duplicate inner addon entries fail closed", t => {
  const f = fixture(t);
  for (const names of [[], ["resources/native-fs/mcode_fs.node", "resources\\native-fs\\mcode_fs.node"]]) {
    assert.throws(() => inspectNsis(f.nsis, f.source, f.unpacked, fakeSevenZip("NATIVE_BINARY_TEST", names)),
      /exactly one/);
  }
});
test("NSIS: staged binary must also match approved source", t => {
  const f = fixture(t);
  fs.writeFileSync(f.unpacked, "STALE");
  assert.throws(() => inspectNsis(f.nsis, f.source, f.unpacked, fakeSevenZip("NATIVE_BINARY_TEST")), /unpacked addon/);
});
test("NSIS: suspicious archive and binary symlinks are rejected", t => {
  const f = fixture(t);
  fs.unlinkSync(f.unpacked);
  try { fs.symlinkSync(f.source, f.unpacked, "file"); } catch (e) { if (e.code === "EPERM") { t.skip("file symlink unavailable"); return; } throw e; }
  assert.throws(() => inspectNsis(f.nsis, f.source, f.unpacked, fakeSevenZip("NATIVE_BINARY_TEST")), /regular file/);
});
test("macOS: both DMG and ZIP contain identical approved native module", t => {
  const f = macFixture(t);
  const report = inspectMacRelease(f.dir, f.source, f.options);
  assert.equal(report.ok, true);
  assert.equal(report.addonSize, Buffer.byteLength("NATIVE_BINARY_TEST"));
});
test("macOS: DMG with a stale native module fails closed", t => {
  const f = macFixture(t);
  fs.writeFileSync(f.addon, "STALE");
  assert.throws(() => inspectMacDmg(f.dmg, f.source, f.options), /differs/);
});
test("macOS: updater ZIP with a missing native module fails closed", t => {
  const f = macFixture(t);
  fs.unlinkSync(f.addon);
  assert.throws(() => inspectMacZip(f.zip, f.source, f.options), /ENOENT/);
});
test("macOS: symlinked Contents ancestor cannot escape bundle", t => {
  const f = macFixture(t);
  const app = path.join(f.bundle, "Mcode.app");
  fs.rmSync(path.join(app, "Contents"), { recursive: true });
  fs.mkdirSync(path.join(f.dir, "outside"));
  fs.symlinkSync(path.join(f.dir, "outside"), path.join(app, "Contents"),
    process.platform === "win32" ? "junction" : "dir");
  const bytes = fs.readFileSync(f.source);
  const expected = {size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
  assert.throws(() => verifyMacApp(f.bundle, expected), /directory is missing or symlinked/);
});
test("macOS: multiple app bundles cannot hide a decoy", t => {
  const f = macFixture(t);
  fs.mkdirSync(path.join(f.bundle, "Decoy.app"));
  assert.throws(() => inspectMacDmg(f.dmg, f.source, f.options), /exactly one Mcode.app/);
});
test("macOS: missing either distributable fails closed", t => {
  const f = macFixture(t);
  fs.unlinkSync(f.zip);
  assert.throws(() => inspectMacRelease(f.dir, f.source, f.options), /exactly one Mcode DMG and one updater ZIP/);
});
