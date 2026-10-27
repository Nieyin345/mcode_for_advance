/**
 * T23 gap A: the production build must actually emit the document view preload.
 *
 * ## The defect this suite covers
 *
 * `documentViewHost.ts` (resolveViewPreload) hands a sandboxed WebContentsView
 * `join(__dirname, "documentViewPreload.js")` — i.e. `out/main/documentViewPreload.js`
 * next to the bundled main entry. The four `document-view-*` suites each
 * esbuild that TS file into their own probe directory, so they stayed green
 * while `electron-vite build` never declared the entry at all (verified: no
 * `documentViewPreload` in electron.vite.config.ts across 22 revisions, and a
 * real `pnpm build` produced no such file). Packaged Docs views therefore lost
 * `window.desktop` and unmounted (T13 §2 发现 A).
 *
 * ## What is asserted here
 *
 * 1. The *production* config (electron.vite.config.ts, loaded through
 *    electron-vite's own resolveConfig — same code path `electron-vite build`
 *    uses) declares `documentViewPreload` as a preload entry pointing at
 *    `src/main/document/documentViewPreload.ts`.
 * 2. Building that preload section with the production plugins emits a CJS
 *    `documentViewPreload.js` **next to the main bundle** (not in
 *    `out/preload/`), containing `require("electron")` and the slides bridge —
 *    the exact shape `documentViewHost.ts` loads. No ESM twin is left behind.
 * 3. The four Electron suites and the production config read the same source
 *    file, so a future rename can't silently unbind them.
 *
 * This suite does NOT start Electron and does not replace the suites' own
 * probe bundles; it proves the *production* artifact exists.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build as viteBuild } from "vite";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const configPath = join(desktop, "electron.vite.config.ts");
const PRELOAD_SOURCE = "src/main/document/documentViewPreload.ts";

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

const out = mkdtempSync(join(tmpdir(), "mcode-production-build-preload-"));
try {
  process.chdir(desktop);
  process.env.NODE_ENV_ELECTRON_VITE = "production";
  const resolved = await resolveConfig({ configFile: configPath, root: desktop, logLevel: "error" }, "build", "production");
  const preload = resolved.config?.preload;
  check("production config loads a preload section", Boolean(preload && preload.build?.lib));
  if (!preload) throw new Error("production preload config missing");

  const entry = preload.build.lib.entry;
  check("production preload entry is a named entry map", entry && typeof entry === "object" && !Array.isArray(entry), entry);
  check("production preload declares documentViewPreload", entry?.documentViewPreload === PRELOAD_SOURCE, entry);
  check("documentViewPreload source file exists", existsSync(join(desktop, PRELOAD_SOURCE)));
  // Main-window preloads must not regress while adding the view entry.
  check("main window preload entry retained", entry?.index === "src/preload/index.ts", entry);
  check("browser picker preload entry retained", entry?.browserPicker === "src/preload/browserPicker.ts", entry);

  // The host loads `join(__dirname, "documentViewPreload.js")` from the main
  // bundle. Bind that expectation to the emitted file name.
  const hostSource = readFileSync(join(desktop, "src/main/document/documentViewHost.ts"), "utf8");
  check("host resolves documentViewPreload.js from its own __dirname",
    hostSource.includes('join(__dirname, "documentViewPreload.js")'));

  // Build the production preload section into a throwaway outDir. The output
  // plugin derives the view preload's target from options.dir's sibling
  // `main/`, so this exercises the same emit path a real build uses.
  const outDir = join(out, "preload");
  mkdirSync(outDir, { recursive: true });
  await viteBuild({
    ...preload,
    logLevel: "error",
    build: { ...preload.build, outDir, emptyOutDir: true },
  });

  const emitted = join(out, "main", "documentViewPreload.js");
  check("production preload build emits out/main/documentViewPreload.js", existsSync(emitted), emitted);
  if (existsSync(emitted)) {
    const code = readFileSync(emitted, "utf8");
    check("emitted view preload is CommonJS (sandbox preloads cannot be ESM)", !/^\s*(?:import|export)\s/m.test(code));
    check("emitted view preload requires electron", code.includes('require("electron")') || code.includes("require('electron')"));
    /* 【2026-10-28 反向】**产物里不该再出现 `slidesApi`。**
     *
     * 原断言是 `code.includes("slidesApi")` —— 守「产物装上了 slides 桥」。
     * 而那份手写的 `window.slidesApi` 最小桥已在 2026-10-26 删除
     *（`documentViewPreload.ts:389` 记了理由：六种编辑器走 vendor 工厂，
     *  vendor 自己的 `out/preload/index.js` 建 `window.slidesApi`；本文件只在
     *  `kind === null` 的普通文档视图里挂，那份桥永远走不到）。
     *
     * 于是这条长期红着，红因写着「产物没装上 slides 桥」，看起来像构建漏了一步
     * —— 实际是**被测对象已经不在了**。
     *
     * 改成反向：如果它重新出现，说明有人把那份死代码加回来了，这一条会提醒他
     * 先想清楚「哪条路会走到它」。 */
    check("emitted view preload does NOT reinstall a hand-written slidesApi bridge", !code.includes("slidesApi"));
    const variant = existsSync(join(desktop, "../../genoffice/apps/docs/src/preload/mcode-view.ts")) ? "vendor" : "stub";
    check(`emitted view preload carries the ${variant} Docs bridge`,
      variant === "vendor"
        ? code.includes("installMcodeDocsViewPreload") && code.includes("mcode:docs:ai-tool-result")
        : code.includes("installMcodeDocsViewPreload"));
  }
  check("no ESM documentViewPreload twin in out/preload",
    !existsSync(join(out, "preload", "documentViewPreload.mjs")));
  const preloadFiles = existsSync(join(out, "preload")) ? readdirSync(join(out, "preload")).sort() : [];
  check("out/preload keeps the main and picker bundles", preloadFiles.includes("index.mjs") && preloadFiles.includes("browserPicker.mjs"), preloadFiles);

  // Bind each Electron suite's own esbuild step to the same production source:
  // the suites may keep their private bundles, but they must package the same
  // file the production entry declares.
  const suites = [
    "document-view-electron-smoke",
    "document-view-open-smoke",
    "document-view-vendor-page-smoke",
    "genoffice-ai-ask-smoke",
  ];
  for (const name of suites) {
    const buildFile = join(desktop, "scripts", name, "build.mjs");
    if (!existsSync(buildFile)) {
      check(`${name} build script exists`, false, buildFile);
      continue;
    }
    const source = readFileSync(buildFile, "utf8");
    check(`${name} bundles the same documentViewPreload source`, source.includes(PRELOAD_SOURCE));
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`production-build-preload-smoke: ${total - failures}/${total} ${failures === 0 ? "PASS" : "FAIL"}`);
if (failures > 0) process.exitCode = 1;
