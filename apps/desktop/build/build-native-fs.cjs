/**
 * Build the N-API filesystem addon against the Electron headers used by this
 * workspace. N-API 8 keeps the binary on Node's stable addon ABI.
 */
"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");

const appDir = path.resolve(__dirname, "..");
const nativeDir = path.join(appDir, "native", "mcode-fs");
const appRequire = createRequire(path.join(appDir, "package.json"));
const electronVersion = appRequire("electron/package.json").version;
const nodeGypCli = appRequire.resolve("node-gyp/bin/node-gyp.js");
const arch = process.env.MCODE_ARCH || process.arch;
const supported = ["x64", "arm64"];
if (!supported.includes(arch)) {
  console.error("[native-fs] unsupported target architecture: " + arch);
  process.exit(1);
}

const output = path.join(nativeDir, "build", "Release", "mcode_fs.node");
const metadata = path.join(nativeDir, "build", "native-fs-build.json");
const sourceFiles = [
  path.join(nativeDir, "binding.gyp"),
  path.join(nativeDir, "src", "addon.cc"),
  path.join(nativeDir, "src", "native_fs.h"),
  path.join(nativeDir, "src", "fs_posix.cc"),
  path.join(nativeDir, "src", "fs_win32.cc"),
];
const expected = { platform: process.platform, arch, electronVersion, napiVersion: 8 };
if (!process.env.MCODE_FORCE_NATIVE_FS && fs.existsSync(output) && fs.existsSync(metadata)) {
  try {
    const previous = JSON.parse(fs.readFileSync(metadata, "utf8"));
    const outputTime = fs.statSync(output).mtimeMs;
    const sourcesFresh = sourceFiles.every((file) => fs.statSync(file).mtimeMs <= outputTime);
    if (JSON.stringify(previous) === JSON.stringify(expected) && sourcesFresh) {
      console.log("[native-fs] binary is current: " + output);
      process.exit(0);
    }
  } catch {
    // A missing/stale metadata record triggers a normal rebuild.
  }
}

const args = [
  "rebuild",
  "--target=" + electronVersion,
  "--dist-url=https://electronjs.org/headers",
  "--arch=" + arch,
  "--napi_build_version=8",
];

function runNodeGyp() {
  const env = { ...process.env, npm_config_arch: arch };
  if (process.platform !== "win32" || env.VCINSTALLDIR) {
    return spawnSync(process.execPath, [nodeGypCli, ...args], {
      cwd: nativeDir, stdio: "inherit", env,
    });
  }

  // VS 2022 installs under either Program Files root depending on the
  // installer channel and machine image. Search both, plus Enterprise.
  const installRoots = [...new Set([
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean))];
  const editions = ["BuildTools", "Community", "Professional", "Enterprise"];
  const candidates = installRoots.flatMap((root) => editions.map((edition) =>
    path.join(root, "Microsoft Visual Studio", "2022", edition, "Common7", "Tools", "VsDevCmd.bat"),
  ));
  const devCmd = candidates.find((candidate) => fs.existsSync(candidate));
  if (!devCmd) {
    return spawnSync(process.execPath, [nodeGypCli, ...args], {
      cwd: nativeDir, stdio: "inherit", env,
    });
  }
  const quote = (value) => '"' + String(value) + '"';
  const command = 'call ' + quote(devCmd) + ' -arch=' + arch +
    ' && ' + quote(process.execPath) + ' ' + quote(nodeGypCli) + ' ' +
    args.map(quote).join(" ");
  return spawnSync(env.ComSpec || "cmd.exe", ["/d", "/c", command], {
    cwd: nativeDir, stdio: "inherit", env, windowsVerbatimArguments: true,
  });
}

console.log("[native-fs] building Electron " + electronVersion + " / " + process.platform + "-" + arch);
const result = runNodeGyp();
if (result.error) {
  console.error("[native-fs] compiler launch failed: " + result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
if (!fs.existsSync(output) || !fs.lstatSync(output).isFile()) {
  console.error("[native-fs] node-gyp exited successfully but did not produce the addon: " + output);
  process.exit(1);
}
fs.mkdirSync(path.dirname(metadata), { recursive: true });
fs.writeFileSync(metadata, JSON.stringify(expected, null, 2) + "\n", "utf8");
