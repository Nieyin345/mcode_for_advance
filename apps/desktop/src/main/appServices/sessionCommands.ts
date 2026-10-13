/**
 * **唯一的会话业务命令** —— 「建一条对话(或复用同项目里那份还新鲜的空壳),可选地把它
 * 的第一条消息发出去」这一条**业务动作**只有这一处实现。
 *
 * ## 为什么要有这个文件(硬规矩 2:共享实现只有一份)
 *
 * 同一件事从前在两处**各写一遍**:桌面 `claude:startSession` IPC 建会话;而 agent 那条
 * 「无渲染窗口也能开对话」的路(`appControl/tools.ts` 的 `headlessNewSession`)把
 * 「查项目 → `createOrReuseSession` → 解析 cwd → `runtimeManager.sendTurn` 发首条」又内联
 * 拼了一遍。两处只要有一处漏了后半截(比如忘了把 `workflowId` 随轮下发),同一条命令经
 * 桌面走和经 agent 走就会**行为漂移** —— 这正是 ARC-001 要收的口子。
 *
 * 现在这一段收成一个函数:桌面 IPC 与 agent headless 都调它,各端只把自己那份**传输形状**
 * (IPC 返回 `{session}` / Agent 返回 ToolResult)留给自己。命令的**业务动作**只有一份。
 *
 * ## 边界(这里**不**做)
 *
 *   - 不碰审批:审批在各自入口(`gateAppAction` / IPC 侧无审批)做,与本函数无关;
 *   - 不做纯 UI 动作(切对话、开文件、截图)—— 那些仍属界面(`uiBridge`);
 *   - 不改结果形状:调用方拿到的仍是它们各自原来的东西。
 *
 * ## 【ARC-001 步②】ActionContext —— 「谁在调」是结构化事实,不是裸字符串
 *
 * 从前本函数的第二个入参是一个裸的 `source: "desktop" | "mobile" | "agent"` —— 它能
 * 表达"经哪条路进来",却表达不了"**谁**在调":桌面用户、Agent、手机端三者的身份/作用域
 * 全被压成一个渠道名。台账 remaining 第②条点名的「ActionContext(actorKind / actorId /
 * scope / operationId / expectedRevision)」就是要把它升成结构化事实。
 *
 * 本切片落**能立即兑现**的那几个字段:`actorKind`(谁)、`actorId`(哪个主体)、
 * `operationId`(这一次操作的幂等键)、可选 `scope`(作用域,当前 = 项目 id)。两条调用方
 * **各填自己的身份**:桌面 IPC = `user`、agent headless = `agent`(mobile 由本函数按
 * actorKind 直接支持)。`source` 这个渠道名由 `actorKind` **派生**出来喂给
 * `createOrReuseSession` —— 结果形状与行为**一律不变**(mobile → mobile,其余 → desktop)。
 *
 * ⚠️ **本切片已知残余(如实记录,不假称做全)**:`permissionGrant`(计划级授权句柄)与
 * `expectedRevision`(乐观并发修订号)两个字段尚未落 —— 它们要等授权判定核与资源修订号
 * 先铺进这条命令链,此处**不造**一个没有消费者的空字段冒充结构完整。
 */
import type { StartSessionInput } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";

/**
 * 发起一条会话业务命令的**主体种类**。
 *
 *   - `user` —— 桌面界面的用户本人(点「新建对话」等);
 *   - `agent` —— 本地 Agent 经 mcode-app 工具(无窗口 headless 路)代用户发起;
 *   - `mobile` —— 手机端经无 preload 的 HTTP 桥发起。
 */
export type ActorKind = "user" | "agent" | "mobile";

/**
 * **谁在调这条业务命令**的结构化事实。由**调用方**(可信边界)填,受管命令只**读**它,
 * 不自己从别处再推导一遍 —— 与 `PublicActionContext` 同一条信任边界取向。
 */
export interface ActionContext {
  /** 主体种类:用户 / Agent / 手机端。决定渠道语义(`createOrReuseSession` 的 source)。 */
  actorKind: ActorKind;
  /** 主体身份标识(桌面固定 `desktop`;agent = 发起调用的会话 id;mobile = 设备/会话 id)。 */
  actorId: string;
  /** 这一次操作的幂等键(跨端对账 / 幂等去重用)。调用方生成。 */
  operationId: string;
  /** 作用域(当前 = 目标项目 id);可选,调用方拿得到就带上。 */
  scope?: string;
}

/**
 * 建会话 + (可选)发首条消息的入参。
 *
 * `input` 就是桌面 `claude:startSession` 的那份 `StartSessionInput` —— 复用同一份 schema,
 * 不再为 agent 那条路另造一套「建会话要什么」的字段(那样早晚又漂开)。
 */
export interface CreateSessionAndSendArgs {
  /** 建会话的配置(与桌面 `claude:startSession` 同一份)。 */
  input: StartSessionInput;
  /**
   * 首条消息。**省略 = 只建会话,不派发回合**(与桌面「新建对话」一致:建完等用户打字)。
   * 传了(含空串)就发 —— 空串也发,保持与既有 headless 路径逐字同行为。
   */
  prompt?: string;
  /** 让这条首消息按某个工作流跑。 */
  workflowId?: string;
}

/** 命令结果。`sendError` 为 null 表示「没发」或「发成功」。 */
export interface CreateSessionAndSendResult {
  session: Session;
  reused: boolean;
  /** 首条消息没发出去时的**原因**;null = 发成功,或本来就没让发。 */
  sendError: string | null;
}

/** 建会话+发首条这条命令被调了几次 —— 让回归能证「两条路真的都走这一个函数」(硬规矩 2)。 */
let createSessionAndSendCount = 0;
/** 最近一次收到的 ActionContext —— 让回归能证「各端各填了自己的身份」(ARC-001 步②)。 */
let lastActionContext: ActionContext | null = null;

/**
 * 建一条对话(或复用项目里那份还新鲜的「新对话」空壳),可选地把它第一条消息发出去。
 *
 * 解析链:**项目 → `createOrReuseSession`(唯一复用判据)→ cwd(会话自己的工作树优先,
 * 否则项目根)→ `runtimeManager.sendTurn`**。`sendTurn` 返回 null = 上一轮还在运行、这轮
 * 没接 —— 如实落进 `sendError`,不假装发成功(硬规矩 3:坏东西显式报出来)。
 *
 * `action` 就是「谁在调」的结构化事实(见 {@link ActionContext})—— 本函数只**读**它,
 * 把它派生成 `createOrReuseSession` 要的渠道名(mobile → mobile,其余 → desktop),
 * **不改任何业务行为、不改结果形状**。
 */
export async function createSessionAndSend(
  args: CreateSessionAndSendArgs,
  action: ActionContext,
): Promise<CreateSessionAndSendResult> {
  createSessionAndSendCount += 1;
  lastActionContext = action;
  const { session, reused } = createOrReuseSession(
    args.input,
    action.actorKind === "mobile" ? "mobile" : "desktop",
  );
  if (args.prompt === undefined) {
    // 只建会话 —— 与桌面「新建对话」同一条:不因为这里少发一条消息而改变落库/广播行为。
    return { session, reused, sendError: null };
  }
  const project = ProjectRepo.get(session.projectId);
  const cwd = session.worktreePath ?? project?.path;
  if (!cwd) {
    return { session, reused, sendError: `对话 ${session.id} 没有可用的工作目录` };
  }
  const handle = await runtimeManager.sendTurn(session, {
    prompt: args.prompt,
    cwd,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
  });
  return {
    session,
    reused,
    sendError: handle === null ? "上一轮还在运行,消息没发出去" : null,
  };
}

/* ───────────────────────── 测试观测(与 appControl 的 __clearOperationLog 同一取向) ───────────────────────── */

/** 建会话+发首条这条命令被调了几次 —— 让回归能证「两条路真的都走这一个函数」。 */
export function __createSessionAndSendCount(): number {
  return createSessionAndSendCount;
}
/** 每个用例前清一次,免得跨用例串味。 */
export function __resetCreateSessionAndSendCount(): void {
  createSessionAndSendCount = 0;
  lastActionContext = null;
}
/**
 * 最近一次收到的 ActionContext(ARC-001 步②)—— 让回归能证「桌面传 user / agent 传 agent /
 * mobile 传 mobile」,而不是只断言计数。返回的是**那次调用**的原样对象(只读用途)。
 */
export function __lastActionContext(): ActionContext | null {
  return lastActionContext;
}
