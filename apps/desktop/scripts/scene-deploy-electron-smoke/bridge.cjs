// 【MC-002】真 Electron UI 探针的渲染端桥 —— 与 `src/preload/index.ts` **同形的最小种子**。
//
// 只暴露本套件被测的四条 scene 通道(renderer 与生产 preload 一样走 `ipcRenderer.invoke`);
// 其余 `window.api` 在页面里一律显式抛 —— SceneDeployPanel 当前只用到 scene.*,若它悄悄
// 多读一样东西,这里会立刻显形而不是被 undefined 吞掉。
//
// 为什么不直接复用生产 preload:那份 import `@contracts/ipc` 整面表并在模块顶层
// `exposeInMainWorld`,打成 CJS 需要把整个 contracts barrel 拉进来且会暴露 313 个 RPC;
// 本套件只验场景部署链,最小种子同时是**权限最小化**(与台账要求的边界一致)。
const { contextBridge, ipcRenderer } = require("electron");

const scene = {
  plan: (input) => ipcRenderer.invoke("scene:plan", input),
  preflight: (input) => ipcRenderer.invoke("scene:preflight", input),
  approve: (input) => ipcRenderer.invoke("scene:approve", input),
  apply: (input) => ipcRenderer.invoke("scene:apply", input),
  resume: (input) => ipcRenderer.invoke("scene:resume", input),
  listDeployments: (input) => ipcRenderer.invoke("scene:listDeployments", input),
};

contextBridge.exposeInMainWorld("api", { scene });
contextBridge.exposeInMainWorld("mcodeElectron", true);
