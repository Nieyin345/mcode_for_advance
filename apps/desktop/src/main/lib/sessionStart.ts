import { replaceBackflowSource } from "@main/lib/pendingBackflow.js";
import type { Session } from "@contracts/session";
import { DEFAULT_PROVIDER_ID, type StartSessionInput } from "@contracts/ipc";
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
): { session: Session; reused: boolean } {
  // Side-chat Q&A sessions: reuse the parent's still-fresh "Quick ask" row
  // when one exists (same anti-stacking rule as main sessions below — a
  // placeholder title means the first question never landed, so the shell is
  // empty and refocusing it beats creating another one). No session.changed
  // broadcast — side chats are invisible to the left-bar/mobile lists by
  // design; the desktop ask tab consumes the IPC return value directly and
  // mobile doesn't manage side chats at all.
  if (input.kind === "side") {
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
        // Re-aim at the current composer config (updateSettings skips
        // undefined fields and bumps updated_at; the ask tab sorts by
        // created_at, so the row stays in place in its list).
        SessionRepo.updateSettings(fresh.id, {
          providerId: input.providerId,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          customModelId: input.customModelId ?? null,
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
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
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
      model: input.model ?? "default",
      effort: input.effort,
      permissionMode: input.permissionMode,
      // A new thread always starts in 默认 — deliberately NOT inheriting the
      // previous thread's composer mode: 文献检索 swallows the send entirely
      // (no model call), so silently carrying it into a fresh chat would eat
      // the user's first message. The mode is picked per thread.
      workflowId: "default",
      customModelId: input.customModelId ?? null,
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

  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId: input.projectId,
    providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
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
