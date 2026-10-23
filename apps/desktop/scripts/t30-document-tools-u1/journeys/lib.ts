/**
 * T30 —— 两条文档旅程共用的装配与取证脚手架。
 *
 * ## 复用边界（不复制产品、不复制 T7）
 *
 * - 视图装配：`t7-genoffice-u1/harness.ts` 的 `assembleHarness`（生产 `DocumentViewHost`
 *   单例 + 真 vendor 视图 + 真 DB 项目行）与 `editor-flow.ts` 的 `editorSetup`
 *   → 本套件只补「文档工具面」那一段：`registerDocumentHandlers`（生产 handler，
 *   与界面/Agent 同一段代码）与 T98 的 `DocsAiPorts`。
 * - 模型：**假 SDK**（不联网、不真模型）。T98 的请求/ACK 通道、渲染端
 *   `AgentSkill.executeTool`、宿主 handler、磁盘读写全是生产代码。
 *
 * ## 为什么 fake 端口是合法的
 *
 * T30 卡明确「不需要真模型」：假的只有 `ports.run`（它模拟「SDK 的回合」并调用
 * T98 交给它的第 4 个参数 `invokeRendererTool`）。请求身份、工具表、ACK 校验、
 * 渲染端执行都不经过我们自造的旁路。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { WebContents } from "electron";

import type { DocsAiChunk, DocsAiPorts, DocsAiRequest } from "@main/document/docsAiPorts.js";
import type { GenOfficeNativeToolDefinition } from "@main/document/nativeEditorToolTransport.js";

/* ───────────────────────── 生产 document.* handler ───────────────────────── */

export type RecordedHandler = (event: unknown, raw: unknown) => unknown;

/**
 * 用生产 `registerDocumentHandlers` 注册到一张**可调用**的表上。
 *
 * 为什么不用真 ipcMain：`document.*` 的 handler 不看 sender（围栏在文件路径上），
 * 而探针需要在**主进程里直接**调用它们并拿到返回值 —— 与 T7 对
 * `documentView:*` 的做法一致。注册的是生产函数本身，不是复刻。
 */
export function installDocumentSurface(repoRoot: string): Map<string, RecordedHandler> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ipcDocument = require("@main/ipc/document.js") as typeof import("@main/ipc/document.js");
  // CLI 解析在无头/探针里必须固定到仓库根：`app.getAppPath()` 在探针里指向 build 目录。
  ipcDocument.configureDocumentRepoRoot(repoRoot);
  const handlers = new Map<string, RecordedHandler>();
  const fakeIpc = {
    handle(channel: string, listener: RecordedHandler): void {
      handlers.set(channel, listener);
    },
  };
  ipcDocument.registerDocumentHandlers(fakeIpc as never);
  return handlers;
}

export async function callSurface<T = unknown>(
  handlers: Map<string, RecordedHandler>,
  channel: string,
  payload: unknown,
): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`T30: 生产 handler 未注册：${channel}`);
  return (await handler({ sender: null }, payload)) as T;
}

/* ───────────────────────── fake SDK 端口 + 可观测状态 ───────────────────────── */

export interface PlannedCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ExecutedCall {
  callId: string;
  name: string;
  status: string;
  output: string;
}

export interface FakeSdkState {
  /** 渲染端真的发起了一轮请求（`ports.run` 被 T98 调到）。 */
  entered: boolean;
  requestId: string | null;
  /** 渲染端在请求里声明的工具名（证明 T98 收到的是页面的工具表）。 */
  declaredTools: string[];
  /** 等旅程放行（让 `document.tool_call` 在绑定活跃期间先跑）。 */
  readonly gate: Promise<void>;
  releaseGate(): void;
  /** `run()` 真正返回（旅程用它证明「本回合已收尾」）。 */
  readonly finished: Promise<void>;
  /** 附加计划：本回合里由 fake 自己发起的调用（默认空 —— 编辑由 `document.tool_call`
   *  驱动，结果是经 T98 ACK 回到本回合的）。 */
  plan: PlannedCall[];
  results: ExecutedCall[];
  error: string | null;
  done: boolean;
}

export interface FakeDocsPorts {
  ports: DocsAiPorts;
  state: FakeSdkState;
}

/**
 * 假 SDK：一轮请求里按 `state.plan` 逐个调用 T98 给的 `invokeRendererTool`，
 * 结果记进 `state.results`（这就是「工具结果带着 requestId/callId 回到宿主」的
 * 宿主侧证据 —— T98 只接受 callId/name/requestId 全部匹配的 ACK）。
 */
export function createFakeDocsPorts(): FakeDocsPorts {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const state: FakeSdkState = {
    entered: false,
    requestId: null,
    declaredTools: [],
    gate,
    releaseGate: () => release(),
    finished,
    plan: [],
    results: [],
    error: null,
    done: false,
  };
  const ports: DocsAiPorts = {
    describe: () => ({ ok: true, provider: "claude-sdk", model: "t30-fake-sdk" }),
    confirm: async () => true,
    async run(request: DocsAiRequest, onChunk: (chunk: DocsAiChunk) => void, _signal: AbortSignal, invokeRendererTool) {
      state.entered = true;
      state.requestId = request.requestId;
      const declared = Array.isArray(request.tools) ? request.tools : [];
      state.declaredTools = declared.map((tool) => (tool as { name?: string }).name ?? "");
      const send = (chunk: Omit<DocsAiChunk, "requestId">): void =>
        onChunk({ requestId: request.requestId, ...chunk });
      try {
        send({ type: "delta", text: "T30 fake SDK: 开始一轮文档工具调用。" });
        await state.gate;
        if (typeof invokeRendererTool !== "function") {
          state.error = "T98 没有把 invokeRendererTool 交给端口";
          send({ type: "error", error: state.error });
          return;
        }
        for (const item of state.plan) {
          const definition = declared
            .map((tool) => tool as GenOfficeNativeToolDefinition)
            .find((tool) => tool.name === item.name);
          if (!definition) {
            state.error = `渲染端请求里没有声明工具 ${item.name}`;
            break;
          }
          const result = await invokeRendererTool(
            { id: item.callId, name: item.name, input: item.input },
            definition,
          );
          state.results.push({ callId: item.callId, name: item.name, status: result.status, output: result.output });
        }
        state.done = true;
        send({ type: "done", stopReason: "end_turn" });
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        send({ type: "error", error: state.error });
      } finally {
        finish();
      }
    },
  };
  return { ports, state };
}

/* ───────────────────────── 渲染端取证助手 ───────────────────────── */

/** 在真实编辑器页里执行一段表达式（与页面自己的桥是同一个作用域）。 */
export async function pageEval<T = unknown>(wc: WebContents, expression: string): Promise<T> {
  return (await wc.executeJavaScript(expression, true)) as T;
}

/** 伪造一次 ACK（负控）：直接调页面自己的 `window.desktop.aiToolResult`。 */
export async function forgeAck(
  wc: WebContents,
  ack: { requestId: string; callId: string; name: string; status?: string; output?: string },
): Promise<unknown> {
  return pageEval(
    wc,
    `window.desktop.aiToolResult(${JSON.stringify({
      requestId: ack.requestId,
      callId: ack.callId,
      name: ack.name,
      status: ack.status ?? "success",
      output: ack.output ?? "forged-by-t30",
    })})`,
  );
}

/* ───────────────────────── 磁盘事实 ───────────────────────── */

export function fileText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}
