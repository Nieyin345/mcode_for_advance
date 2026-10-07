// Cross-platform runner:用仓库已装的 Vite 自带 esbuild,绝不 npx / 联网。
// 需要本机有 git(本套件真的建仓库、真的 git add)。
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
  console.error("git-discard-smoke: 本机没有可用的 git —— 明确失败,不跳过、不伪称通过");
  process.exitCode = 1;
  return;
}

// 临时根取规范路径(理由同 maint-m10-smoke):git 报的是解析过软链/长名的真路径。
const tmpRoot = realpathSync.native(tmpdir());
const out = mkdtempSync(join(tmpRoot, "mcode-git-discard-smoke-"));
try {
  const bundle = join(out, "smoke.mjs");
  esbuild.buildSync({
    absWorkingDir: appDir,
    entryPoints: ["scripts/git-discard-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "electron": "./scripts/git-discard-smoke/stubs.ts",
      "@main/store/repositories.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/lib/dataRoot.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/lib/logger.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/lib/sessionSync.js": "./scripts/git-discard-smoke/stubs.ts",
      // ⚠️ `@main/lib/pathGuard.js` **不换桩** —— 围栏(`§5`)要验的正是它,
      //    换成桩就成了验桩。它只依赖上面两个已桩好的仓库 + dataRoot,跑得起来。
      "@main/lib/worktreeOps.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/lib/secretStore.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/providers/bridge/bridgeRegistry.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/providers/claude-sdk/customEnv.js": "./scripts/git-discard-smoke/stubs.ts",
      "@main/providers/claude-sdk/sdkBinaryPath.js": "./scripts/git-discard-smoke/stubs.ts",
    },
  });
  mkdirSync(join(appDir, ".tmp"), { recursive: true });
  const result = spawnSync(process.execPath, [bundle], {
    encoding: "utf-8", timeout: 120000,
    env: { ...process.env, TEMP: tmpRoot, TMP: tmpRoot, TMPDIR: tmpRoot },
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(appDir, ".tmp", "git-discard-smoke.log"), text, "utf-8");
  process.stdout.write(text);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
