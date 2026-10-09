/**
 * 「ChatGPT 直连」合成会话 —— 公网 MCP 端点收进来的工具调用挂在哪次对话上。
 *
 * ## 为什么必须有这条会话
 *
 * `mcpEndpoint` 处理工具调用时,`sessionIdOf(req)` 从 `x-mcode-session` 头里读会话
 * 是谁;`webToolHost` 拿不到会话就**一律拒绝**(它的文件头解释了原因:审批闸门
 * ——权限模式、「始终允许」—— 全是按会话记的,没会话就没闸门)。
 *
 * ChatGPT 那边**没有"会话"这个概念**,它不会带这个头。所以不能靠它给,只能由
 * mcode 自己造一条、每次调用都挂上去。这就是那条会话。
 *
 * ## 为什么是「可见的正常会话」而不是隐藏会话
 *
 * 造一个隐藏会话(像 `automation` 那种)更省事,但那样用户就**看不见 ChatGPT 到底
 * 调了什么**。这条会话刻意用 `kind: "chat"`、进左栏、标题写死「ChatGPT 直连」——
 * 于是公网来的每一次工具调用都留在这条对话的记录里,用户点开就能看到调用的工具名和
 * 参数。这是这条路唯一(也是必须)的审计面。
 *
 * ## ⚠️ 权限模式写死 `bypassPermissions`
 *
 * 用户明确选了"全部工具 + 免审批"(见 `PUBLIC_MCP_ENABLED_SETTING_KEY` 那段注释)。
 * 于是这条会话的审批闸门**全部放行**(`shouldAutoApproveWebTool` 在
 * `bypassPermissions` 档对任何工具都返回 true)。
 *
 * 这个值**不可由别处覆盖**:每次装配这条会话时都重新写一遍 —— 用户如果在设置页把
 * 这条会话的模式改了,下次开关一动就被改回来。**这是故意的**:这条会话的免审批
 * 是这个功能的定义,不是可调的偏好。要收紧就关总开关或换密钥。
 *
 * ## 为什么这个文件和 `publicMcpServer.ts` 分开
 *
 * `publicMcpServer.ts` 是**纯**的(无 electron / 无 db),所以无头 smoke 能把假 store
 * 注进去、把 MCP 协议逐条断言一遍。建会话要碰 db(`SessionRepo`)和 RuntimeManager,
 * 那两样都会把 electron 拉进 smoke。分开之后:协议那半测得到,建会话这半在真机跑一次。
 */
import type { Session } from "@contracts/session";
import { DEFAULT_PROVIDER_ID } from "@contracts/ipc";
import {
  PUBLIC_MCP_ENABLED_SETTING_KEY,
  PUBLIC_MCP_SECRET_SETTING_KEY,
  PUBLIC_MCP_SESSION_ID_SETTING_KEY,
  PUBLIC_MCP_PROJECT_ID_SETTING_KEY,
  PUBLIC_MCP_TUNNEL_MODE_SETTING_KEY,
  PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY,
  PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY,
  PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY,
  PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY,
  PUBLIC_MCP_FIXED_PORT_SETTING_KEY,
  PUBLIC_MCP_DEFAULT_FIXED_PORT,
  PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY,
} from "@contracts/ipc/settings";
import type { PublicMcpProjectLink, PublicMcpTunnelConfig } from "@contracts/customModel";
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { uid } from "@main/utils.js";
import { log } from "@main/lib/logger.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import {
  configurePublicMcpExtras,
  configurePublicMcpStore,
  newSecret,
  publicMcpPort,
  publicMcpStatus,
  startPublicMcp,
  stopPublicMcp,
  type PublicMcpStore,
  type PublicMcpStatus,
} from "@main/providers/bridge/publicMcpServer.js";
import { disposeTunnel, startTunnel, stopTunnel, tunnelStatus } from "@main/providers/bridge/tunnelManager.js";

/**
 * 手机伴侣此刻在听哪个端口 —— **注入**,不 import。
 *
 * ⚠️ 这里原先是 `import { getMobileServer } from "@main/mobile/MobileHttpServer.js"`,
 * 结果 `custom-model-smoke` **在 esbuild 打包阶段就红了**:那个 smoke 只 alias 了
 * electron / secretStore / SDK 几样,而 MobileHttpServer 会把 db → electron 整条图
 * 拉进来。与本文件头说的"RuntimeManager 为什么走注入"是同一个坑,别再踩第二次。
 *
 * 默认返回 0(= 没在听),由 `main/index.ts` 在装配时换成真的。
 */
let mobilePortProvider: () => number = () => 0;

/* ──────────────────────── 隧道配置的存取 ──────────────────────── */

/** 隧道模式。认不出的值按 `quick` 处理(设置表是用户可改的文本,不能假设它干净)。 */
function readTunnelMode(): "quick" | "named" | "external" {
  const raw = SettingRepo.get(PUBLIC_MCP_TUNNEL_MODE_SETTING_KEY)?.trim();
  return raw === "named" || raw === "external" ? raw : "quick";
}

/** 解出那串 Tunnel Token(落盘是 safeStorage 密文)。没存过给空串。 */
function readTunnelToken(): string {
  const raw = SettingRepo.get(PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY);
  if (!raw) return "";
  try {
    return decrypt(raw);
  } catch (err) {
    // 解不开(换了机器 / 系统密钥环变了)—— 当作没存,让用户重填,别把异常抛到 UI。
    log.error(`public mcp: tunnel token decrypt failed: ${(err as Error).message}`);
    return "";
  }
}

/** 固定端口。非法值(非数字 / 越界)一律按 0 = 随机。 */
function readFixedPort(): number {
  const n = Number.parseInt(SettingRepo.get(PUBLIC_MCP_FIXED_PORT_SETTING_KEY) ?? "", 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 0;
}

/** 界面要的那份隧道配置视图。**token 只给尾 4 位** —— 整串不出主进程。 */
function tunnelConfigView(): {
  tunnelMode: "quick" | "named" | "external";
  tunnelHostname: string;
  mobileHostname: string;
  tokenHint: string;
  fixedPort: number;
  mobilePort: number;
  agentDelegate: boolean;
} {
  const token = readTunnelToken();
  return {
    tunnelMode: readTunnelMode(),
    tunnelHostname: SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ?? "",
    mobileHostname: SettingRepo.get(PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY)?.trim() ?? "",
    tokenHint: token ? `****${token.slice(-4)}` : "",
    fixedPort: readFixedPort(),
    // 手机服务此刻在听哪个端口 —— 用户要拿它核对 Cloudflare 那条 ingress 写得对不对。
    mobilePort: mobilePortProvider(),
    agentDelegate: false, // Public MCP is basic tools + read-only library queries, regardless of legacy setting.
  };
}

/**
 * 存一份新的隧道配置。设置页那张卡片调它。
 *
 * **token 留空 = 沿用已存的那串**(界面上永远只显示尾 4 位,用户不改它时不该被迫重粘一遍)。
 * 真要清掉,传一个空格之外的显式空值由上层决定 —— 这里的语义就这一条,保持简单。
 */
export async function setPublicMcpTunnelConfig(config: PublicMcpTunnelConfig): Promise<PublicMcpStatus> {
  if (config.agentDelegate === true) throw new Error("公网 MCP 仅提供基础工具与资料库只读查询，已不支持完整 Agent 委派；请刷新设置页");
  const before = {
    mode: readTunnelMode(),
    hostname: SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ?? "",
    token: readTunnelToken(),
  };
  SettingRepo.set(PUBLIC_MCP_TUNNEL_MODE_SETTING_KEY, config.mode);
  SettingRepo.set(
    PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY,
    (config.hostname ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
  );
  // 手机域名已经搬到「连接手机 → 自有域名」单独管理(`main/mobile/mobileTunnel.ts`),
  // 这里只在调用方**显式**带了才写(兼容老调用),缺席 = 不动。
  if (config.mobileHostname !== undefined) {
    SettingRepo.set(
      PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY,
      config.mobileHostname.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
    );
  }
  const port = config.fixedPort ?? 0;
  // 自有域名(named / external)**必须**固定端口 —— Cloudflare 那条 ingress 写死了它。
  // 用户留空时落到界面上建议的 17331,而不是随机端口(随机 = ingress 必然指空)。
  const validPort = Number.isFinite(port) && port > 0 && port < 65536 ? port : 0;
  SettingRepo.set(
    PUBLIC_MCP_FIXED_PORT_SETTING_KEY,
    String(validPort || (config.mode === "quick" ? 0 : PUBLIC_MCP_DEFAULT_FIXED_PORT)),
  );
  const token = (config.token ?? "").trim();
  // 「清掉」优先于「沿用」:留空只能表达"不动",删 token 得显式说。
  if (config.clearToken) SettingRepo.set(PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY, "");
  else if (token) SettingRepo.set(PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY, encrypt(token));
  // Old clients may clear the retired flag; enabling was rejected before any writes.
  if (config.agentDelegate === false) {
    SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "0");
    log.info("public mcp: legacy agent delegate flag cleared");
  }
  log.info(`public mcp: tunnel config saved (mode=${config.mode})`);
  // 配置一变,上一次 external 探测的结论就不作数了 —— 下次读状态立刻重探。
  externalProbe = null;
  await applySavedTunnelConfig(before);
  return publicMcpStatus();
}

/**
 * 存完**立刻生效**,不用重启应用。
 *
 * ⚠️ 原先只落盘不应用:第一次配自有域名的典型流程是「开开关(随机端口 + 快速隧道)→
 * 选自有域名、填 token 和 17331 → 保存 → 点开始隧道」—— 服务还听在**随机端口**上,
 * 命名隧道却按 Cloudflare 面板里写死的 17331 转发,公网只拿到 502,而界面显示一切正常
 * (恰恰是固定端口那段注释说要避免的情形)。同理,隧道正跑着时改模式/域名/token,
 * 跑着的那条还是旧配置。
 *
 * 所以:端口对不上就换绑(被占用照样如实报错,不回落);隧道在跑且配置变了就按新配置重起。
 */
async function applySavedTunnelConfig(before: { mode: string; hostname: string; token: string }): Promise<void> {
  if (SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY) !== "on") return;
  const phase = tunnelStatus().phase;
  const tunnelActive = phase === "starting" || phase === "ready" || phase === "reconnecting";
  const wantPort = readFixedPort();
  const rebind = wantPort > 0 && publicMcpPort() !== wantPort;
  const tunnelChanged =
    readTunnelMode() !== before.mode ||
    (SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ?? "") !== before.hostname ||
    readTunnelToken() !== before.token;
  const restartTunnel = tunnelActive && (tunnelChanged || rebind);
  if (!rebind && !restartTunnel) return;
  if (restartTunnel) stopTunnel();
  if (rebind) {
    log.info(`public mcp: rebinding to fixed port ${wantPort} (was ${publicMcpPort() || "not listening"})`);
    stopPublicMcp();
    await startPublicMcp();
  }
  if (restartTunnel) startPublicMcpTunnel();
}

/**
 * 这条通路需要主进程提供的那点能力 —— 由 `main/index.ts` 注入。
 *
 * ## 为什么注入而不是直接 import
 *
 * 直接 `import { runtimeManager } from "@main/claude/RuntimeManager.js"` 会把整条
 * provider 图拉进来(它 → `agentTools` → `agentRemoteSsh` → `ssh2`,一个原生模块)。
 * 后果很具体:`custom-model-smoke` 只 alias 了 electron / secretStore / SDK 那几样,
 * 没有 `--external:ssh2`,于是 esbuild **在打包阶段**就卡在 `cpu-features.node` 上 ——
 * 而那套 smoke 跟公网端点毫无关系,失败信息也指不到这里。
 *
 * 这与 `extensionBridge` 的 `configureExtensionBridgeTokenStore` 是同一个套路:
 * 纯逻辑留在桥模块里,碰主进程的那一点点从外面注入。
 */
export interface PublicMcpRuntime {
  /** 把某个会话的权限模式钉死。 */
  setSessionPermissionMode(sessionId: string, mode: "bypassPermissions"): void;
  /** 把会话记进运行时(建行之后要做的绑定)。 */
  bindSession(session: Session): void;
  /** 告诉界面会话列表变了(左栏要出现那条「ChatGPT 直连」)。 */
  broadcastSessionChanged(session: Session): void;
}

let runtime: PublicMcpRuntime | null = null;

/** 装配主进程能力 —— 只由 `main/index.ts` 调。 */
export function configurePublicMcpRuntime(next: PublicMcpRuntime | null): void {
  runtime = next;
}

/** 左栏里那条会话显示的标题。用户靠它找到"ChatGPT 调了什么"。 */
export const PUBLIC_MCP_SESSION_TITLE = "ChatGPT 直连";

/** 这条会话的工作目录。挂到用户第一个项目上(agent_* 的相对路径基准);
 *  一个项目都没有时给 null,agent 工具对相对路径报错(与 RuntimeManager.cwdFor 同行为)。 */
function defaultProjectId(): string | null {
  const projects = ProjectRepo.list();
  return projects.find((p) => !p.archived)?.id ?? projects[0]?.id ?? null;
}

/**
 * **公网那条通路用哪个项目** —— 用户在设置里选的那个;
 * 没选过就退回"第一个非归档项目"(见 {@link defaultProjectId})。
 *
 * 为什么要有"用户选的"这一层:早先这里直接就是 `defaultProjectId`,而且**建会话时
 * 定死** —— 用户换了项目、改了目录，沙箱还指着老那个，永远不会变。用户报的就是这个
 * ("项目路径一直是固定的,没有变化")。现在改成**每次现读设置**,所以设置页改一下、
 * 下一次工具调用就生效。
 */
export function publicMcpProjectId(): string | null {
  const chosen = SettingRepo.get(PUBLIC_MCP_PROJECT_ID_SETTING_KEY)?.trim();
  if (chosen && ProjectRepo.get(chosen)) return chosen;
  return defaultProjectId();
}

/**
 * **公网那条通路的沙箱根** —— {@link publicMcpProjectId} 那个项目的目录。
 *
 * 只对合成会话生效:其他会话(桌面本机的)返回 null = 不限制,保持 claude 引擎那种
 * 自由度不变。这不是可选的谨慎,是必须 —— 给所有会话都套上会改掉本机一直在用的行为。
 *
 * 查不到(会话被删/项目没路径)返回 null:宁可**不放行**由调用方处理,也不要拿一个
 * 猜的根去限制。调用方(`agentTools`)对 null 的解释是"不限制"——但那不会发生,因为
 * 没有合成会话时公网端点连 503 都过了,压根到不了工具。
 */
export function publicMcpSandboxRoot(sessionId: string): string | null {
  const stored = SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY);
  if (stored && stored === sessionId) {
    const projectId = publicMcpProjectId();
    return projectId ? (ProjectRepo.get(projectId)?.path ?? null) : null;
  }
  // 项目链接的合成会话:沙箱 = **那条链接自己的项目**,与默认链接选了哪个无关。
  const link = readProjectLinks().find((l) => l.sessionId === sessionId);
  if (link) return ProjectRepo.get(link.projectId)?.path ?? null;
  return null;
}

/**
 * 某条公网合成会话**属于哪个项目** —— 委派(`delegateHost`)靠它把"外面的 AI 从哪条
 * 链接进来"翻译成"在哪个项目里跑那一轮"。默认链接 → 默认项目;项目链接 → 链接的
 * 项目;都不是 → null(调用方回退到默认项目)。
 */
export function publicMcpProjectIdForSession(sessionId: string | null): string | null {
  if (!sessionId) return null;
  if (SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY) === sessionId) return publicMcpProjectId();
  return readProjectLinks().find((l) => l.sessionId === sessionId)?.projectId ?? null;
}

/* ────────────────────────────── 多项目链接 ────────────────────────────── */

/**
 * 落盘的那一条(见 `PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY`)。
 *
 * 为什么不是"默认链接换项目":ChatGPT 的一个 Connector 只记一个 URL。用户要的是
 * **几个对话同时各管一个项目** —— 那就得几条 URL 同时有效、各自落到各自的会话与
 * 沙箱,而不是一条 URL 来回切。
 */
interface StoredProjectLink {
  projectId: string;
  secret: string;
  sessionId: string | null;
}

function readProjectLinks(): StoredProjectLink[] {
  const raw = SettingRepo.get(PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: StoredProjectLink[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const projectId = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
    const secret = typeof rec.secret === "string" ? rec.secret.trim() : "";
    // 太短的密钥不认 —— 手改坏的设置不能变成一条好猜的公网入口。
    if (!projectId || secret.length < 32 || seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({
      projectId,
      secret,
      sessionId: typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : null,
    });
  }
  return out;
}

function writeProjectLinks(links: StoredProjectLink[]): void {
  SettingRepo.set(PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY, JSON.stringify(links));
}

/**
 * 某条项目链接的合成会话:有就用(并确认还属于这个项目),没有/被删了就现建一条
 * 「ChatGPT 直连 · 项目名」。项目已经不在 → null(请求回 404)。
 *
 * 每次请求都会走到这里(密钥比对成功之后),所以只做两次按主键的读;建会话只在
 * 第一次或会话被用户删掉之后发生。
 */
function ensureLinkSession(projectId: string): string | null {
  const project = ProjectRepo.get(projectId);
  if (!project) return null;
  const links = readProjectLinks();
  const link = links.find((l) => l.projectId === projectId);
  if (!link) return null;
  const existing = link.sessionId ? SessionRepo.get(link.sessionId) : null;
  if (existing && existing.projectId === projectId) {
    // ⚠️ **每次都重新钉**(与默认链接 `ensureSyntheticSession` 一字不差的规矩)。
    // 从前这里用一个只增不减的 `armedLinkSessions` 判"钉过没",于是用户在界面上把这条
    // 链接会话的权限模式改掉后,下一次公网调用**不会**再钉回去 —— 文件头承诺的"模式不可
    // 覆盖"就漏了,而默认链接那条每次都钉。两条路本就是同一条规矩;每次钉一次的代价只是一次
    // 内存写,不值得为此维护一张会只涨不落的会话表。
    runtime?.setSessionPermissionMode(existing.id, "bypassPermissions");
    return existing.id;
  }
  const id = createSyntheticSession(projectId, `${PUBLIC_MCP_SESSION_TITLE} · ${project.name}`);
  link.sessionId = id;
  writeProjectLinks(links);
  return id;
}

function projectLinksView(): PublicMcpProjectLink[] {
  return readProjectLinks().map((l) => {
    const project = ProjectRepo.get(l.projectId);
    return {
      projectId: l.projectId,
      projectName: project?.name ?? "",
      projectPath: project?.path ?? "",
      secret: l.secret,
      sessionId: l.sessionId,
      missing: !project,
    };
  });
}

/** 总开关开着时把每条链接的会话都备好(会话出现在左栏,用户一眼看得到有哪几条在用)。 */
function ensureAllLinkSessions(): void {
  for (const link of readProjectLinks()) {
    try {
      ensureLinkSession(link.projectId);
    } catch (err) {
      log.error(`public mcp: 备项目链接会话失败(${link.projectId}): ${(err as Error).message}`);
    }
  }
}

/** 给一个项目发一条自己的链接。已经有了就不动(密钥不变,免得把用着的对话踢掉)。 */
export function addPublicMcpProjectLink(projectId: string): PublicMcpStatus {
  const id = projectId.trim();
  if (!ProjectRepo.get(id)) throw new Error(`项目 ${id} 不存在`);
  const links = readProjectLinks();
  if (!links.some((l) => l.projectId === id)) {
    links.push({ projectId: id, secret: newSecret(), sessionId: null });
    writeProjectLinks(links);
    log.warn(`public mcp: project link added for ${id} — anyone with that URL controls this project`);
  }
  if (SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY) === "on") {
    try {
      ensureLinkSession(id);
    } catch (err) {
      log.error(`public mcp: 建项目链接会话失败(${id}): ${(err as Error).message}`);
    }
  }
  return publicMcpStatus();
}

/** 删掉一条项目链接:URL 立刻失效。会话留着 —— 那是审计记录,不该跟着链接消失。 */
export function removePublicMcpProjectLink(projectId: string): PublicMcpStatus {
  const id = projectId.trim();
  const links = readProjectLinks();
  const next = links.filter((l) => l.projectId !== id);
  if (next.length !== links.length) {
    writeProjectLinks(next);
    log.info(`public mcp: project link removed for ${id}`);
  }
  return publicMcpStatus();
}

/** 换某条项目链接的密钥(旧 URL 立刻失效,会话不变)。 */
export function regeneratePublicMcpProjectLinkSecret(projectId: string): PublicMcpStatus {
  const id = projectId.trim();
  const links = readProjectLinks();
  const link = links.find((l) => l.projectId === id);
  if (!link) throw new Error(`项目 ${id} 还没有公网链接`);
  link.secret = newSecret();
  writeProjectLinks(links);
  log.warn(`public mcp: project link secret regenerated for ${id} — the old URL no longer works`);
  return publicMcpStatus();
}

/* ────────────────────────────── external 模式探测 ────────────────────────────── */

/**
 * external 模式下隧道是用户自己在外面跑的,Mcode 没有进程可看 —— 以前只要填了域名
 * 就报 ready,于是"域名填了但 cloudflared 没跑 / ingress 端口写错"也显示连通。
 *
 * 现在真去敲一下:`GET https://<域名>/mcp/<密钥>`。我们自己的服务对 GET 回
 * `405 POST-only` —— 看到它就说明 **公网 → Cloudflare → 隧道 → 本机这个端口**整条
 * 都通了;看到别的就按状态码给一句能照着改的话。结果缓存 30 秒,读状态时过期才重探。
 */
interface ExternalProbe {
  key: string;
  phase: "starting" | "ready" | "failed";
  error: string | null;
  at: number;
  inflight: boolean;
}

let externalProbe: ExternalProbe | null = null;
const EXTERNAL_PROBE_TTL_MS = 30_000;
const EXTERNAL_PROBE_TIMEOUT_MS = 10_000;

function externalProbeView(): { phase: "stopped" | "starting" | "ready" | "failed"; error: string | null } {
  const host = SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ?? "";
  const port = publicMcpPort();
  if (!host || !port) return { phase: "stopped", error: null };
  const secret = SettingRepo.get(PUBLIC_MCP_SECRET_SETTING_KEY)?.trim() ?? "";
  if (!secret) return { phase: "stopped", error: null };
  const key = `${host}|${port}|${secret}`;
  const stale = !externalProbe || externalProbe.key !== key ||
    (!externalProbe.inflight && Date.now() - externalProbe.at > EXTERNAL_PROBE_TTL_MS);
  if (stale) {
    // 换了目标就从"探测中"重来;同一目标过期重探时保留上次结论,界面不闪。
    const keep = externalProbe && externalProbe.key === key ? externalProbe : null;
    const probe: ExternalProbe = {
      key,
      phase: keep?.phase ?? "starting",
      error: keep?.error ?? null,
      at: Date.now(),
      inflight: true,
    };
    externalProbe = probe;
    void probeExternal(host, secret, port).then((r) => {
      if (externalProbe !== probe) return; // 期间配置变了,这次结论作废
      probe.phase = r.ok ? "ready" : "failed";
      probe.error = r.ok ? null : r.error;
      probe.at = Date.now();
      probe.inflight = false;
    });
  }
  return { phase: externalProbe!.phase, error: externalProbe!.error };
}

async function probeExternal(
  host: string,
  secret: string,
  port: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `https://${host}/mcp/${secret}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(EXTERNAL_PROBE_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    if (res.status === 405 && body.includes("POST-only")) return { ok: true };
    const s = res.status;
    if (s >= 300 && s < 400) {
      return { ok: false, error: `https://${host} 把请求重定向了(HTTP ${s})。多半是这个域名挂了 Cloudflare Access —— MCP 域名不能挂 Access(ChatGPT 过不了登录页)。` };
    }
    if (s === 403) {
      return { ok: false, error: `https://${host} 被 Cloudflare 拦下了(HTTP 403)。检查 Bot Fight Mode / WAF 规则 / Access 是否作用在这个域名上。` };
    }
    if (s === 404 && body.includes("not found")) {
      return { ok: false, error: `https://${host} 通到了一个 Mcode 公网服务,但密钥对不上 —— ingress 指到的可能是另一台机器或另一份 Mcode。` };
    }
    if (s === 502 || s === 503 || s === 530 || /error code: 10(16|33)/i.test(body)) {
      return { ok: false, error: `Cloudflare 连不到你的隧道(HTTP ${s})。确认 cloudflared 在跑,且这个域名的 ingress 指向 http://127.0.0.1:${port}。` };
    }
    return { ok: false, error: `https://${host} 的应答不像 Mcode(HTTP ${s})。确认这个域名的 ingress 指向 http://127.0.0.1:${port}。` };
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError" ? "超时" : (err as Error).message;
    return { ok: false, error: `连不上 https://${host}(${msg})。如果本机访问外网要走代理,这条探测可能误报 —— 以 ChatGPT 实际能否连上为准。` };
  }
}

/**
 * 找到或建出那条合成会话,返回它的 id。
 *
 * 复用判据是 `publicMcp.sessionId` 里存的那个 id **确实存在**。库里查不到
 * (被用户删了)就现建一条 —— 而不是让每次公网调用都撞 503。
 */
/** 建一条公网合成会话(默认链接与项目链接共用):可见的 chat 会话,权限钉死 bypass。 */
function createSyntheticSession(projectId: string, title: string): string {
  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId,
    providerId: DEFAULT_PROVIDER_ID,
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "bypassPermissions",
    workflowId: "default",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(session);
  runtime?.bindSession(session);
  runtime?.broadcastSessionChanged(session);
  log.info(`public mcp: created synthetic session ${session.id} (${title})`);
  runtime?.setSessionPermissionMode(session.id, "bypassPermissions");
  return session.id;
}

function ensureSyntheticSession(): string {
  const stored = SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY);
  if (stored && SessionRepo.get(stored)) {
    // 已存在:只把权限模式重新钉死(见文件头为什么不可覆盖)。
    runtime?.setSessionPermissionMode(stored, "bypassPermissions");
    return stored;
  }
  // The public endpoint reads this setting directly.  Leaving a deleted session id
  // here makes the endpoint look ready even though webToolHost will reject every
  // call because no approval gate exists for that session.  Clear the dangling
  // reference before attempting to recreate it; if recreation fails, requests now
  // fail at the endpoint boundary with the intended 503 instead.
  if (stored) SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "");

  const projectId = defaultProjectId();
  if (!projectId) {
    throw new Error("public mcp: 需要一个项目才能建「ChatGPT 直连」会话,但一个项目都没有");
  }

  // 可见的正常会话、权限钉死 bypass —— 两条都见文件头。
  const id = createSyntheticSession(projectId, PUBLIC_MCP_SESSION_TITLE);
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, id);
  return id;
}

/**
 * 装配这个功能的**不纯那一半**:把 `SettingRepo` / `ApprovalBridge` 接到纯模块
 * (`publicMcpServer.ts`)留的注入点上,并在开关开着时把服务与合成会话一并备好。
 *
 * 由 `main/index.ts` 在启动时调一次(db 就绪之后,与 `configureExtensionBridgeTokenStore`
 * 同一个时机)。
 */
export function initPublicMcp(deps?: { mobilePort?: () => number }): void {
  if (deps?.mobilePort) mobilePortProvider = deps.mobilePort;
  const store: PublicMcpStore = {
    getEnabled: () => SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY) === "on",
    setEnabled: (on) => SettingRepo.set(PUBLIC_MCP_ENABLED_SETTING_KEY, on ? "on" : "off"),
    getSecret: () => {
      const existing = SettingRepo.get(PUBLIC_MCP_SECRET_SETTING_KEY);
      if (existing && existing.trim()) return existing.trim();
      const fresh = newSecret();
      SettingRepo.set(PUBLIC_MCP_SECRET_SETTING_KEY, fresh);
      return fresh;
    },
    setSecret: (secret) => SettingRepo.set(PUBLIC_MCP_SECRET_SETTING_KEY, secret),
    getSessionId: () => SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY),
    setSessionId: (id) => SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, id),
    // 命名隧道要固定端口(ingress 规则里写死了它);0 = 随机,保持老行为。
    getFixedPort: () => readFixedPort(),
    // 多项目并行:几条项目链接各自的密钥与会话(见 `ensureLinkSession`)。
    listProjectLinks: () => readProjectLinks().map((l) => ({ projectId: l.projectId, secret: l.secret })),
    linkSessionId: (projectId) => {
      try {
        return ensureLinkSession(projectId);
      } catch (err) {
        log.error(`public mcp: 项目链接会话不可用(${projectId}): ${(err as Error).message}`);
        return null;
      }
    },
  };
  configurePublicMcpStore(store);

  // 隧道状态 + 沙箱根:那两个都住在各自模块里(隧道要 child_process,沙箱要查库),
  // 纯的 `publicMcpServer` 不碰它们,只在这里接上。
  configurePublicMcpExtras({
    tunnelConfig: () => tunnelConfigView(),
    projectLinks: () => projectLinksView(),
    // external 模式:隧道不归我们管(用户自己在外面跑,比如装成了系统服务),所以
    // 没有进程状态可报 —— 直接把他配的域名当作"地址",有域名就算 ready。
    // 这不是在假装探测过:UI 文案会说明 external 下的可达性要用"测试"按钮确认。
    tunnelUrl: () => {
      if (readTunnelMode() !== "external") return tunnelStatus().url;
      const host = SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim();
      return host ? `https://${host}` : null;
    },
    tunnelPhase: () => {
      if (readTunnelMode() !== "external") return tunnelStatus().phase;
      // 真去敲一下公网那头(见 `externalProbeView`),不再“填了域名就算通”。
      return externalProbeView().phase;
    },
    tunnelError: () => (readTunnelMode() === "external" ? externalProbeView().error : tunnelStatus().error),
    sandboxRoot: () => {
      const id = store.getSessionId();
      return id ? publicMcpSandboxRoot(id) : null;
    },
    // 设置页那个下拉框:让用户自己挑沙箱项目(见 `PUBLIC_MCP_PROJECT_ID_SETTING_KEY`)。
    sandboxProjectId: () => publicMcpProjectId(),
    availableProjects: () =>
      ProjectRepo.list()
        .filter((p) => !p.archived)
        .map((p) => ({ id: p.id, name: p.name, path: p.path })),
  });

  // 开关开着就顺手起好(与扩展桥"别等用户点开设置页"同一个理由:用户重启应用后
  // 期望它还在听)。失败不拦启动 —— 记日志即可。
  //
  // ⚠️ **必须先备好合成会话,再起服务**(与 `setPublicMcpEnabled` 同一步骤、同一顺序)。
  //
  // 这里原先只 `startPublicMcp()` —— 于是**重启之后**开关虽然是 on、服务也在听,但那条
  // 合成会话没人建(或者指向一个被用户删掉的旧会话)。`publicMcpServer` 拿不到会话 id
  // 就回 503,**每一次工具调用都失败**,而用户看到的只是"连上了但调不动"
  // (2026-09-24 自查发现:两条启动路径行为不一致)。
  if (store.getEnabled()) {
    void (async () => {
      try {
        ensureSyntheticSession();
        ensureAllLinkSessions();
      } catch (err) {
        // 建不了会话(比如一个项目都没有)—— 记下来。服务还是起,但调用会被 503 挡住,
        // 那条路径自己的日志会说清原因。
        log.error(`public mcp: 自动启动时建合成会话失败: ${(err as Error).message}`);
      }
      await startPublicMcp();
    })().catch((err) => {
      log.error(`public mcp: auto-start failed: ${(err as Error).message}`);
    });
  }
}

/** 起公网隧道。UI 那个按钮调它。没开开关时拒绝 —— 隧道指着一个没在听的服务没意义。 */
export function startPublicMcpTunnel(): PublicMcpStatus {
  const status = publicMcpStatus();
  if (!status.enabled) {
    log.warn("public mcp: tunnel start ignored — the endpoint is disabled");
    return status;
  }
  // 端口为 0 = 服务还没起来(持久化的 enabled 是 true、但 auto-start 还没跑完,
  // 或它失败了)。这时起隧道会指向 `http://127.0.0.1:0`,那条隧道永远连不通 ——
  // 与其让用户拿到一个死地址,不如明确拒绝。
  if (!status.port) {
    log.warn("public mcp: tunnel start ignored — the local server is not listening yet");
    return status;
  }
  const mode = readTunnelMode();
  // external:隧道是用户自己在外面跑的,这里**什么都不起** —— 起了就是两条隧道抢
  // 同一个 ingress,反而把本来好好的那条弄坏。
  if (mode === "external") {
    log.info("public mcp: tunnel mode is external — not spawning cloudflared");
    return publicMcpStatus();
  }
  if (mode === "named") {
    startTunnel(status.port, false, {
      mode: "named",
      token: readTunnelToken(),
      hostname: SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ?? "",
    });
    return publicMcpStatus();
  }
  startTunnel(status.port, false, { mode: "quick" });
  return publicMcpStatus();
}

/** 停公网隧道(开关仍开着;只是不再对外暴露)。 */
export function stopPublicMcpTunnel(): PublicMcpStatus {
  stopTunnel();
  return publicMcpStatus();
}

/**
 * 打开/关闭这条通路。设置页那个开关调这里。
 *
 * 打开时**先把合成会话备好再起服务** —— 反过来的话,从服务起到会话建好之间有个窗口,
 * 那时进来的调用会因为没有会话而被拒(甚至更糟)。宁可先建会话。
 */
export async function setPublicMcpEnabled(enabled: boolean): Promise<PublicMcpStatus> {
  if (enabled) {
    // Persist "on" before starting because publicMcpServer deliberately refuses
    // to listen while disabled.  If either session provisioning or listen fails,
    // roll the persisted switch back: reporting an error while leaving a dangerous
    // public service configured to auto-start on the next launch is misleading.
    SettingRepo.set(PUBLIC_MCP_ENABLED_SETTING_KEY, "on");
    try {
      const sessionId = ensureSyntheticSession();
      ensureAllLinkSessions();
      log.warn(
        `public mcp: ENABLED — tool calls from the internet run WITHOUT approval, ` +
          `attributed to session ${sessionId}. Anyone with the URL secret controls this machine.`,
      );
      await startPublicMcp();
    } catch (err) {
      SettingRepo.set(PUBLIC_MCP_ENABLED_SETTING_KEY, "off");
      stopTunnel();
      stopPublicMcp();
      throw err;
    }
  } else {
    SettingRepo.set(PUBLIC_MCP_ENABLED_SETTING_KEY, "off");
    // 关服务**也要停隧道** —— 否则留下一条指向死端口的公网隧道:外人还能连上那个
    // 域名(cloudflared 会回 502),而我们这边已经没人在听。关就是关干净。
    stopTunnel();
    stopPublicMcp();
    log.info("public mcp: disabled");
  }
  return publicMcpStatus();
}

/** 换一把路径密钥 —— 让旧链接失效(旧链接立刻失效)。服务不用重启:密钥是
 *  每次请求现读的(见 `publicMcpServer.handlePublicRequest`)。 */
export function regeneratePublicMcpSecret(): PublicMcpStatus {
  const fresh = newSecret();
  SettingRepo.set(PUBLIC_MCP_SECRET_SETTING_KEY, fresh);
  log.warn("public mcp: secret regenerated — the old URL no longer works");
  return publicMcpStatus();
}

/**
 * 改**沙箱目录** —— 公网进来的文件工具能碰哪个项目(见 `PUBLIC_MCP_PROJECT_ID_SETTING_KEY`)。
 *
 * 传 `null` = 取消选择(回退到"第一个非归档项目")。传不存在的 id 也当取消 —— 与其存一个
 * 悬空引用,不如明确回退。**不用重启任何东西**:工具调用每次都现读这个设置。
 */
export function setPublicMcpProject(projectId: string | null): PublicMcpStatus {
  const valid = projectId?.trim() && ProjectRepo.get(projectId.trim());
  if (valid) {
    SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, projectId!.trim());
    log.info(`public mcp: sandbox project set to ${projectId}`);
  } else {
    SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "");
    log.info("public mcp: sandbox project cleared (falls back to the first project)");
  }
  return publicMcpStatus();
}

/** 退出时收摊。与 `stopExtensionBridge()` 并排调。 */
export function disposePublicMcp(): void {
  disposeTunnel();
  stopPublicMcp();
}
