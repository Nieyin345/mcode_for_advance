/**
 * 一个 mcode 会话 ↔ 一个引擎视图的运行时状态。
 *
 * 职责边界：这一层只管"网页那边的事" —— 建视图、探测元素、填字提交、把抓到的
 * 原始数据分帧解析成 `TapEvent`、判断本轮结束。**不认识 RuntimeEvent，也不碰
 * 会话存储**：那些是 provider 与 adapter 的事。这样切分让"网页怎么变"与"mcode
 * 怎么显示"互不污染。
 *
 * ## 多轮靠网页自己维持上下文
 * 同一个 mcode 会话始终复用同一个视图，所以页面的对话上下文（它的
 * `parent_message_id` 链）自然延续 —— 我们每轮只负责填字和提交，不需要自己
 * 维护历史。这也是"新建会话要点一下新对话"的原因（见 SiteAdapter.newChatFirst）。
 *
 * ## 结束判定为什么是"三选一 + 超时"
 * 网页版大多**不发**明确的结束标记（没有 `data: [DONE]`）。所以依次看：站点自报
 * 结束（parser.isEnd）→ 流被关闭（tap 的 close）→ 空闲超时。**空闲超时是常态
 * 而非异常**：它意味着"没有更多字了"，此时已收到的内容完整保留。
 */
import { join } from "node:path";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import type { SiteAdapter } from "./adapters/types.js";
import { buildProbeScript, parseProbeResultSerialized, type ElementProbe } from "./elementResolver.js";
import { parserFor } from "./parsers/index.js";
import type { TapEvent } from "./parsers/types.js";
import { EMPTY_FRAME_STATE, frameSse, type SseFrameState } from "./sseFramer.js";
import { buildTapScriptFor, parseTapPayload } from "./tapScript.js";

/**
 * 引擎视图用的 preload 构建产物。主进程 bundle 落在 `out/main/`、preload 在
 * `out/preload/` —— 与 BrowserManager 取 browserPicker 路径的方式一致。
 */
const ENGINE_PRELOAD_PATH = join(__dirname, "../preload/webAgentTap.mjs");

/** 首字节超时：提交后这么久还没收到任何抓流数据 → 认定网页没响应。 */
const FIRST_BYTE_TIMEOUT_MS = 30_000;
/** 空闲超时：收到过数据后，这么久没有新数据 → 认定本轮说完了。 */
const IDLE_TIMEOUT_MS = 90_000;
/** 等结束信号的轮询间隔。 */
const WAIT_TICK_MS = 200;
/** 视图加载等待上限。 */
const VIEW_LOAD_TIMEOUT_MS = 15_000;
/** 保留几条原始载荷样本 —— 仅用于"抓到流却没解析出内容"时的诊断与校准。 */
const MAX_RAW_SAMPLES = 5;

/** 本轮是怎么结束的。 */
export type TurnOutcome = "ended" | "closed" | "idle" | "no-response";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把探测结果压成一行诊断文案（选择器失配时它是最有用的信息）。 */
export function describeProbe(probe: ElementProbe | null): string {
  if (!probe) return "探测失败（evaluate 报错，或页面返回值形状异常）";
  const d = probe.diagnostics;
  return `textarea ${d.textareas} 个 / contenteditable ${d.contentEditables} 个 / 按钮 ${d.buttons} 个 / 抓流桥 ${
    d.hasBridge ? "就绪" : "缺失"
  }`;
}

/** 在输入框上按回车（合成事件流，React 的 keydown 监听能收到）。 */
function buildEnterScript(selector: string): string {
  return `return (function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: "输入框已消失" };
  try { el.focus(); } catch (e) {}
  var init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true };
})();`;
}

export class EngineSession {
  /** 视图 id；null = 还没建或已关。 */
  private browserId: string | null = null;
  private framer: SseFrameState = EMPTY_FRAME_STATE;
  private unsubTap: (() => void) | null = null;
  private sink: ((events: TapEvent[]) => void) | null = null;
  /** 最近一次收到抓流数据的时间；0 = 本轮还没收到过（首字节超时判定用）。 */
  private lastTapAt = 0;
  private sawClose = false;
  private sawEnd = false;
  private aborted = false;
  private disposed = false;
  /** 注入脚本已就绪 —— 比"视图存在"更强的证据：抓流通道确实通了。 */
  tapReady = false;
  /** 最近一次探测结果（提交前会刷新）。 */
  lastProbe: ElementProbe | null = null;
  /**
   * 本轮的原始载荷样本（前几条）。
   *
   * 只在一件事上有用，但那件事很关键：**站点改版导致一条内容都解析不出来时**，
   * 光看"没内容"无法判断是选择器问题、接口路径问题还是帧格式变了。把这几个样本
   * 打进日志，看一眼就知道该改哪儿（也方便直接写进 parser 的 smoke 断言）。
   */
  private rawSamples: string[] = [];

  constructor(
    readonly sessionId: string,
    private readonly adapter: SiteAdapter,
    private readonly projectPath: string,
  ) {}

  /** 会话中途换了站点（改模型）→ 必须重建视图：不同站点是不同 URL。 */
  needsNewViewFor(next: SiteAdapter): boolean {
    return this.adapter.id !== next.id;
  }

  setSink(sink: ((events: TapEvent[]) => void) | null): void {
    this.sink = sink;
  }

  /**
   * 开一轮：清掉上一轮的残留。
   *
   * 半帧必须清 —— 上一轮最后一段若是半条 JSON，留着会和这一轮的开头拼成一个
   * 看似合法实则错位的帧（表现为"偶尔少一段字"）。
   */
  resetTurn(): void {
    this.framer = EMPTY_FRAME_STATE;
    this.sawClose = false;
    this.sawEnd = false;
    this.lastTapAt = 0;
    this.aborted = false;
    this.rawSamples = [];
  }

  /** 本轮抓到的原始载荷样本（诊断用；可能为空 —— 那说明连流都没抓到）。 */
  rawSampleDump(): string[] {
    return this.rawSamples;
  }

  /** 建好（或复用）引擎视图，并保证抓流通道就绪。 */
  async ensureView(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.browserId && BrowserManager.has(this.browserId)) {
      if (!this.unsubTap) this.subscribeTap();
      return { ok: true };
    }
    this.browserId = null;

    // 注入脚本在 createEngineView 内部、**导航之前**装好 —— 顺序反了就抢不到
    // 页面脚本前（页面会把 fetch 缓存进闭包）。
    const created = await BrowserManager.createEngineView({
      projectPath: this.projectPath,
      url: this.adapter.homeUrl,
      preloadPath: ENGINE_PRELOAD_PATH,
      injectScript: buildTapScriptFor(this.adapter),
    });
    if (!created.ok) return { ok: false, error: created.error };

    this.browserId = created.browserId;
    this.subscribeTap();
    await BrowserManager.waitForLoad(this.browserId, VIEW_LOAD_TIMEOUT_MS);
    return { ok: true };
  }

  private subscribeTap(): void {
    if (!this.browserId) return;
    const id = this.browserId;
    this.unsubTap = BrowserManager.onEngineTap(id, (raw) => this.onTap(raw));
  }

  /** 页面回传的入口：分帧 → 解析 → 交给 sink。 */
  private onTap(raw: unknown): void {
    const payload = parseTapPayload(raw);
    if (!payload) return;
    this.lastTapAt = Date.now();

    if (payload.t === "ready") {
      this.tapReady = true;
      return;
    }
    if (payload.t === "open") {
      // 新的一条流开始：重置分帧器（上一轮的尾巴可能是个半帧）。
      this.framer = EMPTY_FRAME_STATE;
      this.sawClose = false;
      this.sawEnd = false;
      return;
    }
    if (payload.t === "close") {
      this.sawClose = true;
      return;
    }
    if (payload.t === "error") {
      this.sink?.([{ kind: "transport-error", message: payload.message }]);
      return;
    }

    const batch = frameSse(this.framer, payload.text);
    this.framer = batch.state;
    if (batch.done) this.sawEnd = true;
    if (batch.payloads.length === 0) return;

    const parser = parserFor(this.adapter.parser);
    const events: TapEvent[] = [];
    for (const frame of batch.payloads) {
      if (this.rawSamples.length < MAX_RAW_SAMPLES) this.rawSamples.push(frame.slice(0, 300));
      for (const event of parser.parse(frame)) {
        events.push(event);
        if (parser.isEnd?.(event)) this.sawEnd = true;
      }
    }
    if (events.length > 0) this.sink?.(events);
  }

  /** 探测页面元素（每次提交前调一次 —— SPA 转页会重建 DOM，缓存会失效）。 */
  async probe(): Promise<ElementProbe | null> {
    if (!this.browserId) return null;
    const res = await BrowserManager.evaluate(this.browserId, buildProbeScript(this.adapter));
    if (!res.ok) return null;
    // evaluate 返回的是**序列化字符串**，这里要解回来。
    const probe = parseProbeResultSerialized(res.result);
    this.lastProbe = probe;
    return probe;
  }

  /**
   * 站点相同时重新加载页面；站点不同（换了模型）则什么都不做。
   *
   * 用在"用户在**独立的登录窗口**里登完并关掉窗口"之后：cookie 是分区级共享的，
   * 但页面自己的 DOM 还停在未登录态（SPA 不会自己发现），必须重新加载才会进到
   * 已登录界面。注入脚本是 CDP document-start 级别的，随导航自动重跑，不用重装。
   */
  reloadIfSite(next: SiteAdapter): void {
    if (this.adapter.id !== next.id || !this.browserId) return;
    this.tapReady = false;
    this.resetTurn();
    BrowserManager.loadUrl(this.browserId, this.adapter.homeUrl);
  }

  /** 填入并提交。 */
  async submit(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = this.browserId;
    if (!id) return { ok: false, error: "引擎视图不存在" };

    const probe = this.lastProbe ?? (await this.probe());
    if (!probe || !probe.input) {
      return { ok: false, error: `找不到输入框（${describeProbe(probe)}）` };
    }

    // BrowserManager.type 内部就是"原生 value setter + input/change 事件"，
    // 正是绕过 React 受控组件清空输入框的写法，直接复用。
    const typed = await BrowserManager.type(id, probe.input, text);
    if (!typed.ok) return { ok: false, error: `填入输入框失败：${typed.error ?? "未知"}` };

    if (this.adapter.submit === "click" && probe.send) {
      const clicked = await BrowserManager.click(id, probe.send);
      if (clicked.ok) return { ok: true };
      // 点不到就退回落回车（很多站两者都行）。
    }

    const res = await BrowserManager.evaluate(id, buildEnterScript(probe.input));
    if (!res.ok) return { ok: false, error: `提交失败：${res.error ?? "未知"}` };
    return { ok: true };
  }

  /**
   * 中断本轮。
   *
   * 先试点"停止生成"按钮（让网页那边也停下，省流量也避免它继续写）；找不到按钮
   * 就只做本地降级 —— 标记中断并停止向上吐事件，**页面会继续生成但 mcode 忽略**。
   * 这个降级是刻意保留的安全网：没有它，一次选择器失配就会让"停止"按钮彻底失效。
   */
  async abortTurn(): Promise<void> {
    this.aborted = true;
    if (!this.browserId) return;
    try {
      const probe = this.lastProbe ?? (await this.probe());
      if (probe?.stop) await BrowserManager.click(this.browserId, probe.stop);
    } catch {
      /* 点不到就算了，本地降级已生效 */
    }
  }

  /** 本轮是否已被中断。 */
  get isAborted(): boolean {
    return this.aborted;
  }

  /**
   * 等本轮结束。见文件头注释：三选一 + 两级超时。
   */
  async waitForTurnEnd(): Promise<TurnOutcome> {
    const submitAt = Date.now();
    for (;;) {
      if (this.disposed) return "closed";
      if (this.aborted) return "closed";
      if (this.sawEnd) return "ended";
      if (this.sawClose) return "closed";

      const now = Date.now();
      if (this.lastTapAt === 0) {
        if (now - submitAt > FIRST_BYTE_TIMEOUT_MS) return "no-response";
      } else if (now - this.lastTapAt > IDLE_TIMEOUT_MS) {
        return "idle";
      }
      await delay(WAIT_TICK_MS);
    }
  }

  /** 关掉视图、退订抓流。会话删除、应用退出、LRU 淘汰时调用。 */
  dispose(): void {
    this.disposed = true;
    this.unsubTap?.();
    this.unsubTap = null;
    this.sink = null;
    if (this.browserId) {
      BrowserManager.close(this.browserId);
      this.browserId = null;
    }
  }
}