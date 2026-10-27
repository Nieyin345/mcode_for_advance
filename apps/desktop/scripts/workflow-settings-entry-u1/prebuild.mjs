/**
 * W26 —— `--prebuild=` 模块：把**生产的** `documentViewPreload.ts` 打到 buildDir。
 *
 * 理由与 T7/T8 逐条相同：`DocumentViewHost.resolveViewPreload()` 从 `__dirname`
 * 取 `documentViewPreload.js`；探针 bundle 的 `__dirname` 是构建目录，所以在那里
 * 放一份**同源**产物（生产 preload 源码 + 生产 seam 的别名）。
 *
 * Node-RED 编辑器页本身不使用这个 preload（它只服务 GenOffice 文档页），但没有它
 * 宿主对普通文档视图会走 `resolveViewPreload() === undefined` 的降级分支 ——
 * 给上更接近生产装配，且**不改产品源码**。
 *
 * ⚠️ 与 T7 的差异：T7 把 `docsVendorPreload.js` 别名到 genoffice vendor 的受限桥。
 * 本套件对 GenOffice 零依赖，**不引入那条 alias** —— 走仓库自带的 fail-closed
 * stub（`src/main/document/docsVendorPreload.ts`，与 `genoffice/` 缺席时的生产
 * 构建同一条 seam）。Node-RED 页面不消费它。
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export async function prepare({ buildDir, desktop, esbuild }) {
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
  });

  /**
   * ## 页面：**不用** `electron-u1` 的 `page.html`（它让 `api` 变成 fixture 桩）
   *
   * `electron-u1/build.mjs` 把 `renderer/lib/api.ts` 换成 `export const api=window.labApi`，
   * 而它自己的 `page.html` 先加载 `api-stub.js`（一个内存 Proxy）→ `window.labApi` 是桩。
   * **本卡的判据必须走真 IPC**（`api.workflowEngine.start` / `api.documentView.open`），
   * 桩的话「视图真的开了」永远不会发生，而 DOM 断言照样绿 —— 那就是假绿。
   *
   * 所以这里写一个同形页面，顺序改成：**先把 `window.labApi` 指到产品真 preload 暴露的
   * `window.api`**，再加载同一个 `bundle.js`。`api.ts` 的 stub 因此绑定到真桥，
   * 页面其余部分（真 `App.tsx`、真 store）与 `electron-u1` 逐字节相同。
   *
   * CSP 与 `electron-u1` 的页面一致：不联网。`'unsafe-inline'` 是给下面那段赋值用的
   * （它是唯一的内联脚本）。
   */
  writeFileSync(
    join(buildDir, "real-api-page.html"),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src 'none'">
<title>mcode w26 harness</title><link rel="stylesheet" href="./app.css"></head>
<body style="margin:0"><div id="root" style="height:100vh"></div>
<script>window.labApi = window.api; if (!window.api) { window.__w26NoApi = true; }</script>
<script src="./bundle.js"></script></body></html>`,
  );

  console.log("W26 prebuild: documentViewPreload.js + real-api-page.html → " + buildDir);
}
