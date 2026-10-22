/**
 * `@main/orchestration/runner.js` 的替身 —— **只替 `hasActiveRun` / `startWorkflowRun`
 * 两个函数**（与 `automation-smoke` 那一份同一手法，但本套只需要"记下每次起跑"）。
 *
 * ## 为什么必须换掉
 *
 * 真 `startWorkflowRun` 会拉起会话、调度器、执行器、运行存档 —— 无头脚本里跑不完。
 * 而 T3 要证明的判据恰恰是「**旧 runner 到底有没有尝试派发**」：Node-RED 拥有的图必须
 * 一次 `startWorkflowRun` 都不发生。桩把每次调用原样记下来，断言看这一份就够了。
 *
 * ## 为什么走 `--external:./runner.js`
 *
 * `automationRunner` 里那句是**相对** import（`from "./runner.js"`），esbuild 的
 * `--alias:` 不收相对路径的名字。所以把它整条外置，由 `run.sh` 把这份桩打成同名模块
 * 放在 bundle 旁边 —— 被测路径一字未改。
 *
 * ⚠️ 桩**不模拟**真 `runner.ts` 的 `assertWorkflowExecutor`：本套要观察的是"旧 runner
 * 有没有走到派发这一步"，而不是再验一遍下游 assert（那条由
 * `workflow-engine-selection-smoke` 与 `executor-*` 守着）。真实现里 node-red 图会在
 * assert 处抛错并留下一次失败运行 —— 那也是"尝试过"，与这里记下一笔等价。
 */
import type { Session } from "@contracts/session";

export interface CapturedRun {
  sessionId: string;
  cwd: string | undefined;
  prompt: string | undefined;
  entry: { nodeId?: string; summary?: string; payload?: Record<string, unknown> } | undefined;
}

/** 按发生顺序记下的每一次起跑。 */
export const runs: CapturedRun[] = [];

export function resetRuns(): void {
  runs.length = 0;
}

/** 某一条触发器（按 `entry.nodeId`）起了几次。 */
export function runsOfNode(nodeId: string): CapturedRun[] {
  return runs.filter((r) => r.entry?.nodeId === nodeId);
}

export function hasActiveRun(_sessionId: string): boolean {
  return false;
}

export function startWorkflowRun(args: {
  session: Session;
  cwd?: string;
  prompt?: string;
  entry?: CapturedRun["entry"];
}): Promise<{ status: "success" }> {
  runs.push({ sessionId: args.session.id, cwd: args.cwd, prompt: args.prompt, entry: args.entry });
  return Promise.resolve({ status: "success" });
}
