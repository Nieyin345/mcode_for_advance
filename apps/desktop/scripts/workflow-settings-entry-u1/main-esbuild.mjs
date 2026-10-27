/**
 * W26 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加 esbuild 选项
 * （与 `t8-node-red-u1/main-esbuild.mjs` 同一取舍，逐条对应）。
 *
 * 旅程注册表要 import **生产主进程模块**（workflowEngines / document /
 * orchestration）。它们默认能被 esbuild 解析（`@main/*` / `@contracts/*` 由
 * tsconfig 的 paths 生效），但有三处需要构建期处理：
 *
 *  1. **`@main/window.js`**：生产 `window.ts` 拖进语音原生模块（sherpa-onnx），
 *     本套件不需要；别名到 `window-holder.ts`（T7/T8 同一取舍）。
 *  2. **GenOffice vendor 快照**（`genoffice/`，gitignored）：`documentViewHost`
 *     的构造链 import `genofficeNativeVendor.js` / `slidesVendorModules.js`。
 *     W26 的判据不涉及任何 GenOffice 编辑器 —— 别名到仓库自带的 fail-closed
 *     stub（与没装 vendor 时的生产构建**同源**，见 `electron.vite.config.ts`）。
 *  3. 原生模块与 `electron` 保持 external。
 *
 * ⚠️ 与 T8 的差异只有一处：**没有 child-owner 那条 esbuild 产物**（本套件不需要
 * 跨进程 owner 验证），所以 `prebuild.mjs` 只打 `documentViewPreload.js`。
 */
import { resolve } from "node:path";

export const options = {
  alias: {
    "@main/window.js": resolve("scripts/workflow-settings-entry-u1/window-holder.ts"),
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
