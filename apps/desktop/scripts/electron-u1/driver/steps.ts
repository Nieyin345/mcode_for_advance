/**
 * T16 —— 声明式步骤工厂。全部是**纯数据**：调用它们不触发任何执行，
 * 执行统一在 `runner.ts` 里做。旅程文件因此可以非常短：
 *
 * ```ts
 * steps: [
 *   step.waitFor('[data-testid=workspace-main]', "主窗口出现"),
 *   step.click("[data-tree-session-row]", "点第一个会话"),
 *   step.assertDom("[data-testid=workspace-main]", { textContains: "..." }, "中央面板已切换"),
 * ]
 * ```
 */
import type { U1Journey, U1LaunchOptions, U1Step } from "./types.js";

/** `U1Step` 去掉公共字段后的形状，供各工厂的参数推断。 */
type Body<T extends U1Step["op"], K extends string = never> = Omit<Extract<U1Step, { op: T }>, "op" | "name" | K>;

export const step = {
  navigate: (url: string, name?: string): U1Step => ({ op: "navigate", url, ...(name === undefined ? {} : { name }) }),

  /** 真实鼠标点击：`sendInputEvent` 派发到元素中心（不是页内 `el.click()`）。 */
  click: (selector: string, name?: string, opts: { text?: string; button?: "left" | "right" } = {}): U1Step => ({
    op: "click", selector, ...(name === undefined ? {} : { name }), ...opts,
  }),

  /** 真实键入：聚焦元素后 `insertText`（走 Chromium 输入栈，React 受控组件能收到）。 */
  type: (selector: string, text: string, name?: string, opts: { clear?: boolean } = {}): U1Step => ({
    op: "type", selector, text, ...(name === undefined ? {} : { name }), ...opts,
  }),

  press: (key: string, name?: string, modifiers?: Array<"shift" | "control" | "alt">): U1Step => ({
    op: "press", key, ...(name === undefined ? {} : { name }), ...(modifiers === undefined ? {} : { modifiers }),
  }),

  waitFor: (selector: string, name?: string, opts: { text?: string; timeoutMs?: number } = {}): U1Step => ({
    op: "waitFor", selector, ...(name === undefined ? {} : { name }), ...opts,
  }),

  waitForGone: (selector: string, name?: string, timeoutMs?: number): U1Step => ({
    op: "waitForGone", selector, ...(name === undefined ? {} : { name }), ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }),

  sleep: (ms: number, name?: string): U1Step => ({ op: "sleep", ms, ...(name === undefined ? {} : { name }) }),

  /** 在页面里跑一段表达式，返回值写进证据（不断言）。 */
  eval: (expression: string, name?: string): U1Step => ({ op: "eval", expression, ...(name === undefined ? {} : { name }) }),

  /** dom 档：所有给出的条件都要满足（自动重试到 timeoutMs）。 */
  assertDom: (selector: string, opts: Body<"assertDom", "selector" | "timeoutMs"> & { timeoutMs?: number } = {}, name?: string): U1Step => ({
    op: "assertDom", selector, ...opts, ...(name === undefined ? {} : { name }),
  }),

  /** dom 档：页面内表达式结果与 expected 做 JSON 深比较。 */
  assertEvaluated: (expression: string, expected: unknown, name?: string, opts: { timeoutMs?: number } = {}): U1Step => ({
    op: "assertEvaluated", expression, expected, ...opts, ...(name === undefined ? {} : { name }),
  }),

  /** visual 档：截图仅记录（不断言）；失败时也是证据。 */
  screenshot: (shot: string, stepLabel?: string): U1Step => ({ op: "screenshot", shot, ...(stepLabel === undefined ? {} : { name: stepLabel }) }),

  /** visual 档：本次截图必须与早先同名截图**字节不同**（界面真的变了）。 */
  assertScreenshotChanged: (shot: string, baseline: string, stepLabel?: string): U1Step => ({
    op: "assertScreenshotChanged", shot, baseline, ...(stepLabel === undefined ? {} : { name: stepLabel }),
  }),

  /** sideEffect 档：记录文件当前 sha256 + 字节数。`key` 是后续对比用的名字（缺省用路径）。 */
  recordSideEffect: (file: string, key?: string, stepLabel?: string): U1Step => ({
    op: "recordSideEffect", file, ...(key === undefined ? {} : { key }), ...(stepLabel === undefined ? {} : { name: stepLabel }),
  }),

  /** sideEffect 档：直接断言磁盘事实（files 里的 `@doc`/`@db` 由 runner 解析）。 */
  assertSideEffect: (file: string, opts: Body<"assertSideEffect", "file"> = {}, name?: string): U1Step => ({
    op: "assertSideEffect", file, ...opts, ...(name === undefined ? {} : { name }),
  }),

  /** 关闭当前 Electron 进程并**真正重开**一个新的（同一 runDir / 数据根）。 */
  relaunch: (name?: string, reason?: string): U1Step => ({
    op: "relaunch", ...(name === undefined ? {} : { name }), ...(reason === undefined ? {} : { reason }),
  }),
};

/** 校验 + 补默认值。骨架宁可**显式拒绝**不完整的旅程，也不静默跑一半。 */
export function defineU1Journey(input: {
  name: string;
  expect?: "pass" | "fail";
  failBecause?: U1Journey["failBecause"];
  launch?: U1LaunchOptions;
  steps: U1Step[];
}): U1Journey {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) {
    throw new Error(`U1 journey 名字必须是 kebab-case（证据目录直接用）：${input.name}`);
  }
  if (input.expect === "fail" && typeof input.failBecause !== "function") {
    throw new Error(`旅程 ${input.name} 标了 expect:"fail"，必须给 failBecause 说明「为什么失败算预期」`);
  }
  if (input.steps.length === 0) throw new Error(`旅程 ${input.name} 没有任何步骤`);
  const names = new Set<string>();
  input.steps.forEach((s, i) => {
    const n = s.name ?? `step-${String(i + 1).padStart(2, "0")}-${s.op}`;
    if (names.has(n)) throw new Error(`旅程 ${input.name} 步骤名重复：${n}`);
    names.add(n);
  });
  return { ...input, expect: input.expect ?? "pass" };
}

/** 步骤的规范名（runner 与校验器共用同一规则）。 */
export function stepName(s: U1Step, index: number): string {
  return s.name ?? `step-${String(index + 1).padStart(2, "0")}-${s.op}`;
}
