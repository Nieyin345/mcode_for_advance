/**
 * `electron` 包的替身 —— 只给无头脚本用。
 *
 * 本套为什么要换掉**整个包**(而不是只换 `@main/window.js`):`main/ipc/templates.ts`
 * 自己就有一句 `import { shell } from "electron"`(给「用系统默认程序打开」那条),
 * 而 `main/lib/reveal.ts`(「在文件夹中打开」)也直接用它。顺着 alias 一个个堵会变成
 * 打地鼠,每漏一个报出来的都是 "Cannot determine intended module format" —— 看起来
 * 和"被测代码坏了"一模一样(理由与取舍见 library-delete-smoke/stubs/electron.ts)。
 *
 * ⚠️ **不是空实现,一律显式抛。** 真被调到了要立刻显形,而不是安静返回 undefined ——
 * 那会让断言去猜"这是成功还是没执行"。本套里 `shell` 与 `ipcMain` 都**一定不该**
 * 被走到:`ipcMain` 我们自己造了一个记名的(见 main.ts §0),`shell` 那两条
 * (openFile / 点按钮开文件夹)属于 Electron 的职责,不在套件范围内。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(
      `template-migration-smoke 不该走到 electron.${name}(本套不起 Electron,也不真开文件夹)`,
    );
  };
}

/**
 * `shell.openPath` **走到了哪个路径** —— 记下来,然后照旧显式抛。
 *
 * 为什么不只是抛:`openFile` 那道围栏有**两侧**要钉 —— 越界的必须被拦在
 * `shell.openPath` 之前,合法的必须真的送到它跟前。只抛的话,越界那一侧能靠
 * "进程崩了"看出来(红是红,但不是一条断言),而**合法那一侧根本没法验**:
 * 拦得过紧(把正当文件也挡了)在旧写法下完全看不出来(`res.ok === false` 一样成立)。
 * 所以先记一笔,再抛 —— main.ts §8 两条断言分别读这个数组是不是空的。
 */
export const openedPaths: string[] = [];

export const shell = {
  openPath: (p: string): never => {
    openedPaths.push(p);
    return notHere("shell.openPath")() as never;
  },
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/** 本套自己造了一个 `ipcMain`(记名替身),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
