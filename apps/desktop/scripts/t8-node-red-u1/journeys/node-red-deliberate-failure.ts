/**
 * T8 —— **故意失败旅程**（骨架自检 + 变异验证的翻转点）。
 *
 * ## 它证明什么
 *
 * T16 的 `build.mjs` 在正常跑里**强制**要求「故意失败」旅程按预期红：它变绿 =
 * 断言被旁路（假绿）。本套件因此必须有一条 `expect:"fail"` 的旅程；它必须：
 *
 *  1. 在**指定步骤**失败（`failBecause` 只认那一步与那条形态）；
 *  2. 失败原因是**真实的界面事实**，不是骨架崩溃；
 *  3. 前置的正对照（`positive-control-canvas-live`）必须 PASS —— 证明编辑器真的
 *     在跑、画布真的有节点，失败不是因为页面没打开。
 *
 * 做法：在真实画布上断言一个**不可能存在**的节点名。这个断言与正式旅程里
 * `deploy-wrote-native-flows` 用的是同一档（`run` + `assert:true`）判定，所以把
 * `assertionStatus` 改成无条件 PASS 时它变绿 —— 变异验证的翻转点成立。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { assembleHarness, saveFixture, PROJECT_ID, type T8Harness } from "../harness.js";
import { fixtureDoc } from "../fixtures.js";
import { dismissFirstRunOverlays, js, waitEditorReady } from "../editor-flow.js";

const SENTINEL = "T8-DELIBERATE-FAILURE-SENTINEL-MUST-NOT-EXIST";
const FAIL_STEP = "sentinel-label-must-not-exist";

interface FailRuntime {
  harness: T8Harness;
}

export const deliberateFailureJourney = defineU1Journey({
  name: "node-red-deliberate-failure",
  expect: "fail",
  failBecause: (evidence) => {
    const failed = evidence.filter((e) => e.status === "FAIL");
    return failed.length === 1 && failed[0]!.step === FAIL_STEP;
  },
  launch: {
    window: false,
    size: { width: 1920, height: 1040 },
    defaultTimeoutMs: 60_000,
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("T8: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("T8: 探针窗口缺失");
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });
      if (ctx.generation === 1) {
        const saved = await saveFixture(fixtureDoc(PROJECT_ID));
        if (!saved.ok) throw new Error(`T8 setup: 夹具工作流保存失败：${saved.error ?? "未知原因"}`);
      }
      const started = await harness.startEngine();
      if (!started.ok) throw new Error(`T8 setup: Node-RED 引擎未启动：${started.reason ?? "未知原因"}`);
      const opened = await harness.openEngineEditor();
      if (!opened.ok) throw new Error(`T8 setup: 编辑器视图未打开：${opened.reason ?? "未知原因"}`);
      const wc = harness.editorWebContents();
      if (wc === null) throw new Error("T8 setup: 编辑器视图没有 webContents");
      wc.focus();
      const runtime: FailRuntime = { harness };
      return { pageFromView: wc, runtime, dispose: () => harness.dispose() };
    },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as FailRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      const overlays = await dismissFirstRunOverlays(wc);
      return { ok: ready && overlays.closed, observed: { ready, overlays } };
    }, "positive-control-editor-live", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as FailRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      // 正对照：空画布是**预期**状态（本旅程不导入任何节点）。
      const nodes = await js<number>(wc, `document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length`);
      return { ok: nodes === 0, observed: { canvasNodes: nodes } };
    }, "positive-control-empty-canvas", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as FailRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      // 故意失败：哨兵名在画布上**不可能**出现。它必须让本步 FAIL。
      const labels = await js<string[]>(wc, `[...document.querySelectorAll('.red-ui-flow-node-label-text')].map((n) => (n.textContent || ''))`);
      const present = labels.some((text) => text.includes(SENTINEL));
      return {
        ok: present,
        observed: { labels, sentinel: SENTINEL },
        detail: `画布上不可能出现哨兵名「${SENTINEL}」—— 本条失败是预期的（断言真的在判）`,
      };
    }, FAIL_STEP, { assert: true }),
  ],
});

export default deliberateFailureJourney;
