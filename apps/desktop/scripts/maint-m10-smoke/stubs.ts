/**
 * MAINT-2026-09 / M10 独占套件的替身。只替换 electron / 会话仓库 / RuntimeManager /
 * 会话广播 / 日志;被测的 `lib/worktreeOps.ts` 一行未改,git 是真的 git。
 * 不碰任何真实项目或用户仓库 —— 仓库是 mkdtemp 出来的,跑完就删。
 */
import { WORKTREE_ROOT_SETTING_KEY } from "@contracts/ipc";

/** run.cjs 通过环境变量把临时目录交进来。 */
const managedRoot = (): string => process.env.MCODE_M10_WT_ROOT ?? "";
const userData = (): string => process.env.MCODE_M10_USERDATA ?? "";

export const app = {
  getPath: (name: string): string => (name === "userData" ? userData() : userData()),
};

/** 被 worktreeOps 读到的会话侧信息。测试按需改这两个数组。 */
export const sessionsByWorktree: Array<{ id: string }> = [];
export const runningIds: string[] = [];
export const clearedWorktreeIds: string[] = [];

export const SessionRepo = {
  listByWorktreePath: (_p: string): Array<{ id: string }> => sessionsByWorktree,
  clearWorktreePath: (id: string): void => { clearedWorktreeIds.push(id); },
  get: (_id: string): null => null,
  worktreeReferenceCounts: (): Record<string, number> => ({}),
  listWorktreeRoots: (): string[] => [],
};

export const SettingRepo = {
  get: (key: string): string | undefined =>
    key === WORKTREE_ROOT_SETTING_KEY ? managedRoot() : undefined,
};

export const runtimeManager = { runningSessionIds: (): string[] => runningIds };

export function broadcastSessionChanged(_s: unknown): void { /* 无渲染端 */ }

export const logLines: string[] = [];
export const log = {
  debug: (m: string): void => { logLines.push(m); },
  info: (m: string): void => { logLines.push(m); },
  warn: (m: string): void => { logLines.push(m); },
  error: (m: string): void => { logLines.push(m); },
};

/** pathGuard 会拉进来的两样东西 —— 本套件不测项目根,给空实现即可。 */
export const ProjectRepo = {
  listPaths: (): string[] => [],
};
export function dataRoot(): string {
  return userData();
}
