/**
 * `@main/claude/RuntimeManager.js` 的替身。
 *
 * ⚠️ **实测:本套现在并不需要它 —— 去了这条 alias,97/97 一样绿。**
 * 留住它的理由只有一个,而且是防将来的:真正拉 RuntimeManager 的是
 * `ipc/index.ts` 那一侧(`library.ts` 那种"注册时 ensureWorkflows"的兄弟),本套只
 * `registerTerminalHandlers` 一个模块,图里够不到。`buildTerminalEnv` 也不需要它。
 *
 * 但 **`envRefresh.ts` 是本套拿真跑的那一个**(它换不掉,见 run.sh 那段注释),而它是
 * 顺着 `@main/claude/…` 这条线进来的一张真图。哪天 `envRefresh`(或者 `TerminalManager`)
 * 多 import 一个走 `claude/` 的模块,esbuild 会顺着往下解 —— 包括
 * `workflows/searchScriptsAssets.ts` 那二十几个 Vite `?raw` 的 `.py`,那会以
 * `No loader is configured for ".py" files` **直接挂掉打包**(不是在断言上红,是打包不出来)。
 *
 * 所以这一份留着当**保险**,不是必需品。留的还是"显式抛"的形态:本套一次都不该走到它,
 * 真被调到了要立刻显形,而不是静默 no-op 掉、把一条真调用吞了。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`terminal-smoke 不该走到 runtimeManager.${name}(本套不跑引擎)`);
  };
}

export const runtimeManager = {
  runningSessionIds: notHere("runningSessionIds"),
  sendTurn: notHere("sendTurn"),
  bindSession: notHere("bindSession"),
  emitExternal: notHere("emitExternal"),
  subscribe: notHere("subscribe"),
};
