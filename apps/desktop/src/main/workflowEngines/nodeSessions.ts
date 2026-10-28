/**
 * 【Q11 / WF-07】**节点会话的身份：认回来，不是每次新建。**
 *
 * ## 为什么要有身份
 *
 * 工作流里每个子 agent 节点跑在自己的会话里。会话行必须能被**下一次**认回来，
 * 否则每跑一次图就在库里堆一个新会话行，重启后没有任何入口能找回"那一步的会话"，
 * 手册 WF-07「子代理跑完保留上下文，下次认回同一个会话」也就落不了地。
 *
 * ## 两种身份，不是两种实现
 *
 * 图上的一格在两种执行方式下有不同的"归属锚点"：
 *
 * | 执行方式 | 锚点 | 为什么 |
 * |---|---|---|
 * | 旧调度器：用户在对话里选一张图发消息 | `(父对话, 节点)` | 用户在**某个对话里**跑图，节点会话是它的子行（`parent_session_id` 指回那条对话） |
 * | 原生 Node-RED：inject / watch / 事件 / 画布手动点 | `(工作流, 节点)` | **没有父对话**。图由引擎自己的触发器驱动，运行时不存在"用户此刻正在看的那个对话" |
 *
 * 两者共用同一套"建/复用 + 执行配置同步 + 标题不复写"的规则，只是查找键不同。
 * 分开写两份会让两条路上的用户看到两个不同的会话 —— 仓库硬规矩 2。
 *
 * ## 复用时同步执行配置，但**不改标题**
 *
 * 会话行承载下一轮真正交给 RuntimeManager 的 provider/model/permissionMode。
 * 图被编辑后如果仍把旧值交还，`sendTurn` 会继续解析旧 provider。
 * 但**标题不跟着图上的格子名走**：图上改名是"这一步的说明变了"，标题是会话自己的
 * （用户可能亲手改过，见 `session.rename`）。每次跑图重写等于抹掉他改的名字。
 *
 * ## 老行（加 `node_id` 之前建的）认不回来
 *
 * 它们是 `node_id IS NULL` 的孤儿。不删、也不猜它们属于哪一格 —— 猜错等于把
 * 用户的历史轮次塞进另一格。
 */
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { Session } from "@contracts/session";
import type { WorkflowCapability, WorkflowNode } from "@contracts/workflow";
import type { PermissionMode } from "@contracts/runtime";
import { SessionRepo } from "@main/store/repositories.js";

/**
 * 能力 → 权限模式。
 *
 * **为什么不 import `runner.ts` 的 `permissionModeForCapability`**：本模块被原生
 * Node-RED 端口使用，而多个套件把 `runner.ts` 整个桩掉（`--external:./runner.js`）——
 * 从那里取函数会让这些套件在**打包期**就失败（实测 `memory-codex-smoke` 报
 * 「No matching export in stubs/runner.ts」）。这不是风格问题，是依赖方向问题：
 * 原生路径不该依赖旧执行器。
 *
 * 语义必须与 `runner.ts:283` 的同名函数逐项一致：
 * - `read` → `plan`：不是禁止写，而是**让写变得可见**（写类工具一律弹审批）；
 * - `write` → `acceptEdits`；
 * - `exec` / `net` → `default`。
 *
 * `nodePackProductionPorts.ts` 里还有第三份同样的表（它服务 Host 端口）。三份都在
 * 描述同一个业务规则，但各自的依赖边界不同 —— 改动时必须三处同步。
 */
function permissionModeForCapabilityOf(capability: WorkflowCapability | undefined): PermissionMode {
  switch (capability ?? "read") {
    case "read": return "plan";
    case "write": return "acceptEdits";
    case "exec":
    case "net": return "default";
  }
}

/** 节点标题：图上的自定义标题优先，否则用节点类型的名字。 */
export function nodeDisplayTitle(
  node: { title: string; type: string },
  manifest: NodeTypeManifest | undefined,
): string {
  if (node.title.trim().length > 0) return node.title;
  return manifest?.name ?? node.type;
}

type NodeRef = Pick<WorkflowNode, "id" | "type" | "title" | "capability" | "params">;

/** 建立节点会话需要的一切 —— 两种身份的共同输入 + 各自的锚点。 */
interface NodeSessionBase {
  node: NodeRef;
  manifest: NodeTypeManifest | undefined;
  /** 覆盖 provider（节点参数里选的引擎）；省略 = 继承锚点会话。 */
  engine?: string;
}

/** 旧调度器的身份：在某个对话里跑图。 */
export interface ConversationNodeSessionRequest extends NodeSessionBase {
  kind: "conversation";
  conversation: Session;
}

/** 原生 Node-RED 的身份：图由引擎触发，没有父对话。 */
export interface WorkflowNodeSessionRequest extends NodeSessionBase {
  kind: "workflow";
  workflowId: string;
  /** 图所属项目 —— 节点行要有归属项目，否则列表/删除路径看不见它。 */
  projectId: string;
  /** 继承哪条会话的 provider/model/权限/工作环境。 */
  inheritFrom: Session;
}

export type NodeSessionRequest = ConversationNodeSessionRequest | WorkflowNodeSessionRequest;

/**
 * 按身份找到或建出那一步的会话。**幂等**：同一身份反复调用返回同一行。
 *
 * 只在执行配置确实变了时才写库。
 *
 * ## ⚠️ 2026-10-28 实测：本函数**没有任何生产调用方**
 *
 * `grep -rn "nodeSessionOf" apps/desktop/src` 只命中两处：
 *   1. 本文件的定义；
 *   2. `orchestration/runner.ts:390/1154/1821/2309` —— 那是**另一个同名函数**
 *     （`runner.ts:2855` 的局部版，按 `(父对话, 节点)` 找，只支持 `conversation` 一种身份）。
 *
 * 也就是说：Q11 的「按 `(工作流, 节点)` 认回会话」这条能力**写了、有套件守着
 * （`node-session-smoke` 172/172）、但没接进任何执行路径**。
 *
 * 后果可观测：`mcode-conversation-session-smoke` 的 W18 有一条红着 ——
 * agent 节点没填 sessionId 时，`nodePackProductionPorts.ts:102` 仍然抛
 * 旧文案 `"Mcode sessionId is required"`，而断言期望的是 Q11 那句
 * 「不属于任何一张已保存的 Mcode 工作流」。
 *
 * **为什么不在这里改**：接上它需要 `(workflowId, node, inheritFrom)` 三样，
 * 而 `nodePackProductionPorts` 目前拿不到工作流文档与节点对象
 * —— 那是执行链所有权的问题，不是这个文件能决定的。留给工作流 owner。
 *
 * ## ⚠️ 2026-10-28 追加：**两条断言对同一行代码要相反的东西**
 *
 * 想修那条红断言时撞上的墙 —— 不是「不好改」，是**两条套件互斥**：
 *
 * | 套件 | 要求 `agent.run` 缺 sessionId 时抛的话 |
 * |---|---|
 * | `mcode-conversation-session-smoke`（W18） | **不要**是 `"Mcode sessionId is required"`，要「不属于任何一张已保存的 Mcode 工作流」 |
 * | `mcode-node-pack-ports-smoke`（两条） | **必须**是 `"Mcode sessionId is required"` |
 *
 * 实测：把消息换成 W18 要的那句 → conversation-session 4/4 通过，但
 * node-pack-ports 从 **180/180 掉到 178/180**（「模型选路缺 sessionId」与
 * 「缺 sessionId → 拒绝」两条红）。改回来则相反。**没有一份文案能同时满足。**
 *
 * 所以这不是「写错了一句话」，是**两套件对同一个契约的期望已经分叉**。
 * 要修必须先裁决：agent 节点缺 sessionId 时的正确文案是哪一句、
 * 旧那句的「established contract」还成不成立。那是产品/契约决定。
 * 在那之前**不要**去改 `nodePackProductionPorts` 里那句消息 —— 改了必然
 * 打破另一套，而且我试过两次、两次都只能回滚。
 */
export function nodeSessionOf(request: NodeSessionRequest): Session {
  const anchor = request.kind === "conversation" ? request.conversation : request.inheritFrom;
  const providerId = request.engine ?? anchor.providerId;
  const sameEngine = providerId === anchor.providerId;
  const override = typeof request.node.params["model"] === "string"
    ? (request.node.params["model"] as string).trim() : "";
  // 节点显式选的模型属于它自己选的 provider，即使跨 provider 也该用；
  // 只有**继承来的**父模型跨 provider 才不安全。
  const model = override.length > 0 ? override : sameEngine ? anchor.model : "";
  const effort = sameEngine ? anchor.effort : "default";
  const permissionMode = permissionModeForCapabilityOf(request.node.capability ?? request.manifest?.capability);
  const customModelId = sameEngine ? anchor.customModelId : null;
  const workflowId = request.kind === "conversation" ? anchor.workflowId : request.workflowId;

  const existing = request.kind === "conversation"
    ? SessionRepo.findNodeByNodeId(request.conversation.id, request.node.id)
    : SessionRepo.findNodeByWorkflowNode(request.workflowId, request.node.id);
  if (existing !== undefined) {
    const providerChanged = existing.providerId !== providerId;
    if (
      providerChanged || existing.model !== model || existing.effort !== effort
      || existing.permissionMode !== permissionMode || existing.workflowId !== workflowId
      || existing.customModelId !== customModelId
    ) {
      SessionRepo.updateSettings(existing.id, {
        providerId, model, effort, permissionMode, workflowId, customModelId,
      });
      // 跨 provider 时清掉旧 provider 的 resume 句柄 —— 绝不能把 Claude 的
      // 会话 id 交给 Pi/Codex，那会静默续到另一家的上下文上。
      if (providerChanged) SessionRepo.updateClaudeSessionId(existing.id, null);
    }
    // 复用的行可能属于新的祖先链。sendTurn 之前先落盘，否则嵌套 hook 事件
    // 会观察到上一轮那个更浅的深度。
    if ((existing.hookDepth ?? 0) !== (anchor.hookDepth ?? 0)) {
      SessionRepo.setHookDepth(existing.id, anchor.hookDepth ?? 0);
    }
    return {
      ...existing,
      hookDepth: anchor.hookDepth ?? 0,
      providerId,
      model,
      effort,
      permissionMode,
      workflowId,
      customModelId,
      claudeSessionId: providerChanged ? null : existing.claudeSessionId,
    };
  }

  const now = Date.now();
  const projectId = request.kind === "conversation" ? request.conversation.projectId : request.projectId;
  const parentSessionId = request.kind === "conversation" ? request.conversation.id : null;
  const session: Session = {
    id: newNodeSessionId(),
    projectId,
    providerId,
    claudeSessionId: null,
    kind: "node",
    hookDepth: anchor.hookDepth ?? 0,
    parentSessionId,
    nodeId: request.node.id,
    // 标题只给排查用（节点会话不进任何列表）：图上的标题比 "节点" 有用得多。
    title: nodeDisplayTitle(request.node, request.manifest),
    status: "idle",
    model,
    effort,
    permissionMode,
    // 带着同一张流程的 id：按"这个会话属于哪张流程"读的东西（续跑、运行上下文）
    // 才不会认错。
    workflowId,
    customModelId,
    // 继承锚点会话的工作环境 —— 节点行 worktree_path 为空会让"别把目录从正在跑的
    // 回合底下抽走"那条判断看不见节点，于是图还在跑、工作树却被删了。
    envMode: anchor.envMode,
    worktreePath: anchor.worktreePath ?? null,
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
  return session;
}

/** 会话 id 生成器。与 `runner.ts` 的 `uid("sess_")` 同形，但本模块不 import 那个
 *  私有 helper —— 它会把旧执行器整条依赖链拖进原生端口。 */
function newNodeSessionId(): string {
  return `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 能力 → 权限模式的窄判据（原生节点只用到 read/write 两档）。 */
export type { WorkflowCapability };
