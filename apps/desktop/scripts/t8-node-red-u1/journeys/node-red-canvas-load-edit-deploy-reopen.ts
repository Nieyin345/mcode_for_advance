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
import type { WebContents } from "electron";
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
  deployRequestNames,
  dismissFirstRunOverlays,
  importFlowNodes,
  installDeployProbe,
  js,
  readDeployProbe,
  renameNodeViaEditor,
  resetDeployProbe,
  switchToTab,
  waitEditorReady,
  waitFor,
  waitForCaptureReady,
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

/** Bound Electron calls too: a closed-but-not-destroyed WebContents can leave executeJavaScript pending. */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** W29: labels are repainted asynchronously after a tray commit or page reload.
 * Poll the actual DOM assertion, not an arbitrary sleep or the in-memory model.
 * Include the last observed labels on timeout so a real regression is diagnosable. */
async function awaitCanvasLabel(
  wc: WebContents,
  expected: string,
  setupWebContentsId?: number,
): Promise<{
  ok: boolean;
  observed: {
    expected: string;
    labels: string[];
    firstLabels: string[];
    firstSampleAt: string | null;
    lastAttemptAt: string | null;
    lastSampleAt: string | null;
    lastError: string | null;
    webContentsId: number;
    webContentsUrl: string | null;
    setupWebContentsId: number | null;
    matchesSetupWebContents: boolean | null;
    attempts: number;
    elapsedMs: number;
    timeoutMs: number;
  };
  detail?: string;
}> {
  let labels: string[] = [];
  let firstLabels: string[] = [];
  let firstSampleAt: string | null = null;
  let lastAttemptAt: string | null = null;
  let lastSampleAt: string | null = null;
  let lastError: string | null = null;
  let webContentsUrl: string | null = null;
  let attempts = 0;
  const webContentsId = wc.id;
  const matchesSetupWebContents = setupWebContentsId === undefined ? null : webContentsId === setupWebContentsId;
  try { if (!wc.isDestroyed()) webContentsUrl = wc.getURL(); } catch { /* preserve identity even if URL is unavailable */ }
  const startedAt = Date.now();
  const timeoutMs = 10_000;
  const ok = await waitFor(async () => {
    attempts += 1;
    lastAttemptAt = new Date().toISOString();
    try {
      if (wc.isDestroyed()) throw new Error(`WebContents ${webContentsId} 已销毁`);
      labels = await withTimeout(
        js<string[]>(wc,
          `[...document.querySelectorAll('.red-ui-flow-node-label-text')].map(n => n.textContent || '')`),
        1000,
        "executeJavaScript 标签查询超过 1000ms",
      );
      lastError = null;
      const sampledAt = new Date().toISOString();
      if (firstSampleAt === null) {
        firstSampleAt = sampledAt;
        firstLabels = [...labels];
      }
      lastSampleAt = sampledAt;
      return labels.some((label) => label.includes(expected));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }, timeoutMs);
  const elapsedMs = Date.now() - startedAt;
  const labelFound = labels.some((label) => label.includes(expected));
  const identityMatches = matchesSetupWebContents !== false;
  const resultOk = ok && labelFound && identityMatches;
  const detailParts: string[] = [];
  if (!labelFound) detailParts.push(`最后实际标签：${JSON.stringify(labels)}`);
  if (lastError !== null) detailParts.push(`最后读取错误：${lastError}`);
  if (matchesSetupWebContents === false) detailParts.push(`当前编辑器 WebContents(${webContentsId}) 与 runner 捕获的 setup WebContents(${setupWebContentsId}) 不一致`);
  return {
    ok: resultOk,
    observed: {
      expected, labels, firstLabels, firstSampleAt, lastAttemptAt, lastSampleAt, lastError,
      webContentsId, webContentsUrl, setupWebContentsId: setupWebContentsId ?? null,
      matchesSetupWebContents, attempts, elapsedMs, timeoutMs,
    },
    ...(resultOk ? {} : { detail: `画布标签条件或视图身份未通过（${timeoutMs}ms）；${detailParts.join("；")}` }),
  };
}

interface T8Runtime {
  harness: T8Harness;
  /** The exact WebContents returned as pageFromView to the U1 driver at setup time. */
  setupWebContents: WebContents;
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
        setupWebContents: wc,
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

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const liveWc = rt.harness.editorWebContents();
      return liveWc === null
        ? { ok: false, detail: "首次画布截图前，编辑器视图不存在" }
        : await waitForCaptureReady(rt.setupWebContents, liveWc);
    }, "canvas-loaded-capture-ready", { assert: true }),
    step.screenshot("canvas-loaded"),

    // ── W23：装载后像生产渲染端一样**重新打开视图** ──
    //
    // `production-load-entry`（`loadWorkflowIntoNative`）会**停掉旧引擎、换端口重启**
    // （`nativeLibraryLoad.ts` 的 stop → start）。生产渲染端由 `EngineRuntimePanel`
    // 的 `status.editorUrl` effect 负责：URL 变了就 `api.documentView.open`（同一
    // docId，宿主按 URL 变化 `navigate`，见 `documentViewHost.ts:611`）。旅程原先只在
    // 装载**之前**开过一次视图，于是点部署时页面停在已关闭的旧端口上 —— W5 实测
    // `POST flows status 0`、「部署失败: 服务器没有响应」。
    //
    // 这里补上同一行为，**不硬编码端口**：新 URL 由宿主从引擎**此刻的 status.port**
    // 重新算（`harness.openEngineEditor()` 与生产 `toStatusView` 同一来源）。
    // 覆盖顺序与生产 effect 一致：URL 变了就重开；open 失败是**显式红**，不静默继续。
    //
    // 重开后页面从新引擎的 `flows.json` 重新载入（这份文件是装载写下的迁移产物，
    // 与刚导入的图是同一份夹具），所以导入手势的断言仍然成立；重新载入的页面是
    // **干净**的（`deploy.js` 的 `workspace:dirty` 把部署按钮置灰），基线部署要的是
    // 一次真实部署，因此像任何一次编辑那样置 `dirty(true)` —— 全量部署提交的本来
    // 就是整张画布（`save()` 的 `createCompleteNodeSet()`），内容不由此改变。
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const portOf = (url: string): number | null => {
        try { return Number(new URL(url).port) || null; } catch { return null; }
      };
      const beforeUrl = await js<string>(wc, `window.location.href`);
      const beforePort = portOf(beforeUrl);
      const enginePort = rt.harness.enginePort();
      const portChanged = enginePort !== null && beforePort !== null && beforePort !== enginePort;

      let open: { ok: boolean; reason?: string } = { ok: true };
      let navigated = true;
      if (portChanged) {
        // `deploy.js:118` 的 beforeunload 在 dirty 时 `event.preventDefault()`，
        // 会让 `loadURL` 被取消（W5 证据 12-41-15-384Z 的 `document view navigation
        // failed`）。导入手势让画布是 dirty 的，导航前先清掉。
        await js(wc, `(RED.nodes.dirty(false), true)`);
        open = await rt.harness.openEngineEditor();
        if (!open.ok) {
          return {
            ok: false,
            observed: { beforeUrl, beforePort, enginePort, portChanged, open },
            detail: `装载后重新打开编辑器视图失败：${open.reason ?? "未知原因"}（视图仍停在旧端口，后续部署必然连不上）`,
          };
        }
        // 宿主的导航是异步的（`navigate` 不等待 loadURL）：必须等到页面**真的离开
        // 旧 URL**，否则后面所有手势仍作用在旧页面上。
        navigated = await waitFor(async () => (await js<string>(wc, `window.location.href`)) !== beforeUrl, 45_000);
        if (!navigated) {
          return {
            ok: false,
            observed: { beforeUrl, beforePort, enginePort, portChanged, open },
            detail: `open 返回 ok，但页面 45s 内没有离开旧 URL（${beforeUrl}）—— 视图没有真的重开`,
          };
        }
      }

      const ready = await waitEditorReady(wc, 60_000);
      const overlays = await dismissFirstRunOverlays(wc);
      // 新页面的 flows 是异步载入的：等夹具 tab 出现再切（直接 switchToTab 会早于载入）。
      const switched = await waitFor(async () => await switchToTab(wc, TAB_LABEL), 30_000);
      const rendered = await waitFor(async () => (await js<number>(wc, `document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length`)) >= 3, 20_000);
      const afterUrl = await js<string>(wc, `window.location.href`);
      const afterPort = portOf(afterUrl);
      const urlChanged = beforeUrl !== afterUrl;
      // 重载后的页面是干净的：不置 dirty，`deploy.js` 的 save() 第一行就 return
      // （按钮 `disabled`），基线部署会「点了但什么都没发生」—— 那会以
      // 「没有观察到 POST /flows 请求」的红出现，离真因远。这里显式置 dirty 并把
      // 按钮已启用的状态记进证据（`deployDisabledBefore` 在下一步还有一份）。
      let deployButtonEnabled: boolean | null = null;
      if (portChanged) {
        await js(wc, `(RED.nodes.dirty(true), true)`);
        const buttonState = await js<{ disabled: boolean }>(wc, `(() => {
          const el = document.getElementById('red-ui-header-button-deploy');
          return { disabled: !el || el.classList.contains('disabled') };
        })()`);
        deployButtonEnabled = !buttonState.disabled;
      }

      const live = afterPort !== null && enginePort !== null && afterPort === enginePort;
      const ok = ready && overlays.closed && switched && rendered && live
        && (portChanged ? urlChanged && deployButtonEnabled === true : true);
      const failures: string[] = [];
      if (!ready) failures.push("编辑器未就绪");
      if (!overlays.closed) failures.push("首次启动模态没有关掉");
      if (!switched) failures.push(`画布里找不到「${TAB_LABEL}」页签`);
      if (!rendered) failures.push("重开后画布没有渲染出 3 个节点");
      if (!live) failures.push(`页面端口 ${String(afterPort)} ≠ 引擎监听端口 ${String(enginePort)}`);
      if (portChanged && !urlChanged) failures.push("端口变了但页面 URL 没变 —— 视图没有重新导航");
      if (portChanged && deployButtonEnabled !== true) failures.push("重开并置 dirty 后部署按钮仍是禁用态（下一次点部署不会发请求）");
      return {
        ok,
        observed: {
          beforeUrl, beforePort, enginePort, portChanged,
          open, navigated, afterUrl, afterPort, urlChanged,
          ready, overlays, switched, rendered, deployButtonEnabled,
        },
        ...(ok ? {} : { detail: `装载后重新打开视图没有被证明成功：${failures.join("；")}` }),
      };
    }, "reopen-view-after-load", { assert: true }),

    // 先做一次**基线部署**：让磁盘上的 flows.json 成为「改名之前」的真实版本。
    // 之后改名再部署，字节对比才是同一台引擎、同一份图的 before/after
    // （否则第一次部署面对的是「文件根本还没写」—— `beforeSha=null`，那不是对比）。
    //
    // ── W5：这一步必须证明的是「**部署被服务器接受了**」，不是「flows.json 里有名字」 ──
    //
    // 旧判据（`deploy.clicked && baselineSha !== null && agent.name === "检查 README"`）
    // 三件事全都不成立：
    //   - `clicked` 只说明鼠标点到了按钮；
    //   - `flows.json` 是更早的 `loadWorkflowIntoNative`（生产 T59 装载）写下的，
    //     而装载会**停掉旧引擎、换端口重启**（`nativeLibraryLoad.ts` 的 stop → start）。
    //     本旅程在装载之前就打开了编辑器页，装载之后也没有像生产渲染端那样把视图
    //     重新导航到新 URL（`EngineRuntimePanel` 的 `status.editorUrl` effect）；
    //     于是点部署时页面还停在**已关闭的旧端口**上 —— 「部署失败: 服务器没有响应」
    //     是真的（连接被拒：`xhr.status = 0`、`responseText = ""`，上游
    //     `ui/deploy.js:685` 正是这个条件弹那句通知）；
    //   - 「文件里有名字」成立与否跟这次点击毫无因果关系。
    //
    // 新判据（缺一即红，detail 逐条点名）：
    //   入口：页面 origin 端口 == 引擎此刻的监听端口（否则请求根本到不了这台引擎）；
    //   网络：一次 `POST */flows` 的响应 2xx（失败/无响应都会在这里红）；
    //   事件：`RED.events` 发出 `deploy`（上游只在成功回调里发，失败不发）；
    //   DOM ：没有 `red-ui-notification-error` / 「部署失败」通知（成功通知是旁证）；
    //   内容：请求体里带着基线名字（证明部署的就是这张图，不是别的请求）；
    //   磁盘：**事后** flows.json 仍存在且 agent 名字是基线的（不要求字节不变 ——
    //         成功部署会重写文件，字节变不变都不是成败信号）。
    //
    // 判据来源（上游 5.0.8）：`@node-red/editor-client/src/js/ui/deploy.js`
    //   save()：`$.ajax({url:"flows", type:"POST"})` 成功回调 `RED.events.emit("deploy")`
    //   并弹 `deploy.successfulDeploy`；fail 回调按 401/409/responseText 分支，
    //   `responseText` 为空时弹 `deploy.deployFailed` + `deploy.errors.noResponse`
    //   （zh-CN：`部署失败: 服务器没有响应`）。
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const baselineName = "检查 README";

      // 入口有效性：编辑器页的 origin 与引擎当前的监听端口必须一致。
      // 装载（T59）会重启引擎换端口；旅程没有生产渲染端那层「editorUrl 变了就
      // 重新 open」的 effect，所以这里把两个端口如实记录 —— 不一致本身就是
      // 「部署不可能被接受」的直接原因，要原样进 detail，而不是被一句
      // 「flows.json 里有名字」盖住。
      const pageOrigin = await js<string>(wc, `window.location.origin`);
      const enginePort = rt.harness.enginePort();
      const pageUrl = await js<string>(wc, `window.location.href`);
      const pagePort = (() => {
        try { return Number(new URL(pageOrigin).port) || null; } catch { return null; }
      })();
      const entryLive = pagePort !== null && enginePort !== null && pagePort === enginePort;

      // 三层信号探针必须在点击**之前**装好（失败通知只活 5 秒，轮询会错过）。
      const probeInstall = await installDeployProbe(wc);
      if (probeInstall.installed) await resetDeployProbe(wc);

      const beforeBytes = rt.harness.nativeFlowsBytes();
      const beforeSha = beforeBytes === null ? null : sha256(beforeBytes);

      // 即使入口已死也**真点一次**：这条红的价值就在于把「服务器没有响应」从
      // 一条绿断言底下翻出来。点到 / 没点到由 clickDeploy 如实返回。
      const deploy = await clickDeploy(wc);
      let confirmed = false;
      // 轮询「这一次部署有了结论」：拿到部署请求的响应，或看到 `deploy` 事件，
      // 或出现失败通知。超时也继续 —— 超时本身就是证据（无响应）。
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (!confirmed) confirmed = await confirmDeployWarningIfPresent(wc);
        const read = await readDeployProbe(wc);
        const failedNotice = read.notifications.some((n) => n.cls.includes("red-ui-notification-error") || n.text.includes("部署失败"));
        if (read.deployRequests.length > 0 || read.deployEvents > 0 || failedNotice) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      // 等响应落定后再读一次（`loadend` 可能比轮询晚一拍；通知也可能刚弹出来）。
      await new Promise((r) => setTimeout(r, 300));
      const probe = await readDeployProbe(wc);

      const deployRequests = probe?.deployRequests ?? [];
      const response = deployRequests.length > 0 ? deployRequests[deployRequests.length - 1]! : null;
      const responseOk = response !== null && response.status >= 200 && response.status < 300;
      const deployEventSeen = (probe?.deployEvents ?? 0) > 0;
      const failureNotices = (probe?.notifications ?? []).filter((n) => n.cls.includes("red-ui-notification-error") || n.text.includes("部署失败"));
      const successNotices = (probe?.notifications ?? []).filter((n) => n.cls.includes("red-ui-notification-success") || n.text.includes("部署成功"));
      // 内容层：请求体里必须出现基线名字（部署提交的就是这张图）。
      const payload = response === null ? null : deployRequestNames(response.body);
      const payloadHasBaseline = payload !== null && payload.ok && payload.names.includes(baselineName);

      // 磁盘层（只做「事后仍在」的兜底，不做字节判据）：
      const afterBytes = rt.harness.nativeFlowsBytes();
      const afterSha = afterBytes === null ? null : sha256(afterBytes);
      const parsed = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
      const agent = Array.isArray(parsed) ? parsed.find((n) => n["type"] === NATIVE_AGENT_TYPE) : undefined;
      const baselineNameOnDisk = agent?.["name"] ?? null;

      const ok = deploy.clicked
        && responseOk
        && deployEventSeen
        && failureNotices.length === 0
        && payloadHasBaseline
        && afterSha !== null
        && baselineNameOnDisk === baselineName;
      // `entry` 只是根因诊断，不单独进 `ok`：部署成功与否由上面那些信号判
      // （入口已死时网络层必然 status 0 —— 那一条本身就是失败）。但红的时候
      // 两个端口都要写进 detail，否则下一个人只能像 W0 那样从截图里猜。
      const entryHint = entryLive
        ? null
        : `（根因线索：编辑器页端口 ${String(pagePort)} ≠ 引擎监听端口 ${String(enginePort)} —— 装载重启引擎换了端口，页面停在已关闭的旧端口，请求到不了这台引擎）`;
      const failures: string[] = [];
      if (!deploy.clicked) failures.push("部署按钮没点到");
      if (deploy.clicked && response === null) failures.push(`没有观察到 POST /flows 请求（部署按钮可能禁用，或编辑器没发出请求）${entryHint ?? ""}`);
      if (response !== null && !responseOk) {
        failures.push(`部署请求未成功：HTTP ${response.status}${response.responseText !== "" ? `（${response.responseText.slice(0, 160)}）` : "（无响应体 —— 上游正因此弹「服务器没有响应」）"}${entryHint ?? ""}`);
      }
      if (responseOk && !deployEventSeen) failures.push("部署请求 2xx 但编辑器没有发出 deploy 事件");
      if (failureNotices.length > 0) failures.push(`出现部署失败通知：${failureNotices.map((n) => n.text).join(" / ")}`);
      if (response !== null && !payloadHasBaseline) failures.push(payload !== null && payload.ok ? `部署内容里没有「${baselineName}」（${payload.names.join(",") || "无名字节点"}）` : `部署请求体解析失败：${payload?.parseError ?? "未知"}`);
      if (baselineNameOnDisk !== baselineName) failures.push(`磁盘上基线名字是「${String(baselineNameOnDisk)}」而不是「${baselineName}」`);
      return {
        ok,
        observed: {
          entry: { pageUrl, pageOrigin, pagePort, enginePort, entryLive },
          deployClicked: deploy.clicked,
          deployDisabledBefore: deploy.disabledBefore,
          deployWarningConfirmed: confirmed,
          probeInstalled: probeInstall,
          network: {
            deployRequestCount: deployRequests.length,
            last: response === null ? null : { method: response.method, url: response.url, status: response.status, responseText: response.responseText },
            otherRequests: probe?.otherRequests ?? 0,
            responseOk,
          },
          events: { deployEventSeen, deployEvents: probe?.deployEvents ?? 0 },
          dom: { notifications: probe?.notifications ?? [], failureNotices, successNoticeCount: successNotices.length },
          payload: payload === null ? null : { ok: payload.ok, names: payload.names, types: payload.types, hasBaseline: payloadHasBaseline, parseError: payload.parseError ?? null },
          disk: { beforeSha, afterSha, baselineName: baselineNameOnDisk, note: "基线部署成功会重写 flows.json（字节变不变不是成败信号）；它出现时仍带着基线名字即可" },
        },
        ...(ok ? {} : { detail: `基线部署没有被证明成功：${failures.join("；")}` }),
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

    // The driver captures pageFromView once at setup; production host.open may
    // navigate the existing view after an engine-port change. Check the live view
    // and record whether it is still the same WebContents the driver will assert/screenshot.
    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const liveWc = rt.harness.editorWebContents();
      return liveWc === null
        ? { ok: false, detail: "改名后编辑器视图不存在" }
        : await awaitCanvasLabel(liveWc, RENAME, rt.setupWebContents.id);
    }, "canvas-label-shows-rename", { assert: true }),

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
      // 【W23 2026-10-25】这条断言在 T28（7ba94777，10-23 19:19）之后**方向反了**。
      //
      // T28 的提交信息原文：「Node-RED's editor serialises only keys declared in a
      // type's `_def.defaults`, so Mcode's `x-mcode` sidecar vanished on export ...
      // declare `x-mcode` in the generated editor defaults」。也就是说，
      // **T28 的目的就是让 `x-mcode` 出现在导出/部署的载荷里**，好让导入时能把这张
      // 流关联回它的库文档（上游 `nodes.js:1263` `for (var d in n._def.defaults)`）。
      //
      // 而本条断言要求 `payloadHasMcodeTabs === false` —— **那是 T28 之前的形状**。
      // 两者直接冲突，T28 赢了，于是这条断言从 10-23 起对任何一次**成功部署**都恒假。
      //
      // 它不是「还没修的问题」，是**一条永远红的断言** —— 和永远绿一样，不再告诉你任何东西。
      // 现在改成验 T28 想要的**正**结果：载荷里的 tab 带着 `x-mcode`，且它指向的是
      // 本夹具那份库文档（`x-mcode.docId`）。这样它同时守住：
      //   ① 导出没有被上游剥掉（T28 的回归网）；
      //   ② 关联回去的是**正确的那一份**（不是另一张流的 id）。
      const tabWithSidecar = (rt.harness.nativeFlows() ?? []).find(
        (n) => (n as Record<string, unknown>)["type"] === "tab" && (n as Record<string, unknown>)["x-mcode"] !== undefined,
      ) as Record<string, unknown> | undefined;
      const sidecar = tabWithSidecar?.["x-mcode"] as Record<string, unknown> | undefined;
      const sidecarDocId = typeof sidecar?.["docId"] === "string" ? sidecar["docId"] : null;
      return {
        ok: ledger.pending.length === 0 && ledger.lastError === undefined && (mirrorState?.pending ?? 0) === 0
          && owners.every((r) => r.owner === "node-red")
          && payloadHasMcodeTabs === true && sidecarDocId === FIXTURE_WORKFLOW_ID,
        observed: {
          ledger,
          mirrorState,
          owners,
          payloadHasMcodeTabs,
          sidecarDocId,
          expectedDocId: FIXTURE_WORKFLOW_ID,
          sqlTitles: sqlDoc?.nodes.map((n) => n.title) ?? null,
          note: "T28 起 `x-mcode` 由 `_def.defaults` 声明、随导出保留（上游 nodes.js 只抄 defaults）。本步验它**在**、且 docId 指回本夹具那份库文档 —— 账本仍须为空、库文档不被改写。",
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
      let dom: { count: number; labels: string[]; types: string[] } = { count: 0, labels: [], types: [] };
      let renderAttempts = 0;
      const rendered = await waitFor(async () => {
        renderAttempts += 1;
        dom = await js<{ count: number; labels: string[]; types: string[] }>(wc, `(() => {
          const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
          return { count: groups.length, labels: groups.map((g) => (g.__data__ && typeof g.__data__.name === 'string' ? g.__data__.name : '')), types: groups.map((g) => (g.__data__ ? g.__data__.type : '')) };
        })()`);
        // Node count alone is not enough: the node's model can be loaded before
        // its label has been painted. Wait for the original name criterion too.
        return dom.count >= 3 && dom.labels.includes(RENAME);
      }, 20_000);
      return {
        ok: ready && switched && rendered,
        observed: { engineState: rt.harness.engineState(), port: rt.enginePort, ready, switched, rendered, renderAttempts, dom },
        ...(ready && switched && rendered ? {} : { detail: `重开后画布未在 20s 内显示改后的名字（count=${dom.count}, attempts=${renderAttempts}, labels=${JSON.stringify(dom.labels)}）` }),
      };
    }, "reopen-canvas-shows-rename", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const liveWc = rt.harness.editorWebContents();
      return liveWc === null
        ? { ok: false, detail: "重开后编辑器视图不存在" }
        : await awaitCanvasLabel(liveWc, RENAME, rt.setupWebContents.id);
    }, "reopen-dom-label", { assert: true }),

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

    step.run(async ({ runtime }) => {
      const rt = runtime as T8Runtime;
      const liveWc = rt.harness.editorWebContents();
      return liveWc === null
        ? { ok: false, detail: "重开截图前编辑器视图不存在" }
        : await waitForCaptureReady(rt.setupWebContents, liveWc);
    }, "reopen-capture-ready", { assert: true }),
    step.screenshot("canvas-reopened-final"),
  ],
});

export default nodeRedCanvasJourney;
