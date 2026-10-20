/**
 * 【MC-046 U1】真 Electron 下的设置覆盖层焦点所有权 —— 启动器。
 *
 * 组装（与 settings-layout-smoke 同一套真实度取舍，只是宿主从 Chrome 换成 Electron）：
 *   - 渲染端：**真 App**（App.tsx）+ 真 store；只换三处「真 Chrome/Electron 跑不起来」
 *     的模块：`lib/api`（无 preload 桥）、`lib/monacoSetup`（?worker 资源）、左栏/流式
 *     侧栏两个深层面板（空数据下会炸，与焦点判据无关）。
 *   - 主进程：`probe.ts` 建隐藏 BrowserWindow，`webContents.sendInputEvent` 派发**真**
 *     Tab/Escape/鼠标事件。
 *   - `window.api` 由 `api-stub.js` 在 bundle **之前**注入（与 settings-layout-smoke
 *     同一坑：`api.ts` 在模块求值那一刻决定 transport）。
 *
 * 判据由启动器汇总 `checks.json`：exit 0 且每条 PASS 且条数 ≥ 10。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const root = join(desktop, "src/renderer");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
if (process.argv.length > 2) throw Error("Unknown test option");

const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw Error("Missing installed dependency " + prefix);
  return join(pnpm, n, "node_modules", sub);
};
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = resolve(desktop, "../../.tmp/arc005-visual");
mkdirSync(dir, { recursive: true });
// Do not preserve PNGs from prior runs when a scene is now DATA_MISSING.
for (const name of readdirSync(dir)) {
  if (/^(empty|messages|tools|approval|diff|sidechat|terminal|editor|preview|parallel|projects|settings|narrow-window)-(light|dark|narrow)-(1280|1024)\.(png|json)$/.test(name)) unlinkSync(join(dir, name));
}
console.log("ARC-005 visual electron evidence: " + dir);

/** `.js` 说明符 → 磁盘上的 `.ts`/`.tsx`。 */
const resolveTs = (p) => {
  const candidates = [p, p.replace(/\.js$/, ".tsx"), p.replace(/\.js$/, ".ts"), p + "/index.ts", p + "/index.tsx"];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c.replaceAll("\\", "/"); } catch { /* next */ }
  }
  return p.replaceAll("\\", "/");
};
const abs = (rel) => join(root, rel).replaceAll("\\", "/");
const stubs = {
  [abs("lib/api.ts")]: "export const api=window.labApi;",
  [abs("lib/monacoSetup.ts")]: "export const monacoSetup=()=>{};export default {};",
  // T12: keep the real LeftBar and StreamSidebar. Supply isolated API fixtures
  // instead of hiding the real project/session tree behind placeholder divs.
};

const esbuild = await import(pathToFileURL(pkg("esbuild@", "esbuild/lib/main.js")).href);

// Entry must live below apps/desktop so node resolution finds React dependencies.
const entry = join(desktop, ".tmp/arc005-visual-entry.tsx");
writeFileSync(entry, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from ${JSON.stringify(join(root, "App.tsx").replaceAll("\\", "/"))};
import {Arc005FixturePanels} from ${JSON.stringify(join(suite, "fixture-panels.tsx").replaceAll("\\", "/"))};
import {useSessionStore} from ${JSON.stringify(join(root, "stores/sessionStore.ts").replaceAll("\\", "/"))};
import {useToastStore} from ${JSON.stringify(join(root, "stores/toastStore.ts").replaceAll("\\", "/"))};
window.React=React;
window.__store=useSessionStore;
window.__toast=useToastStore;
try{
  createRoot(document.getElementById('root')).render(<><App/><Arc005FixturePanels/></>);
  window.__mounted=true;
}catch(e){
  window.__mountError=String(e&&e.stack||e);
  throw e;
}
`);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  absWorkingDir: desktop,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: join(dir, "bundle.js"),
  logLevel: "error",
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".png": "empty", ".svg": "empty" },
  plugins: [{
    name: "shell-stubs",
    setup(b) {
      b.onResolve({ filter: /\?(worker|url|raw)$/ }, (a) => ({ path: a.path, external: true }));
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind !== "import-statement" && a.kind !== "require-call" && a.kind !== "dynamic-import") return undefined;
        const raw = a.path;
        const isAlias = raw.startsWith("@renderer/");
        const isRel = raw.startsWith("./") || raw.startsWith("../");
        if (!isAlias && !isRel) return undefined;
        const resolved = resolveTs(isAlias ? join(root, raw.slice(10)) : resolve(a.resolveDir, raw));
        if (resolved in stubs) return { path: resolved, namespace: "mock" };
        return isAlias ? { path: resolved } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: stubs[a.path], loader: "tsx", resolveDir: desktop }));
    },
  }],
});

const configPath = join(dir, "tailwind.config.cjs");
writeFileSync(
  configPath,
  readFileSync(join(desktop, "tailwind.config.js"), "utf8")
    .replace("export default", "module.exports =")
    .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]', "content: " + JSON.stringify([root.replaceAll("\\", "/") + "/**/*.{ts,tsx,html}"])),
);
const css = buildTailwindCached({
  cliPath: pkg("tailwindcss@", "tailwindcss/lib/cli.js"),
  configPath,
  inputCss: "src/renderer/styles.css",
  outPath: join(dir, "app.css"),
  cwd: desktop,
});
if (css.status !== undefined && css.status !== 0) throw Error("tailwind failed");

copyFileSync(join(suite, "api-stub.js"), join(dir, "api-stub.js"));
copyFileSync(join(suite, "bridge.cjs"), join(dir, "bridge.cjs"));
copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));

writeFileSync(
  join(dir, "page.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src 'none'">
<title>settings focus electron u1</title><link rel="stylesheet" href="./app.css"></head>
<body style="margin:0"><div id="root" style="height:100vh"></div><script src="./api-stub.js"></script><script src="./bundle.js"></script></body></html>`,
);

// 探针（CJS，electron 外置）。它 import 的 @main/window 会有原生模块问题 —— 本探针
// 不 import 任何主进程业务模块，只建窗口 + 派发输入，所以不需要 alias。
await esbuild.build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron"],
  alias: { "@main/window.js": join(suite, "windowStub.ts") },
});

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
  MCODE_SFE_DIR: dir,
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
const failed = checks.filter((c) => c.status !== "PASS" && c.status !== "DATA_MISSING");
// T12 provenance gate: an Electron screenshot alone cannot authenticate a
// renderer fixture. Every captured PNG must have a typed JSON provenance.
for (const check of checks) {
  if (check.status !== "PASS") continue;
  const jsonPath = join(dir, check.name + ".json");
  const pngPath = join(dir, check.name + ".png");
  try {
    const sample = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!existsSync(pngPath) || typeof sample.fixture !== "string" || !sample.fixture) {
      failed.push({ ...check, reason: "captured scene missing PNG or fixture provenance" });
    }
  } catch (error) {
    failed.push({ ...check, reason: "captured scene missing JSON: " + String(error) });
  }
}
const complete = checks.length === 39 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`ARC005 VISUAL E2E FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`arc005-visual-baseline: ${checks.filter(x=>x.status==="PASS").length}/39 真 Electron 场景已拍；其余 data-missing 已显式登记`);
}
