/** Run the real permissionedProcessRunner probe against this checkout. No external network. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(desktop, "../..");
const pnpmStore = join(repo, "node_modules", ".pnpm");
const esbuild = readdirSync(pnpmStore).filter(name=>/^esbuild@\d/.test(name)).sort().reverse()
  .map(name=>join(pnpmStore,name,"node_modules","esbuild","bin","esbuild"))
  .find(existsSync);
if (!esbuild) throw Error("Missing local esbuild in " + pnpmStore);
const out = mkdtempSync(join(tmpdir(), "mcode-mc035-"));
try {
  const bundle = join(out, "probe.mjs");
  const build = spawnSync(process.execPath, [esbuild, "scripts/mc035-egress-probe/main.ts",
    "--bundle", "--platform=node", "--format=esm", "--tsconfig=tsconfig.json",
    "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    "--outfile=" + bundle, "--log-level=error"], {cwd:desktop, encoding:"utf8"});
  if (build.status !== 0) throw Error("esbuild failed: " + build.stderr);
  await import(pathToFileURL(bundle).href);
} finally { rmSync(out, {recursive:true, force:true}); }
