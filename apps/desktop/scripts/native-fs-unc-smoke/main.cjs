"use strict";
/**
 * B-02/B-05: real SMB/UNC access against the already configured Windows
 * administrative share. No SMB configuration changes and no user files.
 * Set MCODE_TEST_UNC_ROOT to an EXISTING, writable UNC directory to exercise
 * an external share instead of localhost, and MCODE_TEST_REQUIRE_UNC=1 to
 * fail instead of skip when no usable share is present.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openRoot } = require("../../native/mcode-fs/build/Release/mcode_fs.node");

if (process.platform !== "win32") {
  console.log("SKIP native-fs-unc-smoke: Windows SMB client required");
  process.exit(0);
}

const base = path.resolve(__dirname, "../../.tmp");
fs.mkdirSync(base, { recursive: true });
const localParent = fs.mkdtempSync(path.join(base, "native-fs-unc-"));
const fallback = path.join("\\\\localhost\\" + path.parse(localParent).root[0].toUpperCase() + "$",
  localParent.slice(path.parse(localParent).root.length));
const external = process.env.MCODE_TEST_UNC_ROOT?.trim();
if (external && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(external)) {
  throw new Error("MCODE_TEST_UNC_ROOT must be a real \\\\server\\share UNC directory");
}
const uncParent = external || fallback;
const unavailable = new Set(["EACCES", "EPERM", "ENOENT", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENETDOWN", "EIO"]);
let target = uncParent, root, passed = 0, createdOnShare = false;
const ok = (message) => { ++passed; console.log("  ok " + message); };
const rejects = async (message, action) => {
  await assert.rejects(Promise.resolve().then(action));
  ok(message);
};
(async () => {
  try {
    try {
      if (!fs.statSync(uncParent).isDirectory()) throw new Error("UNC root is not a directory");
    } catch (e) {
      if (!external && !process.env.MCODE_TEST_REQUIRE_UNC && unavailable.has(e.code)) {
        console.log("SKIP native-fs-unc-smoke: no accessible Windows SMB share (" + e.code + ")");
        return;
      }
      throw e;
    }
    if (external) {
      target = path.win32.join(uncParent, "mcode-native-unc-" + process.pid + "-" + Date.now());
      fs.mkdirSync(target);
      createdOnShare = true;
    }
    root = openRoot(target);
    ok("openRoot pins an actual UNC / SMB directory");
    await root.writeFile(["created.txt"], Buffer.from("smb-data"), true);
    assert.equal(fs.readFileSync(path.join(target, "created.txt"), "utf8"), "smb-data");
    ok("handle-relative SMB write is visible over the share");
    fs.writeFileSync(path.join(target, "external.txt"), "smb-read");
    assert.equal((await root.readFile(["external.txt"], 32)).toString(), "smb-read");
    ok("handle-relative SMB read sees a real network file");
    assert.ok((await root.readdir([], 30)).some(x => x.name === "external.txt"));
    ok("SMB directory enumeration works");
    await root.rename(["created.txt"], ["renamed.txt"], false);
    assert.equal(fs.readFileSync(path.join(target, "renamed.txt"), "utf8"), "smb-data");
    await root.remove(["renamed.txt"]);
    assert.ok(!fs.existsSync(path.join(target, "renamed.txt")));
    ok("SMB rename and remove work");
    await rejects("UNC root rejects traversal components", () => root.readFile(["..", "external.txt"], 32));

    const outside = path.join(localParent, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
    const link = path.join(target, "outside-link");
    try {
      fs.symlinkSync(outside, link, "junction");
      await rejects("SMB reparse-point directory cannot escape the root",
        () => root.readFile(["outside-link", "secret.txt"], 128));
      assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "OUTSIDE-SECRET");
      ok("SMB reparse-point rejection preserves outside file");
    } catch (e) {
      if (!["EACCES", "EPERM", "ENOTSUP"].includes(e.code)) throw e;
      console.log("SKIP SMB reparse-point fixture creation unavailable: " + e.code);
    } finally {
      // Remove only the reparse entry, never recursively follow its target.
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.rmdirSync(link); } catch {}
    }
    const adapterRunner = path.resolve(__dirname, "../workspace-copy-boundary-smoke/run.cjs");
    const adapter = spawnSync(process.execPath, [adapterRunner], {
      encoding: "utf8",
      cwd: path.resolve(__dirname, "../.."),
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, MCODE_TEST_UNC_ROOT: target },
    });
    process.stdout.write(adapter.stdout || "");
    process.stderr.write(adapter.stderr || "");
    if (adapter.error) throw adapter.error;
    if (adapter.status !== 0) {
      throw new Error("Theia Workspace FS UNC adapter smoke failed with status " + adapter.status);
    }
    ok("Theia Workspace FS adapter passed real SMB/UNC read-write, search and authority checks");
    console.log("native-fs-unc-smoke: " + passed + "/" + passed + " PASS (real SMB + Theia Workspace FS)");
  } finally {
    root?.close();
    if (createdOnShare) fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(localParent, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
