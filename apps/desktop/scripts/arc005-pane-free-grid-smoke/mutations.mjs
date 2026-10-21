/** T23: in-memory fault injection; never edits product files. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildPackage = readdirSync(pnpm).filter(name => name.startsWith("esbuild@")).sort().at(-1);
assert.ok(esbuildPackage, "esbuild not installed");
const { build } = await import(pathToFileURL(join(pnpm, esbuildPackage, "node_modules/esbuild/lib/main.js")).href);
const sourcePath = resolve(desktop, "src/renderer/components/layout/paneLayout.ts");
const source = readFileSync(sourcePath, "utf8");
const outParent = resolve(desktop, ".tmp");
mkdirSync(outParent, { recursive: true });
const out = mkdtempSync(join(outParent, "t23-mutants-"));
try {
  const mutants = [
    {
      name: "collapse threshold removed",
      source: source.replace("if (raw < SPLIT_COLLAPSE_THRESHOLD)", "if (false && raw < SPLIT_COLLAPSE_THRESHOLD)")
        .replace("if (raw > 1 - SPLIT_COLLAPSE_THRESHOLD)", "if (false && raw > 1 - SPLIT_COLLAPSE_THRESHOLD)"),
      expected: "FAIL T23 fold thresholds",
    },
    {
      name: "pixel minima removed",
      source: source.replace(/const minRatio = containerWidth >=[\s\S]*?: 0\.82;/,
        "const minRatio = 0.18;\n  const maxRatio = 0.82;"),
      expected: "FAIL T23 pixel min",
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant.source, source, "mutation target not found: " + mutant.name);
    const bundlePath = join(out, "mutant-" + index + ".mjs");
    await build({
      entryPoints: [resolve(desktop, "scripts/arc005-pane-free-grid-smoke/main.ts")],
      bundle: true, platform: "node", format: "esm",
      tsconfig: resolve(desktop, "tsconfig.json"),
      outfile: bundlePath, logLevel: "silent",
      plugins: [{
        name: "t23-memory-mutation",
        setup(ctx) {
          ctx.onLoad({ filter: /[\\/]paneLayout\.ts$/ }, args =>
            resolve(args.path) === sourcePath
              ? { contents: mutant.source, loader: "ts", resolveDir: dirname(sourcePath) }
              : undefined);
        },
      }],
    });
    const run = spawnSync(process.execPath, [bundlePath], { cwd: desktop, encoding: "utf8", timeout: 30000 });
    const output = (run.stdout ?? "") + (run.stderr ?? "");
    assert.notEqual(run.status, 0, mutant.name + " unexpectedly green");
    assert.ok(output.includes(mutant.expected), mutant.name + " red test missing; output: " + output.slice(-3000));
    console.log("PASS mutation-red:", mutant.name, "=>", mutant.expected);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
