/**
 * 【ARC-007 / GenOffice slides 编辑】真 Electron 启动器。
 *
 * 与 document-view-vendor-page-smoke 同一形态，但有两点不同（原因见 probe.ts）：
 *  1. preload 用 **vendor 自己的** `genoffice/apps/slides/src/preload/index.ts`
 *     （全量 `slidesApi`）—— 编辑操作全在 vendor 主进程会话里，只补空桩等于伪造；
 *  2. 主进程探针直接 `require` **vendor 主进程** `slides-main.ts` 并调
 *     `registerSlidesIpc()` —— 编辑/保存/重开走真实现（真 pptx zip 操作）。
 *
 * vendor 包由 esbuild alias + nodePaths 解析（genoffice/node_modules 是指向源码的
 * symlink；assets `.wasm/.ttf/.md` 用 loader 内联）。产物缺失时如实 skip（exit 0）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = resolve(desktop, "../..");
const vendorRoot = join(repoRoot, "genoffice");
const pagePath = join(vendorRoot, "apps", "slides", "out", "renderer", "index.html");
const slidesPreload = join(vendorRoot, "apps", "slides", "src", "preload", "index.ts");

if (process.argv.length > 2) throw Error("Unknown test option");

if (!existsSync(pagePath) || !existsSync(slidesPreload)) {
  console.log(`slides-edit-smoke: skip（未构建：${pagePath}）`);
  process.exit(0);
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const { build } = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

/** vendor 源码里带 `?raw` / `?asset` 的资产，esbuild 用 loader 内联。 */
const loader = {
  ".md": "text",
  ".wasm": "dataurl",
  ".ttf": "dataurl",
  ".otf": "dataurl",
  ".png": "dataurl",
  ".woff": "dataurl",
  ".woff2": "dataurl",
};

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/slides-edit-"));

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
    // 真 vendor slides 主进程（编辑/保存/打开的唯一实现）。
    "@genoffice/slides-main": join(vendorRoot, "apps/slides/src/main/slides-main.ts"),
  },
  nodePaths: [join(vendorRoot, "node_modules")],
  loader,
});
await build({
  entryPoints: [slidesPreload],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(vendorRoot, "apps/slides/tsconfig.json"),
  absWorkingDir: vendorRoot,
  outfile: join(dir, "slidesPreload.js"),
  logLevel: "error",
  external: ["electron"],
  nodePaths: [join(vendorRoot, "node_modules")],
  loader,
});

copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify(
    {
      pagePath,
      preloadPath: join(dir, "slidesPreload.js"),
      waitMs: 10000,
      urlSuffix: "?mode=tab",
    },
    null,
    2,
  ),
);

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  MCODE_SLIDES_EDIT_DIR: dir,
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
// 10 条（probe.ts 逐条写）；下限钉住，防空转。
const complete = checks.length >= 10 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`SLIDES EDIT FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`slides-edit-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过（真实 vendor slides 编辑）`);
}
