/**
 * 网页版上游 —— bridge 的第三种上游类型（`protocol: "web"`）。
 *
 * ## 它为什么存在
 * 「网页版大模型」应该像自定义 API 一样在「设置 → 模型配置」里配置，配好后出现
 * 在模型下拉里 —— 而不是变成第四个引擎。这里就是那条路径的落点：claude 引擎
 * 照常把请求发到本地 bridge，而 bridge **不转发 HTTP**，改为驱动内嵌浏览器里的
 * 网页，再把旁听到的回答翻译回 Anthropic 流给 SDK。
 *
 * ## 接法：伪造 OpenAI 流，复用现成的翻译器
 * 不新造一套 Anthropic 事件序列，而是产出 `{choices:[{delta:{content}}]}` 这类
 * chunk 喂给 {@link OpenAiToAnthropicSse} —— 它已经把 message_start /
 * content_block_* / message_delta / message_stop 的细节（含思考块与工具块的边界）
 * 处理干净了。少一套要维护的协议实现，就少一类只在真机上才暴露的错位。
 *
 * ## 网页的上下文怎么给
 * **只发本轮最后一条 user 消息**，对话上下文依赖网页自己维持（同一个 mcode
 * 会话复用同一个网页视图）。刻意**不发** claude 的系统提示：它里面写着工具说明，
 * 网页模型会兴冲冲地输出工具调用标记，而 claude 侧收不到对应的 tool_use 块 ——
 * 用户看到的是"模型宣称要读文件，然后什么都没发生"，比不带系统提示更让人困惑。
 *
 * ## 登录为什么是一个独立窗口
 * 引擎视图是主窗口的 `WebContentsView`，位置由渲染端下发的 bounds 决定；而用户点
 * 「打开登录窗口」时通常正站在设置页（全屏 overlay）上，视图会被盖住 —— 表现就是
 * "点了没反应"。所以登录改走**独立的操作系统窗口**（`openSiteLoginWindow`）：它和
 * 引擎视图共用同一个浏览器分区，cookie 天然互通，登完关掉窗口即可。
 *
 * ## 一期限制（明确列出，避免被当成 bug）
 *  - 网页端是**纯对话**：claude 的工具能力用不上（上游不产出 tool_use）；
 *  - 视图被 LRU 淘汰或应用重启后，网页那边的上下文会重来（它会"忘记"前文）；
 *  - 违反站点服务条款，官方发版即可能失效（用户已知情确认）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { openSiteLoginWindow } from "@main/browser/BrowserManager.js";
import { log } from "@main/lib/logger.js";
import { adapterById } from "@main/providers/web-agent/adapters/index.js";
import type { SiteAdapter } from "@main/providers/web-agent/adapters/types.js";
import { describeProbe, EngineSession } from "@main/providers/web-agent/EngineSession.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
import type { AnthropicRequest, AnthropicSseEvent, OpenAIChunk, UpstreamConfig } from "./types.js";

/** 同时保留几个网页视图（每个 = 一个 WebContentsView + 页面自身的内存占用）。 */
const MAX_WEB_SESSIONS = 3;

/** 会话 key → 网页驱动状态（顺序表用于 LRU）。 */
const sessions = new Map<string, EngineSession>();
const order: string[] = [];

/** 引擎视图的归属元数据。引擎视图不进浏览列表，所以这个值只影响日志。 */
const ENGINE_PROJECT = homedir();

function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** 从 Anthropic 请求里取出"这一轮要问什么"：最后一条 user 消息的文本。 */
export function promptFromAnthropicRequest(body: AnthropicRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const text = textOfContent(message.content);
    if (text) return text;
  }
  return "";
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * 会话 key。
 *
 * claude 带的 `metadata.user_id`（形如 `user_…_account__session_…`）足以区分
 * mcode 会话 —— 用它给每个会话一个独立网页视图，避免两个对话互相串上下文。
 * 拿不到就退回单例共享（多个会话会共用一页，这是可接受的降级）。
 */
function sessionKeyOf(body: AnthropicRequest): string {
  const userId = body.metadata?.user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : "default";
}

/**
 * 处理一条网页版上游请求。
 *
 * 注意**先写 200 再干活**：一旦响应头出去，失败就只能用流内错误表达（见 catch）。
 * 这是刻意的 —— claude 侧已经在解析这条流了，一个中途的 4xx 反而会让它把整个
 * 回合当作网络故障，用户看到的东西远不如一句"需要先登录"清楚。
 */
export async function handleWebMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicRequest,
  upstream: UpstreamConfig,
): Promise<void> {
  const siteId = upstream.webSiteId ?? "";
  const adapter = adapterById(siteId);
  if (!adapter) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`网页版配置的站点无效：${siteId || "(未选择)"}`);
    return;
  }

  const prompt = promptFromAnthropicRequest(body);
  const translator = new OpenAiToAnthropicSse();
  const feed = (chunk: OpenAIChunk): void => {
    for (const ev of translator.feed(chunk)) writeSseEvent(res, ev);
  };
  const delta = (d: { content?: string; reasoning_content?: string }): void => {
    feed({ choices: [{ index: 0, delta: d }] });
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const session = acquireSession(sessionKeyOf(body), adapter);
  let produced = false;

  try {
    const view = await session.ensureView();
    if (!view.ok) throw new Error(view.error);

    const probe = await session.probe();
    if (probe?.loggedOut) {
      openLoginWindowFor(adapter);
      throw new Error(
        `需要先登录 ${adapter.label}：已弹出一个登录窗口，登录完成后关掉它、重新发送即可（也可在「设置 → 模型配置」里点「打开登录窗口」）。`,
      );
    }
    if (!probe?.input) {
      openLoginWindowFor(adapter);
      throw new Error(
        `在 ${adapter.label} 页面上找不到输入框（${describeProbe(probe)}）。已弹出登录窗口，可先在里面确认站点能正常打开并登录，然后重发。`,
      );
    }

    session.resetTurn();
    session.setSink((events) => {
      for (const event of events) {
        if (event.kind === "text") {
          produced = true;
          delta({ content: event.text });
        } else if (event.kind === "thinking") {
          produced = true;
          delta({ reasoning_content: event.text });
        }
      }
    });

    if (!prompt) throw new Error("这一轮没有可发送的用户消息");
    const sent = await session.submit(prompt);
    if (!sent.ok) throw new Error(sent.error);

    const outcome = await session.waitForTurnEnd();
    if (outcome === "no-response") {
      throw new Error(
        `${adapter.label} 提交后一直没有返回数据。可能登录已失效、页面改版，或网络问题。`,
      );
    }
    if (!produced) {
      // 有流却没内容：站点改版的第一个信号。把原始载荷样本打出来，照样本改
      // parser 即可（这是唯一的校准入口）。
      log.warn(
        `web upstream: 抓到流但没有任何内容（outcome=${outcome}），载荷样本：\n${session.rawSampleDump().join("\n")}`,
      );
    }

    // 正常收尾：一个带 finish_reason 的空 delta，让翻译器产出 message_delta +
    // message_stop（claude 侧靠它判定 end_turn）。
    feed({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`web upstream failed: ${message}`);
    // 头已经发出去了，只能流内报错 —— 这是 Anthropic 的流式错误约定。
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
    );
  } finally {
    session.setSink(null);
    for (const ev of translator.finish()) writeSseEvent(res, ev);
    res.end();
  }
}

/**
 * 让某个站点的登录窗口弹出来（设置页的「打开登录窗口」按钮，以及发消息时发现
 * 未登录的那条路）。
 *
 * 用**独立的操作系统窗口**，不是把引擎视图显形：引擎视图是主窗口的
 * `WebContentsView`，位置由渲染端下发的 bounds 决定，而用户此刻多半正在设置页
 * （全屏 overlay）上 —— 视图会被盖在底下，表现为"点了没反应"。独立窗口没有这个
 * 问题（见 BrowserManager.openSiteLoginWindow）。
 *
 * 不按会话 key 建视图：用户是在"给这个站点登录"，不是在某个对话里；登录态本身
 * 是分区级共享的，登录一次之后所有会话的引擎视图都受益。
 */
export async function revealSiteForLogin(siteId: string): Promise<{ ok: boolean; error?: string }> {
  const adapter = adapterById(siteId);
  if (!adapter) return { ok: false, error: `未知的网页版站点：${siteId}` };
  return openLoginWindowFor(adapter);
}

/**
 * 弹出某个站点的登录窗口，并在窗口关闭后刷新该站点的引擎视图。
 *
 * 刷新是必需的：cookie 跟着分区即时生效，但已经加载过的那一页 DOM 仍停在未登录
 * 态（SPA 不会自己发现），不重载的话下一轮仍然探不到输入框。
 */
function openLoginWindowFor(adapter: SiteAdapter): { ok: boolean; error?: string } {
  return openSiteLoginWindow({
    url: adapter.homeUrl,
    title: `登录 ${adapter.label}`,
    onClosed: () => {
      for (const session of sessions.values()) session.reloadIfSite(adapter);
    },
  });
}

/** 关闭全部网页视图（应用退出时调用，与 BridgeRegistry.disposeAll 一同）。 */
export function disposeWebSessions(): void {
  for (const key of [...sessions.keys()]) disposeSession(key);
}

/* ────────────────────────── 内部 ────────────────────────── */

function acquireSession(key: string, adapter: SiteAdapter): EngineSession {
  let session = sessions.get(key);
  if (session && session.needsNewViewFor(adapter)) {
    // 中途换了站点：不同站点是不同 URL，旧视图留着只会占内存。
    disposeSession(key);
    session = undefined;
  }
  if (!session) {
    session = new EngineSession(key, adapter, ENGINE_PROJECT);
    sessions.set(key, session);
  }

  const idx = order.indexOf(key);
  if (idx >= 0) order.splice(idx, 1);
  order.push(key);
  while (order.length > MAX_WEB_SESSIONS) {
    const oldest = order[0];
    if (oldest === undefined || oldest === key) break;
    disposeSession(oldest);
  }
  return session;
}

function disposeSession(key: string): void {
  const session = sessions.get(key);
  if (session) {
    session.dispose();
    sessions.delete(key);
  }
  const idx = order.indexOf(key);
  if (idx >= 0) order.splice(idx, 1);
}