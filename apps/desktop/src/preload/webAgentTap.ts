/**
 * Preload for **web-agent engine views**（网页版大模型引擎用的视图）。
 *
 * 与 browserPicker 一样锁死：这个视图加载的是任意远程页面，绝不能暴露任何
 * Node 能力。唯一的桥是 `window.mcodeBridge.dsTapEvent(payload)`，由注入到
 * 页面**主世界**的 tap 脚本调用，把旁听到的 SSE 原始文本增量送回来。
 *
 * 数据流向：页面主世界（劫持 fetch/XHR）→ contextBridge → 本 preload →
 * `ipcRenderer.send("__mcode_web_tap__")` → BrowserManager（按 `evt.sender`
 * 反查 browserId）→ web-agent provider 的 handler → 分帧 + 解析 → RuntimeEvent。
 *
 * ## 为什么回传走这里而不是 CDP 的 Runtime.addBinding
 * 注入**必须**走 CDP（主世界 + document-start，preload 在隔离世界改不了
 * `window.fetch`），但**回传**不必：CDP 那条路要在主进程订阅 `dbg.on("message")`
 * 事件流，而 BrowserManager 目前只做 `sendCommand`、没有事件管道。contextBridge
 * 这条路是现成的（browserPicker 已经在用），少一条要维护的管道。
 *
 * Built as a separate bundle (`out/preload/webAgentTap.mjs`).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mcodeBridge", {
  /** 把一条抓流数据转发给主进程。tap 脚本同步调用，主进程按 sender 路由。 */
  dsTapEvent: (payload: unknown): void => {
    ipcRenderer.send("__mcode_web_tap__", payload);
  },
});