/**
 * `git-discard-smoke` 的替身。**只换掉 git.ts 会拉进来的那几样**;真 git 不走桩。
 *
 * ## 为什么这样切
 *
 * `ipc/git.ts` import 了一长串主进程模块(secretStore / bridge / providers …),
 * 但那几条只在"生成提交信息"那条路上用得到,`git.discard` 一个都不碰。这里把它们
 * 桩成抛/空,**一旦被走到就立刻炸** —— 那说明被测的那条路比预期更宽,是信号不是噪音。
 * `pathGuard` 用**真的**(它只依赖 ProjectRepo / SessionRepo / dataRoot,都在这儿桩好),
 * 因为围栏本身就是 `git.discard` 要验的一档。
 */
import { join } from "node:path";

/** 项目根 —— main.ts 建好临时目录后写进这个环境变量。 */
const root = (): string => process.env.MCODE_GIT_SMOKE_ROOT ?? "";

export const app = {
  getPath: (name: string): string => (name === "userData" ? join(root(), "_userdata") : join(root(), "_home")),
};

/** `pathGuard.findContainingProject` 通过它认项目根 —— 只认这一个临时仓库根。 */
export const ProjectRepo = {
  listPaths: (): string[] => [root()],
  get: (_id: string): null => null,
};

export const SessionRepo = {
  listWorktreeRoots: (): string[] => [],
};

export function dataRoot(): string {
  return join(root(), "_data");
}

export const logLines: string[] = [];
export const log = {
  debug: (m: string): void => { logLines.push(m); },
  info: (m: string): void => { logLines.push(m); },
  warn: (m: string): void => { logLines.push(m); },
  error: (m: string): void => { logLines.push(m); },
};

export function broadcastGitChanged(_p: string): void { /* 无渲染端 */ }

/** 这几样只在"生成提交信息"那条路上被 import —— `git.discard` 走到它们就是坏了。 */
function notOnDiscardPath(name: string): never {
  throw new Error(`git-discard-smoke: git.discard 不该走到 ${name}`);
}

export const CustomModelStore = {
  get: () => notOnDiscardPath("CustomModelStore.get"),
  list: () => notOnDiscardPath("CustomModelStore.list"),
};
export const BridgeRegistry = { acquire: () => notOnDiscardPath("BridgeRegistry.acquire") };
export const resolveActiveModel = () => notOnDiscardPath("resolveActiveModel");
export const buildCustomEnv = () => notOnDiscardPath("buildCustomEnv");
export const resolveSdkBinaryPath = () => notOnDiscardPath("resolveSdkBinaryPath");
export const resolveProtocol = () => notOnDiscardPath("resolveProtocol");
export const listWorktrees = () => notOnDiscardPath("listWorktrees");
export const worktreeStatus = () => notOnDiscardPath("worktreeStatus");
export const mergeBackWorktree = () => notOnDiscardPath("mergeBackWorktree");
export const removeWorktree = () => notOnDiscardPath("removeWorktree");
