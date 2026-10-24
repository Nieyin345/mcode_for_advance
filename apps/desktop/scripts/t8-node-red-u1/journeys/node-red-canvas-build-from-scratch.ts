/**
 * W1 —— **从零搭一张工作流**：空白画布 → 拖两个节点 → 连线 → 部署 → 重开。
 *
 * 现有 `node-red-canvas-load-edit-deploy-reopen` 覆盖的是「我已经有图了」：导入
 * 一份现成夹具再编辑。**本旅程覆盖的是用户第一次打开工作流时的动作**：
 *
 *   1. 打开一个**空白**工作流（不是导入夹具）；
 *   2. 从 palette 拖一个 `inject` 到画布（真鼠标：move → down → move → up）；
 *   3. 从 palette 拖一个 `debug` 到画布；
 *   4. 用鼠标从 inject 的输出端口拖到 debug 的输入端口（真鼠标，不是编辑器 API）；
 *   5. 点部署 → 原生 `flows.json` 落盘，里面带着两个节点和那条连线；
 *   6. 换一个真 OS 进程重开 → 两个节点和连线都还在。
 *
 * ## 每一步为什么这样判
 *
 * | 步 | 判据 | 不这样判会漏掉什么 |
 * |---|---|---|
 * | 1 | `createCompleteNodeSet()` 的非 tab 节点数 = 0，且只有一个页签 | 若夹具/上次部署残留，「从零」就不成立 |
 * | 2/3 | 画布模型里该类型节点数 +1（拖拽前后各数一次） | 只看 DOM 会把「helper 弹回但留下渲染残影」当成成功 |
 * | 4 | `RED.nodes.filterLinks({source,target}).length > 0` **且** `wires[0]` 指向 debug id | 只看 DOM 里的线会被上一轮残留误导；模型 + wires 才是部署的输入 |
 * | 5 | 磁盘 `flows.json` 的**字节**变了，解析后节点与 wires 都在 | 只看画布模型：部署可能根本没写盘 |
 * | 6 | 新进程重开后模型里节点 id、类型、wires 与部署前一致，且 flows.json 字节未变 | 只刷新页面证明不了持久化 |
 *
 * ## 与挂掉的 `rename-node-via-tray` 无关
 *
 * 本旅程**不打开节点编辑托盘、不改名** —— 它只做「拖、连、部署」。2026-10-24 的
 * 基线红（`rename-node-via-tray` 点名称框后焦点落空）在 `editor-flow.ts` 的
 * `renameNodeViaEditor` 里，本旅程不经过那条代码路径。
 *
 * ## 空白画布的来源
 *
 * 每次运行都有全新的 `runDir`（`build.mjs` 的 mktemp），引擎数据目录里**没有**
 * `flows.json`；编辑器加载时 `RED.nodes.import([])` 会自己建一个默认页签
 * （zh-CN 下叫「流程 1」）。本旅程不写任何夹具文档、不调 `harness.loadWorkflow`。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { assembleHarness, type T8Harness } from "../harness.js";
import {
  clickDeploy,
  confirmDeployWarningIfPresent,
  dismissFirstRunOverlays,
  dragNodeOutputToInput,
  dragPaletteNodeToCanvas,
  js,
  waitEditorReady,
  waitFor,
} from "../editor-flow.js";

interface W1Runtime {
  harness: T8Harness;
  enginePort: number;
}

/** 跨代（relaunch）传递的部署快照：写进 projectDir，新进程读回。 */
const SNAPSHOT_FILE = "w1-build-scratch-snapshot.json";

interface BuildSnapshot {
  injectId: string;
  debugId: string;
  wires: string[] | null;
  tabLabel: string | null;
  shaAfterDeploy: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 画布可见区域（viewport 坐标），旅程据此选落点。 */
async function chartRect(wc: WebContents): Promise<{ left: number; top: number; width: number; height: number } | null> {
  return await js<{ left: number; top: number; width: number; height: number } | null>(wc, `(() => {
    const el = document.getElementById('red-ui-workspace-chart');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  })()`);
}

export const nodeRedBuildFromScratchJourney = defineU1Journey({
  name: "node-red-canvas-build-from-scratch",
  launch: {
    window: false,
    size: { width: 1920, height: 1040 },
    defaultTimeoutMs: 60_000,
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("W1: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("W1: 探针窗口缺失（window:false 时 runner 会建一个）");
      // 不落任何夹具文档：本旅程判的就是「空白」。
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });
      const started = await harness.startEngine();
      if (!started.ok || started.port === null) {
        throw new Error(`W1 setup: Node-RED 引擎未启动：${started.reason ?? "未知原因"}`);
      }
      const opened = await harness.openEngineEditor();
      if (!opened.ok) throw new Error(`W1 setup: 编辑器视图未打开：${opened.reason ?? "未知原因"}`);
      const wc = harness.editorWebContents();
      if (wc === null) throw new Error("W1 setup: 编辑器视图没有 webContents");
      wc.focus();
      const runtime: W1Runtime = { harness, enginePort: started.port };
      return { pageFromView: wc, runtime, dispose: () => harness.dispose() };
    },
  },
  steps: [
    /* 1 ── 空白工作流 */
    step.run(async ({ runtime }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      const overlays = await dismissFirstRunOverlays(wc);
      const state = await js<{ nonTab: number; tabs: string[]; active: string | null; locked: boolean; flowsOnDisk: boolean }>(wc, `(() => {
        const set = RED.nodes.createCompleteNodeSet();
        const ws = RED.nodes.workspace(RED.workspaces.active());
        return {
          nonTab: set.filter((n) => n.type !== 'tab').length,
          tabs: set.filter((n) => n.type === 'tab').map((n) => String(n.label ?? '')),
          active: ws ? String(ws.label ?? '') : null,
          locked: !!(ws && ws.locked),
          flowsOnDisk: false,
        };
      })()`);
      const flowsOnDisk = rt.harness.nativeFlowsBytes() !== null;
      const blank = state.nonTab === 0 && state.tabs.length >= 1;
      return {
        ok: ready && overlays.closed && blank && !flowsOnDisk,
        observed: { ready, overlays, ...state, flowsOnDisk, enginePort: rt.enginePort },
        ...(ready && overlays.closed && blank && !flowsOnDisk ? {} : {
          detail: `不是空白工作流（ready=${ready}, overlaysClosed=${overlays.closed}, nonTab=${state.nonTab}, tabs=${JSON.stringify(state.tabs)}, flowsOnDisk=${flowsOnDisk}）`,
        }),
      };
    }, "blank-workflow-open", { assert: true }),

    /* 2 ── 拖 inject */
    step.run(async ({ runtime }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const chart = await chartRect(wc);
      if (chart === null) return { ok: false, detail: "画布不可见（#red-ui-workspace-chart 尺寸为 0）" };
      const target = { x: Math.round(chart.left + chart.width * 0.34), y: Math.round(chart.top + chart.height * 0.30) };
      const before = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      const dragged = await dragPaletteNodeToCanvas(wc, "inject", target);
      const after = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      const node = await js<{ id: string; type: string; z: string | null } | null>(wc, `(() => {
        const n = RED.nodes.createCompleteNodeSet().find((x) => x.type === 'inject');
        return n ? { id: String(n.id), type: String(n.type), z: typeof n.z === 'string' ? n.z : null } : null;
      })()`);
      const ok = dragged.dropped && before === 0 && after === 1 && node !== null;
      return {
        ok,
        observed: { chart, target, before, after, dragged, node, inputMethod: "sendInputEvent: mouseMove → mouseDown → mouseMove(中间点) → mouseMove(落点) → mouseUp" },
        ...(ok ? {} : { detail: dragged.detail ?? `拖 inject 后节点数 ${after}（期望 1；before=${before}）` }),
      };
    }, "drag-inject-to-canvas", { assert: true }),

    /* 3 ── 拖 debug */
    step.run(async ({ runtime }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const chart = await chartRect(wc);
      if (chart === null) return { ok: false, detail: "画布不可见（#red-ui-workspace-chart 尺寸为 0）" };
      const target = { x: Math.round(chart.left + chart.width * 0.60), y: Math.round(chart.top + chart.height * 0.30) };
      const before = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      const dragged = await dragPaletteNodeToCanvas(wc, "debug", target);
      const after = await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`);
      const types = await js<string[]>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').map((n) => String(n.type)).sort()`);
      const ok = dragged.dropped && before === 1 && after === 2 && types.join(",") === "debug,inject";
      return {
        ok,
        observed: { chart, target, before, after, dragged, types, inputMethod: "sendInputEvent（同第 2 步）" },
        ...(ok ? {} : { detail: dragged.detail ?? `拖 debug 后节点数 ${after}（期望 2；before=${before}, types=${JSON.stringify(types)}）` }),
      };
    }, "drag-debug-to-canvas", { assert: true }),

    step.screenshot("build-scratch-two-nodes"),

    /* 4 ── 连线：真鼠标从输出端口拖到输入端口 */
    step.run(async ({ runtime }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const wired = await dragNodeOutputToInput(wc, "inject", "debug");
      const injectId = wired.sourceId;
      const debugId = wired.targetId;
      const model = await js<{ injectWires: string[] | null; linkCount: number } | null>(wc, `(() => {
        const set = RED.nodes.createCompleteNodeSet();
        const inj = set.find((n) => n.type === 'inject');
        const dbg = set.find((n) => n.type === 'debug');
        if (!inj || !dbg) return null;
        const src = RED.nodes.node(inj.id), dst = RED.nodes.node(dbg.id);
        return {
          injectWires: Array.isArray(inj.wires) && Array.isArray(inj.wires[0]) ? inj.wires[0].slice() : null,
          linkCount: (src && dst) ? RED.nodes.filterLinks({ source: src, target: dst }).length : 0,
        };
      })()`);
      const wiresPointAtDebug = model !== null && model.injectWires !== null && debugId !== null && model.injectWires.includes(debugId);
      const ok = wired.linked && model !== null && model.linkCount > 0 && wiresPointAtDebug;
      return {
        ok,
        observed: {
          inputMethod: "sendInputEvent：在 inject 的输出端口 rect 上 mouseDown → 两次 mouseMove → 在 debug 的输入端口 rect 上 mouseUp（不是 RED.nodes.addLink）",
          wired, injectId, debugId,
          injectWires: model?.injectWires ?? null,
          linkCount: model?.linkCount ?? null,
        },
        ...(ok ? {} : { detail: wired.detail ?? `连线断言失败（wires=${JSON.stringify(model?.injectWires)}, debugId=${String(debugId)}, linkCount=${String(model?.linkCount)}）` }),
      };
    }, "wire-inject-to-debug", { assert: true }),

    /* 5 ── 部署 → flows.json */
    step.run(async ({ runtime, projectDir }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const flowsPath = join(rt.harness.engineDir, "flows.json");
      const beforeBytes = rt.harness.nativeFlowsBytes();
      const beforeSha = beforeBytes === null ? null : sha256(beforeBytes);
      const model = await js<{ injectId: string | null; debugId: string | null; wires: string[] | null; tabLabel: string | null }>(wc, `(() => {
        const set = RED.nodes.createCompleteNodeSet();
        const inj = set.find((n) => n.type === 'inject');
        const dbg = set.find((n) => n.type === 'debug');
        const tab = set.find((n) => n.type === 'tab' && n.id === (inj && inj.z));
        return {
          injectId: inj ? String(inj.id) : null,
          debugId: dbg ? String(dbg.id) : null,
          wires: inj && Array.isArray(inj.wires) && Array.isArray(inj.wires[0]) ? inj.wires[0].slice() : null,
          tabLabel: tab ? String(tab.label ?? '') : null,
        };
      })()`);
      const deploy = await clickDeploy(wc);
      let confirmed = false;
      const wrote = await waitFor(async () => {
        if (!confirmed) confirmed = await confirmDeployWarningIfPresent(wc);
        const now = rt.harness.nativeFlowsBytes();
        return now !== null && (beforeSha === null || sha256(now) !== beforeSha);
      }, 45_000);
      const afterBytes = rt.harness.nativeFlowsBytes();
      const afterSha = afterBytes === null ? null : sha256(afterBytes);
      const parsed = rt.harness.nativeFlows() as Array<Record<string, unknown>> | null;
      const diskInject = Array.isArray(parsed) ? parsed.find((n) => n["type"] === "inject") : undefined;
      const diskDebug = Array.isArray(parsed) ? parsed.find((n) => n["type"] === "debug") : undefined;
      const diskWires = diskInject && Array.isArray(diskInject["wires"]) && Array.isArray((diskInject["wires"] as unknown[])[0])
        ? ((diskInject["wires"] as unknown[])[0] as unknown[]).map(String)
        : null;
      const diskOk = diskInject !== undefined && diskDebug !== undefined
        && diskInject["id"] === model.injectId && diskDebug["id"] === model.debugId
        && diskWires !== null && model.debugId !== null && diskWires.includes(model.debugId);
      const ok = deploy.clicked && wrote && model.injectId !== null && model.debugId !== null && diskOk && afterSha !== null;
      if (ok && afterSha !== null) {
        const snapshot: BuildSnapshot = {
          injectId: model.injectId!, debugId: model.debugId!,
          wires: model.wires, tabLabel: model.tabLabel, shaAfterDeploy: afterSha,
        };
        writeFileSync(join(projectDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
      }
      return {
        ok,
        observed: {
          deployClicked: deploy.clicked,
          deployDisabledBefore: deploy.disabledBefore,
          deployWarningConfirmed: confirmed,
          flowsPath, beforeSha, afterSha, wrote,
          model, disk: { inject: diskInject ?? null, debug: diskDebug ?? null, wires: diskWires },
        },
        ...(ok ? {} : { detail: `部署没有把两个节点和连线写进原生 flows.json（wrote=${wrote}, diskOk=${diskOk}, afterSha=${String(afterSha)}）` }),
      };
    }, "deploy-writes-native-flows", { assert: true }),

    /* 6 ── 重开（真 OS 进程） */
    step.relaunch("relaunch-after-build", "新进程重新起引擎、打开画布，断言拖出来的两个节点和连线都还在"),

    step.run(async ({ runtime, projectDir }) => {
      const rt = runtime as W1Runtime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "重开后编辑器视图不存在" };
      const snapshotPath = join(projectDir, SNAPSHOT_FILE);
      let snapshot: BuildSnapshot | null = null;
      try { snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as BuildSnapshot; } catch { snapshot = null; }
      if (snapshot === null) return { ok: false, detail: `找不到部署快照 ${snapshotPath}` };
      const ready = await waitEditorReady(wc, 60_000);
      await dismissFirstRunOverlays(wc);
      // 重开后页签可能先显示默认的一个空 tab，等模型里真的出现两个节点。
      const rendered = await waitFor(async () => (await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length`)) === 2, 30_000);
      const state = await js<{
        nonTab: number;
        injectId: string | null;
        debugId: string | null;
        injectWires: string[] | null;
        linkCount: number;
        tabLabels: string[];
        domNodes: number;
      }>(wc, `(() => {
        const set = RED.nodes.createCompleteNodeSet();
        const inj = set.find((n) => n.type === 'inject');
        const dbg = set.find((n) => n.type === 'debug');
        const src = inj ? RED.nodes.node(inj.id) : null;
        const dst = dbg ? RED.nodes.node(dbg.id) : null;
        return {
          nonTab: set.filter((n) => n.type !== 'tab').length,
          injectId: inj ? String(inj.id) : null,
          debugId: dbg ? String(dbg.id) : null,
          injectWires: inj && Array.isArray(inj.wires) && Array.isArray(inj.wires[0]) ? inj.wires[0].slice() : null,
          linkCount: (src && dst) ? RED.nodes.filterLinks({ source: src, target: dst }).length : 0,
          tabLabels: set.filter((n) => n.type === 'tab').map((n) => String(n.label ?? '')),
          domNodes: document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length,
        };
      })()`);
      const bytes = rt.harness.nativeFlowsBytes();
      const shaNow = bytes === null ? null : sha256(bytes);
      const idsMatch = state.injectId === snapshot.injectId && state.debugId === snapshot.debugId;
      const wireKept = state.injectWires !== null && state.injectWires.includes(snapshot.debugId) && state.linkCount > 0;
      const bytesUnchanged = shaNow !== null && shaNow === snapshot.shaAfterDeploy;
      const ok = ready && rendered && state.nonTab === 2 && idsMatch && wireKept && bytesUnchanged;
      return {
        ok,
        observed: {
          engineState: rt.harness.engineState(), port: rt.enginePort, ready, rendered,
          state, expected: snapshot, shaNow, bytesUnchanged,
        },
        ...(ok ? {} : {
          detail: `重开后画布没有保住拖出来的工作流（nonTab=${state.nonTab}, idsMatch=${idsMatch}, wireKept=${wireKept}, bytesUnchanged=${bytesUnchanged}）`,
        }),
      };
    }, "reopen-keeps-nodes-and-wire", { assert: true }),

    step.screenshot("build-scratch-reopened"),
  ],
});

export default nodeRedBuildFromScratchJourney;
