/**
 * `@main/terminal/TerminalManager.js` 的替身 —— 只为无头脚本存在。
 *
 * ## 为什么整份换掉,而不是只换 node-pty
 *
 * `ipc/mcp.ts` 用到它只有 `loadNodePty()`,但 TerminalManager 这个模块本身经
 * `@main/window.js` → `@main/lib/theme.js` 又拉了一层 electron(`nativeTheme`),
 * 而那条链上还有 `TerminalManagerImpl` 的单例、`shellResolve` / `envRefresh`
 * (Windows 上会真跑一次 powershell.exe 刷注册表环境) —— 顺着堵会变成打地鼠。
 *
 * 整份换掉之后,唯一的损失是「`loadNodePty()` 确实来自真 TerminalManager」这一点,
 * 而这件事本套本来也验不了(原生插件在无头环境里没有可加载的形态)。换来的是
 * `@main/window.js` 可以**整条不换** —— 这对 MCP 面板是有意义的:本套因此跑在真正的
 * 窗口广播实现上,而不是一个记名替身。
 *
 * ⚠️ 这里**显式抛**,理由同 stubs/nodePty.ts:OAuth 那两条通道的参数守卫不通过时
 * 根本走不到 `runCaptured()`,所以 `spawn` 不该被调到。让一个"假 pty"安静返回,只会
 * 让一条永远绿的断言看起来像覆盖。
 */
export function loadNodePty(): never {
  throw new Error("mcp-ipc-smoke 不该真的加载 node-pty(本套只验参数守卫)");
}
