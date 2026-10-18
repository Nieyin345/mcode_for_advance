// 【ARC-005】真 Electron 端到端的 preload 桥。
//
// 浏览器面板自己走生产同款 `window.api.browser.*`（BrowserPanel / HtmlPreviewButton
// 都读 `window.api`）。本桥：
//   1. 暴露最小 `window.api`：`browser.*` 转发到真 IPC（生产 handler），
//      `setting.get` 返回空值，`on.*` 订阅返回可调用的取消函数 —— 其余命名空间
//      一律 rejected（本套件不碰它们；误接等于伪造能力）。
//   2. 补两件只读查询：`__hpeBrowserUrl` / `__hpeBrowserTitle`（主进程侧真值）。
//
// 判据只看主进程侧的真实值，不在渲染端推断。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (input) => ipcRenderer.invoke(channel, input);
const noopSub = () => () => {};

const api = {
  platform: process.platform,
  browser: {
    create: invoke('browser:create'),
    loadUrl: invoke('browser:loadUrl'),
    goBack: invoke('browser:goBack'),
    goForward: invoke('browser:goForward'),
    reload: invoke('browser:reload'),
    setBounds: invoke('browser:setBounds'),
    setPickMode: invoke('browser:setPickMode'),
    show: invoke('browser:show'),
    hide: invoke('browser:hide'),
    close: invoke('browser:close'),
    setDevice: invoke('browser:setDevice'),
    captureFrame: invoke('browser:captureFrame'),
    bookmarkAdd: invoke('browser:bookmarkAdd'),
    bookmarkRemove: invoke('browser:bookmarkRemove'),
    clearCache: invoke('browser:clearCache'),
    clearCookies: invoke('browser:clearCookies'),
    vaultStatus: invoke('browser:vaultStatus'),
    historyRemove: invoke('browser:historyRemove'),
    historyClear: invoke('browser:historyClear'),
    authRespond: invoke('browser:authRespond'),
    downloadAction: invoke('browser:downloadAction'),
  },
  setting: {
    get: async () => ({ value: null }),
    set: async () => ({ ok: true }),
    getMany: async () => ({}),
  },
  // contextBridge 不能克隆 Proxy —— 用显式对象（只列被订阅的命名空间）。
  on: {
    browserEvent: noopSub, themeChanged: noopSub, settingChanged: noopSub,
    fileChanged: noopSub, projectChanged: noopSub, sessionChanged: noopSub,
    turnEvent: noopSub, subagentUpdate: noopSub, todoUpdate: noopSub,
    terminalData: noopSub, terminalExit: noopSub, lspEvent: noopSub,
    appEvent: noopSub, workflowEvent: noopSub, notification: noopSub,
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('__hpeBrowserUrl', (browserId) =>
  ipcRenderer.invoke('hpe:browser-url', browserId));
contextBridge.exposeInMainWorld('__hpeBrowserTitle', (url) =>
  ipcRenderer.invoke('hpe:browser-title', url));
