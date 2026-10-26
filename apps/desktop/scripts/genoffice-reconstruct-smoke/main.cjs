"use strict";
/**
 * Rebuild the exact reviewed GenOffice history in a disposable, isolated Git
 * clone. This smoke never alters the user's genoffice worktree or Mcode index.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { reconstructPinnedSource } = require("../../build/prepare-genoffice-release.cjs");
const { FINAL_REVISION, FINAL_TREE, PATCHES } = require("../../build/verify-genoffice-upstream.cjs");

const repoRoot = path.resolve(__dirname, "../../../..");
const upstreamUrl = path.join(repoRoot, "genoffice");
if (!fs.statSync(upstreamUrl).isDirectory()) {
  throw new Error("GenOffice release replay smoke requires a reviewed local vendor clone");
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-genoffice-ci-replay-"));
try {
  const result = reconstructPinnedSource({
    repoRoot,
    vendorDir: path.join(tempRoot, "genoffice"),
    upstreamUrl,
    env: { ...process.env, CI: "true" },
  });
  assert.equal(result.created, true);
  assert.equal(result.checked, true);
  assert.equal(result.revision, FINAL_REVISION);
  assert.equal(result.tree, FINAL_TREE);
  assert.equal(result.patchCount, PATCHES.length);
  assert.deepEqual(result.editors, ["docs", "sheets", "slides", "pdf", "markdown", "html"]);
  console.log("PASS GENOFFICE_RECONSTRUCTION pinned upstream + baseline + approved + " +
    PATCHES.length + " patches yields exact final Git commit/tree");
} finally {
  // Only delete the OS-temp directory allocated exclusively by this smoke.
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
