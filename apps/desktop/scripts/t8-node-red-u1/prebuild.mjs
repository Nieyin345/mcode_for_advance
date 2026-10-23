/**
 * T8 —— `--prebuild=` 模块：把**生产的** `documentViewPreload.ts` 打到 buildDir。
 *
 * 理由与 T7 `prebuild.mjs` 逐条相同：`DocumentViewHost.resolveViewPreload()` 从
 * `__dirname` 取 `documentViewPreload.js`；探针 bundle 的 `__dirname` 是构建目录，
 * 所以在那里放一份**同源**产物（生产 preload 源码 + 生产 seam 的别名）。
 *
 * Node-RED 编辑器页本身不使用这个 preload（它只服务 GenOffice 文档页），但没有它
 * 宿主对普通文档视图会走 `resolveViewPreload() === undefined` 的降级分支 —— 给上
 * 更接近生产装配，且**不改产品源码**。
 */
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
  // 跨进程 owner 的子进程入口：**独立产物**（Electron-as-Node 直接执行，
  // 不能依赖 journeys.cjs 的导出；与 `electron-u1/build.mjs` 的 runner 同一条纪律）。
  await esbuild({
    entryPoints: [join(desktop, "scripts/t8-node-red-u1/child-owner.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: join(buildDir, "t8-child-owner.cjs"),
    logLevel: "error",
    external: ["electron"],
    alias: {
      // `FileExecutorOwnershipStore` 的 import 链会碰 logger（electron app.getPath）
      // 与 dataRoot（electron app.getPath("home")）；子进程里只要盘上事实 ——
      // 与 T4 套件同一对桩。
      "@main/lib/logger.js": join(desktop, "scripts/run-store-smoke/stubs/logger.ts"),
      "@main/lib/dataRoot.js": join(desktop, "scripts/run-store-smoke/stubs/dataRoot.ts"),
    },
  });
  console.log("T8 prebuild: documentViewPreload.js + t8-child-owner.cjs → " + buildDir);
}

import { join } from "node:path";
