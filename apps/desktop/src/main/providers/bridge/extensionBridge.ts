/**
 * 扩展桥 —— 「网页版模型」的真实浏览器通道。
 *
 * ## 它替换掉了什么
 * 上一版里 `protocol: "web"` 由**内嵌 Electron 浏览器 + CDP 注入**驱动：另起一个
 * 浏览器实例、劫持页面内部接口、模拟填框回车。形态上就是爬虫（UA 指纹可疑 +
 * 反向工程内部接口 + 机器节奏），站点风控视角下等同于自动化抓取 —— 用户已明确
 * 否决（"对账号有风险就直接封了"）。
 *
 * 现在改成：**请求由用户自己浏览器里的官方页面发出**，mcode 只当调度方。
 * 驱动网页那一段搬进浏览器扩展（fork 自 DeepSeek++ 的形态），mcode 侧只剩一条
 * 本机 HTTP 通道 —— 就是这个文件。
 *
 * ## 线协议
 * 一条 SSE 长连接 + 一个回合内事件上行，两者都带 `Authorization: Bearer <token>`：
 *
 * | 方向 | 端点 | 内容 |
 * |---|---|---|
 * | 服务端 → 扩展 | `GET /v1/bridge/stream`（SSE，长连接） | `hello` / `prompt` / `abort`，每 15s 一个注释帧心跳 |
 * | 扩展 → 服务端 | `POST /v1/bridge/events` | `delta` / `thinking` / `status` / `conversation` / `done` / `error` |
 *
 * **挂住 SSE 连接即视为「已配对」** —— 不需要握手往返，连接本身就是配对证据。
 * 于是设置页那颗「已连接」徽章就是 `client !== null`，不存在需要维护的配对表。
 *
 * ## 为什么是 127.0.0.1 + 明文令牌
 * 服务只绑回环地址，令牌是**本机共享秘密**而不是可离线爆破的密码，所以
 * ① 允许 `?token=` 形式（EventSource 不能自定义请求头，这是唯一能用的通道）；
 * ② 比较用 `===` 而不是定长比较。CORS 只放行扩展来源（`chrome-extension://` 等），
 * 网页里的脚本因此拿不到这个端口 —— 这是「明文令牌 + 回环」能成立的前提。
 *
 * ## 为什么 token 存储是可注入的
 * 令牌要跨重启稳定（否则 mcode 一起身扩展就静默掉线），所以真实运行存在 settings
 * 表里。但本模块**不能静态 import `SettingRepo`** —— 那条链会拉进 db.ts → electron，
 * 于是无头 smoke 在 node 下直接崩（`upstream-headers-smoke` 吃过同样的教训）。
 * 折中：默认走内存实现，应用启动时由 `main/index.ts` 换成 settings 实现。smoke 因此
 * 能整条链跑起来：起服务 → 拿 `bridgeStatus().token` → 当扩展连上去。
 *
 * ## 限制（一期，写清楚免得被当 bug）
 *  - 扩展没开 / 没配对时，`runPrompt` **立刻报错**而不是挂起等 10 分钟超时；
 *  - 只有一条 SSE 连接（后连的顶掉先连的）：配对是「一台浏览器」的事，
 *    旧连接留着只会遮蔽活的那个；
 *  - 回合进行中扩展掉线 = 该回合立刻失败，不自动续传。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { listenOnDialablePort } from "@main/lib/loopbackPort.js";
import { MCODE_SESSION_HEADER, MCP_ENDPOINT_PATH, handleMcpRequest } from "./mcpEndpoint.js";
import type { ExtensionBridgeStatus } from "@contracts/customModel";

/** 心跳间隔。扩展侧靠它区分"链路还活着但模型没吐字"和"mcode 没了"；
 *  顺带穿透中间设备的空闲超时。 */
const HEARTBEAT_MS = 15_000;

/** 一轮对话的**无数据**容忍度。扩展真在跑的时候会持续回 delta/thinking，所以这
 *  是"多久没听到任何动静就认定卡住"，不是回合总时长上限。 */
const TURN_IDLE_MS = 120_000;

/** 上行事件体的大小上限。事件是纯文本增量，正常远小于此；给个上限只是不让
 *  一个乱写的扩展把内存吃满。 */
const MAX_EVENT_BODY = 1024 * 1024;

/** 令牌在 settings 表里的 key。 */
export const BRIDGE_TOKEN_SETTING_KEY = "web.bridgeToken";

/** 服务端 → 扩展的事件版本。扩展据此判断自己是否还兼容这套线协议。 */
const PROTOCOL_VERSION = 1;

/* ────────────────────────────── 令牌存储 ────────────────────────────── */

/** 令牌读写。默认内存实现；应用启动时由 main/index.ts 注入 settings 实现。 */
export interface BridgeTokenStore {
  get(): string | null;
  set(token: string): void;
}

let tokenStore: BridgeTokenStore = { get: () => null, set: () => {} };

/** 当前令牌的内存缓存。null = 还没读过（见 {@link ensureToken}）。 */
let token: string | null = null;

/** 注入持久化实现（见文件头"为什么 token 存储是可注入的"）。 */
export function configureExtensionBridgeTokenStore(store: BridgeTokenStore): void {
  tokenStore = store;
  // 清掉缓存重新读一次。注入发生在启动早期（一般还没人取过令牌），这一步主要是
  // 兜住"万一在注入前就有人问过状态"——否则那个临时令牌会被永久缓存，而存储里
  // 始终是空的，扩展下次启动就对不上了。
  token = null;
}

/** 取当前令牌，没有就生成并落盘。同步 —— 设置页打开时要立刻显示它。 */
function ensureToken(): string {
  if (token) return token;
  const stored = tokenStore.get()?.trim();
  token = stored && stored.length > 0 ? stored : randomBytes(24).toString("hex");
  if (token !== stored) tokenStore.set(token);
  return token;
}

/* ────────────────────────────── 连接与回合 ────────────────────────────── */

/** 一条挂着 SSE 的扩展连接。同一时刻最多一条。 */
interface Client {
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  pairedAt: number;
}

let client: Client | null = null;

/**
 * 等扩展连上来的人。{@link runPrompt} 在没连接时不立刻放弃，而是挂在这里 —— 见
 * {@link CLIENT_WAIT_MS}。
 */
interface ClientWaiter {
  resolve(arrived: boolean): void;
}

let clientWaiters: ClientWaiter[] = [];

/**
 * **未配对时的宽限期**。扩展跑在 MV3 的 service worker 里，那个 worker 空闲约 30 秒
 * 就被浏览器回收，连人带线一起消失；重连要等下一次它被叫醒（实测空窗 20~30 秒）。
 *
 * 于是"此刻没连上"绝大多数情况等于"再等几秒就连上了"。立刻抛错会把一次可自愈的
 * 抖动变成用户可见的失败，而且会连带触发 claude 侧的非流式重试，报出更难懂的错
 * （"malformed response"）。35 秒足够覆盖一次完整的回收+重连周期。
 */
const CLIENT_WAIT_MS = 35_000;

/** 新连接上台，唤醒所有等待者。 */
function notifyClientAvailable(): void {
  const waiters = clientWaiters;
  clientWaiters = [];
  for (const waiter of waiters) waiter.resolve(true);
}

/** 等一条连接出现；已连上立即返回，超时或被中断返回 false。 */
function waitForClient(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (client) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const entry: ClientWaiter = {
      resolve(arrived) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(arrived);
      },
    };
    const onAbort = (): void => entry.resolve(false);
    const timer = setTimeout(() => {
      const index = clientWaiters.indexOf(entry);
      if (index >= 0) clientWaiters.splice(index, 1);
      entry.resolve(false);
    }, timeoutMs);
    if (signal?.aborted) {
      entry.resolve(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    clientWaiters.push(entry);
  });
}

/** 扩展回传的事件处理口。webUpstream 把 delta/thinking 直接灌进翻译器。 */
export interface PromptHandlers {
  onDelta?(text: string): void;
  onThinking?(text: string): void;
  /** 站点侧的进度提示（"正在思考"之类），只用来重置空闲计时。 */
  onStatus?(text: string): void;
  /** 网页侧会话标识 —— 扩展用它维护「mcode 会话 ↔ 网页对话」映射，本轮可忽略。 */
  onConversation?(conversationId: string): void;
}

/** 一个在飞的回合。 */
interface Turn {
  id: string;
  handlers: PromptHandlers;
  idle: ReturnType<typeof setTimeout>;
  settled: boolean;
  finish(err?: Error): void;
}

const turns = new Map<string, Turn>();

/* ────────────────────────────── 服务生命周期 ────────────────────────────── */

let server: Server | null = null;
let localUrl: string | null = null;
let starting: Promise<void> | null = null;

/** 已配对状态变化的订阅者（设置页徽章靠它刷新）。 */
const bridgeListeners = new Set<() => void>();

/** 订阅配对状态变化；返回退订函数。 */
export function onBridgeChange(cb: () => void): () => void {
  bridgeListeners.add(cb);
  return () => bridgeListeners.delete(cb);
}

function notifyBridgeChange(): void {
  for (const cb of bridgeListeners) {
    try {
      cb();
    } catch {
      // 订阅者坏了不能带着桥一起坏
    }
  }
}

/** 当前状态快照（设置页那一屏）。服务没起时 `url` 为空串。 */
export function bridgeStatus(): ExtensionBridgeStatus {
  return {
    url: localUrl ?? "",
    token: ensureToken(),
    paired: client !== null,
    pairedAt: client?.pairedAt ?? null,
  };
}

/** 换一个令牌，并断开现有连接（旧令牌已经不认了，让扩展拿新令牌重连）。 */
export function regenerateToken(): ExtensionBridgeStatus {
  token = randomBytes(24).toString("hex");
  tokenStore.set(token);
  log.info("extension bridge: token regenerated");
  dropClient("token regenerated");
  return bridgeStatus();
}

/**
 * 优先用的端口。
 *
 * 端口是**要用户手抄进扩展设置里的东西**(扩展那边得知道连哪儿),所以它不能每次都
 * 变 —— 随机端口意味着重启一次就要重配一次,而用户不会知道要重配,只会觉得"连不上了"。
 * 挑的这个号落在私有段里、不撞常见服务(5173/8080 那类)。
 *
 * 被占了就退回随机(`listen(0)`)—— 宁可让用户偶尔重配一次,也不能因为端口冲突就
 * 整个功能起不来。设置页显示的是**实际**监听到的地址(`bridgeStatus().url`),不是这个常量。
 */
const PREFERRED_PORT = 17831;

/**
 * 确保服务在听。幂等 —— 并发调用共用同一个 promise，重复调用不重开端口。
 *
 * 先试 {@link PREFERRED_PORT},占用则回退随机端口（照 `bridgeServer.ts` 的既有做法）。
 */
export async function ensureStarted(): Promise<void> {
  if (server) return;
  if (starting) return starting;
  ensureToken();

  starting = new Promise<void>((resolve, reject) => {
    const srv = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log.error(`extension bridge: handler threw: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "internal bridge error" }));
      });
    });

    const onListening = () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") {
        starting = null;
        reject(new Error("extension bridge: failed to bind"));
        return;
      }
      server = srv;
      localUrl = `http://127.0.0.1:${addr.port}`;
      log.info(`extension bridge: listening on ${localUrl}`);
      resolve();
    };

    // 回退到随机端口时不能只 `listen(0)`：浏览器(扩展那一侧)和 Node 一样执行 fetch
    // 规范的 bad-port 名单，落到名单上的号**扩展一连接就失败**，而这边看不出任何异常。
    // 见 lib/loopbackPort.ts。
    const listenRandom = () => {
      void listenOnDialablePort(srv).then(
        () => onListening(),
        (err: Error) => {
          starting = null;
          log.error(`extension bridge: listen failed: ${err.message}`);
          reject(err);
        },
      );
    };

    let fellBack = false;
    srv.on("error", (err) => {
      // 只在**第一次**、且确实是"端口被占"时回退；回退之后再失败就是真起不来了。
      if (!fellBack && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        fellBack = true;
        log.info(`extension bridge: port ${PREFERRED_PORT} is taken, using a random one`);
        listenRandom();
        return;
      }
      starting = null;
      log.error(`extension bridge: listen failed: ${err.message}`);
      reject(err);
    });
    srv.listen(PREFERRED_PORT, "127.0.0.1", onListening);
  });

  return starting;
}

/** 停机：结束在飞回合、断开扩展、关掉服务。应用退出时调用。 */
export function stopExtensionBridge(): void {
  for (const id of [...turns.keys()]) {
    turns.get(id)?.finish(new Error("mcode 正在退出"));
  }
  dropClient("bridge stopping");
  const srv = server;
  server = null;
  localUrl = null;
  starting = null;
  if (srv) srv.close(() => log.info("extension bridge: closed"));
}

/* ────────────────────────────── 下行（prompt / abort） ────────────────────────────── */

function writeEvent(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function dropClient(why: string): void {
  const c = client;
  if (!c) return;
  client = null;
  clearInterval(c.heartbeat);
  try {
    c.res.end();
  } catch {
    // 对端可能已经走了
  }
  log.info(`extension bridge: extension disconnected (${why})`);
  notifyBridgeChange();
}

/** 一条命中的回合：把 `prompt` 写下去，等扩展回事件。 */
export interface RunPromptOptions {
  /** mcode 会话标识 —— 扩展据此维护「会话 ↔ 网页对话」映射。 */
  sessionKey: string;
  /**
   * mcode 的**会话 id**（与 `sessionKey` 不是一回事，见 `mcpEndpoint.ts` 的
   * `MCODE_SESSION_HEADER`）。
   *
   * `sessionKey` 只够扩展自己分清"哪一页对应哪个对话"；而网页端要调 mcode 的工具时，
   * 工具调用会带着会话 id 回来走审批闸门 —— 闸门是按会话记的（权限模式、「始终允许」），
   * 所以扩展必须知道**真正**的那个 id。它从这条事件里学到，回头填进 `/mcp` 的请求头。
   *
   * 拿不到（老配置/理论上没有会话的路径）就是空 —— 那时工具调用会被明确拒掉，
   * 而不是挂到一个猜出来的会话上。
   */
  sessionId?: string;
  /** 站点 id（见 contracts 的 WEB_SITES）。 */
  siteId: string;
  /** 本轮要问的话（只发最后一条 user 消息，上下文靠网页自己维持）。 */
  text: string;
  handlers?: PromptHandlers;
  /** 触发即向扩展下发 `abort` 并立刻结束本轮。 */
  signal?: AbortSignal;
}

/**
 * 发起一轮网页版对话，等扩展把回答回完。
 *
 * **未配对时最多等 {@link CLIENT_WAIT_MS} 再抛错**（理由见那个常量）—— 挂起的上界是
 * 明确的，所以故障原因依然可见，只是把"扩展正在重连"这段抖动吸收掉了。
 */
export async function runPrompt(opts: RunPromptOptions): Promise<void> {
  await ensureStarted();
  if (!client && !(await waitForClient(CLIENT_WAIT_MS, opts.signal))) {
    throw new Error(
      "浏览器扩展未连接：请在浏览器里安装并启用 Mcode 扩展桥，并在「设置 → 模型配置 → 网页端」填入桥地址与令牌。",
    );
  }

  const id = randomUUID();
  const handlers = opts.handlers ?? {};

  return new Promise<void>((resolve, reject) => {
    const turn: Turn = {
      id,
      handlers,
      idle: setTimeout(() => {
        turn.finish(new Error("扩展已连接但长时间没有任何数据回传，本轮已中断。"));
      }, TURN_IDLE_MS),
      settled: false,
      finish(err) {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(turn.idle);
        turns.delete(id);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      },
    };
    const onAbort = (): void => {
      writeAbort(id);
      turn.finish(new Error("本轮已中断"));
    };

    turns.set(id, turn);
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // 现取而不是用宽限期之前捕获的那条：等待期间可能正好有一次"旧的断、新的连"，
    // 用旧连接写等于往一个已经关掉的响应里发数据。
    const target = client;
    if (!target) {
      turn.finish(new Error("浏览器扩展连接已断开，本轮已中断。"));
      return;
    }
    try {
      writeEvent(target.res, {
        type: "prompt",
        turnId: id,
        sessionKey: opts.sessionKey,
        // 扩展要拿它去填 `/mcp` 的会话头，见 RunPromptOptions.sessionId。
        sessionId: opts.sessionId ?? "",
        siteId: opts.siteId,
        text: opts.text,
      });
    } catch (err) {
      turn.finish(new Error(`无法把消息发给浏览器扩展：${(err as Error).message}`));
    }
  });
}

/** 向扩展下发中断（找不到对应连接/回合就当无事发生）。 */
export function abortTurn(turnId: string): void {
  writeAbort(turnId);
  turns.get(turnId)?.finish(new Error("本轮已中断"));
}

function writeAbort(turnId: string): void {
  if (!client) return;
  try {
    writeEvent(client.res, { type: "abort", turnId });
  } catch {
    // 写失败说明链路已断，dropClient 那条路会收拾
  }
}

/* ────────────────────────────── HTTP 路由 ────────────────────────────── */

const EXTENSION_ORIGIN_RE = /^(?:chrome|moz|safari-web)-extension:\/\//i;

/** 只放行扩展来源；没有 Origin 的调用方（node 脚本 / 无头 smoke / curl）也放行，
 *  但它们照样要过令牌。其余一律 403 —— 网页脚本是最需要挡住的那一类。 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  return EXTENSION_ORIGIN_RE.test(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // 后两样是 `/mcp` 那条路要的:标准 MCP 客户端会带协议版本与（服务端给了才有的）
  // 会话 id,而浏览器只有在预检里见过这两个名字才肯把它们发出去。
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, ${MCODE_SESSION_HEADER}`,
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // 预检要能看见这两个头,否则 `/mcp` 的响应头在扩展里读不到。
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "600");
}

/** 取请求里的令牌。EventSource 不能自定义请求头，所以 `?token=` 是必需的第二条路。 */
function presentedToken(req: IncomingMessage, url: URL): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return (url.searchParams.get("token") ?? "").trim();
}

function authorize(req: IncomingMessage, url: URL): boolean {
  const got = presentedToken(req, url);
  return got.length > 0 && got === ensureToken();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!originAllowed(req)) {
    json(res, 403, { error: "origin not allowed" });
    return;
  }
  if (!authorize(req, url)) {
    json(res, 401, { error: "invalid bridge token" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/bridge/stream") {
    openStream(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/bridge/events") {
    await handleEvents(req, res);
    return;
  }
  // MCP 端点与桥**同一个服务、同一个令牌**(见 mcpEndpoint.ts 文件头:用户已经为这一套
  // 配过一次地址和令牌了,不该为了同一个扩展再配第二遍)。
  if (url.pathname === MCP_ENDPOINT_PATH) {
    await handleMcpRequest(req, res);
    return;
  }
  json(res, 404, { error: "not found" });
}

/** 扩展连上来：注册为当前连接，下发 `hello`，之后靠心跳维持。 */
function openStream(req: IncomingMessage, res: ServerResponse): void {
  // 后连的顶掉先连的：配对是"一台浏览器"的事，留着旧连接只会遮蔽活的那个
  // （典型场景：用户在设置里改了地址，旧标签页的连接还没断）。
  if (client) dropClient("replaced by a newer connection");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // 关掉 nginx 式缓冲的通用写法；本机回环用不上，但无害且省一类"为什么流不动"的排查。
    "X-Accel-Buffering": "no",
  });
  const pairedAt = Date.now();
  const heartbeat = setInterval(() => {
    // 注释帧：SSE 里被解析器忽略，只用来证明链路还在。
    try {
      res.write(": ping\n\n");
    } catch {
      // 写失败由下面的 close 收拾
    }
  }, HEARTBEAT_MS);
  client = { res, heartbeat, pairedAt };
  // 叫醒还在宽限期里等的回合 —— 它们等的就是这个。
  notifyClientAvailable();
  log.info("extension bridge: extension paired");
  notifyBridgeChange();

  writeEvent(res, { type: "hello", protocol: PROTOCOL_VERSION, bridgeUrl: localUrl });

  // 扩展侧断了 → 收摊，并且在飞的回合一并失败（否则它会空等到 TURN_IDLE_MS）。
  const onClose = (): void => {
    if (client?.res !== res) return;
    dropClient("connection closed");
    for (const id of [...turns.keys()]) {
      turns.get(id)?.finish(new Error("浏览器扩展连接已断开，本轮已中断。"));
    }
  };
  req.on("close", onClose);
  res.on("close", onClose);
}

/** 上行事件。校验宽松但**必须**是个已知类型 + 带 turnId —— 未知回合当成"迟到
 *  事件"忽略（回合可能刚被中断，不值得让扩展因此重试）。 */
async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    json(res, 400, { error: `invalid request body: ${(err as Error).message}` });
    return;
  }

  const type = typeof body.type === "string" ? body.type : "";
  const turnId = typeof body.turnId === "string" ? body.turnId : "";
  const turn = turnId ? turns.get(turnId) : undefined;
  if (!turn) {
    json(res, 200, { ok: true, ignored: true });
    return;
  }
  // 收到任何东西就说明扩展还活着 —— 重置空闲计时。
  turn.idle.refresh();

  switch (type) {
    case "delta":
      turn.handlers.onDelta?.(asText(body.text));
      break;
    case "thinking":
      turn.handlers.onThinking?.(asText(body.text));
      break;
    case "status":
      turn.handlers.onStatus?.(asText(body.text));
      break;
    case "conversation":
      turn.handlers.onConversation?.(asText(body.conversationId));
      break;
    case "done":
      turn.finish();
      break;
    case "error":
      turn.finish(new Error(asText(body.message) || "网页侧执行失败"));
      break;
    default:
      json(res, 400, { error: `unknown event type: ${type || "(missing)"}` });
      return;
  }
  json(res, 200, { ok: true });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读 JSON 请求体，带大小上限。 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_EVENT_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}