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

/** 存一份代理档案。**整份给过来**(而不是"改哪个字段")—— 理由同 `HooksSaveSchema`:
 *  档案是用户从头写的,局部更新在这里没有意义,而整份给过来能让校验只发生在一个地方
 *  (`validateAgentProfile`)。 */
export const AgentProfileSaveSchema = z.object({ profile: AgentProfileSchema });
export type AgentProfileSaveInput = z.infer<typeof AgentProfileSaveSchema>;

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

