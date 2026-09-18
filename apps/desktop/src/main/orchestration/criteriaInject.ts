/**
 * **入口节点「固定条件」的注入** —— 从主对话节点的参数表里读出条件,把用户在输入框
 * 上方选好的值拼进这次运行的提示词。
 *
 * ## 为什么单独一个文件
 *
 * 它原来长在 `runner.ts` 的 `startWorkflowRun` 里(那段函数本来就长),而它和"怎么跑
 * 一个节点"没有关系 —— 它是**这次运行开头那一段文字怎么来的**。抽出来还有一个更实际
 * 的理由:`runner.ts` 一 import 就把 RuntimeManager、三家 provider 全拖进来,无头脚本
 * 跑不动;而这一段真正要验的东西(**只在这个对话的第一轮注入**)恰恰是最该被钉住的
 * 那一条。分开之后 `scripts/criteria-inject-smoke` 直接调它,一行桩都不用打。
 *
 * ## 三道门,少一道都会注出不该注的
 *
 *  1. **续跑不注** —— 存档里的 prompt 当年已经带过这段,再注一遍就是重复段落;
 *  2. **对话已经有消息就不注** —— 固定条件只需进上下文**一次**;第一轮注入之后它就
 *     一直在上下文里,后面每一轮再注就是同一段话反复出现(2026-09-19 裁定);
 *  3. **值为「不限」/没选的跳过** —— 拼出来的段为空就不动 prompt(那一层在
 *     `searchPrefs.nodeCriteriaPrompt` 里)。
 *
 * 调用方(`runner.startWorkflowRun`)负责把第 1、2 两道门的判据算出来传进来 —— 它那
 * 边才够得着存档和消息表。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import { MAIN_NODE_TYPE_ID, NODE_CRITERIA_PARAM_KEY } from "@contracts/nodeType";
import { nodeCriteriaPrompt, type CriteriaCondition } from "@main/lib/searchPrefs.js";

/**
 * 读主对话节点声明的那张条件表。**坏行丢掉,不抛** —— 参数是用户和 AI 都能写的自由
 * 数据,一行写坏了不该让整次运行起不来。
 *
 * 与渲染端(`chat/SearchFilterBar.criteriaRowsOf`)同一条读法,只是这里**不滤掉空候选
 * 的行**:候选值由用户在设置页里配,而"有下拉但还没配候选"在那边渲染成一个只有「—」的
 * 空下拉,注不出来任何东西(`nodeCriteriaPrompt` 看的是选中值)。两边的取舍不同是因为
 * 要回答的问题不同,不是读法分家。
 */
export function entryCriteriaOf(doc: WorkflowDoc): CriteriaCondition[] {
  const params = doc.nodes.find((node) => node.type === MAIN_NODE_TYPE_ID)?.params;
  const raw = params?.[NODE_CRITERIA_PARAM_KEY];
  if (!Array.isArray(raw)) return [];
  const out: CriteriaCondition[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { name, choices, note } = item as { name?: unknown; choices?: unknown; note?: unknown };
    if (typeof name !== "string" || !Array.isArray(choices)) continue;
    out.push({
      name,
      choices: choices.filter((c): c is string => typeof c === "string"),
      // 空解释不带上 —— 契约里它可选,而且一个空串在提示词里会变成一对空括号。
      ...(typeof note === "string" && note.trim() !== "" ? { note } : {}),
    });
  }
  return out;
}

/**
 * 把固定条件拼进这次运行的提示词。返回**新的 prompt**(没得注就原样返回)。
 *
 * `firstTurn` 由调用方算(`MessageRepo.hasAny(session.id) === false`);`resumed` 就是
 * "这次是不是点卡片接回来的"。两条都是普通布尔 —— 这个函数不去碰数据库,只做拼装。
 */
export function injectEntryCriteria(args: {
  doc: WorkflowDoc;
  workflowId: string;
  prompt: string;
  resumed: boolean;
  firstTurn: boolean;
}): string {
  if (args.resumed || !args.firstTurn) return args.prompt;
  const conditions = entryCriteriaOf(args.doc);
  if (conditions.length === 0) return args.prompt;
  const criteria = nodeCriteriaPrompt(args.workflowId, conditions);
  if (criteria.length === 0) return args.prompt;
  return args.prompt.length > 0 ? `${args.prompt}\n\n${criteria}` : criteria;
}
