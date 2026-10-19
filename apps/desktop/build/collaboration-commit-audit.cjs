"use strict";
/**
 * Multi-AI working-tree audit: inventory only, NEVER stage, commit, stash or
 * reset another conversation's work. Run from the Mcode checkout:
 *
 *   node apps/desktop/build/collaboration-commit-audit.cjs
 *   node apps/desktop/build/collaboration-commit-audit.cjs --owner <conversation-id> --json
 *
 * A missing claim is NOT proof that a file is safe to commit: agents release
 * claims after a task and pre-protocol edits may never have had a claim.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const CLAIMS_DIR = path.join(PROJECT_ROOT, "audit-ledgers", "collaboration", "claims");
const OWNER = /^[a-z][a-z0-9-]{4,70}$/;

function canonical(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new Error("Invalid path in Git/claim");
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix) ||
    posix.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Refusing absolute/parent path: " + raw);
  }
  return posix.toLowerCase();
}

/** Git porcelain -z returns NUL-delimited, UNQUOTED paths. In a rename,
 * its first path is the destination, second NUL field is the source.
 * Ordinary line splitting corrupts legitimate Unicode/newline filenames.
 */
function parsePorcelainV1Z(payload) {
  if (!payload) return [];
  if (typeof payload !== "string" || !payload.endsWith("\0")) {
    throw new Error("Truncated Git porcelain -z output");
  }
  const parts = payload.slice(0, -1).split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (record.length < 4 || record[2] !== " ") throw new Error("Malformed Git porcelain entry");
    const xy = record.slice(0, 2);
    if (!/^[ MADRCUT?!]{2}$/.test(xy)) throw new Error("Unexpected Git status code: " + xy);
    const file = record.slice(3);
    canonical(file);
    const renamed = /[RC]/.test(xy);
    let prior = null;
    if (renamed) {
      if (i + 1 >= parts.length) throw new Error("Truncated rename/copy record");
      prior = parts[++i];
      canonical(prior);
    }
    entries.push({
      path: file, oldPath: prior, status: xy,
      staged: xy[0] !== " " && xy[0] !== "?" && xy[0] !== "!",
      modified: xy[1] !== " " && xy[1] !== "?" && xy[1] !== "!",
      untracked: xy === "??",
    });
  }
  return entries;
}

function gitStatus(cwd = PROJECT_ROOT) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 24 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Cannot inspect Git worktree: " + (result.error?.message || result.stderr || result.status));
  }
  return parsePorcelainV1Z(result.stdout);
}

/** Claims are advisory ownership only, not permission to automatically commit.
 * Corrupt/duplicate claim files are a blocker, not 'unclaimed'.
 */
function readClaims(dir = CLAIMS_DIR) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const claim = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
    if (!claim || claim.schema !== "mcode.collaboration.claim/v1"
      || !OWNER.test(claim.owner) || typeof claim.task !== "string") {
      throw new Error("Malformed ownership claim: " + entry.name);
    }
    const key = canonical(claim.file);
    if (map.has(key)) throw new Error("Conflicting ownership claims for " + claim.file);
    map.set(key, { owner: claim.owner, task: claim.task, file: claim.file });
  }
  return map;
}

function analyze(entries, claims, requestedOwner = null) {
  if (requestedOwner !== null && !OWNER.test(requestedOwner)) throw new Error("Invalid owner id");
  const ownerCounts = {};
  const files = entries.map((entry) => {
    const claim = claims.get(canonical(entry.path)) || null;
    const priorClaim = entry.oldPath ? (claims.get(canonical(entry.oldPath)) || null) : null;
    const mixedRename = entry.oldPath !== null &&
      (!claim || !priorClaim || claim.owner !== priorClaim.owner);
    const owner = claim?.owner ?? null;
    const group = owner ?? "(unclaimed)";
    ownerCounts[group] = (ownerCounts[group] || 0) + 1;
    return {
      ...entry, owner, task: claim?.task || null,
      mixedRename,
      candidateForOwner: requestedOwner !== null && owner === requestedOwner && !mixedRename,
    };
  });
  const staged = files.filter((item) => item.staged);
  // A staged change from any other owner, an unclaimed file, or ambiguous
  // rename is a hard 'stop and coordinate' if the user supplied --owner.
  const unsafeStaged = requestedOwner
    ? staged.filter((item) => !item.candidateForOwner)
    : [];
  return {
    worktreeEntries: files.length,
    trackedChanges: files.filter((item) => !item.untracked).length,
    untrackedFiles: files.filter((item) => item.untracked).length,
    stagedChanges: staged.length,
    claimedChanges: files.filter((item) => item.owner !== null).length,
    unclaimedChanges: files.filter((item) => item.owner === null).length,
    owners: ownerCounts,
    requestedOwner,
    ownedDirty: files.filter((item) => item.candidateForOwner).map((item) => item.path),
    unsafeStaged: unsafeStaged.map((item) => item.path),
    files,
  };
}

function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Usage: node collaboration-commit-audit.cjs [--owner conversation-id] [--json]");
    console.log("READ ONLY: never auto-commit; no active claim is not proof of ownership.");
    return;
  }
  const idx = args.indexOf("--owner");
  const owner = idx < 0 ? null : args[idx + 1];
  if (idx >= 0 && (!owner || owner.startsWith("--"))) throw new Error("--owner requires an id");
  const accepted = new Set(["--json", ...(idx >= 0 ? ["--owner", owner] : [])]);
  if (args.some((part) => !accepted.has(part))) throw new Error("Unexpected argument");
  const summary = analyze(gitStatus(), readClaims(), owner);
  if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log("Git worktree changes: " + summary.worktreeEntries);
    console.log("  tracked=" + summary.trackedChanges + ", untracked=" + summary.untrackedFiles +
      ", staged=" + summary.stagedChanges);
    console.log("  claimed=" + summary.claimedChanges + ", no active claim=" + summary.unclaimedChanges);
    for (const [who, n] of Object.entries(summary.owners).sort((a, b) => b[1] - a[1])) {
      console.log("  " + who + ": " + n);
    }
    if (owner) {
      console.log("  " + owner + " currently claimed dirty: " + summary.ownedDirty.length);
      console.log("  foreign/unclaimed staged (BLOCKED): " + summary.unsafeStaged.length);
      for (const file of summary.unsafeStaged) console.log("    " + file);
    }
    console.log("This report is read-only. Verify tests and task history before any exact-path commit.");
  }
  if (summary.unsafeStaged.length) process.exitCode = 2;
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = { canonical, parsePorcelainV1Z, gitStatus, readClaims, analyze, main };
