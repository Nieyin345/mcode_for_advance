/**
 * 【Office 深度集成】**普通对话借用文档编辑器执行工具** —— 让 50 个
 * `editor-only` 工具在"用户只是开着一个文档、在聊天里让 AI 改它"时也能用。
 *
 * ## 它修的是什么
 *
 * `document_tool_call` 取渲染端能力的唯一入口是 `activeRendererBindingFor(filePath)`，
 * 而那张登记簿**只在文档视图自己发起一轮 AI 请求时**才有条目
 *（`withRendererToolRegistry` 包在 `docsAiPorts.run` 外面）。
 *
 * 于是出现一个自相矛盾的现状：
 *
 *   - 用户在**编辑器里**点 AI 面板 → 有一轮文档 AI 请求 → 50 个 editor-only 工具可用；
 *   - 用户在**聊天区**让 AI 改这个文档 → 没有任何文档 AI 请求 → 绑定为空 →
 *     这 50 个工具全部回「需要先打开这个文档」，而文档明明就开着。
 *
 * 后者正是用户最常走的路径（「在对话里让它改文档」）。**功能搬过来了，却用不上** ——
 * 这是本项目反复出现的形态：能力存在，但入口与实际使用路径不重合。
 *
 * ## 为什么不能直接把登记簿放宽
 *
 * 登记簿里的 `invoke` 是**请求级**的：它携带那一轮 `ai:stream` 声明的工具定义，
 * `nativeEditorToolTransport` 会做 requestId/callId/重复/超时校验。没有一个正在
 * 跑的请求，就没有那些校验赖以存在的上下文。放宽登记簿 = 绕过那套校验。
 *
 * ## 所以另开一条**宿主签名**的派发通道
 *
 * 本模块只做三件事：
 *   1. 记住"哪些 docId 的编辑器页现在开着、且它的 webContents 是活的"；
 *   2. 把一次工具调用打包成**宿主签发**的请求（带 nonce、过期时间、单次有效），
 *      经该 webContents 的专用通道发给页面；
 *   3. 等页面回执，按 callId 配对，超时/重复/未知 callId 一律拒绝。
 *
 * **它与请求级通道的区别**（也是它为什么不能替代后者）：
 *
 * | | 请求级（`nativeEditorToolTransport`） | 本通道 |
 * |---|---|---|
 * | 工具定义 | 取自那一轮 `ai:stream` 声明，页面自己认 | 宿主随请求下发，页面按名执行 |
 * | 生命周期 | 随请求结束失效 | 每次调用单次有效（nonce + TTL） |
 * | 谁批准 | 该轮 AI 请求的用户确认 | 走 Mcode 既有的工具审批（`ApprovalBridge`） |
 *
 * 也就是说：**审批不在这里做**。审批发生在调用方（Mcode 的 `document_tool_call`）
 * 进入本模块之前；本模块只保证"这次调用确实来自宿主、只执行一次、且只发给它声称
 * 的那个已打开文档"。
 *
 * ## 安全边界
 *
 *   - 只向**已登记的 docId** 派发（没开着的文档不可能被这条通道碰到）；
 *   - 每个请求带一次性 nonce 与 TTL，过期即拒；
 *   - 同一 callId 只接受一次回执（重复回执按拒绝处理，不覆盖首次结果）；
 *   - 页面回执必须带同一个 nonce；不匹配即丢弃（防止旧回执串到新请求上）；
 *   - 页面不可用 / 已销毁 / 超时 → **显式失败**，绝不返回一个"看起来成功"的空结果。
 */
import { randomUUID } from "node:crypto";
import { log } from "@main/lib/logger.js";

/** 一个已登记、可接收工具调用的文档编辑器页。 */
interface RegisteredRenderer {
  docId: string;
  /** 派发通道：主进程 → 页面。 */
  send(request: RendererToolRequest): void;
  /** 该 webContents 是否还活着（销毁后不能再派发）。 */
  isAlive(): boolean;
}

/** 宿主 → 页面的工具调用请求。**全部字段由宿主填写**，页面不能自报。 */
export interface RendererToolRequest {
  /** 一次性标识；回执必须带回同一个值。 */
  nonce: string;
  /** 工具调用 id（与 Mcode 工具层同源，用于与回执配对）。 */
  callId: string;
  /** 工具名。页面按名在它自己的工具表里找实现。 */
  name: string;
  /** 工具入参（JSON 对象，已由调用方校验过大小与可序列化）。 */
  input: Record<string, unknown>;
  /** 超时时刻（`Date.now()` 毫秒）；页面可据此提前放弃。 */
  expiresAt: number;
}

/** 页面 → 宿主的回执。 */
export interface RendererToolReply {
  nonce: string;
  callId: string;
  status: "ok" | "error" | "cancelled";
  output?: string;
}

/** 单次调用的默认超时。取 30 s：编辑类工具要遍历文档结构，但不该挂住一轮对话。 */
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingCall {
  nonce: string;
  resolve(reply: RendererToolReply): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RendererToolDispatch {
  private readonly renderers = new Map<string, RegisteredRenderer>();
  private readonly pending = new Map<string, PendingCall>();
  private pathResolver: ((filePath: string) => string | null) | null = null;

  /** 登记一个已打开的编辑器页。同一 docId 重复登记 = 覆盖（重开视图）。 */
  register(renderer: RegisteredRenderer): void {
    this.renderers.set(renderer.docId, renderer);
  }

  /** 视图关闭时摘掉。**必须调用**：否则会向已销毁的 webContents 派发。 */
  unregister(docId: string): void {
    this.renderers.delete(docId);
    // 该视图上所有在飞的调用：回执永远不会来，立即以"取消"结束，
    // 而不是让调用方干等到 30 秒超时。
    for (const [callId, call] of [...this.pending]) {
      if (!call.nonce.startsWith(`${docId}:`)) continue;
      clearTimeout(call.timer);
      this.pending.delete(callId);
      call.resolve({
        nonce: call.nonce,
        callId,
        status: "cancelled",
        output: "这个文档的编辑器页已关闭，调用被取消",
      });
    }
  }

  /** 当前是否有可派发的编辑器页（`document_tool_call` 据此决定走不走这条路）。 */
  has(docId: string): boolean {
    const renderer = this.renderers.get(docId);
    return renderer !== undefined && renderer.isAlive();
  }

  /** 已登记的 docId（诊断/测试用）。 */
  docIds(): string[] {
    return [...this.renderers.entries()].filter(([, r]) => r.isAlive()).map(([id]) => id);
  }

  /**
   * 按文件路径找可派发的编辑器页 —— 派发通道不认识路径，只认识 docId；
   * 而调用方（`document_tool_call`）只有路径。装配期通过 {@link setPathResolver}
   * 把宿主那份 `docIdForOpenPath` 交进来，**不在这里 import 宿主**
   * （那会让本模块反向依赖 `documentViewHost`，两者会绑成一个环）。
   */
  resolveDocId(filePath: string): string | null {
    const resolver = this.pathResolver;
    return resolver === null ? null : resolver(filePath);
  }

  /** 装配期登记路径 → docId 的解析器（通常是宿主的 `docIdForOpenPath`）。 */
  setPathResolver(resolver: ((filePath: string) => string | null) | null): void {
    this.pathResolver = resolver;
  }

  /**
   * 派发一次工具调用并等待回执。
   *
   * **失败一律显式**：没有这个文档、页面已销毁、超时、页面回 error —— 各回各的原因，
   * 绝不合并成一句"失败了"，也绝不返回空结果冒充成功。
   */
  async invoke(
    docId: string,
    call: { callId: string; name: string; input: Record<string, unknown> },
    options: { timeoutMs?: number } = {},
  ): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
    const renderer = this.renderers.get(docId);
    if (renderer === undefined) {
      return { ok: false, reason: `文档没有在编辑器里打开（docId=${docId}）；先打开它，或改用不需要编辑器的工具。` };
    }
    if (!renderer.isAlive()) {
      this.renderers.delete(docId);
      return { ok: false, reason: "这个文档的编辑器页已经关闭，无法再执行需要实时上下文的工具。" };
    }
    if (this.pending.has(call.callId)) {
      return { ok: false, reason: `工具调用 id 重复：${call.callId}` };
    }

    const nonce = `${docId}:${randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const request: RendererToolRequest = {
      nonce,
      callId: call.callId,
      name: call.name,
      input: call.input,
      expiresAt: Date.now() + timeoutMs,
    };

    const reply = new Promise<RendererToolReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(call.callId);
        resolve({ nonce, callId: call.callId, status: "cancelled", output: "编辑器在超时前没有回执" });
      }, timeoutMs);
      this.pending.set(call.callId, { nonce, resolve, timer });
    });

    try {
      renderer.send(request);
    } catch (err) {
      const call0 = this.pending.get(call.callId);
      if (call0 !== undefined) {
        clearTimeout(call0.timer);
        this.pending.delete(call.callId);
      }
      return { ok: false, reason: `派发失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const settled = await reply;
    if (settled.nonce !== nonce) {
      // 回执来自另一次请求（例如同一 callId 被复用、或页面回执延迟）。
      // **不接受**：错配的结果比没有结果更危险。
      log.warn(`renderer tool reply nonce mismatch: ${docId} ${call.callId}`);
      return { ok: false, reason: "回执与本次调用不匹配（可能是一次迟到的旧回执）" };
    }
    if (settled.status === "ok") return { ok: true, output: settled.output ?? "" };
    if (settled.status === "cancelled") {
      return { ok: false, reason: settled.output ?? "编辑器取消了这次调用" };
    }
    return { ok: false, reason: settled.output ?? "编辑器执行失败" };
  }

  /**
   * 页面回执入口。返回 `true` 表示认领了这次回执，`false` 表示不认识
   * （未知 callId / nonce 不符 / 已经回过一次）—— 调用方据此记日志，但不该向页面报错。
   */
  acceptReply(reply: RendererToolReply): boolean {
    const call = this.pending.get(reply.callId);
    if (call === undefined) return false;
    if (call.nonce !== reply.nonce) return false;
    clearTimeout(call.timer);
    this.pending.delete(reply.callId);
    call.resolve(reply);
    return true;
  }

  /** 退出/测试用：丢弃全部登记与在飞调用。 */
  reset(): void {
    for (const call of this.pending.values()) clearTimeout(call.timer);
    this.pending.clear();
    this.renderers.clear();
    this.pathResolver = null;
  }
}

/** 生产单例。装配期与 `DocumentViewHost` 同生命周期。 */
export const rendererToolDispatch = new RendererToolDispatch();
