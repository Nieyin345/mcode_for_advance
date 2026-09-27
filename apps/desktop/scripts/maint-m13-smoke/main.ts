/**
 * MAINT-2026-09 / M13 — plugin install-slot containment.
 *
 * BUG-M13-01: the manifest `version` becomes a directory segment
 *   (plugins/<name>/<version>). "." or ".." (and all-dot forms that Windows
 *   collapses) must not resolve to the plugin's own base dir or PLUGINS_ROOT;
 *   otherwise the swap/prune steps delete the payload or every installed
 *   plugin and marketplace.
 * BUG-M13-02: "marketplaces" is the housekeeping directory for marketplace
 *   clones. A plugin (or remove/enable request) with that name, in any letter
 *   case, must not operate on it.
 *
 * Only a scratch HOME is touched; the script aborts before any write if
 * PLUGINS_ROOT is not inside it.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  PLUGINS_ROOT,
  addMarketplace,
  installFromLocal,
  listPlugins,
  removeMarketplace,
  removePlugin,
  setPluginEnabled,
} from "../../src/main/plugins/pluginManager.js";

const home = process.env.MAINT_M13_HOME ?? "";
const rel = home ? path.relative(path.resolve(home), path.resolve(PLUGINS_ROOT)) : "..";
if (!home || rel.startsWith("..") || path.isAbsolute(rel)) {
  console.error(`REFUSING TO RUN: PLUGINS_ROOT ${PLUGINS_ROOT} is not inside scratch home ${home}`);
  process.exit(2);
}

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const fixtures = path.join(home, "fixtures");

function writePlugin(dirName: string, name: string, version: string | undefined): string {
  const dir = path.join(fixtures, dirName);
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, ...(version !== undefined ? { version } : {}), description: "fixture" }),
  );
  writeFileSync(path.join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
  return dir;
}

function writeMarketplace(): string {
  const dir = path.join(fixtures, "mp-src");
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "m13-market", plugins: [{ name: "keeper", source: "./keeper" }] }),
  );
  return dir;
}

/** Fresh plugins root with one healthy plugin and one marketplace clone. */
async function seed(): Promise<void> {
  // The settings stub outlives the directory: drop the previous record first.
  removeMarketplace("m13-market");
  rmSync(PLUGINS_ROOT, { recursive: true, force: true });
  const keeper = writePlugin("keeper-src", "keeper", "1.0.0");
  const installed = await installFromLocal(keeper);
  if (!installed.ok) throw new Error(`seed install failed: ${installed.error}`);
  const market = await addMarketplace({ kind: "local", ref: writeMarketplace() });
  if (!market.ok) {
    throw new Error(`seed marketplace failed: ${market.error}`);
  }
  if (!existsSync(path.join(PLUGINS_ROOT, "marketplaces", "m13-market"))) {
    throw new Error("seed marketplace clone missing");
  }
}

function keeperIntact(): boolean {
  const keeper = listPlugins().find((p) => p.name === "keeper");
  return !!keeper && existsSync(path.join(keeper.rootDir, ".claude-plugin", "plugin.json"));
}
function marketCloneIntact(): boolean {
  return existsSync(path.join(PLUGINS_ROOT, "marketplaces", "m13-market", ".claude-plugin", "marketplace.json"));
}
function inside(parent: string, child: string): boolean {
  const r = path.relative(path.resolve(parent), path.resolve(child));
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
}

async function main(): Promise<void> {
  // ── BUG-M13-01: version "." must not replace the plugin's base directory.
  await seed();
  const dot = await installFromLocal(writePlugin("dot-src", "dotver", "."));
  const dotState = listPlugins().find((p) => p.name === "dotver");
  ok(
    dot.ok && !!dotState && existsSync(path.join(dotState.rootDir, ".claude-plugin", "plugin.json")),
    'version "." installs a readable payload',
    JSON.stringify({ ok: dot.ok, error: dot.error, root: dotState?.rootDir }),
  );
  ok(
    !!dotState && inside(path.join(PLUGINS_ROOT, "dotver"), dotState.rootDir),
    'version "." lands in its own versioned slot',
    dotState?.rootDir ?? "not listed",
  );

  // ── BUG-M13-01: version ".." must not replace PLUGINS_ROOT.
  await seed();
  const up = await installFromLocal(writePlugin("up-src", "upver", ".."));
  ok(keeperIntact(), 'installing version ".." keeps other installed plugins', JSON.stringify(up));
  ok(marketCloneIntact(), 'installing version ".." keeps marketplace clones', JSON.stringify(up));
  const upState = listPlugins().find((p) => p.name === "upver");
  ok(
    !upState || inside(path.join(PLUGINS_ROOT, "upver"), upState.rootDir),
    'version ".." never resolves outside plugins/<name>/',
    upState?.rootDir ?? "",
  );

  // Windows collapses trailing dots, so "..." would equal plugins/<name>.
  await seed();
  const many = await installFromLocal(writePlugin("many-src", "manyver", "..."));
  const manyState = listPlugins().find((p) => p.name === "manyver");
  ok(
    many.ok && !!manyState && inside(path.join(PLUGINS_ROOT, "manyver"), manyState.rootDir) &&
      path.basename(manyState.rootDir).replace(/\.+$/, "") !== "",
    'all-dot version "..." gets a non-empty slot name on every platform',
    JSON.stringify({ many, root: manyState?.rootDir }),
  );

  // Windows drops trailing dots from directory names: "2.0." would be created
  // as "2.0" and then pruned as "another version" right after install.
  await seed();
  const trail = await installFromLocal(writePlugin("trail-src", "trailver", "2.0."));
  const trailState = listPlugins().find((p) => p.name === "trailver");
  ok(
    trail.ok && !!trailState && existsSync(path.join(trailState.rootDir, ".claude-plugin", "plugin.json")),
    'trailing-dot version "2.0." keeps its payload',
    JSON.stringify({ ok: trail.ok, error: trail.error, root: trailState?.rootDir }),
  );

  // Normal version keeps its exact slot (compatibility).
  const normal = listPlugins().find((p) => p.name === "keeper");
  ok(!!normal && path.basename(normal.rootDir) === "1.0.0" && normal.version === "1.0.0", "ordinary version slot unchanged");

  // ── BUG-M13-02: reserved housekeeping name.
  for (const reserved of ["marketplaces", "Marketplaces"]) {
    await seed();
    const res = await installFromLocal(writePlugin(`res-${reserved}`, reserved, "1.0.0"));
    ok(!res.ok, `installing a plugin named "${reserved}" is refused`, JSON.stringify(res));
    ok(marketCloneIntact(), `installing "${reserved}" keeps marketplace clones`);
  }
  await seed();
  const en = setPluginEnabled("marketplaces", true);
  ok(!en.ok, 'setPluginEnabled("marketplaces") is refused while clones exist', JSON.stringify(en));
  const rm = removePlugin("marketplaces");
  ok(!rm.ok, 'removePlugin("marketplaces") is refused', JSON.stringify(rm));
  ok(marketCloneIntact(), 'removePlugin("marketplaces") keeps marketplace clones');

  // Ordinary remove still works.
  const rmKeeper = removePlugin("keeper");
  ok(rmKeeper.ok && !existsSync(path.join(PLUGINS_ROOT, "keeper")), "ordinary remove still deletes the plugin");
  ok(marketCloneIntact(), "ordinary remove leaves marketplaces alone");

  console.log(`\nM13 SUMMARY ${JSON.stringify({ passed, failed })}`);
  if (readdirSync(home).length === 0) console.log("(scratch home empty)");
}

main()
  .catch((err) => {
    failed++;
    console.error("HARNESS ERROR", err);
  })
  .finally(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
