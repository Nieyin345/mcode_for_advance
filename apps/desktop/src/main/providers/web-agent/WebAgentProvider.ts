/**
 * 网页版大模型引擎 —— 把"网页版 LLM"接成 mcode 的一个 provider。
 *
 * 与另外三个引擎（claude-sdk / codex-sdk / pi-sdk）平级：用户在同一个输入框里
 * 提问，UI 用同一套事件流显示流式回答与思考过程，多轮上下文、停止按钮、会话
 * 管理全部照旧。区别只在于"回答从哪来"——不是 API、也不是本地 CLI，而是一个
 * **内嵌浏览器里真实运行的网页**。
 *
 * ## 为什么这样能成立
 * 我们不去伪造请求：页面自己的 JS 正常登录、正常加密、正常发请求，PoW 与风控
 * 都由它处理。我们只是（a）在页面主世界旁听它已经发出的 SSE，把原始文本搬回
 * 主进程解析；（b）替用户往输入框里填字并回车。从服务端看，请求就是真实用户
 * 发出的。
 *
 * ## 已告知用户并获确认的风险
 *  - **违反站点服务条款**（DeepSeek 协议 4.3(3) 禁止反向工程与自动化抓取），
 *    存在封号风险；
 *  - 网页内部接口无版本承诺，**官方发版即可能失效**；
 *  - 因此站点差异全部收敛在 `adapters/`（选择器 + 解析策略）与 `parsers/` 里，
 *    改版时只需改那两处，这个文件不用动。
 *
 * ## 通用性
 * `builtinModels` 由适配器表生成 —— 也就是说 UI 里选择的"模型"其实是一个**站点**。
 * 新增站点 = 在 `adapters/` 加一份配置 + 在 `adapters/index.ts` 注册一行，本文件
 * 一行都不用改。
 */
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderContext,
  StartTurnRequest,
  TurnHandle,
} from "@contracts/provider.js";
import { adapterById, defaultAdapter, listAdapters } from "./adapters/index.js";
import type { SiteAdapter } from "./adapters/types.js";
import { describeProbe, EngineSession } from "./EngineSession.js";
import { WebMessageAdapter } from "./WebMessageAdapter.js";

/**
 * 同时保留几个引擎视图。
 *
 * 每个视图是一个真实的 WebContentsView（外加网页自身的内存占用），不能无限留；
 * 但关掉就意味着那个会话的网页上下文没了（下次发消息对方会重新认识你）。3 个是
 * 在"切来切去的常见用法"和"内存"之间的折中。
 */
const MAX_ENGINE_SESSIONS = 3;

export class WebAgentProvider implements AgentProvider {
  readonly id = "web-agent";
  readonly displayName = "网页版大模型";

  readonly capabilities: ProviderCapabilities = {
    // 一期没有本地工具可批（工具调用是二期），所以不需要审批。
    supportsApproval: false,
    // 网页端的"会话"由页面自己维护，我们没有可靠的 id 可存（见 onProviderSessionId 不调）。
    supportsResume: false,
    supportsStreaming: true,
    supportsMcp: false,
    supportsAskUserQuestion: false,
    // **必须非空**：渲染端的模型下拉对"provider 存在但没有任何模型"会显示
    // "无可用模型"空态。这里的每一项其实是一个**站点**（见 adapters/）。
    builtinModels: listAdapters().map((a) => ({ id: a.id, label: a.label })),
    supportsCustomEndpoint: false,
  };

  /** 会话 id → 运行时状态。 */
  private readonly sessions = new Map<string, EngineSession>();
  /** LRU 顺序（末尾最新）。 */
  private readonly order: string[] = [];

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const adapter = this.resolveAdapter(req.model, ctx);
    const session = this.acquire(req.sessionId, adapter, req.cwd);
    const messages = new WebMessageAdapter(req.sessionId, ctx);
    let finished = false;

    const done = (async () => {
      try {
        const view = await session.ensureView();
        if (!view.ok) throw new Error(view.error);

        // 先接管抓流，再提交 —— 提交后立刻就可能来数据，晚一步会丢掉开头。
        session.setSink((events) => messages.handle(events));

        const probe = await session.probe();
        if (!probe || !probe.input) {
          throw new Error(`在这个网页里找不到输入框（${describeProbe(probe)}）`);
        }
        if (probe.loggedOut) {
          // 需要人来登录：把视图显示出来给明确指引，而不是让人对着转圈猜。
          session.revealToUser();
          throw new Error(
            `需要先登录 ${adapter.label}：已在右侧打开站点页面，登录完成后重新发送即可。`,
          );
        }

        session.resetTurn();
        const sent = await session.submit(req.prompt);
        if (!sent.ok) throw new Error(sent.error);

        const outcome = await session.waitForTurnEnd();

        if (session.isAborted) {
          messages.finish("interrupted");
          return;
        }
        if (outcome === "no-response") {
          throw new Error(
            `${adapter.label} 提交后一直没有返回数据。可能原因：登录已失效、页面改版、或网络问题。`,
          );
        }
        if (!messages.hasContent) {
          // 有流却没内容：要么是空回答，要么站点的帧格式变了（改版的第一个信号）。
          // 把原始载荷样本一起打出来 —— 只写"没内容"的话，拿到日志也不知道该改
          // 选择器、接口路径还是帧解析；有了样本一眼就能定位（这也是校准 parser
          // 的入口，见实施计划 W4）。
          const samples = session.rawSampleDump();
          ctx.log.warn(
            `web-agent: 抓到流但没有任何内容（outcome=${outcome}）` +
              (samples.length > 0
                ? `，载荷样本：\n${samples.join("\n")}`
                : "，且连一条载荷都没抓到（检查适配器的 streamUrlPatterns）"),
          );
        }
        messages.finish("end_turn");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (session.isAborted) {
          messages.finish("interrupted");
        } else {
          ctx.log.error(`web-agent 回合失败：${msg}`);
          ctx.emit({
            type: "error",
            sessionId: req.sessionId,
            message: msg,
            code: "WEB_AGENT_ERROR",
          });
          messages.finish("error");
        }
      } finally {
        session.setSink(null);
        finished = true;
      }
    })();

    return {
      done,
      interrupt: async () => {
        await session.abortTurn();
      },
      isRunning: () => !finished && !session.isAborted,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const adapters = listAdapters();
    if (adapters.length === 0) return { ok: false, error: "未注册任何站点适配器" };
    return { ok: true, version: `${adapters.length} 个站点` };
  }

  /**
   * 应用退出 / 会话删除时清干净所有引擎视图。
   *
   * RuntimeManager 目前只在 dispose 时清自己的东西，所以这个方法由调用方按需
   * 触发（见 providers/index 或 main/index 的退出清理）。
   */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  /* ────────────────────────── 内部 ────────────────────────── */

  /**
   * 按 `req.model` 选站点。
   *
   * 未知 id **回退到默认站点**而不是报错：那个值可能来自旧会话（站点后来被移除）
   * 或 UI 传来的别的东西，而用户此刻要的是"能聊天"，不是"配置正确"。
   */
  private resolveAdapter(model: string | undefined, ctx: ProviderContext): SiteAdapter {
    if (model) {
      const found = adapterById(model);
      if (found) return found;
      ctx.log.warn(`web-agent: 未知站点 id "${model}"，回退到默认站点`);
    }
    return defaultAdapter();
  }

  /** 取（或建）某个 mcode 会话的引擎状态，并维护 LRU。 */
  private acquire(sessionId: string, adapter: SiteAdapter, projectPath: string): EngineSession {
    let session = this.sessions.get(sessionId);
    if (session && session.needsNewViewFor(adapter)) {
      // 会话中途换了站点：不同站点是不同 URL，旧视图留着只会占内存。
      this.dispose(sessionId);
      session = undefined;
    }
    if (!session) {
      session = new EngineSession(sessionId, adapter, projectPath);
      this.sessions.set(sessionId, session);
    }

    const existing = this.order.indexOf(sessionId);
    if (existing >= 0) this.order.splice(existing, 1);
    this.order.push(sessionId);

    while (this.order.length > MAX_ENGINE_SESSIONS) {
      const oldest = this.order[0];
      // 永不淘汰刚在用的那个（会话数上限是 3，正常情况下不会走到这里）。
      if (oldest === undefined || oldest === sessionId) break;
      this.dispose(oldest);
    }
    return session;
  }

  private dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionId);
    }
    const idx = this.order.indexOf(sessionId);
    if (idx >= 0) this.order.splice(idx, 1);
  }
}