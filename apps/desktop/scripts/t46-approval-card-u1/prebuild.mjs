/**
 * T46 —— `electron-u1/build.mjs --prebuild=` 模块：把**审批卡探针页**打进 buildDir。
 *
 * 与 `t7-genoffice-u1/prebuild.mjs` 同一个机制（在 buildDir 就绪后、旅程跑起来前
 * 打附加产物），只是这里打的是渲染端页面：
 *
 *  1. `approval-page.tsx` → `t46-approval-page.js`（真 React 19 + 真 `ApprovalPrompt`
 *     + 真 Base UI `Dialog`），`@renderer/stores/sessionStore.js` 别名到
 *     `stub-session-store.ts`（可切换 `settingsOpen`）；
 *  2. Tailwind 按生产 `styles.css` + 生产配置**真编译** —— 审批卡用 utility class
 *     控制可见性/禁用态，不编译会假过（E1 同一取舍）；
 *  3. 写 `t46-approval.html`，旅程用 `launch.page = { file: "t46-approval.html" }`。
 *
 * 不起第二个执行器，也不改 `electron-u1` 的任何文件 —— 这是「`--prebuild` 就是给
 * 后续卡复用」的用法（见 `electron-u1/build.mjs` 的头注释）。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";

export async function prepare({ buildDir, desktop, esbuild }) {
  const suite = join(desktop, "scripts/t46-approval-card-u1");
  const root = join(desktop, "src/renderer");
  const pnpm = resolve(desktop, "../../node_modules/.pnpm");

  const pkg = (prefix, sub) => {
    const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
    if (!n) throw Error("T46 prebuild: missing installed dependency " + prefix);
    return join(pnpm, n, "node_modules", sub);
  };
  const resolveTs = (p) => {
    const candidates = [p, p.replace(/\.js$/, ".tsx"), p.replace(/\.js$/, ".ts"), p + "/index.ts", p + "/index.tsx"];
    for (const c of candidates) {
      try { if (statSync(c).isFile()) return c.replaceAll("\\", "/"); } catch { /* next */ }
    }
    return p.replaceAll("\\", "/");
  };
  const abs = (rel) => join(root, rel).replaceAll("\\", "/");

  // 只换 store（可切换 settingsOpen）。Button/Dialog/i18n/icons 全部用真模块：
  // 生产组件直接 import 它们的具名导出，缺名会在构建期失败（正是我们要的）。
  const stubs = {
    [abs("stores/sessionStore.ts")]: join(suite, "stub-session-store.ts").replaceAll("\\", "/"),
  };

  await esbuild({
    entryPoints: [join(suite, "approval-page.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    absWorkingDir: desktop,
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(buildDir, "t46-approval-page.js"),
    logLevel: "error",
    loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".png": "empty", ".svg": "empty" },
    plugins: [{
      name: "t46-stubs",
      setup(b) {
        b.onResolve({ filter: /\?(worker|url|raw)$/ }, (a) => ({ path: a.path, external: true }));
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.kind !== "import-statement" && a.kind !== "require-call" && a.kind !== "dynamic-import") return undefined;
          const raw = a.path;
          const isAlias = raw.startsWith("@renderer/");
          const isRel = raw.startsWith("./") || raw.startsWith("../");
          if (!isAlias && !isRel) return undefined;
          const resolved = resolveTs(isAlias ? join(root, raw.slice(10)) : resolve(a.resolveDir, raw));
          if (resolved in stubs) {
            const target = stubs[resolved];
            // `sessionStore` 的桩是**独立 TS 文件**：直接把它作为解析结果，
            // 让 esbuild 正常打包（而不是内联字符串，保持它与探针页面共享同一模块实例）。
            return { path: target };
          }
          return isAlias ? { path: resolved } : undefined;
        });
      },
    }],
  });

  // 生产 utility class 真编译（可见性 / disabled 判据都落在它上面）。
  const configPath = join(buildDir, "t46-tailwind.config.cjs");
  writeFileSync(
    configPath,
    readFileSync(join(desktop, "tailwind.config.js"), "utf8")
      .replace("export default", "module.exports =")
      .replace(
        'content: ["./src/renderer/**/*.{ts,tsx,html}"]',
        "content: " + JSON.stringify([root.replaceAll("\\", "/") + "/**/*.{ts,tsx,html}"]),
      ),
  );
  const css = buildTailwindCached({
    cliPath: pkg("tailwindcss@", "tailwindcss/lib/cli.js"),
    configPath,
    inputCss: "src/renderer/styles.css",
    outPath: join(buildDir, "t46-approval.css"),
    cwd: desktop,
  });
  if (css.status !== undefined && css.status !== 0) throw Error("T46 prebuild: tailwind failed");

  writeFileSync(
    join(buildDir, "t46-approval.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'none\'; worker-src \'none\'">'
    + '<title>T46 approval card U1</title><link rel="stylesheet" href="./t46-approval.css"></head>'
    + '<body style="margin:0"><div id="root"></div><script src="./t46-approval-page.js"></script></body></html>',
  );
  mkdirSync(buildDir, { recursive: true });
  console.log("T46 prebuild: t46-approval-page.js + t46-approval.html → " + buildDir);
}
