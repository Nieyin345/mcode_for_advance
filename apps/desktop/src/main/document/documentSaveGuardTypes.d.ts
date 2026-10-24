/**
 * 【O10】vendor 保存接缝（`genoffice/packages/electron-utils/src/document-save-guard.ts`）
 * 在 **Mcode 侧**的类型面。
 *
 * 为什么不是直接 `import type { … } from "../../../genoffice/..."`：
 * vendor 是 gitignored 的可选快照，**它的源码树不进 Mcode 的 typecheck 图**
 * （`genofficeNativeVendor.ts` 里那几条 vendor import 都带 `@ts-ignore`，理由见
 * `genofficeEntryTypes.d.ts` 的注释：「Keep the app's very large source tree out of
 * Mcode's typecheck graph」）。把类型拖进来会让整棵 vendor 树进 tsc，快照缺失时
 * 更是直接失败。
 *
 * 所以这里只声明**这一个模块**的最小形状（与 vendor 实现逐字对应，改一处必须
 * 同步另一处）。
 *
 * ⚠️ **谁在守着这个同步**（如实，分三层）：
 *  - **类型面的漂移**由 typecheck 抓（vendor 改了签名而这里没改 → tsc 红）；
 *  - **调用点是否还在**由 `scripts/o2-conflict-u1-smoke/save-paths.ts` 的静态断言抓
 *    （`--classify-only`；锚点 `format: '<kind>'`，四个格式各一条）；
 *  - **「守卫在运行时真的拦住了」**由 O2 的 4a/4b 抓（要跑 Electron）。
 *
 * 三层缺任何一层，都会出现「这段话读起来像有保护、实际没有」。本文件最初那句
 * 「`save-paths.ts` 的静态断言会盯着调用点的原文」在写下时**还不成立**（那条断言
 * 当时尚未存在，是「写了计划但读起来像已完成」）；它现在是成立的，所以这句留下来。
 *
 * 运行时解析不受影响：主进程构建把 `@genoffice/*` 解析到
 * `genoffice/node_modules` 的符号链接（与 `@genoffice/i18n`、pptx 等同一通路）。
 */
declare module "@genoffice/electron-utils/document-save-guard" {
  export type DocumentSaveFormat = "pdf" | "markdown" | "html" | "slides";
  export interface DocumentSaveGuardContext {
    target: string;
    format: DocumentSaveFormat;
    write: () => Promise<void>;
  }
  export type DocumentSaveGuard = (ctx: DocumentSaveGuardContext) => Promise<void>;
  export function setDocumentSaveGuard(guard: DocumentSaveGuard | undefined): void;
  export function hasDocumentSaveGuard(): boolean;
  export function guardedDocumentSave(ctx: DocumentSaveGuardContext): Promise<void>;
}
