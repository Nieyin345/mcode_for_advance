"use strict";
/**
 * FULL-0 upstream provenance test.
 *
 * The verifier's contract changed in fe6ee970 (T87): lock format v1
 * ({format, repository, revision, license, editors}) became
 * `mcode.genoffice.upstream-lock.v2`, which additionally pins the exact
 * upstream base commit, the reviewed PDF patch identity, the immutable
 * 13-patch series and the final tree, and refuses any lock that differs.
 * A synthetic Git repository can therefore never satisfy the positive path:
 * the pinned SHAs are properties of the real vendored checkout. Sections A/B
 * still need no vendor (opt-in semantics, lock-format rejection); section C
 * clones the real `genoffice/` into OS temp and mutates only that clone.
 * When the vendor checkout is absent (CI does not fetch it), section C prints
 * explicit skip lines and is not counted — never a silent green.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  verifyReleaseSource, assertUpstreamRevision, EDITORS,
  BASE_REVISION, FINAL_REVISION, FINAL_TREE, PATCHES,
} = require("../../build/verify-genoffice-upstream.cjs");

const repoRootReal = path.resolve(__dirname, "../../../..");
const vendorReal = path.join(repoRootReal, "genoffice");
const lockReal = path.join(repoRootReal, "apps/desktop/build/genoffice-upstream.lock.json");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-go-upstream-"));
let count = 0;
function check(name, fn) { fn(); count++; console.log("  ok " + name); }
function skip(name, why) { console.log("  skip " + name + " (" + why + ")"); }
function put(p, s = "fixture") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  }).trim();
}
try {
  // ── Section A: release opt-in semantics (no vendor checkout required) ──
  const emptyRepo = path.join(base, "empty-mcode");
  const emptyLock = path.join(base, "empty-lock.json");
  check("without opt-in no vendor checkout is necessary", () => {
    assert.deepEqual(verifyReleaseSource({ repoRoot: emptyRepo, lockPath: emptyLock }), { bundled: false, checked: false });
  });
  check("release opt-in cannot silently accept missing GenOffice source", () => {
    assert.throws(() => verifyReleaseSource({ repoRoot: emptyRepo, lockPath: emptyLock, env: { MCODE_INCLUDE_GENOFFICE_BUNDLE: "1" } }),
      /lock|missing|GenOffice/i);
  });
  check("six-editor opt-in cannot bypass CLI bundle opt-in", () => {
    assert.throws(() => verifyReleaseSource({ repoRoot: emptyRepo, lockPath: emptyLock, env: { MCODE_INCLUDE_GENOFFICE_EDITORS: "1" } }),
      /require.*BUNDLE|require.*CLI/i);
  });

  // ── Section B: v2 lock contract is pinned, not negotiated ──
  // Any lock that is not byte-for-byte the reviewed v2 contract must be
  // rejected before the checkout is even inspected. This is the branch the
  // old v1 fixture tripped over when the product moved to v2.
  const lockSource = JSON.parse(fs.readFileSync(lockReal, "utf8"));
  const lockCopy = path.join(base, "contract-lock.json");
  const writeLock = (mutate) => {
    const next = JSON.parse(JSON.stringify(lockSource));
    mutate(next);
    fs.writeFileSync(lockCopy, JSON.stringify(next, null, 2) + "\n");
  };
  check("legacy v1 lock format is rejected by the pinned v2 contract", () => {
    fs.writeFileSync(lockCopy, JSON.stringify({
      format: "mcode.genoffice.upstream-lock.v1", repository: lockSource.repository,
      revision: lockSource.revision, license: "Apache-2.0", editors: [...EDITORS],
    }));
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }), /source lock differs/i);
  });
  check("lock with a partial editor list is rejected", () => {
    writeLock((lock) => { lock.editors.pop(); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }), /source lock differs/i);
  });
  check("lock claiming a different final revision is rejected", () => {
    writeLock((lock) => { lock.revision = "0".repeat(40); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }), /source lock differs/i);
  });
  check("lock claiming a different expected tree is rejected", () => {
    writeLock((lock) => { lock.expectedTree = "0".repeat(40); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }), /source lock differs/i);
  });
  check("relabeling the reviewed PDF patch subject is rejected", () => {
    writeLock((lock) => { lock.approvedPatch.subject = "unreviewed change"; });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }),
      /first approved patch identity\/parent\/changed-path manifest mismatch/i);
  });
  check("hiding one changed path of the reviewed PDF patch is rejected", () => {
    writeLock((lock) => { lock.approvedPatch.paths = lock.approvedPatch.paths.slice(0, 1); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }),
      /first approved patch identity\/parent\/changed-path manifest mismatch/i);
  });
  check("relabeling the reviewed PDF patch parent is rejected", () => {
    writeLock((lock) => { lock.approvedPatch.parentRevision = "0".repeat(40); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }),
      /first approved patch identity\/parent\/changed-path manifest mismatch/i);
  });
  check("missing one entry of the 13-patch series is rejected", () => {
    writeLock((lock) => { lock.patchSeries.pop(); });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }),
      /patch series missing|unexpected patch count/i);
  });
  check("reordering the 13-patch series is rejected", () => {
    writeLock((lock) => {
      [lock.patchSeries[0], lock.patchSeries[1]] = [lock.patchSeries[1], lock.patchSeries[0]];
    });
    assert.throws(() => assertUpstreamRevision({ repoRoot: emptyRepo, lockPath: lockCopy }),
      /patch series identity\/order\/hash\/parent mismatch/i);
  });
  check("package pipeline must verify source BEFORE staging or electron-builder", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    const script = pkg.scripts.package;
    const gate = script.indexOf("verify-genoffice-upstream.cjs");
    const stage = script.indexOf("stage-genoffice-resources.cjs");
    assert.ok(gate >= 0 && stage > gate && script.indexOf("electron-builder") > stage,
      "FULL-0 source provenance gate missing from packaged release pipeline");
  });

  // ── Section C: the pinned contract against the REAL vendored lineage ──
  const vendorPresent = fs.existsSync(vendorReal);
  if (!vendorPresent) {
    skip("pinned lineage and dirty-tree rejection", "genoffice vendor checkout absent; nothing verified");
  } else {
    const fixtureRoot = path.join(base, "lineage-fixture");
    const clone = path.join(fixtureRoot, "genoffice");
    const cloneLock = path.join(fixtureRoot, "apps/desktop/build/genoffice-upstream.lock.json");
    fs.mkdirSync(fixtureRoot, { recursive: true });
    execFileSync("git", ["clone", "--local", "--no-hardlinks", vendorReal, clone], {
      encoding: "utf8", timeout: 120000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
    });
    put(cloneLock, fs.readFileSync(lockReal));
    for (const entry of lockSource.patchSeries) {
      put(path.join(fixtureRoot, entry.file), fs.readFileSync(path.join(repoRootReal, entry.file)));
    }
    const verifyClone = () => assertUpstreamRevision({ repoRoot: fixtureRoot, lockPath: cloneLock });
    const realHeadStatus = git(vendorReal, "status", "--porcelain", "--untracked-files=all");
    const realHead = git(vendorReal, "rev-parse", "HEAD");

    check("pinned clean nested Git checkout with all six original app source roots passes", () => {
      const r = verifyClone();
      assert.equal(r.baseRevision, BASE_REVISION);
      assert.equal(r.revision, FINAL_REVISION);
      assert.equal(r.tree, FINAL_TREE);
      assert.equal(r.patchCount, PATCHES.length);
      assert.deepEqual(r.editors, [...EDITORS]);
      assert.equal(verifyReleaseSource({ repoRoot: fixtureRoot, lockPath: cloneLock, env: { MCODE_INCLUDE_GENOFFICE_BUNDLE: "1" } }).checked, true);
    });
    check("tampered patch bytes are rejected by the pinned SHA-256", () => {
      const patch = path.join(fixtureRoot, lockSource.patchSeries[3].file);
      const saved = fs.readFileSync(patch);
      const tampered = Buffer.from(saved);
      tampered[0] ^= 1;
      fs.writeFileSync(patch, tampered);
      try { assert.throws(verifyClone, /SHA-256 mismatch/i); }
      finally { fs.writeFileSync(patch, saved); }
    });
    check("dirty tracked vendor file fails rather than advertising an old HEAD", () => {
      const file = path.join(clone, "apps/docs/electron.vite.config.ts");
      const saved = fs.readFileSync(file);
      fs.writeFileSync(file, saved.toString("utf8") + "\n// T31 fixture mutation\n");
      try { assert.throws(verifyClone, /dirty/i); }
      finally { fs.writeFileSync(file, saved); }
    });
    check("tracked root package manifest drift cannot bypass source provenance", () => {
      const file = path.join(clone, "package.json");
      const saved = fs.readFileSync(file);
      fs.writeFileSync(file, saved.toString("utf8").replace(/"name"\s*:\s*"[^"]*"/, '"name":"modified-vendor-package"'));
      try {
        assert.notEqual(fs.readFileSync(file).toString("utf8"), saved.toString("utf8"), "mutation must change bytes");
        assert.throws(verifyClone, /dirty/i);
      } finally { fs.writeFileSync(file, saved); }
    });
    check("tracked dependency lock drift cannot bypass source provenance", () => {
      const file = path.join(clone, "package-lock.json");
      const saved = fs.readFileSync(file);
      const parsed = JSON.parse(saved.toString("utf8"));
      parsed.t31Marker = "modified-transitive-dependencies";
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
      try {
        assert.notEqual(fs.readFileSync(file).toString("utf8"), saved.toString("utf8"), "mutation must change bytes");
        assert.throws(verifyClone, /dirty/i);
      } finally { fs.writeFileSync(file, saved); }
    });
    check("untracked top-level build script is not exempt from source lock", () => {
      const script = path.join(clone, "native-build-hook.cjs");
      put(script, "process.exit(0);\n");
      try { assert.throws(verifyClone, /dirty/i); }
      finally { fs.rmSync(script, { force: true }); }
    });
    check("extra commit after the pinned final HEAD is rejected", () => {
      git(clone, "config", "user.email", "t31-fixture@example.invalid");
      git(clone, "config", "user.name", "T31 fixture");
      git(clone, "commit", "--allow-empty", "--no-gpg-sign", "-m", "T31 fixture-only extra commit");
      try { assert.throws(verifyClone, /lineage mismatch|final commit mismatch/i); }
      finally { git(clone, "reset", "--hard", FINAL_REVISION); }
    });
    check("untracked native source under apps fails rather than bypassing revision pin", () => {
      const injected = path.join(clone, "apps/pdf/src/main/new-native.ts");
      put(injected, "export const newPart=true;");
      try { assert.throws(verifyClone, /dirty/i); }
      finally { fs.rmSync(injected, { force: true }); }
    });
    check("ignored-but-runtime-loadable original editor source cannot evade HEAD pin", () => {
      // `git status` deliberately hides ignored files, yet the native editor
      // may import them by relative path. .git/info/exclude is untracked
      // checkout metadata, so this adds an ignore rule without dirtying the
      // working tree itself.
      const injected = path.join(clone, "apps/docs/src/renderer/.extra-plugin.ts");
      const exclude = path.join(clone, ".git/info/exclude");
      const savedExclude = fs.readFileSync(exclude);
      put(injected, "export const injector = true;");
      fs.appendFileSync(exclude, "\napps/docs/src/renderer/.extra-plugin.ts\n");
      try {
        assert.throws(verifyClone, /ignored|untracked|dirty/i);
      } finally {
        fs.rmSync(injected, { force: true });
        fs.writeFileSync(exclude, savedExclude);
      }
    });
    check("missing one renderer source root is not six-app provenance", () => {
      const dir = path.join(clone, "apps/html/src/renderer");
      const saved = path.join(base, "saved-html-renderer");
      fs.cpSync(dir, saved, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      try { assert.throws(verifyClone, /dirty|html|renderer/i); }
      finally { fs.cpSync(saved, dir, { recursive: true }); }
    });
    check("missing notice cannot pass upstream source gate", () => {
      const file = path.join(clone, "NOTICE");
      const saved = fs.readFileSync(file);
      fs.rmSync(file);
      try { assert.throws(verifyClone, /dirty|NOTICE|missing/i); }
      finally { fs.writeFileSync(file, saved); }
    });
    check("clean fixture clone verifies again after every restoration", () => {
      assert.equal(git(clone, "status", "--porcelain", "--untracked-files=all"), "");
      assert.equal(verifyClone().revision, FINAL_REVISION);
    });
    check("real GenOffice vendor checkout was not modified", () => {
      assert.equal(git(vendorReal, "rev-parse", "HEAD"), realHead);
      assert.equal(git(vendorReal, "status", "--porcelain", "--untracked-files=all"), realHeadStatus);
    });
  }

  console.log("genoffice-source-smoke: " + count + "/" + count + " PASS" + (vendorPresent ? "" : " (section C skipped: vendor absent)"));
} finally { fs.rmSync(base, { recursive: true, force: true }); }
