/**
 * MAINT-2026-09 / M21 独占套件的替身。只换 electron / 日志 / 设置仓库;
 * `localInstall.ts` 与 `OnlyOfficeBridge.ts` 一行未改。
 * 子进程由 childStub.ts 顶替 —— 本套件**绝不真的提权、不真的装 Office、不下载**。
 */
export const app = {
  getPath: (name: string): string =>
    name === "temp" ? (process.env.MCODE_M21_TEMP ?? "") : (process.env.MCODE_M21_USERDATA ?? ""),
};
export const nativeTheme = { shouldUseDarkColors: false };
export const dialog = { showMessageBox: async (): Promise<void> => undefined };

const settings = new Map<string, string>();
export const SettingRepo = {
  get: (k: string): string | undefined => settings.get(k),
  set: (k: string, v: string): void => { settings.set(k, v); },
};
export const ProjectRepo = { listPaths: (): string[] => [] };
export const SessionRepo = {
  listWorktreeRoots: (): string[] => [],
  listByWorktreePath: (): [] => [],
};
export function dataRoot(): string { return process.env.MCODE_M21_USERDATA ?? ""; }

export const logLines: string[] = [];
export const log = {
  debug: (m: string): void => { logLines.push(m); },
  info: (m: string): void => { logLines.push(m); },
  warn: (m: string): void => { logLines.push(m); },
  error: (m: string): void => { logLines.push(m); },
};
