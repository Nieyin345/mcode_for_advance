/**
 * **公网 MCP 监听器** —— 让互联网上的 ChatGPT 网页端(的云端)直接调 mcode 的工具。
 *
 * ## 它和扩展桥那两个 server 的关系
 *
 * mcode 现在有两处提供工具:进程内的 SDK server(桌面 claude 引擎用)、以及
 * `extensionBridge` 那个回环服务上的 `/mcp`(浏览器扩展用)。这个模块是**第三个**
 * 出口,面向的是一个**不在本机、也不是扩展**的客户端:ChatGPT 的 Connector。
 *
 * ChatGPT 的 Connector 是由 OpenAI 的**云服务器**去连你的 server,不是浏览器连 ——
 * 所以它永远碰不到 `127.0.0.1`。要让它够得着,必须由用户自己架一条公网隧道
 * (cloudflared / ngrok)指到本机某个端口。这个模块就是那个端口。
 *
 * ## 为什么不复用扩展桥那个服务
 *
 * 那个服务的 `originAllowed` 只放行扩展来源(`chrome-extension://` 等),网页来源
 * 一律 403 —— 那**是它的安全边界,不能为了这条路去开口子**(开了等于把扩展桥也暴露
 * 给公网)。所以这里**独立起一个监听器、独立端口**,用独立的鉴权方式。
 *
 * ## 鉴权:密钥藏在路径里
 *
 * ChatGPT 的自定义 Connector **只支持 OAuth,不收 Bearer / API key** —— 所以扩展桥
 * 那套 `Authorization: Bearer <token>` 在这里用不了。但 Connector 的 URL 会**原样
 * 转发**,于是走用户验证过的那条路:密钥塞进路径。
 *
 *     https://<隧道域名>/mcp/<密钥>
 *
 * 密钥不对**一律回 404**,不是 401 —— 401 等于告诉扫描者"这里确实有个端点,只是你没
 * 带对凭证"。404 什么都不透露。比较用 `timingSafeEqual`(常量时间),避免按字节比较
 * 泄漏前缀长度。
 *
 * ## ⚠️ 这条链接等于整台机器的操作权
 *
 * 工具表里包含 `agent_*`(读写文件、跑 bash、杀进程、SSH)。用户明确选择了
 * "全部工具 + 免审批"(见 `PUBLIC_MCP_SETTING_KEY` 那段),所以**没有第二道闸门**:
 * 拿到链接的人 = 完全控制这台机器。安全模型全部压在密钥上。因此:
 *
 *   - 密钥 32 字节随机(256 位),不是可猜的;
 *   - 提供一键重新生成(旧链接立刻失效)—— 这是用户唯一的"拉闸"手段;
 *   - 总开关**默认关**。
 *
 * ## 这个文件是**纯**的
 *
 * 不 import electron、不 import db —— 密钥和会话 id 从哪儿来由
 * {@link configurePublicMcpStore} 注入(与 `extensionBridge` 的
 * `configureExtensionBridgeTokenStore` 同一个套路),工具则由
 * `configureMcpToolHost` 注入(那份是**共享**的,不是这里再建一个)。这样无头 smoke
 * 能把假的注进来,把这条协议逐条断言一遍。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { listenOnDialablePort } from "@main/lib/loopbackPort.js";
// 路径与协议处理都复用扩展桥那份 —— 同一个端点形状、同一份 JSON-RPC 实现。
// `mcpEndpoint.ts` 本身是纯的(它的文件头解释了为什么),所以静态 import 安全。
import { MCP_ENDPOINT_PATH, handleMcpRequest } from "./mcpEndpoint.js";
// 会话头字面量同类:它是跨进程线协议常量,住契约层,不拉 electron。
import { MCODE_SESSION_HEADER, type PublicMcpStatus as ContractPublicMcpStatus } from "@contracts/customModel";

/** 密钥在路径里的位置:`<MCP_ENDPOINT_PATH>/<密钥>`。 */
export const PUBLIC_MCP_PATH_PREFIX = `${MCP_ENDPOINT_PATH}/`;

/** 密钥字节数。32 字节 = 256 位随机,50 字符十六进制。 */
const SECRET_BYTES = 32;

/**
 * 密钥与合成会话的存取口。真实实现在 `main/index.ts` 用 `SettingRepo` 装配
 * (见那边的 `configurePublicMcpStore`);smoke 里注假的。
 *
 * 为什么走注入而不是直接 import:本模块要走无头 smoke,而 `SettingRepo` 那条链会拉到
 * db.ts → electron,一引就把 electron 带进 smoke 进程(同 `extensionBridge` 的理由)。
 */
export interface PublicMcpStore {
  /** 开关是否是开的。缺省(`null`)按关处理。 */
  getEnabled(): boolean;
  setEnabled(on: boolean): void;
  /** 路径里的那把密钥。没有就现生成一个并落盘。 */
  getSecret(): string;
  setSecret(secret: string): void;
  /**
   * 那条"ChatGPT 直连"合成会话的 id。没有时**由调用方**去建会话再把 id 存回来
   * (建会话要碰 db,不是这个纯模块能干的事)。
   */
  getSessionId(): string | null;
  setSessionId(id: string): void;
  /**
   * **固定端口**(0 / 不实现 = 沿用随机端口)。
   *
   * 随机端口对快速隧道是对的(没人需要知道它)。但**命名隧道不行**:ingress 规则
   * 在 Cloudflare 面板里写死 `127.0.0.1:<端口>`,端口每次变就等于那条规则每次都指空。
   */
  getFixedPort?(): number;
  /**
   * **按项目分出来的那几条链接**(多项目并行)。每条有自己的密钥、自己的合成会话、
   * 自己的沙箱根 —— 一个 ChatGPT 对话连一个项目,几条链接可以同时被几个对话用。
   *
   * 不实现 = 只有上面那一条默认链接(这个功能上线前的行为)。这里只返回**密钥 +
   * 项目 id**;会话由 `linkSessionId` 现取 —— 那一步可能要建/修会话(碰 db),
   * 而且只该在密钥比对成功之后做。
   */
  listProjectLinks?(): { projectId: string; secret: string }[];
  /** 某条项目链接的合成会话(没有就建;项目已删 → null)。 */
  linkSessionId?(projectId: string): string | null;
}

let store: PublicMcpStore | null = null;

/** 装配真实存取口 —— 只由 `main/index.ts` 调。传 null 是卸载(smoke 用完还回去)。 */
export function configurePublicMcpStore(next: PublicMcpStore | null): void {
  store = next;
}

/** 现生成一把密钥(不带存储)。密钥的生成方式只有这一处,免得两处漂移。 */
export function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/* ────────────────────────────── 服务生命周期 ────────────────────────────── */

let server: Server | null = null;
let localPort = 0;
let starting: Promise<void> | null = null;
// Incremented by stop so an in-flight listen cannot publish itself after the
// user has disabled the endpoint. Closing `server` alone is insufficient while
// the socket still only exists in startPublicMcp's local variable.
let lifecycleGeneration = 0;

/** 当前监听的端口;没起时 0。*/
export function publicMcpPort(): number {
  return localPort;
}

/**
 * 确保服务在听。幂等 —— 并发调用共用同一个 promise。
 *
 * 端口默认用 `listenOnDialablePort` 随机取:`bind` 到哪不重要,因为**真正的入口是那条
 * 隧道**,用户看到的地址是隧道域名,不是这个端口。
 *
 * **命名隧道那条路要固定端口**(见 {@link PublicMcpStore.getFixedPort}),所以 store
 * 给了非 0 值时就绑它。
 *
 * ⚠️ **固定端口被占用时如实失败,绝不回落到随机端口。** 回落看起来"更健壮",实际是
 * 最坏的一种:服务起来了(UI 显示一切正常),而 Cloudflare 那条 ingress 还指着原来
 * 那个端口 —— 公网访问得到的是连接被拒,用户在 Mcode 这边**看不到任何异常**。
 * 宁可在这里报一句"17331 被占了",那是他三十秒能处理掉的事。
 */
export async function startPublicMcp(): Promise<void> {
  if (server) return;
  if (starting) return starting;
  if (!store) throw new Error("public mcp: store is not configured");

  const generation = lifecycleGeneration;
  const pending = (async () => {
    // 密钥在这里确保存在:服务一起来就得能鉴权,不能等到第一次请求才现生成
    // —— 那样设置页在服务起来之后、第一次请求之前会显示空密钥。
    store!.getSecret();

    const srv = createServer((req, res) => {
      handlePublicRequest(req, res).catch((err) => {
        log.error(`public mcp: handler threw: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });

    try {
      const fixed = store!.getFixedPort?.() ?? 0;
      const port = fixed > 0 ? await listenOnFixedPort(srv, fixed) : await listenOnDialablePort(srv);
      if (generation !== lifecycleGeneration) {
        // stopPublicMcp ran while listen was pending. Do not resurrect a
        // disabled public endpoint when the bind eventually completes.
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        return;
      }
      server = srv;
      localPort = port;
      log.info(`public mcp: listening on 127.0.0.1:${port} (path ${PUBLIC_MCP_PATH_PREFIX}<secret>)`);
    } catch (err) {
      throw err;
    }
  })();
  starting = pending;
  try {
    await pending;
  } finally {
    if (starting === pending) starting = null;
  }
}

/**
 * 绑一个**指定**端口。失败就失败 —— 不换端口、不重试(理由见 `startPublicMcp` 的注释)。
 *
 * `EADDRINUSE` 单独翻译成人话:这是唯一一个用户自己能处理的失败,而 Node 原话
 * (`listen EADDRINUSE: address already in use 127.0.0.1:17331`)不会告诉他该怎么办。
 */
function listenOnFixedPort(srv: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      srv.off("error", onError);
      srv.off("listening", onListening);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      cleanup();
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `端口 ${port} 已被占用,公网 MCP 服务起不来。换一个端口(设置里改),` +
              `或者先把占着它的程序关掉。**没有自动换端口** —— 换了的话 Cloudflare 那条 ingress 就指空了。`,
          ),
        );
        return;
      }
      reject(err);
    };
    const onListening = (): void => {
      cleanup();
      resolve(port);
    };
    srv.once("error", onError);
    srv.once("listening", onListening);
    srv.listen(port, "127.0.0.1");
  });
}

/** 停机。幂等。不跑着的服务调用它无事发生。 */
export function stopPublicMcp(): void {
  lifecycleGeneration++;
  const srv = server;
  server = null;
  localPort = 0;
  starting = null;
  if (srv) {
    srv.close(() => log.info("public mcp: closed"));
  }
}

/* ────────────────────────────── 请求处理 ────────────────────────────── */

/**
 * 从 pathname 里切出密钥段。形状不对给 null(调用方一律按"密钥不对"处理)。
 *
 * 只认 `<MCP_ENDPOINT_PATH>/<单段>`:密钥段里的 `/` 会让 `secretMatches` 的长度检查
 * 落空(含 `/` 的串必然比真密钥长),所以这里**不需要**再单独判 `includes("/")` ——
 * 那是条永远不改结果的冗余分支,变异验证也测不出来(试过,见 mut-public-mcp.py)。
 */
export function secretFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PUBLIC_MCP_PATH_PREFIX)) return null;
  const rest = pathname.slice(PUBLIC_MCP_PATH_PREFIX.length);
  return rest || null;
}

/** 常量时间比较两个字符串。长度不同直接 false(长度本身就泄漏不了密钥内容)。 */
function secretMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CORS —— **这条路要允许 ChatGPT 的网页来源**,和扩展桥那份刻意不同(那份只放行
 * 扩展来源,是它的安全边界,不动)。这里放行任意来源是安全的:真正的门槛是路径里的
 * 密钥,而不是 Origin(Origin 是浏览器自愿带的,本来就不该当鉴权用)。
 */
function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, ${MCODE_SESSION_HEADER}`,
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // 标准 MCP 客户端要能在预检里看见会话 id(服务端给了才有)。
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "600");
}

async function handlePublicRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);

  // 预检:不碰密钥(浏览器在发正式请求前就要这个答复,而那时代码还没机会看路径)。
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const rawUrl = req.url ?? "";
  const pathname = rawUrl.split("?", 2)[0] ?? "";
  const got = secretFromPath(pathname);
  const expected = store?.getSecret() ?? "";

  // 先比**项目链接**(多项目并行那几条)。每一条都比完 —— 不在第一条命中就 break,
  // 免得"命中第几条"变成可计时的信号;常量时间比较只防得住单条比较内部的时序。
  let linkProject: string | null = null;
  if (got) {
    for (const link of store?.listProjectLinks?.() ?? []) {
      if (link.secret && secretMatches(got, link.secret) && linkProject === null) {
        linkProject = link.projectId;
      }
    }
  }
  if (linkProject !== null) {
    const linkSession = store!.linkSessionId?.(linkProject) ?? null;
    if (!linkSession) {
      // 项目被删了(或者建会话失败)。与"密钥不对"同样回 404 —— 这条链接已经不指向任何东西。
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    req.headers[MCODE_SESSION_HEADER] = linkSession;
    await handleMcpRequest(req, res, { keepAliveLongCalls: true });
    return;
  }

  // 密钥不对 / 路径形状不对 / 没存 store —— 一律 404,不区分原因(不透露"这里有端点")。
  if (!got || !expected || !secretMatches(got, expected)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // 密钥对了。把**合成会话**注入进去 —— `handleMcpRequest` 内部读的是
  // `MCODE_SESSION_HEADER`,而 ChatGPT 那边没有"会话"这个概念,不注入的话
  // `webToolHost` 会因为没有闸门而拒绝每一次调用(见它的文件头)。
  // 覆写而不是"没有才填":这条路**只**属于那条合成会话,外部塞什么值都不算数。
  const sessionId = store!.getSessionId();
  if (!sessionId) {
    // 会话还没建(理论上装配时就应该建好)。宁可明确失败,也不放一次没有闸门的调用。
    log.error("public mcp: no synthetic session bound; refusing the call");
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "mcode is still starting up; retry shortly" }));
    return;
  }
  req.headers[MCODE_SESSION_HEADER] = sessionId;

  // `keepAliveLongCalls`:这条路前面是 Cloudflare,它对**一个请求 100 秒内没有任何
  // 字节**就回 524(免费/Pro/Business 都不能调)。慢工具(agent_bash 默认 120 秒、
  // 长构建)会撞上 —— 所以这条路允许把慢调用改成 SSE 回、中途发保活注释。扩展的
  // `/mcp` 是本机回环,没这个问题,保持原样。
  await handleMcpRequest(req, res, { keepAliveLongCalls: true });
}

/* ────────────────────────────── 状态快照 ────────────────────────────── */

/** 设置页那一屏要的东西。形状就是契约层那份 —— 两边共用一个类型,不各写一遍。 */
export type PublicMcpStatus = ContractPublicMcpStatus;

export function publicMcpStatus(): PublicMcpStatus {
  return {
    enabled: store?.getEnabled() ?? false,
    port: localPort,
    secret: store?.getSecret() ?? "",
    sessionId: store?.getSessionId() ?? null,
    tunnelUrl: tunnelUrlProvider?.() ?? null,
    tunnelPhase: tunnelPhaseProvider?.() ?? "stopped",
    tunnelError: tunnelErrorProvider?.() ?? null,
    sandboxRoot: sandboxRootProvider?.() ?? null,
    sandboxProjectId: sandboxProjectIdProvider?.() ?? null,
    availableProjects: availableProjectsProvider?.() ?? [],
    projectLinks: projectLinksProvider?.() ?? [],
    // 隧道配置那一组:没注入(无头 smoke)时给一组"quick + 什么都没配"的缺省,
    // 与这个功能上线前的行为一致。
    ...(tunnelConfigProvider?.() ?? {
      tunnelMode: "quick" as const,
      tunnelHostname: "",
      mobileHostname: "",
      tokenHint: "",
      fixedPort: 0,
      mobilePort: 0,
      agentDelegate: false,
    }),
  };
}

/** `publicMcpStatus()` 里与隧道配置有关的那几项。 */
export interface PublicMcpTunnelView {
  tunnelMode: "quick" | "named" | "external";
  tunnelHostname: string;
  mobileHostname: string;
  tokenHint: string;
  fixedPort: number;
  mobilePort: number;
  agentDelegate: boolean;
}

/**
 * 隧道状态由外面注入 —— 隧道那套要用 `node:child_process` 和文件系统,而这几个
 * provider 本体(纯模块)不该管那些。`publicMcpSession` 负责接上。
 */
let tunnelUrlProvider: (() => string | null) | null = null;
let tunnelPhaseProvider: (() => "stopped" | "starting" | "ready" | "reconnecting" | "failed") | null = null;
let tunnelErrorProvider: (() => string | null) | null = null;
let sandboxRootProvider: (() => string | null) | null = null;
let sandboxProjectIdProvider: (() => string | null) | null = null;
let availableProjectsProvider: (() => { id: string; name: string; path: string }[]) | null = null;
/** 隧道配置视图。**可选** —— 无头 smoke 装配时不给,状态里就是一组缺省值。 */
let tunnelConfigProvider: (() => PublicMcpTunnelView) | null = null;
/** 多项目链接的展示视图。**可选** —— 不给就是空表。 */
let projectLinksProvider: (() => PublicMcpProjectLinkView[]) | null = null;

export type PublicMcpProjectLinkView = ContractPublicMcpStatus["projectLinks"][number];

export function configurePublicMcpExtras(next: {
  tunnelUrl: () => string | null;
  tunnelPhase: () => "stopped" | "starting" | "ready" | "reconnecting" | "failed";
  tunnelError: () => string | null;
  sandboxRoot: () => string | null;
  sandboxProjectId: () => string | null;
  availableProjects: () => { id: string; name: string; path: string }[];
  /** 可选:不给就按 quick + 空配置显示(见 `publicMcpStatus`)。 */
  tunnelConfig?: () => PublicMcpTunnelView;
  /** 可选:多项目链接(见 `PublicMcpStore.listProjectLinks`)。 */
  projectLinks?: () => PublicMcpProjectLinkView[];
}): void {
  tunnelConfigProvider = next.tunnelConfig ?? null;
  projectLinksProvider = next.projectLinks ?? null;
  tunnelUrlProvider = next.tunnelUrl;
  tunnelPhaseProvider = next.tunnelPhase;
  tunnelErrorProvider = next.tunnelError;
  sandboxRootProvider = next.sandboxRoot;
  sandboxProjectIdProvider = next.sandboxProjectId;
  availableProjectsProvider = next.availableProjects;
}
