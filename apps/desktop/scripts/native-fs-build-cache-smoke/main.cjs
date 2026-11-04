"use strict";
/**
 * Native addon build-cache regression: never reuse an addon solely because
 * timestamps look fresh. All builds run in a disposable, synthetic project.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sourceBuilder = path.resolve(__dirname, "../../build/build-native-fs.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-native-fs-cache-"));
const app = path.join(root, "desktop");
const nativeDir = path.join(app, "native", "mcode-fs");
const releaseDir = path.join(nativeDir, "build", "Release");
const addon = path.join(releaseDir, "mcode_fs.node");
const countFile = path.join(nativeDir, "build", "build-count.txt");
const runner = path.join(app, "build", "build-native-fs.cjs");

function write(relative, content) {
  const target = path.join(app, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function runs() {
  try { return Number(fs.readFileSync(countFile, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
function build() {
  const result = spawnSync(process.execPath, [runner], {
    cwd: app,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, VCINSTALLDIR: "synthetic-test", MCODE_FORCE_NATIVE_FS: "" },
  });
  assert.equal(result.status, 0,
    "isolated native build failed: " + String(result.error?.message || result.stdout + result.stderr));
}

try {
  write("build/build-native-fs.cjs", fs.readFileSync(sourceBuilder));
  write("package.json", '{"name":"cache-smoke-fixture","version":"1.0.0"}');
  write("node_modules/electron/package.json",
    '{"name":"electron","version":"44.4.5"}');
  write("node_modules/node-gyp/package.json",
    '{"name":"node-gyp","version":"1.0.0"}');
  write("node_modules/node-gyp/bin/node-gyp.js", [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const base = process.cwd();',
    'const release = path.join(base, "build", "Release");',
    'const counter = path.join(base, "build", "build-count.txt");',
    'fs.mkdirSync(release, {recursive:true});',
    'const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;',
    'fs.writeFileSync(path.join(release, "mcode_fs.node"), "synthetic-binary-" + n);',
    'fs.writeFileSync(counter, String(n));',
  ].join("\n"));
  for (const name of ["binding.gyp", "src/addon.cc", "src/native_fs.h",
                      "src/fs_posix.cc", "src/fs_win32.cc"]) {
    write("native/mcode-fs/" + name, "initial " + name);
  }

  build();
  assert.equal(runs(), 1, "first build must compile the addon");
  build();
  assert.equal(runs(), 1, "unchanged sources and binary must hit the cache");
  console.log("  ok unchanged source and addon reuse the build cache");

  const source = path.join(nativeDir, "src", "addon.cc");
  const sourceTime = fs.statSync(source).mtime;
  fs.appendFileSync(source, "\nchanged even though mtime was restored");
  fs.utimesSync(source, sourceTime, sourceTime);
  build();
  assert.equal(runs(), 2, "source byte changes with old mtime must rebuild");
  console.log("  ok backdated source changes invalidate the build cache");

  const addonTime = fs.statSync(addon).mtime;
  const addonSize = fs.statSync(addon).size;
  fs.writeFileSync(addon, "X".repeat(addonSize));
  fs.utimesSync(addon, addonTime, addonTime);
  build();
  assert.equal(runs(), 3, "corrupt binary of same size/mtime must rebuild");
  console.log("  ok modified native binary invalidates the build cache");

  build();
  assert.equal(runs(), 3, "fresh reconstructed addon should be reused");
  console.log("  ok validated native artifact is cached");
  console.log("native-fs-build-cache-smoke: 4/4 PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
