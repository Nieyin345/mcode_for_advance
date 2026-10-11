/** `mcpConfig.ts` 只用到 `awaitDb`(等 db 就绪)。无头环境没有 sql.js 库,
 *  换成立即 resolve 的桩 —— 本套件测的是身份/指纹纯逻辑,不碰持久化。 */
export const awaitDb = (): Promise<void> => Promise.resolve();
export const getDb = (): never => {
  throw new Error("mcp-trust-identity-smoke: getDb 不应被调用(SettingRepo 已打桩)");
};
export const persistNowOrThrow = (): void => {};
export const initDb = async (): Promise<void> => {};
