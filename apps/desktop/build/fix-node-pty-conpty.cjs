/**
 * Restore node-pty's conpty.dll + OpenConsole.exe after a native rebuild.
 *
 * WHY THIS EXISTS
 * `electron-builder install-app-deps` (our `rebuild:native` script) rebuilds
 * node-pty's native addon via `node-gyp rebuild` to match Electron's ABI. But
 * node-gyp ONLY compiles the `.node` files - it does NOT run npm's `postinstall`
 * lifecycle hook. node-pty's `postinstall` (scripts/post-install.js) is what
 * copies `conpty.dll` + `OpenConsole.exe` from `third_party/conpty/<ver>/win10-<arch>/`
 * into `build/Release/conpty/`. Without that copy, the rebuilt `conpty.node`
 * loads fine but fails at runtime:
 *
 *   "Cannot find conpty.dll at .../build/Release/conpty/conpty.dll"
 *
 * because conpty.cc hardcodes the lookup as `<dir-of-conpty.node>/conpty/conpty.dll`
 * (see src/win/conpty.cc: LoadConptyDll). The prebuilds fallback path can't
 * help here: loadNativeModule (utils.js) prefers `build/Release`, finds the
 * rebuilt conpty.node there, and that node looks for the dll next to itself.
 *
 * This script replicates the conpty-copy portion of post-install.js and runs it
 * against the installed node-pty, so the fix is robust across pnpm's symlink
 * layout (we resolve node-pty's real location rather than assuming a path).
 *
 * Run after `electron-builder install-app-deps`. No-op on non-Windows.
 */
//@ts-check

const fs = require("fs");
const os = require("os");
const path = require("path");

if (os.platform() !== "win32") {
  console.log("[fix-conpty] SKIPPED (not Windows)");
  process.exit(0);
}

// Resolve node-pty's real directory via its package.json. require.resolve walks
// the symlink/hoist layout, so this works under pnpm too.
let ptyPkgPath;
try {
  ptyPkgPath = require.resolve("node-pty/package.json");
} catch {
  console.warn("[fix-conpty] SKIPPED (node-pty not found)");
  process.exit(0);
}
const ptyRoot = path.dirname(ptyPkgPath);

const arch = process.env["npm_config_arch"] || os.arch();
const supported = ["x64", "arm64"];
if (!supported.includes(arch)) {
  console.warn(`[fix-conpty] SKIPPED (unsupported arch ${arch})`);
  process.exit(0);
}

const conptyThirdParty = path.join(ptyRoot, "third_party", "conpty");
if (!fs.existsSync(conptyThirdParty)) {
  console.warn(`[fix-conpty] SKIPPED (third_party/conpty not found at ${conptyThirdParty})`);
  process.exit(0);
}

// third_party/conpty/<version>/win10-<arch>/{conpty.dll,OpenConsole.exe}
// 版本目录要挑得**确定**:原来取 readdirSync()[0],顺序由文件系统说了算,只要
// 留着一个旧的/空的版本目录就可能指向一个空壳,然后一路 WARNING 退 0。排序后
// 只认真正含 win10-<arch> 的那个,取最新的一个。
const versionFolders = fs.readdirSync(conptyThirdParty).sort();
const versionFolder = versionFolders
  .filter((v) => fs.existsSync(path.join(conptyThirdParty, v, `win10-${arch}`)))
  .pop();
if (!versionFolder) {
  console.error(
    `[fix-conpty] FAILED: third_party/conpty 下没有任何版本目录含 win10-${arch}(找到:${versionFolders.join(", ") || "无"})`,
  );
  process.exit(1);
}
const sourceFolder = path.join(conptyThirdParty, versionFolder, `win10-${arch}`);
const destFolder = path.join(ptyRoot, "build", "Release", "conpty");

fs.mkdirSync(destFolder, { recursive: true });
let copied = 0;
let missing = 0;
for (const file of ["conpty.dll", "OpenConsole.exe"]) {
  const src = path.join(sourceFolder, file);
  const dst = path.join(destFolder, file);
  if (!fs.existsSync(src)) {
    // 这正是本脚本存在的理由。缺了它,打出来的包一开终端就是
    // "Cannot find conpty.dll" —— 必须让构建停在这里,而不是 WARNING 之后退 0。
    console.error(`[fix-conpty] FAILED: source missing ${src}`);
    missing++;
    continue;
  }
  // Only copy if missing or stale (avoids needless writes on re-runs).
  if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
    fs.copyFileSync(src, dst);
    console.log(`[fix-conpty] copied ${src} -> ${dst}`);
    copied++;
  }
}
if (missing > 0) {
  console.error("[fix-conpty] 打包中止:conpty 运行时文件缺失,打出来的包终端起不来。");
  process.exit(1);
}
if (copied === 0) {
  console.log(`[fix-conpty] already up to date in ${destFolder}`);
}
process.exit(0);
