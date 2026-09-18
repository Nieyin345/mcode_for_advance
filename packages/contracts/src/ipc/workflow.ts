/**
 * 工作流 / 代理档案 / 钩子的 RPC 入参。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { WorkflowDocSchema } from "../workflow.js";
import { AgentProfileSchema } from "../agentProfile.js";
import { HookSpecSchema } from "../hook.js";

/* ── 工作流 RPC 入参 ── */

/** 取一份完整工作流(含 nodes / edges)。画布编辑器打开某一项时才调。 */
export const WorkflowGetSchema = z.object({ id: z.string().min(1) });
export type WorkflowGetInput = z.infer<typeof WorkflowGetSchema>;

/** 存一份工作流。`workflow.id` 就是主键 —— 对内置 id 来说,存进去就是**覆盖它的
 *  默认版**(所以内置工作流可以直接改);「恢复默认」= 删掉那条覆盖。 */
export const WorkflowSaveSchema = z.object({ workflow: WorkflowDocSchema });
export type WorkflowSaveInput = z.infer<typeof WorkflowSaveSchema>;

/** 删一份工作流。对内置 id 来说**这就是「恢复默认」** —— 两种在存储层是同一个操作,
 *  所以只有一个删除动词,见 `main/orchestration/library.ts` 的文件头。 */
export const WorkflowRemoveSchema = z.object({ id: z.string().min(1) });
export type WorkflowRemoveInput = z.infer<typeof WorkflowRemoveSchema>;

/**
 * 用户在**岔路口**上选了一条路(`mcode.branch` 那个节点正停在那儿等人)。
 *
 * ## 它是"回答",不是"发消息"
 *
 * 那次运行**还活着** —— 它挂在一个 promise 上等这个回答,而这个调用把它唤醒之后,
 * 图从那儿接着往下跑,**不重跑整张图**。所以它和 `claude.send` 是两件事:后者开一次
 * 新的运行(`graphRunIntent` 在运行中会直接报 busy)。
 *
 * ## 为什么要 `runId`
 *
 * 同一个节点在同一张图里每一轮跑的 id 都一样。只按 `nodeId` 认的话,用户在**上一轮
 * 那张旧卡片**上点一下,会去唤醒这一轮的等待 —— 而这一轮问的根本不是同一件事。
 * `runId` 每次运行都是新的(见 `runner.ts` 的 `ActiveRun.runId`),带上它就分得开。
 */
export const WorkflowChooseSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  /** 选中的那条**边**的 id。**不是节点 id** —— 两条出路可以通向同一步。 */
  edgeId: z.string().min(1),
  /** 用户顺手写的一句话(可以不写)。会拼进下一步的提示词。 */
  comment: z.string().optional(),
});
export type WorkflowChooseInput = z.infer<typeof WorkflowChooseSchema>;

/**
 * 用户在一张**失败**的卡片上点了「再试一次」。
 *
 * ## 与 `workflow.choose` 是同一件事的两种形态
 *
 * 两者都是"用户在一张旧卡片上拍了个板,把那次运行接回来接着跑" —— 只是岔路口那一步
 * 是**选一条出路**,而失败那一步是**从这儿重新跑一遍**。所以都带 `runId`,都由
 * `runner.ts` 里那对 `resolveWorkflow*` 接(它们共用同一个 `startWorkflowRun`)。
 *
 * ## 重跑范围由主进程算,不在这儿给
 *
 * 界面上只知道"这一步失败了"。要重跑的是**它 + 它的全部前进后代**(用户的决定)——
 * 而"谁是谁的后代"是图的结构,只有主进程那一侧拿得到(而且它已经有现成的闭包函数)。
 * 所以这里只给起点。
 */
export const WorkflowRetrySchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  /** 失败的那一步。 */
  nodeId: z.string().min(1),
  /** 用户写的一句话:「上次哪里不对」。**只给这一步看**(可以不写)。 */
  note: z.string().optional(),
});
export type WorkflowRetryInput = z.infer<typeof WorkflowRetrySchema>;

/** 存一份代理档案。**整份给过来**(而不是"改哪个字段")—— 理由同 `HooksSaveSchema`:
 *  档案是用户从头写的,局部更新在这里没有意义,而整份给过来能让校验只发生在一个地方
 *  (`validateAgentProfile`)。 */
export const AgentProfileSaveSchema = z.object({ profile: AgentProfileSchema });
export type AgentProfileSaveInput = z.infer<typeof AgentProfileSaveSchema>;

/* ── 自动化 RPC 入参 ── */

/**
 * **手动运行一次。** 走的就是 `manual` 触发器那条路(`entry` = 指定的那个触发器节点),
 * 所以它和自动触发在"哪个项目 / 哪句话 / 落在哪条会话上"三件事上完全一致 —— 用户可以
 * 拿它先试一遍,再改成定时,看到的是同一件事(见 `automationRunner.runNow`)。
 *
 * 它是"开一次新的运行",不是"回答一个还活着的运行"(那是 `workflow.choose`)。
 */
export const AutomationRunSchema = z.object({
  workflowId: z.string().min(1),
  /** 用**哪个触发器**起这一次 —— 一条自动化可以有多个触发器,它们的工作目录和请求
   *  都可能不一样,所以这里必须指名道姓。 */
  triggerNodeId: z.string().min(1),
});
export type AutomationRunInput = z.infer<typeof AutomationRunSchema>;

/** 取这条自动化的运行历史。 */
export const AutomationRunsSchema = z.object({
  workflowId: z.string().min(1),
  /** 最多几条(新的在前)。不给就用主进程的默认值。 */
  limit: z.number().int().min(1).max(50).optional(),
});
export type AutomationRunsInput = z.infer<typeof AutomationRunsSchema>;

/** 取这条自动化的后台会话 id(`kind: "automation"`)。跑过零次的话是 null。 */
export const AutomationSessionsSchema = z.object({ workflowId: z.string().min(1) });
export type AutomationSessionsInput = z.infer<typeof AutomationSessionsSchema>;

/* ── 守望(会话输入区那颗「守望」按钮,D3/D4)── */

/**
 * 一条**命令模板**:守望面板下拉里的一项(名字 + 命令)。存在 setting 里
 * (D4:不单开设置页,面板里管)。
 */
export const WatchCommandTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
});
export type WatchCommandTemplate = z.infer<typeof WatchCommandTemplateSchema>;

/**
 * **守望起跑**:以 `sessionId` 那条会话为**发起会话**,起一次内置模板
 * 「长任务守望」的运行(见 `main/orchestration/automationRunner.ts` 的
 * `startWatch`)。命令在发起会话的项目目录里跑,跑完注入回发起会话。
 *
 * `command` / `message` 不给 = 沿用模板里现在那条 —— 主进程会把给了的写进模板
 * (节点参数就是配置的真相),所以这个调用**有可见的副作用**:库里那份模板显示的
 * 就是上一次守望用的配置。
 */
export const WatchStartSchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1).optional(),
  message: z.string().optional(),
});
export type WatchStartInput = z.infer<typeof WatchStartSchema>;

/** 这条会话上有没有**正在跑的守望**(面板据此提示"上一次还在跑")。 */
export const WatchStatusSchema = z.object({ sessionId: z.string().min(1) });
export type WatchStatusInput = z.infer<typeof WatchStatusSchema>;

/**
 * 存**整份**命令模板列表(同 `AgentProfileSaveSchema` 的理由:模板是用户从头写的,
 * 局部更新在这里没有意义,整份给过来让校验只发生在一个地方)。
 */
export const WatchTemplatesSaveSchema = z.object({
  templates: z.array(WatchCommandTemplateSchema),
});
export type WatchTemplatesSaveInput = z.infer<typeof WatchTemplatesSaveSchema>;

/**
 * 一次运行的结局。与 `workflow_runs.status` 那一列**一一对应**
 * (见 `main/store/repositories.ts` 的 `WorkflowRunStatus`)。
 *
 * 这里再写一份是因为 IPC 契约不能 import 存储层;两边真要漂了,主进程那边
 * "把 `WorkflowRunRow.status` 赋给这个类型"的一行会编译不过 —— 那正是它存在的意义。
 */
export const AUTOMATION_RUN_STATUSES = [
  "running",
  "interrupted",
  "success",
  "failed",
  "cancelled",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** 运行历史里的一步。**从存档折出来的**,不是另存的一份 —— 只挑卡片上显示得下的那几样
 *  (节点 id、名字、结局、摘要首行、错误)。 */
export interface AutomationRunStep {
  nodeId: string;
  /** 这一步在图上叫什么(标题 > id)。只给 id 的话历史里没人认得出是哪一步。 */
  title: string;
  status: string;
  /** 摘要的**首行**(整段摘要塞进一行列表里是噪声)。 */
  summary: string;
  /** 失败时的原因,原样给(里面往往就写着该怎么办)。 */
  error?: string;
}

/** 运行历史里的一次运行。 */
export interface AutomationRunEntry {
  runId: string;
  status: AutomationRunStatus;
  /** 这次运行什么时候开始的。 */
  startedAt: number;
  /** 最后一次更新(收尾时刻)。 */
  updatedAt: number;
  steps: AutomationRunStep[];
}

/** 删一份代理档案。**只按 id** —— 格式坏、读不出来的文件不在 `profiles` 里,但它照样
 *  删得掉(`removeAgentProfile` 直接按 id 拼路径),那正是最该能删的一种。 */
export const AgentProfileRemoveSchema = z.object({ id: z.string().regex(/^p_[a-z0-9_]+$/) });
export type AgentProfileRemoveInput = z.infer<typeof AgentProfileRemoveSchema>;

/** 存一条钩子。**整份给过来**(而不是"改哪个字段")—— 钩子是用户从头写的,
 *  局部更新在这里没有意义,而整份给过来能让校验只在一个地方发生(`validateHook`)。 */
export const HooksSaveSchema = z.object({ hook: HookSpecSchema });
export type HooksSaveInput = z.infer<typeof HooksSaveSchema>;

export const HooksRemoveSchema = z.object({ id: z.string().min(1) });
export type HooksRemoveInput = z.infer<typeof HooksRemoveSchema>;

/** 试跑。给的是**还没存下来**的那一份 —— 用户正是想在打开它之前看看会发生什么。 */
export const HooksTestSchema = z.object({ hook: HookSpecSchema });
export type HooksTestInput = z.infer<typeof HooksTestSchema>;

// `workflow.list` **没有入参 schema** —— 它列的是本机的工作流库,不针对某个项目。
// ⚠️ 与 `toolchain.check` 同一条纪律:无参 handler 里**不要 parse**,无参 invoke 时
// handler 收到的是 `undefined`,`z.object({}).parse(undefined)` 会直接 invalid_type。
// 与 `runtimes.list` 一致:无参 handler 不接 raw、也不 parse(不带参数 invoke 时
// raw 是 undefined,`z.object({})` 会把 `undefined` 判为 invalid_type)。

