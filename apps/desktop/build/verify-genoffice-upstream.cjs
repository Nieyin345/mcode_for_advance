"use strict";
/**
 * FULL-0 / ARC-007. Verify the ORIGINAL nested GenOffice Git revision before
 * bundling its CLI or six native editor assets. No vendor build or user data
 * changes occur here. A default package without vendor opt-in is unaffected.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EDITORS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
const FORMAT = "mcode.genoffice.upstream-lock.v1";

function runGit(directory, ...args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
    }).trim();
  } catch (cause) {
    throw new Error("GenOffice upstream Git inspection failed (" + args.join(" ") + "): " +
      (cause instanceof Error ? cause.message : String(cause)));
  }
}
function nonempty(file, name) {
  try {
    if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) return;
  } catch {}
  throw new Error("GenOffice upstream missing " + name + ": " + file);
}
function assertUpstreamRevision({ repoRoot, lockPath } = {}) {
  if (typeof repoRoot !== "string") throw new Error("GenOffice source gate requires repoRoot");
  const file = lockPath ?? path.resolve(__dirname, "genoffice-upstream.lock.json");
  nonempty(file, "source lock");
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (lock.format !== FORMAT || lock.repository !== "https://github.com/genspark-ai/genoffice"
      || lock.license !== "Apache-2.0"
      || typeof lock.revision !== "string" || !/^[0-9a-f]{40}$/.test(lock.revision)
      || JSON.stringify(lock.editors) !== JSON.stringify(EDITORS)) {
    throw new Error("GenOffice source lock invalid or missing canonical upstream/commit/license/six apps");
  }
  // A reviewed GenOffice L3 patch must remain tied to its upstream base, and
  // may only change the explicitly approved original source/test files.
  const patch = lock.approvedPatch;
  const hasLineage = lock.baseRevision !== undefined || patch !== undefined;
  if (hasLineage && (typeof lock.baseRevision !== "string"
      || !/^[0-9a-f]{40}$/.test(lock.baseRevision)
      || !patch || typeof patch !== "object" || Array.isArray(patch)
      || patch.revision !== lock.revision
      || !Array.isArray(patch.paths) || patch.paths.length === 0
      || patch.paths.some(p => typeof p !== "string"
        || !/^apps\/[a-z0-9/.-]+\.(?:ts|tsx)$/.test(p)
        || p.split("/").some(segment => !segment || segment === "." || segment === ".."))
      || new Set(patch.paths).size !== patch.paths.length)) {
    throw new Error("GenOffice approved upstream patch lineage / changed-path manifest invalid");
  }
  const vendor = path.join(path.resolve(repoRoot), "genoffice");
  try {
    if (!fs.lstatSync(vendor).isDirectory() || fs.lstatSync(vendor).isSymbolicLink())
      throw new Error("not a real directory");
  } catch {
    throw new Error("GenOffice upstream checkout missing or symlinked: " + vendor);
  }
  const worktree = fs.realpathSync.native(vendor);
  const gitRoot = fs.realpathSync.native(runGit(vendor, "rev-parse", "--show-toplevel"));
  if (process.platform === "win32"
    ? worktree.toLowerCase() !== gitRoot.toLowerCase()
    : worktree !== gitRoot) {
    throw new Error("GenOffice must be its own nested upstream Git checkout, not the Mcode repository");
  }
  const head = runGit(vendor, "rev-parse", "HEAD");
  if (head !== lock.revision) {
    throw new Error(`GenOffice upstream commit mismatch: locked ${lock.revision}, actual ${head}`);
  }
  if (hasLineage) {
    const parent = runGit(vendor, "rev-parse", `${patch.revision}^`);
    if (parent !== lock.baseRevision) {
      throw new Error(`GenOffice approved patch parent mismatch: expected ${lock.baseRevision}, actual ${parent}`);
    }
    const changed = runGit(vendor, "diff-tree", "--no-commit-id", "--name-only", "-r", patch.revision)
      .split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...patch.paths].sort())) {
      throw new Error(`GenOffice approved patch file manifest mismatch: ${changed.join(", ")}`);
    }
  }
  // Ignored build output is expected, but source changes AND root dependency
  // manifest/lock changes can alter bundled native runtimes without changing HEAD.
  const changes = runGit(vendor, "status", "--porcelain", "--untracked-files=all", "--",
    "apps", "packages", "LICENSE", "NOTICE", "package.json", "package-lock.json");
  if (changes) throw new Error("GenOffice upstream tracked/untracked source is dirty: " + changes.slice(0, 300));
  const licenseFile = path.join(vendor, "LICENSE");
  nonempty(licenseFile, "LICENSE");
  nonempty(path.join(vendor, "NOTICE"), "NOTICE");
  const license = fs.readFileSync(licenseFile, "utf8");
  if (!/Apache License\s+Version 2\.0/.test(license)) {
    throw new Error("GenOffice upstream Apache-2.0 LICENSE no longer matches pinned provenance");
  }
  for (const name of EDITORS) {
    for (const part of ["main", "preload", "renderer"]) {
      const dir = path.join(vendor, "apps", name, "src", part);
      try {
        if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) continue;
      } catch {}
      throw new Error(`GenOffice original ${name}/src/${part} unavailable; cannot advertise six native apps`);
    }
  }
  return { repository: lock.repository, revision: head, license: lock.license, editors: [...EDITORS] };
}
function verifyReleaseSource({ repoRoot, env = process.env, lockPath } = {}) {
  const cli = env.MCODE_INCLUDE_GENOFFICE_BUNDLE ?? "";
  const editors = env.MCODE_INCLUDE_GENOFFICE_EDITORS ?? "";
  if (!["", "0", "1"].includes(cli) || !["", "0", "1"].includes(editors)) {
    throw new Error("GenOffice release opt-in flags must be 0 or 1");
  }
  if (editors === "1" && cli !== "1") {
    throw new Error("Six GenOffice editors require MCODE_INCLUDE_GENOFFICE_BUNDLE=1");
  }
  if (cli !== "1") return { bundled: false, checked: false };
  return { bundled: true, checked: true, ...assertUpstreamRevision({ repoRoot, lockPath }) };
}
if (require.main === module) {
  try {
    const result = verifyReleaseSource({ repoRoot: path.resolve(__dirname, "../../..") });
    console.log(result.checked
      ? `GenOffice original upstream approved: ${result.revision} (Apache-2.0, six source apps)`
      : "GenOffice upstream gate: opt-out, no vendor source required");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
module.exports = { assertUpstreamRevision, verifyReleaseSource, EDITORS };
