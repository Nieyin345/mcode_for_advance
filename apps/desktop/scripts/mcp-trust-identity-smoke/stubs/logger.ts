/** 无头环境里 `lib/logger.ts` 会拉起 electron 包(动态 require),换成空实现。 */
export const log = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
};
