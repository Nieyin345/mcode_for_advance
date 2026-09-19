/**
 * `@main/env/toolInstall.js` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么必须换掉它
 *
 * 真的那一个会:
 *   - **pandoc**:从 GitHub release(含国内镜像)下载 40 MB 并解包;
 *   - **latex**:下 165 MB 的 TinyTeX,再跑 `tlmgr install ctex fandol`(实测几分钟);
 *   - **python-deps**:`execFile(python, ["-m","pip","install",…])` —— **往用户
 *     自己的解释器里装包**。
 *
 * 这三样在这套 smoke 里一件都不该发生:不是"慢",是真的下载、真的改用户环境。
 *
 * ## 还有一层:把这个文件从邻座的改动里隔离出来
 *
 * 本套要钉的是 `ipc/toolchain.ts` **自己**的职责 —— 校验入参、转发、把运行态
 * (`installing` / `lastError`)贴到检测结果上。而运行态那三个访问器
 * (`isToolInstalling` / `lastToolError` / `installTool` / `removeTool`)的实现细节
 * 住在 `toolInstall.ts` 里,那个文件此刻**有别的代理在改**。换桩之后,那边的改动
 * 不会把本套带红 —— 本套的判据只落在 IPC 那一层。
 *
 * ## 桩的姿态:可摆布 + 把调用记下来
 *
 * 运行态不是写死的,是脚本用 `setInstalling` / `setLastError` **摆**出来的现场。
 * `installTool` / `removeTool` 把收到的工具名记进 `installs` / `removes`,断言据此
 * 确认"校验过了的才转发过去、被挡下的一个都没转发"。
 */
import type { ToolchainToolId } from "@contracts/ipc";

const installing = new Set<ToolchainToolId>();
const errors = new Map<ToolchainToolId, string>();

/** 按顺序记下转发进来的 `installTool` 参数。 */
export const installs: ToolchainToolId[] = [];
/** 按顺序记下转发进来的 `removeTool` 参数。 */
export const removes: ToolchainToolId[] = [];

/** 摆现场:让某一项显示成"正在装"。 */
export function setInstalling(tool: ToolchainToolId, value: boolean): void {
  if (value) installing.add(tool);
  else installing.delete(tool);
}

/** 摆现场:让某一项带上一句"上次报错"。传空串 = 清掉。 */
export function setLastError(tool: ToolchainToolId, message: string): void {
  if (message) errors.set(tool, message);
  else errors.delete(tool);
}

export function isToolInstalling(tool: ToolchainToolId): boolean {
  return installing.has(tool);
}

export function lastToolError(tool: ToolchainToolId): string {
  return errors.get(tool) ?? "";
}

export async function installTool(tool: ToolchainToolId): Promise<{ ok: boolean; error?: string }> {
  installs.push(tool);
  return { ok: true };
}

export async function removeTool(tool: ToolchainToolId): Promise<{ ok: boolean; error?: string }> {
  removes.push(tool);
  return { ok: true };
}
