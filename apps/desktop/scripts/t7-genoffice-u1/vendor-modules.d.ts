/**
 * T7 —— vendor（`genoffice/`，gitignored 快照）的最小类型声明（**只服务 typecheck**）。
 *
 * `apps/desktop/tsconfig.json` 把 `scripts` 收进 include。T7 的夹具模块在**运行时**
 * 用 `require(...)` 加载 vendor 的 TS 源码（由 `vendor-esbuild.mjs` 的 alias 与
 * `prebuild` 打进 journeys bundle），但这台机器的 TS 工程没有 vendor 的路径映射，
 * `require("../../genoffice/...")` 这类字符串也不参与类型解析。
 *
 * 所以这里不声明模块名（那会让 TS 去跟随 vendor 源码、把 JSZip 的全局类型也搅乱），
 * 只声明**夹具模块内部**用到的两个最小接口；调用点自己断言形状。
 * 形状与 vendor 源码逐字对应（见各条注释里的出处）。
 */
export {};

declare global {
  /**
   * `genoffice/packages/docx-engine/src/index.ts` 的 `buildBlankDocx`。
   * 夹具只用到「返回一份合法空 DOCX 字节」这一条契约。
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface T7DocxEngine {
    buildBlankDocx(options?: { paperSize?: string }): Promise<Uint8Array>;
  }

  /**
   * `genoffice/packages/pptx-engine/src/index.ts` 的四个导出
   *（`createBlankPptx`/`openPptx`/`addElement`/`savePptx`）。
   */
  interface T7PptxEngine {
    createBlankPptx(): Promise<Uint8Array>;
    openPptx(bytes: Uint8Array): Promise<{
      deck: { slides: Array<{ elements: unknown[] }>; size: { cx: number; cy: number } };
    }>;
    addElement(slide: unknown, opts: Record<string, unknown>): { id?: string };
    savePptx(opened: unknown): Promise<Uint8Array>;
  }

  /** `genoffice/packages/electron-utils/src/print-html-pdf.ts` 的两个导出。 */
  interface T7PrintHtml {
    buildPrintableHtml(title: string, bodyHtml: string): string;
    printHtmlToPdf(
      html: string,
      createWindow: () => import("electron").BrowserWindow,
    ): Promise<Uint8Array>;
  }

  /** `jszip` 的 CJS 构造器（vendor node_modules 里那一份）。 */
  interface T7JSZip {
    loadAsync(data: Uint8Array): Promise<unknown>;
    file(path: string, content: string): void;
    generateAsync(opts: { type: "uint8array"; compression: string }): Promise<Uint8Array>;
  }
  type T7JSZipCtor = new () => T7JSZip;
}
