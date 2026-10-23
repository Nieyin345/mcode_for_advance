/**
 * T8 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加 esbuild 选项。
 *
 * 旅程注册表要 import **生产主进程模块**（workflowEngines / document / orchestration）。
 * 它们默认能被 esbuild 解析（tsconfig 的 `@main/*` / `@contracts/*` paths 由
 * `--tsconfig` 生效），但有三处需要构建期处理：
 *
 *  1. **`@main/window.js`**：生产 `window.ts` 拖进语音原生模块（sherpa-onnx）——
 *     本套件不需要；别名到 `window-holder.ts`（与 T7 同一取舍）。
 *  2. **GenOffice vendor 快照**（`genoffice/`，gitignored）：`documentViewHost` 的
 *     构造链 import `genofficeNativeVendor.js` / `slidesVendorModules.js`。T8 的判据
 *     不涉及任何 GenOffice 编辑器，而 vendor 快照的存在与否是另一张卡（T25）的事。
 *     别名到仓库自带的 **fail-closed 构建 stub**（`*Stub.ts`），与没有 vendor 时的
 *     生产构建产物**同源**（`electron.vite.config.ts` 的同一处 seam）。
 *  3. 原生模块（`sherpa-onnx-node` / `node-pty` / `better-sqlite3` / `cpu-features`）
 *     与 `electron` 保持 external。
 *
 * 这里**不修改**生产构建配置：它只是本套件的构建输入。
 */
import { resolve } from "node:path";

export const options = {
  alias: {
    "@main/window.js": resolve("scripts/t8-node-red-u1/window-holder.ts"),
    "@main/document/genofficeNativeVendor.js": resolve("src/main/document/genofficeNativeVendorStub.ts"),
    "@main/document/slidesVendorModules.js": resolve("src/main/document/slidesVendorModulesStub.ts"),
  },
  external: [
    "electron",
    "sherpa-onnx-node",
    "node-pty",
    "better-sqlite3",
    "cpu-features",
  ],
};
