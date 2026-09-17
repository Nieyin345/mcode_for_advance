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
import type { NodeTypeManifest } from "@contracts/nodeType";
import {
  deciderOf,
  parseTriggerSpec,
  validateNodeParams,
  WORKFLOW_TRIGGER_OF_TRIGGER_KIND,
} from "@contracts/nodeType";
import { validateOutputRules } from "@contracts/outputConstraint";
import { WorkflowRepo } from "@main/store/repositories.js";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow } from "./builtins.js";
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

  // 自建的按表里的顺序(WorkflowRepo.list 已经按 sort_order 排好)。
  // 判重按**内置文档的实际 id 集合**,不是 `isBuiltinWorkflowId`:守望模板(`watch`)
  // 是内置的,但故意不在 `BUILTIN_WORKFLOW_IDS` 里(那是对话模式下拉的名单,见
  // `builtins.ts`)—— 按那份名单判的话,它的覆盖行会在下面再列一次。
  const builtinIds = new Set(BUILTIN_WORKFLOWS.map((d) => d.id));
  for (const row of rows) {
    if (builtinIds.has(row.id)) continue;
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
  //
  // **闸门必须是"决定权给用户"的分支。** 决定权给模型的那种分支(见 `@contracts/nodeType`
  // 的 `deciderOf`)不能回头:它自己判完自己转,没有人拦得住 —— 那正是环闸门要防的事。
  const check = validateDag(doc.nodes, doc.edges, {
    isLoopGate: (id) => {
      const node = doc.nodes.find((n) => n.id === id);
      if (node === undefined) return false;
      const manifest = types.get(node.type);
      return manifest !== undefined && manifest.runner.kind === "branch" && deciderOf(node.params) !== "model";
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

  const derived = deriveTrigger(doc, types);
  if (!derived.ok) return derived;

  WorkflowRepo.save({ ...derived.doc, updatedAt: Date.now() });
  return { ok: true };
}

/**
 * 把 `trigger` 那个字段从**触发器节点**反推出来。
 *
 * ## 为什么要有这一步
 *
 * `trigger` 在这一版**降级成了一个开关**(见 `@contracts/workflow` 的文件头):它不再有
 * 独立的真相 —— 列表分栏、MCP、i18n 那些照旧读它,而它的值一律从图上的触发器节点推。
 * 两处都能写的话,迟早出现"图上是个定时任务、列表里显示成事件触发"。
 *
 * ## 三条规则,每条都挡一个真问题
 *
 *  - **一个触发器都没有** → 删掉这个字段。它就是个普通工作流了,列表该分到另一栏。
 *  - **触发器有入边** → 报错。触发器是这次运行的**起点**(见 `scheduler.ts` 的 `entry`),
 *    它上游那些节点永远不会跑 —— 用户会以为图坏了,而图上看起来一切正常。
 *  - **参数不过 {@link parseTriggerSpec}** → 原样把那个错报出去。存下一份**永远不响**的
 *    自动化是最难查的一类问题:cron 写错、glob 写空都不会当场报错,只会安安静静地不跑。
 *
 * 一条自动化可以有多个触发器(它们在后台各听各的),而 `trigger` 只有一个值,所以按
 * **文档顺序取第一个** —— 分栏只需要知道"它是不是自动化、大概是哪一种"。
 *
 * 返回的是一份**新的 doc**(不修改入参):`saveWorkflow` 存的就是这一份。写成纯函数是为了
 * 冒烟能直接断言它,而不必去碰数据库(它也就因此不 import `automationRunner`,那个会拉到
 * electron —— 见 `main/ipc/orchestration.ts` 那处 reload 的注释)。
 */
export function deriveTrigger(
  doc: WorkflowDoc,
  types: Map<string, NodeTypeManifest>,
): { ok: true; doc: WorkflowDoc } | { ok: false; error: string } {
  const triggers = doc.nodes.filter((n) => types.get(n.type)?.runner.kind === "trigger");

  if (triggers.length === 0) {
    if (doc.trigger === undefined) return { ok: true, doc };
    const cleared: WorkflowDoc = { ...doc };
    delete cleared.trigger;
    return { ok: true, doc: cleared };
  }

  const first = triggers[0];
  const where = `触发器「${first.title || first.id}」`;

  // 触发器是这次运行的起点,上面不该有东西。判据是**边**,不是节点上的字段(依赖的
  // 真相是 `edges`,见 `@contracts/workflow` 的说明)。
  if (doc.edges.some((e) => e.to === first.id)) {
    return {
      ok: false,
      error: `${where}有上游节点 —— 触发器是这次运行的起点,它等的那件事发生时整张图就从它开始跑,所以它前面不能接别的步骤`,
    };
  }

  const manifest = types.get(first.type);
  if (manifest === undefined) return { ok: true, doc }; // 认不出的类型不算错(同上面那条)
  const check = parseTriggerSpec(manifest, first.params);
  if (!check.ok) return { ok: false, error: `${where}:${check.error}` };

  return { ok: true, doc: { ...doc, trigger: WORKFLOW_TRIGGER_OF_TRIGGER_KIND[check.spec.kind] } };
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
  // 按**内置文档的实际集合**判,不用 `isBuiltinWorkflowId`:守望模板是内置的
  // (删除它的覆盖行 = 恢复默认),但它不在 `BUILTIN_WORKFLOW_IDS` 里。
  const wasBuiltin = getBuiltinWorkflow(id) !== undefined;
  WorkflowRepo.remove(id);
  return { ok: true, wasBuiltin };
}
