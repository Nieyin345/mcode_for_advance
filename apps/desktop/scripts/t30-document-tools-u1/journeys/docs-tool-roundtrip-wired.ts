/**
 * T30 旅程 1 —— Docs：**显式补上 T40 缺失的那一段**后，走完整往返。
 *
 * ## 与 production 那条的分工（写死）
 *
 * - `docs-tool-roundtrip-production` 装配**与产品一字不差**（未包装 ports），
 *   断言 renderer-only 工具被拒绝 —— 那是 T40 缺陷的证据。
 * - 本旅程把 **T40 的最小修复**（`withRendererToolRegistry(docsAiPorts)`）显式
 *   装上，证明「这段链路本身是通的」：页面 AI 面板 → T98 请求级 ACK →
 *   渲染端 `AgentSkill.executeTool` → 真 DOM 变化 → 结果回到同一请求。
 *
 * 换句话说：本旅程绿 + production 红，就精确定位了 T40 的唯一缺口。
 * **它不宣称 T40 已修**：产品代码没改，装的是探针。
 *
 * ## 真实边界（如实）
 *
 * 唯一被换掉的是**模型本身**：`DocsAiPorts.run` 由 fake 端口实现（它不联网、
 * 不调 SDK，只把 T98 交给它的 `invokeRendererTool` 记下来并按旅程要求驱动）。
 * 除此之外全部是生产代码：
 *   - 页面：vendor Docs 真构建产物 + 生产 `documentViewPreload.js`；
 *   - 请求：**页面自己的 AI 面板**（composer 输入 + Enter）→ AgentLoop →
 *     `window.desktop.aiStream` → 生产 `mcode:docs:ai-stream` handler；
 *   - 工具表：AgentLoop 传给 transport 的 `skill.tools`（**页面原件**，
 *     不是探针自造的 schema —— T98 的 canonical JSON 比对会拒绝自造件）；
 *   - 请求/ACK 校验、`createNativeEditorToolBridge`、渲染端 `executeTool`：全是生产。
 *
 * ## 编排（gate 的必要性）
 *
 * `document.tool_call` 的 renderer 路线要求「此刻有一个**活跃**的文档 AI 请求」
 * （登记簿按 filePath 查到绑定）。所以顺序是：
 *   页面在 composer 里发一句话 → fake 端口进入 `run` 并等 gate（请求保持活跃）
 *   → 等登记簿看到绑定 → 调 `document.tool_call`（它会同步等渲染端 ACK）
 *   → 放行 gate → 本回合收尾。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../fixtures.js";

interface WiredRun {
  harness: import("../../t7-genoffice-u1/harness.js").GenofficeHarness;
  fixtures: { docs: string; sheets: string };
  docId: string;
  repoRoot: string;
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>;
  fake: import("./lib.js").FakeDocsPorts;
  /** 页面发起请求后的心跳（fake 进入 run 时置位）。 */
  requestObserved: boolean;
  beforeText: string;
  afterText: string;
}

const DOC_ID = "t30-docs-wired";

async function wiredSetup(ctx: import("../../electron-u1/driver/index.js").U1SetupContext) {
  const repoRoot = process.env.MCODE_U1_REPO ?? "";
  if (!repoRoot) throw new Error("T30: MCODE_U1_REPO 未设置");
  if (ctx.win === null) throw new Error("T30: Docs 视图需要宿主窗口");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assembleHarness } = require("../../t7-genoffice-u1/harness.js") as typeof import("../../t7-genoffice-u1/harness.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureFixtures } = require("../fixtures.js") as typeof import("../fixtures.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installDocumentSurface, createFakeDocsPorts } = require("./lib.js") as typeof import("./lib.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withRendererToolRegistry } = require("@main/document/documentToolRendererBinding.js") as typeof import("@main/document/documentToolRendererBinding.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { editorUrl, waitForPageReady, waitFor } = require("../../t7-genoffice-u1/editor-flow.js") as typeof import("../../t7-genoffice-u1/editor-flow.js");

  const fixtures = ensureFixtures(ctx.projectDir, repoRoot);
  const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir });
  const fake = createFakeDocsPorts();
  // 【T40 的最小修复】显式包装 —— 产品里 `ipc/index.ts:227` 少了这一步。
  //
  // T98 的 `mcode:docs:ai-*` 通道**已经**由 `DocumentViewHost` 构造时调 vendor
  // `registerDocsIpc` 注册（`mcodeNativeDocsIpcAvailable === true`，且 T7 的
  // vendor-esbuild 把 `docsVendorIpc.js` 别名到了真 vendor `mcode-ipc.ts`）。
  // 它的 `ai` 回调每次都读 `this.docsAi`，所以**后设**的 ports 依然生效 ——
  // 这里不需要、也不该再注册一遍（重复 `ipcMain.handle` 会抛）。
  harness.host.setDocsAiPorts(withRendererToolRegistry(fake.ports));
  const handlers = installDocumentSurface(repoRoot);

  const opened = harness.host.open({
    docId: DOC_ID,
    url: editorUrl("docs"),
    bounds: { x: 0, y: 0, width: 1280, height: 900 },
    visible: true,
    mcodeSessionId: "t30-u1-session",
  });
  if (!opened.ok) { harness.dispose(); throw new Error(`T30: docs 视图打开失败：${opened.reason}`); }
  const wc = harness.webContentsOf(DOC_ID);
  if (wc === null) { harness.dispose(); throw new Error("T30: docs 视图没有 webContents"); }
  await waitForPageReady(wc);
  const mounted = await waitFor(
    () => wc.executeJavaScript("!!document.querySelector('.ProseMirror')").then((v: unknown) => v === true),
    30_000,
    200,
  );
  if (!mounted) throw new Error("T30: docs 起始屏 30s 内没有挂载 .ProseMirror");

  const openReply = (await harness.handlers.get("documentView:openPath")!({ sender: wc }, { docId: DOC_ID, filePath: fixtures.docs })) as { ok?: boolean; reason?: string };
  if (openReply.ok !== true) throw new Error(`T30: openPath 被拒：${openReply.reason}`);
  const session = await waitFor(async () => harness.host.sessionFor(DOC_ID), 30_000, 200);
  if (!session) throw new Error("T30: 30s 内没有提交打开会话");

  const runtime: WiredRun = {
    harness,
    fixtures,
    docId: DOC_ID,
    repoRoot,
    handlers,
    fake,
    requestObserved: false,
    beforeText: "",
    afterText: "",
  };
  return { pageFromView: wc, dispose() { harness.dispose(); }, runtime };
}

export const docsWiredJourney = defineU1Journey({
  name: "docs-tool-roundtrip-wired",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: wiredSetup as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.screenshot("wired-docs-opened", "wired-docs-opened"),
    step.assertDom(".ProseMirror", { textContains: UNIQUE.docs }, "wired-fixture-text-visible"),

    // ── 1. 页面桥完整（AI 通道 + tool-result ACK 都在）──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "视图没有 webContents" };
      const probe = await wc.executeJavaScript(`(() => ({
        hasDesktop: typeof window.desktop === 'object' && window.desktop !== null,
        hasAiStream: typeof window.desktop?.aiStream === 'function',
        hasToolResultAck: typeof window.desktop?.aiToolResult === 'function',
        hasOnAiStream: typeof window.desktop?.onAiStream === 'function',
        hasPanel: !!document.querySelector('.ai-input-box textarea'),
      }))()`, true) as Record<string, unknown>;
      const ready = probe.hasDesktop === true && probe.hasAiStream === true
        && probe.hasToolResultAck === true && probe.hasOnAiStream === true;
      // 面板不在 DOM 里时显式重启一次（localStorage 里可能存着上次的 '0'）。
      if (!probe.hasPanel) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const helpers = require("../../t7-genoffice-u1/editor-flow.js") as typeof import("../../t7-genoffice-u1/editor-flow.js");
        await wc.executeJavaScript(`localStorage.removeItem('aidocs.showAi')`, true);
        await wc.reload();
        await helpers.waitForPageReady(wc);
        const remount = await helpers.waitFor(
          () => wc.executeJavaScript("!!document.querySelector('.ai-input-box textarea')").then((v: unknown) => v === true),
          30_000,
          200,
        );
        if (!remount) return { ok: false, observed: probe, detail: "AI 面板 30s 内没有挂载（composer 不在 DOM）" };
        // reload 后需要重新打开文档（视图仍是同一个 webContents）。
        const again = (await rt.harness.handlers.get("documentView:openPath")!({ sender: wc }, { docId: rt.docId, filePath: rt.fixtures.docs })) as { ok?: boolean };
        if (again.ok !== true) return { ok: false, observed: again, detail: "reload 后重新打开文档失败" };
        await helpers.waitFor(async () => rt.harness.host.sessionFor(rt.docId), 30_000, 200);
      }
      return ready
        ? { ok: true, observed: probe }
        : { ok: false, observed: probe, detail: "页面桥不完整：AI 通道或 tool-result ACK 缺失" };
    }, "page-bridge-complete", { assert: true }),

    // ── 2. 页面自己的 AI 面板发起一轮（fake SDK 进入 run 并等 gate）──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "视图没有 webContents" };
      // 2a. 在 composer 里真的输入（走 React 受控组件的 native setter + input 事件）。
      const typed = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector('.ai-input-box textarea');
        if (!ta) return { ok: false, reason: 'composer textarea 不存在' };
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, 'T30 wired probe: 请在文档开头插入一段。');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, value: ta.value };
      })()`, true) as { ok: boolean; value?: string; reason?: string };
      if (typed.ok !== true) return { ok: false, observed: typed, detail: typed.reason };
      // 2b. 真键盘 Enter（页面的 `onKeyDown` 走 `canSend` → `onSend`）。
      wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      wc.sendInputEvent({ type: "char", keyCode: "\r" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      // 2c. 等 fake 端口进入（页面 → AgentLoop → transport → ai:stream → T98 → ports.run）。
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (rt.fake.state.entered) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      rt.requestObserved = rt.fake.state.entered;
      if (!rt.requestObserved) {
        const diag = await wc.executeJavaScript(`(() => ({
          panel: !!document.querySelector('.ai-panel'),
          textarea: !!document.querySelector('.ai-input-box textarea'),
          value: document.querySelector('.ai-input-box textarea')?.value ?? null,
          sendDisabled: !!document.querySelector('.ai-send-btn')?.disabled,
          body: (document.body?.innerText ?? '').slice(0, 300),
        }))()`, true);
        return { ok: false, observed: diag, detail: "20s 内页面没有把请求发到 T98（fake 端口从未进入）" };
      }
      // 2d. 登记簿看到该文件的活跃绑定（T40 包装生效）。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const registry = require("@main/document/documentToolRendererBinding.js") as typeof import("@main/document/documentToolRendererBinding.js");
      const boundDeadline = Date.now() + 10_000;
      while (Date.now() < boundDeadline) {
        if (registry.hasActiveRendererBinding(rt.fixtures.docs)) break;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      const bound = registry.hasActiveRendererBinding(rt.fixtures.docs);
      return bound
        ? { ok: true, observed: { requestId: rt.fake.state.requestId, declared: rt.fake.state.declaredTools.length } }
        : { ok: false, observed: { entered: rt.fake.state.entered, requestId: rt.fake.state.requestId }, detail: "登记簿没有看到该文件的活跃绑定（T40 包装没生效？）" };
    }, "turn-entered-and-bound", { assert: true }),

    // ── 3. ★ document.tool_call 走 renderer 路线，让渲染端真的改文档 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "视图没有 webContents" };
      rt.beforeText = await wc.executeJavaScript("document.querySelector('.ProseMirror').innerText", true) as string;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const call = await callSurface<{ ok: boolean; route?: string; kind?: string; reason?: string; text?: string }>(
        rt.handlers, "document:toolCall",
        {
          tool: "insert_content",
          app: "docs",
          filePath: rt.fixtures.docs,
          input: { html: `<p>${UNIQUE.docs}-FROM-RENDERER</p>`, afterBlockIndex: -1 },
        },
      );
      if (call.ok !== true || call.route !== "renderer") {
        return {
          ok: false,
          observed: call,
          detail: `toolCall 没有走 renderer 路线（route=${call.route ?? "?"}，kind=${call.kind ?? "?"}，${call.reason ?? ""}）`,
        };
      }
      return { ok: true, observed: { route: call.route, text: (call.text ?? "").slice(0, 200) } };
    }, "tool-call-renderer-route", { assert: true }),

    // ── 4. 渲染端真的执行了：DOM 变了 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "视图没有 webContents" };
      const marker = `${UNIQUE.docs}-FROM-RENDERER`;
      const deadline = Date.now() + 10_000;
      let text = "";
      while (Date.now() < deadline) {
        text = await wc.executeJavaScript("document.querySelector('.ProseMirror').innerText", true) as string;
        if (text.includes(marker)) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      rt.afterText = text;
      const changed = text.includes(marker) && text !== rt.beforeText;
      return changed
        ? { ok: true, observed: { beforeChars: rt.beforeText.length, afterChars: text.length, marker } }
        : { ok: false, observed: { before: rt.beforeText.slice(0, 200), after: text.slice(0, 200) }, detail: "渲染端没有把内容写进 DOM" };
    }, "renderer-executed-dom-changed", { assert: true }),
    step.screenshot("wired-docs-after-tool", "wired-docs-after-renderer-tool"),

    // ── 5. 结果回传：本回合正常收尾，且 requestId 是页面自己发起的那一个 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      rt.fake.state.releaseGate();
      await rt.fake.state.finished;
      const { error, done, entered, requestId, declaredTools } = rt.fake.state;
      if (!entered) return { ok: false, detail: "fake SDK 从未进入 run" };
      if (error) return { ok: false, observed: rt.fake.state, detail: `本回合报错：${error}` };
      if (!done) return { ok: false, observed: rt.fake.state, detail: "本回合没有 done" };
      return {
        ok: true,
        observed: { requestId, declaredTools: declaredTools.slice(0, 5), declaredCount: declaredTools.length },
      };
    }, "turn-completed-same-request", { assert: true }),

    // ── 6. 负控：伪造 ACK（未知 callId）必须被 T98 拒绝 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "视图没有 webContents" };
      const reply = await wc.executeJavaScript(
        `window.desktop.aiToolResult(${JSON.stringify({
          requestId: rt.fake.state.requestId ?? "t30-unknown",
          callId: "t30-forged-call",
          name: "insert_content",
          status: "success",
          output: "forged",
        })})`,
        true,
      ) as { ok?: boolean };
      return reply?.ok === false
        ? { ok: true, observed: reply }
        : { ok: false, observed: reply, detail: "T98 接受了伪造的 ACK —— 校验没有生效" };
    }, "forged-ack-rejected", { assert: true }),

    // ── 7. 负控：未知工具 / 工作区外路径 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as WiredRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const unknown = await callSurface<{ ok: boolean; kind?: string }>(rt.handlers, "document:toolCall",
        { tool: "t30_no_such_tool", app: "docs", filePath: rt.fixtures.docs, input: {} });
      const outsidePath = `${rt.repoRoot}\\..\\t30-outside-${Date.now()}.docx`;
      const outside = await callSurface<{ ok: boolean; kind?: string }>(rt.handlers, "document:toolCall",
        { tool: "insert_content", app: "docs", filePath: outsidePath, input: { html: "<p>x</p>" } });
      const ok = unknown.ok === false && outside.ok === false && outside.kind === "refused";
      return ok
        ? { ok: true, observed: { unknown: unknown.kind, outside: outside.kind } }
        : { ok: false, observed: { unknown, outside }, detail: "未知工具/工作区外路径没有按约定拒绝" };
    }, "wired-negative-controls", { assert: true }),

    step.assertDom(".ProseMirror", { textContains: `${UNIQUE.docs}-FROM-RENDERER` }, "wired-final-dom-has-inserted-text"),
  ],
});
