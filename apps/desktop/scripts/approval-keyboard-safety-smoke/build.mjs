import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";

/**
 * T6 审批卡键盘/焦点/拒绝回归 —— 隔离浏览器构建器。
 *
 * 真实度：真 React 19 + 真 react-dom + 真生产组件（ApprovalPrompt /
 * McpToolDecisionCard）+ 真 Base UI Dialog + 真 Chromium 按键/焦点。
 * 只换四处（见 main.tsx 文件头）。判据能区分"生产代码"与"夹具"，因为
 * 焦点/键盘/拒绝全部由浏览器原生行为驱动，不读源码字符串。
 *
 * 与 `ui-interaction-smoke/build.mjs` 同一套成熟取舍（browser.mjs 自包含 CDP 驱动）。
 * 不起 Electron —— 这是 E1 隔离组件证据，U1 另验。
 */
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
const dir = mkdtempSync(join(desktop, ".tmp/approval-keyboard-safety-"));
console.log("Approval keyboard safety artifacts: " + dir);
for (const f of ["main.tsx", "verify.mjs"]) copyFileSync(join(suite, f), join(dir, f));
copyFileSync(join(suite, "browser.mjs"), join(dir, "browser.mjs"));

/** `.js` 说明符 → 磁盘上的 `.ts`/`.tsx`。 */
const resolveTs = (p) => {
  const candidates = [p, p.replace(/\.js$/, ".tsx"), p.replace(/\.js$/, ".ts"), p + "/index.ts", p + "/index.tsx"];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c.replaceAll("\\", "/"); } catch { /* next */ }
  }
  return p.replaceAll("\\", "/");
};
const abs = (rel) => join(root, rel).replaceAll("\\", "/");

// 真 zh 词典（zh 是 MessageId 的源）。只拼本套件会触达的几份。
const locales = ["chat-composer", "chat-stream", "common"];
const i18nStub = locales
  .map((n, i) => `import { zh as d${i} } from ${JSON.stringify(abs(`lib/i18n/zh/${n}.ts`))};`)
  .join("\n")
  + `\nconst dict=Object.assign({},${locales.map((_, i) => "d" + i).join(",")});`
  + `\nconst t=(key,params={})=>{const base=dict[key]??key;return Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',String(v)),base);};`
  + `\nexport const useI18n=()=>({t,locale:"zh"});`;

const stubs = {
  // 只读选择器桩：审批卡只读 settingsOpen（真组件里的实际用法）。
  [abs("stores/sessionStore.ts")]:
    "export const useSessionStore=(sel)=>sel({settingsOpen:false});useSessionStore.getState=()=>({settingsOpen:false});",
  [abs("lib/i18n/index.ts")]: i18nStub,
  // 图标不换桩：真 barrel 直接打进 bundle。具名导出是 ESM 静态解析的，
  // 手写空壳一旦漏名就构建失败；判据也不落在图标绘制上，不值得为它引风险。
  // 转发表：Button 要**真**组件（disabled / focus / Enter 激活都是判据），Dialog 要真 Base UI。
  [abs("components/ui/index.ts")]:
    `export { Button } from ${JSON.stringify(abs("components/ui/button.tsx"))};\n`
    + `export { Dialog } from ${JSON.stringify(abs("components/ui/dialog.tsx"))};\n`,
};

const esbuild = await import(pathToFileURL(pkg("esbuild@", "esbuild/lib/main.js")).href);
await esbuild.build({
  entryPoints: [join(dir, "main.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  absWorkingDir: desktop,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: join(dir, "bundle.js"),
  logLevel: "error",
  plugins: [{
    name: "component-stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind !== "import-statement" && a.kind !== "require-call" && a.kind !== "dynamic-import") return undefined;
        const raw = a.path;
        const isAlias = raw.startsWith("@renderer/");
        const isRel = raw.startsWith("./") || raw.startsWith("../");
        if (!isAlias && !isRel) return undefined;
        const resolved = resolveTs(isAlias ? join(root, raw.slice(10)) : resolve(a.resolveDir, raw));
        if (resolved in stubs) return { path: resolved, namespace: "mock" };
        if (isAlias) return { path: resolved };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: stubs[a.path], loader: "tsx", resolveDir: desktop }));
    },
  }],
});

// 生产组件用到的 utility class 必须真编译，否则 display:none 之类的判据会假过。
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

writeFileSync(join(dir, "index.html"),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'none\'; worker-src \'none\'">'
  + '<title>approval keyboard safety</title><link rel="stylesheet" href="/app.css"></head>'
  + '<body><div id="root"></div><script src="/bundle.js"></script></body></html>');

await import(pathToFileURL(join(dir, "verify.mjs")).href);
