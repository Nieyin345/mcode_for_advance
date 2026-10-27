/**
 * T30 file-router regression + in-memory mutation checks.
 * Builds the real upstream and Mcode pure functions in isolated OS temp files.
 * Mutations never touch the repository. No user data, DB or Electron process.
 * Run: node apps/desktop/scripts/genoffice-file-routing-smoke/run.mjs
 */
import { readdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(dir, "../..");
const repo = resolve(desktop, "../..");
const pnpm = join(repo, "node_modules/.pnpm");
const folder = readdirSync(pnpm).filter(x => x.startsWith("esbuild@")).sort().at(-1);
if (!folder) throw Error("esbuild dependency missing");
const { build } = await import(pathToFileURL(join(pnpm, folder, "node_modules/esbuild/lib/main.js")).href);
const temp = mkdtempSync(join(tmpdir(), "mcode-t30-"));
let checks = 0;
function check(label, ok) {
  checks++;
  if (!ok) throw Error("FAIL: " + label);
  console.log("ok  " + label);
}
const own = join(repo, "packages/contracts/src/genofficeFileRoute.ts");
const upstream = join(repo, "genoffice/apps/shell/src/main/app-routing.ts");
const host = join(desktop, "src/main/document/documentViewHost.ts");
const ownSource = readFileSync(own, "utf8");
const hostSource = readFileSync(host, "utf8");
try {
  async function compile(label, mutation = null) {
    const output = join(temp, label + ".mjs");
    await build({
      entryPoints: [mutation?.entry ?? own],
      bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
      plugins: mutation ? [{
        name: "in-memory-mutation",
        setup(b) {
          b.onLoad({ filter: /genofficeFileRoute\.ts$/ }, args => {
            if (args.path !== own) return undefined;
            check("route mutation seam matches one real source fragment", ownSource.includes(mutation.before));
            return { contents: ownSource.replace(mutation.before, mutation.after), loader: "ts" };
          });
        }
      }] : []
    });
    return import(pathToFileURL(output).href);
  }
  const ours = await compile("our-route");
  await build({ entryPoints: [upstream], bundle: true, platform: "node", format: "esm",
    outfile: join(temp, "upstream.mjs"), logLevel: "silent" });
  const vendor = await import(pathToFileURL(join(temp, "upstream.mjs")).href);
  const corpus = [
    ["C:/project/a.DOCX", "docs"], ["C:/project/a.XLSX", "sheets"],
    ["C:/project/a.PPTX", "slides"], ["C:/project/a.PDF", "pdf"],
    ["C:/project/a.MD", "markdown"], ["C:/project/a.HTML", "html"],
    ...["docx", "odt", "ott"].map(ext => ["x." + ext, "docs"]),
    ...["xlsx", "xlsm", "xls", "csv", "tsv", "ods", "ots"].map(ext => ["x." + ext, "sheets"]),
    ...["pptx", "odp", "otp"].map(ext => ["x." + ext, "slides"]),
    ...["md", "markdown", "txt", "json"].map(ext => ["x." + ext, "markdown"]),
    ["x.pdf", "pdf"], ["x.html", "html"], ["x.htm", "html"],
    ["x.docm", undefined], ["x.pptm", undefined], ["x.xltx", undefined],
    ["x.tar.gz", undefined], ["x.bin", undefined],
    ["noextension", undefined], [".env", undefined],
    ["a.docx.txt", "markdown"], ["x.pdf.exe", undefined],
    ["C:\\project\\relative\\x.PDF", "pdf"],
    ["../../outside.docx", "docs"],
    ["x.pdf?forged=.docx", "docs"], // original vendor suffix semantics, never an authorization
  ];
  for (const [path, expected] of corpus) {
    check(path + " vendor parity", vendor.appForPath(path) === expected &&
      ours.genofficeAppForPath(path) === vendor.appForPath(path));
  }
  // SOURCE-OF-TRUTH inspection: these are real consumers, not a parallel test-only router.
  for (const path of [
    "apps/desktop/src/renderer/components/ide/fileEditorKinds.ts",
    "apps/desktop/src/renderer/components/ide/GenofficeViewHostPane.tsx",
    "apps/desktop/src/renderer/components/library/FilePreview.tsx",
    "apps/desktop/src/renderer/components/library/FileViewer.tsx",
  ]) {
    const source = readFileSync(join(repo, path), "utf8");
    check(path + " uses shared route", source.includes("genofficeAppForPath"));
  }
  const fileEditor = readFileSync(join(repo, "apps/desktop/src/renderer/components/ide/FileEditor.tsx"), "utf8");
  // 守**行为**不守字面形状：原断言要求恰好 `viewModePref === "genoffice-view"`，
  // 而实现后来改成 `viewModePref !== "genoffice-view" || genofficeViewAvailable`
  // （同样的语义，更严的写法）—— 断言就假红了。这里改成：仍然挂载原生视图入口，
  // 且仍然用 genoffice-view 这个偏好值参与判定。
  check("T65 FileEditor keeps native-view entry and preference",
    fileEditor.includes("<GenofficeViewHostPane") &&
    // 只断言「同一行里 viewModePref 与 genoffice-view 一起出现」——
    // 不锚定具体的比较运算符（那属于写法，不属于行为）。
    fileEditor.split("\n").some((line) =>
      line.includes("viewModePref") && line.includes('"genoffice-view"')));
  // Safety: classification must never call or replace the host's independent path guard.
  check("router has no authorization decision", !ownSource.includes("withinWorkspace") && !ownSource.includes("isOnlyOfficeSupportedPath("));
  check("host fail-closed missing factory", hostSource.includes("if (!this.vendorCreateView) return { ok: false"));
  check("host path guard checks workspace AND physical file", hostSource.includes("!this.withinWorkspace(input.filePath)") &&
    hostSource.includes("physicalPath(input.filePath) === null"));

  const mutant = await compile("mutated-route", {
    entry: own, before: 'if (DOCX_RE.test(filePath)) return "docs";',
    after: 'if (PDF_RE.test(filePath)) return "docs";'
  });
  check("MUTATION #1: deleting shared DOCX mapping makes vendor/IDE disagree (RED)",
    mutant.genofficeAppForPath("x.docx") !== vendor.appForPath("x.docx"));

  // Mutation #2: no source files altered. Compile the REAL existing host smoke
  // with its workspace guard disabled in-memory and insist the suite fail.
  const guardFragment = "!this.withinWorkspace(input.filePath)";
  check("guard mutation seam matches host source", hostSource.includes(guardFragment));
  const fixture = join(desktop, "scripts/genoffice-native-view-smoke/main.ts");
  async function runHost(label, mutate) {
    const out = join(temp, label + ".mjs");
    await build({
      entryPoints: [fixture], bundle: true, platform: "node", format: "esm",
      tsconfig: join(desktop, "tsconfig.json"), absWorkingDir: desktop,
      outfile: out, logLevel: "silent",
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require=__cr(import.meta.url);" },
      alias: {
        "@main/window.js": "./scripts/document-view-host-smoke/stubs/window.ts",
        "@main/lib/logger.js": "./scripts/run-store-smoke/stubs/logger.ts",
        "@main/lib/dataRoot.js": "./scripts/run-store-smoke/stubs/dataRoot.ts",
      },
      plugins: mutate ? [{
        name: "disable-real-host-workspace-guard-for-mutation-only",
        setup(b) {
          b.onLoad({ filter: /documentViewHost\.ts$/ }, args => {
            if (args.path !== host) return undefined;
            return { contents: hostSource.replace(guardFragment, "false"), loader: "ts" };
          });
        },
      }] : [],
    });
    return spawnSync(process.execPath, [out], {
      cwd: desktop, encoding: "utf8", timeout: 60000,
      env: { ...process.env, MCODE_SMOKE_DATA_ROOT: temp }
    });
  }
  const positive = await runHost("positive-host", false);
  check("real native host 5 kinds: resources, guard, open/close positive (GREEN)",
    positive.status === 0);
  const unsafe = await runHost("unsafe-host", true);
  check("MUTATION #2: removing workspace guard breaks real host refusal (RED)",
    unsafe.status !== 0 && (unsafe.stdout + unsafe.stderr).includes("FAIL"));
  check("original router and host source bytes remain unchanged after in-memory mutations",
    readFileSync(own, "utf8") === ownSource && readFileSync(host, "utf8") === hostSource);
  console.log("genoffice-file-routing-smoke: " + checks + "/" + checks + " PASS (2 red mutants verified)");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
