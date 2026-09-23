/**
 * `@main/memory/broadcast.js` 的替身 —— 真的那个 import 了 `@main/window.js`
 * (electron 的 `webContents.send`),无头脚本给不出来。
 *
 * ## 为什么本套件突然需要它
 *
 * 2026-09-22 加了记忆工具集,`toolRules.ts` 因此要多认一个 server(`mcode-memory`),
 * 于是它的 import 图里多出 `memoryServer` → `memory/broadcast` → `window.js`。
 * 本套件本来就引 `toolRules`(走 `webToolHost`),那条新边一接上,打包就在
 * `electron` 上炸 —— 报在一个和"网页工具派发"毫无关系的文件上。
 *
 * 换掉它是安全的:本套件验的是**派发与闸门**(会话缺失、参数校验、只读放行/写弹卡),
 * 与"记忆变了要不要通知界面"无关。
 */
export function notifyMemoryChanged(_reason: string): void {
  /* 这套件不断言它 */
}
