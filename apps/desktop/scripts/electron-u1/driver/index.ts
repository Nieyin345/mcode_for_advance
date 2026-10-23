/**
 * T16 —— driver 的公开入口。后续任务卡**只 import 这一个文件**：
 *
 * ```ts
 * // apps/desktop/scripts/<你的>-smoke/journeys/open-save.ts
 * import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
 *
 * export const journeys = [
 *   defineU1Journey({
 *     name: "genoffice-docs-open-edit-save",
 *     launch: { page: "bundle", useRealDb: true, preload: "product" },
 *     steps: [
 *       step.waitFor("[data-testid=workspace-main]", "主窗口出现"),
 *       step.click("[data-genoffice-doc]", "打开文档"),
 *       step.assertDom("[data-genoffice-editor]", { textContains: "hello" }, "编辑器载入内容"),
 *       step.relaunch("保存后重开"),
 *       step.assertSideEffect("@doc", { contains: "hello" }, "改动落盘"),
 *     ],
 *   }),
 * ];
 * ```
 *
 * 执行器（runner.ts）与启动器（build.mjs）不对外导出 —— 后续卡应复用本套件的
 * `build.mjs --registry=<你的 journeys 入口>`（见 README「后续卡如何复用」），
 * 而不是复制一份执行器。
 */
export { defineU1Journey, step, stepName } from "./steps.js";
export { classifyJourney, literalStatus, suiteExitCode } from "./verdict.js";
export { assertionStatus, RELAUNCH_EXIT } from "./runner.js";
export type {
  SideEffectRecord,
  U1AssertionKind,
  U1Evidence,
  U1Journey,
  U1JourneyResult,
  U1LaunchOptions,
  U1RunAssertion,
  U1SetupContext,
  U1SetupResult,
  U1Step,
  U1StepRuntime,
} from "./types.js";
