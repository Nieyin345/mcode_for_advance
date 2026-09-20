/**
 * 夹具:一张**最小的两张图**,和一段父对话。
 *
 * 现摆而不是用内置流程(`wf_search` 之类):内置那些格子带技能 / MCP 收窄,链上会多出
 * 别的依赖,而这一套要盯的只是"节点跑着的时候主进程发了什么"。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import type { Project, Session } from "@contracts/session";

export const WORKFLOW_ID = "wf_node_live";
export const PARENT = "s_parent";
/** 节目标题 —— "报的是这一步的标题"那条断言读它。 */
export const AGENT_TITLE = "查一下这三篇的引用";

/** 会话行有外键指向项目,所以项目必须真的在。 */
export function project(): Project {
  const now = 1_700_000_000_000;
  return {
    id: "p1",
    name: "夹具项目",
    path: process.cwd(),
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 入口(`mcode.main`,跑在主对话里)→ 子 agent 节点。
 *
 * 入口必须是 `mcode.main`(`runner.kind === "conversation"`)—— 它跑在主对话里、很快
 * 收场;而**要盯的是第二个格子**(隐藏子会话那一路,也就是绝大多数节点)。
 */
export function nodeLiveDoc(): WorkflowDoc {
  return {
    id: WORKFLOW_ID,
    name: "node-live 夹具",
    prompt: "",
    nodes: [
      {
        id: "entry",
        type: "mcode.main",
        title: "入口",
        // ⚠️ 「指令」是**必填**的(`mcode.main` 与 `mcode.agent` 共用同一份
        // `runner.kind: "prompt"` 的输入构造)。填了才有东西发给模型 —— 空着的话
        // 调度器当场把这一步判成「参数「指令」是必填的」并**跳过**整条下游,
        // 而这个 suite 要盯的那个节点根本不会被派发。
        params: { instruction: "把这三篇的引用整理出来。" },
        position: { x: 0, y: 0 },
      },
      {
        id: "agent",
        type: "mcode.agent",
        title: AGENT_TITLE,
        params: { instruction: "查一下这三篇的引用。" },
        position: { x: 0, y: 120 },
      },
    ],
    edges: [{ id: "e1", from: "entry", to: "agent" }],
    builtin: false,
    updatedAt: 1_700_000_000_000,
  };
}

export function parentSession(id: string = PARENT): Session {
  const now = 1_700_000_000_000;
  return {
    id,
    projectId: "p1",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: "跑图",
    status: "idle",
    model: "sonnet",
    effort: "default",
    permissionMode: "default",
    workflowId: WORKFLOW_ID,
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
}
