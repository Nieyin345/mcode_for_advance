// 【MC-026 复核·外观即时生效】真 Electron preload —— 只暴露 theme 的三条通道,
// 与生产 `src/preload/index.ts` 的 `theme.get/set` + `on.themeChanged` 同形。
// 其余面板数据由 `api-stub.js` 在页面脚本里提供(见那里的说明)。
//
// 为什么 theme 必须走真 IPC:主题是"改 nativeTheme → Chromium prefers-color-scheme
// → 渲染端 .dark 类"的跨进程链;在页面里伪造一个 theme 对象只能证明类切换,证明不了
// 主进程那条链。本桥把渲染端 `api.theme.*` 直接接到探针注册的真 handler。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__electronTheme", {
  get: () => ipcRenderer.invoke("theme:get"),
  set: (input) => ipcRenderer.invoke("theme:set", input),
  onChanged: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on("theme:changed", listener);
    return () => ipcRenderer.off("theme:changed", listener);
  },
});
