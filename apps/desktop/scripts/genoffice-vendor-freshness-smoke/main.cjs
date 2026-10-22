"use strict";
/**
 * T25: the six vendored GenOffice renderers/preloads must be built from the
 * pinned upstream HEAD, not from an older snapshot.
 *
 * ## Why this suite exists
 *
 * T13 §2 发现 C / T23 缺口三: `genoffice/apps/*\/out/` was built 2026-10-18/19,
 * while patch 0013 (Docs ACK transport) landed 2026-10-22. The stale products
 * made every "real vendor page" validation exercise a renderer that predated the
 * reviewed source. T23 made staging fail closed on the Docs marker; this suite
 * is the pre-stage, machine-checkable freshness gate for all six apps.
 *
 * ## What is asserted (and why each leg is needed)
 *
 * 1. For every app: `out/renderer/index.html` and `out/preload/index.js` exist
 *    and are non-empty (the two products the host mounts).
 * 2. Every EMITTED build output of each app — `index.html`, `out/renderer/assets/**`,
 *    `out/preload/**` — has an mtime not older than the pinned HEAD commit time.
 *    Old products (2026-10-18/19) fail this against the 0013 commit (2026-10-22).
 *    `out/renderer/pdfjs/**` is deliberately excluded: it is a static copy of
 *    `pdfjs-dist` assets (viteStaticCopy preserves the upstream package mtimes),
 *    pinned by the lockfile rather than by the patch series, and no patch edits it.
 * 3. Docs renderer carries the two 0013 transport names (`aiToolResult`,
 *    `toolResultAck`, the same constants staging's `DOCS_ACK_MARKERS` gate uses).
 *    mtime can be faked with `touch`; this content marker cannot.
 *
 * The preload half of 0013 lives in `apps/docs/src/preload/mcode-view.ts`, which
 * vendor's own `src/preload/index.ts` never imports — Mcode's production build
 * bundles it into `out/main/documentViewPreload.js` (T23). That file is covered
 * by `production-build-preload-smoke`, not here.
 *
 * ## Skipping
 *
 * `genoffice/` is a nested checkout that CI does not fetch (like every other
 * vendor-dependent suite). When it is absent the suite prints explicit skip
 * lines and exits 0 — it never pretends to have verified anything.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DOCS_ACK_MARKERS } = require("../../build/stage-genoffice-resources.cjs");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const VENDOR = path.join(REPO_ROOT, "genoffice");
const LOCK_FILE = path.join(REPO_ROOT, "apps", "desktop", "build", "genoffice-upstream.lock.json");
const EDITORS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);

let total = 0;
let failures = 0;
function check(name, cond, detail) {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function git(args) {
  return execFileSync("git", ["-C", VENDOR, ...args], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function walkFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Emitted build outputs only: index.html, assets/**, out/preload/**. */
function emittedOutputs(appOut) {
  const files = [path.join(appOut, "renderer", "index.html")];
  const assets = path.join(appOut, "renderer", "assets");
  if (fs.existsSync(assets)) files.push(...walkFiles(assets));
  const preload = path.join(appOut, "preload");
  if (fs.existsSync(preload)) files.push(...walkFiles(preload));
  return files;
}

function readDocsRendererCorpus(appOut) {
  const renderer = path.join(appOut, "renderer");
  const html = fs.readFileSync(path.join(renderer, "index.html"), "utf8");
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(([, src]) => path.join(renderer, src));
  const assets = path.join(renderer, "assets");
  const chunks = fs.existsSync(assets)
    ? fs.readdirSync(assets).filter((name) => name.endsWith(".js")).map((name) => path.join(assets, name))
    : [];
  return [...entryScripts, ...chunks]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function main() {
  if (!fs.existsSync(VENDOR)) {
    console.log(`  skip genoffice vendor checkout absent (${VENDOR}); freshness cannot be asserted`);
    console.log("genoffice-vendor-freshness-smoke: SKIPPED (vendor checkout absent, nothing verified)");
    return 0;
  }
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  check("upstream lock identifies a pinned revision", /^[0-9a-f]{40}$/.test(lock.revision ?? ""), lock.revision);

  const head = git(["rev-parse", "HEAD"]);
  check("vendor HEAD equals the pinned lock revision", head === lock.revision, { head, pinned: lock.revision });
  // The patch timeline is the pinned commit's own timestamp — not a hard-coded
  // date — so re-pinning the upstream moves the threshold with it.
  const pinMs = Number(git(["show", "-s", "--format=%ct", lock.revision])) * 1000;
  console.log(`  info pinned revision ${lock.revision} committed at ${new Date(pinMs).toISOString()}`);

  for (const app of EDITORS) {
    const appOut = path.join(VENDOR, "apps", app, "out");
    const indexHtml = path.join(appOut, "renderer", "index.html");
    const preload = path.join(appOut, "preload", "index.js");

    check(`${app}: out/renderer/index.html exists and is non-empty`,
      fs.existsSync(indexHtml) && fs.statSync(indexHtml).size > 0, indexHtml);
    check(`${app}: out/preload/index.js exists and is non-empty`,
      fs.existsSync(preload) && fs.statSync(preload).size > 0, preload);
    if (!fs.existsSync(indexHtml) || !fs.existsSync(preload)) continue;

    const emitted = emittedOutputs(appOut);
    check(`${app}: emitted outputs were found to check`, emitted.length >= 2, emitted.length);
    let oldest = null;
    for (const file of emitted) {
      const mtime = fs.statSync(file).mtimeMs;
      if (!oldest || mtime < oldest.mtime) oldest = { file, mtime };
    }
    check(`${app}: no emitted output predates the pinned HEAD commit`,
      Boolean(oldest) && oldest.mtime >= pinMs,
      oldest && {
        oldest: path.relative(appOut, oldest.file),
        mtime: new Date(oldest.mtime).toISOString(),
        pinned: new Date(pinMs).toISOString(),
      });
  }

  const docsOut = path.join(VENDOR, "apps", "docs", "out");
  const corpus = readDocsRendererCorpus(docsOut);
  for (const marker of DOCS_ACK_MARKERS) {
    check(`docs renderer carries patch 0013 marker "${marker}"`, corpus.includes(marker));
  }
  // Guard against an empty corpus silently satisfying the loop above (the
  // "空过" failure mode): the docs bundle must be substantial.
  check("docs renderer corpus is non-trivial", corpus.length > 100000, corpus.length);

  console.log(`genoffice-vendor-freshness-smoke: ${total - failures}/${total} 通过`);
  return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  // A thrown error (missing git, unreadable lock) is a failure, never a skip.
  console.error(`genoffice-vendor-freshness-smoke: ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
