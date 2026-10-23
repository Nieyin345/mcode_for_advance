/**
 * T30 旅程 2 —— Docs：**成品链路**（生产装配原样）上的工具面往返。
 *
 * ## 这条旅程验什么
 *
 * 完全按生产 `ipc/index.ts` 的装配方式：
 *   - `documentViewHost.setDocsAiPorts(docsAiPorts)` —— **未包装**的 ports
 *     （与产品一字不差）；
 *   - `registerDocumentHandlers` 注册七条 `document:*` 通道；
 *   - Docs 视图打开一个真 `.docx`，并注入 `mcodeSessionId`（生产面板必带）。
 *
 * 然后：
 *   1. 发现链路：`document.apps` → `toolsList` → `toolDescribe`；
 *   2. 调用链路：**绕开 T98，经 `document.toolCall` 直接用 `read_blocks` 读** ——
 *      这条走 CLI，符合设计；
 *   3. **关键负控**：在渲染端没有活跃 AI 请求时，调一个 renderer-only 工具
 *      （`reply_comment`）必须**被拒绝**（`kind: "refused"`）。
 *      这条同时是 T40 缺陷的证据：生产装了未包装的 ports，登记簿永远为空，
 *      所以「文件开着」的渲染端路线永远走不到。
 *
 * ## 为什么不在这里伪造 T98 ACK
 *
 * T30 卡要求「真的让渲染端执行了工具」。**在生产装配下**，渲染端能执行工具的
 * 唯一通道是 T98 的请求级 ACK；而生产没把它接到登记簿上（T40）。本旅程如实
 * 断言这个拒绝，并把「接上之后会怎样」交给 `docs-tool-roundtrip-wired` 那条
 * 旅程（它把缺失的那一段装配**显式**补上，证明链路本身是通的）。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { join } from "node:path";
import { UNIQUE } from "../fixtures.js";

interface DocsRun {
  harness: import("../../t7-genoffice-u1/harness.js").GenofficeHarness;
  fixtures: { docs: string; sheets: string };
  docId: string;
  repoRoot: string;
}

const DOC_ID = "t30-docs-production";

/**
 * 生产同款装配：T7 的 harness（真 Host 单例 + 真视图 + 真 DB）+
 * `docsAiPorts`（**不**包 `withRendererToolRegistry`）+ 生产 `document.*` handler。
 */
async function productionSetup(ctx: import("../../electron-u1/driver/index.js").U1SetupContext) {
  const repoRoot = process.env.MCODE_U1_REPO ?? "";
  if (!repoRoot) throw new Error("T30: MCODE_U1_REPO 未设置");
  if (ctx.win === null) throw new Error("T30: Docs 视图需要宿主窗口");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assembleHarness } = require("../../t7-genoffice-u1/harness.js") as typeof import("../../t7-genoffice-u1/harness.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureFixtures } = require("../fixtures.js") as typeof import("../fixtures.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installDocumentSurface } = require("./lib.js") as typeof import("./lib.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { docsAiPorts } = require("@main/document/docsAiPorts.js") as typeof import("@main/document/docsAiPorts.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { editorUrl, waitForPageReady, waitFor } = require("../../t7-genoffice-u1/editor-flow.js") as typeof import("../../t7-genoffice-u1/editor-flow.js");

  const fixtures = ensureFixtures(ctx.projectDir, repoRoot);
  const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir });
  // 【生产一字不差】未包装的 ports：
  harness.host.setDocsAiPorts(docsAiPorts);
  // 生产 `registerDocumentHandlers`（七条 document:* 通道）—— 本旅程的调用对象。
  installDocumentSurface(repoRoot);

  const wcUrl = editorUrl("docs");
  const opened = harness.host.open({
    docId: DOC_ID,
    url: wcUrl,
    bounds: { x: 0, y: 0, width: 1280, height: 900 },
    visible: true,
    mcodeSessionId: "t30-u1-session",
  });
  if (!opened.ok) {
    harness.dispose();
    throw new Error(`T30: docs 视图打开失败：${opened.reason}`);
  }
  const wc = harness.webContentsOf(DOC_ID);
  if (wc === null) {
    harness.dispose();
    throw new Error("T30: docs 视图没有 webContents");
  }
  await waitForPageReady(wc);
  const mounted = await waitFor(() => wc.executeJavaScript("!!document.querySelector('.ProseMirror')").then((v: unknown) => v === true), 30_000, 200);
  if (!mounted) throw new Error("T30: docs 起始屏 30s 内没有挂载 .ProseMirror");

  // 生产打开链：documentView:openPath（页面回执后才提交会话）。
  const openReply = (await harness.handlers.get("documentView:openPath")!({ sender: wc }, { docId: DOC_ID, filePath: fixtures.docs })) as { ok?: boolean; reason?: string };
  if (openReply.ok !== true) throw new Error(`T30: openPath 被拒：${openReply.reason}`);
  const session = await waitFor(async () => harness.host.sessionFor(DOC_ID), 30_000, 200);
  if (!session) throw new Error("T30: 30s 内没有提交打开会话（open-committed 未到）");

  const runtime: DocsRun = { harness, fixtures, docId: DOC_ID, repoRoot };
  return { pageFromView: wc, dispose() { harness.dispose(); }, runtime };
}

export const docsProductionJourney = defineU1Journey({
  name: "docs-tool-roundtrip-production",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 30_000,
    setup: productionSetup as never,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.screenshot("docs-opened", "docs-editor-opened"),
    step.assertDom(".ProseMirror", { textContains: UNIQUE.docs }, "docs-fixture-text-visible"),

    // ── 发现链路 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const apps = await callSurface<{ apps: Array<{ app: string; toolCount: number; residentTools: string[] }>; totalTools: number }>(handlers, "document:apps", {});
      const docs = apps.apps.find((item) => item.app === "docs");
      if (!docs) return { ok: false, observed: apps, detail: "document_apps 没有返回 docs" };
      if (docs.toolCount < 30) return { ok: false, observed: docs, detail: `docs 工具数异常：${docs.toolCount}` };
      if (apps.totalTools !== 139) return { ok: false, observed: { total: apps.totalTools }, detail: "目录总数不是 139" };
      return { ok: true, observed: { docs: docs.toolCount, total: apps.totalTools, resident: docs.residentTools } };
    }, "apps-discovery", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const listed = await callSurface<{ shown: number; tools: Array<{ name: string; route: string }> }>(handlers, "document:toolsList", { app: "docs" });
      const hasRead = listed.tools.some((tool) => tool.name === "read_blocks");
      const hasEdit = listed.tools.some((tool) => tool.name === "insert_content");
      return hasRead && hasEdit && listed.shown >= 30
        ? { ok: true, observed: { shown: listed.shown } }
        : { ok: false, observed: listed, detail: "toolsList 里缺少 read_blocks / insert_content 或数量不足" };
    }, "tools-list", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const described = await callSurface<{ ok: boolean; app?: string; tool?: string; route?: string; schemaText?: string }>(handlers, "document:toolDescribe", { tool: "read_blocks", app: "docs" });
      return described.ok === true && described.app === "docs" && (described.schemaText?.length ?? 0) > 20
        ? { ok: true, observed: { route: described.route, schemaChars: described.schemaText?.length ?? 0 } }
        : { ok: false, observed: described, detail: "toolDescribe 没有给出 docs.read_blocks 的参数正文" };
    }, "tool-describe", { assert: true }),

    // ── 调用链路（CLI 路线，设计如此）──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const read = await callSurface<{ ok: boolean; route?: string; text?: string; kind?: string; reason?: string }>(
        handlers, "document:toolCall",
        { tool: "read_blocks", app: "docs", filePath: rt.fixtures.docs, input: {} },
      );
      if (read.ok !== true) return { ok: false, observed: read, detail: `toolCall(read_blocks) 失败：${read.reason}` };
      if (read.route !== "cli") return { ok: false, observed: read, detail: `read_blocks 应走 CLI，实际 ${read.route}` };
      return { ok: true, observed: { route: read.route, text: (read.text ?? "").slice(0, 200) } };
    }, "tool-call-cli-read", { assert: true }),

    // ── ★ 关键负控 / T40 证据：文件开着，但渲染端通道未被登记 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const call = await callSurface<{ ok: boolean; kind?: string; reason?: string; route?: string }>(
        handlers, "document:toolCall",
        { tool: "reply_comment", app: "docs", filePath: rt.fixtures.docs, input: { commentId: "c0", text: "T30 probe" } },
      );
      // 生产装配（未接登记簿）下：必须**显式拒绝**，且原因点名「没有受信的渲染端绑定」。
      // 若 T40 修好，这条会变成 route:"renderer" —— 那时应该由 wired 旅程接管，本卡回写里说明。
      if (call.ok === true) {
        return {
          ok: false,
          observed: call,
          detail: "生产装配下 renderer-only 工具竟然执行了 —— 除非 T40 已修复，否则说明存在绕过登记簿的旁路",
        };
      }
      const refused = call.kind === "refused" && /受信|渲染端/.test(call.reason ?? "");
      return refused
        ? { ok: true, observed: { kind: call.kind, reason: (call.reason ?? "").slice(0, 160) } }
        : { ok: false, observed: call, detail: `拒绝形态不对（kind=${call.kind}）` };
    }, "renderer-route-refused-without-registry", { assert: true }),

    // ── 负控 2/3：未知工具、错误文件 ──
    step.run(async ({ runtime }) => {
      const rt = runtime as DocsRun;
      const { callSurface } = require("./lib.js") as typeof import("./lib.js");
      const handlers = require("./lib.js").installDocumentSurface(rt.repoRoot) as ReturnType<typeof import("./lib.js").installDocumentSurface>;
      const unknown = await callSurface<{ ok: boolean; kind?: string; reason?: string }>(
        handlers, "document:toolCall",
        { tool: "t30_no_such_tool", app: "docs", filePath: rt.fixtures.docs, input: {} },
      );
      const outside = await callSurface<{ ok: boolean; kind?: string }>(
        handlers, "document:toolCall",
        { tool: "read_blocks", app: "docs", filePath: join(rt.repoRoot, "..", "t30-outside.docx"), input: {} },
      );
      const ok = unknown.ok === false && outside.ok === false && outside.kind === "refused";
      return ok
        ? { ok: true, observed: { unknown: unknown.kind, outside: outside.kind } }
        : { ok: false, observed: { unknown, outside }, detail: "未知工具 / 工作区外路径没有按约定拒绝" };
    }, "negative-controls", { assert: true }),

    // ── 渲染端仍在、内容未被上述调用破坏 ──
    step.assertDom(".ProseMirror", { textContains: UNIQUE.docs }, "docs-content-intact"),
    step.screenshot("docs-after-calls", "docs-after-tool-calls"),
  ],
});
