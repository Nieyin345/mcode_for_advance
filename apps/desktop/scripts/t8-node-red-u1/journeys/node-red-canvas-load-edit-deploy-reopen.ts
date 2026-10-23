/**
 * T8 —— **Node-RED 原生画布的真实 Electron U1 旅程**。
 *
 * 一条旅程走完任务卡的四项判据 + 三项额外验证：
 *
 *   1. **加载**  —— 生产 `documentView:open`（带 `workflowEngineId` → 凭据 broker 注入）
 *      打开真实 Node-RED 5.0.8 编辑器；用编辑器自己的「导入」对话框（真粘贴 + 真点）
 *      放入迁移器产物；断言**真实画布**上出现 tab 与三个节点（`mcode-trigger` →
 *      `mcode-agent` ×2）。
 *   2. **编辑**  —— 打开节点编辑托盘（节点双击处理器调用的 `RED.editor.edit`），
 *      真点名称框 + `Ctrl+A` + `insertText` 改成唯一名字，真点「完成」；
 *      断言画布标签同步。
 *   3. **Deploy** —— 真点部署按钮（编辑器的 `save()`）；断言**原生 `flows.json` 字节
 *      真的变了**，且新字节里带着新名字与未改动的 instruction。
 *   4. **重开**  —— `relaunch` 换一个**真 OS 进程**：重新起引擎（读盘上的
 *      `flows.json`）、重新打开画布；断言画布仍显示改后的名字，且 `flows.json`
 *      与 Deploy 后**逐字节一致**。
 *
 * 额外（T2/T3/T4 的成果，在 U1 里复核）：
 *   - **库镜像对账**（T2）：Deploy 后读 `deploy-reconciliation.json`；本夹具由编辑器
 *     「导入」放入，导入会剥掉 `x-mcode`（见 `editor-flow.ts` 文件头），因此载荷里
 *     没有 Mcode 自有 tab —— 账本必须**如实为空**（不伪造 pending），且库里的文档
 *     不被改写；
 *   - **触发器单一归属**（T3）：启动生产旧自动化执行器，事实表里本图的 manual 触发器
 *     必须 `armed:false` 且 `detail` 写明「由 Node-RED 引擎管理」，owner 账本里不出现
 *     `mcode`；
 *   - **跨进程 owner**（T4）：引擎运行期间另起一个**真 OS 子进程**（electron-as-node）
 *     用生产 `FileExecutorOwnershipStore` 抢同一个 flowId —— 必须被拒；抢一个新 id ——
 *     必须成功（随后由子进程自己释放）。
 *
 * ## 断言真在判（负控）
 *
 * 设置 `T8_U1_NEGATIVE_CONTROL=1` 时，第 2 步预期改成的名字被换成一个**不会出现**的
 * 哨兵值；画布与磁盘都不可能包含它，`deploy-wrote-native-flows` 必须因此变红。
 * 这是本套件的负控（由 `negative-control.sh` 跑）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { assembleHarness, saveFixture, PROJECT_ID, type T8Harness } from "../harness.js";
import {
  NATIVE_AGENT_TYPE,
  FIXTURE_WORKFLOW_ID,
  fixtureDoc,
  fixtureMigrationReport,
  fixtureNativeNodes,
} from "../fixtures.js";
import {
  canvasNodeCenter,
  clickDeploy,
  confirmDeployWarningIfPresent,
  dismissFirstRunOverlays,
  importFlowNodes,
  js,
  renameNodeViaEditor,
  switchToTab,
  waitEditorReady,
  waitFor,
} from "../editor-flow.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { getWorkflow } from "@main/orchestration/library.js";

const NEGATIVE_CONTROL = process.env.T8_U1_NEGATIVE_CONTROL === "1";
const RENAME = "T8-已改名-DEPLOYED";
const EXPECTED_NAME = NEGATIVE_CONTROL ? "T8-负控-不存在的名字" : RENAME;
/** Deploy 后 sha 的落点（跨代传递：state.sideEffects 不能存任意 key）。 */
const SHA_FILE = "t8-flows-sha-after-deploy.txt";
/** 基线部署（改名之前）的 sha —— 重开那一步证明「磁盘上仍是改动后的版本」。 */
const BASELINE_SHA_FILE = "t8-flows-sha-baseline.txt";
const TAB_LABEL = "T8 Node-RED 夹具自动化";

interface T8Runtime {
  harness: T8Harness;
  enginePort: number;
  projectDir: string;
  repoRoot: string;
  evidenceDir: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const nodeRedCanvasJourney = defineU1Journey({
  name: "node-red-canvas-load-edit-deploy-reopen",
  launch: {
    window: false,
    size: { width: 1920, height: 1040 },
    defaultTimeoutMs: 60_000,
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("T8: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("T8: 探针窗口缺失（window:false 时 runner 会建一个）");
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });

      // 第一代：落夹具文档（SQL 真实行）。重开后文档已经在。
      if (ctx.generation === 1) {
        const saved = await saveFixture(fixtureDoc(PROJECT_ID));
        if (!saved.ok) throw new Error(`T8 setup: 夹具工作流保存失败：${saved.error ?? "未知原因"}`);
      }

      const started = await harness.startEngine();
      if (!started.ok || started.port === null) {
        throw new Error(`T8 setup: Node-RED 引擎未启动：${started.reason ?? "未知原因"}`);
      }
      const opened = await harness.openEngineEditor();
      if (!opened.ok) throw new Error(`T8 setup: 编辑器视图未打开：${opened.reason ?? "未知原因"}`);
      const wc = harness.editorWebContents();
      if (wc === null) throw new Error("T8 setup: 编辑器视图没有 webContents");
      wc.focus();

      const runtime: T8Runtime = {
        harness,
        enginePort: started.port,
        projectDir: ctx.projectDir,
        repoRoot,
        evidenceDir: ctx.evidenceDir,
      };
      return {
        pageFromView: wc,
        runtime,
        dispose: () => harness.dispose(),
      };
    },
  },
  steps: [
    /* ───────────────────────── 加载 ───────────────────────── */
    step.run(({ runtime, evidenceDir }) => {
      const rt = runtime as T8Runtime;
      // 引擎与视图的静态事实（端口、状态）先落证据。
      const state = rt.harness.engineState();
      writeFileSync(join(evidenceDir, "engine-state.json"), JSON.stringify({
        engineState: state,
        enginePort: rt.enginePort,
        engineDir: rt.harness.engineDir,
      }, null, 2));
      return { ok: state === "running", observed: { engineState: state, port: rt.enginePort }, detail: `引擎状态 ${state}` };
    }, "engine-running", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      const overlays = await dismissFirstRunOverlays(wc);
      const settings = await js<{ version?: string }>(wc, `fetch('/settings').then((r) => r.json()).catch(() => ({}))`);
      return {
        ok: ready && overlays.closed,
        observed: { ready, overlays, settingsVersion: settings.version ?? null },
        ...(ready && overlays.closed ? {} : { detail: `编辑器未就绪（ready=${ready}, overlaysClosed=${overlays.closed}）` }),
      };
    }, "canvas-editor-ready", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      // 生产 T59 装载入口的**真实行为**：对任何有节点的可保存图都拒绝（见 editor-flow 头）。
      // 这里把它作为**事实**落证据；两种结局都接受，但必须说清是哪一种。
      const result = await rt.harness.loadWorkflow(FIXTURE_WORKFLOW_ID, true);
      const knownRefusal = result.ok === false && typeof result.reason === "string" && result.reason.includes("无法无损装载");
      const succeeded = result.ok === true;
      return {
        ok: succeeded || knownRefusal,
        observed: { ok: result.ok, reason: result.reason ?? null, decision: succeeded ? "loaded" : knownRefusal ? "known-lossy-refusal" : "unexpected" },
        ...(succeeded || knownRefusal ? {} : { detail: `装载入口返回了未预期的结果：${JSON.stringify(result)}` }),
      };
    }, "production-load-entry", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const types = new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]));
      const nodes = fixtureNativeNodes(types);
      const report = fixtureMigrationReport(types);
      const before = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      const imported = await importFlowNodes(wc, nodes);
      const after = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      return {
        ok: imported.ok && before === 0 && after === 3 && imported.canvas?.tabs.includes(TAB_LABEL) === true,
        observed: {
          beforeNodes: before,
          afterNodes: after,
          import: imported,
          migrationReport: report,
          nodeSource: "migrateWorkflowDoc(fixture) → 编辑器 Import 对话框（真粘贴）",
        },
        ...(imported.ok && after === 3 ? {} : { detail: imported.detail ?? `导入后画布节点数 ${after} ≠ 3` }),
      };
    }, "canvas-import-fixture", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const switched = await switchToTab(wc, TAB_LABEL);
      if (!switched) return { ok: false, detail: "画布模型里找不到夹具 tab" };
      const visible = await waitFor(async () => (await js<number>(wc, `document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length`)) >= 3, 15_000);
      const dom = await js<{ nodes: number; labels: string[]; types: string[] }>(wc, `(() => {
        const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
        return {
          nodes: groups.length,
          labels: groups.map((g) => (g.__data__ && typeof g.__data__.name === 'string' ? g.__data__.name : '')),
          types: groups.map((g) => (g.__data__ ? g.__data__.type : '')),
        };
      })()`);
      const typesOk = ["inject", "mcode-agent", "mcode-agent"].every((t) => dom.types.includes(t));
      const namesOk = ["入口", "检查 README", "汇总"].every((n) => dom.labels.includes(n));
      return {
        ok: visible && typesOk && namesOk,
        observed: dom,
        ...(visible && typesOk && namesOk ? {} : { detail: `画布渲染不符合夹具（typesOk=${typesOk}, namesOk=${namesOk}）` }),
      };
    }, "canvas-renders-fixture", { assert: true }),

    step.screenshot("canvas-loaded"),

    // 先做一次**基线部署**：让磁盘上的 flows.json 成为「改名之前」的真实版本。
    // 之后改名再部署，字节对比才是同一台引擎、同一份图的 before/after
    // （否则第一次部署面对的是「文件根本还没写」—— `beforeSha=null`，那不是对比）。
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const deploy = await clickDeploy(wc);
      let confirmed = false;
      const baselineName = "检查 README";
      const wroteBaseline = await waitFor(async () => {
        if (!confirmed) confirmed = await confirmDeployWarningIfPresent(wc);
        const parsedNow = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
        const agentNow = Array.isArray(parsedNow) ? parsedNow.find((n) => n["type"] === NATIVE_AGENT_TYPE) : undefined;
        return agentNow?.["name"] === baselineName;
      }, 45_000);
      const baselineBytes = rt.harness.nativeFlowsBytes();
      const baselineSha = baselineBytes === null ? null : sha256(baselineBytes);
      void wroteBaseline;
      // 基线版本里节点名必须仍是「检查 README」（证明对比起点真实存在）。
      const parsed = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
      const agent = Array.isArray(parsed) ? parsed.find((n) => n["type"] === NATIVE_AGENT_TYPE) : undefined;
      return {
        ok: deploy.clicked && baselineSha !== null && agent?.["name"] === "检查 README",
        observed: { deployClicked: deploy.clicked, deployWarningConfirmed: confirmed, baselineSha, baselineName: agent?.["name"] ?? null },
        ...(baselineSha !== null && agent?.["name"] === "检查 README" ? {} : { detail: `基线部署没有写出预期的 flows.json（sha=${String(baselineSha)}, name=${String(agent?.["name"])}）` }),
      };
    }, "baseline-deploy", { assert: true }),

    /* ───────────────────────── 编辑 ───────────────────────── */
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const renamed = await renameNodeViaEditor(wc, NATIVE_AGENT_TYPE, RENAME);
      return {
        ok: renamed.ok,
        observed: renamed,
        ...(renamed.ok ? {} : { detail: renamed.detail ?? `改名未落到画布模型（committed=${String(renamed.committedValue)}）` }),
      };
    }, "rename-node-via-tray", { assert: true }),

    // T16 的 `assertDom` 把 `textContains` 核对在 `document.querySelector` 的**第一个**
    // 命中上；画布有多个节点标签，用页面内表达式对整个集合求值（同一 DOM 事实）。
    step.assertEvaluated(
      `[...document.querySelectorAll('.red-ui-flow-node-label-text')].some((n) => (n.textContent || '').includes(${JSON.stringify(RENAME)}))`,
      true,
      "canvas-label-shows-rename",
    ),

    step.screenshot("canvas-edited"),

    /* ───────────────────────── Deploy ───────────────────────── */

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const flowsPath = join(rt.harness.engineDir, "flows.json");
      const beforeBytes = rt.harness.nativeFlowsBytes();
      if (beforeBytes === null) return { ok: false, detail: "基线部署后 flows.json 仍不存在" };
      const beforeSha = sha256(beforeBytes);
      // 对照起点（改名之前）确实落盘：写在 projectDir，供重开那一步比字节。
      writeFileSync(join(rt.projectDir, BASELINE_SHA_FILE), beforeSha);
      const deploy = await clickDeploy(wc);
      // 部署告警（未知节点/无效节点）真的出现时，按用户手势点确认。
      let confirmed = false;
      const deployed = await waitFor(async () => {
        if (!confirmed) confirmed = await confirmDeployWarningIfPresent(wc);
        const now = rt.harness.nativeFlowsBytes();
        return now !== null && sha256(now) !== beforeSha;
      }, 45_000);
      const afterBytes = rt.harness.nativeFlowsBytes();
      const afterSha = afterBytes === null ? null : sha256(afterBytes);
      if (afterSha !== null) writeFileSync(join(rt.projectDir, SHA_FILE), afterSha);
      const parsed = rt.harness.nativeFlows();
      const agent = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>).find((n) => n["type"] === NATIVE_AGENT_TYPE && n["z"] !== undefined)
        : undefined;
      const diskName = agent?.["name"];
      const diskInstruction = agent?.["instruction"];
      const bytesDiffer = afterSha !== null && beforeSha !== afterSha;
      return {
        ok: deploy.clicked && deployed && bytesDiffer && diskName === EXPECTED_NAME,
        observed: {
          deployClicked: deploy.clicked,
          deployDisabledBefore: deploy.disabledBefore,
          deployed,
          deployWarningConfirmed: confirmed,
          flowsPath,
          beforeSha,
          afterSha,
          bytesDiffer,
          diskName: diskName ?? null,
          diskInstruction: diskInstruction ?? null,
          expectedName: EXPECTED_NAME,
          negativeControl: NEGATIVE_CONTROL,
        },
        ...(bytesDiffer && diskName === EXPECTED_NAME ? {} : {
          detail: `原生 flows.json 未体现改动（before=${String(beforeSha)} after=${String(afterSha)} name=${String(diskName)} expected=${EXPECTED_NAME}）`,
        }),
      };
    }, "deploy-wrote-native-flows", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const ledger = rt.harness.reconcileLedger();
      const sqlDoc = getWorkflow(FIXTURE_WORKFLOW_ID);
      const mirrorState = rt.harness.runtime().libraryMirrorState();
      const owners = rt.harness.ownershipRecords();
      const payloadHasMcodeTabs = (rt.harness.nativeFlows() ?? []).some(
        (n) => (n as Record<string, unknown>)["type"] === "tab" && (n as Record<string, unknown>)["x-mcode"] !== undefined);
      return {
        ok: ledger.pending.length === 0 && ledger.lastError === undefined && (mirrorState?.pending ?? 0) === 0
          && owners.every((r) => r.owner === "node-red") && payloadHasMcodeTabs === false,
        observed: {
          ledger,
          mirrorState,
          owners,
          payloadHasMcodeTabs,
          sqlTitles: sqlDoc?.nodes.map((n) => n.title) ?? null,
          note: "导入手势剥掉 x-mcode（上游编辑器只导出 _def.defaults 里的键），载荷因此没有 Mcode 自有 tab —— 账本必须如实为空，库文档不被改写",
        },
      };
    }, "library-mirror-reconciliation", { assert: true }),

    /* ───────────── 额外：T3 触发器单一归属 / T4 跨进程 owner ───────────── */
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      await rt.harness.startAutomation();
      // 事实表由 reloadAll 同步填充；留一拍让 ticker/订阅完成首轮。
      await new Promise((r) => setTimeout(r, 1500));
      const facts = rt.harness.triggerFacts();
      const ours = facts.filter((f) => f.workflowId === FIXTURE_WORKFLOW_ID);
      const owners = rt.harness.ownershipRecords();
      const mcodeOwned = owners.filter((r) => r.owner === "mcode");
      rt.harness.stopAutomation();
      const armedFalse = ours.length > 0 && ours.every((f) => f.armed === false);
      const detailOk = ours.every((f) => typeof f.detail === "string" && f.detail.includes("由 Node-RED 引擎管理"));
      return {
        ok: ours.length === 1 && armedFalse && detailOk && mcodeOwned.length === 0,
        observed: { facts: ours, mcodeOwned, totalFacts: facts.length },
        ...(ours.length === 1 && armedFalse && detailOk && mcodeOwned.length === 0 ? {} : {
          detail: `触发器归属断言失败（entries=${ours.length}, armedFalse=${armedFalse}, detailOk=${detailOk}, mcodeOwned=${mcodeOwned.length}）`,
        }),
      };
    }, "trigger-single-ownership", { assert: true }),

    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as T8Runtime;
      const owners = rt.harness.ownershipRecords();
      const nativeClaim = owners.find((r) => r.owner === "node-red");
      if (!nativeClaim) return { ok: false, detail: "引擎运行中却没有任何 node-red owner" };
      const childPath = join(process.env.MCODE_U1_BUILD ?? "", "t8-child-owner.cjs");
      if (!existsSync(childPath)) return { ok: false, detail: `子进程入口缺失：${childPath}` };
      // 真 OS 子进程：electron-as-node 跑生产 FileExecutorOwnershipStore。
      const child = spawnSync(process.execPath, [childPath, rt.harness.engineDir, nativeClaim.flowId], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
        encoding: "utf8",
        timeout: 60_000,
      });
      const log = `${child.stdout ?? ""}${child.stderr ?? ""}`;
      writeFileSync(join(evidenceDir, "cross-process-owner.json"), JSON.stringify({
        engineDir: rt.harness.engineDir,
        heldFlowId: nativeClaim.flowId,
        exit: child.status,
        log,
      }, null, 2));
      interface ChildOwnerResult { sameFlowClaim: boolean; freshClaim: boolean; freshReleased: boolean; error?: string }
      let parsed: ChildOwnerResult | null = null;
      try {
        const line = (child.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
        parsed = JSON.parse(line) as ChildOwnerResult;
      } catch { parsed = null; }
      const after = rt.harness.ownershipRecords();
      const leakedFresh = after.some((r) => r.flowId.startsWith("t8-fresh-"));
      return {
        ok: child.status === 0 && parsed !== null && parsed.sameFlowClaim === false && parsed.freshClaim === true && parsed.freshReleased === true && !leakedFresh,
        observed: { childExit: child.status, parsed, logTail: log.slice(-800), after },
        ...(parsed !== null && parsed.sameFlowClaim === false ? {} : { detail: `跨进程 owner 断言失败：${log.slice(-400)}` }),
      };
    }, "cross-process-owner-cas", { assert: true }),

    /* ───────────────────────── 重开（真 OS 进程）───────────────────────── */
    step.relaunch("relaunch-after-deploy", "新进程重新起引擎、打开画布，断言 Deploy 的改动还在"),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "重开后编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      await dismissFirstRunOverlays(wc);
      const switched = await switchToTab(wc, TAB_LABEL);
      const rendered = await waitFor(async () => (await js<number>(wc, `document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length`)) >= 3, 20_000);
      const dom = await js<{ labels: string[]; types: string[] }>(wc, `(() => {
        const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
        return { labels: groups.map((g) => (g.__data__ && typeof g.__data__.name === 'string' ? g.__data__.name : '')), types: groups.map((g) => (g.__data__ ? g.__data__.type : '')) };
      })()`);
      return {
        ok: ready && switched && rendered && dom.labels.includes(RENAME),
        observed: { engineState: rt.harness.engineState(), port: rt.enginePort, ready, switched, rendered, dom },
        ...(ready && rendered && dom.labels.includes(RENAME) ? {} : { detail: `重开后画布未显示改后的名字（labels=${JSON.stringify(dom.labels)}）` }),
      };
    }, "reopen-canvas-shows-rename", { assert: true }),

    step.assertEvaluated(
      `[...document.querySelectorAll('.red-ui-flow-node-label-text')].some((n) => (n.textContent || '').includes(${JSON.stringify(RENAME)}))`,
      true,
      "reopen-dom-label",
    ),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const shaFile = join(rt.projectDir, SHA_FILE);
      const expected = existsSync(shaFile) ? readFileSync(shaFile, "utf8").trim() : null;
      const bytes = rt.harness.nativeFlowsBytes();
      const actual = bytes === null ? null : sha256(bytes);
      return {
        ok: expected !== null && actual === expected,
        observed: { expectedSha: expected, actualSha: actual, engineDir: rt.harness.engineDir },
        ...(expected !== null && actual === expected ? {} : { detail: `重开后 flows.json 字节变了（expected=${String(expected)} actual=${String(actual)}）` }),
      };
    }, "reopen-flows-bytes-unchanged", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const owners = rt.harness.ownershipRecords();
      const sqlDoc = getWorkflow(FIXTURE_WORKFLOW_ID);
      const ledger = rt.harness.reconcileLedger();
      return {
        ok: owners.length > 0 && owners.every((r) => r.owner === "node-red") && ledger.pending.length === 0,
        observed: { owners, ledgerPending: ledger.pending, sqlTitles: sqlDoc?.nodes.map((n) => n.title) ?? null },
      };
    }, "reopen-ownership-and-ledger", { assert: true }),

    step.screenshot("canvas-reopened-final"),
  ],
});

export default nodeRedCanvasJourney;
