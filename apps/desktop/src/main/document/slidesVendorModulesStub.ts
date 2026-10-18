/**
 * 【ARC-007 P1/GA1】`slidesVendorModules.ts` 的**无 vendor 快照**替身。
 *
 * `electron.vite.config.ts` 在 `genoffice/`（gitignored 快照）不存在时把
 * `@main/document/slidesVendorModules.js` 别名到本文件。它导出同一组名字，
 * 但 `vendorAvailable = false`、每个函数都显式抛错 —— 装配层看到 false 就不
 * 会调用它们（本文件的价值是让**构建**在没有 vendor 的机器上也能成功，
 * 而不是静默假装能力存在）。
 */
export const vendorAvailable = false;

function unavailable(name: string): never {
  throw new Error(`slides vendor 模块不可用（genoffice/ 快照未安装）：${name}`);
}

export const vendorSlidesModules = {
  openPptx: () => unavailable("openPptx"),
  savePptxToFile: () => unavailable("savePptxToFile"),
  createBlankPptx: () => unavailable("createBlankPptx"),
  commitSaved: () => unavailable("commitSaved"),
  buildRenderSlide: () => unavailable("buildRenderSlide"),
  HeuristicMetrics: class {
    constructor() {
      unavailable("HeuristicMetrics");
    }
  },
  runTxn: () => unavailable("runTxn"),
};
