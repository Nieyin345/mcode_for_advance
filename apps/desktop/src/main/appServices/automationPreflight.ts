/**
 * **自动化触发的只读预检** —— 「在真正启动一次自动化之前,先问它会遇到什么」。
 *
 * ## 它补的是哪个洞
 *
 * `automation.run` 一按下去就 `fire()`:工作流被删、当前版本未审查、节点类型缺执行器、
 * 项目没了、触发器参数坏了 —— 这些全都在**起跑那一刻**才变成一句错误,而对
 * 带外部副作用的自动化,那时可能已经跑掉了前几步。Agent 想要「先看看会不会炸」,
 * 从前没有任何只读入口。
 *
 * ## 判据与边界
 *
 *  - **纯读**:不建会话、不写运行记录、不派发、不挂 watcher;所有宿主依赖(工作流文档、
 *    节点清单、能力清单)都由调用方**注入**,本文件因此可被无头套件直接打包(与
 *    `appServices/scenePreflight.ts` 同一条分法)。
 *  - 三类问题用同一个 `kind` 说话:
 *      - `corrupt`:存档读不出来(行在、payload 坏到连 id 都对不上)或文档形状不对;
 *      - `missing-executor`:能力预检发现缺执行器 / 缺引擎 —— 判据**复用**调度器的
 *        `requirementsForNode` + `checkNodeCapabilities` + `describeCapabilityProblems`
 *        (与真正派发前那道闸**同一份**,不另写一套);
 *      - `needs-grant`:当前版本未审查(导入 / AI 改过的图),或触发器自身参数解不开;
 *      - `missing`:工作流 / 触发器不存在。
 *  - `ok: true` 只意味着「预检没发现问题」,**不是执行授权**,更不代表跑得一定成功。
 *
 * ## 为什么 `capabilities` 也给出来
 *
 * Agent 要在「为什么不能跑」之外回答「它需要什么」。`required` 是这次预检收集到的
 * 需求(去重后的 `kind:id`),`available` 是这些需求里本机**已满足**的那些 —— 同一份
 * 解析结果的两个投影,不另算一遍。
 */
import type { CapabilityDescriptor, CapabilityRequirement } from "@contracts/capability";
import { describeCapabilityProblems } from "@contracts/capability";
import {
  parseTriggerSpec,
  providerIdOf,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { checkNodeCapabilities, requirementsForNode } from "@main/orchestration/capabilityResolver.js";

/** 一份预检问题。`kind` 是给 Agent 分支用的稳定枚举;`reason` 是给人看的一句话。 */
export interface AutomationPreflightProblem {
  kind: "corrupt" | "missing" | "missing-executor" | "needs-grant";
  reason: string;
}

export interface AutomationPreflightResult {
  ok: boolean;
  workflowId: string;
  triggerKey: string;
  /** 第一个问题(没有 = 不出现)。逐个问题按严重度排在前面的那个。 */
  problem?: AutomationPreflightProblem;
  /** 全部问题(不止第一条 —— 修一处又撞下一处是最烦的)。没问题是空数组。 */
  problems: AutomationPreflightProblem[];
  capabilities: {
    /** 这次预检收集到的需求(`kind:id`,去重、稳定排序)。 */
    required: string[];
    /** 其中本机已满足的那些。 */
    available: string[];
  };
}

/** 宿主注入的工作流读取口:返回 `null` = 不存在;`corrupt` = 行在但读不出来。 */
export type PreflightWorkflowLookup =
  | { kind: "ok"; doc: WorkflowDoc }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | null;

export interface AutomationPreflightDeps {
  /** 按 id 取工作流文档。`null` = 没有可靠的读口(按 missing 处理并说明)。 */
  getWorkflow: (id: string) => PreflightWorkflowLookup;
  /** 节点清单(内置 + 插件 + 本地)。 */
  loadManifests: () => Promise<Map<string, NodeTypeManifest>>;
  /** 能力清单 + 本次运行真正注册的执行器 kinds(与调度器预检同一份形状)。 */
  loadCapabilityInventory: () => Promise<{
    inventory: CapabilityDescriptor[];
    executorKinds: readonly string[];
  } | undefined>;
  /** 当前版本是否未审查(导入 / AI 改过)。返回 null = 已审查。 */
  reviewErrorOf: (doc: WorkflowDoc) => string | null;
}

const keyOfRequirement = (r: CapabilityRequirement): string => `${r.kind}:${r.id}`;

/**
 * 跑一次只读预检。**不抛**(除注入口本身爆炸 —— 调用方的那一层会把它变成错误),
 * 所有「会不会炸」都落在返回值里。
 */
export async function automationPreflight(
  input: { workflowId: string; triggerNodeId: string },
  deps: AutomationPreflightDeps,
): Promise<AutomationPreflightResult> {
  const { workflowId } = input;
  const triggerKey = `${workflowId}:${input.triggerNodeId}`;
  const result: AutomationPreflightResult = {
    ok: false,
    workflowId,
    triggerKey,
    problems: [],
    capabilities: { required: [], available: [] },
  };
  const add = (kind: AutomationPreflightProblem["kind"], reason: string): void => {
    result.problems.push({ kind, reason });
  };

  // ── 1. 工作流文档 ──
  const found = deps.getWorkflow(workflowId);
  if (found === null || found.kind === "missing") {
    add("missing", `工作流「${workflowId}」不存在(可能已被删除)`);
    result.problem = result.problems[0];
    return result;
  }
  if (found.kind === "corrupt") {
    add("corrupt", `工作流「${workflowId}」的存档损坏,读不出来:${found.reason}`);
    result.problem = result.problems[0];
    return result;
  }
  const doc = found.doc;

  // ── 2. 审查状态(needs-grant)──
  const reviewError = deps.reviewErrorOf(doc);
  if (reviewError !== null) add("needs-grant", reviewError);

  // ── 3. 触发器节点与参数 ──
  const node = doc.nodes.find((n) => n.id === input.triggerNodeId);
  if (node === undefined) {
    add("missing", `触发器「${input.triggerNodeId}」不在工作流「${doc.name || workflowId}」里`);
    result.problem = result.problems[0];
    return result;
  }
  let manifests: Map<string, NodeTypeManifest>;
  try {
    manifests = await deps.loadManifests();
  } catch (err) {
    add("missing-executor", `读节点类型清单失败:${(err as Error).message}`);
    result.problem = result.problems[0];
    return result;
  }
  const triggerManifest = manifests.get(node.type);
  if (triggerManifest === undefined) {
    add("missing", `触发器节点类型「${node.type}」没装(清单里没有)`);
    result.problem = result.problems[0];
    return result;
  }
  const spec = parseTriggerSpec(triggerManifest, node.params);
  if (!spec.ok) add("needs-grant", `触发器参数不完整:${spec.error}`);

  // ── 4. 逐节点能力预检(与调度器同一份判据)──
  const preflight = await deps.loadCapabilityInventory();
  if (preflight === undefined) {
    // 清单装配不了 ≠ 通过。如实说"查不了",不谎报"都在"。
    add("missing-executor", "能力清单装配失败,无法确认节点所需能力是否齐全(请检查插件 / 执行器注册表)");
  } else {
    const required: CapabilityRequirement[] = [];
    const available: CapabilityRequirement[] = [];
    for (const each of doc.nodes) {
      const manifest = manifests.get(each.type);
      if (manifest === undefined) {
        add("missing-executor", `节点「${each.title || each.id}」的类型「${each.type}」没装 —— 缺执行器`);
        continue;
      }
      // ⚠️ skill / mcp 与调度器同一条取舍:**这一轮不查** —— 宿主没有可靠的
      // "全部可用技能 / MCP"清单来源,拿不完整的清单去对会把"选了技能"误判成
      // "缺技能"(误伤比漏检难看)。见 scheduler.ts 的同一段注释。
      const requirements = requirementsForNode(manifest, each.params, providerIdOf(each.params), preflight.executorKinds)
        .filter((r) => r.kind !== "skill" && r.kind !== "mcp");
      const resolution = checkNodeCapabilities(manifest, requirements, preflight.inventory);
      required.push(...resolution.available, ...resolution.missing,
        ...resolution.incompatible.map((p) => p.requirement));
      available.push(...resolution.available);
      const problems = describeCapabilityProblems(resolution);
      for (const problem of problems) add("missing-executor", `「${each.title || each.id}」:${problem}`);
    }
    const unique = (list: CapabilityRequirement[]): string[] =>
      [...new Set(list.map(keyOfRequirement))].sort();
    result.capabilities = { required: unique(required), available: unique(available) };
  }

  // ── 5. 收口 ──
  result.ok = result.problems.length === 0;
  result.problem = result.problems[0];
  return result;
}
