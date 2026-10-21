/**
 * T63: host-side dispatch for the two non-shell hook actions.
 * The hook runner owns matching/grants/budget; this module only starts an
 * isolated persisted session using the existing SDK/workflow entry points.
 */
import { hookActionOf, type HookPayload, type HookSpec } from "@contracts/hook";
import type { Session } from "@contracts/session";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { SessionRepo } from "@main/store/repositories.js";
import { loadAgentProfileForSession, profileSeedOf } from "@main/lib/sessionAgentProfile.js";
import { agentProfilesDir } from "@main/orchestration/agentProfiles.js";
import { getWorkflow } from "@main/orchestration/library.js";
import { startWorkflowRun } from "@main/orchestration/runner.js";
import { uid } from "@main/utils.js";
import { log } from "@main/lib/logger.js";

/** Nonblocking launch: the child's hookDepth is persisted before its first event. */
export async function launchHookAction(spec: HookSpec, payload: HookPayload, nextDepth: number): Promise<void> {
  const action = hookActionOf(spec);
  if (action.kind === "command") throw new Error("command hook must use runHookCommand");
  const parent = SessionRepo.get(payload.session.id);
  if (!parent) throw new Error("触发会话不存在，拒绝启动代理");
  let agentProfile: Session["agentProfile"] = null;
  if (action.kind === "agent") {
    const loaded = loadAgentProfileForSession(action.profileId, agentProfilesDir());
    if (!loaded.ok) throw new Error(loaded.error);
    agentProfile = profileSeedOf(loaded.profile).ref;
  } else if (!getWorkflow(action.workflowId)) {
    throw new Error(`工作流不存在:${action.workflowId}`);
  }
  const now = Date.now();
  const child: Session = {
    ...parent,
    id: uid("sess_"),
    kind: action.kind === "agent" ? "side" : "automation",
    parentSessionId: parent.id,
    nodeId: null,
    agentProfile,
    workflowId: action.kind === "workflow" ? action.workflowId : "default",
    title: `Hook:${spec.name}`,
    claudeSessionId: null,
    status: "idle",
    permissionMode: "plan", // unsolicited background work cannot auto-approve
    hookDepth: nextDepth,
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
  // Persist BEFORE dispatch: nested tool events read this same per-session depth.
  SessionRepo.create(child);
  const prompt = JSON.stringify(payload);
  if (action.kind === "agent") {
    runtimeManager.bindSession(child);
    // Do not block HookRunner's event delivery for the lifetime of the turn.
    void runtimeManager.sendTurn(child, { prompt, cwd: payload.cwd }).then((handle) => {
      if (!handle) log.warn(`[hooks] agent action was not started for ${child.id}`);
    }).catch((error: unknown) => {
      log.warn(`[hooks] agent action failed ${child.id}: ${String(error)}`);
    });
  } else {
    void startWorkflowRun({ session: child, cwd: payload.cwd, prompt, originSessionId: parent.id })
      .then((result) => {
        if (!result) log.warn(`[hooks] workflow action was not started for ${child.id}`);
      }).catch((error: unknown) => {
        log.warn(`[hooks] workflow action failed ${child.id}: ${String(error)}`);
      });
  }
}
