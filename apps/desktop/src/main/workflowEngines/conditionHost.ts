/**
 * **Host 侧的条件求值** —— 复刻旧 `scheduler.conditionOutcome` 的求值语义，
 * 但把「上游结局从哪来」换成 native 侧能拿到的那一份。
 *
 * ## 为什么它在 Host，而不是在引擎子进程里
 *
 * Node-RED 的 `mcode-condition-eval` 节点（`mcodeNodeTypes.ts`）只是**信使**：它把
 * 表达式与本次消息流上已经发生的上游结果交给 Host，Host 求完把布尔写回去。
 * 求值放在 Host 的唯一理由是**语义只有一份**（硬规矩 2）：旧函数
 * `evaluateConditionExpression`（`@contracts/condition`）在这里被**直接调用**，
 * 不是抄一份。
 *
 * ## scope 与旧调度器的差别（这里是全部的差别，别处不要再说「等价」）
 *
 * 旧 `conditionOutcome` 的 scope（`scheduler.ts` 的 `templateScopeOf`）：
 *
 *   - `user`：这次运行的用户请求；
 *   - `upstream`：**上游传递闭包**里节点的 id 与标题；
 *   - `nodes`：**整张图**的节点，每个带 `outcome`（执行记录）与 `artifacts`；
 *   - `trigger`：触发载荷的平面事实。
 *
 * 本文件能拼出来的：
 *
 *   - `upstream`：**同一条规则**（`buildForwardAdjacency` + `upstreamClosure`），
 *     来自**宿主库里的那张文档**，不是重写一套邻接算法；
 *   - `nodes[].title/params`：来自同一张文档；
 *   - `nodes[].outcome`：来自消息流上的 `msg.mcode.results`（每个 `mcode-*` 节点
 *     执行完都会追加自己那一条，见 `mcodeNodePack.ts` 的 `outputMsg`）；
 *   - `user` / `trigger`：**没有**。原生触发节点的载荷不离开引擎进程，Host 看不到。
 *
 * ## 三类「拿不到」必须**报错**，不许落成 false
 *
 *  `readConditionRef` 对「值缺失」「字段缺失」返回 `found:false`（旧语义就是这样：
 *  `exists` 为假，其余谓词为假）。但**拿不到**是另一回事：
 *
 *   - `{{trigger.*}}`：Host 没有触发载荷；
 *   - `{{A.某产出变量}}`：native 执行记录不保留结构化产出变量；
 *   - 引用一个**原生节点**（`function` / `exec` / `inject` …）的 `status` / `error`：
 *     原生节点的结局只有引擎自己知道。
 *
 *  这三类在旧图上**能算出值**；在 native 侧让它们安静地为假，就是本卡要修的那种
 *  静默错。所以它们在进入 `evaluateConditionExpression` **之前**就被拒掉，
 *  错误信息点名是哪个引用、为什么。
 */
import { parseConditionExpression, evaluateConditionExpression } from "@contracts/condition";
import {
  classifyConditionRef,
  CONDITION_SWITCH_PROPERTY,
} from "@contracts/conditionBridge";
import {
  buildForwardAdjacency,
  upstreamClosure,
  type WorkflowDoc,
} from "@contracts/workflow";
import type { NodeTemplateNode, NodeTemplateScope } from "@contracts/nodeTemplate";

/** 一个 `mcode-*` 节点在本次消息流上留下的执行事实。 */
export interface ConditionResultEntry {
  /** Mcode 节点 id（`x-mcode.nodeId`，不是 native id）。 */
  nodeId: string;
  /** 结果文本（`payload.text`）。 */
  summary: string;
  /** `"success"` / `"failed"`；缺省按 success。 */
  status?: string;
}

export interface ConditionHostInput {
  /** 条件节点保存的那份 `params.expression`（原样，不再序列化/改写）。 */
  expression: unknown;
  /** 宿主库里的文档（上游闭包、标题、参数都从它来）。 */
  doc: WorkflowDoc;
  /** 条件节点的 Mcode id。 */
  nodeId: string;
  /** 消息流上已经发生的 `mcode-*` 执行事实。 */
  results: readonly ConditionResultEntry[];
}

export type ConditionHostOutcome =
  | { ok: true; matched: boolean }
  | { ok: false; error: string };

/** `mcode.*` 前缀 = 经 Host 的节点；其余（原生节点、扩展类型）Host 看不到结局。 */
function hostBackedType(type: string): boolean {
  return type.startsWith("mcode.");
}

/**
 * 校验并去重 `msg.mcode.results`。**不可信输入**：它来自 Node-RED 引擎进程的
 * 消息，任意节点都能往 `msg.mcode` 上写东西。只保留结构正确、且 nodeId 在
 * 文档里确实存在的条目；同 nodeId 取**最后一条**（后写的覆盖先写的，和
 * 「每次执行追加」的语义一致）。
 */
export function sanitizeConditionResults(
  raw: unknown,
  doc: WorkflowDoc,
): ConditionResultEntry[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(doc.nodes.map((node) => node.id));
  const byNode = new Map<string, ConditionResultEntry>();
  for (const item of raw.slice(-256)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const nodeId = entry["nodeId"];
    const summary = entry["summary"];
    if (typeof nodeId !== "string" || !known.has(nodeId)) continue;
    if (typeof summary !== "string") continue;
    const status = entry["status"];
    byNode.set(nodeId, {
      nodeId,
      summary: summary.slice(0, 32_000),
      ...(status === "success" || status === "failed" ? { status } : {}),
    });
  }
  return [...byNode.values()];
}

/**
 * 拼出旧调度器那份 `NodeTemplateScope` 里**本环境能拼的部分**，然后调用真的
 * `evaluateConditionExpression`。
 *
 * 求值之前先对每个引用做一次「能不能满足」的分类（见文件头）；有一条拿不到就
 * 整体失败 —— **不做部分求值**，否则 `or` 的另一条为真时会把拿不到的那条吞掉，
 * 用户永远看不到「这条在 native 侧算不了」。
 */
export function evaluateConditionForHost(input: ConditionHostInput): ConditionHostOutcome {
  const node = input.doc.nodes.find((candidate) => candidate.id === input.nodeId);
  if (node === undefined) {
    return { ok: false, error: `条件求值找不到节点「${input.nodeId}」—— 宿主库与画布不一致，拒绝猜测` };
  }
  const parsed = parseConditionExpression(input.expression);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const upstreamIds = upstreamClosure(
    buildForwardAdjacency(input.doc.nodes, input.doc.edges).deps,
    node.id,
  );
  const upstreamNames = new Set<string>();
  const nodes: NodeTemplateNode[] = [];
  for (const candidate of input.doc.nodes) {
    if (candidate.id !== node.id && !upstreamIds.has(candidate.id)) continue;
    upstreamNames.add(candidate.id);
    const title = (candidate.title ?? "").trim();
    if (title.length > 0) upstreamNames.add(title);
    if (candidate.id === node.id) continue;
    nodes.push({
      id: candidate.id,
      title: candidate.title ?? "",
      params: candidate.params,
    });
  }

  const results = sanitizeConditionResults(input.results, input.doc);
  const resultOf = new Map(results.map((entry) => [entry.nodeId, entry]));
  const typeOf = new Map(input.doc.nodes.map((candidate) => [candidate.id, candidate.type]));

  for (const rule of parsed.expression.rules) {
    const classified = classifyConditionRef(rule.ref);
    if (!classified.supported) {
      return { ok: false, error: `条件引用「${rule.ref}」在 Node-RED 侧算不了：${classified.reason}` };
    }
    // 「是不是上游」「标题有没有重名」不在这里判 —— `readConditionRef` 已经用
    // 同一个 scope 做这件事，再写一遍就是第二套判据。这里只补它不知道的那一层：
    // **原生节点的结局 Host 看不见**，`status` / `error` 不能落成 found:false。
    const target = input.doc.nodes.find((candidate) =>
      candidate.id === classified.name
      || (candidate.title ?? "").trim() === classified.name);
    if (target !== undefined && !hostBackedType(target.type)
      && (classified.field === "status" || classified.field === "error")) {
      return {
        ok: false,
        error: `条件引用「${rule.ref}」在 Node-RED 侧算不了：原生节点「${target.title || target.id}」的结局不离开引擎进程，Host 取不到它的 ${classified.field}`,
      };
    }
  }

  for (const entry of nodes) {
    const result = resultOf.get(entry.id);
    const type = typeOf.get(entry.id) ?? "";
    // 经 Host 的节点：有记录就有结局；没有记录 = 这次没走这条路（和旧调度器把
    // 未选中的支路标 `unselected` 同义），readConditionRef 会按 found:false 处理。
    // 原生节点：不伪造 `success` —— 没有 outcome，读值字段时 readConditionRef 会
    // 报「上游还没有结果」，这是刻意的 fail-closed。
    if (result !== undefined) {
      entry.outcome = {
        status: result.status === "failed" ? "failed" : "success",
        summary: result.summary,
        // `{{A.summary}}` 与 `{{A.output}}` 的**可观测结果**：`readConditionRef` 的
        // `readVar` 先查 `outcome.outputs.summary`，查不到再回落到 `outcome.summary`
        // （见 `@contracts/nodeTemplate` 的 `readVar`）。native 执行记录里
        // `payload.text` 就是旧调度器那个 `summary` 的位置，所以直接放进去 ——
        // 这不是「造一个产出变量」，是把它放在 `readVar` 找得到的那一格。
        outputs: { summary: result.summary },
      };
    } else if (hostBackedType(type)) {
      entry.outcome = { status: "unselected", summary: "" };
    }
  }

  const scope: NodeTemplateScope = {
    user: "",
    upstream: upstreamNames,
    nodes,
  };
  return evaluateConditionExpression(parsed.expression, scope);
}

/** 供错误信息与诊断：switch 读取的属性名（和迁移器同一个常量）。 */
export const CONDITION_HOST_RESULT_FIELD = CONDITION_SWITCH_PROPERTY;
