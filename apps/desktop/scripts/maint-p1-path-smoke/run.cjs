const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const appRequire = createRequire(join(app, "package.json"));
const esbuild = createRequire(appRequire.resolve("vite"))("esbuild");
const out = mkdtempSync(join(tmpdir(), "mcode-p1-path-smoke-"));
try {
  const bundle = join(out, "smoke.mjs");
  esbuild.buildSync({
    absWorkingDir: app, entryPoints: ["scripts/maint-p1-path-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias: {
      "@main/store/repositories.js": "./scripts/maint-m07-smoke/stubs.ts",
      "@main/lib/dataRoot.js": "./scripts/maint-m07-smoke/stubs.ts",
      "@main/lib/logger.js": "./scripts/maint-m07-smoke/stubs.ts",
      "electron": "./scripts/maint-m07-smoke/stubs.ts",
    },
  });
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", timeout: 60000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
