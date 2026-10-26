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
import { isRetiredLegacyGraph, retiredGraphError } from "@main/workflowEngines/workflowEngineSelection.js";
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
    // 【Q5】钩子的 `workflow` 动作现在走 **Node-RED 原生路径**。
    //
    // 它跑的是**用户自己选的那张图**，所以跟着"用户工作流统一到 Node-RED"一起迁。
    // 与旧路径的差别必须说清：
    // - 旧调度器给这张图建了一条专用会话（`child`）；原生图跑在自己的节点会话里
    //   （`(工作流, 节点)`，见 `nodeSessions.ts`），所以 `child` 行落库后不再被使用；
    // - 旧路径能拿到 `result.outcomes`；原生路径只触发一次，产出进运行史与看板。
    //
    // 被拒的三种情况都有明确原因，且都是用户能自己解决的（图没迁、引擎没起、没部署）。
    void runHookWorkflowNatively(action.workflowId, prompt)
      .then((result) => {
        if (!result.ok) log.warn(`[hooks] workflow action not started (${action.workflowId}): ${result.error}`);
      }).catch((error: unknown) => {
        log.warn(`[hooks] workflow action failed ${child.id}: ${String(error)}`);
      });
  }
}

/**
 * 【Q5】钩子触发一张已迁移到 Node-RED 的图。
 *
 * 用与画布手动点、记忆整理**同一个**入口（`runNativeManual`），所以前置校验
 * （引擎 running / 部署已确认 / 这张图有已部署的手动触发器）一条都不少。
 *
 * 图里没有手动触发器时（定时/文件/事件驱动）如实拒绝 —— 钩子事件不是那张图的
 * 触发器，替它点火会绕过图自己的触发语义。
 */
async function runHookWorkflowNatively(
  workflowId: string,
  prompt: string,
): Promise<{ ok: boolean; error?: string }> {
  const doc = getWorkflow(workflowId);
  if (doc === null) return { ok: false, error: "工作流已不存在" };
  if (isRetiredLegacyGraph(doc)) {
    return { ok: false, error: retiredGraphError(doc.name) };
  }
  const manual = doc.nodes.find(
    (node) => node.type === "mcode.trigger" && node.params["triggerKind"] === "manual",
  );
  if (manual === undefined) {
    return {
      ok: false,
      error: `工作流「${doc.name}」没有手动触发器；钩子需要一个可被外部点火的入口节点`,
    };
  }
  const { workflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
  const runtime = workflowEngineRegistry.get("node-red");
  if (runtime === null) return { ok: false, error: "Node-RED 引擎未注册" };
  // `EngineRuntime` 的基类没有这个入口（它是 Node-RED 专用运行时才有的），
  // 与 `registry.ts` 里 `retryNativeFlow` 同一个取舍：运行时类型断言，缺方法就拒绝。
  const tool = runtime as unknown as {
    runNativeManual?: (
      docId: string, triggerNodeId: string, facts: Readonly<Record<string, unknown>>,
    ) => Promise<{ ok: boolean; error?: string }>;
  };
  if (typeof tool.runNativeManual !== "function") {
    return { ok: false, error: "当前引擎不支持原生手动触发" };
  }
  return tool.runNativeManual(workflowId, manual.id, { kind: "manual", at: Date.now(), prompt });
}
