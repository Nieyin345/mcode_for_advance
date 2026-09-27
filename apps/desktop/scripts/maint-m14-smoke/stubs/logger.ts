/** `@main/lib/logger.js` 的替身 —— 真那份会拉 electron 的 `app.getPath`。 */
export const log = {
  debug(_msg: string): void {},
  info(_msg: string): void {},
  warn(_msg: string): void {},
  error(_msg: string): void {},
};

