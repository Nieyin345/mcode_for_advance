/**
 * 主进程 → 界面的指令通道。
 *
 * 切对话、开文件、开面板、像用户一样发消息 —— 这些状态只在渲染端 store 里。没有走新的
 * IPC 通道,而是 `webContents.executeJavaScript` 调渲染端挂在 `window` 上的入口
 * (`renderer/lib/appControlHost.ts`):返回值就是那次调用的 Promise 结果,一来一回,
 * 不用在 preload / RpcMap 上再开口子。来回传的都是 JSON 字符串,避开结构化克隆的坑。
 */
import { APP_CONTROL_RENDERER_GLOBAL, type AppUiCommand, type AppUiReply } from "@contracts/appControl";

export const UI_COMMAND_TIMEOUT_MS = 30_000;

export interface RendererPort {
  /** 在界面里执行一段 JS,返回它的结果。窗口没开 → 抛错。 */
  executeJavaScript(code: string): Promise<unknown>;
}

let portOverride: RendererPort | null = null;

/** 测试用:换掉真正的窗口。 */
export function setRendererPortForTest(port: RendererPort | null): void {
  portOverride = port;
}

async function defaultPort(): Promise<RendererPort> {
  const { getMainWindow } = await import("@main/window.js");
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    throw new Error("Mcode 主窗口没有打开,界面操作做不了");
  }
  return { executeJavaScript: (code) => win.webContents.executeJavaScript(code, true) };
}

export async function runUiCommand(cmd: AppUiCommand, timeoutMs = UI_COMMAND_TIMEOUT_MS): Promise<AppUiReply> {
  const port = portOverride ?? (await defaultPort());
  const g = JSON.stringify(APP_CONTROL_RENDERER_GLOBAL);
  const arg = JSON.stringify(JSON.stringify(cmd));
  const code =
    `(typeof window[${g}] === "function" ? window[${g}](${arg}) : ` +
    `Promise.resolve(JSON.stringify({ ok: false, error: "界面还没准备好(请稍后再试)" })))`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`界面 ${timeoutMs / 1000}s 内没有回应`)), timeoutMs);
  });
  try {
    const raw = await Promise.race([port.executeJavaScript(code), timeout]);
    if (typeof raw !== "string") return { ok: false, error: "界面返回了无法识别的结果" };
    const parsed = JSON.parse(raw) as AppUiReply;
    return typeof parsed === "object" && parsed !== null && typeof parsed.ok === "boolean"
      ? parsed
      : { ok: false, error: "界面返回了无法识别的结果" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
