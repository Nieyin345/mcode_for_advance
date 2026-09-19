/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * `ipc/plugins.ts` 只从它身上取一件东西:`runningSessionIds()`,用来在"还有回合在跑"
 * 时拒绝卸载插件。所以桩里就要有**能拨动的**那个数 —— 这条闸门是本套要钉的一条,
 * 永远返回 `[]` 的桩等于没验(那样"拒绝卸载"那条路一次都走不到)。
 *
 * `__setRunning` 是桩自己的开关:`main.ts` 直接 import 本模块,和被测代码拿到的是
 * **同一个模块实例**(run.sh 里用 `--alias` 换的,不是相对路径转发),所以拨得动。
 */
let running: string[] = [];

export const runtimeManager = {
  runningSessionIds(): string[] {
    return [...running];
  },
  /** 仅供本套:伪造"这些会话的回合正在跑"。 */
  __setRunning(ids: string[]): void {
    running = [...ids];
  },
};
