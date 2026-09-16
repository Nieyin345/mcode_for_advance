/**
 * 工作流库 —— **内置默认版 + 用户覆盖** 合并之后的那一层。
 *
 * ## 三个概念别混
 *
 * | 东西 | 在哪 |
 * |---|---|
 * | 内置工作流的**默认版** | 代码(`builtins.ts`),随发版更新 |
 * | 用户对某个内置的**覆盖** | `workflows` 表里同名 id 的一行 |
 * | 用户**自建**的工作流 | `workflows` 表里 `wf_` 前缀的行 |
 *
 * 读取时合并:内置的按 id 打底,表里的同名行替换之,表里独有的追加。
 * 「恢复默认」= **删掉那一行** —— 代码里的默认版立刻回来,不需要在表里另存副本。
 *
 * ## 为什么只有一个删除动词(和方案里写的不一样)
 *
 * 方案列了 `workflow.remove` 和 `workflow.reset` 两个 RPC。但它们在**存储层是同一个
 * 操作**:删掉表里那一行。对内置 id 来说那叫"恢复默认",对自建 id 来说那叫"删除" ——
 * 区别只在**界面的措辞**,不在行为。两个 RPC 做同一件事,后来的人一定会问"该调哪个"。
 * 所以这里只留 {@link removeWorkflow},返回值里带上"删的是不是内置的覆盖",
 * 界面据此决定提示语。
 */

import type { WorkflowDoc, WorkflowListEntry } from "@contracts/workflow";
import { validateDag } from "@contracts/workflow";
import { validateNodeParams } from "@contracts/nodeType";
import { validateOutputRules } from "@contracts/outputConstraint";
import { WorkflowRepo } from "@main/store/repositories.js";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, isBuiltinWorkflowId } from "./builtins.js";
import { loadNodeTypes } from "./nodeTypes.js";

function summarize(doc: WorkflowDoc, builtin: boolean, edited: boolean): WorkflowListEntry {
  return {
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.icon ? { icon: doc.icon } : {}),
    builtin,
    edited,
    kind: doc.nodes.length > 0 ? "graph" : "prompt",
    // 带过去,不然列表分不出"工作流"和"自动化"两栏(见 `WorkflowListEntry`)。
    ...(doc.trigger ? { trigger: doc.trigger } : {}),
    updatedAt: doc.updatedAt,
  };
}

/** 全部工作流(内置打底 + 用户覆盖 + 用户自建),**内置排在前面且顺序固定**。 */
export function listWorkflows(): WorkflowListEntry[] {
  const rows = WorkflowRepo.list();
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: WorkflowListEntry[] = BUILTIN_WORKFLOWS.map((builtinDoc) => {
    const override = byId.get(builtinDoc.id);
    return override
      ? summarize(override.doc, true, true)
      : summarize(builtinDoc, true, false);
  });

  // 自建的按表里的顺序(WorkflowRepo.list 已经按 sort_order 排好)
  for (const row of rows) {
    if (isBuiltinWorkflowId(row.id)) continue;
    out.push(summarize(row.doc, false, false));
  }
  return out;
}

/** 取一份**生效的**工作流(内置被覆盖时取覆盖版)。找不到返回 null。 */
export function getWorkflow(id: string): WorkflowDoc | null {
  const override = WorkflowRepo.get(id);
  if (override) return override.doc;
  return getBuiltinWorkflow(id) ?? null;
}

/** 取工作流的提示词正文 —— 供 `RuntimeManager` 在每轮拼系统提示词时调。
 *
 *  没有提示词(图型工作流、或"默认"那个空提示词)返回 undefined,调用方据此跳过
 *  注入。**这是把提示词解析从 provider 搬到 host 的那一步**(见方案),provider
 *  从此只负责 append 一段字符串。 */
export function getWorkflowPrompt(id: string): string | undefined {
  const text = getWorkflow(id)?.prompt;
  return text && text.length > 0 ? text : undefined;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/** 存一份工作流。**存盘前必须过两道校验**:
 *
 *  1. {@link validateDag} —— 出了环的图会让调度器永远等不到就绪节点,那不是报错,是
 *     静默卡死。**环上有一个岔路口就不算**(见 `@contracts/workflow` 的「回头」):
 *     那样绕一圈至少要有用户点一下,停得下来。
 *  2. 每个节点的参数对它那份**类型清单**的校验 —— 必填没填、下拉给了不存在的值,
 *     这些等到执行时才发现就太晚了(用户已经画完一整张图)。
 *
 *  ⚠️ **类型认不出来不算错。** 一份别人分享来的工作流,在这台机器上可能引用了没装的
 *  节点类型(见 `@contracts/workflow` 文件头)。那种节点跳过参数校验,图照样能存能看
 *  —— 只是跑不了。把"类型缺失"做成硬错误会让工作流没法分享。 */
export async function saveWorkflow(doc: WorkflowDoc): Promise<SaveResult> {
  const types = new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]));

  // ⚠️ **顺序要紧**:取类型这件事**必须在 `validateDag` 之前** —— 判"环上有没有岔路口"
  // 靠的就是这份类型表,拿不到的话一个合法的环会被当成死循环拒掉。
  //
  // 认不出的类型不算岔路口:一份引用了没装类型的工作流能存(见上面那条),而它要是
  // 恰好成了某个环的闸门,那个环就按"没闸门"拒 —— 拒了才知道要装什么,比存下来跑不动强。
  const check = validateDag(doc.nodes, doc.edges, {
    isLoopGate: (id) => {
      const node = doc.nodes.find((n) => n.id === id);
      return node !== undefined && types.get(node.type)?.runner.kind === "branch";
    },
  });
  if (!check.ok) return check;

  for (const node of doc.nodes) {
    const manifest = types.get(node.type);
    if (!manifest) continue;
    const paramsCheck = validateNodeParams(manifest, node.params);
    if (!paramsCheck.ok) {
      // 节点标题可能没填过,退回 id —— 报错信息要能让人在图上找到是哪一个。
      return { ok: false, error: `节点「${node.title || node.id}」:${paramsCheck.error}` };
    }
    // 产出约束那几个键**不是** `validateNodeParams` 管的(它只看清单声明过的形状),
    // 但配矛盾了同样要在这里拦:等跑到那一步才发现的话,用户已经在图上找了一圈了。
    const rulesCheck = validateOutputRules(manifest, node.params);
    if (!rulesCheck.ok) {
      return { ok: false, error: `节点「${node.title || node.id}」:${rulesCheck.error}` };
    }
  }

  WorkflowRepo.save({ ...doc, updatedAt: Date.now() });
  return { ok: true };
}

/**
 * 删掉工作流。
 *
 * - `id` 是内置的 → 删掉的是**覆盖行**,效果是「恢复默认」;
 * - `id` 是自建的 → 删掉它本身。
 *
 * 两种在存储层是同一个动作,所以只有一个函数;`wasBuiltin` 让界面能说对话
 * (「已恢复默认」而不是「已删除」)。
 */
export function removeWorkflow(id: string): { ok: boolean; wasBuiltin: boolean } {
  const wasBuiltin = isBuiltinWorkflowId(id);
  WorkflowRepo.remove(id);
  return { ok: true, wasBuiltin };
}
