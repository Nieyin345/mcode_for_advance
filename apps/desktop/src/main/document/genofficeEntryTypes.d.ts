interface GenofficeMcodePaneGuard {
  ownsSender(sender: unknown): boolean;
  containsPath(path: string): boolean;
  documentPath(sender: unknown): string | null;
  audit(channel: string, category: "A" | "B" | "C", outcome: string): void;
}

/** Native GenOffice app main imports are build aliases to optional TS source.
 * Keep the app's very large source tree out of Mcode's typecheck graph. */
declare module "@main/document/genofficeSheetsEntry.js" {
  import type { WebContents, WebContentsView } from "electron";
  export function configureSheetsRuntime(config: {
    preloadPath: string; rendererFile: string; rendererUrl?: string;
    sidecarPath?: string; openGeneratedPath?: (path: string) => boolean;
    mcodePaneGuard?: GenofficeMcodePaneGuard;
  }): void;
  export function createSheetsView(options?: { includeAiHandlers?: boolean; openingWorkbook?: boolean }): WebContentsView;
  export function queueWorkbookForView(contents: WebContents, path: string): void;
  /** T29: vendor 的关闭守卫（脏时弹 保存/放弃/取消，选保存走渲染端自己的保存链）。 */
  export function requestSheetsClose(contents: WebContents, parent?: unknown): Promise<boolean>;
}
declare module "@main/document/genofficeSlidesEntry.js" {
  import type { WebContentsView } from "electron";
  export function configureSlidesRuntime(config: {
    preloadPath: string; rendererFilePath: string; rendererDevUrl?: string;
    openGeneratedPath?: (path: string) => boolean;
    mcodePaneGuard?: GenofficeMcodePaneGuard;
  }): void;
  export function createSlidesView(openPath?: string | null): WebContentsView;
}
