/**
 * Workflow 生成质量闸门 —— Agent(或任何人)给出的整份文档,存盘 / 导入前过这里。
 *
 * ## 它管三件事(对应 v2 计划的 WF-09 / WF-05 / WF-08)
 *
 * - **WF-09 校验报告**:{@link validateWorkflowDoc} 把一份文档查一遍,产出一份带
 *   **稳定错误码**的 {@link WorkflowValidationReport}(类型在 `@contracts/workflow`)。
 *   图错误(环/断链/悬空边/分支语义)、参数错误、引用错误各有各的 code,Agent 拿到
 *   report 能按 code 定位"哪一类错、在哪一步",照着改再存一次 —— 而不是只拿到一句
 *   没法行动的话。
 * - **WF-05 schema**:文档级的 `schemaVersion` / `inputSchema` / `outputSchema` 长在
 *   `@contracts/workflow` 的 `WorkflowDocSchema` 上(宽松、可选、向后兼容);这里只有
 *   import/export 对 `schemaVersion` 的核对规则。
 * - **WF-08 导入导出**:{@link exportWorkflowDoc} / {@link importWorkflowDoc}。
 *   导入先过契约形状、再核版本、再过 {@link validateWorkflowDoc},任一步不过就拒绝
 *   并带回 report —— **不过校验的文档进不了库**。
 *
 * ## 语义从哪儿来(一条都不新造)
 *
 * 环与闸门的判据 = `@contracts/workflow` 的 `validateDag` / `backEdgesOf`(环上必须有
 * "决定权给用户"的分支,模型选的分支拦不住回头);"上游" = `buildForwardAdjacency` +
 * `upstreamClosure`(回边不算依赖 —— 同调度器的求值顺序);参数 = `validateNodeParams`
 * + `validateOutputRules`(contracts 里那两把现成的尺);`{{...}}` 引用的词法与
 * `@contracts/nodeTemplate` 一致(同一条 `{{...}}` 正则、同一个 `\{{` 转义)—— 这里
 * **只查引用存不存在,不实现展开**,展开仍然只有 nodeTemplate 那一份。
 *
 * ## 纯函数,可注入
 *
 * 本模块不 import 任何会碰 DB / electron / 文件的东西:节点类型清单由调用方注入
 * (`opts.types`,主进程来自 `nodeTypes.ts` 的 `loadNodeTypes()`,冒烟测试给夹具)。
 * 全部检查都能在 node 下直接跑 —— `scripts/workflow-validation-smoke` 就是证据。
 */

import {
  WorkflowDocSchema,
  backEdgesOf,
  buildForwardAdjacency,
  upstreamClosure,
  type WorkflowDoc,
  type WorkflowNode,
  type WorkflowValidationIssue,
  type WorkflowValidationReport,
} from "@contracts/workflow";
import {
  BRANCH_NODE_TYPE_ID,
  MAIN_NODE_TYPE_ID,
  deciderOf,
  isModelDecider,
  validateNodeParams,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import {
  DECIDE_VAR_NAME,
  NODE_OUTPUT_VARS_KEY,
  normalizeVars,
  validateOutputRules,
} from "@contracts/outputConstraint";

/* ── schemaVersion(WF-05) ── */

/**
 * 当前 import/export 的读写版本。兼容规则:**缺失或等于现值即接受**,别的值拒绝 ——
 * 缺失是老文档(它们本来就是按这一套形状写的),等于现值是正常情况,别的值说明
 * 是更新(或更旧)的一套序列化,瞎读只会读出一份看起来能用、其实语义错位的文档。
 */
export const WORKFLOW_SCHEMA_VERSION = "1";

/* ── 校验入口 ── */

export interface WorkflowValidationOptions {
  /**
   * 节点类型清单(键 = 类型 id,值 = 清单)。来自 `nodeTypes.ts` 的 `loadNodeTypes()`。
   * **不传 = 跳过**类型存在性、参数、分支语义这些"要认识类型才能判"的检查 —— 图结构
   * 与引用检查不依赖它,照跑。注入而不是自己去读,是为了保持纯函数:主进程给真的,
   * 冒烟给夹具。
   */
  types?: ReadonlyMap<string, NodeTypeManifest>;
  /**
   * 认不出的节点类型按哪一档报。默认 **error** —— 这个闸门的首要服务对象是 Agent
   * 生成的文档,生成器用了这台机器没有的类型就该被拦下重写。**存盘路径传
   * "warning"**:一份别人分享来的工作流,类型没装也得能存能看(见
   * `@contracts/workflow` 文件头"类型认不出来不算错误"),那条分享语义不能被这里收紧。
   */
  unknownTypeSeverity?: "error" | "warning";
}

/** 节点在报错里的叫法:标题优先,退回 id(同 `library.ts` 那条规矩)。 */
function labelOf(node: WorkflowNode): string {
  return node.title || node.id;
}

/**
 * 一段文本里的**全部** `{{...}}` 引用。词法与 `@contracts/nodeTemplate` 同一套:
 * 同样的正则、同样的 `\{{` 转义(先藏起来,不把转义写法当引用)。
 * 这里只做**引用存在性**检查;解算/展开只在 nodeTemplate 那一份。
 */
function templateRefs(text: string): string[] {
  const ESC = "\u0000mcode-lbrace\u0000";
  const guarded = text.split("\\{{").join(ESC);
  return [...guarded.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1] ?? "");
}

/** 节点参数里的**全部字符串值**(含数组与一层对象里的 —— 选项表、变量表都是字符串的家)。 */
function* stringValuesOf(params: Record<string, unknown>): Generator<string> {
  for (const value of Object.values(params)) {
    if (typeof value === "string") {
      yield value;
    } else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") yield item;
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (typeof item === "string") yield item;
      }
    }
  }
}

/**
 * 一个节点**声明过**的可引用产出:产出变量表(`outputVars`)+ 类型清单里声明的
 * outputs 键 + 模型选的分支必交的「出路」。类型认不出来时返回 undefined —— 不猜它
 * 交什么,引用检查对它跳过(同"类型缺失不算错误"的分享语义)。
 *
 * ## 「出路」为什么在这里(2026-09-19)
 *
 * 模型选的分支**必须**交 `出路`(值就是它选的那条边的名字,见
 * `@contracts/outputConstraint` 的 `DECIDE_VAR_NAME`),调度器拿它查产出、对边,
 * 交不出来那一步直接失败。可这份名单以前不算它 —— 于是用户写下 `{{判断.出路}}`
 * 去接那条路时会**存不下去**,报"「判断」没有声明产出变量「出路」"。一边逼模型交,
 * 一边不让下游取,自相矛盾。
 *
 * 只对**模型选**的分支加:决定权在用户时那一项由点选产生,不要求模型交,追进去会
 * 让一个取不到的写法通过校验(同 `outputVarsFor` 的判据)。
 */
function declaredOutputsOf(
  node: WorkflowNode,
  types: ReadonlyMap<string, NodeTypeManifest> | undefined,
): Set<string> | undefined {
  const manifest = types?.get(node.type);
  const declared = new Set(normalizeVars(node.params[NODE_OUTPUT_VARS_KEY]).map((v) => v.name));
  for (const output of manifest?.outputs ?? []) declared.add(output.key);
  if (manifest !== undefined && isModelDecider(manifest, node.params)) {
    declared.add(DECIDE_VAR_NAME);
  }
  if (declared.size === 0 && manifest === undefined) return undefined;
  return declared;
}

/** `{{节点.字段}}` 里**值类**字段之外的那些 —— 元信息/配置/产物路径,取不到不算变量错。 */
function isMetaField(field: string): boolean {
  return (
    field === "output" ||
    field === "status" ||
    field === "error" ||
    field === "title" ||
    field === "artifacts" ||
    field.startsWith("artifacts.") ||
    field.startsWith("artifacts[") ||
    field.startsWith("params.")
  );
}

/**
 * 校验一份工作流文档(WF-09)。**这是保存/导入前的那道闸**,检查项与错误码:
 *
 * | code | 级别 | 是什么 |
 * |---|---|---|
 * | `graph.duplicate-node-id` | error | 节点 id 重复 |
 * | `graph.duplicate-edge-id` | error | 边 id 重复 |
 * | `graph.dangling-edge` | error | 边的端点指向不存在的节点(悬空边) |
 * | `graph.self-loop` | error | 节点依赖自己 |
 * | `graph.cycle` | error | 有闸门拦不住的环(环上没有"决定权给用户"的分支) |
 * | `graph.orphan-node` | warning | 节点没有入边也不是起点(主代理/触发器/唯一节点豁免)。**只提醒不拦** —— 旧 `validateDag` 允许多入口图,存量工作流与既存夹具依赖这个语义,保存闸门不能比旧语义更严 |
 * | `graph.no-main-node` | error | 工作流一个主节点(主代理 `mcode.main`)都没有 —— 它是用户对话的入口,缺了这张图就没有"用户那一头"。**只查普通工作流**(有 `trigger` 的自动化不查,它的入口是触发器) |
 * | `graph.multiple-main-nodes` | error | 主节点超过一个 —— 只能有一个,多一个就说不清用户那句话听谁的 |
 * | `graph.no-trigger-node` | error | 自动化一个触发器都没有。从前这是**静默降级**(`deriveTrigger` 悄悄删掉 `trigger` 字段、当成普通工作流存),现在明确拒绝 |
 * | `branch.no-options` | error | 分支节点一条出边都没有 —— 选项就是出边,没得出可选 |
 * | `node.unknown-kind` | 见 opts | 节点类型不在注入的清单里(存盘=warning,导入=error) |
 * | `param.missing` / `param.invalid` | error | 参数对类型清单不合规(必填缺失/形状不对) |
 * | `ref.empty` | error | 空引用 `{{}}` |
 * | `ref.unknown-node` | error | 引用的节点图上没有 |
 * | `ref.ambiguous-title` | error | 引用名同时是多个节点的标题 |
 * | `ref.not-upstream` | error | 引用的节点在图上但不是这一步的上游 |
 * | `ref.unknown-output` | error | 引用的产出变量,上游没声明过 |
 *
 * 不检查 runner.kind 是否在执行器注册表里:执行器注册表带**兜底执行器**
 * (`ExecutionEngine.setDefault`),任何 kind 都有路可跑;类型能不能跑是**类型**的问题,
 * 不是这份文档的问题。
 */
export function validateWorkflowDoc(
  doc: WorkflowDoc,
  opts: WorkflowValidationOptions = {},
): WorkflowValidationReport {
  const errors: WorkflowValidationIssue[] = [];
  const warnings: WorkflowValidationIssue[] = [];
  const types = opts.types;
  const unknownSeverity = opts.unknownTypeSeverity ?? "error";

  const nodes = doc.nodes;
  const edges = doc.edges;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const manifestOf = (node: WorkflowNode): NodeTypeManifest | undefined => types?.get(node.type);

  const fail = (issue: WorkflowValidationIssue): void => void errors.push(issue);
  const hint = (issue: WorkflowValidationIssue): void => void warnings.push(issue);

  /* ── 图结构 ── */

  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.id)) {
      fail({ code: "graph.duplicate-node-id", nodeId: node.id, message: `节点 id 重复:${node.id}` });
    }
    seenNodeIds.add(node.id);
  }

  const seenEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      fail({ code: "graph.duplicate-edge-id", message: `边 id 重复:${edge.id}` });
    }
    seenEdgeIds.add(edge.id);
    if (!seenNodeIds.has(edge.from)) {
      fail({ code: "graph.dangling-edge", message: `边「${edge.id}」的上游节点不存在:${edge.from}` });
    }
    if (!seenNodeIds.has(edge.to)) {
      fail({ code: "graph.dangling-edge", message: `边「${edge.id}」的下游节点不存在:${edge.to}` });
    } else if (edge.from === edge.to) {
      const node = byId.get(edge.to);
      fail({
        code: "graph.self-loop",
        nodeId: edge.to,
        message: `节点「${node ? labelOf(node) : edge.to}」不能依赖自己`,
      });
    }
  }

  // 环:回边 ⟺ 环(contracts 的标准结论)。闸门 = 环上"决定权给用户"的分支;
  // 认不出的类型**不算**闸门(同 `library.ts` 那条:拒了才知道要装什么,但环照样是环 ——
  // 而未知类型在存盘档位是 warning,不能反过来把环也放行)。没有类型清单时一律无闸门
  // (老行为,同 `validateDag` 的默认)。
  const isLoopGate = (id: string): boolean => {
    const node = byId.get(id);
    if (!node) return false;
    const manifest = manifestOf(node);
    return manifest !== undefined && manifest.runner.kind === "branch" && deciderOf(node.params) !== "model";
  };
  const openBack = backEdgesOf(nodes, edges).filter((b) => !b.cycle.some(isLoopGate));
  if (openBack.length > 0) {
    const onCycle = [...new Set(openBack.flatMap((b) => b.cycle))].sort();
    fail({
      code: "graph.cycle",
      message:
        `图里有环,涉及节点:${onCycle.map((id) => byId.get(id)).filter((n): n is WorkflowNode => n !== undefined).map(labelOf).join("、")}。` +
        "环上必须有一个**岔路口**(决定权给我的分支节点)—— 每一圈都要人点一下才走,有它在才停得下来。",
    });
  }

  // 断链:没有入边、又不是起点的节点。起点 = 主代理(用户那句话的第一站)、触发器
  // (自动化的起点);只有一个节点的图不查(独苗没有"链"可言)。**认不出的类型不判**
  // —— 不知道它是不是起点,不猜(同分享语义)。
  //
  // **这一条只提醒、不拦**(2026-09-18 整合门裁定):旧 `validateDag` 从不查"入边",
  // 多入口图是既存合法语义(mcode-admin 冒烟的"一份正常的图"、mcp-endpoint 的保存
  // 流程都靠它),闸门加严会连锁打断它们。提醒放在 warnings 里,保存/导入照常放行。
  if (nodes.length > 1) {
    const hasIn = new Set(edges.filter((e) => seenNodeIds.has(e.to)).map((e) => e.to));
    for (const node of nodes) {
      if (hasIn.has(node.id)) continue;
      const manifest = manifestOf(node);
      if (manifest === undefined) continue;
      if (manifest.runner.kind === "trigger" || node.type === MAIN_NODE_TYPE_ID) continue;
      hint({
        code: "graph.orphan-node",
        nodeId: node.id,
        message: `节点「${labelOf(node)}」没有任何入边,也不是起点(主代理/触发器)—— 它拿不到上游,多半是有一根线忘了拉`,
      });
    }
  }

  /* ── 两条硬约束(2026-09-18 产品裁定) ── */

  // **工作流必须有且只有一个主节点。** 主节点就是主对话 —— 用户选一个工作流、开一段
  // 新对话,那句话从这里进来,子代理节点在它下游干活、跑完把结果交给它。没有它,这张图
  // 就没有"用户对话的那一头",跑起来谁收用户那句话都说不清;有两个,更是不知道听谁的。
  //
  // 自动化不查这条:它的开头是触发器,用户那句话从触发器的参数进来(触发器的 `task`)。
  //
  // 只对**有主节点概念**的图生效:图是空的、或全是认不出的类型时不判(同"不猜"语义)。
  if (doc.trigger === undefined && nodes.length > 0) {
    const known = nodes.filter((n) => manifestOf(n) !== undefined);
    if (known.length > 0) {
      const mains = nodes.filter((n) => n.type === MAIN_NODE_TYPE_ID);
      if (mains.length === 0) {
        fail({
          code: "graph.no-main-node",
          message:
            "这份工作流没有主节点(主代理)—— 用户选工作流、开一段新对话,话是从主节点进去的;" +
            "没有它,这张图就没有用户对话的那一头。加一个主代理节点当开头。",
        });
      } else if (mains.length > 1) {
        fail({
          code: "graph.multiple-main-nodes",
          message:
            `这份工作流有 ${mains.length} 个主节点(${mains.map(labelOf).join("、")})—— 只能有一个:` +
            "它是用户对话的入口,多一个就说不清听谁的。其余那几个改成子 agent 或对话节点。",
        });
      }
    }
  }

  // **自动化至少要有一个触发器。** 触发器是自动化的起点 —— 什么条件下起一次运行由它说。
  // 一个都没有时,`deriveTrigger` 会**静默**把 `trigger` 字段删掉、这份文档就降级成普通
  // 工作流:用户以为自己建了个自动化、实际得到一个要手动发消息才动的东西。出错要出声。
  if (doc.trigger !== undefined) {
    const triggers = nodes.filter((n) => manifestOf(n)?.runner.kind === "trigger");
    if (triggers.length === 0) {
      fail({
        code: "graph.no-trigger-node",
        message:
          "这份自动化一个触发器都没有 —— 触发器是它的起点(定时/文件变化/事件发生时),没有它就不会自己跑。" +
          "加一个触发器节点,或者把它改成普通工作流。",
      });
    }
  }

  /* ── 节点类型与参数 ── */

  for (const node of nodes) {
    if (types !== undefined && !types.has(node.type)) {
      const issue: WorkflowValidationIssue = {
        code: "node.unknown-kind",
        nodeId: node.id,
        message: `节点「${labelOf(node)}」的类型「${node.type}」不在这台机器的注册表里 —— 跑之前得先装上它`,
      };
      if (unknownSeverity === "error") fail(issue);
      else hint(issue);
    }
  }

  // 分支节点的**选项就是它的出边**(contracts 的 edge 模型):一条出边都没有 = 没得出
  // 可选,这一步必然卡死。反过来(普通边带 label "填了不显示")契约层明确不拦,这里也不拦。
  for (const node of nodes) {
    const manifest = manifestOf(node);
    const isBranch = manifest ? manifest.runner.kind === "branch" : node.type === BRANCH_NODE_TYPE_ID;
    if (isBranch && !edges.some((e) => e.from === node.id)) {
      fail({
        code: "branch.no-options",
        nodeId: node.id,
        message: `分支「${labelOf(node)}」一条出边都没有 —— 选项就是它的出边,从它拉几根线到下一步才有路可选`,
      });
    }
  }

  for (const node of nodes) {
    const manifest = manifestOf(node);
    if (!manifest) continue;
    const paramsCheck = validateNodeParams(manifest, node.params);
    if (!paramsCheck.ok) {
      fail({
        // 必填缺失单独一个 code:Agent 收到它该做的动作是"把这个参数填上",
        // 而不是别的(形状错可能是生成器根本不认识这个参数)。
        code: paramsCheck.error.includes("必填") ? "param.missing" : "param.invalid",
        nodeId: node.id,
        message: `节点「${labelOf(node)}」:${paramsCheck.error}`,
      });
    }
    const rulesCheck = validateOutputRules(manifest, node.params);
    if (!rulesCheck.ok) {
      fail({
        code: "param.invalid",
        nodeId: node.id,
        message: `节点「${labelOf(node)}」:${rulesCheck.error}`,
      });
    }
  }

  /* ── `{{...}}` 引用存在性 ── */

  // "上游"用前进边邻接表算(回边不算依赖)—— 与调度器的求值顺序同一份答案。
  const forward = buildForwardAdjacency(nodes, edges);
  for (const node of nodes) {
    const upstream = upstreamClosure(forward.deps, node.id);
    for (const text of stringValuesOf(node.params)) {
      for (const spec of templateRefs(text).map((s) => s.trim())) {
        if (spec.length === 0) {
          fail({ code: "ref.empty", nodeId: node.id, message: `节点「${labelOf(node)}」里有一处空的引用 \`{{}}\` —— 写成 \`{{节点.变量}}\`,或者删掉它` });
          continue;
        }
        if (spec === "user") continue; // 内置字段:这次运行的用户请求,永远可引用

        const dot = spec.indexOf(".");
        const name = (dot < 0 ? spec : spec.slice(0, dot)).trim();
        const field = dot < 0 ? "output" : spec.slice(dot + 1).trim();
        if (name.length === 0) {
          fail({ code: "ref.empty", nodeId: node.id, message: `节点「${labelOf(node)}」里有一处引用没写节点名:\`{{${spec}}}\`` });
          continue;
        }

        // 名字按 id 优先、标题兜底来认(同 nodeTemplate 的解法;重名标题解算必炸,这里拦下)。
        let target = byId.get(name);
        if (!target) {
          const byTitle = nodes.filter((n) => n.title === name);
          if (byTitle.length > 1) {
            fail({ code: "ref.ambiguous-title", nodeId: node.id, message: `节点「${labelOf(node)}」引用的 \`${name}\` 同时是多个节点的标题 —— 改用它俩的 id` });
            continue;
          }
          target = byTitle[0];
        }
        if (!target) {
          fail({ code: "ref.unknown-node", nodeId: node.id, message: `节点「${labelOf(node)}」引用不到 \`{{${spec}}}\` —— 图上没有「${name}」这个节点(id、标题都对不上)` });
          continue;
        }
        if (!upstream.has(target.id)) {
          fail({ code: "ref.not-upstream", nodeId: node.id, message: `节点「${labelOf(node)}」引用了 \`{{${spec}}}\` —— 「${name}」在图上,但不是这一步的上游(只能引用上游,要连一根线过来)` });
          continue;
        }
        // 元信息/配置/产物路径只要上游对就行;剩下的都是"值",值得上游声明过才取得到。
        if (isMetaField(field)) continue;
        const varName = field.startsWith("outputs.") ? field.slice("outputs.".length).trim() : field;
        if (varName.length === 0) {
          fail({ code: "ref.empty", nodeId: node.id, message: `节点「${labelOf(node)}」里 \`outputs.\` 后面是空的:\`{{${spec}}}\`` });
          continue;
        }
        const declared = declaredOutputsOf(target, types);
        if (declared !== undefined && !declared.has(varName)) {
          fail({
            code: "ref.unknown-output",
            nodeId: node.id,
            message:
              `节点「${labelOf(node)}」要取 \`{{${spec}}}\` —— 「${name}」没有声明产出变量「${varName}」` +
              (declared.size > 0 ? `(它声明过:${[...declared].join("、")})` : "(它一张产出变量表都没填)") +
              "。去那一步的「产出变量」里加一行,或者改用已声明的名字",
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ── 导入 / 导出(WF-08) ── */

/**
 * 导出一份文档为 JSON 文本:**总是带上 `schemaVersion`**。缩进两格 —— 导出的东西是
 * 给人读、给人 diff 的,一行超长 JSON 是反这份用途的。
 */
export function exportWorkflowDoc(doc: WorkflowDoc): string {
  return `${JSON.stringify({ ...doc, schemaVersion: WORKFLOW_SCHEMA_VERSION }, null, 2)}\n`;
}

export type WorkflowImportResult =
  | { ok: true; doc: WorkflowDoc }
  | { ok: false; report: WorkflowValidationReport };

/**
 * 从 JSON 文本导入一份文档。**三道关,逐道拒绝**:
 *
 * 1. JSON 解析 → `schema.invalid-json`;
 * 2. `WorkflowDocSchema` 形状核对 → `schema.invalid`(契约是单一事实源,不在这里另立一份);
 * 3. `schemaVersion` 核对(缺失或等于 {@link WORKFLOW_SCHEMA_VERSION} 即过)→ `schema.version-unsupported`;
 * 4. {@link validateWorkflowDoc} → 不过就原样带回 report。
 *
 * 全过时返回一份**规范化**的文档:zod 会剥掉契约外的键,并补上 `schemaVersion`。
 * 注意通过与否取决于 `opts`:默认档位下,用了这台机器没装的节点类型的文档**进不来**
 * (error);调用方想要"先收下、缺的以后装"的宽松语义,传
 * `{ unknownTypeSeverity: "warning" }`。
 */
export function importWorkflowDoc(text: string, opts: WorkflowValidationOptions = {}): WorkflowImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      report: {
        ok: false,
        errors: [{ code: "schema.invalid-json", message: `不是合法的 JSON:${(err as Error).message}` }],
        warnings: [],
      },
    };
  }

  const shape = WorkflowDocSchema.safeParse(parsed);
  if (!shape.success) {
    const detail = shape.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(根)"}:${i.message}`)
      .join("; ");
    return {
      ok: false,
      report: {
        ok: false,
        errors: [{ code: "schema.invalid", message: `文档形状不符合 WorkflowDoc 契约:${detail}` }],
        warnings: [],
      },
    };
  }
  const doc: WorkflowDoc = shape.data;

  if (doc.schemaVersion !== undefined && doc.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    return {
      ok: false,
      report: {
        ok: false,
        errors: [{
          code: "schema.version-unsupported",
          message: `schemaVersion「${doc.schemaVersion}」不被支持 —— 这里的读法是「${WORKFLOW_SCHEMA_VERSION}」(缺失也按它算)`,
        }],
        warnings: [],
      },
    };
  }

  const report = validateWorkflowDoc(doc, opts);
  if (!report.ok) return { ok: false, report };
  return { ok: true, doc: { ...doc, schemaVersion: WORKFLOW_SCHEMA_VERSION } };
}
