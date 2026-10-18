/**
 * 【MC-054】真 Electron 并发 U1 的**主进程端口替身**。
 *
 * 探针要 import 真的 `ipc/orchestration.ts`（`registerWorkflowHandlers`）与真的
 * `appControl/tools.ts`（`invokeAppTool` 的 `app_api_call` 通路）。这两条依赖链会拖进：
 *   - `@main/window.js` —— 真的那个 import 了语音引擎原生模块（sherpa-onnx `.node`），
 *     esbuild 在 node 平台下解析不了；本套只借它的 `sendToRenderer` 与窗口查询，
 *     真 Electron 下用 `BrowserWindow.getAllWindows()` 等价实现；
 *   - `@main/claude/RuntimeManager.js` —— 真的那个会拉起三家引擎 SDK；模板保存这条
 *     路一次都用不到它，只补 `automationRunner` / `runner` 顶层要的那些成员
 *     （被调到也不该被执行 —— 需要的地方会显式抛）；
 *   - `providers/registry.js` —— 同上，只为让 import 图能打包；
 *   - `probeProviderHealth` —— 真被调用说明走到了本套不该走的路，显式抛。
 *
 * 与 `module-phase2-e2e-smoke/native-ports.ts` 同一个理由与同一种姿势：**只换无关端口，
 * 不换被测模块**。
 */
import { BrowserWindow } from "electron";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";

function forbidden(name: string): never {
  throw new Error(`watch-templates-cas-electron-smoke 不该走到 ${name}`);
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

export function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

export function hasLiveRendererWindow(): boolean {
  return getMainWindow() !== null;
}

export function updateTitleBarOverlay(): void {
  /* 本套不关心标题栏 */
}

export function createMainWindow(): never {
  return forbidden("createMainWindow");
}

export const runtimeManager = {
  bindSession: (_session: Session): void => {},
  isBusy: (_id: string): boolean => false,
  isTurnEndHeld: (_id: string): boolean => false,
  holdTurnEnd: (_id: string, _held: boolean): void => {},
  holdTurnText: (_id: string, _text: string | null): void => {},
  subscribe: (_listener: (event: RuntimeEvent) => void): (() => void) => () => {},
  emitExternal: (_event: RuntimeEvent): void => {},
  echoUserMessage: (): never => forbidden("runtimeManager.echoUserMessage"),
  sendTurn: (): never => forbidden("runtimeManager.sendTurn"),
  interrupt: (): never => forbidden("runtimeManager.interrupt"),
  setInteractiveProxy: (): never => forbidden("runtimeManager.setInteractiveProxy"),
  setPermissionMode: (): never => forbidden("runtimeManager.setPermissionMode"),
  dispose: (_id: string): void => {},
  usageOf: (): undefined => undefined,
  transcriptOf: (): undefined => undefined,
};

export const providerRegistry = {
  list: (): [] => [],
  get: (): undefined => undefined,
};

export function probeProviderHealth(): never {
  return forbidden("probeProviderHealth");
}
