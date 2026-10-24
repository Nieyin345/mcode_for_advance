/**
 * `workflow-node-select-smoke` 的构建器 —— 真 React 19 + 真 react-dom + 真
 * `WorkflowLibraryView` + 真 Base UI + 真 Chromium 的隔离浏览器套件。
 *
 * ## 与仓库里两套既有夹具的分工
 *
 * - `workflow-view-smoke`（763 条，SSR）：验"给了 `selectedNodeId` 之后渲染对不对"。
 *   **它绕过了"用户怎么让它变成 B"** —— T45 之后那条路从来没人走过。
 * - `settings-form-lifecycle-smoke`（fakeReact）：验根组件上的状态机。`NodeInspector`
 *   是**子组件**，假运行时不展开它，所以"点完节点右侧换了没有"在那里验不到。
 *
 * 这一套补的正是那一步：**真点击**（CDP `Input.dispatchMouseEvent`）+ 真重渲染。
 *
 * ## 只换四处
 *
 * 见 `main.tsx` 文件头的 stubs 表（api / sessionStore / libraryStore / monacoSetup）。
 * 其余全是生产源码：`WorkflowLibraryView`、`NodeInspector`、`NodeInspectorParts`、
 * `ParamField`、`WorkflowListRow`、i18n 词典、UI 原语、Tailwind CSS。
 *
 * ## `banner` 为什么必须存在
 *
 * `@renderer/lib/api.ts` 在**模块求值那一刻**做 `window.api ?? createWebApi()`，而 ESM
 * 的 import 全部先于任何模块体执行 —— 入口文件里写 `window.api = stub` 太晚（生产里
 * preload 在页面脚本之前注入，正是同一个道理）。所以 stub 挂在 bundle 的 banner 上：
 * 它在**所有**模块之前求值。
 *
 * ## 判成败
 *
 * 隐藏浏览器关掉后 `Page.navigate` 的结果没人看，断言失败若只看进程退出码会被吞掉
 * —— `verify.mjs` 把每条断言写进 `results.json` 并要求全部 PASS 才退出 0（与
 * `approval-keyboard-safety-smoke` 同一取舍）。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const dir = mkdtempSync(join(desktop, ".tmp/workflow-node-select-"));
console.log("workflow-node-select artifacts: " + dir);
for (const f of ["main.tsx", "verify.mjs"]) copyFileSync(join(suite, f), join(dir, f));
copyFileSync(join(suite, "browser.mjs"), join(dir, "browser.mjs"));
copyFileSync(join(suite, "api-stub.ts"), join(dir, "api-stub.ts"));
// `main.tsx` 以相对路径 import 它（esbuild 的 json loader）。目录由 run.sh 生成到临时
// 位置后经环境变量交进来 —— 不落在套件目录，避免"清单改了、提交的旧夹具还在"。
const catalogJson = process.env.MCODE_SMOKE_NODE_CATALOG;
if (!catalogJson) throw Error("MCODE_SMOKE_NODE_CATALOG 未设置 —— 请用 run.sh 跑（它会从内置清单生成）");
// 作为**全局**注入，而不是写成 `catalog.generated.json` 让 main.tsx import：那个文件
// 只在运行时存在（run.sh 生成到临时目录），tsc 会因找不到模块而红 —— 而这是 tsconfig
// 里 `scripts/**/*` 被 include 的直接后果。走 window 既避开 tsc，也与"它是运行时夹具"
// 这件事相符。
const catalogGlobal = `\nwindow.__LAB_CATALOG = ${catalogJson};\n`;

/** 仓库相对 `.js` 说明符 → 磁盘上的 `.ts`/`.tsx`：生产源码全用 ESM-with-.js 写法，
 *  直接按字面找 `.js` 会找不到真身（esbuild 的默认扩展名探测**只对相对路径**生效，
 *  而这个插件接管了 `@renderer/*` 之后要自己给对路径）。 */
const resolveTs = (p) => {
  const plain = p.replaceAll("\\", "/");
  const candidates = [plain, plain.replace(/\.js$/, ".tsx"), plain.replace(/\.js$/, ".ts"), plain + "/index.tsx", plain + "/index.ts"];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return plain;
};
const abs = (rel) => resolveTs(join(root, rel).replaceAll("\\", "/"));

// 本套件只需要 `settings` + `common` 两份词典（检查器与库列表用的全部词条都在它们里；
// 缺什么 key 时 t() 会回落成 key 本身，verify 会因"找不到文案"红掉 —— 那正是我们要的
// 失败形态，不是静默通过）。
const localeFiles = ["common", "settings", "layout", "lib"];
const i18nStub =
  localeFiles
    .map((n, i) => `import { zh as d${i} } from ${JSON.stringify(abs(`lib/i18n/zh/${n}.ts`))};`)
    .join("\n")
  + "\nconst dict = Object.assign({}, " + localeFiles.map((_, i) => "d" + i).join(", ") + ");"
  + `
export type MessageId = string;
export const translate = (_locale, key, params = {}) => {
  const base = dict[key] ?? key;
  return Object.entries(params).reduce((s, [k, v]) => s.replaceAll("{" + k + "}", String(v)), base);
};
export const useI18n = () => ({ t: (key, params) => translate("zh", key, params), locale: "zh" });`;

/**
 * 会话 store 的最小切片。**保留真 zustand**（`create`/`useStore` 都是本套件依赖里的
 * 那一份），只换内容 —— `useSessionStore(selector)` / `.getState` / `.setState` /
 * `.subscribe` 的语义与生产一致（见 main.tsx 文件头）。
 */
const sessionStub = `
import { create } from "zustand";
const initial = {
  locale: "zh",
  providers: [{ id: "claude-sdk", displayName: "Claude", capabilities: { builtinModels: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] } }],
  skills: [],
  projects: [],
  customModels: [],
  customModelId: null,
  providerId: "claude-sdk",
  piAvailableModels: [],
  codexAvailableModels: [],
  settingsFocusWorkflowId: null,
};
const S = create(() => ({ state: initial }));
export const useSessionStore = (sel) => S((s) => sel(s.state));
useSessionStore.getState = () => S.getState().state;
useSessionStore.setState = (patch) => S.setState((s) => ({ state: { ...s.state, ...patch } }));
useSessionStore.subscribe = (fn) => S.subscribe((s) => fn(s.state));
useSessionStore.getInitialState = () => initial;
export const EMPTY_MESSAGES = [];
`;

const stubs = {
  [abs("lib/i18n/index.ts")]: i18nStub,
  [abs("stores/sessionStore.ts")]: sessionStub,
  // `useRefOptions` 只 import 类型（`type SessionState`），从 stub 里拿不到 —— 给一个
  // 结构上够用的别名。运行时那个 import 会被 esbuild 完全擦掉（`import type`）。
  [abs("stores/libraryStore.ts")]: `
import { create } from "zustand";
const S = create(() => ({ collections: [], loaded: true, loadCollections: async () => {} }));
export const useLibraryStore = (sel) => S((s) => sel(s));
useLibraryStore.getState = () => S.getState();
`,
  [abs("lib/monacoSetup.js")]: "export {};",
};

const esbuild = await import(pathToFileURL(pkg("esbuild@", "esbuild/lib/main.js")).href);
const buildOnce = (entry, outfile, extra = {}) => esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile,
  logLevel: "error",
  ...extra,
});

// ── ① stub 先成包（在 bundle.js 之前以独立 <script> 加载） ────────────────
// `@renderer/lib/api.ts` 在**模块求值那一刻**做 `window.api ?? createWebApi()`，而
// 生产模块一被 bundle 就不会等谁。所以 stub 必须在**另一个** script 里先跑完，
// 把 `window.api` 放好 —— 与生产里 preload 先于页面脚本注入完全同构
// （`settings-panels-electron-smoke` 的 api-stub.js 走的是同一条路）。
const apiStubPath = join(dir, "api-stub.ts");
const apiStubOut = join(dir, "api-stub.js");
{
  const esbuildBrowser = await import(pathToFileURL(pkg("esbuild@", "esbuild/lib/main.js")).href);
  await esbuildBrowser.build({
    entryPoints: [apiStubPath],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "__labApiModule",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: apiStubOut,
    logLevel: "error",
    footer: { js: "window.api = __labApiModule.api;" + catalogGlobal },
  });
}

await buildOnce(join(dir, "main.tsx"), join(dir, "bundle.js"), {
  plugins: [
    {
      name: "component-stubs",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.kind !== "import-statement" && a.kind !== "require-call" && a.kind !== "dynamic-import") return undefined;
          const raw = a.path;
          const isAlias = raw.startsWith("@renderer/");
          if (!isAlias) return undefined;
          const resolved = abs(raw.slice(10));
          if (resolved in stubs) return { path: resolved, namespace: "mock" };
          return { path: resolved };
        });
        b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: stubs[a.path], loader: "tsx", resolveDir: desktop }));
      },
    },
  ],
});

// Tailwind 要真编译 —— verify 里没有读样式的判据，但 `.hidden` 之类的类会决定
// "可见/不可见"，将来若加样式判据不能假过（与 approval-keyboard-safety 同一条理由）。
const configPath = join(dir, "tailwind.config.cjs");
const config = readFileSync(join(desktop, "tailwind.config.js"), "utf8")
  .replace("export default", "module.exports =")
  .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]', "content: " + JSON.stringify([root.replaceAll("\\", "/") + "/**/*.{ts,tsx,html}"]));
writeFileSync(configPath, config);
buildTailwindCached({
  cliPath: pkg("tailwindcss@", "tailwindcss/lib/cli.js"),
  configPath,
  inputCss: "src/renderer/styles.css",
  outPath: join(dir, "app.css"),
  cwd: desktop,
});

writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'none\'; worker-src \'none\'">'
  + '<title>workflow node select</title><link rel="stylesheet" href="/app.css"></head>'
  + '<body><div id="root"></div><script src="/api-stub.js"></script><script src="/bundle.js"></script></body></html>',
);

await import(pathToFileURL(join(dir, "verify.mjs")).href);
