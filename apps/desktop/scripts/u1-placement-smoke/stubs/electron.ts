/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * 本套断言的是 `runner.ts` 里**纯算术**的 `chooseHostWindowPlacement`：它不读
 * `screen`、不碰任何 Electron API。`runner.ts` 顶层也没有副作用，所以正常情况
 * 下这个桩**一个成员都不会被调到**。
 *
 * 所以这里不是空实现，而是**显式抛错**：如果哪天 `runner.ts` 的顶层开始碰
 * electron（例如模块级 `screen.getPrimaryDisplay()`），这套会当场炸出来 ——
 * 而不是安静地返回 undefined，让断言继续绿。
 *
 * ⚠️ 将来若要在这套里测 `pickHostWindowPlacement`（读 `screen` 的那层），
 * 不能在这里加一个「像样」的 screen 桩 —— 那验的是桩，不是 `screen` 的行为。
 * 真机分支由真 Electron 套件（U1 / W24 探针）覆盖。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`u1-placement-smoke 不该走到 electron.${name}`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  on: notHere("app.on"),
  exit: notHere("app.exit"),
  whenReady: notHere("app.whenReady"),
};

export const screen = {
  getPrimaryDisplay: notHere("screen.getPrimaryDisplay"),
  getAllDisplays: notHere("screen.getAllDisplays"),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const BrowserWindow = function BrowserWindow(): never {
  throw new Error("u1-placement-smoke 不该走到 electron.BrowserWindow");
} as unknown as new (...args: never[]) => never;
