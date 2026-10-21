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
// 拦截两种实际 import 写法。shim 自己的 node:fs/promises 必须走真正的 OS API，
// 不能再次被注入（简单 alias 两个名字会把 shim 递归 alias 到它自己）。
const faultShim = resolve(app, "scripts/maint-m07-smoke/fsFaultShim.ts");
const fsFaultPlugin = {
  name: "maint-m07-fs-fault",
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?fs\/promises$/ }, (args) => {
      if (args.importer && resolve(args.importer) === faultShim) return;
      return { path: faultShim };
    });
  },
};
(async () => {
try {
  const bundle = join(out, "smoke.mjs");
  const alias = {
    "@main/store/repositories.js": "./scripts/maint-m07-smoke/stubs.ts",
    "@main/lib/dataRoot.js": "./scripts/maint-m07-smoke/stubs.ts",
    "@main/lib/logger.js": "./scripts/maint-m07-smoke/stubs.ts",
    "electron": "./scripts/maint-m07-smoke/stubs.ts",
  };
  await esbuild.build({
    absWorkingDir: app,
    entryPoints: ["scripts/maint-m07-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias,
    plugins: [fsFaultPlugin],
  });
  // 【MC-097 跨进程】另打一份**独立子进程入口**,由 main.ts 用 `spawn(node, [$OUT/child-write.mjs,…])`
  // 各起一个真 OS 进程并发写同一路径,证明宿主级文件租约真的跨进程(进程内 Map 做不到)。
  const childBundle = join(out, "child-write.mjs");
  await esbuild.build({
    absWorkingDir: app,
    entryPoints: ["scripts/maint-m07-smoke/child-write.ts"],
    outfile: childBundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias,
    plugins: [fsFaultPlugin],
  });
  // 【MC-097 跨进程租约 / 真 SIGKILL】再打一份**独立子进程入口**,由 main.ts 起真 OS 进程
  // 直接去抢/持有同一把 `lib/osFileLease.ts` 的磁盘租约:① 父进程持锁时另一个真进程必须**被拒**;
  // ② 子进程抢到后**被真 SIGKILL**,断言锁文件仍在盘上、且陈旧回收让下一个写者照常写入。
  const leaseBundle = join(out, "child-lease.mjs");
  await esbuild.build({
    absWorkingDir: app,
    entryPoints: ["scripts/maint-m07-smoke/child-lease.ts"],
    outfile: leaseBundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias,
    plugins: [fsFaultPlugin],
  });
  const result = spawnSync(process.execPath, [bundle], {
    stdio: "inherit", timeout: 90000,
    env: { ...process.env, MCODE_M07_CHILD_ENTRY: childBundle, MCODE_M07_LEASE_ENTRY: leaseBundle },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
})().catch((err) => { console.error(err); process.exitCode = 1; });

