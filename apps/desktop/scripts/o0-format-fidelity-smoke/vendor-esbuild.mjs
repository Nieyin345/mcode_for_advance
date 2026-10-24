/**
 * O0 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加 esbuild 选项。
 *
 * 与 t7 的 `vendor-esbuild.mjs` 几乎同形（同样要解析 `@genoffice/*` 包名、`?raw`、
 * 资产 loader），**只多两条** O0 指纹需要的别名：
 *
 *  - `genoffice:fast-xml-parser` —— `fidelity/fingerprint.ts` 解 OOXML 用；
 *  - `genoffice:pdf-lib` —— `fixtures/build.ts` 造 PDF 样本用（vendor
 *    `save-pdf.ts` 的同一份依赖）。
 *
 * `genoffice:jszip`（t7 fixtures 已在用）与这里的两条在 `t7-genoffice-u1/
 * vendor-esbuild.mjs` 的 `fixtureRequires` 里没有全部覆盖，所以 O0 自己带一份
 * —— **不修改** t7 的文件（卡 §5：不改 t7 现有旅程与其构建输入）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const vendor = resolve("../../genoffice");
const pkg = (pkgDir, file) => resolve(vendor, "packages", pkgDir, "src", file);
const appMain = (kind) => resolve(vendor, "apps", kind, "src", "main", `${kind}-main.ts`);

/** vendor 包的子路径导出（顺序：子路径 → 包根）。与 t7 的列表同源。 */
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
  "@genoffice/electron-utils/print-html-pdf": pkg("electron-utils", "print-html-pdf.ts"),
  "@genoffice/pptx-engine": pkg("pptx-engine", "index.ts"),
  "@genoffice/pptx-render": pkg("pptx-render", "index.ts"),
  "@genoffice/pptx-ops": pkg("pptx-ops", "index.ts"),
  "@genoffice/docx-engine": pkg("docx-engine", "index.ts"),
  "@genoffice/font-metrics": pkg("font-metrics", "index.ts"),
  "@main/document/genofficeNativeVendor.js": resolve("../desktop/src/main/document/genofficeNativeVendor.ts"),
  "@main/document/genofficeSheetsEntry.js": appMain("sheets"),
  "@main/document/genofficeSlidesEntry.js": appMain("slides"),
  "@main/document/docsVendorIpc.js": resolve(vendor, "apps/docs/src/main/mcode-ipc.ts"),
  "@genoffice/pdf-main": appMain("pdf"),
  "@genoffice/markdown-main": appMain("markdown"),
  "@genoffice/html-main": appMain("html"),
  "@genoffice/sheets-main": appMain("sheets"),
  "@genoffice/slides-main": appMain("slides"),
  "@genoffice/docs-mcode-ipc": resolve(vendor, "apps/docs/src/main/mcode-ipc.ts"),
  "@main/document/slidesVendorModules.js": resolve("../desktop/src/main/document/slidesVendorModules.ts"),
  "@main/window.js": resolve("../desktop/scripts/t7-genoffice-u1/window-holder.ts"),
};

/** `?raw` → 原样字符串（html2docx 的浏览器内核脚本以源码形式内联）。 */
const rawTextPlugin = {
  name: "o0-raw-text",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => {
      const bare = args.path.replace(/\?raw$/, "");
      if (!bare.startsWith(".") && !bare.startsWith("/")) return undefined;
      return { path: resolve(args.resolveDir, bare), namespace: "o0-raw" };
    });
    build.onLoad({ filter: /.*/, namespace: "o0-raw" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

/**
 * 夹具与指纹模块用**虚拟包名** `require("genoffice:<name>")` 加载 vendor
 *（见 `fixtures/build.ts` 与 `fidelity/fingerprint.ts` 的文件头：静态 import
 * 会把这台机器的 tsc 拖进 vendor 源码）。
 */
const fixtureRequires = {
  "genoffice:docx-engine": pkg("docx-engine", "index.ts"),
  "genoffice:pptx-engine": pkg("pptx-engine", "index.ts"),
  "genoffice:print-html-pdf": pkg("electron-utils", "print-html-pdf.ts"),
  "genoffice:jszip": resolve(vendor, "node_modules/jszip"),
  "genoffice:fast-xml-parser": resolve(vendor, "node_modules/fast-xml-parser"),
  "genoffice:pdf-lib": resolve(vendor, "node_modules/pdf-lib"),
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
    "import.meta.url": JSON.stringify(new URL("./journeys.cjs", import.meta.url).href),
  },
  plugins: [rawTextPlugin],
};

/** 让 `--esbuild` 的消费方在 vendor 缺失时能报清楚。 */
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
