/**
 * W2 —— **在 UI 里点一下 inject，看到 debug 侧栏里出现那条消息**。
 *
 * ## 补的是什么缺口
 *
 * 无头层已经有 `node-red-e2e-smoke`：真跑过「Mcode 执行器 → Node-RED HTTP-in →
 * 回灌 payload」，并断言了 `msg.payload`。**它证明引擎能执行。**
 *
 * 缺的是**真 Electron UI 层**：用户在画布上点 inject 节点的按钮，debug 侧栏里
 * 出不出现那条消息。这一步把「部署成功」与「跑出结果」区分开：
 * 部署只证明 `flows.json` 写对了，不证明 runtime 在跑、不证明 debug 节点把消息
 * 推到了侧栏。
 *
 * ## 图从哪来
 *
 * 本旅程**不复用 W1 旅程跑出来的磁盘状态** —— `build.mjs` 给每条旅程 mktemp 独立
 * 的 `runDir`（各自一份 `data/workflow-engines/node-red/flows.json`），W1 部署的
 * 那份在 W1 进程退出后不会进到 W2。**「复用」在这里的含义是复用 W1 的产物**：
 * 同一组 `editor-flow.ts` 辅助函数（`dragPaletteNodeToCanvas` /
 * `dragNodeOutputToInput`），按同样的手势在 W2 自己的 runDir 里重建同一张
 * `inject → debug` 图。**不是**第二个建图实现，也**不是**用 `RED.nodes.import`
 * 抄一份 JSON。
 *
 * ## 判据（不是「面板有内容」）
 *
 * 主判据是**具体 payload 文本**：`w2-probe-<时间戳>`（固定前缀 + 唯一后缀）。
 *   1. 前缀固定 → 可以断言「侧栏里出现的正是这一条」；
 *   2. 后缀唯一 → 排除「上一轮残留 / 别的旅程留下」的可能（同一进程里不会有
 *      第二条带这个后缀的消息）。
 *
 * 还要断言它出现在 **debug 侧栏**（`#red-ui-sidebar-container .red-ui-debug-msg`）
 * 而不是别的侧栏：Node-RED 侧栏有 info / help / config / context / debug 多个 tab，
 * 只查全局 `.red-ui-debug-msg` 会把「调试窗口」弹窗也当成侧栏。
 *
 * 旁证（**不是**主判据）：通知条里出现 `成功注入: w2-probe-…` —— 证明
 * `POST inject/<id>` 被运行时接受（200），排除「点是点到了但 HTTP 失败」。
 *
 * ## 变异
 *
 * `W2_MUTATION` 环境变量不参与 —— 变异直接改源码（见回写）：把「点按钮」换成空操作后，
 * 第 2 步（通知条旁证）与第 3 步（debug 侧栏主判据）都必须红。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { assembleHarness, type T8Harness } from "../harness.js";
import {
  clickDeploy,
  clickInjectNodeButton,
  confirmDeployWarningIfPresent,
  dismissFirstRunOverlays,
  dragNodeOutputToInput,
  dragPaletteNodeToCanvas,
  js,
  openDebugSidebarAndClear,
  readDebugMessages,
  readNotifications,
  setInjectPayload,
  waitEditorReady,
  waitFor,
} from "../editor-flow.js";

interface W2Runtime {
  harness: T8Harness;
  enginePort: number;
  /** 本轮唯一的 payload（`w2-probe-<毫秒时间戳>`），跨 step 共享。 */
  probe: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function chartRect(wc: WebContents): Promise<{ left: number; top: number; width: number; height: number } | null> {
  return await js<{ left: number; top: number; width: number; height: number } | null>(wc, `(() => {
    const el = document.getElementById('red-ui-workspace-chart');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  })()`);
}

export const nodeRedRunAndSeeResultJourney = defineU1Journey({
  name: "node-red-run-and-see-result",
  launch: {
    window: false,
    size: { width: 1920, height: 1040 },
    defaultTimeoutMs: 60_000,
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("W2: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("W2: 探针窗口缺失（window:false 时 runner 会建一个）");
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });
      const started = await harness.startEngine();
      if (!started.ok || started.port === null) {
        throw new Error(`W2 setup: Node-RED 引擎未启动：${started.reason ?? "未知原因"}`);
      }
      const opened = await harness.openEngineEditor();
      if (!opened.ok) throw new Error(`W2 setup: 编辑器视图未打开：${opened.reason ?? "未知原因"}`);
      const wc = harness.editorWebContents();
      if (wc === null) throw new Error("W2 setup: 编辑器视图没有 webContents");
      wc.focus();
      // 每代进程用同一个 probe（存在 projectDir 的 state 文件里）—— 本旅程没有
      // relaunch，但进程重启后若从 stepOffset 续跑，payload 必须还是那个字符串。
      const probeFile = join(ctx.projectDir, "w2-probe.txt");
      const probe = ctx.generation === 1 || !existsSync(probeFile)
        ? `w2-probe-${Date.now()}`
        : readFileSync(probeFile, "utf8").trim();
      if (ctx.generation === 1) writeFileSync(probeFile, probe);
      const runtime: W2Runtime = { harness, enginePort: started.port, probe };
      return { pageFromView: wc, runtime, dispose: () => harness.dispose() };
    },
  },
  steps: [
    /* ── 0. 前置：用 W1 的辅助函数重建 inject → debug 并部署 ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W2Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      const overlays = await dismissFirstRunOverlays(wc);
      const chart = await chartRect(wc);
      if (chart === null) return { ok: false, detail: "画布不可见" };
      const before = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);

      // 与 W1 步 2/3 完全同一对手势（同一坐标比例，便于对照）。
      const injectDrop = await dragPaletteNodeToCanvas(wc, "inject", {
        x: Math.round(chart.left + chart.width * 0.34),
        y: Math.round(chart.top + chart.height * 0.30),
      });
      const debugDrop = await dragPaletteNodeToCanvas(wc, "debug", {
        x: Math.round(chart.left + chart.width * 0.60),
        y: Math.round(chart.top + chart.height * 0.30),
      });
      const wire = await dragNodeOutputToInput(wc, "inject", "debug");
      const injectId = wire.sourceId;
      const debugId = wire.targetId;
      const ok = ready && overlays.closed && before === 0 && injectDrop.dropped && debugDrop.dropped
        && wire.linked && injectId !== null && debugId !== null;
      return {
        ok,
        observed: {
          ready, overlays, chart, before,
          injectDrop, debugDrop, wire, injectId, debugId,
          note: "图与 W1 同一组辅助函数、同一对手势重建（不是 import JSON，也不是 RED.nodes.addLink）",
        },
        ...(ok ? {} : { detail: `前置建图失败（injectDrop=${injectDrop.dropped}, debugDrop=${debugDrop.dropped}, wire=${wire.linked}）` }),
      };
    }, "build-inject-to-debug", { assert: true }),

    /* ── 0b. 给 inject 设固定 payload 并部署（payload 是「被测输入」，不是「被测动作」） ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W2Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const injectId = await js<string | null>(wc, `(() => { const n = RED.nodes.createCompleteNodeSet().find((x) => x.type === 'inject'); return n ? String(n.id) : null; })()`);
      if (injectId === null) return { ok: false, detail: "画布上找不到 inject 节点（上一步失败？）" };
      const set = await setInjectPayload(wc, injectId, rt.probe);
      if (!set.ok) return { ok: false, observed: { injectId, set }, detail: set.detail ?? "设置 inject payload 失败" };
      const beforeBytes = rt.harness.nativeFlowsBytes();
      const beforeSha = beforeBytes === null ? null : sha256(beforeBytes);
      const deploy = await clickDeploy(wc);
      let confirmed = false;
      const wrote = await waitFor(async () => {
        if (!confirmed) confirmed = await confirmDeployWarningIfPresent(wc);
        const now = rt.harness.nativeFlowsBytes();
        return now !== null && (beforeSha === null || sha256(now) !== beforeSha);
      }, 45_000);
      const parsed = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
      const diskInject = Array.isArray(parsed)
        ? parsed.find((n) => n["type"] === "inject" && n["id"] === injectId) as Record<string, unknown> | undefined
        : undefined;
      const diskProps = diskInject && Array.isArray(diskInject["props"]) ? diskInject["props"] as Array<Record<string, unknown>> : null;
      const diskPayload = diskProps ? diskProps.find((p) => p["p"] === "payload") : undefined;
      const payloadOnDisk = diskPayload !== undefined
        && diskPayload["v"] === rt.probe && diskPayload["vt"] === "str";
      const afterSha = rt.harness.nativeFlowsBytes();
      const ok = deploy.clicked && wrote && payloadOnDisk;
      return {
        ok,
        observed: {
          injectId, set, probe: rt.probe,
          deployClicked: deploy.clicked, deployWarningConfirmed: confirmed, wrote,
          beforeSha, afterSha: afterSha === null ? null : sha256(afterSha),
          diskInjectPayload: diskPayload ?? null,
          runtimeMayBeSafeMode: "见下一步：safeMode 下 runtime 不启动，inject 按钮会带 node-button-stopped",
        },
        ...(ok ? {} : { detail: `部署后磁盘上的 inject 没有固定的 str payload（payloadOnDisk=${payloadOnDisk}, wrote=${wrote}）` }),
      };
    }, "deploy-with-fixed-payload", { assert: true }),

    /* ── 1. 打开 debug 侧栏并清空（判据：侧栏可见） ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W2Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const sidebar = await openDebugSidebarAndClear(wc);
      // 旁证：runtime 是否真的在跑（safeMode 下是 safe，不是 start）。
      const runtimeState = await js<{ started: boolean; state: string | null }>(wc, `(() => ({
        started: !!RED.runtime && RED.runtime.started === true,
        state: (() => {
          const btns = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-button')];
          return btns.length > 0 ? (btns[0].classList.contains('red-ui-flow-node-button-stopped') ? 'stopped-class' : 'running-class') : null;
        })(),
      }))()`);
      return {
        ok: sidebar.opened && sidebar.cleared && sidebar.chromeVisible,
        observed: { sidebar, runtimeState },
        ...(sidebar.opened && sidebar.cleared && sidebar.chromeVisible
          ? {}
          : { detail: sidebar.detail ?? "debug 侧栏没有打开或没有清空" }),
      };
    }, "debug-sidebar-open", { assert: true }),

    step.screenshot("w2-debug-sidebar-open"),

    /* ── 2. 点 inject 按钮（真鼠标）→ 旁证：通知条 ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W2Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const injectId = await js<string | null>(wc, `(() => { const n = RED.nodes.createCompleteNodeSet().find((x) => x.type === 'inject'); return n ? String(n.id) : null; })()`);
      if (injectId === null) return { ok: false, detail: "画布上找不到 inject 节点" };
      const clicked = await clickInjectNodeButton(wc, injectId);
      // 通知条是旁证，但**必须有**：它证明 POST inject/<id> 被接受。没有它，
      // 「点了但没触发」与「触发了但 debug 节点没收到」无法区分。
      const notified = await waitFor(async () => {
        const n = await readNotifications(wc);
        return n.successCount > 0 && n.texts.some((t) => t.includes(rt.probe) || t.includes("成功注入") || t.includes("Successfully injected"));
      }, 10_000);
      const notifications = await readNotifications(wc);
      return {
        ok: clicked.clicked && notified,
        observed: { injectId, clicked, notified, notifications, probe: rt.probe },
        ...(clicked.clicked && notified ? {} : {
          detail: clicked.detail ?? `点 inject 后没有出现注入成功的通知（notifications=${JSON.stringify(notifications.texts)}）`,
        }),
      };
    }, "click-inject-button", { assert: true }),

    /* ── 3. 主判据：debug 侧栏出现那条 payload ── */
    step.run(async ({ runtime }) => {
      const rt = runtime as W2Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      // 消息经 runtime → websocket 回灌到编辑器，有一小段延迟；轮询到超时。
      const appeared = await waitFor(async () => {
        const m = await readDebugMessages(wc);
        return m.messages.some((x) => x.payloadText !== null && x.payloadText.includes(rt.probe) && x.visible);
      }, 15_000, 250);
      const messages = await readDebugMessages(wc);
      // 它必须出现在**当前流程**的 debug 消息里（class 带 flow-<tabId>），而不是别的流程。
      const tabId = await js<string | null>(wc, `(() => {
        const ws = RED.nodes.workspace(RED.workspaces.active());
        return ws ? String(ws.id) : null;
      })()`);
      const hit = messages.messages.find((x) => x.payloadText !== null && x.payloadText.includes(rt.probe)) ?? null;
      const inCurrentFlow = hit !== null && tabId !== null && (hit.flowClass === null || hit.flowClass === tabId.replace(/\./g, "_"));
      // 反向：消息里的 payload 文本必须**带引号**（字符串渲染 `"w2-probe-…"`）。
      // 这同时证明它不是被当成对象/时间戳渲染的 —— 即 payloadType 真的落成了 str。
      const quoted = hit !== null && hit.payloadText !== null && hit.payloadText.includes(`"${rt.probe}"`);
      const ok = appeared && hit !== null && inCurrentFlow && quoted;
      return {
        ok,
        observed: {
          probe: rt.probe, appeared, tabId, hit, inCurrentFlow, quoted,
          total: messages.total, visible: messages.visible, messages: messages.messages,
        },
        ...(ok ? {} : {
          detail: `debug 侧栏里没有出现带引号的 "${rt.probe}"（appeared=${appeared}, inCurrentFlow=${inCurrentFlow}, quoted=${quoted}, 消息=${JSON.stringify(messages.messages)}）`,
        }),
      };
    }, "debug-shows-payload", { assert: true }),

    step.screenshot("w2-debug-shows-payload"),

    /* ── 4. 磁盘旁证：flows.json 里 inject 的 payload 仍是那个 str（部署没被改） ── */
    step.run(async ({ runtime, projectDir }) => {
      const rt = runtime as W2Runtime;
      const bytes = rt.harness.nativeFlowsBytes();
      const parsed = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
      const inject = Array.isArray(parsed) ? parsed.find((n) => n["type"] === "inject") : undefined;
      const props = inject && Array.isArray(inject["props"]) ? inject["props"] as Array<Record<string, unknown>> : [];
      const payload = props.find((p) => p["p"] === "payload");
      const ok = payload !== undefined && payload["v"] === rt.probe && payload["vt"] === "str";
      if (ok) writeFileSync(join(projectDir, "w2-result.json"), JSON.stringify({ probe: rt.probe, sha: bytes === null ? null : sha256(bytes) }, null, 2));
      return {
        ok,
        observed: { probe: rt.probe, payload: payload ?? null, sha: bytes === null ? null : sha256(bytes) },
      };
    }, "payload-on-disk-unchanged", { assert: true }),
  ],
});

export default nodeRedRunAndSeeResultJourney;
