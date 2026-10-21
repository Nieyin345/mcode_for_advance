import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// No build-time `.gz` / `.br` copies any more: they only served the mobile
// HTTP server and added ~26MB to every installer. serveMobileStatic.ts now
// compresses on demand from the final files on disk (same bytes the desktop
// loads) and keeps the results in a bounded in-memory cache.

/** Absolute path to the monaco-editor package root. Used to alias the worker
 *  entry imports so Vite's `?worker` resolver finds them on disk regardless
 *  of monaco-editor's package.json `exports` field (whose `./*.js` wildcard
 *  mis-maps the `esm/vs/.../foo.worker.js` paths documented for Vite).
 *
 *  `require.resolve` follows pnpm's symlinks to the real package dir. */
const monacoPkgDir = resolve(
  __dirname,
  "node_modules/monaco-editor",
);

/** `pdfjs-dist` 的包目录 —— 它的 cmaps / standard_fonts 要当静态资源发给渲染端。 */
const pdfjsPkgDir = resolve(__dirname, "node_modules/pdfjs-dist");

/**
 * 【ARC-007 P1/GA1】slides 执行器用的 vendor 包（genoffice 快照）的**子路径别名**。
 *
 * 为什么需要：vendor 源码用 `@genoffice/pptx-engine/table-grid` 这类**子路径
 * 导出**（package.json `exports` 映射到 `.ts` 源码）。esbuild/Rollup 对「包根
 * 别名 + 子路径」的处理是把后缀拼到别名目标后面（`.../index.ts/table-grid`），
 * 解析必然失败（实测）。所以每个被闭包用到的子路径都显式列在这里；新增时要
 * 跟着闭包 grep 一遍（vendor 更新后漏一个，构建会在解析处当场报错，不会静默）。
 *
 * 快照不在场时返回空表 —— 此时 `slidesVendorModules` 已经被别名到 stub，
 * 这些包根本不会被 import。
 */
function slidesVendorAliases(): Array<{ find: string; replacement: string }> {
  const vendor = resolve("../../genoffice");
  if (!existsSync(resolve(vendor, "packages/pptx-engine/package.json"))) return [];
  const pkg = (pkgDir: string, file: string): string => resolve(vendor, "packages", pkgDir, "src", file);
  // ⚠️ 顺序即判据：Rollup 的 alias 插件按数组顺序做**前缀**匹配，
  // 包根别名写在子路径前面会把 `@genoffice/pptx-engine/table-grid`
  // 拼成 `.../index.ts/table-grid`（实测）。所以子路径全部排在前面。
  return [
    { find: "@genoffice/pptx-engine/table-grid", replacement: pkg("pptx-engine", "table-grid.ts") },
    { find: "@genoffice/pptx-engine/identity", replacement: pkg("pptx-engine", "identity.ts") },
    { find: "@genoffice/pptx-engine/custgeom", replacement: pkg("pptx-engine", "custgeom.ts") },
    { find: "@genoffice/pptx-engine/background-promote", replacement: pkg("pptx-engine", "background-promote.ts") },
    { find: "@genoffice/docx-engine/math", replacement: pkg("docx-engine", "math.ts") },
    { find: "@genoffice/docx-engine/lazy-media", replacement: pkg("docx-engine", "lazy-media.ts") },
    { find: "@genoffice/docx-engine/zip-splice", replacement: pkg("docx-engine", "zip-splice.ts") },
    { find: "@genoffice/agent-core/redact-range", replacement: pkg("agent-core", "redact-range.ts") },
    { find: "@genoffice/pptx-engine", replacement: pkg("pptx-engine", "index.ts") },
    { find: "@genoffice/pptx-render", replacement: pkg("pptx-render", "index.ts") },
    { find: "@genoffice/pptx-ops", replacement: pkg("pptx-ops", "index.ts") },
    { find: "@genoffice/docx-engine", replacement: pkg("docx-engine", "index.ts") },
  ];
}

/**
 * 把 pdfjs 的 `cmaps` 与 `standard_fonts` 复制进渲染端的 public 目录。
 *
 * ## 为什么需要这个
 *
 * 主进程用 pdf.js 抽文本时,cmaps 是**用 fs 直接读**的(见 `main/library/pdfText.ts`);
 * 但渲染端的 pdf.js 是**用 fetch 拿**的,得有一个它能请求到的 URL。中文 PDF 常常靠
 * CMap 才能把字形索引映射回字符(Identity-H 那类编码),少了它正文可能整片空白 ——
 * 用户读的正是中文文献,这条不能省。
 *
 * ## 为什么不改成注册自定义协议
 *
 * `protocol.handle` + `registerSchemesAsPrivileged` 能做到,但那个注册**必须发生在
 * app ready 之前**,是主进程启动路径上的新风险。而这批文件总共才 ~2.3MB(169 个 bcmap
 * + 16 个标准字体),复制进 public 目录之后:开发时 Vite 直接伺服,打包时原样进
 * `out/renderer/`,渲染端用**相对 URL** 就能取到 —— 两种情况都成立,主进程一行不用改。
 *
 * ## 只在版本变化或文件缺失时复制
 *
 * dev 每次启动都会调 buildStart;169 个文件每次都重写没必要。用一个写着包版本的
 * 标记文件判断,升级 pdfjs 之后自动重新复制。
 */
/**
 * 把 `@embedpdf/pdfium` 的 `pdfium.wasm` 拷进 `public/embedpdf/`。
 *
 * ## 为什么用"拷进 public + 运行时路径"而不是 `import ... ?url`
 *
 * `?url` 那条路**只在 dev 下成立**：生产构建时 rollup 解析不到这个说明符——
 * 它是个**包内路径**（`@embedpdf/pdfium/pdfium.wasm`，走那个包的 `exports` 映射），
 * 而 Vite 的 `assetsInclude` 白名单对"包内 + 带 query 的路径"不生效，
 * 直接 `Rollup failed to resolve import`。dev 里看不出来，构建才炸。
 *
 * 拷进 `public/` 之后它在运行时就是 `<origin>/embedpdf/pdfium.wasm`，与
 * `copyPdfjsAssets` 给 `cmaps` / `standard_fonts` 用的是同一条路 —— 那条路一直是好的。
 *
 * ⚠️ **必须自托管。** EmbedPDF 默认从 CDN 取这份 wasm，而这个应用是离线的、
 * CSP 还是 `default-src 'self'` —— 走 CDN 必然失败（表现是"只有工具栏、没有页面"）。
 */
/** A version marker is not evidence that generated assets still exist. Validate
 * every source entry so partial cleanup/copies cannot yield a green broken build.
 * Metadata checks avoid reading a large WASM payload on every dev restart. */
function assetTreeComplete(source: string, destination: string): boolean {
  try {
    const expected = statSync(source);
    const actual = statSync(destination);
    if (expected.isDirectory()) {
      return actual.isDirectory() && readdirSync(source).every(name =>
        assetTreeComplete(join(source, name), join(destination, name)));
    }
    return expected.isFile() && actual.isFile() && expected.size === actual.size;
  } catch { return false; }
}

function copyPdfiumWasm(): Plugin {
  const publicDir = resolve(__dirname, "src/renderer/public/embedpdf");
  const versionFile = join(publicDir, ".pdfium-version");
  return {
    name: "mcode:copy-pdfium-wasm",
    buildStart() {
      /**
       * ⚠️ **别硬编码，也别指望 `require.resolve` —— 它在 pnpm 下找不到。**
       *
       * `@embedpdf/pdfium` 是 `@embedpdf/react-pdf-viewer` 的**传递依赖**。pnpm 的
       * 严格布局下它只存在于 `.pnpm/@embedpdf+pdfium@x.y.z/node_modules/`，而
       * `apps/desktop/node_modules` 顶层**没有**它 —— 从 `apps/desktop/package.json`
       * 出发的 `require.resolve("@embedpdf/pdfium/package.json")` 会直接抛
       * `Cannot find module`（实测）。
       *
       * 第一版就是写死路径 + `catch { return }`，于是**插件一次都不跑、wasm 从不被拷，
       * 而构建还是绿的** —— 只有运行时才以"只有工具栏、没有页面"显形。这种静默失败
       * 正是最该避免的：所以下面找不到时**直接抛**，让构建当场停。
       */
      const pnpmRoot = resolve(__dirname, "../../node_modules/.pnpm");
      let pkgDir: string | null = null;
      try {
        for (const entry of readdirSync(pnpmRoot)) {
          if (!entry.startsWith("@embedpdf+pdfium@")) continue;
          const candidate = join(pnpmRoot, entry, "node_modules/@embedpdf/pdfium");
          if (existsSync(join(candidate, "dist/pdfium.wasm"))) {
            pkgDir = candidate;
            break;
          }
        }
      } catch {
        /* 下面统一报 */
      }
      if (pkgDir === null) {
        throw new Error(
          "[mcode:pdfium] 在 node_modules/.pnpm 里找不到 @embedpdf/pdfium 的 pdfium.wasm。" +
            "它是 @embedpdf/react-pdf-viewer 的传递依赖 —— 装了回去再构建。",
        );
      }
      const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version as string;
      try {
        if (readFileSync(versionFile, "utf8").trim() === version
          && assetTreeComplete(join(pkgDir, "dist/pdfium.wasm"), join(publicDir, "pdfium.wasm"))) return;
      } catch {
        /* 标记不存在 = 还没复制过 */
      }
      mkdirSync(publicDir, { recursive: true });
      cpSync(join(pkgDir, "dist/pdfium.wasm"), join(publicDir, "pdfium.wasm"));
      writeFileSync(versionFile, version, "utf8");
      // eslint-disable-next-line no-console
      console.log(`[mcode:pdfium] copied pdfium.wasm for @embedpdf/pdfium ${version}`);
    },
  };
}

function copyPdfjsAssets(): Plugin {
  const publicDir = resolve(__dirname, "src/renderer/public/pdfjs");
  const versionFile = join(publicDir, ".pdfjs-version");
  const subdirs = ["cmaps", "standard_fonts"];
  return {
    name: "mcode:copy-pdfjs-assets",
    buildStart() {
      const version = JSON.parse(readFileSync(join(pdfjsPkgDir, "package.json"), "utf8")).version;
      try {
        if (readFileSync(versionFile, "utf8").trim() === version
          && subdirs.every(sub => assetTreeComplete(join(pdfjsPkgDir, sub), join(publicDir, sub)))) return;
      } catch {
        // 标记不存在 = 还没复制过
      }
      for (const sub of subdirs) {
        cpSync(join(pdfjsPkgDir, sub), join(publicDir, sub), { recursive: true });
      }
      writeFileSync(versionFile, version, "utf8");
      // eslint-disable-next-line no-console
      console.log(`[mcode:pdfjs] copied ${subdirs.join(" + ")} for pdfjs ${version}`);
    },
  };
}

// electron-vite 3 scans rendered text for the "last import", including words in
// translation strings. Supply its Node 20.11+ shim as a Rollup banner so it sees
// the complete shim and does not inject declarations into a string literal.
// The supported Electron runtime has import.meta.filename/dirname. Keep in sync with electron-vite.
const mainEsmBanner = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

export default defineConfig({
  main: {
    // Providers resolve both Zod 3 and Zod 4 peers. Externalizing "zod/v4"
    // flattens it onto the app's Zod 3.24 runtime package, which has no such
    // export. Bundle schema peers (and their converter) at their resolved paths.
    plugins: [externalizeDepsPlugin({ exclude: ["zod", "zod-to-json-schema"] })],
    build: {
      lib: { entry: "src/main/index.ts" },
      rollupOptions: {
        // contracts is a workspace source package — bundle it into main.
        // sql.js (asm.js build) is externalized and required at runtime like
        // electron — its ~6MB asm.js file is too large to inline cleanly.
        // node-pty is a native addon — must load from node_modules at runtime
        // (never bundle the .node binary into the main chunk).
        external: ["electron", "sql.js", /^sql\.js\//, "node-pty"],
        output: { banner: mainEsmBanner },
      },
    },
    resolve: {
      alias: [
        {
          // 【ARC-007 P1/GA1】slides 的 vendor 依赖入口：`genoffice/` 是 gitignored
          // 快照，未安装的机器上它不存在。快照在场 → 真实现（静态 import 三个
          // vendor 包，构建期打包）；不在场 → stub（同一组导出、vendorAvailable=false，
          // 装配层据此不 attach，能力报告如实报 false）。
          //
          // 用**精确匹配**的 alias 数组项而不是对象键：对象键在 Rollup 的 alias
          // 插件里是前缀匹配，`@main` 那条会把 `@main/document/...` 也一起吞掉
          // （顺序敏感）。精确正则保证只有这一个说明符被改写。
          find: /^@main\/document\/docsVendorIpc\.js$/,
          replacement: existsSync(resolve("../../genoffice/apps/docs/src/main/mcode-ipc.ts"))
            ? resolve("../../genoffice/apps/docs/src/main/mcode-ipc.ts")
            : resolve("src/main/document/docsVendorIpc.ts"),
        },
        {
          find: /^@main\/document\/genofficeViewAiVendor\.js$/,
          replacement: existsSync(resolve("../../genoffice/apps/pdf/src/main/mcode-view-ai.ts"))
            ? resolve("src/main/document/genofficeViewAiVendor.ts")
            : resolve("src/main/document/genofficeViewAiVendorStub.ts"),
        },
        {
          find: /^@main\/document\/genofficeNativeVendor\.js$/,
          replacement: ["pdf", "markdown", "html"].every(kind =>
            existsSync(resolve("../../genoffice/apps", kind, "src/main", `${kind}-main.ts`)))
            ? resolve("src/main/document/genofficeNativeVendor.ts")
            : resolve("src/main/document/genofficeNativeVendorStub.ts"),
        },
        {
          find: /^@main\/document\/slidesVendorModules\.js$/,
          replacement: existsSync(resolve("../../genoffice/packages/pptx-engine/package.json"))
            ? resolve("src/main/document/slidesVendorModules.ts")
            : resolve("src/main/document/slidesVendorModulesStub.ts"),
        },
        ...slidesVendorAliases(),
        ...(existsSync(resolve("../../genoffice/packages/font-metrics/src/index.ts"))
          ? [{ find: "@genoffice/font-metrics", replacement: resolve("../../genoffice/packages/font-metrics/src/index.ts") }]
          : []),
        { find: "@contracts", replacement: resolve("../../packages/contracts/src") },
        { find: "@main", replacement: resolve("src/main") },
        // Only the pure translation core is shared with main; never externalize this source alias.
        {
          find: "@renderer/lib/i18n/core.js",
          replacement: resolve("src/renderer/lib/i18n/core.ts"),
        },
      ],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Two preload bundles:
      //  - index: the main window's preload (contextBridge API).
      //  - browserPicker: a minimal preload for the embedded browser
      //    WebContentsView, exposing only `window.mcodeBridge.pickElement`
      //    so the picker script (injected into the page's main world) can
      //    forward clicked elements to main without leaking any Node API.
      lib: {
        entry: {
          index: "src/preload/index.ts",
          browserPicker: "src/preload/browserPicker.ts",
        },
      },
      rollupOptions: { external: ["electron"] },
    },
    resolve: {
      alias: [
        {
          // ARC-007: bundle the vendor's own sandboxed Docs view preload.
          // genoffice/ is a separate ignored Git clone. Missing source must
          // retain the old restricted Mcode stub rather than enabling IPC.
          find: /^@main\/document\/docsVendorPreload\.js$/,
          replacement: existsSync(resolve("../../genoffice/apps/docs/src/preload/mcode-view.ts"))
            ? resolve("../../genoffice/apps/docs/src/preload/mcode-view.ts")
            : resolve("src/main/document/docsVendorPreload.ts"),
        },
        { find: "@contracts", replacement: resolve("../../packages/contracts/src") },
        { find: "@main", replacement: resolve("src/main") },
      ],
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      // Standard app mode (NOT lib mode): the renderer is loaded via
      // `window.loadFile()` and runs as a normal web page, so Vite must emit
      // the entry as a hashed ESM asset (`assets/index-xxxx.js`) referenced by
      // an external <script type="module">. lib mode would instead produce a
      // UMD bundle (`desktop.umd.cjs`) that <script type="module"> can't load
      // under file:// (wrong MIME: text/plain) and that violates the prod CSP.
      rollupOptions: {
        // Two HTML entries, two transports:
        //  - index: the full desktop/mobile-shell bundle (main.tsx).
        //  - pair: a dependency-free pairing page (pair.ts) served to phones
        //    that scan the QR link — a few KB instead of the full bundle.
        //    See main/mobile/serveMobileStatic.ts for the routing.
        input: {
          index: resolve("src/renderer/index.html"),
          pair: resolve("src/renderer/pair.html"),
        },
      },
    },
    resolve: {
      alias: [
        { find: "@contracts", replacement: resolve("../../packages/contracts/src") },
        { find: "@renderer", replacement: resolve("src/renderer") },
        // Monaco worker entries — alias the documented `esm/vs/...` import
        // paths straight to the on-disk files. Without this, monaco-editor's
        // `exports` wildcard re-maps them to a non-existent doubled path and
        // Vite's `?worker` resolver fails. The alias is path-prefix based, so
        // every worker import (`monaco-editor/esm/vs/.../x.worker?worker`)
        // lands at `${monacoPkgDir}/esm/vs/.../x.worker`.
        { find: "monaco-editor/esm/vs", replacement: resolve(monacoPkgDir, "esm/vs") },
      ],
    },
    // monaco-editor must be EXCLUDED from the dep optimizer: its worker
    // entries (`?worker` imports in monacoSetup.ts) can't be pre-bundled, and
    // including the package makes Vite route those imports into the (empty)
    // .vite/deps cache. Excluding lets the `?worker` imports flow through the
    // normal worker pipeline. The alias above still points them at the real
    // on-disk files.
    optimizeDeps: {
      exclude: ["monaco-editor"],
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler", {}]],
        },
      }),
      copyPdfjsAssets(),
      copyPdfiumWasm(),
    ],
    worker: {
      // Monaco's workers are plain ESM modules; build them as ESM too so the
      // `?worker` imports resolve cleanly under Vite's worker pipeline.
      format: "es",
    },
  },
});
