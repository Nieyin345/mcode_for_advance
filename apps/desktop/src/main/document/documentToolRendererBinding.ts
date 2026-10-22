/**
 * 【T24】**活动渲染端工具绑定的宿主登记簿** —— 让 `document_tool_call` 在文件真的
 * 开在受信 Docs 视图里、且该视图正有一轮 AI 请求时，复用 **T0 的同一个请求级 ACK
 * 通道**执行原生工具，而不是绕开 sender/session/document/callId 校验自己发 IPC。
 *
 * ## 为什么需要登记簿
 *
 * T0 的 `GenOfficeNativeToolInvoker` 是**请求级**的：它由 vendor `registerDocsAiIpc`
 * 在每次 `ai:stream` 时签发，随请求结束而失效；它同时携带该请求渲染端声明的工具
 * 定义（`request.tools`），T98 端会做 canonical JSON 比对，**不接受宿主自造的
 * schema**。所以工具面只能在「有一轮请求正在跑」时借用这条通道。
 *
 * 本模块包装 `DocsAiPorts.run`：在调用原实现前把 `(sessionId, filePath, requestId,
 * tools, invoker)` 登记进一张**按引用计数**的表，结束后撤销。`document_tool_call`
 * 通过 {@link activeRendererBindingFor} 取绑定 —— 只能拿到宿主签名过的
 * `context.sessionId/filePath`（vendor 边界给的，不是调用方自报），且调用仍走
 * T0 的 invoker（它内部复用 T98 的 requestId/callId/重复/超时校验）。
 *
 * ## 不做什么
 *
 * - 不复制 `createNativeEditorToolBridge` 的任何校验；本模块只**转交**。
 * - 不跨文档借用：binding 的 filePath 与调用方的 filePath 必须逐字（大小写按平台）
 *   一致，否则视为没有绑定。
 * - 失败一律显式：同一文件出现两个同时活跃的请求时拒绝（宁可不用渲染端通道，
 *   也不猜"该用哪一个"）。
 */
import type { DocsAiPorts, DocsAiRequest } from "./docsAiPorts.js";
import type { GenOfficeNativeToolDefinition, GenOfficeNativeToolInvoker } from "./nativeEditorToolTransport.js";

interface ActiveBinding {
  sessionId: string;
  filePath: string;
  requestId: string;
  tools: Map<string, GenOfficeNativeToolDefinition>;
  invoke: GenOfficeNativeToolInvoker;
}

const active = new Map<string, ActiveBinding[]>();

function keyOf(filePath: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? filePath.toLowerCase() : filePath;
}

function definitionsOf(request: DocsAiRequest): Map<string, GenOfficeNativeToolDefinition> {
  const map = new Map<string, GenOfficeNativeToolDefinition>();
  if (!Array.isArray(request.tools)) return map;
  for (const raw of request.tools) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof item.name !== "string" || typeof item.description !== "string"
      || item.inputSchema === null || typeof item.inputSchema !== "object" || Array.isArray(item.inputSchema)) continue;
    map.set(item.name, { name: item.name, description: item.description, inputSchema: item.inputSchema as Record<string, unknown> });
  }
  return map;
}

/** 包装一个 `DocsAiPorts`：`run` 开始时登记渲染端绑定，结束时撤销；其余方法原样转发。 */
export function withRendererToolRegistry(ports: DocsAiPorts): DocsAiPorts {
  return {
    describe: (context) => ports.describe(context),
    confirm: (context, dangerous) => ports.confirm(context, dangerous),
    async run(request, onChunk, signal, invokeRendererTool) {
      if (typeof invokeRendererTool !== "function") return ports.run(request, onChunk, signal);
      const context = request.context;
      const binding: ActiveBinding = {
        sessionId: context.sessionId,
        filePath: context.filePath,
        requestId: request.requestId,
        tools: definitionsOf(request),
        invoke: invokeRendererTool,
      };
      const key = keyOf(context.filePath);
      const list = active.get(key) ?? [];
      list.push(binding);
      active.set(key, list);
      try {
        return await ports.run(request, onChunk, signal, invokeRendererTool);
      } finally {
        const current = active.get(key) ?? [];
        const next = current.filter((item) => item !== binding);
        if (next.length === 0) active.delete(key);
        else active.set(key, next);
      }
    },
  };
}

export type RendererBindingLookup =
  | {
      ok: true;
      /** 该请求绑定的 session（宿主签发，不来自调用方）。 */
      sessionId: string;
      requestId: string;
      /** 转发到 T0 的请求级 invoker（内部复用 T98 的 requestId/callId/重复/超时校验）。 */
      invoke: GenOfficeNativeToolInvoker;
      /** 该请求声明的原始工具定义；null = 渲染端没同意执行这个工具。 */
      definitionOf(tool: string): GenOfficeNativeToolDefinition | null;
    }
  | { ok: false; reason: string };

/**
 * 取某个文件当前活跃的渲染端绑定（文件级）。同一文件有多个同时活跃的请求时
 * **拒绝**（不猜该用哪一个）。绑定的身份是宿主签发的 `context.filePath`，调用方
 * 给的路径只用于匹配，不参与身份判定。
 */
export function activeRendererBindingFor(filePath: string): RendererBindingLookup {
  const list = active.get(keyOf(filePath)) ?? [];
  if (list.length === 0) return { ok: false, reason: "该文件当前没有正在运行的受信文档 AI 请求，渲染端工具通道不可用。" };
  if (list.length > 1) {
    return { ok: false, reason: `该文件同时有 ${list.length} 个活跃的文档 AI 请求，无法确定该借用哪一个渲染端绑定；请等其中一个结束后再试。` };
  }
  const binding = list[0]!;
  return {
    ok: true,
    sessionId: binding.sessionId,
    requestId: binding.requestId,
    invoke: binding.invoke,
    definitionOf: (tool) => binding.tools.get(tool) ?? null,
  };
}

/** 该文件是否有任何活跃绑定（IPC 层用它决定“算不算 rendererOpen”）。 */
export function hasActiveRendererBinding(filePath: string): boolean {
  return (active.get(keyOf(filePath)) ?? []).length > 0;
}

/**
 * 整个登记簿里**恰好只有一个**活跃渲染端请求时返回它；0 个或多个都拒绝。
 *
 * 为什么 agent 侧需要这条：`appMcpTools` 的 `document_*` 工具没有“我正对着哪个
 * 文件”的会话事实（它是普通 Mcode 对话里的工具，不是文档视图里的那轮 AI 请求）。
 * 只有一个文档 AI 请求在跑时，借它是安全的；多开时猜错文件会把改动落到另一份
 * 文档 —— 宁可退回 CLI 路线。
 */
export function soleActiveRendererBinding():
  | {
      ok: true;
      filePath: string;
      invoke: GenOfficeNativeToolInvoker;
      definitionOf: (tool: string) => GenOfficeNativeToolDefinition | null;
    }
  | { ok: false; reason: string } {
  const all: ActiveBinding[] = [];
  for (const list of active.values()) all.push(...list);
  if (all.length === 0) return { ok: false, reason: "当前没有活跃的受信文档 AI 请求，渲染端工具通道不可用。" };
  if (all.length > 1) {
    return { ok: false, reason: `当前有 ${all.length} 个活跃的文档 AI 请求，无法确定该借用哪一个渲染端绑定；请等其中一个结束后再试。` };
  }
  const binding = all[0]!;
  return {
    ok: true,
    filePath: binding.filePath,
    invoke: binding.invoke,
    definitionOf: (tool) => binding.tools.get(tool) ?? null,
  };
}

/** 测试用：清空登记簿（生产不调用）。 */
export function clearRendererToolRegistry(): void {
  active.clear();
}
