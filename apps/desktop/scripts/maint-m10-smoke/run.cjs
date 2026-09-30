// Cross-platform runner:用仓库已装的 Vite 自带 esbuild,绝不 npx / 联网。
// 需要本机有 git(本套件真的建仓库、真的 worktree add)。
const { createRequire } = require("node:module");
const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const appDir = resolve(__dirname, "../..");
const appRequire = createRequire(join(appDir, "package.json"));
const viteRequire = createRequire(appRequire.resolve("vite"));
const esbuild = viteRequire("esbuild");

const probe = spawnSync("git", ["--version"], { encoding: "utf-8" });
if (probe.status !== 0) {
  console.error("maint-m10-smoke: 本机没有可用的 git —— 明确失败,不跳过、不伪称通过");
  process.exitCode = 1;
  return;
}

// 临时根先取**规范路径**:`git worktree list --porcelain` 报的是长路径 / 解析过软链的
// 真路径,而 tmpdir() 可能是 8.3 短名(`C:\Users\RUNNER~1\...`,GitHub 的 Windows
// 机器就是)或软链(macOS 的 /var → /private/var)。两边对不上,已注册的工作树就被
// 当成"不是本仓库的"。产品的受管根在 userData 下,不走这条;这里只让夹具与 git 同口径。
const tmpRoot = realpathSync.native(tmpdir());
const out = mkdtempSync(join(tmpRoot, "mcode-maint-m10-smoke-"));
const wtRoot = mkdtempSync(join(tmpRoot, "mcode-maint-m10-wtroot-"));
const userData = mkdtempSync(join(tmpRoot, "mcode-maint-m10-userdata-"));
try {
  const bundle = join(out, "smoke.mjs");
  esbuild.buildSync({
    absWorkingDir: appDir,
    entryPoints: ["scripts/maint-m10-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "electron": "./scripts/maint-m10-smoke/stubs.ts",
      "@main/store/repositories.js": "./scripts/maint-m10-smoke/stubs.ts",
      "@main/claude/RuntimeManager.js": "./scripts/maint-m10-smoke/stubs.ts",
      "@main/lib/sessionSync.js": "./scripts/maint-m10-smoke/stubs.ts",
      "@main/lib/dataRoot.js": "./scripts/maint-m10-smoke/stubs.ts",
      "@main/lib/logger.js": "./scripts/maint-m10-smoke/stubs.ts",
    },
  });
  const logPath = join(appDir, ".tmp", "maint-m10-smoke.log");
  mkdirSync(join(appDir, ".tmp"), { recursive: true });
  const result = spawnSync(process.execPath, [bundle], {
    encoding: "utf-8", timeout: 120000,
    // TEMP/TMP(win32)与 TMPDIR(POSIX)一并指到规范根:main.ts 里的 tmpdir() 也建仓库。
    env: {
      ...process.env, TEMP: tmpRoot, TMP: tmpRoot, TMPDIR: tmpRoot,
      MCODE_M10_WT_ROOT: wtRoot, MCODE_M10_USERDATA: userData,
    },
  });
  // 自己落盘 —— PowerShell 的 `>` 重定向会把这个子进程的输出吞掉,日志路径写死
  // 在这里,报告和 CI 都能稳定拿到。
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(logPath, text, "utf-8");
  process.stdout.write(text);
  console.log(`maint-m10-smoke log: ${logPath}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
