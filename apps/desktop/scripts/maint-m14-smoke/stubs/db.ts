/** `@main/store/db.js` 的替身 —— 本套不建真库(见 run.sh)。
 *  `mcpConfig.getMcpManagement` 只用到 `awaitDb()` 的"等库就绪"语义。 */
export function awaitDb(): Promise<void> {
  return Promise.resolve();
}

