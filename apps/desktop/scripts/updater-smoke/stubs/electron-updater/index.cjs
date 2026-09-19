/**
 * `electron-updater` 的替身 —— **本套的主角**;包在 bundle 旁边的 `node_modules/`
 * 里(见 run.sh),因为被测模块是用**运行期**的 `requireFromHere("electron-updater")`
 * 拿它的。
 *
 * ## 为什么必须换掉真的那个(两条独立的原因)
 *
 * ### 1. 真的那个在无头 node 里**根本 require 不出来**
 *
 * 实测(一次性探针):
 *
 *     require("electron-updater").autoUpdater
 *     → TypeError: Cannot read properties of undefined (reading 'getVersion')
 *       at new AppUpdater (.../ElectronAppAdapter.js:14:25)
 *
 * 它顶层就 `new NsisUpdater()`,而那个构造要真的 `electron.app`。无头里没有 electron,
 * 于是 `autoUpdater` 那个 getter 一求值就抛 —— **不是懒加载能绕开的**。这正是
 * updater.ts 文件头那段注释在讲的事的另一面。
 *
 * ### 2. 就算拿得到,网络那一层也验不了
 *
 * `checkForUpdates()` 会去 GitHub 拉 `latest.yml`、`downloadUpdate()` 会真下几百 MB。
 * 本套要断言的是**这个模块对每种情况怎么反应**(推给界面什么、落盘什么、报错那句话),
 * 事件必须能精确喂进去。
 *
 * ## 形态与**事件时序**都照真 `AppUpdater` 来
 *
 * 它是 EventEmitter;`autoDownload` / `autoInstallOnAppQuit` 是普通属性
 * (`autoInstallOnAppQuit` 真值默认 **true**,这里照抄);三个方法可控。
 *
 * ⚠️ 两处时序是照真实现抄的,不是随手定的:
 *
 *  - `checkForUpdates()` 发现新版本时,是**先 `emit("update-available", info)`
 *    再 resolve**(`AppUpdater.checkForUpdates()` → `doCheckForUpdates()` 里
 *    `onUpdateAvailable()` 就在 `Promise.resolve` 之前);
 *  - 失败时**先 `emit("error", …)` 再 reject**(那句 `.catch(e =>
 *    { nullizePromise(); this.emit("error", e, …); throw e })`)。
 *
 *  被测模块就是靠第一个时序在 resolve 之后读 `pendingVersion` 的 —— 顺序反了它的
 *  `if (pendingVersion)` 永远为假,会一直报"已是最新版本"。
 *
 * ⚠️ **换的是"网络那一层",不是被测模块。** `updater.ts` 一行都没改 —— 它照样走
 * `requireFromHere("electron-updater").autoUpdater`、照样挂监听、照样调
 * `autoUpdater.downloadUpdate()`。
 */
"use strict";
const { EventEmitter } = require("node:events");

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false; // 真值默认 true;本套只断言模块把它设成了 true
    /**
     * 下一条 `checkForUpdates()` 的结果:
     *   `{ ok: true, availableVersion?: string, infoVersion?: string }`
     *   `{ ok: false, error }`
     * `availableVersion` 给了就**先 emit `update-available` 再 resolve**(真时序)。
     * 默认:成功、没有更新。
     */
    this.nextCheck = { ok: true };
    /** 下一条 `downloadUpdate()` 的结果。默认成功(进度靠 `fire` 喂)。 */
    this.nextDownload = { ok: true };
    /** 账本:调用顺序。断言直接用。 */
    this.calls = [];
    this.quitAndInstallArgs = null;
  }

  checkForUpdates() {
    this.calls.push("checkForUpdates");
    const next = this.nextCheck;
    if (!next.ok) {
      // 真实现:emit("error") → 然后 reject。两条都要有,顺序也要对。
      this.emit("error", next.error);
      return Promise.reject(next.error);
    }
    const version = next.availableVersion;
    if (version) {
      const info = {
        version,
        releaseNotes: next.releaseNotes,
        releaseDate: next.releaseDate,
      };
      this.emit("update-available", info);
      return Promise.resolve({ updateInfo: info });
    }
    // **没有新版本时真实现会 emit `update-not-available`**
    // (`doCheckForUpdates()` 里 `if (!(await this.isUpdateAvailable(info)))` 那一支),
    // 然后才 resolve。少了这一条,被测模块的 `pendingVersion` 就永远停在上一轮的
    // 值上 —— 那会让"检查之后报已是最新"变成"报上一轮那个版本可用"。
    const info = next.infoVersion ? { version: next.infoVersion } : undefined;
    this.emit("update-not-available", info ?? {});
    // `updateInfo` 只在真能拿到发布信息时才有(测试里用 `infoVersion` 代表那种)。
    return Promise.resolve({ updateInfo: info });
  }

  downloadUpdate() {
    this.calls.push("downloadUpdate");
    const next = this.nextDownload;
    if (!next.ok) {
      // 真实现:dispatchError(emit "error") → throw。同样两条都有。
      this.emit("error", next.error);
      return Promise.reject(next.error);
    }
    return Promise.resolve([]);
  }

  quitAndInstall(...args) {
    this.calls.push("quitAndInstall");
    this.quitAndInstallArgs = args;
  }

  /** 精确派发一个事件(**同步**;被测模块的监听器也是同步的)。 */
  fire(event, payload) {
    this.emit(event, payload);
  }

  resetCalls() {
    this.calls.length = 0;
    this.quitAndInstallArgs = null;
  }
}

/** 唯一的实例:被测模块与脚本必须看到同一个。
 *
 *  真 `electron-updater` 的 `autoUpdater` 本身也是模块级单例(getter 里
 *  `doLoadAutoUpdater()` 有 `_autoUpdater` 缓存)。本套更省事:bundle 旁边那份
 *  `node_modules/electron-updater/` 只有这一个模块实例,脚本与被测代码
 *  `require` 到的一定是同一个对象 —— CJS 按**解析后的文件名**缓存。 */
const updater = new FakeAutoUpdater();

module.exports = updater;
/** `requireFromHere("electron-updater").autoUpdater` 与
 *  `await import("electron-updater").autoUpdater` 都要拿得到同一个。 */
module.exports.autoUpdater = updater;
module.exports.default = updater;
