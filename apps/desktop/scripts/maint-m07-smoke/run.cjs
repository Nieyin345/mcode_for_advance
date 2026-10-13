// Cross-platform runner (与 path-guard-smoke 同款)。用仓库里已装的 Vite 自带
// esbuild,绝不走 npx / 联网下载。
const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const appRequire = createRequire(join(app, "package.json"));
const viteRequire = createRequire(appRequire.resolve("vite"));
const esbuild = viteRequire("esbuild");
const out = mkdtempSync(join(tmpdir(), "mcode-maint-m07-smoke-"));
try {
  const bundle = join(out, "smoke.mjs");
  const alias = {
    "@main/store/repositories.js": "./scripts/maint-m07-smoke/stubs.ts",
    "@main/lib/dataRoot.js": "./scripts/maint-m07-smoke/stubs.ts",
    "@main/lib/logger.js": "./scripts/maint-m07-smoke/stubs.ts",
    "electron": "./scripts/maint-m07-smoke/stubs.ts",
    // 【MC-097 E1】把 `node:fs/promises` 换成转发壳,让 `open`/`rename` 可按需注入失败
    // (模拟写临时文件 / rename 提交步崩溃)。未设开关时逐调用转发真实实现,生产代码一行未改。
    "node:fs/promises": "./scripts/maint-m07-smoke/fsFaultShim.ts",
  };
  esbuild.buildSync({
    absWorkingDir: app,
    entryPoints: ["scripts/maint-m07-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias,
  });
  // 【MC-097 跨进程】另打一份**独立子进程入口**,由 main.ts 用 `spawn(node, [$OUT/child-write.mjs,…])`
  // 各起一个真 OS 进程并发写同一路径,证明宿主级文件租约真的跨进程(进程内 Map 做不到)。
  const childBundle = join(out, "child-write.mjs");
  esbuild.buildSync({
    absWorkingDir: app,
    entryPoints: ["scripts/maint-m07-smoke/child-write.ts"],
    outfile: childBundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias,
  });
  const result = spawnSync(process.execPath, [bundle], {
    stdio: "inherit", timeout: 90000,
    env: { ...process.env, MCODE_M07_CHILD_ENTRY: childBundle },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}

