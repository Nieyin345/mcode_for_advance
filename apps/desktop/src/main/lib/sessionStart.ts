import { replaceBackflowSource } from "@main/lib/pendingBackflow.js";
import type { Session } from "@contracts/session";
import type { StartSessionInput } from "@contracts/ipc";
import { defaultProviderId } from "@main/providers/defaultProvider.js";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { normPathKey } from "@main/lib/pathNorm.js";
import { agentProfilesDir } from "@main/orchestration/agentProfiles.js";
import {
  loadAgentProfileForSession,
  profileSeedOf,
  sessionMemorySnapshot,
  type SessionProfileSeed,
} from "@main/lib/sessionAgentProfile.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Shared implementation behind the desktop `claude:startSession` IPC and the
 *  mobile RPC of the same name: create a session row for a "new session"
 *  click — or REUSE the project's existing still-fresh row instead of
 *  stacking empty ones.
 *
 *  Reuse = bump the fresh row's `updated_at` (floating it back to the head of
 *  the project list, which sorts by `updated_at DESC`) and re-aim it at the
 *  requester's current config. A brand-new row is only created when the
 *  project has no fresh row left (first click, or the previous one was
 *  used/archived/deleted). */
/** Validate and apply a worktree BIND intent: the named directory must be
 *  an already-materialized worktree of some other session (never a raw
 *  arbitrary path — that would let a session escape the managed roots), and
 *  only meaningful with envMode="worktree". Writes the path onto the fresh
 *  row so its first turn reuses the checkout instead of creating one. */
function applyWorktreeBind(input: StartSessionInput, sessionId: string): void {
  if (input.envMode !== "worktree" || !input.worktreePath) return;
  const roots = SessionRepo.listWorktreeRoots();
  const target = normPathKey(input.worktreePath);
  if (!roots.some((r) => normPathKey(r) === target)) {
    log.warn(`worktree bind ignored — ${input.worktreePath} is not a managed worktree root`);
    return;
  }
  SessionRepo.updateWorktreePath(sessionId, input.worktreePath);
  log.info(`session ${sessionId} bound to existing worktree ${input.worktreePath}`);
}

/** Worktree intent can only materialize where the PROJECT ROOT is itself a
 *  git repo. The persisted new-session default (`session.worktreeDefault`)
 *  is project-agnostic, so a worktree choice made in one repo leaks into
 *  non-repo projects — where the composer chip is hidden and the user has no
 *  UI to flip it back, bricking the first turn (resolveSessionCwd). Coerce
 *  such rows to local right here. A BIND (explicit worktreePath) always
 *  survives: its checkout already exists, so the project root's repo-ness is
 *  irrelevant. */
function coerceEnvMode(input: StartSessionInput): "local" | "worktree" {
  if (input.envMode !== "worktree" || input.worktreePath) return input.envMode ?? "local";
  const project = ProjectRepo.get(input.projectId);
  // Unknown project: leave the intent alone, the turn path will fail loudly.
  if (!project) return "worktree";
  if (!existsSync(join(project.path, ".git"))) {
    log.warn(`worktree intent ignored — project root is not a git repo: ${project.path}`);
    return "local";
  }
  return "worktree";
}

/** 建一个「带角色的子对话」时要落进会话行的那一份。见 `sessionAgentProfile.ts`。 */
export interface AgentSeededSideInput {
  /** 挑中的档案 —— **读不到就直接抛**,不退回"没有角色的空会话"(见 handler 的注释)。 */
  profileId: string;
  /** 「档案+记忆」那一档:建会话时把记忆快照挂进第一轮。 */
  memory: boolean;
}

/**
 * 「新建子对话」这一条路要的档案快照。**在复用判断之前解出来** —— 理由有两条:
 *
 *  1. 档案读不到时,这一条会话**根本不该建出来**(也不该复用到一条旧的),所以必须在
 *     动任何一行之前就失败;
 *  2. 复用那条路要拿档案名去认"上一次为这份档案开的那个空壳"(见 `findFresh...` 的
 *     `agent_profile` 判据),所以名字得先有。
 */
function resolveProfileSeed(profileId: string): SessionProfileSeed {
  const loaded = loadAgentProfileForSession(profileId, agentProfilesDir());
  if (!loaded.ok) throw new Error(loaded.error);
  return profileSeedOf(loaded.profile);
}

/**
 * **会话行的修订号** —— 「建会话 + 发首条」这条业务命令的乐观并发判据(ARC-001 步③:
 * `ActionContext.expectedRevision`)。
 *
 * ## 它是什么
 *
 * 一次会话行写入(改设置 / 改标题 / 改状态 / 绑工作树…)都会把 `updated_at` 盖章成现在
 * (`SessionRepo` 里每一条 UPDATE 都带 `updated_at = Date.now()`)。所以**一行的 `updatedAt`
 * 就是这一行"被改到第几版"的单调标记** —— 调用方读完一条空壳、拿到它的修订号,再带着这个
 * 修订号来命令,就能断言"我读到的那份还没被别的写入动过"。
 *
 * ## 为什么不是整库的 durableRevision(如实记录)
 *
 * 台账 ARC-009 的 `durableRevision`(`store/db.ts`)是**整库** fsync 序号,本切片**没有**用它,
 * 两个原因都是可核对的:① 那个计数器住在 `store/db.ts` 的模块私有 `let` 里,**没有任何纯读取
 * 出口**(唯一接近的 `commitNow()` 会强推一次 fsync 并让计数器自增,是副作用不是读);本切片
 * 改动面不含 `store/db.ts`(另一条车道拥有它),不去动它。② 它**进程内**、每次启动归零
 * (见文件头「进程内单调、不跨进程比较」),拿它当 OCC 令牌会在重启后对不上。会话命令的
 * **自然修订号是会话行自己的 `updatedAt`**,所以本切片用它。
 */
export function sessionRevisionOf(session: Session): string {
  return String(session.updatedAt);
}

/**
 * 修订号对不上 —— 调用方要复用/断言的那条会话已经不是它读到的那一版。**什么都没执行**:
 * 没建行、没复用、没发首条。上层据此拒绝(见 `appControl/tools.ts` 的 REJECTED 映射),
 * **绝不静默新建一条调用方没预期的会话**(硬规矩 3:坏东西显式报出来)。形状与
 * `memory/store.ts` 的 `MemoryConflictError` 同款。
 */
export class SessionRevisionConflictError extends Error {
  readonly code = "revision_conflict";
  /** 调用方断言的修订号(原样带回,便于上层/日志点名)。 */
  readonly expected: string;
  /** 当前实际修订号;没有可复用的空壳时为 null。 */
  readonly actual: string | null;
  constructor(expected: string, actual: string | null) {
    super(
      actual === null
        ? `会话修订号对不上:调用方断言的是「${expected}」,但项目里已没有可复用的「新对话」空壳` +
          "(它已被使用 / 归档 / 删除)。请重新读取当前状态后再重试。"
        : `会话修订号对不上:调用方断言「${expected}」,当前实际「${actual}」` +
          "(这条空壳在你读取之后已被改过)。请重新读取最新状态、合并后再重试。",
    );
    this.name = "SessionRevisionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 复用前的乐观并发闸。`expectedRevision` 缺席 = 不启用(既有调用方一律不受影响);
 * 给了就**必须**与这条空壳当前修订号逐字节相同,否则抛 {@link SessionRevisionConflictError}。
 */
function assertSessionRevision(fresh: Session, expectedRevision: string | undefined): void {
  if (expectedRevision === undefined) return;
  const actual = sessionRevisionOf(fresh);
  if (actual !== expectedRevision) throw new SessionRevisionConflictError(expectedRevision, actual);
}

/** 「复用」不能跨角色。见 {@link createOrReuseSession} 里 side 那一段的注释。 */
function sameProfile(session: Session, seed: SessionProfileSeed | null): boolean {
  const stored = session.agentProfile ?? null;
  if (seed === null) return stored === null;
  return stored !== null && stored.id === seed.ref.id;
}

/** Creation snapshot for the first side-chat turn. Reusing an unstarted shell
 * refreshes/revokes only this producer's slot; independent workflow outputs survive.
 * Once sent, provider history is not erased or silently refreshed. Fresh facts can
 * still be requested through scoped memory tools. Runtime uses producer-specific
 * framing so a creation snapshot is not presented as a workflow execution result. */
function queueSessionMemory(sessionId: string, enabled: boolean): void {
  const owner = SessionRepo.get(sessionId);
  const snapshot = enabled && owner ? sessionMemorySnapshot(owner.projectId).trim() : "";
  // Empty/disabled is an explicit revocation, not a no-op. Other producers survive.
  replaceBackflowSource(sessionId, "memory.creation-snapshot", snapshot);
}

export function createOrReuseSession(
  input: StartSessionInput,
  source: "desktop" | "mobile",
  /**
   * 可选**乐观并发修订号**(ARC-001 步③:`ActionContext.expectedRevision`)。给了就启用
   * OCC:复用判据挑中的那条空壳,**当前修订号必须逐字节等于它**,否则抛
   * {@link SessionRevisionConflictError};给了却**没有任何可复用的空壳**(会被使用 / 归档 /
   * 删除,或这条请求带显式标题因而根本不复用)同样抛 —— 调用方断言的是"复用第 X 版的那个
   * 壳",静默去新建一条它没预期的会话正是要堵的口子。缺席 = 不启用,既有调用方行为不变。
   *
   * 修订号 = 会话行的 `updatedAt`(见 {@link sessionRevisionOf} 的文件头:为什么是它,
   * 以及为什么**没有**用整库的 `durableRevision`)。
   */
  expectedRevision?: string,
): { session: Session; reused: boolean } {
  // Side-chat Q&A sessions: reuse the parent's still-fresh "Quick ask" row
  // when one exists (same anti-stacking rule as main sessions below — a
  // placeholder title means the first question never landed, so the shell is
  // empty and refocusing it beats creating another one). No session.changed
  // broadcast — side chats are invisible to the left-bar/mobile lists by
  // design; the desktop ask tab consumes the IPC return value directly and
  // mobile doesn't manage side chats at all.
  if (input.kind === "side") {
    // 引擎/模型**默认继承父会话**(报告附录 N 的 N4)。用户从界面建子对话时,渲染端会把
    // 当前那套(自定义模型 / 引擎 / 模型)传进来;而 agent 经接口建(`app_api_call` 那类)
    // 往往不传 providerId/model/customModelId —— 从前它们就落到内置默认(未登录的 Claude),
    // 于是同一个子对话「用户建能跑、agent 建 Not logged in」。这里补一条继承:没显式给的
    // 字段,从父会话那一行取。**显式给的一律优先**(调用方明确指定就该听它)。
    //
    // ⚠️ **只继承这三个真正可选的字段**(providerId / model / customModelId):它们的 schema
    // 是 `.optional()`,`undefined` 能如实表达"调用方没给"。而 `effort` / `permissionMode`
    // 的 schema 带 `.default("default")`,到了这里**永远有值** —— 分不清"没给"与"就要默认",
    // 硬继承会把界面上显式选的「默认」也覆盖成父会话的非默认值(那是回归,不是修复)。
    const parent = input.parentSessionId ? SessionRepo.get(input.parentSessionId) : undefined;
    const effProviderId = input.providerId ?? parent?.providerId ?? defaultProviderId();
    const effModel = input.model ?? parent?.model ?? "default";
    const effCustomModelId = input.customModelId !== undefined ? input.customModelId : (parent?.customModelId ?? null);
    // 「新建子对话 → 档案 / 档案+记忆」:建会话那一刻把档案抄成一份快照(见
    // `sessionAgentProfile.ts` 的文件头 —— 为什么是快照不是每轮回读)。
    const seed = input.agentProfileId ? resolveProfileSeed(input.agentProfileId) : null;
    if (input.parentSessionId) {
      // `seed === null` 传 null(「空白」只跟"同样没有角色"的壳复用),`undefined` 会
      // 退回"不看角色"的老行为 —— 那正是这里要避免的,所以这个参数必须**总是**给。
      const fresh = SessionRepo.findFreshSideByParent(input.parentSessionId, seed ? seed.ref.id : null);
      // ⚠️ **复用要看角色对不对得上。** 「空白」「档案甲」「档案甲+记忆」都是同一个
      // kind="side"、同一个占位标题,所以如果只按标题复用,用户点「档案甲」会拿到上一次
      // 点「空白」留下的那个空壳 —— 而那个壳**看不见**角色是否存在(建完就打开了,用户
      // 只会发现"它不是那个角色")。对不上的时候宁可不复用:多一个空壳,也不要一个错的。
      if (fresh && sameProfile(fresh, seed)) {
        // 【ARC-001 步③】乐观并发闸:调用方断言的就是"复用第 X 版的那个空壳" ——
        // 修订号对不上就**当场拒绝**(还没写任何一行),绝不静默复用到另一版。
        assertSessionRevision(fresh, expectedRevision);
        // Re-aim at the current composer config (updateSettings skips
        // undefined fields and bumps updated_at; the ask tab sorts by
        // created_at, so the row stays in place in its list).
        SessionRepo.updateSettings(fresh.id, {
          providerId: effProviderId,
          model: effModel,
          effort: input.effort,
          permissionMode: input.permissionMode,
          customModelId: effCustomModelId,
        });
        const session = SessionRepo.get(fresh.id) ?? fresh;
        // 记忆**每一次都重新挂**:复用的那个壳还没有任何消息(它的占位标题就是"没发过
        // 言"的判据),所以现在取的那份快照仍然会进真正的第一轮 —— 复用不会让记忆变旧。
        queueSessionMemory(session.id, input.memory === true);
        runtimeManager.bindSession(session);
        log.info(`side chat reused: ${session.id} (parent ${input.parentSessionId}, project ${input.projectId}, ${source})`);
        return { session, reused: true };
      }
    }
    // 【ARC-001 步③】带 expectedRevision 却没有可复用的空壳(没有父会话 / 没有空壳 /
    // 角色对不上)= 调用方断言的那一版根本不在 → 拒绝,不静默新建一条它没预期的会话。
    if (expectedRevision !== undefined) throw new SessionRevisionConflictError(expectedRevision, null);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      providerId: effProviderId,
      claudeSessionId: null, // captured from system/init once the first turn runs
      kind: "side",
      parentSessionId: input.parentSessionId ?? null,
      nodeId: null,
      agentProfile: seed?.ref ?? null,
      // Placeholder until the first question rewrites it (sendTurn truncates
      // the first prompt to ~40 chars — same rule as main-session auto-title,
      // but no generateSessionTitle LLM call).
      //
      // ⚠️ **带角色的那两档不占位**:用档案名当标题,并且**不**参与"还没发过言"的判据
      // (那个判据只看 `title === "Quick ask"`)—— 于是它第一次发言时不会被那 40 个字
      // 覆盖掉。用户挑的是"它叫这个、它是这个角色",把名字换成他打的第一句话等于把他
      // 挑的那件事抹掉。
      title: seed?.title ?? "Quick ask",
      status: "idle",
      model: effModel,
      effort: input.effort,
      permissionMode: input.permissionMode,
      // A new thread always starts in 默认 — deliberately NOT inheriting the
      // previous thread's composer mode: 文献检索 swallows the send entirely
      // (no model call), so silently carrying it into a fresh chat would eat
      // the user's first message. The mode is picked per thread.
      workflowId: "default",
      customModelId: effCustomModelId,
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
    // 记忆挂在**建行之后** —— `bindSession` 会建一样新东西(`RuntimeState`),顺序在这里
    // 只关系到"取用之前队列里已经有没有"。队列本身是按 sessionId 的,先建后挂不影响。
    queueSessionMemory(session.id, input.memory === true);
    runtimeManager.bindSession(session);
    log.info(
      `side chat started: ${session.id} (parent ${input.parentSessionId ?? "?"}, project ${input.projectId}, ${source})`,
    );
    return { session, reused: false };
  }

  // Coerced environment (non-repo projects can't carry worktree intent —
  // see coerceEnvMode); computed once for both write paths below.
  const envMode = coerceEnvMode(input);

  // Only a default-title request can reuse — an explicit title (none of our
  // UIs send one today) always deserves its own row.
  if (input.title === undefined || input.title === "New session") {
    const fresh = SessionRepo.findFreshByProject(input.projectId);
    if (fresh) {
      // 【ARC-001 步③】乐观并发闸:调用方断言"复用第 X 版的那个空壳",修订号对不上就
      // **当场拒绝**(还没写任何一行),绝不静默复用到另一版。
      assertSessionRevision(fresh, expectedRevision);
      // Re-aim at the current composer config. `updateSettings` skips
      // undefined fields, so unset inputs keep the row's stored value; a
      // fresh row has no messages yet, so the per-session provider lock
      // doesn't apply. The write also bumps `updated_at`, which is what
      // floats the row back to the top of the list.
      SessionRepo.updateSettings(fresh.id, {
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
        customModelId: input.customModelId ?? null,
        envMode,
        // Worktree-form intent rides along with the environment flip; local
        // rows carry NULL so no stale intent survives a re-aim.
        wtStyle: envMode === "worktree" ? (input.wtStyle ?? "detached") : null,
        // A fresh row reused as a local thread must not keep a worktree path
        // left over from an earlier bind — it would render under the wrong
        // left-bar group with a fork badge while actually running in the
        // project root. Fresh rows are by definition un-materialized, so
        // clearing is always safe here.
        worktreePath: envMode === "worktree" ? undefined : null,
      });
      applyWorktreeBind(input, fresh.id);
      const session = SessionRepo.get(fresh.id) ?? fresh;
      runtimeManager.bindSession(session);
      broadcastSessionChanged(session);
      log.info(`session reused: ${session.id} (project ${input.projectId}, ${source})`);
      return { session, reused: true };
    }
  }

  // 【ARC-001 步③】带 expectedRevision 却没有可复用的空壳(没有空壳 / 带显式标题因而
  // 本就不复用)= 调用方断言的那一版不在 → 拒绝,不静默新建一条它没预期的会话。
  if (expectedRevision !== undefined) throw new SessionRevisionConflictError(expectedRevision, null);

  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId: input.projectId,
    providerId: input.providerId ?? defaultProviderId(),
    claudeSessionId: null, // captured from system/init once the first turn runs
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: input.title ?? "New session",
    status: "idle",
    model: input.model ?? "default",
    effort: input.effort,
    permissionMode: input.permissionMode,
    // See the side-session literal above: new threads never inherit a mode.
    workflowId: "default",
    customModelId: input.customModelId ?? null,
    // Isolated-environment intent; the worktree materializes on first turn.
    // Coerced to local for non-repo projects (see coerceEnvMode).
    envMode,
    wtStyle: envMode === "worktree" ? (input.wtStyle ?? "detached") : null,
    worktreePath: null,
    archived: false,
    pinnedAt: null, // new sessions are never pinned
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
  applyWorktreeBind(input, session.id);
  // Re-read after the bind: applyWorktreeBind writes worktree_path directly
  // to the DB, and broadcasting/returning the stale in-memory object (which
  // carries worktreePath: null) made the renderer file the new session under
  // the project's flat list instead of its worktree group.
  const bound = SessionRepo.get(session.id) ?? session;
  runtimeManager.bindSession(bound);
  broadcastSessionChanged(bound);
  log.info(`session started: ${bound.id} (provider ${bound.providerId}, project ${input.projectId}, ${source})`);
  return { session: bound, reused: false };
}
