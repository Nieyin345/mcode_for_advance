/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只为**打包**而存在(app-control-smoke 从不
 * 真跑无窗口那条路)。
 *
 * ## 为什么这一套现在需要它
 *
 * 【MC-059】之后 `appControl/tools.ts` 的 `headlessNewSession` / `headlessSend` 会
 * **动态** `import("@main/claude/RuntimeManager.js")`、`import("@main/lib/sessionStart.js")`。
 * esbuild 打**动态** import 时照样把整条图收进 bundle,而真的 RuntimeManager 那条链里有
 * `mcp/agentTools` → `agentRemoteSsh` → `ssh2` → `cpu-features.node`(一个原生模块)——
 * 打包阶段就卡在它上面(同 `publicMcpSession.ts` 文件头记过的那次)。
 *
 * 本套**不验**无窗口那条路(它没有 SQLite,`createOrReuseSession` 一碰 `ProjectRepo`
 * 就会抛),真正的无窗口回归在 `claude-ipc-smoke`(那套有真库、真 RuntimeManager 桩)。
 * 这里只要一个能被解析、能让 bundle 成形的替身即可 —— 界面可用那几条路径也用不到它。
 *
 * ⚠️ **不是空实现**:真被调到时**显式抛**,而不是安静返回 undefined 让断言去猜
 * (同 library-delete-smoke / panel-screenshot-smoke 桩的取舍)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(
      `app-control-smoke 不该走到 runtimeManager.${name}(本套不验无窗口那一路;那条回归在 claude-ipc-smoke)`,
    );
  };
}

export const runtimeManager = {
  bindSession: notHere("bindSession"),
  sendTurn: notHere("sendTurn"),
};
