/**
 * 网页版上游 —— bridge 的第三种上游类型（`protocol: "web"`）。
 *
 * ## 它把请求送到哪儿
 * 不再送到内嵌浏览器（那条路已拆除，理由见 extensionBridge.ts 文件头），而是交给
 * **用户自己浏览器里的扩展**：mcode 下发 `prompt` → 扩展在真实页面里输入并发送 →
 * 把流式回答回传 → 这里翻译回 Anthropic 流给 claude SDK。
 *
 * 于是"驱动网页"这件事发生在真实 UA / 真实指纹 / 真实登录态之下，mcode 侧只剩一条
 * 本机 HTTP 通道。claude 引擎 → bridge → 流式回渲染这条链**一行没动**。
 *
 * ## 接法：伪造 OpenAI 流，复用现成的翻译器
 * 不新造一套 Anthropic 事件序列，而是产出 `{choices:[{delta:{content}}]}` 这类
 * chunk 喂给 {@link OpenAiToAnthropicSse} —— 它已经把 message_start /
 * content_block_* / message_delta / message_stop 的细节（含思考块与工具块的边界）
 * 处理干净了。少一套要维护的协议实现，就少一类只在真机上才暴露的错位。
 *
 * ## 只发最后一条 user 消息
 * 上下文依赖网页自己维持：同一个 mcode 会话映射到同一个网页对话（`sessionKey`
 * 就是映射键，扩展侧维护）。刻意**不发** claude 的系统提示 —— 它里面写着工具说明，
 * 网页模型会兴冲冲地输出工具调用标记，而 claude 侧收不到对应的 tool_use 块，
 * 用户看到的是"模型宣称要读文件，然后什么都没发生"，比不带系统提示更让人困惑。
 *
 * ## 一期限制（明确列出，避免被当成 bug）
 *  - 网页端是**纯对话**：claude 的工具能力用不上（上游不产出 tool_use）；
 *  - 扩展没开 / 没配对 → 等一段宽限期再报错（见 extensionBridge.runPrompt）；
 *  - 多轮上下文由扩展侧维护，mcode 重启不影响，但**换浏览器**会重来。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { webSiteLabel, webSiteById } from "@contracts/customModel";
import { log } from "@main/lib/logger.js";
import { runPrompt } from "./extensionBridge.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
import type { AnthropicRequest, AnthropicSseEvent, OpenAIChunk, UpstreamConfig } from "./types.js";

function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
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
 * claude 带的 `metadata.user_id`（形如 `user_…_account__session_…`）足以区分 mcode
 * 会话 —— 扩展拿它维护「会话 ↔ 网页对话」映射，两个对话才不互相串上下文。
 * 拿不到就退回单例共享（多个会话共用一页，这是可接受的降级）。
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
 * 回合当作网络故障，用户看到的东西远不如一句"浏览器扩展未连接"清楚。
 */
export async function handleWebMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicRequest,
  upstream: UpstreamConfig,
  /** mcode 的会话 id，来自 `MCODE_SESSION_HEADER`（见 `mcpEndpoint.ts`）。
   *  扩展要拿它去填 `/mcp` 的会话头，否则它调回来的工具调用无从判定属于哪次对话。 */
  mcodeSessionId: string | null,
): Promise<void> {
  const siteId = upstream.webSiteId ?? "";
  if (!webSiteById(siteId)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`网页版配置的站点无效：${webSiteLabel(siteId)}`);
    return;
  }

  const prompt = promptFromAnthropicRequest(body);
  const translator = new OpenAiToAnthropicSse();
  /**
   * 流式还是非流式。claude 在流式那一轮失败之后会补一次**非流式重试**，而这条路
   * 过去一律回 SSE —— 于是它报 "the non-streaming request was answered with a
   * stream"，一句把真正原因（扩展没连上）整个盖掉的错。Anthropic 的非流式约定是
   * 成功回一个 JSON Message、失败回非 2xx + JSON error 体，这里照办。
   */
  const streaming = body.stream !== false;
  /** 非流式要攒出完整正文，所以无论哪条路都累加。 */
  let text = "";
  const feed = (chunk: OpenAIChunk): void => {
    // 非流式不发 SSE：正文靠上面的 text，头也在收尾时才写。
    if (!streaming) return;
    for (const ev of translator.feed(chunk)) writeSseEvent(res, ev);
  };
  const delta = (d: { content?: string; reasoning_content?: string }): void => {
    if (typeof d.content === "string") text += d.content;
    feed({ choices: [{ index: 0, delta: d }] });
  };

  if (streaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }

  // claude 侧断开（用户点了停止）→ 顺带把中断下发给扩展，让它点网页的停止按钮。
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  let produced = false;
  /** 失败原因。流式当场写进流里，非流式留到收尾时定 HTTP 状态。 */
  let failure: string | null = null;
  try {
    if (!prompt) throw new Error("这一轮没有可发送的用户消息");

    await runPrompt({
      sessionKey: sessionKeyOf(body),
      sessionId: mcodeSessionId ?? undefined,
      siteId,
      text: prompt,
      signal: ac.signal,
      handlers: {
        onDelta: (text) => {
          produced = true;
          delta({ content: text });
        },
        onThinking: (text) => {
          produced = true;
          delta({ reasoning_content: text });
        },
        onStatus: (text) => log.info(`web upstream: 扩展状态 ${text}`),
        onConversation: (id) => log.info(`web upstream: 网页侧会话 ${id}`),
      },
    });

    if (!produced) {
      // 回合正常结束了却一个字都没有：站点/扩展侧出问题的第一个信号。
      log.warn("web upstream: 本轮没有回传任何内容（扩展通了但没抓到回答）");
    }

    // 正常收尾：一个带 finish_reason 的空 delta，让翻译器产出 message_delta +
    // message_stop（claude 侧靠它判定 end_turn）。
    feed({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`web upstream failed: ${message}`);
    failure = message;
    if (streaming) {
      // 头已经发出去了，只能流内报错 —— 这是 Anthropic 的流式错误约定。
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
      );
    }
  } finally {
    if (streaming) {
      for (const ev of translator.finish()) writeSseEvent(res, ev);
      res.end();
    } else if (failure) {
      // 非流式的头还没发出去，所以这里能给出**准确的错误**：claude 报的就是这句话，
      // 用户看到"扩展没连上"而不是"malformed response"。
      writeJson(res, 502, { type: "error", error: { type: "api_error", message: failure } });
    } else {
      writeJson(res, 200, {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }
  }
}