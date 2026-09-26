// Bundle the real callers with only their dependencies stubbed. Never starts
// Electron or loads a real DB/data root. Uses installed Vite/esbuild, no npx.
const { createRequire } = require("node:module");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const app = resolve(__dirname, "../..");
const appRequire = createRequire(join(app, "package.json"));
const esbuild = createRequire(appRequire.resolve("vite"))("esbuild");
const stub = join(app, "scripts/db-persistence-smoke/stubs/callers.ts");
const alertModule = join(app, "src/main/store/persistenceAlerts.ts");
const out = mkdtempSync(join(tmpdir(), "mcode-persistence-callers-"));
async function main() {
  try {
    const bundle = join(out, "callers.cjs");
    await esbuild.build({
      absWorkingDir: app, entryPoints: ["scripts/db-persistence-smoke/callers.ts"],
      outfile: bundle, bundle: true, platform: "node", format: "cjs",
      tsconfig: "tsconfig.json", logLevel: "error",
      alias: Object.fromEntries([
        "electron", "@main/store/db.js", "@main/store/repositories.js", "@main/lib/logger.js",
        "@main/lib/dataRoot.js", "@main/library/paths.js", "@main/templates/store.js", "@main/onlyoffice/OnlyOfficeBridge.js",
      ].map((name) => [name, stub])),
      plugins: [{ name: "alert-relative-dependencies", setup(build) {
        build.onResolve({ filter: /^\.\/(db|repositories)\.js$/ }, (args) => {
          if (resolve(args.importer) === alertModule) return { path: stub };
        });
      } }],
    });
    const result = spawnSync(process.execPath, [bundle], { cwd: app, stdio: "inherit", timeout: 15000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
