/**
 * `electron` 的替身 —— **记录型**,不是纯抛型。
 *
 * ## 为什么不能直接用现成的那份
 *
 * `scripts/library-delete-smoke/stubs/electron.ts` 是纯抛型:它证明"没走到"的办法是
 * **抛**,而本套要区分的是两件不同的事 ——
 *
 *   - 「**拒绝了**」(走到 handler 的围栏,`log.warn` 之后正常 resolve)
 *   - 「**根本没走到**」(连 `shell.openPath` 那一行都没执行)
 *
 * 这两件事在纯抛型下都是"抛了",分不开。所以这里要能**喂**返回值(dialog 的取消 /
 * 空 / 一串路径,`shell.openPath` 的失败字符串),也要能**数**调用次数。
 *
 * ## 没被用到的成员一律显式抛
 *
 * 安静返回 `undefined` 会让断言去猜"它到底调没调",而"猜"出来的绿是最贵的那种绿。
 * 真被调到了要立刻显形(同 library-mcp-smoke 里 browserManager 桩的取舍)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`dialog-shell-smoke 不该走到 electron.${name}`);
  };
}

/* ── dialog.showOpenDialog:能喂、能记 ── */

/** 每次 `showOpenDialog` 收到的参数原样存下来(验 filters/properties 有没有传下去)。 */
export const dialogCalls: Array<Record<string, unknown>> = [];

/** 预先排好的返回值。没排队就调 = 夹具摆错了,直接抛,别安静返回一个"取消"。 */
const dialogQueue: Array<{ canceled: boolean; filePaths: string[] }> = [];
export function pushDialogResult(result: { canceled: boolean; filePaths: string[] }): void {
  dialogQueue.push(result);
}

/** 清空调用记录**和**队列。每条断言前调一次,免得前面那条的余量影响这条。 */
export function resetDialog(): void {
  dialogCalls.length = 0;
  dialogQueue.length = 0;
}

export const dialog = {
  showOpenDialog: async (options: Record<string, unknown>) => {
    dialogCalls.push({ ...options });
    const next = dialogQueue.shift();
    if (!next) {
      throw new Error("dialog.showOpenDialog 被调了但脚本没喂返回值 —— pushDialogResult 少了一次");
    }
    return next;
  },
  showSaveDialog: notHere("dialog.showSaveDialog"),
  showMessageBox: notHere("dialog.showMessageBox"),
};

/* ── shell:*:能喂返回值、能数次数 ── */

export const shellCalls: Array<{ fn: string; path: string }> = [];

/** `shell.openPath` 的返回值:**非空字符串 = 失败**(真的那个是 `""` on success)。 */
export const openPathReturn = { value: "" };

export function resetShell(): void {
  shellCalls.length = 0;
  openPathReturn.value = "";
}

export const shell = {
  openPath: async (path: string) => {
    shellCalls.push({ fn: "openPath", path });
    return openPathReturn.value;
  },
  showItemInFolder: (path: string) => {
    shellCalls.push({ fn: "showItemInFolder", path });
  },
  openExternal: notHere("shell.openExternal"),
  trashItem: notHere("shell.trashItem"),
};

/* ── 其余成员:本套不该碰到 ── */

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/** 本套自己造了一个 `ipcMain`(记名替身),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
