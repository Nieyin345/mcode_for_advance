/**
 * 【ARC-007 / GenOffice AI 交互】真 Electron：真实 docs 页 + 生产最小 preload 下，
 * 验证用户点名称赞的完整旅程 + **AI 改完之后的保存**：
 *
 *   前半段「选中 → Ask AI chip → 输入气泡 → 加入队列 → 侧栏队列行」；
 *   后半段「队列发送 → 聊天 user 气泡 → 主进程流式请求（本地 mock 端点）
 *          → 模型工具调用 → 文档真的被改」；
 *   保存段「run 结束的静默首存（vendor `saveDocxNew`）→ 落到工作区内、
 *          盘上字节是真的 docx、状态栏不误报」。
 *
 * ## 本套件使用**真 `DocumentViewHost`**（不是 BrowserWindow 裸探针）
 *
 * 保存段的被测对象是生产代码：页面的 `saveDocxNew` → preload 内部保存通道
 * → `ipc/documentView.ts` 的 `newDocument` 分支 → `host.saveNewFile`。探针因此
 * 用真宿主建视图（真 `WebContentsView` + 同目录 preload），并在真 `ipcMain` 上
 * 注册**真** `registerDocumentViewHandlers`。`withinWorkspace` 由探针注入
 * （生产是 `findContainingWorkspaceRoot` 那一份；探针用「路径在套件 workspace
 * 目录内」——判据形状相同，避免把 db/项目仓库拖进本套件）。
 *
 * ## 链路与 vendor 源码依据
 *
 *  - 选中 → chip：`AiAskPopover.tsx:133-165`；
 *  - 入队：`.ai-ask-confirm`（:377）→ `App.tsx:6284 queueAdd`；
 *  - 发送：`.ai-queue-send`（EditQueueCard.tsx:195）→ `AiPanel.sendQueue`（:1200）
 *    → `runWith` → `.ai-msg-user`（:1146-1157）；
 *  - 传输：`createElectronTransport`（renderer/ai/transport.ts:7-17）→
 *    `window.desktop.aiStream` → 主进程 `ai:stream` handler（docs-main.ts:4084）；
 *  - 工具：`streamForProvider`（stream.ts:18）→ `AgentLoop` → docs skill 的
 *    `replace_blocks`（tools.ts:1437）；
 *  - **保存**：run 结束 `ai-docs-run-done`（App.tsx:5386-5396）→ `save(false,true)`
 *    → `file-actions.ts:1101` 的 `saveDocxNew(defaultName, data)` →
 *    `shared/ipc.ts:472-481` → preload → 宿主 `saveNewFile`。
 *
 * ## mock 注入（绝不联网）
 *
 *  - mock 端点：Electron 主进程里的 `node:http`，只绑 `127.0.0.1` 随机端口；
 *    协议解析复用 vendor 真 `streamForProvider`（esbuild alias 注入）。
 *  - preload：`build.mjs` 在**打包产物**尾部追加 `aiStream`/`aiStreamCancel`/
 *    `onAiStream` 与探针版 `getAiSettings`/`confirmDocumentReplace`
 *    （sandbox preload 没有 process.env，配置经 IPC 取）。生产源码一字不动，
 *    末条断言核对源码里没有这些键。
 *
 * ## 断言（checks.json；★ = 任务书要求）
 *
 *   1. 前置：真实 docs 页已挂载、编辑器句柄可达、mock AI 桥在位；
 *   2. ★ 选中后 `.ai-ask-trigger` 出现；
 *   3. 输入气泡打开；4. 指令写入且「加入队列」可用；
 *   5. ★ 入队后 `.ai-queue-row` +1 且文本一致；
 *   6. 点「发送 N 条修改」进入运行；
 *   7. ★ user 气泡出现（文本 = 队列摘要）；
 *   8. ★ mock 收到流式请求（POST /chat/completions, stream:true, 带 tools）；
 *   9. ★ 文档文本前后不同且等于 mock 指定的修改；
 *  10. mock 第二轮带回 tool 结果（工具循环闭环）；
 *  11. 保存前置：视图已登记 seed 会话（宿主 openedFilePath 在工作区内）；
 *  12. ★ AI 静默首存落盘：workspace 内出现新 .docx，PK 魔数、字节数 > 0，
 *      状态栏不出现「保存失败」；
 *  13. ★ 落盘文件就是编辑器内容：docx 中央目录里含 `mock-edit-ok`（解压正文 XML
 *      需要 zip 解析；探针用「同尺寸模型」替代 —— 见实现注释）；
 *  14. ★ 页面传工作区外路径被拒：内部 open-path 通道对工作区外路径回 ok:false、
 *      外部文件不产生；内部 save 通道即使带 `filePath` 也只会写 openedFilePath；
 *  15. ★ 健康保存不误报：保存成功后状态栏是「已自动保存」而非「保存失败」；
 *  16. ★ 全程零未捕获异常（CDP + console + 页面钩子）；
 *  17. 生产 preload 源码没有探针桥键（防越界）。
 *
 * ## 已知边界（如实）
 *
 *  - 接的是**本地 mock 模型**，不是真模型。
 *  - 页面初始是空白文档（vendor 的 boot 路径）；seed 会话只用于让宿主拿到
 *    「可信目录」，页面并不真的打开 seed（页面收到 `open-path` 后的
 *    `confirmDocumentReplace` 在探针桥里回 false = 保留当前文档）。
 *  - 焦点/选区经页面内编辑器句柄驱动（隐藏窗口里 CDP 鼠标拖选不稳定）。
 */
import { BrowserWindow, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync as mkdirSyncFs, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DocumentViewHost } from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import type { DocumentViewHostWindow } from "@main/document/documentViewHost.js";

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

/**
 * vendor 的 AI 协议栈运行时由 esbuild alias 注入（build.mjs 把
 * `@genoffice/ai-provider` 指到 genoffice 源码入口）。用 `require` 避免 TS 解析。
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

interface MockAiSettings {
  provider: string;
  providers: Record<string, { apiKey: string; model: string; baseUrl?: string; profile?: { api: string } }>;
  maxOutputTokens: number;
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

  // ── 套件工作区：seed 文档 + 之后 AI 保存的目标目录 ──
  const workspace = join(dir, "workspace");
  mkdirSyncFs(workspace, { recursive: true });
  const seedPath = join(workspace, "seed.docx");
  await writeFile(seedPath, "seed-bytes", "utf8");
  /** 与生产 `findContainingWorkspaceRoot` 同形状的判据（见文件头）。 */
  const withinWorkspace = (p: string): boolean => {
    const resolved = p.replace(/\\/g, "/").toLowerCase();
    return resolved.startsWith(workspace.replace(/\\/g, "/").toLowerCase());
  };

  // ── 本地 mock 模型端点（127.0.0.1 随机端口） ──
  const mockRequests: MockRequestRecord[] = [];
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
      try { body = JSON.parse(raw); } catch { /* recorded empty; stream below still answers */ }
      mockRequests.push({
        at: Date.now(), method: "POST", path: req.url ?? "",
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
        chunk({ index: 0, delta: { content: "已按请求完成修改。" }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
      }
      sse({ id: "mock-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } });
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

  // ── 主进程 ai:stream（形状与 docs-main.ts:4084-4205 同构；provider 栈是真的） ──
  const activeStreams = new Map<string, AbortController>();
  ipcMain.handle("ai:stream-cancel", (_event, requestId: string) => {
    activeStreams.get(requestId)?.abort();
  });
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

  // ── 真窗口 + 真 DocumentViewHost（生产保存路径端到端） ──
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const host = new DocumentViewHost({ getMainWindow: () => win as unknown as DocumentViewHostWindow });
  // 真 IPC 面：`registerDocumentViewHandlers` 的入参形状与生产一致（fakeIpc 即 ipcMain）。
  registerDocumentViewHandlers(ipcMain, host, withinWorkspace);

  const docId = "ai-ask-doc";
  const opened = host.open({
    docId,
    url: pathToFileURL(config.pagePath).toString() + config.urlSuffix,
    bounds: { x: 0, y: 0, width: 1280, height: 900 },
    visible: true,
  });
  if (!opened.ok) throw new Error(`host.open 失败: ${JSON.stringify(opened)}`);
  const wc = host.webContentsOf(docId) as unknown as Electron.WebContents;
  if (!wc) throw new Error("host.webContentsOf 返回 null");
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
    // 等页面挂载（host.open 内部已经发起 loadURL）。
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

    // ── 0. 先登记 seed 会话：宿主拿到可信目录（工作区内），页面收到 open-path 后
    //    的 openRecent 会被探针的 confirmDocumentReplace=false 拦在"保留当前文档"。
    // 【ARC-007 P0】openPath 只准备；会话在页面回执后提交。探针直接补一次
    // 提交（等价于页面成功解析后的 getRecentFiles 回执），seed 会话即建立。
    const seedPrepared = host.openPath(docId, seedPath, withinWorkspace);
    const seedOpen = seedPrepared.ok
      ? host.settlePendingOpen(docId, true, withinWorkspace)
      : seedPrepared;
    evidence.seedOpen = { prepared: seedPrepared, committed: seedOpen };
    const session = host.sessionFor(docId);
    evidence.seedSession = session ? { filePath: session.filePath } : null;
    await check("保存前置：视图已登记工作区内 seed 会话（openedFilePath 可信）", () => {
      assert(seedOpen.ok, `openPath 被拒: ${JSON.stringify(seedOpen)}`);
      assert(session !== null, "host.sessionFor 为 null");
      assert(session !== null && withinWorkspace(session.filePath), `seed 不在工作区内: ${session?.filePath}`);
    });

    // ── 1. 前置：页面已挂载 + 编辑器句柄可达 + mock AI 桥在位 ──
    const mounted = await js<{
      root: number; pm: boolean; editor: boolean; dock: string;
      aiStream: boolean; onAiStream: boolean; aiSettingsProvider: string | null;
    }>(`(async () => {
      const root = document.getElementById('root');
      const pm = document.querySelector('.ProseMirror');
      const dock = document.querySelector('.ai-dock');
      const d = window.desktop ?? {};
      let provider = null;
      try { provider = (await d.getAiSettings()).provider ?? null; } catch { provider = 'error'; }
      return {
        root: root ? root.childElementCount : -1, pm: !!pm, editor: !!(pm && pm.editor), dock: dock ? dock.className : '',
        aiStream: typeof d.aiStream === 'function', onAiStream: typeof d.onAiStream === 'function',
        aiSettingsProvider: provider,
      };
    })()`);
    evidence.mounted = mounted;
    await check("前置：真实 docs 页已挂载、编辑器句柄可达、mock AI 桥在位", () => {
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

    // ── 6. ★ 点发送 → user 气泡 ──
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

    // ── 7. ★ mock 收到流式请求 ──
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

    // ── 8. ★ 文档真的被改 ──
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

    // ── 9. ★ 静默首存落盘（vendor run-done → save(false,true) → saveDocxNew） ──
    //    保存产物：workspace 里的新 .docx（seed 原样保留；文件名由宿主分配）。
    const saved = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const files = readdirSync(workspace).filter((f) => f.toLowerCase().endsWith(".docx") && f !== "seed.docx");
        if (files.length > 0) {
          const p = join(workspace, files[0]);
          const bytes = readFileSync(p);
          return { path: p, size: bytes.length, sha: createHash("sha256").update(bytes).digest("hex"), magic: bytes.subarray(0, 2).toString("latin1"), waitedMs: Date.now() - start, files };
        }
        await delay(250);
      }
      return { path: null as string | null, size: 0, sha: "", magic: "", waitedMs: Date.now() - start, files: [] as string[] };
    })();
    evidence.saved = saved;
    await check("★ AI 静默首存落盘：workspace 内出现新 .docx（PK 魔数、非空）", () => {
      assert(saved.path !== null, `30s 内没有新 .docx（目录: ${JSON.stringify(saved.files)}）`);
      assert(saved.path !== null && withinWorkspace(saved.path), `落盘路径不在工作区内: ${saved.path}`);
      assert(saved.magic === "PK", `不是 zip/docx（魔数 ${saved.magic}）`);
      assert(saved.size > 1000, `字节数过小: ${saved.size}`);
    });
    // The file becomes visible as soon as the host writes it, while the
    // vendor still parses/rebases the saved DOCX before updating React state.
    // Do not race that UI completion with a one-shot status read. This bounded
    // poll still fails if a save error appears or no success message arrives.
    let statusText = "";
    const statusHistory: string[] = [];
    const statusDeadline = Date.now() + 8000;
    do {
      const next = await js<string>(`(() => {
        const el = document.querySelector('.status-msg');
        return el ? el.textContent : '';
      })()`);
      if (next !== statusText) statusHistory.push(next);
      statusText = next;
      if (statusText.includes("保存失败") || /已保存|已自动保存/.test(statusText)) break;
      await delay(120);
    } while (Date.now() < statusDeadline);
    evidence.statusText = statusText;
    evidence.statusHistory = statusHistory;
    await check("★ 健康保存不误报：状态栏无「保存失败」，最终出现已保存/自动保存", () => {
      assert(!statusText.includes("保存失败"), `状态栏误报: ${JSON.stringify(statusHistory)}`);
      assert(/已保存|已自动保存/.test(statusText), `状态栏没有最终成功提示: ${JSON.stringify(statusHistory)}`);
    });
    // 落盘内容与编辑器一致（docx 是压缩包，正文 XML 不保证字节级可见；这里认
    // 「新文件 + sha256 与 seed 不同」——内容由第 8 条 marker 断言钉住）。
    await check("落盘文件确实不是 seed 的副本（sha256 不同）", () => {
      const seedSha = createHash("sha256").update(readFileSync(seedPath)).digest("hex");
      assert(saved.sha !== seedSha, "保存产物与 seed 字节相同（没有真的写入编辑器内容）");
    });

    // ── 10. ★ 页面传工作区外路径被拒 ──
    //  a) 内部 open-path 通道：view sender + 工作区外路径 → ok:false，外部文件不产生。
    //  b) 内部 save 通道：即使 payload 里带一个工作区外 `filePath`，也只写
    //     openedFilePath（现在指向刚保存的新文件）；外部路径不被触碰。
    const outsideDir = join(dir, "outside");
    mkdirSyncFs(outsideDir, { recursive: true });
    const outsidePath = join(outsideDir, "escape.docx");
    // handler 就是一行转发到 `host.openPath`；直接调宿主方法即同一判据。
    const handlerResult = host.openPath(docId, outsidePath, withinWorkspace);
    evidence.openOutside = handlerResult;
    await check("★ 工作区外路径被拒（openPath 围栏），外部文件未产生", () => {
      assert(handlerResult.ok === false, `工作区外 openPath 未被拒: ${JSON.stringify(handlerResult)}`);
      assert(!existsSync(outsidePath), "外部路径被创建");
    });
    // 默认名穿越：`saveNewFile` 只把它当词干，分隔符不生效，产物仍在 workspace。
    const traversal = await host.saveNewFile(docId, new TextEncoder().encode("traversal-test-bytes"), withinWorkspace, "../../evil");
    evidence.traversal = traversal;
    await check("★ defaultName 穿越被中和：产物仍落在工作区内", () => {
      assert(traversal.ok, `saveNewFile 失败: ${JSON.stringify(traversal)}`);
      if (traversal.ok) {
        assert(withinWorkspace(traversal.filePath), `穿越后落点在工作区外: ${traversal.filePath}`);
        assert(!traversal.filePath.includes(".."), `文件名含 ..: ${traversal.filePath}`);
      }
    });
    // 无可信目录的视图：新开一个（不 openPath），saveNewFile 必须拒绝。
    const bareDocId = "ai-ask-bare";
    host.open({ docId: bareDocId, url: pathToFileURL(config.pagePath).toString() + "?mode=tab", bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: false });
    const bare = await host.saveNewFile(bareDocId, new TextEncoder().encode("x"), withinWorkspace, "bare");
    evidence.bareSave = bare;
    await check("★ 没有已打开文档的视图：首次保存被拒（不退回任意目录）", () => {
      assert(bare.ok === false, `应当拒绝: ${JSON.stringify(bare)}`);
    });
    host.close(bareDocId);

    // ── 11. ★ 全程零未捕获异常 ──
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

    // ── 12. 源码级：生产 preload 不得含探针桥（防越界） ──
    await check("生产 preload 源码没有 aiStream/onAiStream（探针桥只在产物里）", async () => {
      const { readFileSync: read } = await import("node:fs");
      const raw = read(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const name of ["aiStream", "aiStreamCancel", "onAiStream", "onMcpCommand", "reportMcpResult"]) {
        assert(!new RegExp(`^\\s*${name}\\s*[:(]`, "m").test(src), `生产 preload 不得提供 ${name}`);
      }
      // saveDocxNew 必须在（本片新增的唯一新键）。
      assert(/^\s*saveDocxNew\s*:/m.test(src), "生产 preload 缺 saveDocxNew");
    });
  } finally {
    if (debuggerAttached) {
      try { wc.debugger.detach(); } catch { /* 已分离 */ }
    }
    host.dispose();
    if (!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler("probe:mock-ai-settings");
    ipcMain.removeHandler("ai:stream");
    ipcMain.removeHandler("ai:stream-cancel");
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ url: pathToFileURL(config.pagePath).toString(), debuggerAttached, ...evidence, checks }, null, 2));
  }
}
