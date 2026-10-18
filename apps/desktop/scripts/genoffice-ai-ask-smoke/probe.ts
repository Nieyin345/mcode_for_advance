/**
 * 【ARC-007 / GenOffice AI 交互】真 Electron：真实 docs 页 + 生产最小 preload 下，
 * 验证用户点名称赞的完整旅程：
 *   前半段「选中 → Ask AI chip → 输入气泡 → 加入队列 → 侧栏队列行」；
 *   后半段「队列发送 → 聊天 user 气泡 → 主进程流式请求（本地 mock 端点）
 *          → 模型工具调用 → 文档真的被改」。
 *
 * ## 链路与 vendor 源码依据
 *
 * 前半段：
 *  1. 选中：`AiAskPopover.tsx:133-165`（`!selection.empty && editor.isFocused`）→
 *     `.ai-ask-trigger`（:397-414）；
 *  2. 弹输入框：`.ai-ask-pop`（:273）/ `.ai-ask-pop-input`（:306）；
 *  3. 确认入队：`.ai-ask-confirm`（:377）→ `App.tsx:6284 queueAdd` →
 *     `EditQueueCard` 的 `.ai-queue-row`（EditQueueCard.tsx:87）。
 *
 * 后半段：
 *  4. 点「发送 N 条修改」（`.ai-queue-send`，EditQueueCard.tsx:195）→
 *     `AiPanel.sendQueue`（:1200-1214）→ `runWith(instruction, display)` →
 *     聊天 `chat` 状态追加 user 条目（:1146-1157）→ 渲染 `.ai-msg-user`；
 *  5. `createElectronTransport`（renderer/ai/transport.ts:7-17）把请求经
 *     `window.desktop.aiStream` 送主进程；主进程 `ai:stream` handler
 *     （docs-main.ts:4084-4205）做 schema 校验 → `streamForProvider`
 *     （stream.ts:18）→ `streamOpenAiCompatible`（openai-compatible.ts:169）→
 *     `aiFetch(endpointUrl(baseUrl,'chat/completions'))`。**请求由主进程发起**
 *     （渲染端 CORS 不参与）。
 *  6. 模型回 `tool-call`（`delta.tool_calls` 流式分片）→ 主进程转
 *     `ai:stream-chunk(type='tool-call')` → `AgentLoop` 执行 skill 的
 *     `executeTool`（loop.ts:1176）→ docs 的 `replace_blocks` 执行器
 *     （tools.ts:1437）真的改 Tiptap 文档。
 *
 * ## mock 注入（绝不联网）
 *
 *  - 本探针在 Electron **主进程**起 `node:http` 服务，只绑 `127.0.0.1`、端口 0
 *    （内核分配）；handler 里直接复用 vendor 的真协议栈
 *    `streamForProvider`（packages/ai-provider/src/stream.ts）——不手写 SSE 解析，
 *    mock 只负责按 OpenAI chat-completions 流式格式吐分片。
 *  - preload 侧：`build.mjs` 在**打包后的生产 bundle** 末尾机械追加三个桥桩
 *    （`aiStream`/`aiStreamCancel`/`onAiStream`）并把 `getAiSettings` 覆盖为指向
 *    mock 的 custom provider。生产源码一行不动；本文件末尾有源码级断言钉住
 *    「生产 preload 里没有这些键」。
 *  - provider 配置：`provider:'custom'`，`baseUrl:http://127.0.0.1:<port>`，
 *    `profile.api:'openai-compatible'`（registry.ts:301-320 的 custom 分支）。
 *    没有任何外部 URL 参与。
 *
 * ## 断言（checks.json；★ = 任务书要求的四条）
 *
 *   1. ★ 选中后 `.ai-ask-trigger` 出现；
 *   2. ★ 入队后 `.ai-queue-row` +1 且文本一致（前半段回归）；
 *   3. ★ 点发送后聊天出现 user 气泡（`.ai-msg-user`，文本 = 队列摘要）；
 *   4. ★ mock 端点真的收到流式请求（POST /chat/completions，`stream:true`，
 *      带 tools；请求体落 evidence）；
 *   5. ★ 文档文本前后不同，且等于 mock 指定的修改（`mock-edit-ok`）；
 *   6. ★ 全程零未捕获异常（CDP + console + 页面钩子）。
 *
 * ## 已知边界（如实）
 *
 *  - 接的是**本地 mock 模型**，不是真模型；用于证明 vendor 的流式协议/工具循环/
 *    文档执行器在 Mcode 最小 preload 下真的能跑通，不证明任何真实模型质量。
 *  - 发送后 vendor 会在 run 结束时对「从未保存的空白文档」触发一次静默首存
 *    （App.tsx:5386-5396 `ai-docs-run-done` → `save(false,true)`）；生产 preload
 *    没有 `saveDocxNew`，该保存会失败并写状态栏。这不影响文档内容断言，但本
 *    套件把它记为已知边界（`saveDocxNew` 是 Mcode 文档保存车道的职责）。
 *  - 焦点/选区用页面内编辑器句柄驱动（隐藏窗口里 CDP 鼠标拖选不稳定），所走的
 *    vendor 代码路径与真实拖选相同（同一组 editor 事件）。
 */
import { BrowserWindow, ipcMain } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * vendor 的 AI 协议栈在运行时由 esbuild alias 注入（见 build.mjs：把
 * `@genoffice/ai-provider` 指到 `genoffice/packages/ai-provider/src/index.ts`，
 * 与 vendor 主进程同一份实现）。这里用 `require` 而不是静态 `import`，是因为
 * desktop 的 tsconfig 不解析 genoffice 包；`require` 的字符串不触发 TS 模块解析，
 * 只声明本文件用到的窄形状。
 */
interface VendorStreamCallbacks {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onToolCall: (call: unknown) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (reason: string) => void;
  onUsage?: (usage: unknown) => void;
  onActivity?: () => void;
}
interface VendorAiProviderModule {
  streamForProvider: (
    provider: string,
    config: { apiKey: string; model: string; baseUrl?: string; profile?: unknown },
    system: string,
    messages: never[],
    tools: never[],
    maxTokens: number,
    cb: VendorStreamCallbacks,
  ) => Promise<void>;
  sanitizeAiSettings: (input: unknown) => { provider: string; providers?: Record<string, unknown> } | null;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vendorAi = require("@genoffice/ai-provider") as VendorAiProviderModule;

/** 探针 settings 的窄形状（只取本文件用到的字段）。 */
interface MockAiSettings {
  provider: string;
  providers: Record<string, { apiKey: string; model: string; baseUrl?: string; profile?: { api: string } }>;
  maxOutputTokens: number;
}

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
  detail?: unknown;
}

interface Config {
  pagePath: string;
  preloadPath: string;
  waitMs: number;
  urlSuffix: string;
}

const INSTRUCTION = "把这段文字润色得更正式";
/** mock 模型要求写入文档的标记文本 —— 文档断言认它 */
const MARKER = "mock-edit-ok";
/** mock 收到的请求体（证明真走了流式协议） */
interface MockRequestRecord {
  at: number;
  method: string;
  path: string;
  stream: boolean | null;
  model: string | null;
  toolCount: number;
  toolNames: string[];
  hasSystem: boolean;
  messageRoles: string[];
  bodyBytes: number;
}

export async function runAiAskProbe(dir: string): Promise<void> {
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as Config;
  const checksPath = join(dir, "checks.json");
  const checks: Check[] = [];
  const evidence: Record<string, unknown> = {};
  const exceptions: string[] = [];
  const consoleErrors: string[] = [];
  let pageErrors: Array<{ type: string; message: string }> = [];

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS AI-ASK " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.error("FAIL AI-ASK " + name + " :: " + String(error));
    } finally {
      await writeFile(checksPath, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  ipcMain.handle("mcode:document-view:open-path", () => ({ ok: false, error: "probe" }));
  ipcMain.handle("mcode:document-view:save", () => ({ ok: false, error: "probe" }));

  // ─────────────── 本地 mock 模型端点（127.0.0.1 随机端口） ───────────────
  const mockRequests: MockRequestRecord[] = [];
  /** 每次模型请求编号：第 1 次回工具调用，第 2 次回纯文本收尾 */
  let modelTurns = 0;
  const mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
        mockRequests.push({
          at: Date.now(), method: req.method ?? "", path: req.url ?? "",
          stream: null, model: null, toolCount: 0, toolNames: [], hasSystem: false,
          messageRoles: [], bodyBytes: raw.length,
        });
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: only POST /chat/completions" } }));
        return;
      }
      let body: {
        model?: string; stream?: boolean; messages?: Array<{ role?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      } = {};
      try { body = JSON.parse(raw); } catch { /* recorded empty; the stream below still answers */ }
      mockRequests.push({
        at: Date.now(),
        method: "POST",
        path: req.url ?? "",
        stream: typeof body.stream === "boolean" ? body.stream : null,
        model: typeof body.model === "string" ? body.model : null,
        toolCount: body.tools?.length ?? 0,
        toolNames: (body.tools ?? []).map((t) => t.function?.name ?? "?"),
        hasSystem: (body.messages ?? []).some((m) => m.role === "system"),
        messageRoles: (body.messages ?? []).map((m) => m.role ?? "?"),
        bodyBytes: raw.length,
      });
      modelTurns += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const sse = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const chunk = (choice: unknown): void =>
        sse({ id: "mock-1", object: "chat.completion.chunk", model: body.model ?? "mock", choices: [choice] });
      if (modelTurns === 1) {
        // 第 1 轮：一次工具调用 —— 把选中段落改成含 marker 的新 HTML。
        // docs 的 createDocsSkill 用 replace_blocks（tools.ts:1437）；它的
        // tool 定义在请求体 tools 里，这里按名字匹配后回同样的名字。
        const hasReplace = (body.tools ?? []).some((t) => t.function?.name === "replace_blocks");
        const toolName = hasReplace
          ? "replace_blocks"
          : (body.tools?.[0]?.function?.name ?? "replace_blocks");
        const args = hasReplace
          ? { startBlockIndex: 0, endBlockIndex: 0, html: `<p>${MARKER}</p>` }
          : { html: `<p>${MARKER}</p>`, afterBlockIndex: -1 };
        chunk({
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_mock_1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        });
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else {
        // 第 2 轮（工具结果回来后）：纯文本收尾
        chunk({ index: 0, delta: { content: "已按请求完成修改。" }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const mockPort = await new Promise<number>((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => {
      const address = mockServer.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  evidence.mockBaseUrl = mockBaseUrl;

  /**
   * 探针给页面用的 settings：custom provider 指向 mock。
   * 经 IPC 返回（sandboxed preload 里没有 process.env；preload 的
   * `getAiSettings` 被 build.mjs 的探针补丁改成 invoke 这条通道）。
   */
  const mockSettings: MockAiSettings = {
    provider: "custom",
    providers: {
      custom: {
        apiKey: "mock-key",
        model: "mock-model",
        baseUrl: mockBaseUrl,
        profile: { api: "openai-compatible" },
      },
    },
    maxOutputTokens: 4096,
  };
  ipcMain.handle("probe:mock-ai-settings", () => mockSettings);

  // ── 主进程 ai:stream handler：形状与 docs-main.ts:4084-4205 同构，但把
  //    provider 栈换成**真** streamForProvider（同一份 vendor 实现），settings
  //    走 sanitizeAiSettings 同一条校验。这是「Mcode 主进程替 vendor 主进程」
  //    的诚实替身 —— 报告里会点名它不是生产接线。
  ipcMain.handle("ai:stream-cancel", (_event, requestId: string) => {
    activeStreams.get(requestId)?.abort();
  });
  const activeStreams = new Map<string, AbortController>();
  ipcMain.handle("ai:stream", async (event: { sender: Electron.WebContents }, request: {
    requestId: string; sessionId?: string; settings?: unknown; system: string;
    messages: never[]; tools?: never[]; maxTokens?: number;
  }) => {
    const send = (chunk: { requestId: string; type: string; [key: string]: unknown }): void => {
      if (!event.sender.isDestroyed()) event.sender.send("ai:stream-chunk", chunk);
    };
    const settings = vendorAi.sanitizeAiSettings(request.settings);
    if (!settings) {
      send({ requestId: request.requestId, type: "error", error: "probe: invalid AI settings payload" });
      return;
    }
    const { requestId, system, messages } = request;
    const tools = request.tools ?? [];
    const provider = settings.provider;
    const config = settings.providers?.[provider] as
      | { apiKey: string; model: string; baseUrl?: string; profile?: unknown }
      | undefined;
    if (!config || !config.apiKey || !config.model) {
      send({ requestId, type: "error", error: "probe: mock provider missing key/model" });
      return;
    }
    const controller = new AbortController();
    activeStreams.set(requestId, controller);
    try {
      let stopReason: string | undefined;
      await vendorAi.streamForProvider(provider, config, system, messages, tools, request.maxTokens ?? 4096, {
        signal: controller.signal,
        onDelta: (text) => send({ requestId, type: "delta", text }),
        onReasoningDelta: (text) => send({ requestId, type: "reasoning", text }),
        onToolCall: (toolCall) => send({ requestId, type: "tool-call", toolCall }),
        onStopReason: (reason) => { stopReason = reason; },
        onUsage: (usage) => send({ requestId, type: "usage", usage }),
      });
      send({ requestId, type: "done", stopReason });
    } catch (err) {
      send({ requestId, type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      activeStreams.delete(requestId);
    }
  });

  const url = pathToFileURL(config.pagePath).toString() + config.urlSuffix;
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: config.preloadPath,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler?.(() => ({ action: "deny" }));
  wc.on("console-message", (event: unknown, level?: number, message?: string) => {
    const d = event as { message?: string; level?: string };
    const text = d.message ?? String(message ?? "");
    if ((d.level ?? String(level)) === "error" || /Uncaught|is not a function/.test(text)) {
      consoleErrors.push(text.split("\n")[0]);
    }
  });

  let debuggerAttached = false;
  try {
    wc.debugger.attach("1.3");
    debuggerAttached = true;
  } catch {
    /* CDP 不可用时页面钩子仍是第二证据源 */
  }
  if (debuggerAttached) {
    wc.debugger.on("message", (_e, method, params) => {
      if (method !== "Runtime.exceptionThrown") return;
      const p = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      exceptions.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "?").split("\n")[0]);
    });
    void Promise.allSettled([wc.debugger.sendCommand("Runtime.enable")]);
  }
  const js = <T = unknown>(expr: string): Promise<T> => wc.executeJavaScript(expr, true) as Promise<T>;

  try {
    await wc.loadURL(url);
    await delay(config.waitMs);

    const hookSource = `
      if (!window.__gasErrHook) {
        window.__gasErrHook = true;
        window.__gasErr = [];
        window.addEventListener('error', (e) => window.__gasErr.push({ type: 'error', message: String(e.message || '') }));
        window.addEventListener('unhandledrejection', (e) => window.__gasErr.push({ type: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason || '') }));
      }
    `;
    try { await js(hookSource); } catch { /* 已注入或页面已销毁 */ }

    // ── 1. 前置：页面已挂载 + 编辑器句柄可达 + AI 桥三件套在位 ──
    const mounted = await js<{
      root: number; pm: boolean; editor: boolean; dock: string;
      bridgeKeys: string[]; aiStream: boolean; onAiStream: boolean; aiSettingsProvider: string | null;
    }>(`(async () => {
      const root = document.getElementById('root');
      const pm = document.querySelector('.ProseMirror');
      const dock = document.querySelector('.ai-dock');
      const d = window.desktop ?? {};
      let provider = null;
      try { provider = (await d.getAiSettings()).provider ?? null; } catch { provider = 'error'; }
      return {
        root: root ? root.childElementCount : -1, pm: !!pm, editor: !!(pm && pm.editor), dock: dock ? dock.className : '',
        bridgeKeys: Object.keys(d), aiStream: typeof d.aiStream === 'function', onAiStream: typeof d.onAiStream === 'function',
        aiSettingsProvider: provider,
      };
    })()`);
    evidence.mounted = mounted;
    await check("前置：真实 docs 页已挂载、编辑器句柄可达、mock AI 桥三件套在位", () => {
      assert(mounted.root > 0, `#root 子节点 ${mounted.root}`);
      assert(mounted.pm, "没有 .ProseMirror");
      assert(mounted.editor, "view.dom.editor 不在了（tiptap 内部结构变了？）");
      assert(/ai-dock/.test(mounted.dock), `AI 侧栏不在位: ${mounted.dock}`);
      assert(mounted.aiStream && mounted.onAiStream, "探针 AI 桥缺失");
      assert(mounted.aiSettingsProvider === "custom", `getAiSettings.provider = ${mounted.aiSettingsProvider}（应为 custom）`);
    });

    // ── 2. 输入一段真实文本（CDP 键入；退回 insertContent 并如实记录） ──
    await js(`document.querySelector('.ProseMirror').focus()`);
    let typedVia = "cdp-input";
    try {
      if (!debuggerAttached) throw new Error("no cdp");
      await wc.debugger.sendCommand("Input.insertText", { text: "这是第一段测试文本。" });
      const docText = await js<string>(
        `(() => { const e = document.querySelector('.ProseMirror').editor; return e.state.doc.textBetween(0, e.state.doc.content.size, ' ', ' '); })()`,
      );
      if (!docText.includes("测试文本")) throw new Error("输入未进文档: " + docText);
    } catch (err) {
      typedVia = "insertContent";
      await js(`document.querySelector('.ProseMirror').editor.commands.insertContent('这是第一段测试文本。')`);
      evidence.typeFallbackReason = String(err).slice(0, 200);
    }
    evidence.typedVia = typedVia;
    evidence.docTextBefore = await js<string>(
      `document.querySelector('.ProseMirror').editor.state.doc.textBetween(0, document.querySelector('.ProseMirror').editor.state.doc.content.size, ' ', ' ')`,
    );

    // ── 3. ★ 选中 → chip 出现 ──
    const selection = await js<{
      from: number; to: number; empty: boolean; isFocused: boolean; trigger: boolean;
    }>(`(async () => {
      const pm = document.querySelector('.ProseMirror');
      const editor = pm.editor;
      let from = -1, to = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from >= 0) return false;
        if (node.isText && node.text && node.text.includes('测试文本')) {
          const idx = node.text.indexOf('测试文本');
          from = pos + idx; to = from + '测试文本'.length;
          return false;
        }
        return true;
      });
      if (from < 0) return { from, to, empty: true, isFocused: false, trigger: false };
      pm.focus();
      editor.commands.setTextSelection({ from, to });
      await new Promise((r) => setTimeout(r, 300));
      return { from, to, empty: editor.state.selection.empty, isFocused: editor.isFocused, trigger: !!document.querySelector('.ai-ask-trigger') };
    })()`);
    evidence.selection = selection;
    await check("★ 选中后浮动 Ask AI chip（.ai-ask-trigger）出现", () => {
      assert(selection.from >= 0, "文档里找不到测试文本");
      assert(selection.empty === false, "选区是空的");
      assert(selection.isFocused === true, "编辑器未获得焦点（vendor 触发条件要求 isFocused）");
      assert(selection.trigger === true, "没有 .ai-ask-trigger");
    });

    // ── 4. 点开 popover 并写入指令 ──
    const popover = await js<{ open: boolean; inputExists: boolean }>(`(async () => {
      const t = document.querySelector('.ai-ask-trigger');
      if (!t) return { open: false, inputExists: false };
      t.click();
      await new Promise((r) => setTimeout(r, 200));
      return { open: !!document.querySelector('.ai-ask-pop'), inputExists: !!document.querySelector('.ai-ask-pop-input') };
    })()`);
    evidence.popover = popover;
    await check("点击 chip 后输入气泡打开（.ai-ask-pop + 输入框）", () => {
      assert(popover.open, "没有 .ai-ask-pop");
      assert(popover.inputExists, "没有 .ai-ask-pop-input");
    });

    const filled = await js<{ value: string; confirmDisabled: boolean | null }>(`(async () => {
      const input = document.querySelector('.ai-ask-pop-input');
      if (!input) return { value: '', confirmDisabled: null };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(INSTRUCTION)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      const confirm = document.querySelector('.ai-ask-confirm');
      return { value: input.value, confirmDisabled: confirm ? confirm.disabled : null };
    })()`);
    evidence.filled = filled;
    await check("指令写入受控输入框且「加入队列」可用", () => {
      assert(filled.value === INSTRUCTION, `输入框值不符: ${filled.value}`);
      assert(filled.confirmDisabled === false, "「加入队列」按钮仍禁用");
    });

    // ── 5. ★ 确认 → 侧栏队列行 +1，且文本一致 ──
    const queued = await js<{ before: number; after: number; count: string | null; rowText: string | null }>(`(async () => {
      const before = document.querySelectorAll('.ai-queue-row').length;
      const confirm = document.querySelector('.ai-ask-confirm');
      if (!confirm) return { before, after: before, count: null, rowText: null };
      confirm.click();
      await new Promise((r) => setTimeout(r, 400));
      const count = document.querySelector('.ai-queue-count');
      const text = document.querySelector('.ai-queue-row .ai-queue-text');
      return { before, after: document.querySelectorAll('.ai-queue-row').length, count: count ? count.textContent : null, rowText: text ? text.textContent : null };
    })()`);
    evidence.queued = queued;
    await check("★ 确认后侧栏队列行 +1（.ai-queue-row / .ai-queue-count）", () => {
      assert(queued.after === queued.before + 1, `.ai-queue-row ${queued.before} → ${queued.after}`);
      assert(queued.count !== null && /^1\/\d+$/.test(queued.count), `.ai-queue-count 不符: ${queued.count}`);
    });
    await check("★ 队列记录的文本与输入一致", () => {
      assert(queued.rowText !== null, "没有 .ai-queue-text");
      assert(queued.rowText?.includes(INSTRUCTION) === true, `行文本不含指令原文: ${queued.rowText}`);
    });

    // ── 6. ★ 点「发送 N 条修改」→ 聊天 user 气泡 ──
    //    `.ai-queue-send`（EditQueueCard.tsx:195）→ sendQueue → runWith →
    //    setChat 追加 user 条目（AiPanel.tsx:1146-1157）→ `.ai-msg-user`。
    const sendClicked = await js<{ clicked: boolean; label: string | null; disabled: boolean | null }>(`(async () => {
      const btn = document.querySelector('.ai-queue-send');
      if (!btn) return { clicked: false, label: null, disabled: null };
      const label = btn.textContent;
      const disabled = btn.disabled;
      btn.click();
      return { clicked: true, label, disabled };
    })()`);
    evidence.sendClicked = sendClicked;
    await check("点「发送 N 条修改」后队列进入运行", () => {
      assert(sendClicked.clicked, "没有 .ai-queue-send");
      assert(sendClicked.disabled === false, `发送按钮禁用: ${sendClicked.label}`);
    });

    // 等 mock 第 1 轮请求到达 + 工具执行 + 第 2 轮收尾 + 气泡落定。
    const userBubble = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const bubble = await js<{ text: string | null; count: number }>(`(() => {
          const el = document.querySelector('.ai-msg-user');
          return { text: el ? el.textContent : null, count: document.querySelectorAll('.ai-msg-user').length };
        })()`);
        if (bubble.count > 0) return bubble;
        await delay(200);
      }
      return { text: null, count: 0 };
    })();
    evidence.userBubble = userBubble;
    await check("★ 发送后聊天区出现 user 气泡（文本 = 队列摘要）", () => {
      assert(userBubble.count >= 1, `没有 .ai-msg-user（count=${userBubble.count}）`);
      assert(userBubble.text?.includes(INSTRUCTION) === true, `气泡文本不含指令: ${userBubble.text}`);
    });

    // ── 7. ★ mock 收到流式请求（证明真走协议栈，没被桩短路） ──
    const waitMock = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 30000 && mockRequests.length < 1) await delay(200);
      return mockRequests.slice();
    })();
    evidence.mockRequests = waitMock;
    await check("★ mock 端点收到流式请求（POST /chat/completions, stream:true, 带 tools）", () => {
      assert(waitMock.length >= 1, "mock 没收到任何请求");
      const first = waitMock[0];
      assert(first.method === "POST" && first.path.includes("/chat/completions"), `首请求形状不符: ${JSON.stringify(first)}`);
      assert(first.stream === true, `stream 不是 true: ${JSON.stringify(first)}`);
      assert(first.toolCount > 0 && first.toolNames.includes("replace_blocks"), `tools 里没有 replace_blocks: ${JSON.stringify(first.toolNames)}`);
      assert(first.hasSystem, "请求没有 system 消息");
    });

    // ── 8. ★ 文档真的被改：等 marker 出现在 ProseMirror 文本里 ──
    //    replace_blocks 执行器（tools.ts:1437）会改 Tiptap doc；随后 run 结束
    //    的静默首存可能因缺 saveDocxNew 失败，但**文档内容本身**已变。
    const docAfter = await (async () => {
      const start = Date.now();
      let last = "";
      while (Date.now() - start < 30000) {
        last = await js<string>(
          `document.querySelector('.ProseMirror').editor.state.doc.textBetween(0, document.querySelector('.ProseMirror').editor.state.doc.content.size, ' ', ' ')`,
        ).catch(() => "");
        if (last.includes(MARKER)) return { text: last, waitedMs: Date.now() - start };
        await delay(200);
      }
      return { text: last, waitedMs: Date.now() - start };
    })();
    evidence.docTextAfter = docAfter;
    await check("★ 文档文本前后不同且等于 mock 指定的修改（marker 落进文档）", () => {
      const before = String(evidence.docTextBefore ?? "");
      assert(before.length > 0, "前置文档文本为空");
      assert(docAfter.text.includes(MARKER), `文档里没有 ${MARKER}（30s 内未出现）: ${docAfter.text.slice(0, 300)}`);
      assert(docAfter.text !== before, "文档文本没有变化");
    });

    // 工具执行轮次证据：mock 恰好两轮（工具轮 + 收尾轮）。
    // 等第二个请求到达（收尾轮）—— 工具结果必须回传，说明 AgentLoop 真执行了。
    await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000 && mockRequests.length < 2) await delay(200);
    })();
    evidence.mockRequestCount = mockRequests.length;
    evidence.mockRequests = mockRequests.slice();
    await check("mock 第二轮请求带回了工具结果（messageRoles 含 tool）", () => {
      assert(mockRequests.length >= 2, `mock 只收到 ${mockRequests.length} 轮请求（工具循环未闭环）`);
      assert(mockRequests[1].messageRoles.includes("tool"), `第二轮请求没有 tool 消息: ${JSON.stringify(mockRequests[1].messageRoles)}`);
    });

    // ── 9. ★ 全程零未捕获异常 ──
    pageErrors = await js<Array<{ type: string; message: string }>>(`Array.isArray(window.__gasErr) ? window.__gasErr.slice(0, 20) : []`).catch(() => []);
    evidence.exceptions = exceptions;
    evidence.consoleErrors = consoleErrors;
    evidence.pageErrors = pageErrors;
    await check("★ 全程零未捕获异常（CDP + console + 页面钩子）", () => {
      assert(debuggerAttached || pageErrors.length === 0, "CDP 未挂上且页面钩子也为空 —— 没有异常证据，拒绝放行");
      assert(exceptions.length === 0, `CDP 异常: ${JSON.stringify(exceptions.slice(0, 3))}`);
      assert(consoleErrors.length === 0, `console error: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
      assert(pageErrors.length === 0, `页面钩子: ${JSON.stringify(pageErrors.slice(0, 3))}`);
    });

    // ── 10. 源码级：生产 preload 不得含探针桥（防越界） ──
    await check("生产 preload 源码没有 aiStream/onAiStream（探针桥只在产物里）", async () => {
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const name of ["aiStream", "aiStreamCancel", "onAiStream", "onMcpCommand", "reportMcpResult"]) {
        assert(!new RegExp(`^\\s*${name}\\s*[:(]`, "m").test(src), `生产 preload 不得提供 ${name}`);
      }
    });
  } finally {
    if (debuggerAttached) {
      try { wc.debugger.detach(); } catch { /* 已分离 */ }
    }
    if (!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler("mcode:document-view:open-path");
    ipcMain.removeHandler("mcode:document-view:save");
    ipcMain.removeHandler("ai:stream");
    ipcMain.removeHandler("ai:stream-cancel");
    ipcMain.removeHandler("probe:mock-ai-settings");
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ url, debuggerAttached, ...evidence, checks }, null, 2));
  }
}
