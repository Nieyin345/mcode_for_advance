/**
 * `@main/updater.js` 的替身 —— 被测的是 `ipc/updater.ts`,那三个 handler 干的全部
 * 事情就是"把这三个函数转给渲染端"。所以这里把它们换成**记名桩**:谁在什么时候被
 * 叫到、带没带参数,都能断言。
 *
 * ## 为什么不是"浅替"而是必须替
 *
 * 真的 `updater.ts` 一上来就 `import { app } from "electron"` 并
 * `createRequire(...)("electron-updater")`。本套验的是 **IPC 那一层**(契约名对不
 * 对、参数透不透传、`await` 有没有丢),把底下整条更新器换掉是刻意的:那一边的逻辑
 * 归另一套(在 `scripts/updater-smoke/`,由另一个代理负责)。
 *
 * ## `checkForUpdates` 的参数为什么要记
 *
 * 真那个的签名是 `checkForUpdates(source: "auto" | "manual" = "manual")`:默认值存
 * 在,但**主进程里没有任何调用方传过它** —— 面板那条路走的是 `IPC.APP_CHECK_FOR_
 * UPDATES`,handler 是零参调的。于是 `source` 永远等于默认值,`update-available`
 * 推给界面的 `source` 字段也就永远是同一个值,"后台发现"和"用户点的"在界面这一侧
 * 分不开。本套把"handler 传了什么"记下来,就是为了让这件事显形。
 */
export type Recorded = { args: unknown[] };

export const record: {
  check: Recorded[];
  download: Recorded[];
  quit: Recorded[];
  /** 让 `checkForUpdates` 返回一个可辨认的结果,断言"handler 原样转发"用。 */
  checkResult: unknown;
  /** 下一次 `downloadUpdate` 要不要抛 —— 断言 handler 有没有把 reject 透出去。 */
  downloadShouldFail: boolean;
  quitShouldFail: boolean;
} = {
  check: [],
  download: [],
  quit: [],
  checkResult: { status: "up-to-date", version: "0.0.0-stub" },
  downloadShouldFail: false,
  quitShouldFail: false,
};

export function reset(): void {
  record.check.length = 0;
  record.download.length = 0;
  record.quit.length = 0;
  record.checkResult = { status: "up-to-date", version: "0.0.0-stub" };
  record.downloadShouldFail = false;
  record.quitShouldFail = false;
}

export async function checkForUpdates(...args: unknown[]): Promise<unknown> {
  record.check.push({ args });
  return record.checkResult;
}

export async function downloadUpdate(...args: unknown[]): Promise<void> {
  record.download.push({ args });
  if (record.downloadShouldFail) throw new Error("桩:下载失败");
}

export async function quitAndInstall(...args: unknown[]): Promise<void> {
  record.quit.push({ args });
  if (record.quitShouldFail) throw new Error("桩:安装失败");
}

/** 真的那个还有这两个导出,别的模块会用。本套不验它们,但替身得"长得像",
 *  否则将来 import 图一变,报出来的是"少一个导出"而不是一句人话。 */
export function initUpdater(): Promise<void> {
  throw new Error("本套不该走到 initUpdater(启动流程那一步不在这里验)");
}

export function getPersistedUpdateState(): never {
  throw new Error("本套不该走到 getPersistedUpdateState");
}
