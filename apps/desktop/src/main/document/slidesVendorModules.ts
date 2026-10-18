/**
 * 【ARC-007 P1/GA1】**vendor 依赖的唯一静态入口**。
 *
 * `slidesExecutor.ts` 只 import 本模块的具名导出；真实实现（本文件）静态 import
 * 三个 vendor 包，由构建器（electron-vite）在构建期打包 —— vendor 包是指向
 * TypeScript 源码的符号链接（`genoffice/node_modules/@genoffice/pptx-engine` →
 * `genoffice/packages/pptx-engine`），Node 运行时无法 `require`，所以**必须在
 * 构建期**解析，不能走运行期 `createRequire`（实测 MODULE_NOT_FOUND / 无法加载 .ts）。
 *
 * ## genoffice 快照缺失时
 *
 * `genoffice/` 是 gitignored 快照；未安装/未构建的机器上这三个 import 解析不到，
 * 构建会当场失败。`electron.vite.config.ts` 因此在快照缺失时把
 * `@main/document/slidesVendorModules.js` **别名到** `slidesVendorModulesStub.ts`
 * （同一组导出、`vendorAvailable=false`）。于是：
 *
 *  - 构建在任何机器上都成功（不会因为可选快照缺失而红）；
 *  - 装配层看到 `vendorAvailable=false` 就不 attach，桥 fail-closed，
 *    `document.capabilities.hosts.slides` 如实报告 false（面板显式降级）。
 */
import {
  openPptx,
  savePptxToFile,
  createBlankPptx,
  commitSaved,
} from "@genoffice/pptx-engine";
import { buildRenderSlide, HeuristicMetrics } from "@genoffice/pptx-render";
import { runTxn } from "@genoffice/pptx-ops";

/** 本模块是否来自**真实** vendor 源码（stub 为 false）。 */
export const vendorAvailable = true;

export const vendorSlidesModules = {
  openPptx,
  savePptxToFile,
  createBlankPptx,
  commitSaved,
  buildRenderSlide,
  HeuristicMetrics,
  runTxn,
};
