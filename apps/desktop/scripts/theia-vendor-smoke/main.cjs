"use strict";
/**
 * F022: the Theia vendor checkout is a real, buildable, modifiable git source
 * tree — not an npm package and not a read-only copy.
 *
 * ## Why this suite exists
 *
 * F017 proved `@theia/plugin-ext` (the npm package) can be loaded inside
 * Electron. F022 is the step before "adapt Theia to Mcode": if we cannot
 * change Theia's *source* and observe the change in the built artifact, every
 * later adaptation is built on sand. This suite pins the four properties that
 * make source modification real:
 *
 *   1. the checkout exists and carries the upstream license files;
 *   2. HEAD / tree / tag identity equal `vendor/theia.lock.json`;
 *   3. `@theia/plugin-ext` builds and its output is require-able;
 *   4. **change → build → runtime value changes → revert → build → value
 *      returns** (the five-step chain from the card), read via `require()`,
 *      never via `grep` alone — a `grep` cannot tell source from artifact.
 *
 * ## What is NOT asserted here
 *
 * - The Theia plugin *host* process (5-channel fork, MessagePack handshake):
 *   that is F017 §2/§3 territory and needs product wiring this card forbids.
 * - The `@lumino/widgets` patch from upstream `postinstall` (`theia-patch`):
 *   we build with `--ignore-scripts` because this machine has no VS C++
 *   toolchain; the patch only affects browser UI menu events, not the
 *   extension host. Recorded in `vendor/README.md`.
 * - `patches/theia/` consistency: the patch series is empty (this card writes
 *   no Mcode adaptation). When the first patch lands, the lock file grows a
 *   `patchSeries` entry and this suite must grow the matching assertion
 *   (GenOffice's `verify-genoffice-upstream.cjs` is the field template).
 *
 * ## Skipping
 *
 * `vendor/theia` is a nested checkout not fetched by CI (same as `genoffice/`).
 * When absent, every section prints explicit skip lines and the suite exits 0
 * — it never pretends to have verified anything. When the *build output* is
 * absent the suite rebuilds once (about 45 s cold); the rebuild is part of
 * section 4's chain anyway, so it is not a hidden cost.
 *
 * ## Runtime
 *
 * The chain rebuilds twice (mutated and reverted), ~10 s each incremental.
 * Budget the suite's runner timeout (default 240 s in run-smokes.mjs) around
 * that; a cold run additionally pays the ~45 s initial build.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const VENDOR = path.join(REPO_ROOT, "vendor", "theia");
const LOCK_FILE = path.join(REPO_ROOT, "vendor", "theia.lock.json");
const PATCHES_DIR = path.join(REPO_ROOT, "patches", "theia");
const PLUGIN_EXT = path.join(VENDOR, "packages", "plugin-ext");
const LIB = path.join(PLUGIN_EXT, "lib");
const TSC = path.join(VENDOR, "node_modules", "typescript", "bin", "tsc");

// The card's marker: a module-local constant that only the compiled artifact
// exposes at runtime. Chosen because `PluginIdentifiers` is exported by the
// package entry (`lib/common/index.js` re-exports it) and neither the literal
// nor the mutation needs any DI container.
const MARKER_SOURCE = path.join(PLUGIN_EXT, "src", "common", "plugin-identifiers.ts");
const MARKER_MODULE = path.join(LIB, "common", "plugin-identifiers.js");
const MARKER_LINE = "    export const UNPUBLISHED = '<unpublished>';";
const MUTATED_VALUE = "<unpublished-mcode-f022>";
const MARKER_COMMENT = "// [MCODE] F022 verification marker — temporary, reverted after the proof.";

let total = 0;
let failures = 0;
function check(name, cond, detail) {
  total++;
  if (cond) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}
function skip(name, why) {
  console.log("  skip " + name + " (" + why + ")");
}
function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function build() {
  execFileSync(process.execPath, [TSC, "--build", PLUGIN_EXT], {
    cwd: VENDOR, encoding: "utf8", timeout: 300000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
  });
}
/** Require the built module in a fresh Node process and return its runtime value. */
function readRuntimeValue() {
  const code = "const m=require(process.argv[1]);"
    + "process.stdout.write(JSON.stringify({value:m.PluginIdentifiers.UNPUBLISHED,"
    + "derived:m.PluginIdentifiers.componentsToUnversionedId({name:'probe'})}));";
  const out = execFileSync(process.execPath, ["-e", code, MARKER_MODULE], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
  });
  return JSON.parse(out);
}
function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  let vendorPresent = false;
  try {
    vendorPresent = fs.statSync(VENDOR).isDirectory() && fs.existsSync(path.join(VENDOR, "package.json"));
  } catch { vendorPresent = false; }

  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));

  // ---- Section 1: lock file is self-consistent and names the pinned identity.
  check("lock format is mcode.theia.upstream-lock.v1", lock.format === "mcode.theia.upstream-lock.v1", lock.format);
  check("lock repository is the upstream git repo, not an npm registry",
    lock.repository === "https://github.com/eclipse-theia/theia", lock.repository);
  check("lock revision is a commit, not a tag object",
    /^[0-9a-f]{40}$/.test(lock.revision ?? "") && lock.revision === "d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649", lock.revision);
  check("lock records the tag object separately from the commit",
    lock.tagObject === "12f62a6bdafe275e87507d6b4984dd5e99fc61a0" && lock.tag === "v1.76.0",
    { tag: lock.tag, tagObject: lock.tagObject });
  check("lock pins the final tree",
    /^[0-9a-f]{40}$/.test(lock.expectedTree ?? ""), lock.expectedTree);
  check("lock declares the EPL-2.0 branch and plugin-ext as the build target",
    lock.chosenLicense === "EPL-2.0" && lock.buildTarget === "@theia/plugin-ext",
    { chosenLicense: lock.chosenLicense, buildTarget: lock.buildTarget });

  // ---- Section 2: the checkout exists, is the pinned state, and is clean.
  if (!vendorPresent) {
    skip("vendor checkout exists", "vendor/theia absent");
    skip("HEAD equals the pinned revision", "vendor/theia absent");
    skip("tree equals the pinned tree", "vendor/theia absent");
    skip("tag v1.76.0 dereferences to the pinned commit", "vendor/theia absent");
    skip("checkout has no unrecorded changes", "vendor/theia absent");
    skip("license files present and non-empty", "vendor/theia absent");
    skip("LICENSE-EPL is the Eclipse Public License 2.0", "vendor/theia absent");
    skip("upstream source files exist (git checkout, not npm tarball)", "vendor/theia absent");
  } else {
    check("vendor checkout exists", true);
    const head = git(VENDOR, "rev-parse", "HEAD");
    check("HEAD equals the pinned revision", head === lock.revision, { head, pinned: lock.revision });
    const tree = git(VENDOR, "rev-parse", "HEAD^{tree}");
    check("tree equals the pinned tree", tree === lock.expectedTree, { tree, pinned: lock.expectedTree });
    const tagCommit = git(VENDOR, "rev-parse", "v1.76.0^{}");
    check("tag v1.76.0 dereferences to the pinned commit", tagCommit === lock.revision, { tagCommit });
    const tagIsObject = git(VENDOR, "cat-file", "-t", "v1.76.0") === "tag";
    check("v1.76.0 is an annotated tag object (the ^{} form is load-bearing)", tagIsObject);

    const dirty = git(VENDOR, "status", "--porcelain", "--untracked-files=all");
    check("checkout has no unrecorded changes (every modification must be a patch)",
      dirty === "", dirty.slice(0, 300));

    for (const name of lock.licenseFiles) {
      const file = path.join(VENDOR, name);
      check("license file present and non-empty: " + name,
        fs.existsSync(file) && fs.statSync(file).size > 0, file);
    }
    // Content checks read defensively: a deleted license must produce its own
    // red line, not kill the run (a mutation that throws looks like ERROR, not
    // like the failed assertion it is).
    let epl = "";
    let notice = "";
    try { epl = fs.readFileSync(path.join(VENDOR, "LICENSE-EPL"), "utf8"); } catch { /* red below */ }
    try { notice = fs.readFileSync(path.join(VENDOR, "NOTICE.md"), "utf8"); } catch { /* red below */ }
    check("LICENSE-EPL is the Eclipse Public License v2.0", /Eclipse Public License - v 2\.0/.test(epl));
    check("NOTICE.md names Eclipse Theia", /Eclipse Theia/.test(notice));

    // npm packages of @theia/plugin-ext ship src/ but no LICENSE and no
    // build config (F017 §"不要用 npm 包"). Assert the git-only properties:
    const pluginExtPkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_EXT, "package.json"), "utf8"));
    check("plugin-ext is a workspace package in the monorepo, not a node_modules copy",
      pluginExtPkg.name === "@theia/plugin-ext" && pluginExtPkg.version === "1.76.0", pluginExtPkg.version);
    check("plugin-ext has a build script (npm packages do not)",
      typeof pluginExtPkg.scripts?.build === "string" && pluginExtPkg.scripts.build === "theiaext build",
      pluginExtPkg.scripts?.build);
    check("plugin-ext tsconfig uses project references (git source layout)",
      Array.isArray(JSON.parse(fs.readFileSync(path.join(PLUGIN_EXT, "tsconfig.json"), "utf8")).references));
  }

  // ---- Section 3: the build artifact exists and is require-able.
  if (!vendorPresent) {
    skip("build artifact exists", "vendor/theia absent");
    skip("build artifact is require-able", "vendor/theia absent");
  } else {
    if (!fs.existsSync(TSC)) {
      check("TypeScript compiler is installed in the vendor checkout", false, TSC);
    } else {
      if (!fs.existsSync(path.join(LIB, "common", "index.js"))) {
        console.log("  info build output absent — running the first build (~45 s cold)");
        build();
      }
      check("build artifact exists", fs.existsSync(path.join(LIB, "common", "index.js")));
      let entry = null;
      try {
        entry = require(path.join(PLUGIN_EXT));
      } catch (error) {
        check("build artifact is require-able", false, error instanceof Error ? error.message : String(error));
      }
      if (entry) {
        check("build artifact is require-able", true);
        check("package entry exposes emptyPlugin (compiled from src/common/plugin-api-rpc.ts)",
          entry.emptyPlugin?.model?.id === "emptyPlugin", entry.emptyPlugin?.model?.id);
        check("PluginIdentifiers is exported through the package entry",
          typeof entry.PluginIdentifiers?.componentsToUnversionedId === "function");
      }
    }
  }

  // ---- Section 4: the five-step chain. change source → build → runtime value
  // changes → revert → build → value returns. `require()` reads, never grep.
  if (!vendorPresent || !fs.existsSync(TSC) || !fs.existsSync(MARKER_MODULE)) {
    skip("five-step chain", "vendor checkout, compiler, or build artifact absent");
  } else {
    const sourceBaseline = sha256File(MARKER_SOURCE);
    const baseline = readRuntimeValue();
    check("step 1: baseline runtime value is the upstream literal",
      baseline.value === "<unpublished>" && baseline.derived === "<unpublished>.probe", baseline);
    // The marker must be unique in source; a second occurrence means the
    // mutation could edit the wrong line and still "pass".
    const sourceText = fs.readFileSync(MARKER_SOURCE, "utf8");
    check("marker line occurs exactly once in source", sourceText.split(MARKER_LINE).length === 2,
      sourceText.split(MARKER_LINE).length - 1);

    let stepError = null;
    let step4 = null;
    try {
      // Step 2: mutate the source (the only place the marker literal lives).
      const mutated = sourceText.replace(MARKER_LINE,
        "    " + MARKER_COMMENT + "\n    export const UNPUBLISHED = '" + MUTATED_VALUE + "';");
      fs.writeFileSync(MARKER_SOURCE, mutated, "utf8");

      // Step 3: rebuild.
      build();

      // Step 4: the built artifact's runtime value is the new one.
      step4 = readRuntimeValue();
    } catch (error) {
      stepError = error;
    } finally {
      // Every step logs exactly once even when an earlier one threw; a check
      // that silently never runs reads like a pass (rule: skipped ≠ passed).
      check("step 4: runtime value changed to the mutated literal",
        step4 !== null && step4.value === MUTATED_VALUE && step4.derived === MUTATED_VALUE + ".probe",
        step4 ?? (stepError instanceof Error ? stepError.message : String(stepError)));
      // Step 5: revert byte-for-byte, rebuild, and prove the value returned.
      // `git checkout --` would also restore CRLF (core.autocrlf=true on this
      // machine), so compare the *hash* with the pre-mutation source instead.
      if (fs.readFileSync(MARKER_SOURCE, "utf8") !== sourceText) {
        fs.writeFileSync(MARKER_SOURCE, sourceText, "utf8");
      }
      check("step 5a: source reverted byte-for-byte", sha256File(MARKER_SOURCE) === sourceBaseline,
        { after: sha256File(MARKER_SOURCE), before: sourceBaseline });
      let restored = null;
      try {
        build();
        restored = readRuntimeValue();
      } catch (error) {
        stepError = stepError ?? error;
      }
      check("step 5b: runtime value returned to the upstream literal",
        restored !== null && restored.value === "<unpublished>" && restored.derived === "<unpublished>.probe",
        restored ?? (stepError instanceof Error ? stepError.message : String(stepError)));
    }
    check("five-step chain completed without throwing", stepError === null,
      stepError === null ? undefined : (stepError instanceof Error ? stepError.message : String(stepError)));
  }

  // ---- Section 5: the patch series is empty *and* the checkout is clean.
  // An empty `patches/theia/` is only honest if the diff is also empty; a
  // modification smuggled into vendor/ would otherwise pass unnoticed.
  if (!vendorPresent) {
    skip("patch series empty while checkout is clean", "vendor/theia absent");
  } else {
    const patchFiles = fs.existsSync(PATCHES_DIR)
      ? fs.readdirSync(PATCHES_DIR).filter(name => name.endsWith(".patch")).sort()
      : [];
    check("lock patchSeries matches patches/theia/ on disk",
      JSON.stringify(lock.patchSeries.map(entry => path.basename(entry.file))) === JSON.stringify(patchFiles),
      { lock: lock.patchSeries.map(entry => path.basename(entry.file)), disk: patchFiles });
    if (lock.patchSeries.length === 0) {
      const dirty = git(VENDOR, "status", "--porcelain", "--untracked-files=all");
      check("no patches recorded therefore no uncommitted source changes", dirty === "", dirty.slice(0, 300));
    } else {
      for (const entry of lock.patchSeries) {
        const file = path.resolve(REPO_ROOT, entry.file);
        check("patch exists with pinned bytes and sha256: " + entry.file,
          fs.existsSync(file) && fs.statSync(file).size === entry.bytes && sha256File(file) === entry.sha256,
          entry.file);
      }
    }
  }

  console.log("theia-vendor-smoke: " + (total - failures) + "/" + total + " 通过"
    + (vendorPresent ? "" : " (vendor 缺失: 仅锁文件断言，未验证源码/构建)"));
  return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  // A thrown error (missing git, unreadable lock) is a failure, never a skip.
  console.error("theia-vendor-smoke: ERROR " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
