/**
 * `@main/orchestration/runner.js` 的替身 —— **只替 `hasActiveRun` / `startWorkflowRun`
 * 两个函数**,别的什么都不给。
 *
 * ## 为什么这两个必须换掉
 *
 * `automationRunner` 起一次运行的收尾是 `void startWorkflowRun({session, cwd, prompt, entry})`,
 * 而真那一个会拉起会话、调度器、执行器、运行存档 —— 无头脚本里那是一条跑不完的活。
 * 更要紧的是:**载荷就长在这个参数里**(`entry.nodeId` / `entry.payload` / `prompt`),
 * 而 `fire()` 把它交给引擎之后,仓库里再没有第二个地方读得到它。所以这个桩是这一套能
 * 断言"交给模型的是什么"的**唯一**入口。
 *
 * ## 为什么走 `--external:./runner.js` 而不是 `--alias:`
 *
 * `automationRunner` 里那句是**相对** import(`from "./runner.js"`)。esbuild 的 `--alias:`
 * 不收相对路径的名字(报 `Invalid alias name: "./runner.js"`,它只认包名),所以改成把它
 * 整条**外置**:esbuild 原样留下 `import … from "./runner.js"`,再由 `run.sh` 把这份桩单独
 * 打成一个同名模块放在 bundle 旁边。代价是 `run.sh` 多一步构建,换来的是"被测路径一字未
 * 改"——`automationRunner.ts` 那句 import 保持原样。
 *
 * ## 这里**不是空实现**,而且刻意保留了两件事
 *
 *  - `startWorkflowRun` 把**每一次调用原样记下来**(提示词、工作目录、`entry`),断言就
 *    看这一份;
 *  - `hasActiveRun` 默认 false；生命周期回归通过 `setRunBusy` 明确控制忙闲，
 *    验证忙时合并、取消与关闭，不会启动真实引擎。
 */
import type { Session } from "@contracts/session";

/** `startWorkflowRun` 收到的那个参数里,本套要断言的那几项(其余原样放着)。 */
export interface CapturedRun {
  sessionId: string;
  cwd: string | undefined;
  /** 真正送给模型的整句提示词 —— `task` + 载荷渲染出来的那一段。 */
  prompt: string | undefined;
  /** 这一格是这次运行的起点;`nodeId` 用来分辨是哪条触发器起的。 */
  entry: { nodeId?: string; summary?: string; payload?: Record<string, unknown> } | undefined;
}

/** 按发生顺序记下的每一次起跑。 */
export const runs: CapturedRun[] = [];

/** 清空记录(每个场景开始前调一次,断言只看这一场景里的)。 */
export function resetRuns(): void {
  runs.length = 0;
}

/** 某一条触发器(按 `entry.nodeId`)起了几次。 */
export function runsOfNode(nodeId: string): CapturedRun[] {
  return runs.filter((r) => r.entry?.nodeId === nodeId);
}

const busySessions = new Set<string>();
/** Controlled in-flight state for busy/coalescing regressions. */
export function setRunBusy(sessionId: string, busy: boolean): void {
  if (busy) busySessions.add(sessionId); else busySessions.delete(sessionId);
}
export function hasActiveRun(sessionId: string): boolean {
  return busySessions.has(sessionId);
}

export function startWorkflowRun(args: {
  session: Session;
  cwd?: string;
  prompt?: string;
  entry?: CapturedRun["entry"];
}): Promise<void> {
  runs.push({
    sessionId: args.session.id,
    cwd: args.cwd,
    prompt: args.prompt,
    entry: args.entry,
  });
  // 真那一个是"跑完整张图"的 promise,调用方不 await(见 `fire()` 的 `void`)。给一个
  // 立刻解决的即可 —— 它上面还挂着 `.catch` 兜"起跑之后才失败",这里不制造失败。
  return Promise.resolve();
}
