import type { WebContents } from "electron";
import { defineU1Journey, step } from "../electron-u1/driver/index.js";
import { assembleHarness, type T8Harness } from "../t8-node-red-u1/harness.js";
import {
  clickDeploy,
  confirmDeployWarningIfPresent,
  dismissFirstRunOverlays,
  importFlowNodes,
  js,
  switchToTab,
  waitEditorReady,
  waitFor,
} from "../t8-node-red-u1/editor-flow.js";

interface SessionDeployRuntime {
  harness: T8Harness;
  enginePort: number;
  nodeId: string | null;
}

/**
 * Real Electron check for W18: an empty mcode-conversation session must be
 * visible as an invalid node before the editor submits POST /flows.
 * Node-RED permits an explicit "Deploy anyway" override; this test proves the
 * warning precedes the network write and records that override as a separate
 * user confirmation, not as a hard validation lock.
 */
export const mcodeConversationRequiredDeployJourney = defineU1Journey({
  name: "mcode-conversation-required-deploy",
  launch: {
    window: false,
    size: { width: 1920, height: 1040 },
    defaultTimeoutMs: 60_000,
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      const repoRoot = process.env.MCODE_U1_REPO;
      if (!repoRoot) throw new Error("W18 U1: MCODE_U1_REPO 未设置");
      if (ctx.win === null) throw new Error("W18 U1: 探针窗口缺失");
      const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir, repoRoot });
      const started = await harness.startEngine();
      if (!started.ok || started.port === null) {
        throw new Error("W18 U1: Node-RED 引擎未启动：" + (started.reason ?? "未知原因"));
      }
      const opened = await harness.openEngineEditor();
      if (!opened.ok) throw new Error("W18 U1: 编辑器视图未打开：" + (opened.reason ?? "未知原因"));
      const wc = harness.editorWebContents();
      if (wc === null) throw new Error("W18 U1: 编辑器视图没有 webContents");
      wc.focus();
      const runtime: SessionDeployRuntime = { harness, enginePort: started.port, nodeId: null };
      return { pageFromView: wc, runtime, dispose: () => harness.dispose() };
    },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as SessionDeployRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const ready = await waitEditorReady(wc, 60_000);
      if (!ready) return { ok: false, detail: "Node-RED 编辑器骨架未就绪" };
      const overlays = await dismissFirstRunOverlays(wc);
      const state = await js<{
        typeRegistered: boolean;
        sessionRequired: boolean;
        paletteEntryRegistered: boolean;
        workspaceLocked: boolean;
      }>(wc, [
        "(() => {",
        "  const def = RED.nodes.getType('mcode-conversation');",
        "  const ws = RED.nodes.workspace(RED.workspaces.active());",
        "  return {",
        "    typeRegistered: !!def,",
        "    sessionRequired: !!(def && def.defaults && def.defaults.sessionId && def.defaults.sessionId.required === true),",
        "    paletteEntryRegistered: !!document.querySelector('#red-ui-palette-container .red-ui-palette-node[data-palette-type=\"mcode-conversation\"]'),",
        "    workspaceLocked: !!(ws && ws.locked),",
        "  };",
        "})()",
      ].join("\n"));
      const ok = ready && overlays.closed && state.typeRegistered && state.sessionRequired &&
        state.paletteEntryRegistered && !state.workspaceLocked;
      return {
        ok,
        observed: { ready, overlays, ...state, enginePort: rt.enginePort },
        ...(ok ? {} : { detail: "mcode-conversation 类型、sessionId 必填声明、palette 注册或可编辑 workspace 未满足预期" }),
      };
    }, "conversation-type-and-required-field", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as SessionDeployRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null) return { ok: false, detail: "编辑器视图不存在" };
      const defaults = await js<Record<string, unknown> | null>(wc, [
        "(() => {",
        "  const def = RED.nodes.getType('mcode-conversation');",
        "  if (!def) return null;",
        "  return Object.fromEntries(Object.entries(def.defaults || {}).map(([key, spec]) => [key, spec && typeof spec === 'object' ? spec.value : undefined]));",
        "})()",
      ].join("\n"));
      if (defaults === null) return { ok: false, detail: "无法从真实注册的 mcode-conversation 类型读取默认字段" };
      const tabId = "tab_w18_session_required_u1";
      const nativeNodes = [
        { id: tabId, type: "tab", label: "W18 Session Required U1", disabled: false, info: "" },
        {
          ...defaults,
          id: "node_w18_conversation_missing_session",
          type: "mcode-conversation",
          z: tabId,
          name: "",
          sessionId: "",
          wires: [],
        },
      ];
      const imported = await importFlowNodes(wc, nativeNodes);
      const switched = await waitFor(async () => await switchToTab(wc, "W18 Session Required U1"), 10_000);
      const rendered = await waitFor(
        async () => await js<boolean>(wc, "document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group').length >= 1"),
        10_000,
      );
      const after = await js<number>(wc, "RED.nodes.createCompleteNodeSet().filter((n) => n.type === 'mcode-conversation').length");
      const node = await js<{ id: string; type: string; sessionId: string; required: boolean } | null>(wc, [
        "(() => {",
        "  const n = RED.nodes.createCompleteNodeSet().find((item) => item.type === 'mcode-conversation');",
        "  const def = RED.nodes.getType('mcode-conversation');",
        "  return n ? { id: String(n.id), type: String(n.type), sessionId: String(n.sessionId ?? ''), required: !!def.defaults.sessionId.required } : null;",
        "})()",
      ].join("\n"));
      if (node) rt.nodeId = node.id;
      const ok = imported.ok && imported.dialogOpened && imported.pastedChars > 0 && imported.importEnabled &&
        switched && rendered && after === 1 && node !== null && node.sessionId === "" && node.required;
      return {
        ok,
        observed: {
          imported, switched, rendered, after, node,
          inputMethod: "真实 Node-RED Import 对话框：粘贴原生 flow JSON 并点击导入",
        },
        ...(ok ? {} : { detail: imported.detail ?? "未能通过真实导入对话框创建 sessionId 为空的 mcode-conversation 节点" }),
      };
    }, "import-conversation-with-empty-session", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as SessionDeployRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null || rt.nodeId === null) return { ok: false, detail: "编辑器视图或待测节点不存在" };
      const probeInstalled = await js<boolean>(wc, [
        "(() => {",
        "  if (window.__mcodeSessionDeployProbe && window.__mcodeSessionDeployProbe.installed) return true;",
        "  const probe = { installed: true, posts: 0, lastUrl: null, lastBody: null };",
        "  const originalOpen = XMLHttpRequest.prototype.open;",
        "  const originalSend = XMLHttpRequest.prototype.send;",
        "  XMLHttpRequest.prototype.open = function(method, url) {",
        "    this.__mcodeMethod = String(method).toUpperCase();",
        "    this.__mcodeUrl = String(url);",
        "    return originalOpen.apply(this, arguments);",
        "  };",
        "  XMLHttpRequest.prototype.send = function(body) {",
        "    if (this.__mcodeMethod === 'POST' && /(?:^|\\/)flows(?:\\?.*)?$/.test(this.__mcodeUrl || '')) {",
        "      probe.posts += 1;",
        "      probe.lastUrl = this.__mcodeUrl;",
        "      probe.lastBody = typeof body === 'string' ? body : String(body ?? '');",
        "    }",
        "    return originalSend.apply(this, arguments);",
        "  };",
        "  window.__mcodeSessionDeployProbe = probe;",
        "  return true;",
        "})()",
      ].join("\n"));
      const clicked = await clickDeploy(wc);
      const modalReady = await waitFor(
        async () => await js<boolean>(wc, "!!document.getElementById('red-ui-deploy-dialog-confirm-deploy-deploy')"),
        10_000,
      );
      const beforeValidation = await js<{
        confirmVisible: boolean;
        modalVisible: boolean;
        modalText: string;
        nodeValid: boolean | null;
        posts: number;
      }>(wc, [
        "(() => {",
        "  const button = document.getElementById('red-ui-deploy-dialog-confirm-deploy-deploy');",
        "  const modal = button && button.closest('.red-ui-notification');",
        "  const node = RED.nodes.node(" + JSON.stringify(rt.nodeId) + ");",
        "  return {",
        "    confirmVisible: !!button && !!button.getClientRects().length,",
        "    modalVisible: !!modal && !!modal.getClientRects().length,",
        "    modalText: modal ? String(modal.innerText || '') : '',",
        "    nodeValid: node && typeof node.valid === 'boolean' ? node.valid : null,",
        "    posts: window.__mcodeSessionDeployProbe ? window.__mcodeSessionDeployProbe.posts : -1,",
        "  };",
        "})()",
      ].join("\n"));
      const validation = await js<boolean>(wc, "RED.editor.validateNode(RED.nodes.node(" + JSON.stringify(rt.nodeId) + "))");
      const validationState = await js<{ valid: boolean; errors: string[] }>(wc, [
        "(() => {",
        "  const node = RED.nodes.node(" + JSON.stringify(rt.nodeId) + ");",
        "  return { valid: !!node.valid, errors: Array.isArray(node.validationErrors) ? node.validationErrors.map(String) : [] };",
        "})()",
      ].join("\n"));
      const ok = probeInstalled && clicked.clicked && !clicked.disabledBefore && modalReady &&
        beforeValidation.confirmVisible && beforeValidation.modalVisible &&
        beforeValidation.modalText.toLowerCase().includes("mcode-conversation") &&
        beforeValidation.posts === 0 && validation === false &&
        !validationState.valid && validationState.errors.includes("sessionId");
      return {
        ok,
        observed: {
          probeInstalled, clicked, modalReady, ...beforeValidation,
          validationResult: validation, validationState,
          expectedNetworkEffect: "POST /flows remains 0 until explicit confirmation",
        },
        ...(ok ? {} : { detail: "缺失 sessionId 时未在 POST /flows 前显示可确认的无效节点告警，或 required 校验没有将 sessionId 判为无效" }),
      };
    }, "missing-session-warns-before-deploy-post", { assert: true }),

    step.screenshot("missing-session-deploy-warning"),

    step.run(async ({ runtime }) => {
      const rt = runtime as SessionDeployRuntime;
      const wc = rt.harness.editorWebContents();
      if (wc === null || rt.nodeId === null) return { ok: false, detail: "编辑器视图或待测节点不存在" };
      const confirmed = await confirmDeployWarningIfPresent(wc);
      const posted = await waitFor(
        async () => await js<number>(wc, "window.__mcodeSessionDeployProbe ? window.__mcodeSessionDeployProbe.posts : 0") >= 1,
        10_000,
      );
      const saved = await waitFor(async () => {
        const flows = rt.harness.nativeFlows() as Array<{ id?: string; type?: string; sessionId?: string }> | null;
        return !!flows?.some((node) => node.id === rt.nodeId && node.type === "mcode-conversation" && node.sessionId === "");
      }, 10_000);
      const probe = await js<{ posts: number; lastUrl: string | null; lastBody: string | null }>(wc, [
        "(() => {",
        "  const p = window.__mcodeSessionDeployProbe;",
        "  return p ? { posts: p.posts, lastUrl: p.lastUrl, lastBody: p.lastBody } : { posts: 0, lastUrl: null, lastBody: null };",
        "})()",
      ].join("\n"));
      const ok = confirmed && posted && saved && probe.posts === 1 && typeof probe.lastBody === "string";
      return {
        ok,
        observed: {
          confirmed,
          posted,
          saved,
          probe,
          persistedNode: (rt.harness.nativeFlows() as Array<{ id?: string; type?: string; sessionId?: string }> | null)
            ?.find((node) => node.id === rt.nodeId) ?? null,
          note: "Node-RED 标准 UI 允许用户显式选择 Deploy anyway；本步只在该明确确认后验证请求与落盘。",
        },
        ...(ok ? {} : { detail: "确认告警后没有观察到唯一的 POST /flows 或隔离 flows.json 中缺少空 sessionId 节点" }),
      };
    }, "explicit-confirm-is-required-for-invalid-deploy", { assert: true }),
  ],
});
