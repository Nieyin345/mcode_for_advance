// 用仓库自带 esbuild 打包(async build + 插件,因为要把 node:child_process 换成替身)。
// 不 npx、不联网、不起任何真实进程。
const { createRequire } = require("node:module");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const appDir = resolve(__dirname, "../..");
const appRequire = createRequire(join(appDir, "package.json"));
const viteRequire = createRequire(appRequire.resolve("vite"));
const esbuild = viteRequire("esbuild");

const out = mkdtempSync(join(tmpdir(), "mcode-maint-m21-smoke-"));
const fakeTemp = mkdtempSync(join(tmpdir(), "mcode-maint-m21-temp-"));
const fakePF = mkdtempSync(join(tmpdir(), "mcode-maint-m21-pf-"));
const userData = mkdtempSync(join(tmpdir(), "mcode-maint-m21-userdata-"));

const childStub = join(appDir, "scripts/maint-m21-smoke/childStub.ts");

(async () => {
  try {
    const bundle = join(out, "smoke.mjs");
    await esbuild.build({
      absWorkingDir: appDir,
      entryPoints: ["scripts/maint-m21-smoke/main.ts"],
      outfile: bundle, bundle: true, platform: "node", format: "esm",
      tsconfig: "tsconfig.json", logLevel: "error",
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      alias: {
        "electron": "./scripts/maint-m21-smoke/stubs.ts",
        "@main/store/repositories.js": "./scripts/maint-m21-smoke/stubs.ts",
        "@main/lib/logger.js": "./scripts/maint-m21-smoke/stubs.ts",
        "@main/lib/dataRoot.js": "./scripts/maint-m21-smoke/stubs.ts",
      },
      plugins: [{
        name: "stub-child-process",
        setup(build) {
          build.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: childStub }));
        },
      }],
    });
    const result = spawnSync(process.execPath, [bundle], {
      encoding: "utf-8", timeout: 120000,
      env: {
        ...process.env,
        MCODE_M21_TEMP: fakeTemp,
        MCODE_M21_USERDATA: userData,
        MCODE_M21_PROGRAMFILES: fakePF,
      },
    });
    if (result.error) throw result.error;
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    mkdirSync(join(appDir, ".tmp"), { recursive: true });
    const logPath = join(appDir, ".tmp", "maint-m21-smoke.log");
    writeFileSync(logPath, text, "utf-8");
    process.stdout.write(text);
    console.log(`maint-m21-smoke log: ${logPath}`);
    process.exitCode = result.status ?? 1;
  } finally {
    for (const d of [out, fakeTemp, fakePF, userData]) rmSync(d, { recursive: true, force: true });
  }
})();
