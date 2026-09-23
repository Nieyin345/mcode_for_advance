/**
 * `@main/window.js` 的替身 —— 真的那个持有 `BrowserWindow`,import 链上就要求 Electron
 * 有窗口。
 *
 * ## 这两个函数在本套里的角色完全不同
 *
 * - `sendToRenderer` 是**观测点**:`lib/sessionSync.ts` 的广播最终落到它身上。本套据此
 *   分辨"这次会话行变动有没有推给别的客户端" —— 那正是手机上列表刷不刷新的判据。
 * - `updateTitleBarOverlay` 是**必须吞掉的副作用**:`ipc/claude.ts` 的 `SETTING_SET`
 *   在主题样式这一键上会调它重画原生标题栏,而无头环境里 `mainWindow` 是 null
 *   (**不是抛**,静默什么都不做)。真实现本来就不会炸,但这条断言要钉的是"设主题
 *   样式这一下不会把整次设置搞失败",所以这里让它什么都不做、并记一笔。
 *
 * ⚠️ 记的是**原始实参**,不是拼好的字符串:断言要能分辨 `session.changed` 与
 * `session.deleted`,拼过一道就看不出来了。
 */
export const sent: Array<{ channel: string; args: unknown[] }> = [];

/** 只回通道名 —— 绝大多数断言只关心"推了哪一类"。 */
export function sentChannels(): string[] {
  return sent.map((s) => s.channel);
}

/** 取某个通道的**载荷**。`sessionSync` 把它包在 `{channel, sessionId, event}` 里。 */
export function eventsOfType(type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of sent) {
    for (const a of s.args) {
      if (a && typeof a === "object" && (a as { event?: { type?: string } }).event?.type === type) {
        out.push(a as Record<string, unknown>);
      }
    }
  }
  return out;
}

export function resetSent(): void {
  sent.length = 0;
}

/** 原生标题栏重画的次数(`SETTING_SET` 收尾那一句会碰它)。 */
export let titleBarOverlayPaints = 0;
export function resetTitleBarPaints(): void {
  titleBarOverlayPaints = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

export function updateTitleBarOverlay(): void {
  // 无头环境:没有窗口可画。真的那边 `mainWindow?.` 也是同样的行为。
  titleBarOverlayPaints += 1;
}

export function getMainWindow(): null {
  return null;
}

export function createMainWindow(): never {
  throw new Error("claude-ipc-smoke:不该建窗口");
}