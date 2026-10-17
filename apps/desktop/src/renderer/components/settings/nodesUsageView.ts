/**
 * 「节点技能总览」的**读取视图模型** —— 纯函数,不 import React / api / i18n
 * (`hooksView.ts` / `workflowView.ts` 同一条纪律)。
 *
 * ## 为什么把它从组件里拎出来
 *
 * 这个视图做的事是"从技能反查谁在用",而它的输入来自**两次**读取:代理档案目录
 * (`agent_profiles.list`,一次)与工作流列表(`workflow.list` + 逐个 `workflow.get`)。
 * 从前后者是 `try { … } catch { /* 跳过 *\/ }`:某一份工作流读不回来(存档损坏 /
 * 刚好被删),它引用的技能就**悄悄从"被使用"掉进"没用到"那一栏** —— 而那一栏的用途
 * 是"清理"。台账 MC-050 把这条列为同类完整度缺陷:漏读被算成"未使用"。
 *
 * 现在把"读得不完整"变成**显式结果**:`incomplete` 列出读不回来的工作流,界面据此
 * 说明"这份目录不完整,别拿它当清理依据"。判据全在这个纯函数里,组件只负责画。
 *
 * ## 与技能 / MCP / 插件三个 tab 共用
 *
 * `paramKey` 一换(`skills` / `mcp` / `plugins`),同一份反查表就是另一类东西的。
 * 组件里原本就写着"三种东西在节点上都是'一组名字'参数" —— 这里保持同一条。
 */
import type { AgentProfile } from "@contracts/agentProfile";
import type { WorkflowDoc } from "@contracts/workflow";
import { NODE_SKILLS_PARAM_KEY } from "@contracts/nodeType";

/** 一处引用：谁在用这个名字。 */
export interface ReferenceUse {
  /** 展示用的来源名（工作流名 / 档案名）。 */
  label: string;
  kind: "workflow" | "profile";
  /** 工作流 id 或档案 id —— 点进去要用。 */
  refId: string;
  /** 工作流里的哪一格（档案没有这个概念）。 */
  nodeTitle?: string;
}

/** 一个名字 + 它的全部引用。 */
export interface ReferenceUsage {
  name: string;
  uses: ReferenceUse[];
}

/** 一份工作流**没读回来** —— 它可能引用了任何名字,所以本次结果是"不完整"。 */
export interface UnreadWorkflow {
  id: string;
  /** 读失败的原因(给用户看的原文)。 */
  error: string;
}

/** 反查结果:引用表 + 完整性诊断。 */
export interface NodesUsageResult {
  usage: Map<string, ReferenceUse[]>;
  /** 目录里列出、但 `workflow.get` 失败的条目。非空 = 结果不完整。 */
  unreadWorkflows: UnreadWorkflow[];
}

/** 从一份工作流文档里数出"每个名字被哪些节点挂了"(`paramKey` 换成 MCP / 插件那一格
 *  就是同一张反查表 —— 三种东西在节点上都是"一组名字"参数)。 */
export function collectWorkflowUses(
  doc: WorkflowDoc,
  into: Map<string, ReferenceUse[]>,
  paramKey: string = NODE_SKILLS_PARAM_KEY,
): void {
  for (const node of doc.nodes) {
    const raw = node.params?.[paramKey];
    if (!Array.isArray(raw)) continue;
    for (const name of raw) {
      if (typeof name !== "string" || name.length === 0) continue;
      const list = into.get(name) ?? [];
      list.push({
        label: doc.name,
        kind: "workflow",
        refId: doc.id,
        ...(node.title ? { nodeTitle: node.title } : {}),
      });
      into.set(name, list);
    }
  }
}

/** 从一份代理档案里数出它挂了哪些名字。档案存的就是"一组节点参数"。 */
export function collectProfileUses(
  profile: AgentProfile,
  into: Map<string, ReferenceUse[]>,
  paramKey: string = NODE_SKILLS_PARAM_KEY,
): void {
  const raw = profile.params?.[paramKey];
  if (!Array.isArray(raw)) return;
  for (const name of raw) {
    if (typeof name !== "string" || name.length === 0) continue;
    const list = into.get(name) ?? [];
    list.push({ label: profile.name, kind: "profile", refId: profile.id });
    into.set(name, list);
  }
}

/**
 * 把两次读取拼成反查结果。
 *
 * `workflowGets` 与 `list.workflows` **一一对应**(调用方按同一顺序逐个 get):
 * 成功的一项带 `workflow`,失败的一项带 `error`。失败**不跳过而不报** —— 进
 * `unreadWorkflows`,结果标成不完整(台账 MC-050 的判据)。
 */
export function buildNodesUsage(input: {
  profiles: readonly AgentProfile[];
  workflows: ReadonlyArray<{ id: string; name: string }>;
  workflowGets: ReadonlyArray<{ workflow: WorkflowDoc | null; error?: string }>;
  paramKey: string;
}): NodesUsageResult {
  const usage = new Map<string, ReferenceUse[]>();
  for (const p of input.profiles) collectProfileUses(p, usage, input.paramKey);
  const unreadWorkflows: UnreadWorkflow[] = [];
  input.workflows.forEach((entry, index) => {
    const got = input.workflowGets[index];
    if (got?.workflow) {
      collectWorkflowUses(got.workflow, usage, input.paramKey);
      return;
    }
    unreadWorkflows.push({ id: entry.id, error: got?.error ?? "没有返回工作流" });
  });
  return { usage, unreadWorkflows };
}

/** 把反查表分成"有引用的"和"没引用的" —— 两边的用途完全不同:前者是"删之前先看看
 *  谁在用",后者是"这一堆我根本没配过"。 */
export function splitUsedAndUnused<T extends { name: string }>(
  items: readonly T[],
  usage: Map<string, ReferenceUse[]> | null,
): { used: Array<ReferenceUsage & { item: T }>; unused: T[] } {
  const used: Array<ReferenceUsage & { item: T }> = [];
  const unused: T[] = [];
  for (const item of items) {
    const uses = usage?.get(item.name);
    if (uses && uses.length > 0) used.push({ name: item.name, uses, item });
    else unused.push(item);
  }
  used.sort((a, b) => b.uses.length - a.uses.length || a.name.localeCompare(b.name));
  return { used, unused };
}

/** 本次结果能不能当"没人用"的依据。只要有工作流没读回来,答案就是**不能** ——
 *  它可能引用了任何一个名字。界面据此压住"未使用"那段的清理暗示。 */
export function usageIsComplete(result: NodesUsageResult): boolean {
  return result.unreadWorkflows.length === 0;
}
