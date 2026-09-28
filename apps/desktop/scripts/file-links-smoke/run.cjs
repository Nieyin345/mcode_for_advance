// Real production imports, with IPC/store only stubbed; no downloads or user data.
// --baseline=<git-ref> reads old helper blobs without changing the working tree.
const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const appRequire = createRequire(join(app, "package.json"));
const esbuild = createRequire(appRequire.resolve("vite"))("esbuild");
const baselineArg = process.argv[2];
if (baselineArg && !/^--baseline=[a-zA-Z0-9._/-]+$/.test(baselineArg)) throw new Error("Invalid baseline argument");
const baseline = baselineArg?.slice("--baseline=".length);
const helpers = ["src/renderer/lib/path.ts", "src/renderer/lib/fileLink.ts"];
const out = mkdtempSync(join(tmpdir(), "mcode-file-links-smoke-"));
(async () => {
  try {
    const bundle = join(out, "smoke.mjs");
    const result = await esbuild.build({
      absWorkingDir: app, entryPoints: ["scripts/file-links-smoke/main.ts"],
      outfile: bundle, bundle: true, platform: "node", format: "esm",
      tsconfig: "tsconfig.json", logLevel: "error", metafile: true,
      alias: {
        "@renderer/lib/api.js": "./scripts/file-links-smoke/stubs.ts",
        "@renderer/stores/sessionStore.js": "./scripts/file-links-smoke/stubs.ts",
      },
      plugins: baseline ? [{ name: "baseline-helpers", setup(build) {
        build.onLoad({ filter: /[\\/]renderer[\\/]lib[\\/](path|fileLink)\.ts$/ }, args => {
          const helper = helpers.find(p => resolve(app, p) === args.path);
          if (!helper) throw new Error("Unexpected baseline helper");
          return { contents: execFileSync("git", ["show", `${baseline}:apps/desktop/${helper}`], { cwd: app, encoding: "utf8" }), loader: "ts" };
        });
      } }] : [],
    });
    for (const helper of helpers) {
      if (!Object.keys(result.metafile.inputs).some(p => p.replaceAll("\\", "/").endsWith(helper))) throw new Error(`Production helper not covered: ${helper}`);
    }
    console.log(`Helper coverage verified (${baseline ? `baseline ${baseline}` : "working tree"})`);
    const child = spawnSync(process.execPath, [bundle], { stdio: "inherit", timeout: 30000 });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally { rmSync(out, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
