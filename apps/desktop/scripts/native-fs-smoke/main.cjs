"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const binary = process.env.MCODE_NATIVE_FS_PATH ||
  path.resolve(__dirname, "../../native/mcode-fs/build/Release/mcode_fs.node");
const { openRoot, napiVersion } = require(binary);
assert.ok(napiVersion >= 8, "addon must use the stable N-API 8 ABI");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-native-fs-"));
const workspace = path.join(temp, "workspace");
const outside = path.join(temp, "outside");
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_SECRET");
fs.writeFileSync(path.join(workspace, "root.txt"), "root-data");

let root;
let passed = 0;
const skipped = [];
function check(name, condition, detail) {
  assert.ok(condition, name + (detail === undefined ? "" : ": " + String(detail)));
  passed++;
  console.log("PASS " + name);
}
async function rejects(name, action, code) {
  await assert.rejects(action, (error) => {
    if (code && error.code !== code) return false;
    return true;
  }, name);
  passed++;
  console.log("PASS " + name);
}

(async () => {
  try {
    root = openRoot(workspace);
    check("N-API addon opens and pins the selected root", (await root.stat([])).type === "directory");
    check("pinned root handle retains directory-list access",
      (await root.readdir([], 10)).some((entry) => entry.name === "root.txt"));
    assert.throws(() => openRoot(workspace + "\0outside"), /NUL/i);
    passed++;
    console.log("PASS native root refuses NUL-truncated path aliases");

    if (process.platform !== "win32") {
      // macOS commonly exposes /var and /tmp as system-managed symlink aliases.
      // The chosen root may be an alias, but all subsequent child operations
      // must be handle-relative to its original target.
      const alias = path.join(temp, "trusted-root-alias");
      fs.symlinkSync(workspace, alias, "dir");
      const aliasedRoot = openRoot(alias);
      try {
        check("POSIX caller-selected root symlink resolves before handle pinning",
          (await aliasedRoot.readFile(["root.txt"], 64)).toString() === "root-data");
        fs.unlinkSync(alias);
        fs.symlinkSync(outside, alias, "dir");
        await rejects("retargeted root alias cannot redirect the opened POSIX handle",
          () => aliasedRoot.readFile(["secret.txt"], 64));
      } finally {
        aliasedRoot.close();
      }
    }

    await root.writeFile(["root-level.txt"], Buffer.from("root-level"));
    check("root-level file creation uses the pinned root handle",
      (await root.readFile(["root-level.txt"], 64)).toString() === "root-level");
    check("root directory enumeration sees entries created after the first listing",
      (await root.readdir([], 10)).some((entry) => entry.name === "root-level.txt"));
    check("repeated root directory enumeration restarts from the beginning",
      (await root.readdir([], 10)).some((entry) => entry.name === "root-level.txt"));
    await root.rename(["root-level.txt"], ["root-level-renamed.txt"], false);
    check("root-level rename uses the pinned root handle",
      (await root.readFile(["root-level-renamed.txt"], 64)).toString() === "root-level");
    await root.copy(["root-level-renamed.txt"], ["root-level-copy.txt"], false);
    check("root-level copy uses the pinned root handle",
      (await root.readFile(["root-level-copy.txt"], 64)).toString() === "root-level");
    await root.remove(["root-level-copy.txt"]);
    await root.remove(["root-level-renamed.txt"]);

    if (process.platform === "win32" && process.env.USERNAME) {
      const readOnlyWorkspace = path.join(temp, "readonly-workspace");
      const account = process.env.USERDOMAIN
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
      fs.mkdirSync(readOnlyWorkspace);
      const acl = spawnSync("icacls", [readOnlyWorkspace, "/deny", `${account}:(WD,AD)`], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!acl.error && acl.status === 0) {
        let readOnlyRoot;
        try {
          readOnlyRoot = openRoot(readOnlyWorkspace);
          check("read-only workspace root remains readable",
            (await readOnlyRoot.stat([])).type === "directory" &&
            (await readOnlyRoot.readdir([], 10)).length === 0);
          await rejects("read-only workspace rejects root-level file creation",
            () => readOnlyRoot.writeFile(["blocked.txt"], Buffer.from("blocked")), "EACCES");
        } finally {
          readOnlyRoot?.close();
          spawnSync("icacls", [readOnlyWorkspace, "/remove:d", account], { stdio: "ignore", windowsHide: true });
          fs.rmSync(readOnlyWorkspace, { recursive: true, force: true });
        }
      } else {
        skipped.push("read-only ACL control unavailable");
        fs.rmSync(readOnlyWorkspace, { recursive: true, force: true });
      }
    }

    for (let i = 0; i < 16; i++) {
      const closingRoot = openRoot(workspace);
      const pending = closingRoot.readdir([], 10).then(
        () => true,
        (error) => {
          if (error && error.code === "EBADF") return false;
          throw error;
        },
      );
      closingRoot.close();
      closingRoot.close();
      await pending;
    }
    check("close is idempotent and serialized with queued native operations", true);

    await root.mkdir(["nested"]);
    await root.mkdir(["nested", "child"]);
    await root.writeFile(["nested", "child", "alpha.txt"], Buffer.from("alpha"));
    check("mkdir and write create nested content", (await root.readFile(["nested", "child", "alpha.txt"], 64)).toString() === "alpha");
    check("stat returns a regular file", (await root.stat(["nested", "child", "alpha.txt"])).type === "file");
    await root.writeFile(["nested", "child", "empty.txt"], Buffer.alloc(0));
    check("zero-byte writes are supported", (await root.readFile(["nested", "child", "empty.txt"], 1)).length === 0);
    check("readdir returns entries from the pinned directory",
      (await root.readdir(["nested", "child"], 10)).some((entry) => entry.name === "alpha.txt" && entry.type === 1));

    await rejects("exclusive write refuses to overwrite an existing file",
      () => root.writeFile(["nested", "child", "alpha.txt"], Buffer.from("overwrite"), true));
    check("failed exclusive write preserves original bytes",
      (await root.readFile(["nested", "child", "alpha.txt"], 64)).toString() === "alpha");

    await root.writeFile(["nested", "child", "alpha.txt"], Buffer.from("updated"));
    check("ordinary write replaces bytes through the opened file handle",
      (await root.readFile(["nested", "child", "alpha.txt"], 64)).toString() === "updated");

    await root.copy(["nested", "child", "alpha.txt"], ["nested", "child", "copy.txt"], false);
    check("copy publishes a new file", (await root.readFile(["nested", "child", "copy.txt"], 64)).toString() === "updated");
    await rejects("copy without overwrite refuses an existing destination",
      () => root.copy(["nested", "child", "alpha.txt"], ["nested", "child", "copy.txt"], false));

    await rejects("rename without overwrite refuses an existing destination",
      () => root.rename(["nested", "child", "alpha.txt"], ["nested", "child", "copy.txt"], false));
    await root.rename(["nested", "child", "alpha.txt"], ["nested", "child", "renamed.txt"], false);
    check("rename moves the source entry", (await root.readFile(["nested", "child", "renamed.txt"], 64)).toString() === "updated");

    await root.mkdir(["directory-source"]);
    await root.mkdir(["directory-source", "subdir"]);
    await root.writeFile(["directory-source", "subdir", "entry.txt"], Buffer.from("directory-data"));
    await root.mkdir(["directory-destination"]);
    await rejects("directory rename without overwrite refuses an existing destination",
      () => root.rename(["directory-source"], ["directory-destination"], false));
    check("failed directory rename preserves the source tree",
      (await root.readFile(["directory-source", "subdir", "entry.txt"], 64)).toString() === "directory-data");
    await root.rename(["directory-source"], ["directory-moved"], false);
    check("directory rename moves the complete subtree through parent handles",
      (await root.readFile(["directory-moved", "subdir", "entry.txt"], 64)).toString() === "directory-data");
    await root.remove(["directory-moved", "subdir", "entry.txt"]);
    await root.remove(["directory-moved", "subdir"]);
    await root.remove(["directory-moved"]);
    await root.remove(["directory-destination"]);

    await root.writeFile(["overwrite-source.txt"], Buffer.from("new-content"), true);
    await root.writeFile(["overwrite-target.txt"], Buffer.from("old-content"), true);
    await root.rename(["overwrite-source.txt"], ["overwrite-target.txt"], true);
    check("file rename with overwrite replaces the destination atomically",
      (await root.readFile(["overwrite-target.txt"], 64)).toString() === "new-content");
    await rejects("overwritten rename source no longer exists",
      () => root.stat(["overwrite-source.txt"]));
    await root.remove(["overwrite-target.txt"]);

    await root.writeFile(["copy-overwrite-source.txt"], Buffer.from("copy-new"), true);
    await root.writeFile(["copy-overwrite-target.txt"], Buffer.from("copy-old"), true);
    await root.copy(["copy-overwrite-source.txt"], ["copy-overwrite-target.txt"], true);
    check("file copy with overwrite replaces the destination bytes",
      (await root.readFile(["copy-overwrite-target.txt"], 64)).toString() === "copy-new");
    await root.remove(["copy-overwrite-source.txt"]);
    await root.remove(["copy-overwrite-target.txt"]);

    await root.mkdir(["directory-overwrite-source"]);
    await root.mkdir(["directory-overwrite-source", "subdir"]);
    await root.writeFile(["directory-overwrite-source", "subdir", "entry.txt"], Buffer.from("replacement-tree"));
    await root.mkdir(["directory-overwrite-target"]);
    if (process.platform === "win32") {
      await rejects("Windows reports directory replacement as unsupported without deleting either tree",
        () => root.rename(["directory-overwrite-source"], ["directory-overwrite-target"], true), "ENOTSUP");
      check("failed Windows directory replacement preserves the source tree",
        (await root.readFile(["directory-overwrite-source", "subdir", "entry.txt"], 64)).toString() === "replacement-tree");
      check("failed Windows directory replacement preserves the empty destination",
        (await root.readdir(["directory-overwrite-target"], 10)).length === 0);
      await root.remove(["directory-overwrite-source", "subdir", "entry.txt"]);
      await root.remove(["directory-overwrite-source", "subdir"]);
      await root.remove(["directory-overwrite-source"]);
      await root.remove(["directory-overwrite-target"]);
    } else {
      await root.rename(["directory-overwrite-source"], ["directory-overwrite-target"], true);
      check("POSIX directory rename with overwrite replaces an empty destination directory",
        (await root.readFile(["directory-overwrite-target", "subdir", "entry.txt"], 64)).toString() === "replacement-tree");
      await root.remove(["directory-overwrite-target", "subdir", "entry.txt"]);
      await root.remove(["directory-overwrite-target", "subdir"]);
      await root.remove(["directory-overwrite-target"]);
    }

    await root.remove(["nested", "child", "copy.txt"]);
    await root.remove(["nested", "child", "empty.txt"]);
    await root.remove(["nested", "child", "renamed.txt"]);
    await root.remove(["nested", "child"]);
    check("remove deletes files and empty directories", (await root.readdir(["nested"], 10)).length === 0);

    await rejects("read limit rejects oversized file", () => root.readFile(["root.txt"], 2), "EFBIG");
    assert.throws(() => root.writeFile(["too-large.txt"], Buffer.alloc(8 * 1024 * 1024 + 1)),
      /8 MiB write limit/);
    passed++;
    console.log("PASS native write limit rejects oversized Buffer");
    await rejects("oversized native write leaves no target", () => root.stat(["too-large.txt"]));
    if (process.platform !== "win32") {
      const fifo = path.join(workspace, "blocking-fifo");
      const created = spawnSync("mkfifo", [fifo], { stdio: "ignore" });
      if (!created.error && created.status === 0) {
        await rejects("FIFO read is rejected without blocking a worker",
          () => root.readFile(["blocking-fifo"], 64));
        await rejects("FIFO write is rejected without blocking a worker",
          () => root.writeFile(["blocking-fifo"], Buffer.from("x")));
        await rejects("FIFO is not reported as an ordinary file",
          () => root.stat(["blocking-fifo"]));
        check("readdir omits POSIX special entries that cannot be reopened",
          !(await root.readdir([], 5000)).some((entry) => entry.name === "blocking-fifo"));
      } else {
        skipped.push("mkfifo utility unavailable");
      }
    }
    assert.throws(() => root.readFile(["..", "outside", "secret.txt"], 64), /invalid|path/i);
    passed++;
    console.log("PASS traversal components are rejected before OS lookup");
    assert.throws(() => root.stat(["nested/child"]), /invalid|path/i);
    passed++;
    console.log("PASS separator-containing components are rejected");
    for (const reserved of ["CON", "NUL", "COM1", "LPT9", "COM¹", "LPT³", "CONIN$", "CONOUT$"]) {
      assert.throws(() => root.stat([reserved]), /invalid|path/i);
    }
    passed++;
    console.log("PASS reserved Windows device names are rejected on every platform");
    if (process.platform !== "win32") {
      const nonPortableNames = ["CON", "bad?name", "bad*name", "bad<name", "bad|name"];
      for (const name of nonPortableNames) fs.writeFileSync(path.join(workspace, name), "non-portable");
      const visibleNames = new Set((await root.readdir([], 5000)).map((entry) => entry.name));
      check("readdir hides POSIX entries that violate the portable path contract",
        nonPortableNames.every((name) => !visibleNames.has(name)));
      const hiddenOverflowDir = path.join(workspace, "hidden-overflow");
      fs.mkdirSync(hiddenOverflowDir);
      const hiddenLinks = [];
      try {
        for (let i = 0; i < 11; i++) {
          const link = path.join(hiddenOverflowDir, `link-${i}`);
          fs.symlinkSync(outside, link, "dir");
          hiddenLinks.push(link);
        }
        await rejects("directory scan budget counts filtered symlink entries",
          () => root.readdir(["hidden-overflow"], 10), "EOVERFLOW");
      } finally {
        for (const link of hiddenLinks) fs.unlinkSync(link);
        fs.rmdirSync(hiddenOverflowDir);
      }
      const unicodeName = "正常-文件-🙂.txt";
      fs.writeFileSync(path.join(workspace, unicodeName), "valid-utf8");
      check("readdir preserves valid Unicode UTF-8 filenames",
        (await root.readdir([], 5000)).some((entry) => entry.name === unicodeName));
      fs.unlinkSync(path.join(workspace, unicodeName));
      const invalidUtf8Sequences = [
        [0xFF],                 // illegal leading byte
        [0xC0, 0xAF],           // overlong two-byte encoding
        [0xE0, 0x80, 0xAF],     // overlong three-byte encoding
        [0xED, 0xA0, 0x80],     // UTF-16 surrogate code point
        [0xF4, 0x90, 0x80, 0x80], // above U+10FFFF
        [0xE2, 0x82],           // truncated sequence
      ];
      const invalidUtf8Paths = invalidUtf8Sequences.map((bytes, index) => Buffer.concat([
        Buffer.from(workspace + path.sep + `invalid-${index}-`), Buffer.from(bytes),
      ]));
      try {
        for (const invalidPath of invalidUtf8Paths) fs.writeFileSync(invalidPath, "non-utf8");
        check("readdir hides POSIX filenames with malformed UTF-8 sequences",
          !(await root.readdir([], 5000)).some((entry) => entry.name.startsWith("invalid-")));
      } finally {
        for (const invalidPath of invalidUtf8Paths) {
          try { fs.unlinkSync(invalidPath); } catch { /* cleanup must not mask the assertion */ }
        }
      }
    }

    if (process.platform === "linux" && fs.existsSync("/dev/shm")) {
      let crossVolumeDir;
      try {
        crossVolumeDir = fs.mkdtempSync(path.join("/dev/shm", "mcode-native-fs-cross-"));
      } catch (error) {
        if (error && ["EACCES", "EPERM", "ENOENT"].includes(error.code)) {
          skipped.push("second writable Linux filesystem unavailable for EXDEV control");
        } else {
          throw error;
        }
      }
      if (crossVolumeDir) {
        const crossRoot = openRoot("/");
        const workspaceSegments = path.relative("/", workspace).split(path.sep).filter(Boolean);
        const crossVolumeSegments = path.relative("/", crossVolumeDir).split(path.sep).filter(Boolean);
        const sourceDirectory = [...workspaceSegments, "cross-volume-source"];
        const sourceFile = [...sourceDirectory, "child.txt"];
        try {
          const sourceInfo = await crossRoot.stat(workspaceSegments);
          const destinationInfo = await crossRoot.stat(crossVolumeSegments);
          if (sourceInfo.device !== destinationInfo.device) {
            await crossRoot.mkdir(sourceDirectory);
            await crossRoot.writeFile(sourceFile, Buffer.from("keep-source"), true);
            await rejects("cross-volume directory rename fails closed with EXDEV",
              () => crossRoot.rename(sourceDirectory, [...crossVolumeSegments, "moved-directory"], false), "EXDEV");
            check("failed cross-volume directory rename preserves the source subtree",
              (await crossRoot.readFile(sourceFile, 64)).toString() === "keep-source");
            await crossRoot.remove(sourceFile);
            await crossRoot.remove(sourceDirectory);
          } else {
            skipped.push("/tmp and /dev/shm share a filesystem; EXDEV control unavailable");
          }
        } finally {
          crossRoot.close();
          fs.rmSync(crossVolumeDir, { recursive: true, force: true });
        }
      }
    }

    const hardlink = path.join(workspace, "hardlink-secret.txt");
    try {
      fs.linkSync(path.join(outside, "secret.txt"), hardlink);
      await rejects("hard-linked outside file is not readable", () => root.readFile(["hardlink-secret.txt"], 128));
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "ENOTSUP" || error.code === "EACCES")) {
        skipped.push("hard-link creation unavailable");
      } else {
        throw error;
      }
    }

    const fileAlias = path.join(workspace, "outside-file-link");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), fileAlias, "file");
      await rejects("file symlink cannot be read", () => root.readFile(["outside-file-link"], 128));
      await rejects("file symlink cannot be written", () =>
        root.writeFile(["outside-file-link"], Buffer.from("PWNED")));
      await rejects("file symlink cannot be statted as a normal entry", () =>
        root.stat(["outside-file-link"]));
      await rejects("file symlink cannot be renamed into the workspace", () =>
        root.rename(["outside-file-link"], ["moved-file-link"], false));
      await rejects("file symlink cannot be removed as an ordinary file", () =>
        root.remove(["outside-file-link"]));
      check("file symlink operations leave the outside target unchanged",
        fs.readFileSync(path.join(outside, "secret.txt"), "utf8") === "OUTSIDE_SECRET");
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        skipped.push("file symlink creation unavailable");
      } else {
        throw error;
      }
    }

    const junction = path.join(workspace, "outside-junction");
    try {
      fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
      await rejects("directory symlink/junction cannot be traversed",
        () => root.readFile(["outside-junction", "secret.txt"], 128));
      await rejects("directory symlink/junction cannot be enumerated",
        () => root.readdir(["outside-junction"], 10));
      await rejects("directory symlink/junction cannot be renamed into the workspace",
        () => root.rename(["outside-junction"], ["moved-junction"], false));
      await rejects("directory symlink/junction cannot be removed as an ordinary directory",
        () => root.remove(["outside-junction"]));
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        skipped.push("directory symlink/junction creation unavailable");
      } else {
        throw error;
      }
    }

    const internalAlias = path.join(workspace, "internal-alias");
    try {
      fs.symlinkSync(path.join(workspace, "nested"), internalAlias,
        process.platform === "win32" ? "junction" : "dir");
      await rejects("internal symlink/junction is rejected as well",
        () => root.readdir(["internal-alias"], 10));
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        skipped.push("internal directory alias creation unavailable");
      } else {
        throw error;
      }
    }

    // Moving the selected root after opening it must not redirect future reads
    // to a replacement path at the old name.
    const moved = path.join(temp, "workspace-original");
    fs.renameSync(workspace, moved);
    let replacementCreated = false;
    try {
      fs.symlinkSync(outside, workspace, process.platform === "win32" ? "junction" : "dir");
      replacementCreated = true;
    } catch (error) {
      if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) throw error;
    }
    check("root handle remains pinned after its original pathname is moved",
      (await root.readFile(["root.txt"], 64)).toString() === "root-data");
    check("root enumeration remains pinned after its original pathname is moved",
      (await root.readdir([], 5000)).some((entry) => entry.name === "root.txt"));
    if (replacementCreated) {
      await rejects("replacement root alias cannot redirect the pinned root",
        () => root.readFile(["secret.txt"], 128));
    }

    root.close();
    await rejects("closed root rejects later operations", () => root.stat([]), "EBADF");

    console.log("native-fs-smoke: " + passed + "/" + passed + " PASS");
    if (skipped.length) console.log("SKIP: " + skipped.join("; "));
  } finally {
    if (root) root.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
