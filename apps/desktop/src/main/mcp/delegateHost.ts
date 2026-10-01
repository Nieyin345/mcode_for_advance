/**
 * **委派工具的不纯那一半** —— 把 `delegateServer.ts` 留的注入点接到真的
 * `RuntimeManager` / `SessionRepo` 上。
 *
 * 分成两个文件不是风格:那张表会被 `publicMcpSession` 引到,而它活在几个无头 smoke 的
 * 打包图里。这边 import 的 `repositories.js` → `db.ts` → electron,直接写进表里会让
 * `custom-model-smoke` 在 **esbuild 阶段**就红(本轮已经为 `MobileHttpServer` 吃过一次)。
 *
 * 由 `main/index.ts` 在 db 就绪后调一次 {@link initAgentDelegate}。
 */
import type { Session } from "@contracts/session";
import {
  PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY,
  PUBLIC_MCP_DELEGATE_SESSION_ID_SETTING_KEY,
  PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY,
} from "@contracts/ipc/settings";
import { configureDelegateDeps } from "@main/mcp/delegateServer.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { publicMcpProjectId, publicMcpProjectIdForSession } from "@main/providers/bridge/publicMcpSession.js";
import { uid } from "@main/utils.js";
import { DEFAULT_PROVIDER_ID } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";

/** 会话标题。**用户要在左栏里一眼认出这是外面的 AI 在支使本机**,所以写得直白。 */
const DELEGATE_SESSION_TITLE = "外部 AI 委派";

/**
 * 那条专用会话(没有就建)。
 *
 * 为什么不复用「ChatGPT 直连」那条:那条是**工具调用的闸门所在**,外面的 AI 每一次
 * `agent_read` 都挂在它身上。委派是在它**里面**再起一整轮 agent —— 两者挤在一条会话里,
 * 流水会交错成一团,出事时分不清哪一段是谁干的。审计面要分得开,这是分开的全部理由。
 */
/** 各项目的委派会话表(见 `PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY`)。坏 JSON = 空表。 */
function readDelegateSessions(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(SettingRepo.get(PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * **多项目并行**:进来的是哪条链接(`callerSessionId` = 那条链接的合成会话),就在
 * 那条链接的项目里跑;每个项目一条自己的委派会话,所以不同项目可以同时各跑一轮,
 * 同一个项目仍然一次一轮(同一条会话不能叠两轮)。
 */
async function ensureDelegateSession(callerSessionId: string | null): Promise<{ sessionId: string; cwd: string }> {
  const projectId = publicMcpProjectIdForSession(callerSessionId) ?? publicMcpProjectId();
  if (!projectId) throw new Error("需要一个项目才能委派,但一个项目都没有");
  const project = ProjectRepo.get(projectId);
  if (!project) throw new Error(`项目 ${projectId} 不在了`);

  const map = readDelegateSessions();
  // 老版本只有一条(单键);它属于哪个项目就继续给哪个项目用,升级后不多建一条。
  const legacy = SettingRepo.get(PUBLIC_MCP_DELEGATE_SESSION_ID_SETTING_KEY);
  const stored = map[projectId] ?? legacy;
  const existing = stored ? SessionRepo.get(stored) : undefined;
  // 项目被改过(用户换了沙箱项目)时同样要重建 —— 否则委派会跑在旧项目的目录里,
  // 而界面上显示的沙箱是新那个,这种错位查起来很要命。
  if (existing && existing.projectId === projectId) {
    runtimeManager.bindSession(existing);
    return { sessionId: existing.id, cwd: project.path };
  }

  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId,
    providerId: DEFAULT_PROVIDER_ID,
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: projectId === publicMcpProjectId() ? DELEGATE_SESSION_TITLE : `${DELEGATE_SESSION_TITLE} · ${project.name}`,
    status: "idle",
    model: "default",
    effort: "default",
    // 和「ChatGPT 直连」同一个理由:外面的 AI 是在无人值守的时刻调过来的,弹卡等于挂死。
    // 闸门是设置里那个开关(默认关),不是逐次审批 —— 见 `delegateServer.ts` 文件头。
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
  map[projectId] = session.id;
  SettingRepo.set(PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY, JSON.stringify(map));
  runtimeManager.bindSession(session);
  log.info(`created delegate session ${session.id} in project ${projectId}`);
  return { sessionId: session.id, cwd: project.path };
}

export function initAgentDelegate(): void {
  configureDelegateDeps({
    enabled: () => SettingRepo.get(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY) === "1",
    ensureSession: ensureDelegateSession,
    isBusy: (sessionId) => runtimeManager.isBusy(sessionId),
    interrupt: (sessionId) => runtimeManager.interrupt(sessionId),

    async runTurn({ sessionId, cwd, prompt, onText }) {
      const session = SessionRepo.get(sessionId);
      if (!session) return { text: "", error: `会话 ${sessionId} 不在了` };
      let acc = "";
      let failure: string | undefined;
      // 订阅必须在 `sendTurn` **之前**挂上:第一段文字可能在 await 回来之前就发出来了,
      // 晚挂一步丢的恰恰是开头那句。
      const unsubscribe = runtimeManager.subscribe((e) => {
        if (e.sessionId !== sessionId) return;
        if (e.type === "text.delta") {
          acc += e.text;
          onText(e.text);
        } else if (e.type === "approval.request") {
          // 委派会话是 bypass,绝大多数调用不会走到这里;但 mcode-app 的 DANGER 档
          // **每次都要人批**,不受权限模式影响。那时这一轮会停在桌面端的审批卡上 ——
          // 外面的 AI 只看得到 running,以为卡死了。把"在等谁"写进进展里,它能告诉用户。
          const note = `\n\n[等待用户在 Mcode 桌面端批准:${e.toolName}]\n\n`;
          acc += note;
          onText(note);
        } else if (e.type === "error") {
          failure = e.message;
        }
      });
      try {
        const handle = await runtimeManager.sendTurn(session, { prompt, cwd });
        if (!handle) return { text: "", error: "这条会话接不下(它正忙)" };
        await handle.done;
        return { text: acc, error: failure };
      } finally {
        unsubscribe();
      }
    },
  });
  log.info("agent delegate wired (tools appear only when the user turns it on)");
}
