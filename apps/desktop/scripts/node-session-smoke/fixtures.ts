/**
 * 夹具:一张三格的图(入口 → 两个子 agent 格子),和两段父对话。
 *
 * 为什么是**两个**节点:要钉的正是「同一张图里,这一步和那一步**各有各的会话**」。
 * 只有一格的图验不出这件事 —— 断言会退化成"有个会话行",而那在加 `node_id` 之前
 * 就是绿的。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import type { Project, Session } from "@contracts/session";

export const WORKFLOW_ID = "wf_node_session";
/** 第一段父对话。 */
export const PARENT = "s_parent";
/** 第二段父对话 —— 用来钉"同一个节点 id 挂在不同对话下是两个会话"。 */
export const PARENT_B = "s_parent_b";

export const ENTRY_TITLE = "入口";
/** 两个格子的标题 —— 「报的是哪一步的名字」那几条断言读它。 */
export const AGENT_A_TITLE = "查引用";
export const AGENT_B_TITLE = "润色";

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
 * 入口(`mcode.main`,跑在主对话里)→ 两个子 agent 格子。
 *
 * 入口必须是 `mcode.main`(`runner.kind === "conversation"`)—— 它跑在主对话里、
 * 立刻收场,于是"跑过的工作流步骤"里它**不算一步**(它没有自己的节点会话)。
 * 那正好也是要钉的一条。
 */
export function nodeSessionDoc(): WorkflowDoc {
  return {
    id: WORKFLOW_ID,
    name: "node-session 夹具",
    prompt: "",
    nodes: [
      {
        id: "entry",
        type: "mcode.main",
        title: ENTRY_TITLE,
        // ⚠️ 「指令」是**必填**的(`mcode.main` 与 `mcode.agent` 共用同一份
        // `runner.kind: "prompt"` 的输入构造)。空着的话调度器当场把这一步判成
        // 「参数「指令」是必填的」并**跳过**整条下游 —— 那两个格子根本不会被派发。
        params: { instruction: "把这两个活儿分头做掉。" },
        position: { x: 0, y: 0 },
      },
      {
        id: "agentA",
        type: "mcode.agent",
        title: AGENT_A_TITLE,
        params: { instruction: "查一下这三篇的引用。" },
        position: { x: 0, y: 120 },
      },
      {
        id: "agentB",
        type: "mcode.agent",
        title: AGENT_B_TITLE,
        params: { instruction: "把摘要润色一遍。" },
        position: { x: 0, y: 240 },
      },
    ],
    edges: [
      { id: "e1", from: "entry", to: "agentA" },
      { id: "e2", from: "entry", to: "agentB" },
    ],
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
