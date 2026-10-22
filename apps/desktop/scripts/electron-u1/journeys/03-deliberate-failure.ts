/**
 * T16 示例旅程 3 —— **故意失败**：断言一个不存在的元素，必须红，证据落盘。
 *
 * 这是本卡最关键的自检：如果骨架把断言改成无条件通过（变异验证），这条旅程会
 * 从「预期失败」变成「没失败」，套件退出码随之从 1（预期红）变成 0（全绿）——
 * 机器可核对，见 run.sh 的 mutation 步骤。
 *
 * `expect: "fail"` + `failBecause` 把「骨架自己崩了」和「断言真的在判」区分开：
 * 只有失败恰好落在指定步骤、且之前的 DOM 断言确实 PASS，才算预期红。
 */
import { defineU1Journey, step } from "../driver/index.js";

export const deliberateFailure = defineU1Journey({
  name: "deliberate-failure",
  expect: "fail",
  failBecause: (evidence) => {
    const failed = evidence.find((e) => e.status === "FAIL");
    if (!failed) return false;
    // 必须败在「断言不存在元素」这一步，而不是启动/导航之类的基础设施步骤。
    if (failed.step !== "assert-missing-element") return false;
    // 且失败前已有的 dom 断言确实通过 —— 证明页面是好的，红的是这一条断言。
    return evidence.some((e) => e.kind === "dom" && e.status === "PASS" && e.step === "page-is-alive");
  },
  launch: { page: "bundle", assertions: { dom: true, visual: true, sideEffect: false } },
  steps: [
    step.waitFor("[data-testid=workspace-main]", "主窗口出现", { timeoutMs: 20_000 }),
    step.assertDom("[data-testid=workspace-sidebar]", { exists: true }, "page-is-alive"),
    // 断言一个**不存在**的元素：必须失败，且失败截图 + DOM 落盘。
    step.assertDom("[data-testid=u1-definitely-not-here]", { exists: true }, "assert-missing-element"),
    step.sleep(200, "失败后不再继续"),
  ],
});
