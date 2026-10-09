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
 * ## 首轮环境块
 * 网页模型没有 claude 的原生工具感知,它需要知道"我有 agent_* 工具、cwd 在哪、
 * `@路径` 挂载要自己读"。这份说明由 {@link buildWebEnvBlock} 生成,**只在该
 * sessionKey 的第一条消息前拼接一次**(cwd 变了才重注 —— 对应"系统提示词第一次
 * 对话告诉他,之后不要再说"的取舍:网页对话里反复贴同一段说明既费 token 也惹眼)。
 * 注入状态按 sessionKey 记,而 cwd 按 mcode 会话查({@link WebEnvProvider},由
 * `main/index.ts` 注入 —— 本文件不能碰 db/electron)。
 *
 * ## 一期限制(明确列出,避免被当成 bug)
 *  - 网页模型的工具能力 = 扩展侧工具循环 + `/mcp` 工具表(见 webToolHost.ts)。
 *    claude 的原生工具(Read/Bash 等)对它不可见,它要走 `agent_*` 那组等价物;
 *  - 扩展没开 / 没配对 → 等一段宽限期再报错（见 extensionBridge.runPrompt）；
 *  - 多轮上下文由扩展侧维护，mcode 重启不影响，但**换浏览器**会重来。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { webSiteLabel, webSiteById, webSiteDriven } from "@contracts/customModel";
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

/* ───────────────────────── 环境块(首轮注入) ───────────────────────── */

/**
 * 会话环境的来源 —— 由 `main/index.ts` 注入(仿 `configureMcpToolHost` 的模式:
 * 本文件刻意不 import db/claude 链,无头 smoke 才能直接驱动 handleWebMessages)。
 */
export interface WebEnvProvider {
  /** mcode 会话 id → 工作目录。拿不到给 null(那时不注入环境块)。 */
  cwdFor(sessionId: string): string | null;
}

let webEnvProvider: WebEnvProvider | null = null;

/** 注入环境来源。不注入(或注入晚于第一条请求)就没有环境块 —— 纯对话照常工作。 */
export function configureWebEnvProvider(provider: WebEnvProvider): void {
  webEnvProvider = provider;
}

/** sessionKey → 上次已注入的 cwd。值相等就不重注;变了(用户换了项目)才重发一份。 */
const injectedCwdByKey = new Map<string, string>();

/**
 * 首轮发给网页模型的操作说明。
 *
 * 写给**模型**看,不是写给人看 —— 所以每条都是动作指令而不是产品介绍。要点:
 * 有哪些工具、`@路径` 挂载只是占位要自己读、技能怎么用、被拒绝后该怎么办。
 */
function buildWebEnvBlock(cwd: string): string {
  return [
    "[环境说明 —— 以下是给你的操作指引,不必向用户复述]",
    `- 当前工作目录:${cwd}。所有相对路径都以它为基准。`,
    "- 你可以通过工具调用操作这台机器,工具名以 agent_ 开头:agent_read_file 读文件(支持 offset/limit 分片,按行号返回)、agent_write_file 写文件(可 append 追加)、agent_edit_file 精确替换编辑(old_string 必须逐字匹配)、agent_list_dir 列目录、agent_glob 按文件名模式查找(如 src/**/*.ts)、agent_grep 按内容搜索、agent_bash 执行命令行(默认 120 秒超时)、agent_skill_list 列出可用的技能、agent_skill_read 读取某个技能的说明文档。",
    "- 用户消息里形如 `@路径` 的挂载(资料库条目:文件/论文/笔记/模版等,由用户自定义分类)只是路径提示,内容不会自动附上 —— 需要内容时用 agent_read_file 自己读,mdPath/pdfPath 等字段里的路径同理。",
    "- 用户提到某个技能时,先用 agent_skill_list 确认存在,再用 agent_skill_read 读它的说明文档,然后照着里面的步骤做。",
    "- agent_write_file / agent_edit_file / agent_bash 这类有副作用的调用会先征求用户批准;用户拒绝了就停下来问清楚,不要换个说法重试同一个动作。",
  ].join("\n");
}

/**
 * 这一轮要不要拼环境块?**只算不记** —— 记在回合真的把话发出去之后(见
 * {@link markWebEnvInjected})。
 *
 * ⚠️ **从前是"算的时候就记"**,那是一个会永久吞掉环境块的 bug:第一轮里最常见的一种
 * 失败恰恰是"扩展还没连上"(`runPrompt` 当场抛),而那时 cwd 已经被记成"已注入"。
 * 用户装好扩展、重试之后,同一个会话的第二轮 `injectedCwdByKey.get(key) === cwd` 为
 * 真,于是**再也不注入** —— 网页模型这一整条会话都拿不到"工作目录在哪、有哪些
 * agent_* 工具",而它没有任何办法自己发现。判据必须是"这一轮**真的发出去了**",
 * 不是"这一轮**试过要发**"。
 *
 * 只有**有正文要发**时才调用 —— 否则一次空正文失败的请求也会把 cwd 记成已注入。
 * cwd 取不到(没有会话头 / 会话查不到项目)直接跳过。
 */
function webEnvBlockFor(
  sessionKey: string,
  mcodeSessionId: string | null,
): { block: string; sessionKey: string; cwd: string } | null {
  const provider = webEnvProvider;
  if (!provider || !mcodeSessionId) return null;
  let cwd: string | null = null;
  try {
    cwd = provider.cwdFor(mcodeSessionId);
  } catch (err) {
    // 环境信息拿不到不该拦住对话本身 —— 记日志,当没注入。
    log.warn(`web upstream: cwdFor(${mcodeSessionId}) 失败,跳过环境块:${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!cwd) return null;
  if (injectedCwdByKey.get(sessionKey) === cwd) return null;
  return { block: buildWebEnvBlock(cwd), sessionKey, cwd };
}

/** 这一轮**真的把话发出去了** → 记下"这个会话的这个 cwd 已注过环境块"。 */
function markWebEnvInjected(sessionKey: string, cwd: string): void {
  injectedCwdByKey.set(sessionKey, cwd);
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
  // 站点在目录里、但浏览器扩展还没实现它的驱动（见 WebSite.driver）。这时**不能**
  // 往下走：那会把问题交给扩展，而扩展那边的站点白名单会拒掉它、回一句和站点无关
  // 的错。在 mcode 这一侧就说清楚"去哪补"，用户才知道该做什么。
  if (!webSiteDriven(siteId)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      `浏览器扩展还不支持驱动「${webSiteLabel(siteId)}」网页版：` +
        `请在扩展里补上该站点的驱动，或改用其它站点。`,
    );
    return;
  }

  const prompt = promptFromAnthropicRequest(body);
  // 环境块只在有正文要发时才算(见 webEnvBlockFor 的说明),拼在用户消息之前。
  // **算与记分开**:这里只算,`markWebEnvInjected` 等回合真发出去之后才记 —— 否则
  // 第一轮「扩展没连上」的失败会把 cwd 记成已注入,这条会话再也拿不到环境块。
  const env = prompt ? webEnvBlockFor(sessionKeyOf(body), mcodeSessionId) : null;
  const fullText = env ? `${env.block}\n\n${prompt}` : prompt;
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
  //
  // ⚠️ 盯的是 **res** 的 close，不是 req 的。本函数跑起来时请求体已经被
  // `bridgeServer.handleMessages` 读完（readJsonBody），而 IncomingMessage 的
  // `close` 是**请求流结束**时触发、与响应侧断连无关 —— 挂在 req 上等于**永不触发**：
  // 用户点停止后页面上那一轮照常在跑（连同它调出去的工具），扩展收不到 abort。
  // 与 `bridgeServer` 里那条同义路径一致：res 的 close + writableEnded 守卫
  // （正常收尾时 res 自己 end，close 紧随其后，那个守卫把这次排除掉）。
  const ac = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  let produced = false;
  /** 失败原因。流式当场写进流里，非流式留到收尾时定 HTTP 状态。 */
  let failure: string | null = null;
  try {
    if (!prompt) throw new Error("这一轮没有可发送的用户消息");

    await runPrompt({
      sessionKey: sessionKeyOf(body),
      sessionId: mcodeSessionId ?? undefined,
      siteId,
      text: fullText,
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

    // 回合真的走完了才把"已注入"记下(见 webEnvBlockFor 的文件头)。失败路径
    // (最常见的:扩展还没连上)不记 —— 否则用户装好扩展重试时环境块已经被吞掉了。
    if (env) markWebEnvInjected(env.sessionKey, env.cwd);

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