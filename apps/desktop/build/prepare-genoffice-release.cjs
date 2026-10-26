"use strict";
/**
 * Reconstruct the reviewed GenOffice fork from the public pinned base and
 * Mcode's hash-pinned patch series, then build only assets Mcode actually ships.
 *
 * CI-only bootstrap when the ignored nested checkout is absent. Never updates
 * an existing vendor checkout to a different revision and never runs GenOffice's
 * standalone Electron shell. Generated outputs remain in ignored vendor paths.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  assertPatchFiles, assertPinnedLock, verifyReleaseSource,
  EDITORS, PATCHES, UPSTREAM_REVISION, BASE_REVISION, UPSTREAM_BASE_PATCH_FILE, APPROVED_PATCH_FILE,
} = require("./verify-genoffice-upstream.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const LOCK_PATH = path.join(__dirname, "genoffice-upstream.lock.json");
const LOCK = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
const VENDOR = path.join(ROOT, "genoffice");
const PRELOADS = ["docs", "sheets", "slides", "pdf", "markdown", "html"].filter(x => x !== "docs");
const REQUIRED = [
  ...EDITORS.map(name => path.join("apps", name, "out", "renderer", "index.html")),
  ...PRELOADS.map(name => path.join("apps", name, "out", "preload", "index.js")),
  path.join("packages", "cli", "dist", "genoffice.cjs"),
  path.join("packages", "cli", "dist", "node_modules"),
  path.join("node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"),
  path.join("apps", "shell", "build", "THIRD-PARTY-NOTICES.txt"),
  path.join("apps", "sheets", "native", "xlsx-engine", "target", "release",
    process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar"),
];

function git(cwd, args, env = process.env) {
  return execFileSync("git", args, {
    cwd, env, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
  }).trim();
}
function runNpm(args, cwd, env = process.env) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    cwd, env, stdio: "inherit", windowsHide: true,
    // npm is a .cmd shim on Windows. Arguments are fixed package/script names,
    // never user-controlled shell fragments.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("npm " + args.join(" ") + " failed with exit " + result.status);
}
function expectedCommits(lock) {
  return [
    lock.upstreamBasePatch,
    lock.approvedPatch,
    ...lock.patchSeries,
  ].map(entry => ({
    file: entry.file,
    revision: entry.revision,
    committerDate: entry.committerDate,
  }));
}
function patchIdentity(file) {
  const text = fs.readFileSync(file, "utf8");
  const revision = /^From ([0-9a-f]{40}) /m.exec(text)?.[1];
  const author = /^From: (.+) <([^>]+)>$/m.exec(text);
  if (!revision || !author) throw new Error("Pinned GenOffice patch has malformed mail metadata: " + file);
  return { revision, committerName: author[1], committerEmail: author[2] };
}
function applyPatch(vendorDir, file, expected) {
  const identity = patchIdentity(file);
  if (identity.revision !== expected.revision) {
    throw new Error("Patch file revision differs from source lock: " + path.basename(file));
  }
  const env = { ...process.env };
  delete env.GIT_COMMITTER_DATE;
  const args = ["-C", vendorDir, "-c", "user.name=" + identity.committerName,
    "-c", "user.email=" + identity.committerEmail, "am"];
  if (expected.committerDate) env.GIT_COMMITTER_DATE = expected.committerDate;
  else args.push("--committer-date-is-author-date");
  args.push(file);
  execFileSync("git", args, {
    cwd: ROOT, env, stdio: "inherit", windowsHide: true, timeout: 120_000,
  });
  const actual = git(vendorDir, ["rev-parse", "HEAD"]);
  if (actual !== expected.revision) {
    throw new Error("Reconstructed GenOffice commit mismatch for " + path.basename(file)
      + ": expected " + expected.revision + ", got " + actual);
  }
}
function addGeneratedOutputExcludes(vendorDir) {
  // Rust's target/ is generated but upstream's .gitignore does not cover it.
  // Keep this local to .git/info/exclude so the pinned source tree stays exact.
  const exclude = path.join(vendorDir, ".git", "info", "exclude");
  const rule = "/apps/sheets/native/xlsx-engine/target/";
  let text = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!text.split(/\r?\n/).includes(rule)) {
    fs.appendFileSync(exclude, (text && !text.endsWith("\n") ? "\n" : "") + rule + "\n");
  }
}
function reconstructPinnedSource({ repoRoot = ROOT, vendorDir = path.join(repoRoot, "genoffice"),
  upstreamUrl = LOCK.repository + ".git", env = process.env } = {}) {
  const root = path.resolve(repoRoot);
  const vendor = path.resolve(vendorDir);
  assertPinnedLock(LOCK);
  assertPatchFiles(root, LOCK);
  if (fs.existsSync(vendor)) {
    const result = verifyReleaseSource({
      repoRoot: root, vendorDir: vendor,
      env: { ...env, MCODE_INCLUDE_GENOFFICE_BUNDLE: "1", MCODE_INCLUDE_GENOFFICE_EDITORS: "1" },
    });
    addGeneratedOutputExcludes(vendor);
    return { created: false, ...result };
  }
  if (env.CI !== "true") {
    throw new Error("Ignored GenOffice checkout is absent. Automatic reconstruction is CI-only; provide a reviewed local checkout for local packaging.");
  }
  fs.mkdirSync(path.dirname(vendor), { recursive: true });
  let created = false;
  try {
    created = true;
    const localUpstream = fs.existsSync(upstreamUrl) && fs.statSync(upstreamUrl).isDirectory();
    const cloneArgs = localUpstream
      ? ["clone", "--shared", "--no-checkout", "--single-branch", "--branch", "main", upstreamUrl, vendor]
      : ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", "main", upstreamUrl, vendor];
    execFileSync("git", cloneArgs, {
      cwd: root, stdio: "inherit", windowsHide: true, timeout: 180_000,
    });
    git(vendor, ["checkout", "--detach", UPSTREAM_REVISION]);
    if (git(vendor, ["rev-parse", "HEAD"]) !== UPSTREAM_REVISION) {
      throw new Error("GenOffice upstream did not resolve the pinned public upstream revision");
    }
    for (const expected of expectedCommits(LOCK)) {
      applyPatch(vendor, path.resolve(root, expected.file), expected);
    }
    const source = verifyReleaseSource({
      repoRoot: root, vendorDir: vendor,
      env: { ...env, MCODE_INCLUDE_GENOFFICE_BUNDLE: "1", MCODE_INCLUDE_GENOFFICE_EDITORS: "1" },
    });
    addGeneratedOutputExcludes(vendor);
    return { created, ...source };
  } catch (error) {
    if (created && fs.existsSync(vendor)) {
      try { fs.rmSync(vendor, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}
function verifyBuiltAssets(vendorDir) {
  const missing = [];
  for (const relative of REQUIRED) {
    const file = path.join(vendorDir, relative);
    try {
      const stat = fs.statSync(file);
      if (relative.endsWith("node_modules") ? !stat.isDirectory() : !stat.isFile() || stat.size === 0) {
        missing.push(relative);
      }
    } catch { missing.push(relative); }
  }
  if (missing.length) throw new Error("GenOffice release build did not produce required assets: " + missing.join(", "));
}
function buildEditorAssets(vendorDir = VENDOR, env = process.env) {
  // Ignore lifecycle scripts to avoid downloading the unused standalone
  // GenOffice Electron application. Optional platform binaries are locked in
  // package-lock.json; Mcode builds and runs its own Electron host.
  runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], vendorDir, env);
  runNpm(["run", "notices"], vendorDir, env);
  for (const name of EDITORS) runNpm(["run", "build", "--workspace=@genoffice/" + name], vendorDir, env);
  runNpm(["run", "build", "--workspace=@genoffice/cli"], vendorDir, env);
  verifyBuiltAssets(vendorDir);
  // Builds may create ignored files only; rerun the source gate after all tools
  // have executed so a tool cannot silently alter tracked or untracked source.
  const source = verifyReleaseSource({
    repoRoot: ROOT, vendorDir,
    env: { ...env, MCODE_INCLUDE_GENOFFICE_BUNDLE: "1", MCODE_INCLUDE_GENOFFICE_EDITORS: "1" },
  });
  return { ...source, assets: REQUIRED.length };
}
function prepareGenofficeRelease({ repoRoot = ROOT, vendorDir = path.join(repoRoot, "genoffice"),
  upstreamUrl, env = process.env, build = true } = {}) {
  const source = reconstructPinnedSource({ repoRoot, vendorDir, upstreamUrl, env });
  const built = build ? buildEditorAssets(path.resolve(vendorDir), env) : null;
  return { source, built };
}
if (require.main === module) {
  try {
    const result = prepareGenofficeRelease();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    console.error("GenOffice release preparation failed closed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = {
  reconstructPinnedSource, buildEditorAssets, verifyBuiltAssets, prepareGenofficeRelease,
  expectedCommits, patchIdentity, REQUIRED,
};
