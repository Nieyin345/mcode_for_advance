/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * LspManager 用它推 `lsp:event`。本套把每一条**按顺序记下来**,断言就立在
 * 「推给界面的那条消息里,用户读到的是什么」上 —— 不是立在内部字段上。
 *
 * ⚠️ 记录里带 `workspacePath` / `language` / `type` / `payload` 四件,因为
 * 「同一个语言在两个工作区各起一个 server」是本套要验的一条,只按 type 记会分不清。
 * 推消息时 `handle` 已经死了(比如退出后台清理),不静默吞掉,原样记下来让断言看见。
 */
import { IPC } from "@contracts/ipc";

export interface LspEvent {
  channel: string;
  workspacePath: string;
  language: string;
  type: string;
  payload: unknown;
}

/** 推给界面的全部 `lsp:event`(按顺序)。 */
export const lspEvents: LspEvent[] = [];

/** 非 `lsp:event` 的推送(不该发生,记下来让收尾的守卫抓)。 */
export const otherChannels: string[] = [];

export function resetSent(): void {
  lspEvents.length = 0;
  otherChannels.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (channel !== IPC.LSP_EVENT) {
    otherChannels.push(channel);
    process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(args[0] ?? {})}\n`);
    return;
  }
  const p = (args[0] ?? {}) as { workspacePath?: unknown; language?: unknown; type?: unknown; payload?: unknown };
  lspEvents.push({
    channel,
    workspacePath: String(p.workspacePath),
    language: String(p.language),
    type: String(p.type),
    payload: p.payload,
  });
}

/** 最后一条匹配的 `lsp:event`(按 workspacePath / language / type 过滤,三者都可省)。 */
export function lastEvent(
  type: string,
  match: { workspacePath?: string; language?: string } = {},
): LspEvent | undefined {
  for (let i = lspEvents.length - 1; i >= 0; i -= 1) {
    const e = lspEvents[i]!;
    if (e.type !== type) continue;
    if (match.workspacePath !== undefined && e.workspacePath !== match.workspacePath) continue;
    if (match.language !== undefined && e.language !== match.language) continue;
    return e;
  }
  return undefined;
}

/** 匹配到的 `lsp:event` 条数。 */
export function countEvents(
  type: string,
  match: { workspacePath?: string; language?: string } = {},
): number {
  return lspEvents.filter(
    (e) =>
      e.type === type &&
      (match.workspacePath === undefined || e.workspacePath === match.workspacePath) &&
      (match.language === undefined || e.language === match.language),
  ).length;
}

export function getMainWindow(): never {
  throw new Error("lsp-smoke 不该走到 getMainWindow");
}