/**
 * mobileRpc — the security whitelist + dispatch for mobile→main RPC calls.
 *
 * The mobile client (the shared renderer bundle served over LAN) POSTs
 * `{ method, input }` to `/api/rpc`. Each whitelisted method has a handler
 * here that reuses the exact same lower-level calls the desktop IPC handlers
 * use (repos, runtimeManager, providerRegistry, and the shared helper cores
 * extracted from ipc/{files,skills,piModels}.ts) — so the behavior is
 * identical, only the transport differs (HTTP vs ipcMain).
 *
 * ## Security
 * The whitelist is explicit and minimal. Anything NOT in {@link HANDLERS}
 * returns a 404 — there is no fallthrough. Dangerous operations (file write/
 * delete/rename, terminal create/write/kill — only the read-only
 * `terminal:list` is served, so the phone can *see* the terminals but never
 * type into one, browser, lsp, shell, dialog, clipboard, custom-
 * model save/getToken, piModels save/getApiKey, endpoint presets, app
 * updates) are simply absent. The per-request {@link DeviceContext} is
 * available to handlers for future audit logging, but authorization is "any
 * paired device may call any whitelisted method" — same trust level as the
 * desktop renderer.
 *
 * Git operations are wired in `mobileGitRpc.ts` and merged in here via
 * {@link registerMobileRpcHandlers}.
 */
import {
  StartSessionSchema,
  SendTurnSchema,
  InterruptSchema,
  ApproveSchema,
  RespondQuestionSchema,
  RespondPlanApprovalSchema,
  RewindTurnSchema,
  WorkflowChooseSchema,
  WorkflowRetrySchema,
  ProjectSessionsSchema,
  SessionSearchSchema,
  SessionListNodesSchema,
  SessionHasNodesSchema,
  BookmarkSearchSchema,
  SessionMessagesSchema,
  SaveMessagesSchema,
  UpsertMessagesSchema,
  TruncateAndInsertMessagesSchema,
  UpdateSessionSettingsSchema,
  workflowIdFromInput,
  RenameSessionSchema,
  PinSessionSchema,
  UpdateBookmarksSchema,
  ArchiveSessionSchema,
  DeleteSessionSchema,
  ArchiveProjectSchema,
  DeleteProjectSchema,
  SetProjectGroupSchema,
  ReorderProjectsSchema,
  PinProjectSchema,
  RenameProjectSchema,
  SkillsListSchema,
  SkillsReadSchema,
  FileListDirSchema,
  FileReadSchema,
  FileReadBinarySchema,
  FileSearchSchema,
  GetSettingSchema,
  SetSettingSchema,
  GetManySettingsSchema,
  ProviderHealthCheckSchema,
  ProviderCommandsSchema,
  OnlyOfficeOpenSchema,
  OnlyOfficeSessionSchema,
} from "@contracts/ipc";
import { nativeTheme } from "electron";
import type {
  SaveMessagesInput,
  UpsertMessagesInput,
  TruncateAndInsertMessagesInput,
} from "@contracts/ipc";
import type { PairedDevice, MobileRpcRequest } from "@contracts/mobile";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { probeProviderHealth, providerRegistry } from "@main/providers/registry.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";
import { uiLocale } from "@main/lib/dialogText.js";
import {
  broadcastProjectsChanged,
  broadcastSessionChanged,
  broadcastSettingChanged,
} from "@main/lib/sessionSync.js";
import { deleteProjectEverywhere, deleteSessionEverywhere, SystemProjectDeleteError } from "@main/lib/rowDeletion.js";
import { isMobileAccessibleSettingKey, isSyncedSettingKey } from "@contracts/ipc/settingsSync";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import {
  cancelWorkflowRun,
  graphRunIntent,
  launchContinuation,
  parkedRunTeardown,
  resolveWorkflowChoice,
  resolveWorkflowRetry,
  startWorkflowRun,
} from "@main/orchestration/runner.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { listAvailablePiModels } from "@main/ipc/piModels.js";
import { listSkillsForProject, readSkillForProject } from "@main/ipc/skills.js";
import { readFileGuarded, readBinaryGuarded, listDirGuarded, searchFilesGuarded } from "@main/ipc/files.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { generateSessionTitle } from "@main/ipc/titleGen.js";
// 工作流库的清单。`main/orchestration/` 与 `main/workflows/`(数据根下那套 Python
// 研究脚本)是两件事,别被名字带偏 —— 见 `main/ipc/orchestration.ts` 文件头。
import { getWorkflow, listWorkflows } from "@main/orchestration/library.js";
import { workflowReviewError } from "@main/orchestration/workflowTrust.js";
import { closeSession, openOnlyOfficeSession } from "@main/onlyoffice/OnlyOfficeBridge.js";

/** Identity of the calling device, made available to every handler. */
export interface DeviceContext {
  device: PairedDevice;
}

/** A whitelisted RPC handler. Mirrors the shape of an ipcMain.handle callback
 *  minus the Electron event: validate input, do the work, return JSON-able. */
export type RpcHandler = (input: unknown, ctx: DeviceContext) => unknown | Promise<unknown>;

/** Error thrown to produce a non-200 response with a specific status. */
export class RpcError extends Error {
  constructor(
    message: string,
    /** HTTP-ish status (400 / 403 / 404 / 409 / 500). */
    readonly status: number,
  ) {
    super(message);
  }
}

const HANDLERS: Record<string, RpcHandler> = {
  // ── Reads ───────────────────────────────────────────────────────────────
  "project:list": () => ({ projects: ProjectRepo.list() }),

  "project:sessions": (raw) => {
    const input = ProjectSessionsSchema.parse(raw);
    const archived = input.archived;
    // Mirrors the desktop handler: the archived bin lists everything (no
    // pagination); the active list paginates with a default page size of 5.
    const limit = input.limit ?? (archived ? undefined : 5);
    const offset = input.offset ?? 0;
    // ⚠️ `worktree`(exclude / only)必须照传,list 和 count 都要 —— 渲染端把「本地分页」和
    // 「工作树全量」分两次取再拼起来;这里漏掉过滤时两次都返回全部会话,手机端每个项目
    // 下的对话就**各出现两遍**(桌面端走 ipc/projects.ts,一直是对的)。
    const sessions = SessionRepo.listByProject(input.projectId, {
      limit,
      offset,
      archived,
      worktree: input.worktree,
    });
    const total = SessionRepo.countByProject(input.projectId, archived, input.worktree);
    const hasMore = limit !== undefined ? offset + sessions.length < total : false;
    return { sessions, hasMore, total };
  },

  // 一个对话里跑过的工作流步骤各自的会话。和桌面端 handler 同一份收口
  // (`SessionRepo.listNodesByParent`)—— 手机端能看到哪些步骤有会话,靠的就是这条。
  "session:listNodes": (raw) => {
    const input = SessionListNodesSchema.parse(raw);
    return { sessions: SessionRepo.listNodesByParent(input.sessionId) };
  },

  // 同桌面端那条:一个对话里有没有步骤留下过会话。手机端也看得到那个入口,
  // 所以这条也得在(共用组件里访问一个 web shim 没有的 RPC 是**同步抛**的)。
  "session:hasNodes": (raw) => {
    const input = SessionHasNodesSchema.parse(raw);
    return { has: SessionRepo.hasNodeSessions(input.sessionId) };
  },

  "session:search": (raw) => {    const input = SessionSearchSchema.parse(raw);
    const sessions = SessionRepo.searchByTitle(input.query, { limit: input.limit });
    return { sessions };
  },

  "session:searchBookmarks": (raw) => {
    const input = BookmarkSearchSchema.parse(raw);
    const results = SessionRepo.searchBookmarks(input.query, { limit: input.limit });
    return { results };
  },

  "session:messages": (raw) => {
    const input = SessionMessagesSchema.parse(raw);
    const res = MessageRepo.listBySession(input.sessionId, {
      limit: input.limit,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
    });
    return { messages: res.messages, hasMore: res.hasMore };
  },

  "provider:list": () => ({
    providers: providerRegistry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    })),
  }),

  "provider:healthCheck": async (raw) => {
    const input = ProviderHealthCheckSchema.parse(raw);
    return probeProviderHealth(input.providerId, { force: input.force });
  },

  // 引擎自己的斜杠命令清单（见 `@contracts/ipc` 的 `ProviderCommandsResult`）。
  //
  // 手机端能读，而且**读到的是电脑上那份清单** —— Claude 的命令是电脑上那个 CLI 报的。
  // 手机上没有 CLI，所以这条 RPC 问的始终是主机。取不到（电脑上没登录 / 没装）会抛，
  // 手机端按那条老规矩把调用包在 try/catch 里（抛出去会让 React 19 把整棵树卸掉）。
  "provider:commands": (raw) => {
    const input = ProviderCommandsSchema.parse(raw);
    const provider = providerRegistry.get(input.providerId);
    if (!provider) throw new Error(`未注册的引擎：${input.providerId}`);
    return provider.listCommands({ cwd: input.cwd });
  },

  // ── Composer config data (read-only, mirrors the desktop IPC handlers) ──
  "customModel:list": () => ({ models: CustomModelStore.listPublic() }),

  // 工作流选择器要的那一份清单。**手机端必须能读** —— 否则输入框上那个下拉是空的,
  // 而"选了哪个工作流"是要跟着会话走到手机上的(`sessions.composer_mode` 里存的就是
  // 这个 id)。只读、无参,与 `runtimes.list` 同一个写法。
  "workflow:list": () => ({ workflows: listWorkflows() }),

  // 在岔路口上选一条路。**这条也必须是手机能回答的** —— 图停在那个节点上等一个人,
  // 而用户多半不在电脑前面;那正是"工作流卡住了"最需要被解开的时刻。它是**回答一个
  // 还活着的运行**,不是编辑工作流,所以和上面那些桌面专属的动作不是一类。
  //
  // `ok: false` 不是错:卡片可能已经过期(运行结束了、或者被取消了)。
  "workflow:choose": (raw) => {
    const input = WorkflowChooseSchema.parse(raw);
    return resolveWorkflowChoice(input);
  },

  // 从失败那一步接着跑。与上面那条同一个理由:图**卡在一个失败节点上**,而解开它
  // 最需要有人拍板的时刻,用户多半不在电脑前面。它同样是"回答一次已经在跑的运行",
  // 不是编辑工作流。
  //
  // 用户写的那句话在手机上传得过来(`note`),而且**只给失败的那一步看**。
  // `ok: false` 不是错 —— 卡片过期了,或者这个对话正有运行在跑。
  "workflow:retry": (raw) => {
    const input = WorkflowRetrySchema.parse(raw);
    return resolveWorkflowRetry(input);
  },

  "piModels:listAvailable": async () => {
    const models = await listAvailablePiModels();
    return { models };
  },

  "skills:list": (raw) => {
    const input = SkillsListSchema.parse(raw);
    return listSkillsForProject(input.projectPath).then((skills) => ({ skills }));
  },
  "skills:read": async (raw) => {
    const input = SkillsReadSchema.parse(raw);
    const content = await readSkillForProject(input.projectPath, input.source, input.name);
    return { content };
  },

  // ── Read-only file access (shared guards from ipc/files.ts) ──
  "file:listDir": (raw) => {
    const input = FileListDirSchema.parse(raw);
    return listDirGuarded(input.projectPath, input.dirPath);
  },

  "file:readFile": (raw) => {
    const input = FileReadSchema.parse(raw);
    return readFileGuarded(input.filePath);
  },

  "file:readBinary": (raw) => {
    const input = FileReadBinarySchema.parse(raw);
    return readBinaryGuarded(input.filePath);
  },

  "file:search": (raw) => {
    const input = FileSearchSchema.parse(raw);
    return searchFilesGuarded(input);
  },

  // A paired phone may open an Office file only in the view-only surface.
  // The desktop bridge still enforces workspace-root/path checks and this
  // transport deliberately never exposes forceSave or write permissions.
  "onlyoffice:open": async (raw) => {
    const input = OnlyOfficeOpenSchema.parse(raw);
    // 界面语言规则只有一份(`dialogText.uiLocale`,带 DB 未就绪兜底)。
    return openOnlyOfficeSession(input.filePath, {
      lang: uiLocale(),
      dark: nativeTheme.shouldUseDarkColors,
      userName: "Mcode",
      mode: "view",
      deviceType: "mobile",
    });
  },

  "onlyoffice:close": (raw) => {
    const input = OnlyOfficeSessionSchema.parse(raw);
    return { ok: closeSession(input.sessionKey) };
  },

  /** 终端列表 —— **只读的一条**,手机端拿它显示"这台电脑上开着哪些终端、谁开的"。
   *
   *  ⚠️ 这里刻意**只开 list**:`terminal:create` / `write` / `kill` 仍然不在白名单里。
   *  终端列表在手机上是个只读的观察窗(用户想看"我的代理在跑什么"),而在手机上
   *  往某台电脑的 PTY 里打字是另一件事 —— 那需要键盘/尺寸/焦点一整套,不是这一条
   *  该顺带给的。写操作留在桌面上、由用户本人操作。
   *
   *  与桌面端 `IPC.TERMINAL_LIST` 走同一个 `TerminalManager.list()`,所以两边看到的
   *  是同一份事实(不是两条会漂移的实现)。 */
  "terminal:list": () => ({ terminals: TerminalManager.list() }),

  // ── Settings (app-level prefs shared with the desktop DB) ──
  // ⚠️ 只放行白名单(`isMobileAccessibleSettingKey`)。设置表里还有配对令牌、
  // 中继 VPS 配置、公网 MCP 密钥、浏览器 cookie 库、MCP / LSP / 终端 shell、
  // 工作流安全审查记录 —— 不设门的话,任何一台配过对的手机都能读走、或者改掉
  // (往 `mobile.pairedDevices` 里种一台设备、把 `terminal.shell` 换成别的程序)。
  // 读:不放行的键一律当"没有"(null),不报错 —— 老网页壳的 getMany 会顺手带上
  // 设备本地键,不该因此整批失败。写:拒绝,403。
  "setting:get": (raw) => {
    const input = GetSettingSchema.parse(raw);
    if (!isMobileAccessibleSettingKey(input.key)) return { value: null };
    return { value: SettingRepo.get(input.key) };
  },

  "setting:set": (raw, ctx) => {
    const input = SetSettingSchema.parse(raw);
    if (!isMobileAccessibleSettingKey(input.key)) {
      throw new RpcError(`setting not writable from a paired device: ${input.key}`, 403);
    }
    SettingRepo.set(input.key, input.value);
    // 「跟着人走」的键写完推给桌面(以及别的手机),当场生效。
    // 不回推给发起的这台(见 broadcastSettingChanged)。
    if (isSyncedSettingKey(input.key)) broadcastSettingChanged(input.key, input.value, ctx.device.deviceId);
  },

  "setting:getMany": (raw) => {
    const input = GetManySettingsSchema.parse(raw);
    const allowed = input.keys.filter(isMobileAccessibleSettingKey);
    const values = SettingRepo.getMany(allowed);
    const out: Record<string, string | null> = {};
    for (const key of input.keys) out[key] = values[key] ?? null;
    return out;
  },

  // ── Session lifecycle / turns ───────────────────────────────────────────
  "claude:startSession": (raw) => {
    const input = StartSessionSchema.parse(raw);
    // Same create-or-reuse semantics as the desktop IPC — the phone's "new
    // session" tap also floats the project's fresh row instead of stacking
    // empty ones.
    const { session } = createOrReuseSession(input, "mobile");
    return { session };
  },

  "claude:sendTurn": async (raw, ctx) => {
    const input = SendTurnSchema.parse(raw);
    const session = SessionRepo.get(input.sessionId);
    if (!session) throw new RpcError(`session not found: ${input.sessionId}`, 404);
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new RpcError(`project not found for session ${input.sessionId}`, 500);
    // 已物化的隔离工作树优先(与桌面 `resolveSessionCwd` 同一优先级):手机发的这一轮
    // 必须跑在会话自己的工作树里,不能把 agent 的编辑写进用户主检出。手机上不物化新
    // 工作树(那需要 Git 操作与主进程交互),只用已存在的那份;没物化就走项目根。
    const cwd = session.envMode === "worktree" && session.worktreePath ? session.worktreePath : project.path;

    let updated = session;
    const isFirstMessage = session.title === "New session" && input.prompt.trim().length > 0;
    if (isFirstMessage) {
      const trimmed = input.prompt.trim();
      const title = trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : "");
      SessionRepo.updateTitle(session.id, title);
      updated = { ...session, title };
      // Sync the new title to every client (desktop renderer included) —— 但只有
      // 真正的用户会话值得广播:工作流节点会话(`kind: "node"`)不进任何列表。
      if (session.kind === "chat") broadcastSessionChanged(updated);
    }
    // Apply per-turn overrides (mirrors the desktop IPC handler).
    if (input.model !== undefined) updated = { ...updated, model: input.model };
    if (input.effort !== undefined) updated = { ...updated, effort: input.effort };
    if (input.permissionMode !== undefined) updated = { ...updated, permissionMode: input.permissionMode };
    // ⚠️ **这一轮选的工作流必须在 `graphRunIntent` 之前打进 `updated`。** 桌面端
    // (`ipc/claude.ts` 的同一段)也是这么做的,而手机端从前漏了这一句 —— 输入框把
    // `workflowId` 经 `session.updateSettings` 落库是 **fire-and-forget**,与 sendTurn
    // 抢跑;行还没落地时 `SessionRepo.get` 读到的仍是旧的 `"default"`,`graphRunIntent`
    // 于是返回 `"none"`,用户选好的工作流**静默退化成普通回合**(不报错、界面无提示)。
    const workflowId = workflowIdFromInput(input);
    if (workflowId !== undefined) updated = { ...updated, workflowId };
    if (input.customModelId !== undefined) updated = { ...updated, customModelId: input.customModelId };
    if (input.providerId !== undefined) updated = { ...updated, providerId: input.providerId };

    if (updated.kind === "chat") {
      const selected = getWorkflow(updated.workflowId);
      const reviewError = selected === null ? null : workflowReviewError(selected);
      if (reviewError !== null) throw new RpcError(reviewError, 409);
    }

    SessionRepo.updateStatus(session.id, "running");
    runtimeManager.bindSession(updated);
    // 状态置 running 后到运行时真正接管前，任何抛错都要把状态放回去（同桌面端
    // ipc/claude.ts）—— 否则会话永远停在 running、`findFreshByProject` 不再复用它。
    try {
    // Background auto-title generation — same one-shot LLM routine the desktop
    // sendTurn fires (see titleGen.ts). Fire-and-forget. **放在分岔之前**:图型
    // 工作流那一轮同样要起标题。
    if (isFirstMessage) {
      void generateSessionTitle(updated, input.prompt).catch((err) =>
        log.warn(`mobile: title generation failed for ${session.id}: ${(err as Error).message}`),
      );
    }
    // 图型工作流:与桌面端同一个判断(见 `graphRunIntent`)。手机上也能选工作流
    // (`workflow:list` 那条 RPC),所以这里不能只有"跑一个普通回合"。
    let run = graphRunIntent(updated);
    if (run === "busy") {
      // 与桌面端同一处判断:**图停在原地等人时,用户直接说话 = 放弃那一次、按他说的
      // 重来**(见 `parkedRunTeardown`)。手机上尤其要紧 —— 图停在岔路口等人的时候,
      // 用户多半不在电脑前面。
      const teardown = parkedRunTeardown(updated.id);
      if (teardown === null) {
        // 有节点真在跑 —— 同桌面端:上一轮图还在跑就**明确拒绝**,别把这条消息丢掉。
        throw new RpcError("这个工作流还在跑:先回答它的问题,或者按停止", 409);
      }
      await teardown;
      run = "start";
    }
    if (run === "start") {
      // 同桌面端(ipc/claude.ts):预检失败不能变成 unhandledRejection,手机端
      // 更看不见主进程日志 —— 交给 launchContinuation 给会话补收口事件。
      launchContinuation(updated, "起跑", {
        session: updated,
        cwd,
        prompt: input.prompt,
        userMessage: input.userMessage,
      });
      log.info(`mobile: workflow run started (${session.id}) by ${ctx.device.name}`);
      return { session: updated };
    }
    const handle = await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd,
      skills: input.skills,
      images: input.images,
      // User-message echo payload from the phone (cross-client bubble).
      userMessage: input.userMessage,
    });
    // 同桌面端:没启动就如实拒绝,别让手机端一直转圈、消息石沉大海。
    if (handle === null) throw new Error("这个对话上一轮还在运行，消息未发送：请等本轮结束或按停止后再发");
    log.info(`mobile: turn sent (${session.id}) by ${ctx.device.name}`);
    return { session: updated };
    } catch (err) {
      SessionRepo.updateStatus(session.id, "idle");
      throw err;
    }
  },

  "claude:interrupt": (raw) => {
    const input = InterruptSchema.parse(raw);
    // 图型工作流要停的是整张图(见 `orchestration/runner.ts`);
    // `cancelWorkflowRun` 返回 false 才说明这是个普通回合。
    if (!cancelWorkflowRun(input.sessionId)) runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
    return { ok: true };
  },

  // Rewind a turn's file changes. Same entry point as the desktop handler —
  // data comes from the persisted turn_files rows, not in-memory state, so it
  // works from any client for any historical turn.
  "claude:rewindTurn": async (raw) => {
    const input = RewindTurnSchema.parse(raw);
    const restored = await runtimeManager.rewindTurn(
      input.sessionId,
      input.files,
      input.targetFiles,
    );
    return { restored };
  },

  // Per-session composer config (model / effort / permissionMode / workflowId /
  // customModelId / providerId). Mirrors the desktop IPC handler: persists to
  // the session row AND, when permissionMode is present, syncs the live value
  // into the ApprovalBridge so a mid-turn mode flip takes effect for the next
  // tool call. The fresh row is broadcast so every other client (desktop
  // included) re-syncs its list and its composer chips for this thread.
  "session:updateSettings": (raw) => {
    const input = UpdateSessionSettingsSchema.parse(raw);
    // 与桌面 `SESSION_UPDATE_SETTINGS`(ipc/claude.ts)同一条规矩:**共享组件**
    // (`ChatPane` → `WorktreeModeChip` / `SessionDirectoryChip`)在手机上也挂,
    // 它们调的正是下面这几个字段。转发漏一个的表现是"界面上改成功了、库里没变"
    // —— 手机端是乐观更新(先改缓存),而这条路连拒绝都不给。
    //
    // 两道「首条消息 / 物化后锁定」的守卫也必须在这里重来一遍,否则锁定只对桌面成立:
    //  - projectId(目录再瞄准):只有还没跑过、也没物化工作树的会话能改;
    //  - providerId / envMode / wtStyle:同样按各自的新鲜度判据,而且是**整条拒**
    //    (不是悄悄忽略那个字段 —— 那会让渲染端以为改成功了,下次同步又弹回原样)。
    if (input.projectId !== undefined) {
      const sess = SessionRepo.get(input.sessionId);
      if (!sess) throw new RpcError(`session not found: ${input.sessionId}`, 404);
      const target = ProjectRepo.get(input.projectId);
      if (!target || target.archived) {
        throw new RpcError("改不了目录:目标项目不存在或已归档", 409);
      }
      if (sess.worktreePath) {
        throw new RpcError("改不了目录:会话已经在工作树里跑过了", 409);
      }
      if (MessageRepo.hasAny(input.sessionId)) {
        throw new RpcError("改不了目录:会话已经有消息了", 409);
      }
      if (sess.projectId !== input.projectId) {
        SessionRepo.updateSettings(input.sessionId, { projectId: input.projectId });
      }
    }
    if (input.providerId !== undefined || input.envMode !== undefined || input.wtStyle !== undefined) {
      const sess = SessionRepo.get(input.sessionId);
      if (!sess) throw new RpcError(`session not found: ${input.sessionId}`, 404);
      // **providerId 过了首条消息就锁死** —— 与桌面那条 handler 同一条规矩(见
      // `ipc/claude.ts` 的 `SESSION_UPDATE_SETTINGS`)。手机能改这条的话,一条跑过对话的
      // 会话会被改成另一个引擎的 DB 行,而运行时(启动时捕获的 provider)不动 ——
      // 界面是 A、实跑是 B。
      if (input.providerId !== undefined && MessageRepo.hasAny(input.sessionId)) {
        throw new RpcError("会话已经有消息了,引擎不能再改", 409);
      }
      if ((input.envMode !== undefined || input.wtStyle !== undefined) && sess.worktreePath) {
        throw new RpcError("工作树已物化,环境不能再改", 409);
      }
    }
    SessionRepo.updateSettings(input.sessionId, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      // 选了哪个工作流**也要落库** —— 手机端的下拉现在列得出桌面端建的工作流
      // (`workflow:list`),只写进本地 store 的话列表里选中的那一项刷新就回去了。
      workflowId: workflowIdFromInput(input),
      customModelId: input.customModelId,
      providerId: input.providerId,
      envMode: input.envMode,
      wtStyle: input.wtStyle,
    });
    if (input.permissionMode) {
      runtimeManager.setPermissionMode(input.sessionId, input.permissionMode);
    }
    // 与桌面那条 handler 完全一致:只广播这一条(迁项目后的列表重排由渲染端自己的
    // `moveSession` 收口 —— 别在这里多加一条 `projects.changed`,那会与桌面分家)。
    const updated = SessionRepo.get(input.sessionId);
    if (updated) broadcastSessionChanged(updated);
    return { ok: true };
  },

  // ── Message persistence (the shared renderer store writes these at turn
  //    boundaries, exactly like the desktop renderer) ──
  "session:saveMessages": (raw) => {
    const input = SaveMessagesSchema.parse(raw) as SaveMessagesInput;
    MessageRepo.replaceAll(input.sessionId, input.messages);
  },

  "session:upsertMessages": (raw) => {
    const input = UpsertMessagesSchema.parse(raw) as UpsertMessagesInput;
    MessageRepo.upsertMany(input.messages);
  },

  "session:truncateAndInsertMessages": (raw) => {
    const input = TruncateAndInsertMessagesSchema.parse(raw) as TruncateAndInsertMessagesInput;
    MessageRepo.truncateFromAndInsert(
      input.sessionId,
      { createdAt: input.cursorCreatedAt, id: input.cursorId },
      input.messages,
    );
  },

  // ── Session row mutations (LeftBar features) + cross-client broadcast ──
  "session:rename": (raw) => {
    const input = RenameSessionSchema.parse(raw);
    SessionRepo.updateTitle(input.id, input.title);
    const session = SessionRepo.get(input.id);
    if (!session) throw new RpcError(`找不到该会话(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  "session:pin": (raw) => {
    const input = PinSessionSchema.parse(raw);
    SessionRepo.setPinned(input.id, input.pinned);
    const session = SessionRepo.get(input.id);
    if (!session) throw new RpcError(`找不到该会话(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  // Replace a session's bookmark list (the mobile activity sheet can delete
  // stale entries even though it has no selection-based add affordance).
  "session:updateBookmarks": (raw) => {
    const input = UpdateBookmarksSchema.parse(raw);
    // Absent title (pre-rename rows) → null; see the desktop handler.
    const bookmarks = input.bookmarks.map((b) => ({ ...b, title: b.title ?? null }));
    SessionRepo.updateBookmarks(input.id, bookmarks);
    const session = SessionRepo.get(input.id);
    if (!session) throw new RpcError(`找不到该会话(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  "session:listPinned": () => ({ sessions: SessionRepo.listPinned() }),

  "session:archive": (raw) => {
    const input = ArchiveSessionSchema.parse(raw);
    SessionRepo.setArchived(input.id, input.archived);
    // Archiving puts the thread away: release its runtime too (same leak as
    // delete). Restoring re-binds lazily — the next send calls bindSession
    // with the fresh row. Mirrors the desktop SESSION_ARCHIVE handler.
    if (input.archived) runtimeManager.dispose(input.id);
    const session = SessionRepo.get(input.id);
    if (!session) throw new RpcError(`找不到该会话(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  "session:delete": (raw) => {
    const input = DeleteSessionSchema.parse(raw);
    // 与桌面 SESSION_DELETE 同一份收尾(停图 → 清待并回 → 释放运行时 → 删 → 广播),
    // 见 `lib/rowDeletion.ts`。
    deleteSessionEverywhere(input.id);
    return { ok: true };
  },

  // ── Project row mutations. Every one broadcasts `projects.changed` (same as
  //    the desktop IPC) so the other client re-fetches its project list;
  //    session-row sync rides session.changed/session.deleted above. ──
  "project:archive": (raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`找不到该项目(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastProjectsChanged();
    return { project };
  },

  "project:delete": (raw) => {
    const input = DeleteProjectSchema.parse(raw);
    // 与桌面 PROJECT_DELETE 同一份收尾(系统项目守卫、逐会话停图 / 清待并回、
    // 释放运行时、逐条广播会话删除 + 项目列表变动),见 `lib/rowDeletion.ts`。
    try {
      const { sessions, stopped } = deleteProjectEverywhere(input.id);
      log.info(`project deleted from phone: ${input.id} (${sessions} sessions, ${stopped} runs stopped)`);
    } catch (err) {
      if (err instanceof SystemProjectDeleteError) throw new RpcError(err.message, 403);
      throw err;
    }
    return { ok: true };
  },

  "project:setGroup": (raw) => {
    const input = SetProjectGroupSchema.parse(raw);
    ProjectRepo.setGroup(input.id, input.group);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`找不到该项目(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastProjectsChanged();
    return { project };
  },

  "project:pin": (raw) => {
    const input = PinProjectSchema.parse(raw);
    ProjectRepo.setPinned(input.id, input.pinned);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`找不到该项目(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastProjectsChanged();
    return { project };
  },

  "project:rename": (raw) => {
    const input = RenameProjectSchema.parse(raw);
    ProjectRepo.rename(input.id, input.name);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`找不到该项目(${input.id})——它可能已经在别处删掉了,请刷新后重试`, 500);
    broadcastProjectsChanged();
    return { project };
  },

  "project:reorder": (raw) => {
    const input = ReorderProjectsSchema.parse(raw);
    ProjectRepo.reorder(input.orderedIds);
    broadcastProjectsChanged();
    return { ok: true };
  },

  // ── Async approvals / questions / plan approvals ───────────────────────
  // requestId is the universal coupling key — same Deferred resolves whether
  // the answer comes from the desktop renderer or the phone.
  "claude:approve": (raw) => {
    const input = ApproveSchema.parse(raw);
    const resolved = runtimeManager.resolveApproval(
      input.requestId,
      input.granted,
      input.granted ? undefined : "Denied by user",
      input.always,
    );
    if (!resolved) throw new RpcError(`no pending approval for ${input.requestId}`, 409);
    return { ok: true };
  },

  "claude:respondQuestion": async (raw) => {
    const input = RespondQuestionSchema.parse(raw);
    // Dismissed: user closed the card. Sentinel requests have no Deferred.
    if (input.dismissed) {
      if (input.requestId.startsWith("sentinel_")) {
        runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
        return { ok: true };
      }
      runtimeManager.dismissUserInput(input.requestId);
      return { ok: true };
    }
    // Sentinel requestIds (legacy fallback) have no Deferred — answer is
    // injected as a new turn. Mirrors the desktop handler.
    if (input.requestId.startsWith("sentinel_")) {
      // No Deferred exists — tell every other client to close their copy of
      // the question card (this answer was accepted from one client only).
      runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
      const session = SessionRepo.get(input.sessionId);
      if (!session) throw new RpcError(`session not found: ${input.sessionId}`, 404);
      const project = ProjectRepo.get(session.projectId);
      if (!project) throw new RpcError(`project not found for session ${input.sessionId}`, 500);
      const prompt = composeSentinelAnswerPrompt(input.answers);
      if (prompt) {
        SessionRepo.updateStatus(session.id, "running");
        runtimeManager.bindSession(session);
        // 工作树会话在第一次发言时就已经物化过了(这个 sentinel 追问只可能在那一轮
        // 之后出现),所以这里要按 sendTurn 的同一条优先级取 cwd —— 写成 `project.path`
        // 会把这一轮送进用户的**主检出**,而它本该跑在隔离工作树里。
        //
        // ⚠️ **与桌面同一条:抛错时把状态放回。** 上面刚置 running,若 sendTurn 抛错而
        // 不收回,会话被永久钉在 running(所有端都显示"运行中",也再不被 `findFreshByProject`
        // 复用)。桌面那条路(ipc/claude.ts)同样套了 try/catch。
        try {
          await runtimeManager.sendTurn(session, { prompt, cwd: session.worktreePath ?? project.path });
        } catch (err) {
          SessionRepo.updateStatus(session.id, "idle");
          throw err;
        }
      }
      return { ok: true };
    }
    const resolved = runtimeManager.resolveUserInput(input.requestId, input.answers);
    if (!resolved) throw new RpcError(`no pending question for ${input.requestId}`, 409);
    return { ok: true };
  },

  "claude:respondPlanApproval": (raw) => {
    const input = RespondPlanApprovalSchema.parse(raw);
    const resolved = runtimeManager.resolvePlanApproval(input.requestId, {
      approved: input.approved,
      editedPlan: input.editedPlan,
      reason: input.reason,
      feedback: input.feedback,
    });
    if (!resolved) throw new RpcError(`no pending plan approval for ${input.requestId}`, 409);
    return { ok: true };
  },
};

/** Register additional handlers (used by mobileGitRpc). */
export function registerMobileRpcHandlers(extra: Record<string, RpcHandler>): void {
  for (const [k, v] of Object.entries(extra)) {
    if (HANDLERS[k]) log.warn(`mobile: duplicate RPC handler override for "${k}"`);
    HANDLERS[k] = v;
  }
}

/** Dispatch a mobile RPC request. Validates the method is whitelisted, runs the
 *  handler, and returns its JSON-able result. Throws {@link RpcError} for
 *  handled failures (not-found, validation, conflict) — the HTTP layer maps
 *  those to status codes. */
export async function dispatchMobileRpc(
  req: MobileRpcRequest,
  ctx: DeviceContext,
): Promise<unknown> {
  const handler = HANDLERS[req.method];
  if (!handler) throw new RpcError(`unknown method: ${req.method}`, 404);
  return handler(req.input, ctx);
}

/** Compose the sentinel-fallback prompt from an AskUserQuestion answer map.
 *  Mirrors the desktop handler's `composeSentinelAnswerPrompt`: the answer
 *  keys already carry the question text, so we just render them as a reply. */
function composeSentinelAnswerPrompt(answers: Record<string, string | string[] | null>): string {
  const lines: string[] = ["(Answers to your previous question:)"];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    const value = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`${question}\n→ ${value}`);
  }
  return lines.join("\n\n");
}
