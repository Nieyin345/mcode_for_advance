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
 */
import type { StartSessionInput } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";

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

/**
 * 建一条对话(或复用项目里那份还新鲜的「新对话」空壳),可选地把它第一条消息发出去。
 *
 * 解析链:**项目 → `createOrReuseSession`(唯一复用判据)→ cwd(会话自己的工作树优先,
 * 否则项目根)→ `runtimeManager.sendTurn`**。`sendTurn` 返回 null = 上一轮还在运行、这轮
 * 没接 —— 如实落进 `sendError`,不假装发成功(硬规矩 3:坏东西显式报出来)。
 */
export async function createSessionAndSend(
  args: CreateSessionAndSendArgs,
  source: "desktop" | "mobile" | "agent",
): Promise<CreateSessionAndSendResult> {
  createSessionAndSendCount += 1;
  const { session, reused } = createOrReuseSession(args.input, source === "mobile" ? "mobile" : "desktop");
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
}
