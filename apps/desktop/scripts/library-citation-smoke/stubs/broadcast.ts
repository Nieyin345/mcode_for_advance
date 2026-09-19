/**
 * `@main/library/broadcast.ts` 的替身 —— 真的那个 import 了 `@main/window.js`(要
 * electron)与 `@main/claude/RuntimeManager.js`(要拉起 SDK 子进程)。
 *
 * ## 为什么要换它
 *
 * import 图是 `citationExport.ts` → `repositories.js` → `library/broadcast.js`:
 * 导出这条路一次都不发广播,但**静态 import 会把它整条拖进来**。在 broadcast 这一刀
 * 切掉,window 与 RuntimeManager 就都不用进这个 bundle —— 与
 * `library-import-smoke` / `mcode-admin-smoke` 同一个切法。
 *
 * 它不是空实现:真被调到了(说明"导出顺手发了广播"这件事真的发生了)会**立刻显形**,
 * 而不是安静地什么也不做。
 */
function notHere(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`本套不该走到 library/broadcast.${name}`);
  };
}

export const notifyLibraryChanged = notHere("notifyLibraryChanged");
export const emitItemImported = notHere("emitItemImported");
export const emitItemDownloaded = notHere("emitItemDownloaded");
