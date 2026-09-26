// Cross-platform runner. Uses installed Vite's esbuild, never npx/downloads.
const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const appRequire = createRequire(join(app, "package.json"));
const viteRequire = createRequire(appRequire.resolve("vite"));
const esbuild = viteRequire("esbuild");
const out = mkdtempSync(join(tmpdir(), "mcode-path-guard-smoke-"));
try {
  const bundle = join(out, "smoke.mjs");
  esbuild.buildSync({
    absWorkingDir: app,
    entryPoints: ["scripts/path-guard-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    tsconfig: "tsconfig.json", logLevel: "error",
    alias: {
      "@main/store/repositories.js": "./scripts/path-guard-smoke/stubs.ts",
      "@main/lib/dataRoot.js": "./scripts/path-guard-smoke/stubs.ts",
    },
  });
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", timeout: 30000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
