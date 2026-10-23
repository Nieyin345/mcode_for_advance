/**
 * T7 —— `--prebuild=` 模块：把**生产的** `documentViewPreload.ts` 打到 buildDir。
 *
 * ## 为什么
 *
 * `DocumentViewHost.resolveViewPreload()` 返回 `join(__dirname, "documentViewPreload.js")`。
 * 发行构建里 `__dirname` 是 `out/main/`，T23 的插件从**同一份源码**
 * （`src/main/document/documentViewPreload.ts`，其 `@main/document/docsVendorPreload.js`
 * 在 electron.vite.config 的 preload 段别名到 vendor `mcode-view.ts`）产出该文件。
 * 探针 bundle 里 `__dirname` 是构建目录 —— 所以在那里放一份**同源同别名**的产物，
 * 验的就是「生产 preload 源码 + vendor 受限桥」这条真实链路，而不是探针自造的桥。
 *
 * 这与 `document-view-open-smoke/build.mjs` 的做法逐项一致（同 entry、同 alias、同
 * CJS 形状）；差异只在输出目录（那边是套件临时目录，这里是 runner 的 `__dirname`）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function prepare({ buildDir, desktop, repo, esbuild }) {
  const vendorDocsPreload = join(repo, "genoffice/apps/docs/src/preload/mcode-view.ts");
  await esbuild({
    entryPoints: [join(desktop, "src/main/document/documentViewPreload.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: join(buildDir, "documentViewPreload.js"),
    logLevel: "error",
    external: ["electron"],
    alias: {
      "@main/document/docsVendorPreload.js": existsSync(vendorDocsPreload)
        ? vendorDocsPreload
        : join(desktop, "src/main/document/docsVendorPreload.ts"),
    },
  });
  console.log("T7 prebuild: documentViewPreload.js (生产源码 + vendor 受限桥) → " + buildDir);
}
