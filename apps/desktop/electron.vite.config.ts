import { readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { constants as zlibConstants, brotliCompressSync, gzipSync } from "node:zlib";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/**
 * Emits a `.gz` and a `.br` copy of every text asset right next to the
 * original in the build output. The mobile HTTP server
 * (`src/main/mobile/serveMobileStatic.ts`) picks these up via
 * `Accept-Encoding` and serves them with Content-Encoding — zero runtime CPU
 * cost, and the phone's cold start over a VPS/relay link drops from ~5.5MB to
 * ~1.3MB. HTML is intentionally skipped: it's tiny and must stay uncached.
 *
 * Compression runs in `closeBundle` against the FINAL files on disk (after
 * Vite's HTML plugin has rewritten the entry chunks and written everything),
 * NOT against `output.code` from `generateBundle`: the in-memory snapshot is a
 * transient intermediate where Vite has already substituted dynamic-import
 * deps with a `__VITE_PRELOAD__` marker that only becomes defined once the
 * rewritten HTML is emitted — compressing that snapshot produces broken
 * `.gz/.br` files (ReferenceError: __VITE_PRELOAD__ is not defined on the
 * phone, while the desktop file:// load works fine). Compressing the written
 * files guarantees the served bytes are identical to what the desktop loads.
 */
function precompressAssets(): Plugin {
  let outDir = "";
  let writeCompleted = false;
  return {
    name: "mcode:precompress",
    apply: "build",
    configResolved(config) {
      // Only the renderer build is served over HTTP (mobile server). The main
      // and preload outputs are lib builds loaded by Electron from disk —
      // compressed copies there would be dead weight in the installer.
      if (config.build.lib) return;
      outDir = config.build.outDir;
    },
    writeBundle() {
      // closeBundle also fires on failed builds (after a partial write);
      // only compress when the write phase actually completed.
      writeCompleted = true;
    },
    closeBundle() {
      if (!outDir || !writeCompleted) return;
      const files = walkTextFiles(outDir);
      const started = Date.now();
      let count = 0;
      for (const file of files) {
        const source = readFileSync(file);
        if (source.length === 0) continue;
        writeFileSync(`${file}.gz`, gzipSync(source, { level: 9 }));
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(source, {
            // q9 ≈ 98% of q11's ratio at a fraction of the wall time (the
            // renderer output is ~40MB of JS; q11 adds ~70s to every build).
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
          }),
        );
        count++;
      }
      if (count > 0) {
        console.log(`[mcode:precompress] ${count} files → .gz/.br in ${Date.now() - started}ms`);
      }
    },
  };
}

/** Recursively collect text assets (JS/CSS/JSON/SVG) under a directory.
 *  Skips any file that is itself a precompressed variant and HTML. */
function walkTextFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTextFiles(full));
    } else if (/\.(js|mjs|css|json|svg)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

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
function copyPdfjsAssets(): Plugin {
  const publicDir = resolve(__dirname, "src/renderer/public/pdfjs");
  const versionFile = join(publicDir, ".pdfjs-version");
  const subdirs = ["cmaps", "standard_fonts"];
  return {
    name: "mcode:copy-pdfjs-assets",
    buildStart() {
      const version = JSON.parse(readFileSync(join(pdfjsPkgDir, "package.json"), "utf8")).version;
      try {
        if (readFileSync(versionFile, "utf8").trim() === version) return;
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "src/main/index.ts" },
      rollupOptions: {
        // contracts is a workspace source package — bundle it into main.
        // sql.js (asm.js build) is externalized and required at runtime like
        // electron/zod — its ~6MB asm.js file is too large to inline cleanly.
        // node-pty is a native addon — must load from node_modules at runtime
        // (never bundle the .node binary into the main chunk).
        external: ["electron", "zod", "sql.js", /^sql\.js\//, "node-pty"],
      },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Three preload bundles:
      //  - index: the main window's preload (contextBridge API).
      //  - browserPicker: a minimal preload for the embedded browser
      //    WebContentsView, exposing only `window.mcodeBridge.pickElement`
      //    so the picker script (injected into the page's main world) can
      //    forward clicked elements to main without leaking any Node API.
      //  - webAgentTap: same lockdown, different method — the web-agent engine
      //    view forwards the SSE text its injected tap script overheard
      //    (`window.mcodeBridge.dsTapEvent`) so main can frame + parse it.
      lib: {
        entry: {
          index: "src/preload/index.ts",
          browserPicker: "src/preload/browserPicker.ts",
          // 网页版大模型引擎视图的 preload（tap 数据回传桥）。
          webAgentTap: "src/preload/webAgentTap.ts",
        },
      },
      rollupOptions: { external: ["electron"] },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
      },
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
      precompressAssets(),
      copyPdfjsAssets(),
    ],
    worker: {
      // Monaco's workers are plain ESM modules; build them as ESM too so the
      // `?worker` imports resolve cleanly under Vite's worker pipeline.
      format: "es",
    },
  },
});
