/**
 * 【MC-002】真 Electron UI 探针的渲染端入口 —— 挂**真的** `SceneDeployPanel`。
 *
 * 不换任何被测模块:面板、状态机、i18n、UI 组件都是生产源码。唯一被换的是
 * `@renderer/lib/api.js`?**没有** —— 生产 `api.ts` 本来就是
 * `window.api ?? createWebApi()`,而 `bridge.cjs` 在页面脚本之前把真 `window.api.scene`
 * 注入了。所以这里一个字都不用换,挂上去的就是生产路径。
 *
 * 探针只额外在 `window.__sdp` 上暴露两样读取(页面侧断言用):
 *  - `renderError`:React 19 的 `onUncaughtError` 收到的第一条未捕获异常(整树卸载的
 *    探针 —— 渲染端一旦抛错整棵面板会消失,而主进程只能看到一句 console);
 *  - `mounted`:挂载完成的标记。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SceneDeployPanel } from "@renderer/components/settings/SceneDeployPanel.js";
import { initFoucGuard } from "@renderer/lib/theme.js";

initFoucGuard();

interface ProbeWindow extends Window {
  __sdp?: { renderError: string | null; mounted: boolean };
}
const probeWindow = window as ProbeWindow;
probeWindow.__sdp = { renderError: null, mounted: false };

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    probeWindow.__sdp!.renderError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  },
}).render(
  <StrictMode>
    <SceneDeployPanel />
  </StrictMode>,
);

// 挂载标记留到下一个微任务之后(StrictMode 会双调用 effect,渲染完成以 DOM 出现为准;
// 探针在页面里轮询真实元素,不依赖这个标记本身)。
queueMicrotask(() => {
  probeWindow.__sdp!.mounted = true;
});
