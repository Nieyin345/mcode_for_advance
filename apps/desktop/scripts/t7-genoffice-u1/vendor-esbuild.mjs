/**
 * T7 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加 esbuild 选项。
 *
 * 六条旅程都要 import **vendor 主进程**（`genoffice/apps/<kind>/src/main/<kind>-main.ts`）
 * 才能在真 Electron 里装配原厂视图。这些包是指向 TypeScript 源码的符号链接，
 * esbuild 默认解析不了三件事：
 *
 *  1. `@genoffice/<pkg>` 包名 → `genoffice/packages/<pkg>/src/index.ts`（以及子路径）；
 *  2. `?raw` 后缀（html2docx 的浏览器内核脚本以字符串形式内联）；
 *  3. `.wasm/.ttf/...` 资产（用 dataurl loader 内联）。
 *
 * 这套 alias 与 `apps/desktop/electron.vite.config.ts` 的 `slidesVendorAliases()` 同源
 * （顺序即判据：子路径在包根前面），但**不修改**生产配置 —— 它只是本套件的构建输入。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const vendor = resolve("../../genoffice");
const pkg = (pkgDir, file) => resolve(vendor, "packages", pkgDir, "src", file);
const appMain = (kind) => resolve(vendor, "apps", kind, "src", "main", `${kind}-main.ts`);

/** vendor 包的子路径导出（顺序：子路径 → 包根）。 */
const vendorAliases = {
  "@genoffice/pptx-engine/table-grid": pkg("pptx-engine", "table-grid.ts"),
  "@genoffice/pptx-engine/identity": pkg("pptx-engine", "identity.ts"),
  "@genoffice/pptx-engine/named-action": pkg("pptx-engine", "named-action.ts"),
  "@genoffice/pptx-engine/custgeom": pkg("pptx-engine", "custgeom.ts"),
  "@genoffice/pptx-engine/background-promote": pkg("pptx-engine", "background-promote.ts"),
  "@genoffice/docx-engine/math": pkg("docx-engine", "math.ts"),
  "@genoffice/docx-engine/lazy-media": pkg("docx-engine", "lazy-media.ts"),
  "@genoffice/docx-engine/zip-splice": pkg("docx-engine", "zip-splice.ts"),
  "@genoffice/agent-core/redact-range": pkg("agent-core", "redact-range.ts"),
  "@genoffice/pptx-ops/font-size": pkg("pptx-ops", "font-size.ts"),
  "@genoffice/pptx-ops/op-docs": pkg("pptx-ops", "op-docs.ts"),
  "@genoffice/pptx-render/auto-num": pkg("pptx-render", "auto-num.ts"),
  // fixtures.ts 静态 import 的三条（PDF 打印 + 包根）。
  "@genoffice/electron-utils/print-html-pdf": pkg("electron-utils", "print-html-pdf.ts"),
  "@genoffice/pptx-engine": pkg("pptx-engine", "index.ts"),
  "@genoffice/pptx-render": pkg("pptx-render", "index.ts"),
  "@genoffice/pptx-ops": pkg("pptx-ops", "index.ts"),
  "@genoffice/docx-engine": pkg("docx-engine", "index.ts"),
  "@genoffice/font-metrics": pkg("font-metrics", "index.ts"),
  // 五个原厂主进程的稳定别名（旅程文件 import 它们，不写 `../../genoffice/...` 相对路径 ——
  // 相对路径在 registry 换了位置时会静默指错）。
  "@main/document/genofficeNativeVendor.js": resolve("../desktop/src/main/document/genofficeNativeVendor.ts"),
  // 生产 `electron.vite.config.ts` 同两条入口别名（vendor 主进程的 main 源）。
  "@main/document/genofficeSheetsEntry.js": appMain("sheets"),
  "@main/document/genofficeSlidesEntry.js": appMain("slides"),
  // 生产 main 段的同一条别名：Docs 的受限注册器用 vendor `mcode-ipc.ts`（否则
  // `docsVendorIpc.ts` 是 `mcodeNativeDocsIpcAvailable=false` 的 fail-closed 桩，
  // 页面的 `mcode:docs:native-*` 通道就没有对端）。
  "@main/document/docsVendorIpc.js": resolve(vendor, "apps/docs/src/main/mcode-ipc.ts"),
  "@genoffice/pdf-main": appMain("pdf"),
  "@genoffice/markdown-main": appMain("markdown"),
  "@genoffice/html-main": appMain("html"),
  "@genoffice/sheets-main": appMain("sheets"),
  "@genoffice/slides-main": appMain("slides"),
  "@genoffice/docs-mcode-ipc": resolve(vendor, "apps/docs/src/main/mcode-ipc.ts"),
  // 三个执行器/端口模块（与生产同一条静态 seam）。
  "@main/document/slidesVendorModules.js": resolve("../desktop/src/main/document/slidesVendorModules.ts"),
  // T7：生产 `documentViewHost` 单例构造时 `import { getMainWindow } from "@main/window.js"`；
  // 探针把自己的窗口注入这个替身（见 `window-holder.ts` 文件头）。
  "@main/window.js": resolve("../desktop/scripts/t7-genoffice-u1/window-holder.ts"),
};

/** `?raw` → 原样字符串（html2docx 的浏览器内核脚本以源码形式内联）。 */
const rawTextPlugin = {
  name: "t7-raw-text",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => {
      const bare = args.path.replace(/\?raw$/, "");
      if (!bare.startsWith(".") && !bare.startsWith("/")) return undefined;
      return { path: resolve(args.resolveDir, bare), namespace: "t7-raw" };
    });
    build.onLoad({ filter: /.*/, namespace: "t7-raw" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

/**
 * 夹具模块用**虚拟包名** `require("genoffice:<name>")` 加载 vendor（见
 * `fixtures.ts` 文件头：静态 import 会把这台机器的 tsc 拖进 vendor 源码）。
 * 这些名字只在本套件的 bundle 里存在；alias 把它们改写到真实源码。
 */
const fixtureRequires = {
  "genoffice:docx-engine": pkg("docx-engine", "index.ts"),
  "genoffice:pptx-engine": pkg("pptx-engine", "index.ts"),
  "genoffice:print-html-pdf": pkg("electron-utils", "print-html-pdf.ts"),
  "genoffice:jszip": resolve(vendor, "node_modules/jszip"),
};

export const options = {
  alias: { ...vendorAliases, ...fixtureRequires },
  nodePaths: [join(vendor, "node_modules")],
  loader: {
    ".wasm": "dataurl",
    ".ttf": "dataurl",
    ".otf": "dataurl",
    ".png": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
  },
  define: {
    // vendor 主进程里的 `import.meta.url`（OCR 辅助二进制解析、wasm-path 的
    // createRequire）在 CJS 产物里不存在；指到 journeys.cjs 自身的位置即可 ——
    // 本套件不测那些路径，它们只需要一个可解析的 URL。
    "import.meta.url": JSON.stringify(new URL("./journeys.cjs", import.meta.url).href),
  },
  plugins: [rawTextPlugin],
};

/** 让 `--esbuild` 的两个消费方（本套件的 build 与文档）都能发现 vendor 缺失。 */
export function assertVendorPresent() {
  const missing = [];
  for (const kind of ["docs", "sheets", "slides", "pdf", "markdown", "html"]) {
    const dir = resolve(vendor, "apps", kind, "out", "renderer");
    let ok = false;
    try { ok = readdirSync(dir).length > 0; } catch { ok = false; }
    if (!ok) missing.push(dir);
  }
  return missing;
}
