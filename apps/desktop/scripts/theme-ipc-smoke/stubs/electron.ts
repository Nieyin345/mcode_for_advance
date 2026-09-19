/**
 * `electron` 的替身 —— **可精确控制 + 记录型**,不是纯抛型。
 *
 * ## 为什么不复用现成的那几份
 *
 * `library-delete-smoke/stubs/electron.ts` 的 `nativeTheme` 是
 * `{ shouldUseDarkColors: false }` —— 一个**死的常量**。这一套要验的三件事全在它身上:
 *
 *   - `initTheme()` 抓 `osPrefersDark` 的**时机**(改 `themeSource` 之前还是之后);
 *   - `nativeTheme.on("updated")` 触发时往渲染端推了什么;
 *   - 用户选完偏好之后 `shouldUseDarkColors` 有没有跟着翻。
 *
 * 所以这里造一个**能读写、能手动触发事件**的假 nativeTheme,并且**照 Electron 的
 * 真实模型算 `shouldUseDarkColors`**:
 *
 * ```
 * themeSource === "dark"   → shouldUseDarkColors = true
 * themeSource === "light"  → shouldUseDarkColors = false
 * themeSource === "system" → shouldUseDarkColors = 操作系统的值(osDark)
 * ```
 *
 * ⚠️ 这一条**非有不可**。如果 `shouldUseDarkColors` 是一个跟 `themeSource` 无关的
 * 常量,"把 `osPrefersDark` 的抓取挪到赋值之后"这种错法**照样全绿** —— 断言会变成
 * 一条空过的断言(见 SKILL.md 里「检查断言有没有'空过'」)。按真实模型算之后,
 * 顺序写反了就必然读到 `false`,那条断言才真的守得住东西。
 *
 * ## `app`
 *
 * 只实现这一套真的会碰的三个:`getVersion` / `relaunch` / `exit`,外加真
 * `@main/lib/dataRoot.js` 要的 `getPath("userData" | "home")`。三个都**记账**。
 *
 * ⚠️ `getPath` 是**数据根的唯一来源**:没设 `MCODE_SMOKE_DATA_ROOT` 就**抛**,
 * 绝不回落到 `%APPDATA%` 或用户主目录 —— `db.ts` 在不存在的路径上会**新建一个空库**,
 * 而 `sql.js` 的 `persist()` 是重写整个 `mcode.db`。指错地方就是拿空库盖掉用户的
 * 聊天记录。
 */

import { join } from "node:path";

/** 假的 `app.getVersion()`。About 面板上那行 `v0.1.54` 就是它。 */
export const APP_VERSION = "9.9.9-theme-ipc-smoke";

/* ──────────────── nativeTheme:可读写的假身 ──────────────── */

export interface ThemeState {
  /** 操作系统那边到底是不是暗的。脚本说了算 —— 这就是"OS 翻了"的模拟入口。 */
  osDark: boolean;
  /** 当前 themeSource。初始 `"system"`,与真的 Electron 一致。 */
  themeSource: "system" | "dark" | "light";
}

export const themeState: ThemeState = { osDark: false, themeSource: "system" };

/** 每一次 `themeSource = x` 的赋值按顺序记下来(断言"设成了什么"用它)。 */
export const themeSourceWrites: string[] = [];

/** 登记过的 `updated` 监听器。**重复登记会在这里露出来** —— `initTheme` 每多跑一次
 *  就该多一个,所以"第二次只初始化一次"这条断言读的就是它的长度。 */
const updatedListeners: Array<() => void> = [];

export function updatedListenerCount(): number {
  return updatedListeners.length;
}

/** 手动触发一次 `nativeTheme` 的 `updated`。真的那个由 OS 主题变化触发,无头脚本里
 *  没有 OS 可翻,只能由脚本按下去。 */
export function emitUpdated(): void {
  for (const listener of [...updatedListeners]) listener();
}

export const nativeTheme = {
  get themeSource(): ThemeState["themeSource"] {
    return themeState.themeSource;
  },
  set themeSource(value: ThemeState["themeSource"]) {
    themeSourceWrites.push(value);
    themeState.themeSource = value;
  },
  get shouldUseDarkColors(): boolean {
    if (themeState.themeSource === "dark") return true;
    if (themeState.themeSource === "light") return false;
    return themeState.osDark;
  },
  on(event: string, listener: () => void): void {
    if (event !== "updated") {
      throw new Error(`theme-ipc-smoke 只登记 nativeTheme 的 "updated",收到 "${event}"`);
    }
    updatedListeners.push(listener);
  },
};

/** 把 nativeTheme 恢复成刚启动的样子(每个小节的夹具起点)。⚠️ **不动监听器** ——
 *  监听器是 `initTheme` 装的,清掉它等于把被测的那条链子拆了。 */
export function resetThemeState(): void {
  themeState.osDark = false;
  themeState.themeSource = "system";
  themeSourceWrites.length = 0;
}

/* ──────────────── app:记账型 ──────────────── */

export const appCalls = {
  relaunch: 0,
  /** `app.exit()` 收到的退出码,按顺序。 */
  exitCodes: [] as number[],
};

export function resetAppCalls(): void {
  appCalls.relaunch = 0;
  appCalls.exitCodes.length = 0;
}

/**
 * `app.getPath()` —— 数据根的唯一来源。
 *
 * `userData` 给一个**临时目录下的私有子目录**(真 `dataRoot.ts` 的指针文件
 * `data-root.json` 就写在那儿);`home` 给它自己(`<主目录>/Mcode` 那个默认位置其实
 * 永远走不到 —— 指针文件一定先命中)。
 *
 * ⚠️ **没设 `MCODE_SMOKE_DATA_ROOT` 就抛。** 这是本套的安全前提,别改成回落到默认值。
 */
function fakePath(which: string): string {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root) {
    throw new Error(
      "MCODE_SMOKE_DATA_ROOT 没设 —— electron 桩拒绝给出任何路径(回落 = 可能指到真数据根)",
    );
  }
  if (which === "userData") return join(root, "_appdata");
  if (which === "home") return root;
  throw new Error(`theme-ipc-smoke 的 app 桩只认 userData / home,收到 "${which}"`);
}

function notHere(name: string): (...a: unknown[]) => never {
  return () => {
    throw new Error(`theme-ipc-smoke 不该走到 electron.${name}`);
  };
}

export const app = {
  getVersion: (): string => APP_VERSION,
  relaunch: (): void => {
    appCalls.relaunch += 1;
  },
  exit: (code: number): void => {
    appCalls.exitCodes.push(code);
  },
  getPath: fakePath,
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  setAppUserModelId: notHere("app.setAppUserModelId"),
};

/** 本套自己造了一个 `ipcMain`(记名替身),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

export const shell = { openPath: notHere("shell.openPath") };
