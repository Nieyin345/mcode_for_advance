/**
 * 【ARC-007 P1/GA1】vendor 包的**类型垫片**（仅类型，不产生运行时代码）。
 *
 * `genoffice/` 是 gitignored 快照：它的 TypeScript 源码不能被 Mcode 的 tsc
 * 纳入（不同 tsconfig、数千文件、且可能在机器上不存在）。而
 * `slidesVendorModules.ts` 需要**静态 import** 它们（构建期打包）。
 *
 * 所以这里按**实际用到的导出**声明最小面 —— 每一条都对照 vendor 源码写过：
 *
 *  - `openPptx(bytes)` / `savePptxToFile(opened, path)` / `createBlankPptx()` /
 *    `commitSaved(opened)`：`packages/pptx-engine/src/index.ts:662,729,146,771`；
 *  - `buildRenderSlide(slide, size, opts)` / `HeuristicMetrics`：
 *    `packages/pptx-render/src/build-slide.ts:132`、`metrics.ts`；
 *  - `runTxn(opened, req)`：`packages/pptx-ops/src/ops/executor.ts:160`。
 *
 * 形状故意用 `unknown`/宽松记录：真正的形状校验在 `slidesExecutor.ts` 运行时
 * 做（`typeof fn === "function"` + 返回值结构），本文件不让类型层假装知道
 * vendor 的全部细节。
 */
declare module "@genoffice/pptx-engine" {
  export function openPptx(bytes: Uint8Array): Promise<unknown>;
  export function savePptxToFile(opened: unknown, filePath: string): Promise<void>;
  export function createBlankPptx(): Promise<Uint8Array>;
  export function commitSaved(opened: unknown): void;
}

declare module "@genoffice/pptx-render" {
  export function buildRenderSlide(
    slide: unknown,
    size: unknown,
    opts: Record<string, unknown>,
  ): unknown;
  export class HeuristicMetrics {
    constructor();
  }
}

declare module "@genoffice/pptx-ops" {
  export interface VendorTxnResult {
    applied: boolean;
    failures?: Array<{ index: number; error: string }>;
    records?: Array<Record<string, unknown>>;
  }
  export function runTxn(opened: unknown, req: Record<string, unknown>): VendorTxnResult;
}

/**
 * 构建期别名（`electron.vite.config.ts`）：mcode 源码 import 的**稳定说明符**，
 * 真实构建解析到 `slidesVendorModules.ts`，无 vendor 快照时解析到
 * `slidesVendorModulesStub.ts`。类型上两者同形。
 */
declare module "@main/document/slidesVendorModules.js" {
  export const vendorAvailable: boolean;
  export const vendorSlidesModules: {
    openPptx: (bytes: Uint8Array) => Promise<unknown>;
    savePptxToFile: (opened: unknown, filePath: string) => Promise<void>;
    createBlankPptx: () => Promise<Uint8Array>;
    commitSaved: (opened: unknown) => void;
    buildRenderSlide: (slide: unknown, size: unknown, opts: Record<string, unknown>) => unknown;
    HeuristicMetrics: new () => unknown;
    runTxn: (opened: unknown, req: Record<string, unknown>) => {
      applied: boolean;
      failures?: Array<{ index: number; error: string }>;
      records?: Array<Record<string, unknown>>;
    };
  };
}

