/**
 * 【ARC-007】真 Electron 加载**真实 GenOffice 编辑器页**（docs + slides）的启动器。
 *
 * ## 这一套回答的问题
 *
 * `document-view-electron-smoke` 用套件自造的最小 HTML 页验「宿主 ⇄ 页面」；
 * 它**不加载** vendor 真实编辑器（见其 probe.ts 文件头），因此证明不了
 * 「真实编辑器页在 Mcode 的最小 preload 下能挂载」。本套件补的就是这一半：
 *
 *   - 真实构建产物 `genoffice/apps/{docs,slides}/out/renderer/index.html`
 *     （`?mode=tab`，与 `editorPageUrl()` 推出的 URL 形状一致）；
 *   - **生产** `src/main/document/documentViewPreload.ts` 原样打包成 CJS preload；
 *   - 真 BrowserWindow（contextIsolation + sandbox + nodeIntegration:false，
 *     与 `documentViewHost.ts` 的视图三项安全开关逐字一致）；
 *   - CDP 挂 `Runtime.exceptionThrown`，外加页面内 `error`/`unhandledrejection` 钩子。
 *
 * ## 断言（探针写进 checks.json，启动器要求 exit 0 且全部 PASS 才算过）
 *
 * 每个页面（docs / slides）各 5 条：
 *   1. ★ `#root` 有子节点（React 没有整树卸载）；
 *   2. ★ 可见文本长度 > 0；
 *   3. ★ 出现编辑器特征（docs: `.app`/`.ribbon`/`.ProseMirror`/`.doc-page`；
 *      slides: `.app`/`.ribbon`/`canvas`/`.konvajs-content`/缩略图 任一）；
 *   4. ★ 首帧零未捕获异常（CDP 异常事件 + 页面钩子都为空）；
 *   5. ★ preload 仍未暴露 ipcRenderer / 文件对话框（源码级断言，防补齐时越界）。
 *
 * ## 隔离与不联网
 *
 * 所有 app 路径（userData/sessionData/logs/crashDumps/home/data）重指到本套件的
 * mktemp 目录；页面是本地 `file://`，只加载自身资源。**不碰 genoffice/ 源码与产物**。
 *
 * ## 产物缺失 = skip，不是 FAIL
 *
 * `genoffice/` 被 .gitignore 排除，CI/新机器上可能没有 `out/renderer`。缺失的页面
 * **逐个跳过**（打印 skip），全部缺失时整套 skip 并 exit 0 —— 与
 * `document-view-renderer-smoke` 的既有约定一致（「没构建过时如实跳过，不假装验过」）。
 * 有产物时必须全绿。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// smokes-for 的覆盖声明：本套件把这份生产 preload **原样**打包进真 Electron
// 并让真实 vendor 页消费它 —— 改了它而这里不跑，等于没验。
// @smoke-covers src/main/document/documentViewPreload.ts

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = resolve(desktop, "../..");
const PAGES = [
  { kind: "docs", path: join(repoRoot, "genoffice", "apps", "docs", "out", "renderer", "index.html") },
  { kind: "slides", path: join(repoRoot, "genoffice", "apps", "slides", "out", "renderer", "index.html") },
];

if (process.argv.length > 2) throw Error("Unknown test option");

const presentPages = PAGES.filter((p) => existsSync(p.path));
for (const p of PAGES) {
  if (!existsSync(p.path)) {
    console.log(`document-view-vendor-page-smoke: skip ${p.kind}（未构建：${p.path}）`);
  }
}
if (presentPages.length === 0) {
  console.log("document-view-vendor-page-smoke: skip（docs 与 slides 产物都未构建）");
  console.log("  先构建 genoffice renderer 再跑；本套件不联网、不代构建。");
  process.exit(0);
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const { build } = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/document-view-vendor-page-"));

// 探针与**生产 preload** 都按真产物形态打包：sandbox preload 必须是 CJS。
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
      pages: presentPages.map((p) => ({
        pagePath: p.path,
        preloadPath: join(dir, "documentViewPreload.js"),
        waitMs: 10000,
        // 与 renderer 套件里的 editorPageUrl() 形状一致（apps 以 ?mode=tab 启动）。
        urlSuffix: "?mode=tab",
      })),
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
  MCODE_GVP_DIR: dir,
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
  timeout: 150000,
  maxBuffer: 16 * 1024 * 1024,
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
// 每页 4 条 + 末尾 1 条共享的源码级断言（probe.ts 里逐条写）；下限钉住，
// 防止探针提前崩退只写了一半。
const EXPECTED_CHECKS = presentPages.length * 4 + 1;
const complete = checks.length >= EXPECTED_CHECKS && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`DOCUMENT VIEW VENDOR PAGE FAILED: exit=${run.status} checks=${checks.length}/${EXPECTED_CHECKS} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  const kinds = presentPages.map((p) => p.kind).join(" + ");
  console.log(`document-view-vendor-page-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过（真实 vendor ${kinds} 页）`);
}
