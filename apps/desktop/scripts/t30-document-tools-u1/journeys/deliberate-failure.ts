/**
 * T30 旅程 √ 自检 —— **故意失败**：断言一个绝不存在的文档视图。
 *
 * 为什么要它：T30 的两条产品旅程在 T40 修好之前**必然红**，
 * 所以「断言真的在判」不能靠它们证明。这条自检与 T16 的 `deliberate-failure`
 * 同义 —— 变异跑（`assertionStatus` 改成无条件 PASS）时它必须由 FAIL 变 PASS，
 * 套件退出码随之从 1 变成 0；正常跑时它必须红在**指定步骤**上。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";

export const deliberateFailure = defineU1Journey({
  name: "deliberate-failure",
  expect: "fail",
  failBecause: (evidence) => {
    const failed = evidence.find((e) => e.status === "FAIL");
    if (!failed) return false;
    if (failed.step !== "assert-missing-view") return false;
    return evidence.some((e) => e.kind === "action" && e.status === "PASS" && e.step === "open-missing-view");
  },
  launch: {
    window: false,
    defaultTimeoutMs: 5_000,
    // 不建宿主页：`pageFromView` 由 setup 给出。setup 自己返回一个**绝对不存在的**
    // docId 的视图表 —— 用 step.run 断言它里面没有视图。
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.run(() => ({ ok: true, observed: { probe: "deliberate-failure" } }), "open-missing-view"),
    step.run(async () => ({
      ok: false,
      observed: { docId: "t30-this-view-does-not-exist" },
      detail: "负控：这个视图从来不存在，断言必须在这里红。",
    }), "assert-missing-view", { assert: true }),
  ],
});
