/**
 * MAINT-2026-09 / M18 — managed-runtime install slot containment.
 *
 * BUG-M18-01: installRuntimeFromLocalPath takes the version from the picked
 * directory's (or .tgz's) package.json and finalizeInstall then runs
 * rmSync(join(root, agent, version), { recursive: true }) before renaming the
 * staging dir there. A version such as "..", "../pi" or "../../.." must not
 * resolve anywhere except <root>/<agent>/<one segment>.
 *
 * Layout (everything under the MAINT_M18_BOX scratch dir):
 *   box/keep.txt                     sentinel outside the app data dir
 *   box/userData/keep.txt            sentinel for "other app data"
 *   box/userData/runtimes/           managed runtime root
 *   box/userData/runtimes/pi/0.1.0/  another agent's installed runtime
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { setManagedRuntimeRoot, getManagedRuntimeRoot } from "../../src/main/runtimes/managedRuntimeRoots.js";
import { installRuntimeFromLocalPath, installedVersionOf } from "../../src/main/runtimes/runtimeInstaller.js";

const box = process.env.MAINT_M18_BOX ?? "";
if (!box || !existsSync(box)) {
  console.error("REFUSING TO RUN: MAINT_M18_BOX is not set to an existing scratch directory");
  process.exit(2);
}
const userData = path.join(box, "userData");
const root = path.join(userData, "runtimes");
setManagedRuntimeRoot(root);
if (getManagedRuntimeRoot() !== root) {
  console.error(`REFUSING TO RUN: managed runtime root is ${getManagedRuntimeRoot()}, expected ${root}`);
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

const sources = path.join(box, "sources");

function seed(): void {
  mkdirSync(box, { recursive: true });
  writeFileSync(path.join(box, "keep.txt"), "outside");
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, "keep.txt"), "app data");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "pi", "0.1.0"), { recursive: true });
  writeFileSync(path.join(root, "pi", "0.1.0", "marker.txt"), "pi payload");
  mkdirSync(path.join(root, "claude", "1.0.0"), { recursive: true });
  writeFileSync(path.join(root, "claude", "1.0.0", "claude.exe"), "MZ old claude\n");
}

function claudeSource(dirName: string, version: string): string {
  const dir = path.join(sources, dirName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "claude.exe"), "MZ picked claude\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

const piIntact = () => existsSync(path.join(root, "pi", "0.1.0", "marker.txt"));
const claudeOldIntact = () => existsSync(path.join(root, "claude", "1.0.0", "claude.exe"));
const appDataIntact = () => existsSync(path.join(userData, "keep.txt"));
const outsideIntact = () => existsSync(path.join(box, "keep.txt"));
const noStrayStaging = () => {
  const dir = path.join(root, "claude");
  return !existsSync(dir) || readdirSync(dir).every((e) => !e.startsWith("."));
};

async function main(): Promise<void> {
  // Ordinary local install keeps working (compatibility).
  seed();
  const good = await installRuntimeFromLocalPath("claude", claudeSource("good", "2.0.0"));
  ok(good.ok && good.version === "2.0.0", "ordinary local-path install succeeds", JSON.stringify(good));
  ok(installedVersionOf("claude") === "2.0.0" && existsSync(path.join(root, "claude", "2.0.0", "claude.exe")),
    "ordinary install lands in <root>/claude/2.0.0");
  ok(piIntact(), "ordinary install leaves other agents alone");

  // "../pi" would replace another agent's runtime.
  seed();
  const sib = await installRuntimeFromLocalPath("claude", claudeSource("sibling", "../pi"));
  ok(!sib.ok, 'version "../pi" is refused', JSON.stringify(sib));
  ok(piIntact(), 'version "../pi" keeps the pi runtime');
  ok(claudeOldIntact(), 'version "../pi" keeps the installed claude runtime');
  ok(noStrayStaging(), 'refused "../pi" install leaves no staging dir');

  // ".." would remove the whole managed runtime root.
  seed();
  const up = await installRuntimeFromLocalPath("claude", claudeSource("up", ".."));
  ok(!up.ok, 'version ".." is refused', JSON.stringify(up));
  ok(piIntact() && claudeOldIntact(), 'version ".." keeps every installed runtime');

  // "../../.." climbs out of the app data dir (to the box here).
  seed();
  const out = await installRuntimeFromLocalPath("claude", claudeSource("out", "../../.."));
  ok(!out.ok, 'version "../../.." is refused', JSON.stringify(out));
  ok(outsideIntact() && appDataIntact(), 'version "../../.." deletes nothing outside the runtime root');
  ok(piIntact() && claudeOldIntact(), 'version "../../.." keeps every installed runtime');

  // Other shapes that are not a single safe directory name.
  for (const bad of [".", "a/b", "a\\b", ""]) {
    seed();
    const res = await installRuntimeFromLocalPath("claude", claudeSource(`bad-${passed}-${failed}`, bad));
    const landed = installedVersionOf("claude");
    ok(
      (!res.ok && claudeOldIntact()) || (res.ok && !!landed && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(landed)),
      `version ${JSON.stringify(bad)} never becomes a nested or parent slot`,
      JSON.stringify({ res, landed }),
    );
    ok(piIntact(), `version ${JSON.stringify(bad)} keeps the pi runtime`);
  }

  console.log(`\nM18 SUMMARY ${JSON.stringify({ passed, failed })}`);
}

main()
  .catch((err) => {
    failed++;
    console.error("HARNESS ERROR", err);
  })
  .finally(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
