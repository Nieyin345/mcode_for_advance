// 【MC-046 U1】真 Electron 端到端的 preload 桥。
//
// 聚焦所有权是**渲染端 DOM** 的事（activeElement / inert / 键盘遍历），本套件
// 不需要真 preload 契约；页面里的 `api-stub.js` 已提供 `window.api` 的最小形状。
// 本桥只暴露一个只读标记，证明 preload 链真的跑起来了 —— 同时它**不是**被判据依赖的
// 东西（防"桥没加载"被误读成焦点缺陷）。
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("__arc005Probe", { preload: true });
