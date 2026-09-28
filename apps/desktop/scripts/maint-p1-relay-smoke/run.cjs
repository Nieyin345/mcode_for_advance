const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const requireApp = createRequire(join(app, "package.json"));
const esbuild = createRequire(requireApp.resolve("vite"))("esbuild");
const out = mkdtempSync(join(tmpdir(), "mcode-p1-relay-"));
try {
  const bundle = join(out, "smoke.mjs");
  esbuild.buildSync({ absWorkingDir: app, entryPoints: ["scripts/maint-p1-relay-smoke/main.ts"],
    outfile: bundle, bundle: true, platform: "node", format: "esm", tsconfig: "tsconfig.json", logLevel: "error" });
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", timeout: 60000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
