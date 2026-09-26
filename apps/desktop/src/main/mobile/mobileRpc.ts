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
  ProviderCommandsSchema,
} from "@contracts/ipc";
import type {
  SaveMessagesInput,
  UpsertMessagesInput,
  TruncateAndInsertMessagesInput,
} from "@contracts/ipc";
import type { PairedDevice, MobileRpcRequest } from "@contracts/mobile";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { providerRegistry } from "@main/providers/registry.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged, broadcastSessionDeleted } from "@main/lib/sessionSync.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import {
  cancelWorkflowRun,
  graphRunIntent,
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
    const sessions = SessionRepo.listByProject(input.projectId, { limit, offset, archived });
    const total = SessionRepo.countByProject(input.projectId, archived);
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
  "setting:get": (raw) => {
    const input = GetSettingSchema.parse(raw);
    return { value: SettingRepo.get(input.key) };
  },

  "setting:set": (raw) => {
    const input = SetSettingSchema.parse(raw);
    SettingRepo.set(input.key, input.value);
  },

  "setting:getMany": (raw) => {
    const input = GetManySettingsSchema.parse(raw);
    return SettingRepo.getMany(input.keys);
  },

  "claude:healthCheck": async () => {
    const provider = providerRegistry.default;
    if (provider.healthCheck) {
      const result = await provider.healthCheck();
      return {
        installed: result.ok,
        source: result.ok ? `Agent SDK v${result.version ?? "?"}` : null,
        command: result.error ?? null,
      };
    }
    return { installed: true, source: "Agent SDK", command: null };
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
    if (input.customModelId !== undefined) updated = { ...updated, customModelId: input.customModelId };
    if (input.providerId !== undefined) updated = { ...updated, providerId: input.providerId };

    if (updated.kind === "chat") {
      const selected = getWorkflow(updated.workflowId);
      const reviewError = selected === null ? null : workflowReviewError(selected);
      if (reviewError !== null) throw new RpcError(reviewError, 409);
    }

    SessionRepo.updateStatus(session.id, "running");
    runtimeManager.bindSession(updated);
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
      void startWorkflowRun({
        session: updated,
        cwd: project.path,
        prompt: input.prompt,
        userMessage: input.userMessage,
      });
      log.info(`mobile: workflow run started (${session.id}) by ${ctx.device.name}`);
      return { session: updated };
    }
    await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd: project.path,
      skills: input.skills,
      images: input.images,
      // User-message echo payload from the phone (cross-client bubble).
      userMessage: input.userMessage,
    });
    log.info(`mobile: turn sent (${session.id}) by ${ctx.device.name}`);
    return { session: updated };
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
    SessionRepo.updateSettings(input.sessionId, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      // 选了哪个工作流**也要落库** —— 手机端的下拉现在列得出桌面端建的工作流
      // (`workflow:list`),只写进本地 store 的话列表里选中的那一项刷新就回去了。
      workflowId: workflowIdFromInput(input),
      customModelId: input.customModelId,
      providerId: input.providerId,
    });
    if (input.permissionMode) {
      runtimeManager.setPermissionMode(input.sessionId, input.permissionMode);
    }
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
    if (!session) throw new RpcError(`session not found after rename: ${input.id}`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  "session:pin": (raw) => {
    const input = PinSessionSchema.parse(raw);
    SessionRepo.setPinned(input.id, input.pinned);
    const session = SessionRepo.get(input.id);
    if (!session) throw new RpcError(`session not found after pin: ${input.id}`, 500);
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
    if (!session) throw new RpcError(`session not found after updateBookmarks: ${input.id}`, 500);
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
    if (!session) throw new RpcError(`session not found after archive: ${input.id}`, 500);
    broadcastSessionChanged(session);
    return { session };
  },

  "session:delete": (raw) => {
    const input = DeleteSessionSchema.parse(raw);
    // 同桌面端:先停掉可能还在跑的图,否则卡在节点问题上的那张图永远不会结束。
    // ⚠️ 必须排在下面 `runtimeManager.dispose` **之前** —— dispose 会清掉审批池,
    // 那时节点还挂在 promise 上。桌面端 SESSION_DELETE 是同一条顺序。
    cancelWorkflowRun(input.id);
    // Release the runtime (interrupt + approval/bridge/snapshot cleanup)
    // BEFORE the row goes — mirrors the desktop SESSION_DELETE handler.
    runtimeManager.dispose(input.id);
    SessionRepo.delete(input.id);
    broadcastSessionDeleted(input.id);
    return { ok: true };
  },

  // ── Project row mutations (DB-only). Note: cross-client PROJECT-row sync
  //    (a phone archiving a project while the desktop has it open) is not yet
  //    broadcast — the desktop refreshes its list on next launch. Session-row
  //    sync is covered by session.changed/session.deleted above. ──
  "project:archive": (raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`project not found after archive: ${input.id}`, 500);
    return { project };
  },

  "project:delete": (raw) => {
    const input = DeleteProjectSchema.parse(raw);
    // Release every session runtime BEFORE the SQL cascade removes the rows —
    // mirrors the desktop PROJECT_DELETE handler.
    runtimeManager.disposeProject(input.id);
    ProjectRepo.delete(input.id);
    return { ok: true };
  },

  "project:setGroup": (raw) => {
    const input = SetProjectGroupSchema.parse(raw);
    ProjectRepo.setGroup(input.id, input.group);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`project not found after setGroup: ${input.id}`, 500);
    return { project };
  },

  "project:pin": (raw) => {
    const input = PinProjectSchema.parse(raw);
    ProjectRepo.setPinned(input.id, input.pinned);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`project not found after pin: ${input.id}`, 500);
    return { project };
  },

  "project:rename": (raw) => {
    const input = RenameProjectSchema.parse(raw);
    ProjectRepo.rename(input.id, input.name);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new RpcError(`project not found after rename: ${input.id}`, 500);
    return { project };
  },

  "project:reorder": (raw) => {
    const input = ReorderProjectsSchema.parse(raw);
    ProjectRepo.reorder(input.orderedIds);
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
        await runtimeManager.sendTurn(session, { prompt, cwd: project.path });
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
