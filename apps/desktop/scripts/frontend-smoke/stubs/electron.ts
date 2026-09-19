/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么可以直接替 `electron` 本身
 *
 * 前几套的做法是 `--alias:@main/window.js=...` 把**用到 electron 的那几个模块**换掉。
 * 那在这里不够:`NotificationManager` 拉进来的东西里,有的是 `import { Notification }
 * from "electron"` 直接写在文件里(而不是经由某个 `@main/*` 中转),顺着 alias 一个个
 * 去堵会变成打地鼠 —— 而每漏一个,报出来的都是"找不到模块 electron",看起来和
 * "被测代码坏了"一模一样。
 *
 * 换掉整个 `electron` 包更窄也更准:**本套要验的是"什么事件该不该弹通知"这个判断**,
 * 而这段判断里唯一用到 electron 的地方就是最后那个 `new Notification(...).show()`。
 * 在这里记下来,反而让"到底弹没弹、弹的是什么字"变成可断言的。
 *
 * ⚠️ **这不是空实现。** `show()` 被记进 {@link shown};`app` / `nativeTheme` 这类本套
 * 用不到的,一律**显式抛**——真被调到了要立刻显形,而不是安静地返回 undefined 让断言
 * 去猜(同 library-mcp-smoke 里 browserManager 桩的取舍)。
 */

/** 按顺序记下真的 show 出去的每一条。 */
export const shown: Array<{ title: string; body: string }> = [];

export function resetShown(): void {
  shown.length = 0;
}

/** 本套的判据永远是"该不该弹";下面这个开关留着验"弹失败不该炸"。 */
export let failNext = false;

export function setFailNext(v: boolean): void {
  failNext = v;
}

export class Notification {
  static isSupported(): boolean {
    return true;
  }

  private readonly opts: { title: string; body: string };

  constructor(opts: { title: string; body: string }) {
    this.opts = opts;
    if (failNext) throw new Error("no notification service");
  }

  on(_event: string, _cb: () => void): this {
    return this;
  }

  show(): void {
    shown.push({ title: this.opts.title, body: this.opts.body });
  }
}

function notHere(name: string): () => never {
  return () => {
    throw new Error(`frontend-smoke 不该走到 electron.${name}`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const ipcMain = { handle: notHere("ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
