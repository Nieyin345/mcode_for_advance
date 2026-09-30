/**
 * MAINT-2026-09 / M07 独占套件的替身。只替换「路径注册表 + Electron + 日志」,
 * 被测的 `main/ipc/files.ts` 与 `main/lib/pathGuard.ts` 一行未改。
 * 不访问任何真实用户数据。
 */
import { tmpdir } from "node:os";

/** 已登记的项目根(测试自己往里塞 mktemp 出来的目录)。 */
export const projectPaths: string[] = [];
export const worktreeRoots: string[] = [];
export const ProjectRepo = { listPaths: (): string[] => projectPaths };
export const SessionRepo = { listWorktreeRoots: (): string[] => worktreeRoots };
/** 本套件不碰数据根:文献库/模版库那一类根在这里一律不存在。 */
export function dataRoot(): never { throw new Error("No user data root in this smoke"); }

/** 被拒绝时 files.ts 只写日志、对渲染端静默返回 —— 把日志收下来当证据。 */
export const warnings: string[] = [];
export const log = {
  debug: (_m: string): void => {},
  info: (_m: string): void => {},
  warn: (m: string): void => { warnings.push(m); },
  error: (m: string): void => { warnings.push(m); },
};

/* ── electron 替身 ── files.ts 的 Electron 导入,但本套件只走 file:* 通道。 */
export const app = { getPath: (_name: string): string => tmpdir() };
export const clipboard = {
  write: async (): Promise<never> => { throw new Error("File-path smoke must not write the OS clipboard"); },
  writeText: async (): Promise<never> => { throw new Error("File-path smoke must not write the OS clipboard"); },
};
export class ClipboardItem {
  constructor(_data: unknown) { throw new Error("File-path smoke must not create ClipboardItem"); }
}
export const nativeImage = { createFromPath: (): unknown => ({ isEmpty: () => true }) };
export const shell = { trashItem: async (): Promise<void> => {} };

