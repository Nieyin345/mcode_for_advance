"use strict";
/**
 * FULL-0 / ARC-007. Verify the exact upstream baseline, the first reviewed
 * Mcode patch, the immutable Mcode patch series, and the final tree.
 * This inspects the nested checkout only; it never checks it out or mutates it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const EDITORS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
const FORMAT = "mcode.genoffice.upstream-lock.v2";
const REPOSITORY = "https://github.com/genspark-ai/genoffice";
const BASE_REVISION = "cbec600ace9c930b2646b6739cf6df3741bb9d6a";
const APPROVED_PATCH_REVISION = "73ba918083b5e2bedff7633925c3d7f625e04449";
const FINAL_REVISION = "3cb99ab13e1e42989889e15cc338bd6f6c6fff5c";
const FINAL_TREE = "5ba6f37bed435a389f8b7af51c70291f6c5bebba";
const LICENSE_SOURCE_MANIFEST = "apps/desktop/build/vendor-licenses/genoffice/manifest.json";
const APPROVED_PATHS = Object.freeze([
  "apps/pdf/src/main/atomic-write.ts",
  "apps/pdf/tests/page-operation-atomic-write.test.ts",
]);
const PATCHES = Object.freeze([
  { file: "patches/genoffice/0001-feat-docs-add-scoped-Mcode-native-preload-and-IPC-bo.patch", revision: "8d379b1d7db7721a4982aaab8f904f624a59a832", parentRevision: APPROVED_PATCH_REVISION, sha256: "0fdb71b158f6edcf20f82bdfa2ac8c8c06c444ab08035aa890e737bfa3c087c0" },
  { file: "patches/genoffice/0002-feat-docs-scope-open-lifecycle-to-Mcode-handoff.patch", revision: "684d9dc420a3837c37be318acc36c2c4bf201978", parentRevision: "8d379b1d7db7721a4982aaab8f904f624a59a832", sha256: "bcf18b61f0d298e8ffceab8e1be70b3ccf5561cf6404dbcadcac17060f0d188d" },
  { file: "patches/genoffice/0003-feat-docs-bind-native-language-and-system-locale-to-.patch", revision: "d8671f6ed75532d0260d9686bb31d63ec25faaf6", parentRevision: "684d9dc420a3837c37be318acc36c2c4bf201978", sha256: "ec8150e00da014262c52fe26485f415a0701c66aee867ab18768d106573961b3" },
  { file: "patches/genoffice/0004-feat-docs-add-host-scoped-native-spelling-operations.patch", revision: "d6eb48eab863f528f775bf80d2abcb475a3bed40", parentRevision: "d8671f6ed75532d0260d9686bb31d63ec25faaf6", sha256: "5a167c6a8534d69163ee4ad1796e90d7d06769c2c286091173d1992688d80201" },
  { file: "patches/genoffice/0005-feat-docs-route-scoped-context-menu-operations.patch", revision: "bd0886823d5762f21c04541eff5bd71a9f862fdb", parentRevision: "d6eb48eab863f528f775bf80d2abcb475a3bed40", sha256: "faa58b5fc7f77b0893d2fa502424a8bce7f046893dce653241987ae38c56a379" },
  { file: "patches/genoffice/0006-feat-docs-fail-close-recovery-and-consolidate-scoped.patch", revision: "2fa633afbe31a14ec3bbcb929c631ae3c828767d", parentRevision: "bd0886823d5762f21c04541eff5bd71a9f862fdb", sha256: "38da2edb59f840913c611aeea79145661428f8c438a657f35b3bb88d49ccc1fa" },
  { file: "patches/genoffice/0007-feat-docs-gate-privileged-operations.patch", revision: "02d8683ca3f19cf404a48c3f1625140ea5175b46", parentRevision: "2fa633afbe31a14ec3bbcb929c631ae3c828767d", sha256: "295276dee4d889ec8f0a5ea90d0437277756a31868c44becb99a5709e07b4dbd" },
  { file: "patches/genoffice/0008-feat-docs-bridge-native-ai-via-mcode-sessions.patch", revision: "bb7f67cc72056c0327030369a1156b92bbe37e7d", parentRevision: "02d8683ca3f19cf404a48c3f1625140ea5175b46", sha256: "3ceae9c45b592a327fa2a7c44af48fd284cb7a918ba70a74cf4422b9ed8522d4" },
  { file: "patches/genoffice/0009-feat-docs-scoped-export-media-and-files-read.patch", revision: "545c83b8a1abc69af2f7499a22d1c49b0c62d8e7", parentRevision: "bb7f67cc72056c0327030369a1156b92bbe37e7d", sha256: "b80bda2dd6f4215ff9dcf2e3f64e84e4f8c44a3e9f3e3d0daa027007f5f825c1" },
  { file: "patches/genoffice/0010-feat-pdf-markdown-html-scoped-mcode-ai.patch", revision: "9959e731e650f9eb51bf19937df2e07e967fe244", parentRevision: "545c83b8a1abc69af2f7499a22d1c49b0c62d8e7", sha256: "a093c109577962a51eaa0ddfdf3df6968e94dd1d8b5185c6de3535456d6594f9" },
  { file: "patches/genoffice/0011-security-sheets-slides-scoped-ipc.patch", revision: "aba076cc9b292461cc419288ee555e524f6250e1", parentRevision: "9959e731e650f9eb51bf19937df2e07e967fe244", sha256: "2f45a4632a38f7a394c5ddffb6a3fd6c515d7f9081e9f07e1504831644b3feed" },
  { file: "patches/genoffice/0012-security-slides-hosted-ai-media-ipc.patch", revision: "355e667353ad90da7d0b3c6823fad0f525b729c3", parentRevision: "aba076cc9b292461cc419288ee555e524f6250e1", sha256: "881f66dfc32c09050831e5760ef040a9e2e2a8588e9ab9a19ad284389817b5fa" },
  { file: "patches/genoffice/0013-feat-docs-ack-native-tool-results-in-hosted-turn.patch", revision: "635dee2f6a38d7f0a3aec31a487afc3e2369a5cf", parentRevision: "355e667353ad90da7d0b3c6823fad0f525b729c3", sha256: "7572ccf2650806cd7707f43d8e011d21ad1545e01ecbdbccbe15df6eb672409c" },
  { file: "patches/genoffice/0014-feat-docs-reshell-the-chrome-in-mcode-design-tokens.patch", revision: "05da63cdf6fcbec44176b07d10cb5b5f75f5f1cf", parentRevision: "635dee2f6a38d7f0a3aec31a487afc3e2369a5cf", sha256: "f2bc783ef20173e861f67e136bee00ee588e86cebc75a07701778d0d6a1a39af" },
  { file: "patches/genoffice/0015-feat-docs-write-eastAsia-so-new-docx-keeps-CJK-typo.patch", revision: FINAL_REVISION, parentRevision: "05da63cdf6fcbec44176b07d10cb5b5f75f5f1cf", sha256: "7a529e41be46b1b26c9d98d34a0bc9e536971131406be7a8619f34b6e859a595" },
]);

function runGit(directory, ...args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8", timeout: 30000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (cause) {
    throw new Error("GenOffice upstream Git inspection failed (" + args.join(" ") + "): " +
      (cause instanceof Error ? cause.message : String(cause)));
  }
}
function nonempty(file, name) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return;
  } catch {}
  throw new Error("GenOffice upstream missing/unsafe " + name + ": " + file);
}
function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assertPinnedLock(lock) {
  if (lock.format !== FORMAT || lock.repository !== REPOSITORY
      || lock.baseRevision !== BASE_REVISION
      || lock.revision !== FINAL_REVISION || lock.expectedTree !== FINAL_TREE
      || lock.license !== "Apache-2.0"
      || lock.licenseSourceManifest !== LICENSE_SOURCE_MANIFEST
      || !sameJson(lock.editors, EDITORS)) {
    throw new Error("GenOffice source lock differs from the pinned upstream/base/final-tree/six-app contract");
  }
  const patch = lock.approvedPatch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)
      || patch.revision !== APPROVED_PATCH_REVISION
      || patch.parentRevision !== BASE_REVISION
      || patch.subject !== "fix(pdf): use privately owned atomic save temporary files"
      || !sameJson(patch.paths, APPROVED_PATHS)) {
    throw new Error("GenOffice first approved patch identity/parent/changed-path manifest mismatch");
  }
  if (!Array.isArray(lock.patchSeries) || lock.patchSeries.length !== PATCHES.length) {
    throw new Error("GenOffice patch series missing or has an unexpected patch count");
  }
  for (let index = 0; index < PATCHES.length; index++) {
    const actual = lock.patchSeries[index];
    const expected = PATCHES[index];
    if (!actual || actual.index !== index + 1 || actual.file !== expected.file
        || actual.revision !== expected.revision || actual.parentRevision !== expected.parentRevision
        || actual.sha256 !== expected.sha256 || typeof actual.subject !== "string"
        || !actual.subject || !Number.isInteger(actual.bytes) || actual.bytes < 1) {
      throw new Error("GenOffice patch series identity/order/hash/parent mismatch at index " + (index + 1));
    }
  }
}
function assertPatchFiles(repoRoot, lock) {
  for (let index = 0; index < PATCHES.length; index++) {
    const expected = PATCHES[index];
    const entry = lock.patchSeries[index];
    const file = path.resolve(repoRoot, expected.file);
    const rel = path.relative(path.resolve(repoRoot), file);
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
      throw new Error("GenOffice patch path escapes Mcode root: " + expected.file);
    }
    nonempty(file, "patch " + (index + 1));
    const stat = fs.lstatSync(file);
    if (stat.size !== entry.bytes) throw new Error("GenOffice patch byte count mismatch: " + expected.file);
    if (sha256File(file) !== expected.sha256) {
      throw new Error("GenOffice patch SHA-256 mismatch: " + expected.file);
    }
    const firstLine = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
    const header = /^From ([0-9a-f]{40}) /.exec(firstLine);
    if (!header || header[1] !== expected.revision) {
      throw new Error("GenOffice patch mail header does not identify its pinned commit: " + expected.file);
    }
  }
}
function readCommit(vendor, revision) {
  const record = runGit(vendor, "show", "-s", "--format=%H%x1f%P%x1f%s", revision);
  const fields = record.split("\x1f");
  if (fields.length !== 3) throw new Error("GenOffice commit metadata malformed: " + revision);
  return { revision: fields[0], parentRevision: fields[1], subject: fields[2] };
}
function assertUpstreamRevision({ repoRoot, lockPath } = {}) {
  if (typeof repoRoot !== "string") throw new Error("GenOffice source gate requires repoRoot");
  const root = path.resolve(repoRoot);
  const file = lockPath ?? path.resolve(__dirname, "genoffice-upstream.lock.json");
  nonempty(file, "source lock");
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  assertPinnedLock(lock);
  assertPatchFiles(root, lock);

  const vendor = path.join(root, "genoffice");
  try {
    const stat = fs.lstatSync(vendor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
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

  // Check every commit from the approved patch's parent to HEAD. This rejects
  // missing, reordered, merged, or extra commits instead of merely pinning HEAD.
  const expectedCommits = [
    { revision: APPROVED_PATCH_REVISION, parentRevision: BASE_REVISION, subject: lock.approvedPatch.subject },
    ...lock.patchSeries.map(entry => ({
      revision: entry.revision, parentRevision: entry.parentRevision, subject: entry.subject,
    })),
  ];
  const actualCommits = runGit(vendor, "rev-list", "--reverse", BASE_REVISION + "..HEAD")
    .split(/\r?\n/).filter(Boolean);
  if (!sameJson(actualCommits, expectedCommits.map(entry => entry.revision))) {
    throw new Error("GenOffice commit lineage mismatch: expected approved patch plus exactly " + PATCHES.length + " ordered Mcode commits; actual " +
      actualCommits.join(", "));
  }
  if (runGit(vendor, "rev-parse", BASE_REVISION) !== BASE_REVISION) {
    throw new Error("GenOffice pinned upstream base commit is unavailable");
  }
  for (const expected of expectedCommits) {
    const actual = readCommit(vendor, expected.revision);
    if (actual.revision !== expected.revision || actual.parentRevision !== expected.parentRevision
        || actual.subject !== expected.subject) {
      throw new Error("GenOffice commit parent/subject lineage mismatch: " + expected.revision);
    }
  }

  const head = runGit(vendor, "rev-parse", "HEAD");
  if (head !== FINAL_REVISION || head !== lock.revision) {
    throw new Error("GenOffice upstream final commit mismatch: expected " + FINAL_REVISION + ", actual " + head);
  }
  const tree = runGit(vendor, "rev-parse", "HEAD^{tree}");
  if (tree !== FINAL_TREE || tree !== lock.expectedTree) {
    throw new Error("GenOffice upstream final tree mismatch: expected " + FINAL_TREE + ", actual " + tree);
  }
  const changed = runGit(vendor, "diff-tree", "--no-commit-id", "--name-only", "-r", APPROVED_PATCH_REVISION)
    .split(/\r?\n/).filter(Boolean).sort();
  if (!sameJson(changed, [...APPROVED_PATHS].sort())) {
    throw new Error("GenOffice approved patch changed-path manifest mismatch: " + changed.join(", "));
  }

  // The pinned SHA only authenticates tracked Git content. Reject any dirty
  // tracked/untracked state, including ignored executable source under src/.
  const changes = runGit(vendor, "status", "--porcelain", "--untracked-files=all");
  if (changes) throw new Error("GenOffice upstream tracked/untracked source is dirty: " + changes.slice(0, 300));
  const nativeSourceRoots = ["apps", "packages"].flatMap(rootName => {
    const dir = path.join(vendor, rootName);
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => rootName + "/" + entry.name + "/src")
        .filter(relative => fs.existsSync(path.join(vendor, relative)));
    } catch { return []; }
  });
  if (nativeSourceRoots.length > 0) {
    const ignored = runGit(vendor, "ls-files", "--others", "--ignored", "--exclude-standard",
      "--", ...nativeSourceRoots);
    const executableSource = ignored.split(/\r?\n/).find(file =>
      /\.(?:[cm]?js|jsx|[cm]?ts|tsx|rs|html|css|json|wasm)$/i.test(file));
    if (executableSource) throw new Error("GenOffice upstream ignored/untracked source is not pinned: " + executableSource);
  }

  const licenseFile = path.join(vendor, "LICENSE");
  nonempty(licenseFile, "LICENSE");
  nonempty(path.join(vendor, "NOTICE"), "NOTICE");
  if (!/Apache License\s+Version 2\.0/.test(fs.readFileSync(licenseFile, "utf8"))) {
    throw new Error("GenOffice upstream Apache-2.0 LICENSE no longer matches pinned provenance");
  }
  for (const name of EDITORS) {
    for (const part of ["main", "preload", "renderer"]) {
      const dir = path.join(vendor, "apps", name, "src", part);
      try {
        if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) continue;
      } catch {}
      throw new Error("GenOffice original " + name + "/src/" + part + " unavailable; cannot advertise six native apps");
    }
  }
  return {
    repository: lock.repository,
    baseRevision: lock.baseRevision,
    approvedPatchRevision: lock.approvedPatch.revision,
    patchCount: lock.patchSeries.length,
    revision: head,
    tree,
    license: lock.license,
    editors: [...EDITORS],
  };
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
      ? `GenOffice original upstream approved: ${result.revision} (base ${result.baseRevision}, ${result.patchCount} patches, tree ${result.tree})`
      : "GenOffice upstream gate: opt-out, no vendor source required");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
module.exports = {
  assertUpstreamRevision, verifyReleaseSource, EDITORS, PATCHES, BASE_REVISION,
  APPROVED_PATCH_REVISION, FINAL_REVISION, FINAL_TREE, LICENSE_SOURCE_MANIFEST,
};
