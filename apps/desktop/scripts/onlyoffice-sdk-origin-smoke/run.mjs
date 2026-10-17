/** 构建 + 运行。虚拟模块 `virtual:docsapi-loader` 把真实源码里两行区段标记之间的
 *  代码**原样**交给 esbuild 转 TS；导出的是一个工厂 —— 套件必须先装好虚构的
 *  `window`/`document`，再调工厂，否则 `loadDocsApi` 里读 window 会 ReferenceError。
 *  工厂每次调用都新建一份模块状态，`reset()` 因此天然干净。 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, "../..");
const text = readFileSync(join(desktop, "src/renderer/components/ide/OnlyOfficeEditorPane.tsx"), "utf8");
const begin = text.indexOf("// #region docsapi-loader");
const end = text.indexOf("// #endregion docsapi-loader");
if (begin < 0 || end <= begin) throw new Error("OnlyOfficeEditorPane.tsx 缺少 docsapi-loader 区段标记（判据会静默空跑）");
const section = text.slice(begin, end);

const pnpm = join(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
if (!esbuildDir) throw new Error("Installed esbuild required");
const esbuild = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/onlyoffice-sdk-origin-"));
await esbuild.build({
  entryPoints: [join(source, "main.ts")],
  bundle: true, platform: "node", format: "esm",
  tsconfig: join(desktop, "tsconfig.json"),
  outfile: join(dir, "smoke.mjs"),
  logLevel: "error",
  plugins: [{
    name: "docsapi-loader-section",
    setup(b) {
      b.onResolve({ filter: /^virtual:docsapi-loader$/ }, () => ({ path: "loader", namespace: "docsapi" }));
      b.onLoad({ filter: /.*/, namespace: "docsapi" }, () => ({
        loader: "ts",
        // 区段里那行 `export function __resetDocsApiOriginForTest()` 在原文件是模块
        // 导出；包进工厂后不能再带 `export`，去掉它（区段里只有这一处导出）。
        contents: `export const createLoader = () => {\n${section.replace(/^export /m, "")}\nreturn { loadDocsApi, reset: __resetDocsApiOriginForTest };\n};`,
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const result = spawnSync(process.execPath, [join(dir, "smoke.mjs")], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
