import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";
import { LIBRARY_GROUPS_SETTING_KEY, LIBRARY_SUPPRESS_SETTING_KEY } from "@contracts/libraryTypes";
import { validateCustomUiWrite } from "@main/customUi/configValidation.js";
import { invalidateLibraryGroupsCache } from "@main/library/groupRegistry.js";
import { invalidateSuppressCache } from "@main/library/suppress.js";
import type { IpcMain } from "electron";
import {
  IPC,
  StartSessionSchema,
  ListSideChatsSchema,
  SendTurnSchema,
  InterruptSchema,
  StopTaskSchema,
  ReadTaskOutputSchema,
  InjectSchema,
  ApproveSchema,
  RespondQuestionSchema,
  RespondPlanApprovalSchema,
  RewindTurnSchema,
  UpdateSessionSettingsSchema,
  SessionMessagesSchema,
  SaveMessagesSchema,
  UpsertMessagesSchema,
  TruncateAndInsertMessagesSchema,
  ForkSessionSchema,
  GetSettingSchema,
  SetSettingSchema,
  GetManySettingsSchema,
  THEME_STYLE_SETTING_KEY,
  TURN_BUDGET_SETTING_KEY,
  workflowIdFromInput,
  isWorkflowExecutionTrustSettingKey,
  ClaudeSubagentsSaveSchema,
  ProviderHealthCheckSchema,
  ProviderCommandsSchema,
} from "@contracts/ipc";
import { saveSubagents } from "@main/claude/subagentStore.js";
import type {
  SaveMessagesInput,
  UpsertMessagesInput,
  TruncateAndInsertMessagesInput,
} from "@contracts/ipc";
import type { UserInputAnswers } from "@contracts/provider";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { probeProviderHealth, providerRegistry } from "@main/providers/registry.js";
import { updateTitleBarOverlay } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { forkSession as forkSessionIntoNew } from "@main/lib/sessionFork.js";
import { broadcastSessionChanged, broadcastSettingChanged } from "@main/lib/sessionSync.js";
import { isSyncedSettingKey } from "@contracts/ipc/settingsSync";
import { budgetCommitWorthBackingUp, lastGoodTurnBudgetKey } from "@main/lib/turnPolicy.js";
import { createSessionAndSend } from "@main/appServices/sessionCommands.js";
import { randomUUID } from "node:crypto";
import {
  cancelWorkflowRun,
  graphRunIntent,
  launchContinuation,
  parkedRunTeardown,
} from "@main/orchestration/runner.js";
import { getWorkflow } from "@main/orchestration/library.js";
import { workflowReviewError } from "@main/orchestration/workflowTrust.js";
import { isRetiredLegacyGraph, retiredGraphError } from "@main/workflowEngines/workflowEngineSelection.js";
import { generateSessionTitle } from "@main/ipc/titleGen.js";
import { createBranchedWorktree, createDetachedWorktree, nextWorktreeDir } from "@main/lib/worktreeOps.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Project, Session } from "@contracts/session";

/** In-flight materializations, keyed by session id. Concurrent first turns
 *  (double-send, desktop + mobile racing) both observe `worktreePath: null`
 *  and would independently probe the disk for the next free directory — an
 *  interleaving that creates TWO worktrees, one of which the DB race orphans.
 *  The second caller awaits the first caller's promise instead. */
const materializing = new Map<string, Promise<string>>();

/** Resolve the working directory a session's turn must run in.
 *
 *  - local session → the project root (unchanged historical behavior);
 *  - worktree session, not yet materialized → create the detached worktree
 *    NOW (intent-first, materialize-on-first-turn), persist its path BEFORE
 *    the turn is dispatched (a crash between creation and turn-start still
 *    leaves the session pointing at its worktree), and return it. Concurrent
 *    materializations for the same session ride ONE in-flight promise;
 *  - materialized worktree session → its recorded path (restart-safe),
 *    with a friendly error when the directory has since disappeared.
 *
 *  Every downstream mechanism (write guard, bash guard, MCP injection,
 *  file snapshot) keys off this cwd, so isolation between parallel worktree
 *  sessions — and from the local checkout — rides on this single value. */
async function resolveSessionCwd(session: Session, project: Project): Promise<string> {
  if (session.envMode !== "worktree") return project.path;

  if (!session.worktreePath) {
    const inFlight = materializing.get(session.id);
    if (inFlight) return inFlight;
    const p = materializeWorktreeSession(session, project).finally(() => {
      materializing.delete(session.id);
    });
    materializing.set(session.id, p);
    return p;
  }

  // Already materialized: verify the directory still exists.
  const exists = await stat(session.worktreePath).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(
      `会话的工作树目录已不存在:${session.worktreePath}(可能被手动删除)。请在 Git 面板清理后新建会话。`,
    );
  }
  return session.worktreePath;
}

/** The materialization half of resolveSessionCwd (un-materialized worktree
 *  intent only). Always called under the per-session in-flight lock above. */
async function materializeWorktreeSession(session: Session, project: Project): Promise<string> {
  // Materialize. The project root itself must be a git repo (the base is
  // HEAD as seen from the user's checkout). When it isn't, DEGRADE to
  // local instead of throwing: this state is reachable without a UI to
  // fix it (rows created before creation-time coercion existed, the
  // project's .git removed after the intent was set — in both the chip
  // is hidden for non-repo projects, so a hard error would brick every
  // send forever). Flip the row back and broadcast so all clients'
  // badges/groupings correct themselves.
  const hasGit = await stat(join(project.path, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!hasGit) {
    log.warn(
      `worktree intent for session ${session.id} dropped — project root is not a git repo (${project.path}); running locally`,
    );
    SessionRepo.updateSettings(session.id, { envMode: "local", wtStyle: null });
    const downgraded = SessionRepo.get(session.id) ?? { ...session, envMode: "local" as const };
    broadcastSessionChanged(downgraded);
    return project.path;
  }
  // Form fork: "branch" materializes on a generated mcode/* ref (durable
  // named commits), anything else keeps the classic detached checkout.
  // nextWorktreeDir's branchStyle probe guarantees the branch name is free
  // BEFORE worktree add -b ever runs.
  const branchStyle = session.wtStyle === "branch";
  const target = await nextWorktreeDir(project.path, session.id, { branchStyle });
  const res = branchStyle
    ? await createBranchedWorktree(project.path, target)
    : await createDetachedWorktree(project.path, target);
  if (!res.ok) {
    throw new Error(`创建隔离工作树失败:${res.error}`);
  }
  SessionRepo.updateWorktreePath(session.id, target);
  // Re-read so the broadcast + the returned session snapshot both carry
  // the materialized path (renderer flips its badge off this).
  const updatedRow = SessionRepo.get(session.id) ?? session;
  broadcastSessionChanged(updatedRow);
  log.info(`worktree session materialized: ${session.id} -> ${target}`);
  return target;
}

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CLAUDE_START_SESSION, async (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    // 【ARC-001】「建会话」这一条业务命令只有一处实现 —— agent 那条 headless 路
    // (`appControl/tools.ts` 的 `headlessNewSession`)调的是**同一个** `createSessionAndSend`。
    // 桌面这条只要会话行(首条消息由用户随后经 `claude:sendTurn` 发),所以不传 prompt ——
    // 结果形状照旧 `{ session }`(复用 `createOrReuseSession` 的既有语义)。
    //
    // 【ARC-001 步②】传入结构化的 ActionContext:桌面路 = **用户**(actorKind: "user")。
    // 从前这里传的是裸字符串 `"desktop"` —— 那只是一个渠道名,表达不了「谁在调」。现在
    // 「谁」是结构化事实:agent 那条路填 `agent`、手机端填 `mobile`,本函数与服务函数都只读它。
    // 【ARC-001 步③】把可选的 `expectedRevision`(乐观并发修订号)也带上:渲染端要复用某条
    // 「新对话」空壳、且怕它已被改过时,会在 `StartSessionInput` 里给出那一版的修订号;给了就
    // 由服务函数在复用前核对,对不上抛错 → 这里变成 IPC 拒绝(不建、不发)。缺席 = 不启用。
    const { session } = await createSessionAndSend({ input }, {
      actorKind: "user",
      actorId: "desktop",
      operationId: randomUUID(),
      scope: input.projectId,
      ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
    });
    return { session };
  });

  // Hydrate the right-panel ask tab's list view: a main session's side
  // chats, newest first. Read-only, no schema beyond the parent id.
  ipcMain.handle(IPC.CLAUDE_LIST_SIDE_CHATS, (_evt, raw) => {
    const input = ListSideChatsSchema.parse(raw);
    return { sessions: SessionRepo.listSideByParent(input.parentSessionId) };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    const session = SessionRepo.get(input.sessionId);
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new Error(`project not found for session ${input.sessionId}`);

	    // Auto-title from the first user message, if the title is still the default.
	    // Side chats rewrite their own "Quick ask" placeholder (same 40-char
	    // truncation) but DON'T broadcast the change — they're invisible to the
	    // left-bar/mobile lists by design; the ask tab patches its own list
	    // from this handler's return value instead.
	    let updated = session;
	    const titlePlaceholder = session.kind === "side" ? "Quick ask" : "New session";
	    const isFirstMessage = session.title === titlePlaceholder && input.prompt.trim().length > 0;
	    if (isFirstMessage) {
      const title = input.prompt.trim().slice(0, 40) + (input.prompt.trim().length > 40 ? "…" : "");
      SessionRepo.updateTitle(session.id, title);
      updated = { ...session, title };
      // 只有**真正的用户会话**才广播。side 与 node 都是"用户看不见的会话":
      // 前者由右侧问答页签自己管,后者由调度器自己管。
      if (session.kind === "chat") {
	      // Keep connected mobile clients' session lists in sync.
	      broadcastSessionChanged(updated);
      }
	    }
	    // Apply per-turn overrides from the renderer's current UI state. The
	    // renderer persists model/effort/permissionMode/customModelId to the
	    // session row via fire-and-forget `updateSettings` calls, so the row
	    // may be stale by the time sendTurn reads it. Patching the in-memory
	    // session with the explicit overrides eliminates this race: if the UI
	    // sends a value, it wins over whatever the DB happens to hold.
	    if (input.model !== undefined) {
	      updated = { ...updated, model: input.model };
	    }
	    if (input.effort !== undefined) {
	      updated = { ...updated, effort: input.effort };
	    }
	    if (input.permissionMode !== undefined) {
	      updated = { ...updated, permissionMode: input.permissionMode };
	    }
	    const workflowId = workflowIdFromInput(input);
	    if (workflowId !== undefined) {
	      // In-memory patch only — the row itself is persisted by the composer's
	      // own `session.updateSettings` call (same split as permissionMode).
	      updated = { ...updated, workflowId };
	    }
    if (input.customModelId !== undefined) {
      updated = { ...updated, customModelId: input.customModelId };
    }
    if (input.providerId !== undefined) {
      // Per-turn provider override. Does NOT persist to the DB — the
      // session's authoritative providerId stays as-is so the per-session
      // "lock after first message" rule still holds. We only patch the
      // in-memory snapshot RuntimeManager uses to resolve the backend.
      updated = { ...updated, providerId: input.providerId };
    }

    // Prompt-only workflows bypass graphRunIntent. Refuse both kinds before
    // binding a provider or echoing a message; saving is not authorization.
    if (updated.kind === "chat") {
      const selected = getWorkflow(updated.workflowId);
      const reviewError = selected === null ? null : workflowReviewError(selected);
      if (reviewError !== null) throw new Error(reviewError);
      // 【Q5 / 批次 3】**用户图退场**：旧执行器不再跑用户的工作流。
      //
      // 闸门放在这里而不是 `runner.startWorkflowRun`：那个函数被五个调用者复用
      // （记忆助手、钩子动作、自动化、手机端、本入口），在它里面拒会把**产品功能**
      // 和**用户图**一起拒掉 —— 我第一版就是这么写的，实测把记忆助手和钩子动作
      // 当场弄坏。真正的"用户选了这张图要它跑"只有这一个入口。
      if (selected !== null && isRetiredLegacyGraph(selected)) {
        throw new Error(retiredGraphError(selected.name));
      }
    }

    // ── MC-049: 忙判断 / 启动权预检必须在**改会话状态之前**完成。 ──
    // 图型会话这一轮的落点(推图 / 等收尾 / 拒绝)先在这里定下来。从前这段在
    // `updateStatus(running)` **之后**,而且 `parkedRunTeardown` 返回 null(有节点真在跑)
    // 时直接抛出去 —— 那个 catch 会把会话状态**放回 idle**,可图其实**还在跑**:
    // 数据库说 idle、真实图说 running,两边分家(`findFreshByProject` 于是会复用一条
    // 其实正忙的会话;与 MC-013 的状态时序同源)。把预检提到状态变更之前,拒绝就发生在
    // 碰状态之前;下面的 catch 只覆盖"已经决定要跑、并且已经置了 running"的那一段 ——
    // 那时回滚 idle 才是对的。
    //
    // ⚠️ `graphRunIntent` 只读 `kind` / `workflowId` / `hasActiveRun`,不依赖 cwd,
    // 所以放在 `resolveSessionCwd` 之前定下,不会和物化那段互相影响。
    let run = graphRunIntent(updated);
    if (run === "busy") {
      // **图停在原地等人,而用户直接说了句话。** 没去点那些卡片本身就是一种回答 ——
      // 放弃那一次,按他刚说的重来(见 `parkedRunTeardown`)。
      //
      // 有节点**真在跑**的时候它返回 null,照旧拦住:半路掐掉一个正在干活的步骤是
      // 另一件事(那是「停止」按钮),不该由"我发了条消息"顺手做掉。
      const teardown = parkedRunTeardown(updated.id);
      if (teardown === null) {
        // 上一轮图还没跑完(多半是某个节点正在干活)。**抛出去**,
        // 别默默把这条消息丢掉 —— 渲染端会把 IPC 的拒绝弹成一句话。正常情况下发送时
        // 输入框是禁用的,这条兜的是手机端 / 竞态。**此刻还没碰会话状态**,所以那个
        // catch 不会把正在跑的图误标成 idle。
        throw new Error("这个工作流还在跑:先回答它的问题,或者按停止");
      }
      // **等他收干净再起新的。** 那次运行的收尾会补一个 `turn.done`(渲染端靠它收掉
      // 当前回合),不等的话它落在新那次中间。见 `parkedRunTeardown`。
      await teardown;
      run = "start";
    }

    SessionRepo.updateStatus(session.id, "running");
    // 状态置 running 之后、本轮真正被运行时接管之前，任何一步抛错都必须把状态**放回**。
    // 否则会话永远停在 running：`findFreshByProject`(要求 idle)不再复用它、其它客户端
    // 永久显示"运行中"，且全仓没有别的地方把活着的会话从 running 收回。下面所有 throw
    // 都经这个 catch 回滚 `idle` 再抛（渲染端照旧弹那句话）。
    try {
    // Resolve the turn's cwd (worktree materialization happens here — before
    // bindSession so the runtime sees the final environment). Throws surface
    // as an IPC rejection the renderer toasts; a retry after a FAILED create
    // probes the next free `<branch>-<n>` directory (materialization itself
    // is guarded by the per-session in-flight lock, so concurrent sends
    // never create two worktrees).
    const cwd = await resolveSessionCwd(updated, project);
    // Materialization may have backfilled worktreePath — refresh the
    // snapshot so the returned session (and the renderer's badge) carries it.
    //
    // ⚠️ **只补 `worktreePath`,不能整行重读。** 上面刚把这一轮的覆盖值
    // (model / effort / permissionMode / workflowId / customModelId / providerId)打进
    // `updated`;整行重读会把它们全丢掉。`providerId` 尤其要紧 —— 它**刻意不落库**
    // (见上面那条注释),库里那份是 null,丢的就是用户这一轮选的引擎。`workflowId` 也会
    // 退回库里的旧值(输入框那条落库 RPC 是 fire-and-forget,正在抢跑),
    // `graphRunIntent` 于是返回 none,选好的工作流静默退化成普通回合。
    if (updated.envMode === "worktree" && !updated.worktreePath) {
      const freshWt = SessionRepo.get(session.id)?.worktreePath;
      if (freshWt) updated = { ...updated, worktreePath: freshWt };
    }
    runtimeManager.bindSession(updated);
    // Background auto-title generation: on the first user message, fire a
    // one-shot LLM call to produce a short Chinese title and overwrite the
    // placeholder. Runs for main sessions AND side chats (both rewrite their own
    // placeholder above; the truncated text is the fallback when the feature is
    // off or fails). Fire-and-forget - never blocks the turn. See titleGen.ts.
    //
    // ⚠️ 放在**分岔之前**:图型工作流那一轮同样要起标题,而这件事和"这一轮跑不跑
    // provider 回合"没有关系(放在分岔之后时,图型会话永远拿不到生成的标题)。
    if (isFirstMessage) {
      void generateSessionTitle(updated, input.prompt).catch((err) =>
        log.warn(`title generation failed for ${session.id}: ${(err as Error).message}`),
      );
    }
    // 图型工作流:这一轮**不跑会话自己的回合**,而是把那张图推一遍。节点各自跑在
    // 自己的隐藏子会话里,它们的交互事件代这个对话提问(见 `orchestration/runner.ts`)。
    //
    // ⚠️ **不 await 整张图跑完** —— 用户可能要在中间回答某个节点的问题,那要几分钟;
    // 这个 IPC 该立刻返回,让输入框回到可用状态。这一轮的收口由调度器最后补的那个
    // `turn.done` 完成。
    //
    // 岔路的**判断**已在上面(改状态之前)定下,这里只落点。
    if (run === "start") {
      // 不 await(一次图运行可能几分钟),但也不能裸 `void`:引擎预检失败会抛,
      // 裸 void 让它成为主进程 unhandledRejection,渲染端却停在“正在运行” ——
      // `launchContinuation` 接住并给会话补 `error` + `turn.done(error)`(BUG-M28-02
      // 的同型缺口,M28 报告点名本处)。
      launchContinuation(updated, "起跑", {
        session: updated,
        cwd,
        prompt: input.prompt,
        userMessage: input.userMessage,
      });
      return { session: updated };
    }
    const handle = await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd,
      skills: input.skills,
      images: input.images,
      // User-message echo payload from the renderer (cross-client bubble).
      userMessage: input.userMessage,
    });
    // null = 这一轮没有启动(上一轮仍在运行)。必须拒绝:渲染端已乐观地把会话标成
    // 运行中,若照常返回,它会一直转圈等一个永远不会来的 turn.done,消息也没发出去。
    if (handle === null) throw new Error("这个对话上一轮还在运行，消息未发送：请等本轮结束或按停止后再发");
    // Return the in-memory `updated` snapshot (it already carries every
    // per-turn override above — including providerId). Re-reading from the DB
    // here would hand back a stale providerId (the per-turn provider override
    // is intentionally NOT persisted), which the renderer then uses to
    // replace its cached session row and flip the thread icon to the wrong
    // SDK. updated has title/model/effort/permissionMode/customModelId/
    // providerId patched in; the DB-only `status` flip is surfaced via the
    // event stream, so it doesn't need to ride this return value.
    return { session: updated };
    } catch (err) {
      // 没走到"运行时接管了这一轮"就把状态放回去，别把会话钉死在 running。
      SessionRepo.updateStatus(session.id, "idle");
      throw err;
    }
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    const input = InterruptSchema.parse(raw);
    // 图型工作流没有"会话自己的回合"可以打断 —— 要停的是**整张图**:调度器不再
    // 派发新的节点,并在飞的节点逐个 interrupt(见 `orchestration/runner.ts`)。
    if (cancelWorkflowRun(input.sessionId)) {
      SessionRepo.updateStatus(input.sessionId, "interrupted");
      return;
    }
    runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
  });

  /**
   * 停掉某一个正在跑的子任务（子代理）—— 右栏「任务列表」页那一行的停止按钮。
   *
   * ⚠️ **不碰会话状态、也不调 `cancelWorkflowRun`。** 它和 `interrupt` 的粒度不同：
   * `interrupt` 是"停这一轮"（所以要把会话标成 interrupted、图要整张停），
   * 这个是"停这一个分身"，主体继续跑、会话照旧 running。
   * 拿 interrupt 那套语义套上来会**误停整轮** —— 那是灾难性的（用户只想收掉一个分身）。
   *
   * 返回 `{ stopped }` 而不是抛：停不成是正常的（已经跑完了、引擎没这个能力），
   * 界面据实说一句就行。
   */
  ipcMain.handle(IPC.CLAUDE_STOP_TASK, async (_evt, raw) => {
    const input = StopTaskSchema.parse(raw);
    return runtimeManager.stopTask(input.sessionId, input.taskId);
  });

  /**
   * 读一个 **bash 任务**的输出（右栏「任务列表」页点开一条 bash 任务时用）。
   *
   * ⚠️ **这是一条读文件的口子，但路径不由渲染端决定** —— 渲染端只给 `(sessionId, taskId)`，
   * 路径由 `RuntimeManager` 从**我们自己的快照**里查（见 `readTaskOutput`）。查完还要过
   * `isAllowedTaskOutputPath` 那道正向校验（必须在 `tasks/` 下、`.output` 结尾）。
   * 读不到时抛 —— 渲染端会画成一句红字（与 `stopTask` 的"回 false"不同：那是正常结果，
   * 这是"你要看的东西读不出来"，该让人看见）。
   */
  ipcMain.handle(IPC.CLAUDE_READ_TASK_OUTPUT, async (_evt, raw) => {
    const input = ReadTaskOutputSchema.parse(raw);
    return runtimeManager.readTaskOutput(input.sessionId, input.taskId);
  });

  /**
   * 生成过程中插一句话。**不打断这一轮** —— 模型在下一个安全点看到它(可能正在跑一个
   * 工具,所以不是立刻)。
   *
   * 这里不写状态、不落库:那条用户消息由**渲染端**在收到 `delivered: true` 之后立刻
   * 落库(和 `sendPrompt` 同一条规矩 —— 这一轮可能永远到不了终态,而"我补过一句什么"
   * 不能跟着一起没掉)。主进程这边只管"塞进去了没有"。
   */
  ipcMain.handle(IPC.CLAUDE_INJECT, (_evt, raw) => {
    const input = InjectSchema.parse(raw);
    return { delivered: runtimeManager.injectMessage(input.sessionId, input.text) };
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    const input = ApproveSchema.parse(raw);
    const resolved = runtimeManager.resolveApproval(
      input.requestId,
      input.granted,
      input.granted ? undefined : "Denied by user",
      input.always,
    );
    if (!resolved) {
      // 【UI-035】找不到待审请求(已响应 / 会话中止 / 事件迟到)→ 回可判别回执,不再静默 void。
      log.warn(`approval: no pending request for id ${input.requestId}`);
      return { status: "not_found" as const, requestId: input.requestId };
    }
    return { status: "accepted" as const, requestId: input.requestId };
  });

  // ── AskUserQuestion answer: resolve the provider's pending user-input
  //    Deferred. The provider's canUseTool await resumes and the turn
  //    continues in the SAME query() — this is what makes the conversation
  //    proceed after the user submits answers.
  //    For `sentinel_`-prefixed ids (fallback path when the native tool is
  //    unavailable), there's no Deferred to resolve — the turn already ended
  //    when the model finished emitting. We compose the answers into a prompt
  //    and start a new turn, prepended with a hint so the model recognizes it
  //    as the answer to its prior question.
  ipcMain.handle(IPC.CLAUDE_RESPOND_QUESTION, async (_evt, raw) => {
    const input = RespondQuestionSchema.parse(raw);

    // Dismissed: the user closed the question card. Sentinel requests have no
    // Deferred (the turn already ended) — nothing to resume; still broadcast
    // the cross-client close so other clients drop their copy of the card.
    if (input.dismissed) {
      if (input.requestId.startsWith("sentinel_")) {
        runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
        return;
      }
      const resolved = runtimeManager.dismissUserInput(input.requestId);
      if (!resolved) {
        log.warn(`respondQuestion(dismiss): no pending request for id ${input.requestId}`);
      }
      return;
    }

    if (input.requestId.startsWith("sentinel_")) {
      // No Deferred exists — tell every other client to close their copy of
      // the question card (this answer was accepted from one client only).
      runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
      const session = SessionRepo.get(input.sessionId);
      if (!session) {
        log.warn(`respondQuestion(sentinel): session not found ${input.sessionId}`);
        return;
      }
      const project = ProjectRepo.get(session.projectId);
      if (!project) {
        log.warn(`respondQuestion(sentinel): project not found for session ${input.sessionId}`);
        return;
      }
      const prompt = composeSentinelAnswerPrompt(input.answers);
      SessionRepo.updateStatus(session.id, "running");
      runtimeManager.bindSession(session);
      // Worktree sessions are always materialized by the time a sentinel
      // follow-up exists (the first turn created it) — route the cwd the
      // same way sendTurn does so the answer lands in the right checkout.
      //
      // ⚠️ **必须与主发送那条路一样把状态放回。** 上面刚把 status 置成 running,若
      // provider 预检在这一步抛错而没人收尾,会话就被**永久钉在 running**:
      // `findFreshByProject` 不会再复用它、所有端都显示"运行中"。主发送那条路正是
      // 为此套了 try/catch(见下面 `sendTurn` 的 catch),这里从前漏了。
      try {
        await runtimeManager.sendTurn(session, {
          prompt,
          cwd: session.worktreePath ?? project.path,
        });
      } catch (err) {
        SessionRepo.updateStatus(session.id, "idle");
        throw err;
      }
      return;
    }

    const resolved = runtimeManager.resolveUserInput(input.requestId, input.answers);
    if (!resolved) {
      log.warn(`respondQuestion: no pending request for id ${input.requestId}`);
    }
  });

  // ── ExitPlanMode plan-approval decision: resolve the provider's pending
  //    plan-approval Deferred. The provider's canUseTool await resumes and
  //    returns allow (exit plan mode) or deny (stay in plan mode) to the SDK,
  //    continuing the SAME query() turn.
  ipcMain.handle(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, async (_evt, raw) => {
    const input = RespondPlanApprovalSchema.parse(raw);
    const resolved = runtimeManager.resolvePlanApproval(input.requestId, {
      approved: input.approved,
      editedPlan: input.editedPlan,
      reason: input.reason,
      feedback: input.feedback,
    });
    if (!resolved) {
      // 【UI-035】同 CLAUDE_APPROVE:找不到待审计划请求 → 回可判别回执,不静默 void。
      log.warn(`respondPlanApproval: no pending request for id ${input.requestId}`);
      return { status: "not_found" as const, requestId: input.requestId };
    }
    return { status: "accepted" as const, requestId: input.requestId };
  });

  // ── Rewind a turn: restore the given files to their pre-turn state.
  //    The renderer passes the explicit entries (the card's own frozen
  //    list), so this works for the latest turn, any historical turn,
  //    and a session reopened after restart alike. Returns the list of
  //    paths that were actually restored so the renderer can show a
  //    "N 个文件已恢复" breadcrumb. ──
  ipcMain.handle(IPC.CLAUDE_REWIND_TURN, async (_evt, raw) => {
    const input = RewindTurnSchema.parse(raw);
    const { restored, failed, conflicts } = await runtimeManager.rewindTurn(
      input.sessionId,
      input.files,
      input.targetFiles,
    );
    return { restored, failed, conflicts };
  });

  // ── Settings → 子代理：保存自定义子代理列表（Claude provider 专用，见
  //    capabilities.supportsCustomSubagents）。main 侧严格校验（名称/描述/
  //    提示词等，见 subagentStore），校验失败把错误抛给渲染端 toast；成功
  //    返回规范化后的列表让编辑器对齐实际落盘内容。读取走通用 SETTING_GET。 ──
  ipcMain.handle(IPC.CLAUDE_SUBAGENTS_SAVE, (_evt, raw) => {
    const input = ClaudeSubagentsSaveSchema.parse(raw);
    const res = saveSubagents(input.subagents);
    if (!res.ok) throw new Error(res.error);
    return { subagents: res.subagents };
  });

  // ── Provider listing ──
  ipcMain.handle(IPC.PROVIDER_LIST, () => {
    const providers = providerRegistry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    }));
    return { providers };
  });

  ipcMain.handle(IPC.PROVIDER_HEALTH_CHECK, async (_evt, raw) => {
    const input = ProviderHealthCheckSchema.parse(raw);
    return probeProviderHealth(input.providerId, { force: input.force });
  });

  // 引擎自己的斜杠命令清单（见 rpcMap 里 `provider.commands` 的说明）。存在的理由是
  // **时机**：事件那条路（system/init）只在开跑一轮时才发，而用户打开 `/` 菜单看命令
  // 恰恰是在还没发消息的时候。
  //
  // 取不到就**抛**（引擎没装、CLI 起不来、超时）—— 让渲染端能区分"引擎坏了"和
  // "引擎没有命令"（后者返回 supported:false + 空数组，见 `ProviderCommandsResult`）。
  ipcMain.handle(IPC.PROVIDER_COMMANDS, async (_evt, raw) => {
    const input = ProviderCommandsSchema.parse(raw);
    const provider = providerRegistry.get(input.providerId);
    if (!provider) {
      throw new Error(`未注册的引擎：${input.providerId}`);
    }
    return provider.listCommands({ cwd: input.cwd });
  });

  // ── P2: message persistence ──
  ipcMain.handle(IPC.SESSION_SAVE_MESSAGES, (_evt, raw) => {
    const input = SaveMessagesSchema.parse(raw) as SaveMessagesInput;
    MessageRepo.replaceAll(input.sessionId, input.messages);
  });

  ipcMain.handle(IPC.SESSION_UPSERT_MESSAGES, (_evt, raw) => {
    const input = UpsertMessagesSchema.parse(raw) as UpsertMessagesInput;
    // The host-validated outer sessionId is authoritative. Embedded rows
    // cannot silently redirect a single upsert IPC into another session.
    MessageRepo.upsertMany(input.messages, input.sessionId);
  });

  ipcMain.handle(IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES, (_evt, raw) => {
    const input = TruncateAndInsertMessagesSchema.parse(raw) as TruncateAndInsertMessagesInput;
    MessageRepo.truncateFromAndInsert(
      input.sessionId,
      { createdAt: input.cursorCreatedAt, id: input.cursorId },
      input.messages,
    );
  });

  ipcMain.handle(IPC.SESSION_MESSAGES, (_evt, raw) => {
    const input = SessionMessagesSchema.parse(raw);
    const res = MessageRepo.listBySession(input.sessionId, {
      limit: input.limit,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
    });
    return { messages: res.messages, hasMore: res.hasMore };
  });

  /**
   * 把一段对话分叉成新的一段(右键左栏的对话 → 复制一份)。
   *
   * 那一整套(先在引擎那边复制上下文、再建行、再抄消息,以及**顺序为什么不能反**)
   * 在 `lib/sessionFork.ts` 里 —— 它要能在没有 Electron 的环境里被单跑一遍。
   * 这里只解析参数。
   */
  ipcMain.handle(IPC.SESSION_FORK, async (_evt, raw) => {
    const input = ForkSessionSchema.parse(raw);
    return { session: await forkSessionIntoNew(input.id, input.title) };
  });

  // ── Settings ──
  ipcMain.handle(IPC.SETTING_GET, (_evt, raw) => {
    const input = GetSettingSchema.parse(raw);
    return { value: SettingRepo.get(input.key) };
  });

  ipcMain.handle(IPC.SETTING_SET, (_evt, raw) => {
    const input = SetSettingSchema.parse(raw);
    // 【ARC-006 创建≠执行授权】**执行信任事实不走通用设置写。**
    // `workflow.review.v1.<id>` 是"这条自动化 / 外来工作流能不能无人值守执行"的
    // 唯一事实,它的签发只属于用户在工作流页面上对**当前存盘版本**的一次点击
    // (`workflow.approve` 对 Agent 是 blocked)。放行 `setting.set` 等于给 Agent
    // (经 `app_api_call`,该档是每次审批的写)与自定义面板开第二条签字路 ——
    // 模型可以先把值读出来再原样写回,批准就变成了"点一次设置写入"。
    // 同一档还有 `workflow.pinnedDefaults`(「恢复默认」快照):那份文档恢复时
    // **直接落库、不过审**,它的信任前提是"只由 pinWorkflowDefault 写入";放行通用写
    // 就成了一条"先种快照、再让用户/Agent 点一次恢复默认"的免审执行路。
    // fail-closed:抛错(渲染端正常路径从不写这两族;手机的 `setting:set` 另有
    // 白名单,同样够不到它们)。判据与设置导入 / 导出共用一份。
    if (isWorkflowExecutionTrustSettingKey(input.key)) {
      throw new Error("工作流审批记录与「恢复默认」快照不能被通用设置写入改写;请在 设置 → 工作流/自动化 里审查当前版本并明确启用");
    }
    if (input.key === CUSTOM_UI_SETTING_KEY) validateCustomUiWrite(input.value);
    // 【MC-083 残余】轮预算这条键:主值 + `.last-good` 备份必须**同一次事务**里一起落盘。
    // 从前 last-good 只在**下一次** sendTurn 读到合法主值时补刷 —— 用户把额度从 A 改成 B
    // 并保存成功,却在下一轮开始前主键就坏了(写入中断/外部改),恢复出来的会是**旧额度 A**
    // 而非刚确认的 B。这里把"保存成功"本身当成权威提交点:一次 `setMany` 同时写主键与备份,
    // 要么都写、要么都不写。仅当这次提交**够格**(VALID 启用限额 / DISABLED 明确关闭)才刷备份;
    // 空值(MISSING)与坏值(INVALID)不刷,免得一份坏提交盖掉上一份好的。
    // `RuntimeManager.sendTurnBound` 里那段"读到合法值就补刷"的兜底保留(幂等),权威点在此。
    if (input.key === TURN_BUDGET_SETTING_KEY) {
      const lastGoodKey = lastGoodTurnBudgetKey(TURN_BUDGET_SETTING_KEY);
      const entries: Array<readonly [string, string]> = [[input.key, input.value]];
      if (budgetCommitWorthBackingUp(input.value)) entries.push([lastGoodKey, input.value]);
      SettingRepo.setMany(entries);
    } else {
      SettingRepo.set(input.key, input.value);
    }
    // 【资料库缓存失效】`library.groups` / `library.suppress` 的**正常**写口是
    // `saveLibraryGroups` / `saveSuppress`(设置页),它们写完会同步刷新各自的缓存。
    // 而通用设置写是同一个键的**第二个写者**(Agent 的 `app_api_call`、自定义面板的
    // `mcode.api.call` 都够得到这里):落库了、进程内缓存却不知道,`groupPromptOf` /
    // 屏蔽判定会一直停在旧表上直到重启 —— 而"屏蔽没生效"是用户会当成安全问题的那
    // 一侧。判据走契约里的共享键常量,不在这里另写字面量。
    if (input.key === LIBRARY_GROUPS_SETTING_KEY) {
      invalidateLibraryGroupsCache();
    } else if (input.key === LIBRARY_SUPPRESS_SETTING_KEY) {
      invalidateSuppressCache();
    }
    // 「跟着人走」的键(语言、强调色、自定义命令、快捷键……)写完推给已配对的
    // 手机,当场生效;桌面自己也会收到回声,套用是幂等的。键表见
    // `@contracts/ipc/settingsSync`。
    if (isSyncedSettingKey(input.key)) broadcastSettingChanged(input.key, input.value);
    // The theme STYLE repaints native chrome accents (win/linux title-bar
    // overlay) that only main can reach — the renderer's .sketch class does
    // nothing for them. Refresh on flip; every other key has no main-side
    // visual. Best-effort: before the window exists (or on macOS, where
    // updateTitleBarOverlay no-ops) this is a harmless no-op.
    if (input.key === THEME_STYLE_SETTING_KEY) {
      try {
        updateTitleBarOverlay();
      } catch {
        // Window not created yet — initTheme's startup sync covers it.
      }
    }
  });

  ipcMain.handle(IPC.SETTING_GET_MANY, (_evt, raw) => {
    const input = GetManySettingsSchema.parse(raw);
    return SettingRepo.getMany(input.keys);
  });

  // ── Per-session settings (model / effort / permissionMode / customModelId) ──
  // Persist to DB AND, when permissionMode is present, sync the live value
  // into the ApprovalBridge so a mid-turn mode flip takes effect for the
  // next tool call (canUseTool reads the bridge's current value).
  ipcMain.handle(IPC.SESSION_UPDATE_SETTINGS, (_evt, raw) => {
    const input = UpdateSessionSettingsSchema.parse(raw);
    // Directory re-aim (new-session panel's directory switcher). Honored
    // ONLY for a thread that hasn't started — no persisted messages, no
    // materialized worktree — and only onto an existing non-archived
    // project. Anything else rejects the WHOLE call so the renderer keeps
    // its caches instead of half-applying a move.
    if (input.projectId !== undefined) {
      const sess = SessionRepo.get(input.sessionId);
      if (!sess) throw new Error(`updateSettings: unknown session ${input.sessionId}`);
      const target = ProjectRepo.get(input.projectId);
      if (!target || target.archived) {
        throw new Error("updateSettings: move target project missing or archived");
      }
      if (sess.worktreePath) {
        throw new Error("updateSettings: session already materialized in a worktree");
      }
      if (MessageRepo.hasAny(input.sessionId)) {
        throw new Error("updateSettings: session already has messages");
      }
      if (sess.projectId !== input.projectId) {
        SessionRepo.updateSettings(input.sessionId, { projectId: input.projectId });
      }
    }
    // **三个字段各有各的「首条消息后锁定」。** schema 的注释白纸黑字写着
    // providerId「once a turn has run the provider is fixed」、envMode/wtStyle
    // 「only meaningful while the session is un-materialized」—— 而那两道守卫此前
    // **只长在 `projectId` 那一支里**。单独发 `{sessionId, providerId}` 就能改一条
    // 已经跑过对话的会话的引擎:DB 行被改,而运行时(捕获的是启动那一刻的 provider)
    // 纹丝不动 —— 界面上是 A 引擎,实际跑的是 B,一句提示都没有。
    //
    // 与 projectId 同一取舍:**整条拒**,而不是"悄悄忽略这个字段" —— 后者会让渲染端
    // 以为改成功了(它没有回读),下次同步又弹回原样,用户看着像"改了没用"。
    if (input.providerId !== undefined || input.envMode !== undefined || input.wtStyle !== undefined) {
      const sess = SessionRepo.get(input.sessionId);
      if (!sess) throw new Error(`updateSettings: unknown session ${input.sessionId}`);
      if (input.providerId !== undefined && MessageRepo.hasAny(input.sessionId)) {
        throw new Error("updateSettings: providerId is fixed once a session has messages");
      }
      if ((input.envMode !== undefined || input.wtStyle !== undefined) && sess.worktreePath) {
        throw new Error("updateSettings: environment is fixed once the worktree is materialized");
      }
    }
    SessionRepo.updateSettings(input.sessionId, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      workflowId: workflowIdFromInput(input),
      customModelId: input.customModelId,
      providerId: input.providerId,
      envMode: input.envMode,
      wtStyle: input.wtStyle,
    });
    if (input.permissionMode) {
      runtimeManager.setPermissionMode(input.sessionId, input.permissionMode);
    }
    // Broadcast the fresh row so every other client (phones) re-syncs its
    // session list AND its composer chips for this thread.
    const updated = SessionRepo.get(input.sessionId);
    if (updated) broadcastSessionChanged(updated);
  });
}

/**
 * Compose the user's answers (from sentinel-fallback AskUserQuestion) into a
 * prompt for the next turn. The sentinel path can't block the SDK turn, so we
 * send answers as a new user message prefixed with a hint so the model knows
 * these are answers to its prior question, not a fresh instruction.
 */
function composeSentinelAnswerPrompt(answers: UserInputAnswers): string {
  const lines: string[] = ["(Answers to your previous question:)"];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    const value = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`${question}\n→ ${value}`);
  }
  return lines.join("\n\n");
}
