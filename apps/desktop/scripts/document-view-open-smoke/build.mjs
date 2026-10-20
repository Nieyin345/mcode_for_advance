/**
 * 【ARC-007 P0】指定文件打开协议闭环 —— 真 Electron 启动器。
 *
 * 真 vendor docs 构建产物 + **生产** `documentViewPreload.ts` + 真
 * `DocumentViewHost`。fixture 的 docx 用 vendor `buildBlankDocx()` 生成再注入
 * 唯一文本（esbuild alias 到 genoffice 源码）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// 本套件把生产 preload 与打开链宿主原样打包进真 Electron。
// @smoke-covers src/main/document/documentViewPreload.ts
// @smoke-covers src/main/document/documentViewHost.ts

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = resolve(desktop, "../..");
const vendorRoot = join(repoRoot, "genoffice");
const pagePath = join(vendorRoot, "apps", "docs", "out", "renderer", "index.html");
// 【ARC-007 P1/GA1】slides 真机段：真实 slides 构建产物（缺失时探针如实跳过该段）。
const slidesPagePath = join(vendorRoot, "apps", "slides", "out", "renderer", "index.html");

if (process.argv.length > 2) throw Error("Unknown test option");
if (!existsSync(pagePath)) {
  console.log(`document-view-open-smoke: skip（未构建：${pagePath}）`);
  process.exit(0);
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const { build } = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/document-view-open-"));

await build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron"],
  alias: {
    "@genoffice/docx-engine": join(vendorRoot, "packages/docx-engine/src/index.ts"),
    // pptx-ops 依赖 docx-engine 的 math 子路径（公式文本）；只 alias 包根会把
    // 子路径拼成 `<index.ts>/math`（实测 esbuild 报错）。
    "@genoffice/docx-engine/math": join(vendorRoot, "packages/docx-engine/src/math.ts"),
    // 【ARC-007 P1/GA1】生产执行器走静态 seam（见 electron.vite.config.ts 的同一条
    // 别名）；本套件与生产同一条判据：快照在场 → 真实现。
    "@main/document/slidesVendorModules.js": join(
      desktop,
      "src/main/document/slidesVendorModules.ts",
    ),
    // 与 electron.vite.config.ts 的 slidesVendorAliases() 同一组（vendor 子路径
    // 导出，esbuild 的「包根别名 + 子路径」拼接会解析失败 —— 实测）。
    "@genoffice/pptx-engine": join(vendorRoot, "packages/pptx-engine/src/index.ts"),
    "@genoffice/pptx-engine/table-grid": join(vendorRoot, "packages/pptx-engine/src/table-grid.ts"),
    "@genoffice/pptx-engine/identity": join(vendorRoot, "packages/pptx-engine/src/identity.ts"),
    "@genoffice/pptx-engine/custgeom": join(vendorRoot, "packages/pptx-engine/src/custgeom.ts"),
    "@genoffice/pptx-engine/background-promote": join(vendorRoot, "packages/pptx-engine/src/background-promote.ts"),
    "@genoffice/pptx-render": join(vendorRoot, "packages/pptx-render/src/index.ts"),
    "@genoffice/pptx-ops": join(vendorRoot, "packages/pptx-ops/src/index.ts"),
    "@genoffice/agent-core/redact-range": join(vendorRoot, "packages/agent-core/src/redact-range.ts"),
    // 真 DocumentViewHost 的默认窗口解析器会拖进原生模块；探针显式注入窗口。
    "@main/window.js": join(suite, "../document-view-electron-smoke/stubs/window.ts"),
  },
  nodePaths: [join(vendorRoot, "node_modules")],
  loader: { ".md": "text", ".wasm": "dataurl", ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl" },
});
await build({
  entryPoints: [join(desktop, "src/main/document/documentViewPreload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "documentViewPreload.js"),
  logLevel: "error",
  external: ["electron"],
  alias: {
    "@main/document/docsVendorPreload.js": existsSync(join(resolve(desktop, "../.."), "genoffice/apps/docs/src/preload/mcode-view.ts"))
      ? join(resolve(desktop, "../.."), "genoffice/apps/docs/src/preload/mcode-view.ts")
      : join(desktop, "src/main/document/docsVendorPreload.ts"),
  },
});

copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify(
    {
      pagePath,
      slidesPagePath: existsSync(slidesPagePath) ? slidesPagePath : "",
      preloadPath: join(dir, "documentViewPreload.js"),
      waitMs: 10000,
      urlSuffix: "?mode=tab",
    },
    null,
    2,
  ),
);

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) throw Error("Existing installed Electron binary required");

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  MCODE_DV_OPEN_DIR: dir,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(dir, "userData"),
  LOCALAPPDATA: join(dir, "localAppData"),
  TEMP: temp,
  TMP: temp,
};
delete env.ELECTRON_RUN_AS_NODE;

const run = spawnSync(electron, [join(dir, "electron-host.cjs")], {
  cwd: desktop,
  env,
  encoding: "utf8",
  timeout: 180000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = (run.stdout ?? "") + (run.stderr ?? "");
writeFileSync(join(dir, "run.log"), output);
process.stdout.write(output);

let checks = [];
try {
  checks = JSON.parse(readFileSync(join(dir, "checks.json"), "utf8"));
} catch {
  checks = [];
}
const failed = checks.filter((c) => c.status !== "PASS");
// 断言条数下限钉住（当前 26 条：P0 15 + P1/slides 11），防探针提前崩退只写了一半。
const complete = checks.length >= 26 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`DOCUMENT VIEW OPEN PROTOCOL FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`document-view-open-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过（打开协议闭环）`);
}
