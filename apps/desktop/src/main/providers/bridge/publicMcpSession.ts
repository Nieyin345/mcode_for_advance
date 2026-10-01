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
} from "@contracts/ipc/settings";
import type { PublicMcpTunnelConfig } from "@contracts/customModel";
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
    agentDelegate: SettingRepo.get(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY) === "1",
  };
}

/**
 * 存一份新的隧道配置。设置页那张卡片调它。
 *
 * **token 留空 = 沿用已存的那串**(界面上永远只显示尾 4 位,用户不改它时不该被迫重粘一遍)。
 * 真要清掉,传一个空格之外的显式空值由上层决定 —— 这里的语义就这一条,保持简单。
 */
export async function setPublicMcpTunnelConfig(config: PublicMcpTunnelConfig): Promise<PublicMcpStatus> {
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
  SettingRepo.set(
    PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY,
    (config.mobileHostname ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
  );
  const port = config.fixedPort ?? 0;
  // 自有域名(named / external)**必须**固定端口 —— Cloudflare 那条 ingress 写死了它。
  // 用户留空时落到界面上建议的 17331,而不是随机端口(随机 = ingress 必然指空)。
  const validPort = Number.isFinite(port) && port > 0 && port < 65536 ? port : 0;
  SettingRepo.set(
    PUBLIC_MCP_FIXED_PORT_SETTING_KEY,
    String(validPort || (config.mode === "quick" ? 0 : PUBLIC_MCP_DEFAULT_FIXED_PORT)),
  );
  const token = (config.token ?? "").trim();
  if (token) SettingRepo.set(PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY, encrypt(token));
  // 委派开关:**缺席 = 不改动**(与 token 同一种读法)。它不是隧道的一部分,搭在这条
  // 已有的通道上只是为了不再多开一条 IPC —— 但语义上它比隧道配置危险得多,所以
  // 每一次变化都单独记一行日志,事后能从日志里看出是谁在哪一刻把它打开的。
  if (config.agentDelegate !== undefined) {
    SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, config.agentDelegate ? "1" : "0");
    log.info(`public mcp: agent delegate ${config.agentDelegate ? "ENABLED" : "disabled"}`);
  }
  log.info(`public mcp: tunnel config saved (mode=${config.mode})`);
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
  if (!stored || stored !== sessionId) return null;
  const projectId = publicMcpProjectId();
  return projectId ? (ProjectRepo.get(projectId)?.path ?? null) : null;
}

/**
 * 找到或建出那条合成会话,返回它的 id。
 *
 * 复用判据是 `publicMcp.sessionId` 里存的那个 id **确实存在**。库里查不到
 * (被用户删了)就现建一条 —— 而不是让每次公网调用都撞 503。
 */
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

  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId,
    providerId: DEFAULT_PROVIDER_ID,
    claudeSessionId: null,
    // 可见的正常会话 —— 这条会话就是这条通路的审计面(见文件头)。
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: PUBLIC_MCP_SESSION_TITLE,
    status: "idle",
    model: "default",
    effort: "default",
    // ⚠️ 见文件头:免审批是这个功能的定义,不是可调的偏好。
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
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, session.id);
  runtime?.bindSession(session);
  runtime?.broadcastSessionChanged(session);
  log.info(`public mcp: created synthetic session ${session.id}`);
  runtime?.setSessionPermissionMode(session.id, "bypassPermissions");
  return session.id;
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
  };
  configurePublicMcpStore(store);

  // 隧道状态 + 沙箱根:那两个都住在各自模块里(隧道要 child_process,沙箱要查库),
  // 纯的 `publicMcpServer` 不碰它们,只在这里接上。
  configurePublicMcpExtras({
    tunnelConfig: () => tunnelConfigView(),
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
      return SettingRepo.get(PUBLIC_MCP_TUNNEL_HOSTNAME_SETTING_KEY)?.trim() ? "ready" : "stopped";
    },
    tunnelError: () => (readTunnelMode() === "external" ? null : tunnelStatus().error),
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

/** 换一把路径密钥 —— 用户唯一的"拉闸"手段(旧链接立刻失效)。服务不用重启:密钥是
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
