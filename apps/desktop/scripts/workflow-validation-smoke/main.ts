import { showsNodeCapability, type NodeTypeManifest, type NodeOutcome } from "@contracts/nodeType";
import { checkOutput, outputVarsOf, referenceableOutputsOf, usesOutputRules } from "@contracts/outputConstraint";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import {
  exportWorkflowDoc,
  importWorkflowDoc,
  validateWorkflowDoc,
  WORKFLOW_SCHEMA_VERSION,
} from "@main/orchestration/workflowValidation.js";
// 4g / 4h 两段要断言的是**真货**:内置清单那一条 `mcode.command` 的 `usage` 文案,以及
// 真调度器 + 真命令执行器跑一遍时,那张产出变量表到底被判成什么。手抄一份进夹具测的是
// 抄本 —— 而这两条偏偏只在真货上才有意义(抄本没有"跟实现说同一件事"这回事)。
// run.sh 为此带了 stubs + banner。
import { builtinCommandManifest } from "@main/orchestration/nodeTypes.js";
import { runCommandNode } from "@main/orchestration/commandRunner.js";
import { runWorkflow, type RunPorts, type RunReport } from "@main/orchestration/scheduler.js";
import type { SpawnFn } from "@main/lib/spawnRun.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/* ── 断言骨架 ── */

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}
function hasCode(report: { errors: { code: string; nodeId?: string }[] }, code: string, nodeId?: string): boolean {
  return report.errors.some((e) => e.code === code && (nodeId === undefined || e.nodeId === nodeId));
}
/** `warnings` 可以整段缺席 —— 那正是「导入把提醒丢了」这个 bug 的形状,断言要能
 *  把它报成一条 FAIL,而不是让冒烟自己崩在这儿。 */
function hasWarning(
  report: { warnings?: { code: string; nodeId?: string }[] },
  code: string,
  nodeId?: string,
): boolean {
  return (report.warnings ?? []).some((w) => w.code === code && (nodeId === undefined || w.nodeId === nodeId));
}

/* ── 夹具:一份最小的类型清单(纯数据,不读盘) ── */

function agentManifest(id: string): NodeTypeManifest {
  return {
    id,
    manifestVersion: 1,
    name: id,
    runner: { kind: "prompt" },
    capability: "read",
    params: [
      { key: "instruction", kind: "longtext", label: "指令", required: true },
      { key: "outputVars", kind: "variables", label: "产出变量" },
    ],
    outputs: [{ key: "summary", label: "结果文本" }],
  };
}
const TYPES = new Map<string, NodeTypeManifest>([
  ["mcode.main", agentManifest("mcode.main")],
  ["mcode.agent", agentManifest("mcode.agent")],
  ["mcode.branch", { id: "mcode.branch", manifestVersion: 1, name: "分支", runner: { kind: "branch" }, capability: "read", params: [] }],
  ["mcode.trigger", {
    id: "mcode.trigger",
    manifestVersion: 1,
    name: "触发器",
    runner: { kind: "trigger" },
    capability: "read",
    // `triggerKind` 这一格是**必须的**:`triggerFactKeysOf` 读它算「能插哪些
    // `{{trigger.*}}`」,校验器要靠同一份答案放行(见下面 4c 那一段)。`options` 也要给
    // —— `select` 的取值不在候选里是 `param.invalid`,那条会把 4c 的断言淹掉。
    params: [{
      key: "triggerKind",
      kind: "select",
      label: "触发方式",
      options: [
        { value: "manual", label: "手动" },
        { value: "schedule", label: "定时" },
        { value: "file", label: "文件变动" },
        { value: "event", label: "事件" },
      ],
    }],
  }],
]);

/* ── 夹具:文档构造 ── */

function node(id: string, type: string, params: Record<string, unknown>, title = id): WorkflowNode {
  return { id, type, title, params, position: { x: 0, y: 0 } };
}
function edge(id: string, from: string, to: string): WorkflowEdge {
  return { id, from, to };
}
function doc(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDoc {
  return { id: "wf_smoke", name: "冒烟", builtin: false, updatedAt: 0, nodes, edges };
}
const SAY = { instruction: "做这一步" };
const OPTS = { types: TYPES };

/* ── 1. 合法文档:全绿,零错误零警告 ── */

const validDoc = doc(
  [
    node("A", "mcode.main", { instruction: "先看 {{user}} 说了什么再拆;字面写法 \\{{not-a-ref}} 不是引用" }),
    node("B", "mcode.agent", { instruction: "算出年份", outputVars: [{ name: "年份", example: "2024" }] }),
    node("C", "mcode.agent", { instruction: "把 {{B.年份}} 写进结论,依据 {{A}} 的拆解" }),
  ],
  [edge("e1", "A", "B"), edge("e2", "B", "C")],
);
const good = validateWorkflowDoc(validDoc, OPTS);
check("合法文档通过", good.ok, good);
check("合法文档零错误零警告", good.errors.length === 0 && good.warnings.length === 0, good);
check("转义与 {{user}} 不算坏引用", good.ok, good.errors);

/* ── 2. 图错误 ── */

const cycle = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", SAY), node("C", "mcode.agent", SAY)], [edge("e1", "A", "B"), edge("e2", "B", "C"), edge("e3", "C", "A")]),
  OPTS,
);
check("无闸门的环被拒", hasCode(cycle, "graph.cycle"), cycle.errors);

const orphan = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", SAY), node("D", "mcode.agent", SAY, "孤步骤")], [edge("e1", "A", "B")]),
  OPTS,
);
check(
  "断链(无入边且非起点)只提醒不拦 —— 旧语义允许多入口图",
  orphan.ok === true && orphan.warnings.some((w) => w.code === "graph.orphan-node" && w.nodeId === "D"),
  { ok: orphan.ok, warnings: orphan.warnings },
);

const dangling = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY)], [edge("e1", "A", "ghost")]),
  OPTS,
);
check("悬空边被报出", hasCode(dangling, "graph.dangling-edge"), dangling.errors);

const selfLoop = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY)], [edge("e1", "A", "A")]),
  OPTS,
);
check("自环被报出", hasCode(selfLoop, "graph.self-loop", "A"), selfLoop.errors);

const dup = validateWorkflowDoc(
  doc([node("dup", "mcode.agent", SAY), node("dup", "mcode.agent", SAY)], []),
  OPTS,
);
check("节点 id 重复被报出", hasCode(dup, "graph.duplicate-node-id", "dup"), dup.errors);

const gatedCycle = validateWorkflowDoc(
  doc(
    [node("A", "mcode.main", SAY), node("BR", "mcode.branch", { decider: "user" }), node("B", "mcode.agent", SAY)],
    [edge("e1", "A", "BR"), edge("e2", "BR", "B"), edge("e3", "B", "BR")],
  ),
  OPTS,
);
check("环上有用户分支闸门 → 放行", gatedCycle.ok, gatedCycle.errors);

const modelCycle = validateWorkflowDoc(
  doc(
    [node("A", "mcode.main", SAY), node("BR", "mcode.branch", { decider: "model" }), node("B", "mcode.agent", SAY)],
    [edge("e1", "A", "BR"), edge("e2", "BR", "B"), edge("e3", "B", "BR")],
  ),
  OPTS,
);
check("模型选的分支当闸门 → 环仍被拒", hasCode(modelCycle, "graph.cycle"), modelCycle.errors);

const bareBranch = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("BR", "mcode.branch", {})], [edge("e1", "A", "BR")]),
  OPTS,
);
check("分支没有出边 → branch.no-options", hasCode(bareBranch, "branch.no-options", "BR"), bareBranch.errors);

/* ── 3. 节点类型与参数 ── */

const unknownStrict = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]),
  OPTS,
);
check("未知类型默认报 error", hasCode(unknownStrict, "node.unknown-kind", "G") && !unknownStrict.ok, unknownStrict.errors);

const unknownLenient = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]),
  { types: TYPES, unknownTypeSeverity: "warning" },
);
check("存盘档位:未知类型降为 warning 且放行", !hasCode(unknownLenient, "node.unknown-kind") && unknownLenient.ok && unknownLenient.warnings.some((w) => w.code === "node.unknown-kind"), { errors: unknownLenient.errors, warnings: unknownLenient.warnings });

const missing = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", {})], [edge("e1", "A", "B")]),
  OPTS,
);
check("必填参数缺失 → param.missing", hasCode(missing, "param.missing", "B"), missing.errors);

const badShape = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", { instruction: "x", outputVars: "不是表" })], [edge("e1", "A", "B")]),
  OPTS,
);
check("参数形状不符 → param.invalid", hasCode(badShape, "param.invalid", "B"), badShape.errors);

/* ── 4. `{{...}}` 引用存在性 ── */

const refs = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("B", "mcode.agent", { instruction: "算年份", outputVars: [{ name: "年份", example: "2024" }] }),
      node("C", "mcode.agent", { instruction: "整理 {{}} 与 {{幽灵.东西}} 与 {{B.标题}}" }),
      node("D", "mcode.agent", { instruction: "看 {{B.年份}}" }),
    ],
    [edge("e1", "A", "B"), edge("e2", "B", "C"), edge("e3", "A", "D")],
  ),
  OPTS,
);
check("空引用 → ref.empty", hasCode(refs, "ref.empty", "C"), refs.errors);
check("引用不存在的节点 → ref.unknown-node", hasCode(refs, "ref.unknown-node", "C"), refs.errors);
check("上游未声明的变量 → ref.unknown-output", hasCode(refs, "ref.unknown-output", "C"), refs.errors);
check("引用旁支 → ref.not-upstream", hasCode(refs, "ref.not-upstream", "D"), refs.errors);

/* ── 4b. 「出路」是模型选的分支声明的产出(2026-09-19) ── */

// 模型选的分支**必须**交「出路」(值 = 它选的那条边的名字,见
// `@contracts/outputConstraint` 的 `DECIDE_VAR_NAME`),调度器拿它查产出、对边。
// 这份名单以前不算它 —— 于是下游写 `{{BR.出路}}` 接那条路时会**存不下去**,报
// "「BR」没有声明产出变量「出路」"。一边逼模型交,一边不让下游取。
const decideRef = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", { decider: "model" }),
      node("C", "mcode.agent", { instruction: "按 {{BR.出路}} 这条走" }),
    ],
    [edge("e1", "A", "BR"), edge("e2", "BR", "C")],
  ),
  OPTS,
);
check("模型选的分支:下游能取「出路」", !hasCode(decideRef, "ref.unknown-output", "C"), decideRef.errors);

/* ── 4c. `{{trigger.*}}` 是**另一个名字空间**,校验器原来不认识它(2026-09-20) ── */

// 界面「插入变量」菜单按 `triggerFactKeysOf` 列出候选(它读触发器节点上的
// `triggerKind`),运行时按同一张表解算(`expandTriggerVars`,取不到是硬失败)。
// 唯独**存盘校验**不认识这个名字空间:它把 `trigger.kind` 拆成节点名 `trigger` 去查表,
// 报「图上没有「trigger」这个节点」—— 于是**菜单让你插、运行时认,插完却存不下去**。
const trigOk = validateWorkflowDoc(
  doc(
    [
      node("M", "mcode.main", SAY),
      node("T", "mcode.trigger", { triggerKind: "schedule" }),
      node("C", "mcode.agent", { instruction: "上次跑是 {{trigger.at}},方式是 {{trigger.kind}}" }),
    ],
    [edge("e1", "T", "C")],
  ),
  OPTS,
);
check(
  "触发器载荷里有的 → 放行(菜单插得出来,这里就得过)",
  !hasCode(trigOk, "ref.unknown-node", "C") && trigOk.ok,
  trigOk.errors,
);

// 反面:拼错的键仍然要拦。它不是节点引用,所以话术得说「触发载荷里没有」,
// 而不是「图上没有这个节点」——后者会把用户支去改图,而图没问题。
const trigBad = validateWorkflowDoc(
  doc(
    [
      node("M", "mcode.main", SAY),
      node("T", "mcode.trigger", { triggerKind: "schedule" }),
      node("C", "mcode.agent", { instruction: "看 {{trigger.不存在的键}}" }),
    ],
    [edge("e1", "T", "C")],
  ),
  OPTS,
);
check("拼错的键 → ref.unknown-trigger-fact", hasCode(trigBad, "ref.unknown-trigger-fact", "C"), trigBad.errors);
check("拼错的键不再报成「图上没有 trigger 这个节点」", !hasCode(trigBad, "ref.unknown-node", "C"), trigBad.errors);

// 取候选的那一份实现在 `@contracts/nodeType` 的 `triggerFactKeysOf`(界面菜单用的就是它)。
// 校验器必须用**同一份** —— 自己再列一张表就会长歪:菜单列得出、存盘拦得下。
check(
  "校验器与菜单同源(候选里没有的键,两边都不认)",
  !trigBad.ok && trigOk.ok,
  { bad: trigBad.errors.map((e) => e.code), ok: trigOk.ok },
);

/* ── 4d. 触发器不接上游 —— 有条边连进去要说出来(2026-09-20) ── */

// 触发器是自动化**起点**:它不跑东西、也不等谁。`@contracts/nodeType` 与
// `nodeTypes.ts` 的说明都写着这一条,而**运行时就是这么做的** —— 被触发的那个由
// `entry` 直接预置成成功(见 `scheduler.ts` 里 `entry.nodeId` 那一段),**根本不看
// 它的入边**;其余触发器一律标 `unselected`。
//
// 于是给触发器连一条入边,界面看着像"上游跑完它才起",运行时那条边**等于不存在**。
// 这是"坏东西要显式报出来"的典型:图的样子和实际行为对不上,而看不出来。
//
// ⚠️ **只提醒不拦**(warning),理由同 `graph.orphan-node`:保存闸门不能比旧语义更严
// —— 存量图里可能真有这种边,拦下会让它存不回去,而它本来跑得好好的(边被忽略而已)。
const triggerInEdge = validateWorkflowDoc(
  doc(
    [
      node("M", "mcode.main", SAY),
      node("T", "mcode.trigger", { triggerKind: "schedule" }),
      node("C", "mcode.agent", SAY),
    ],
    [edge("e1", "M", "T"), edge("e2", "T", "C")],
  ),
  OPTS,
);
check(
  "有边连进触发器 → 提醒(这条边不会生效)",
  triggerInEdge.warnings.some((w) => w.code === "graph.trigger-has-in-edge" && w.nodeId === "T"),
  { errors: triggerInEdge.errors, warnings: triggerInEdge.warnings },
);
check("而且不拦(存量图照存)", triggerInEdge.ok, triggerInEdge.errors);

// 反面:边从触发器**出去**是正常的(它的下游就该这么接),不能连这个也一起报。
check(
  "触发器往下游的边照常(不误报)",
  !triggerInEdge.warnings.some((w) => w.nodeId === "C" && w.code === "graph.trigger-has-in-edge"),
  triggerInEdge.warnings,
);

/* ── 4e. 分支的选项不许重名(2026-09-20) ── */

// 模型选的那条路要在产出里交出「出路」(值 = 那条边的**名字**),调度器拿名字回来对上边
// (见 `applyDecision`)。两个选项同名 = "他选了「通过」"对应哪条边有两种答案,而它不会
// 报错,只会挑一条。用户选的那条虽然走边的 id,但画布上两个一样的按钮也没法点。
const dupOpt = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", { decider: "model" }),
      node("C1", "mcode.agent", SAY),
      node("C2", "mcode.agent", SAY),
    ],
    [
      edge("e1", "A", "BR"),
      { ...edge("e2", "BR", "C1"), label: "通过" },
      { ...edge("e3", "BR", "C2"), label: "通过" },
    ],
  ),
  OPTS,
);
check("两个选项同名 → branch.duplicate-option", hasCode(dupOpt, "branch.duplicate-option", "BR"), dupOpt.errors);

// 反面:名字不一样就放行。这条同时盯"别把整块改坏"。
const okOpt = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", { decider: "model" }),
      node("C1", "mcode.agent", SAY),
      node("C2", "mcode.agent", SAY),
    ],
    [
      edge("e1", "A", "BR"),
      { ...edge("e2", "BR", "C1"), label: "通过" },
      { ...edge("e3", "BR", "C2"), label: "驳回" },
    ],
  ),
  OPTS,
);
check("名字不同 → 放行", !hasCode(okOpt, "branch.duplicate-option", "BR"), okOpt.errors);

// **没填 `label` 的边也要能撞上。** 判据是 `edgeOptionNameOf` —— 它给没填 label 的边
// 兜底一个名字(目标标题 ‖ 类型 id)。两条边都指向**同名**节点、又都没填 label,
// 兜底出来的就是同一个词,一样对不上边。
//
// 这一条是**同源检查**:校验器要是自己写一遍"没 label 就取标题",两处迟早分家,
// 而分家的表现正是上面那句 —— 校验放行的图,模型交回的名字对不上。
const dupFallback = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", { decider: "model" }),
      node("C1", "mcode.agent", SAY, "同名"),
      node("C2", "mcode.agent", SAY, "同名"),
    ],
    [edge("e1", "A", "BR"), edge("e2", "BR", "C1"), edge("e3", "BR", "C2")],
  ),
  OPTS,
);
check(
  "没填 label、但兜底出来的名字撞了 → 同样报",
  hasCode(dupFallback, "branch.duplicate-option", "BR"),
  dupFallback.errors,
);

// **决定权在用户时不放行** —— 那一项由点选产生,不要求模型交,追进去等于让一个
// 取不到的写法通过校验。判据同 `outputVarsFor`(只对 `isModelDecider` 追加)。
const userDecideRef = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", { decider: "user" }),
      node("C", "mcode.agent", { instruction: "按 {{BR.出路}} 这条走" }),
    ],
    [edge("e1", "A", "BR"), edge("e2", "BR", "C")],
  ),
  OPTS,
);
check(
  "用户选的分支:「出路」不算声明过的产出",
  hasCode(userDecideRef, "ref.unknown-output", "C"),
  userDecideRef.errors,
);

// 分支那个 `decider` 参数**留空**时按 `deciderOf` 的兜底是"用户",所以也不放行 ——
// 这一条盯的是"判据只有一份"(别处抄一份容易抄成"有 decider 参数就算")。
const blankDecideRef = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("BR", "mcode.branch", {}),
      node("C", "mcode.agent", { instruction: "按 {{BR.出路}} 这条走" }),
    ],
    [edge("e1", "A", "BR"), edge("e2", "BR", "C")],
  ),
  OPTS,
);
check(
  "decider 留空(兜底=用户)时同样不放行",
  hasCode(blankDecideRef, "ref.unknown-output", "C"),
  blankDecideRef.errors,
);

// 清单里声明的 `outputs` 本来就该放行 —— 这一条是**回归网**:改动
// `declaredOutputsOf` 时别把原来那一半弄丢。`mcode.agent` 的清单声明了 `summary`。
const manifestRef = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("B", "mcode.agent", SAY),
      node("C", "mcode.agent", { instruction: "看 {{B.summary}}" }),
    ],
    [edge("e1", "A", "B"), edge("e2", "B", "C")],
  ),
  OPTS,
);
check("清单声明的产出仍然取得到", !hasCode(manifestRef, "ref.unknown-output", "C"), manifestRef.errors);
check(
  "清单没声明的名字照样被拒",
  hasCode(
    validateWorkflowDoc(
      doc(
        [
          node("A", "mcode.main", SAY),
          node("B", "mcode.agent", SAY),
          node("C", "mcode.agent", { instruction: "看 {{B.没这个}}" }),
        ],
        [edge("e1", "A", "B"), edge("e2", "B", "C")],
      ),
      OPTS,
    ),
    "ref.unknown-output",
    "C",
  ),
);

const dupTitle = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", { instruction: "拆" }),
      node("B1", "mcode.agent", { ...SAY, outputVars: [{ name: "年份", example: "2024" }] }, "同名"),
      node("B2", "mcode.agent", { ...SAY, outputVars: [{ name: "年份", example: "2024" }] }, "同名"),
      node("C", "mcode.agent", { instruction: "取 {{同名.年份}}" }),
    ],
    [edge("e1", "A", "B1"), edge("e2", "A", "B2"), edge("e3", "B1", "C"), edge("e4", "B2", "C")],
  ),
  OPTS,
);
check("标题重名 → ref.ambiguous-title", hasCode(dupTitle, "ref.ambiguous-title", "C"), dupTitle.errors);

// **标题带空白时,存盘校验和解算器得说同一句话**(2026-09-19)。
//
// 标题是**原样存**的(渲染端 `NodeInspector` → `updateNode`,不 trim),所以盘上会有
// `"  检索  "`。而解算器取引用名时自己 trim(`resolveOne`)、`findNode` 也比 trim 过的
// —— 校验这一头原来逐字比,于是这种节点会被判成「引用不到」:**能跑的写法存不下去**。
// 三道判据(id / 标题重名 / 标题命中)必须和 `findNode` 完全一致。
const paddedTitle = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", { instruction: "拆" }),
      node("B", "mcode.agent", { ...SAY, outputVars: [{ name: "年份", example: "2024" }] }, "  检索  "),
      node("C", "mcode.agent", { instruction: "取 {{检索.年份}}" }),
    ],
    [edge("e1", "A", "B"), edge("e2", "B", "C")],
  ),
  OPTS,
);
check(
  "标题带空白也认得出来(不会误报引用不到)",
  !hasCode(paddedTitle, "ref.unknown-node", "C"),
  paddedTitle.errors,
);
check("那份文档整体是干净的", paddedTitle.errors.length === 0, paddedTitle.errors);

/* ── 4f. 导入也要走到「触发器不接上游」那条提醒(2026-09-20) ── */

// **导入那条路原来把 warnings 整个丢了。** `validateWorkflowDoc` 明明算出了
// `graph.trigger-has-in-edge`,而 `importWorkflowDoc` 的成功分支只回 `{ok, doc}`
// —— 提醒一个字节都没传出去。于是同一张图:直接过校验器有提醒,从文件导进来
// **一声不响**,图上那条永远不会生效的边谁都看不见。
//
// 这不是"把它升级成错误":那条检查的取舍写在它的注释里(保存闸门不能比旧语义更严,
// 存量图里可能真有这种边)。要做的是**让导入也走到同一个检查**,并把它的提醒带回去。
const importInEdge = importWorkflowDoc(
  exportWorkflowDoc(
    doc(
      [
        node("M", "mcode.main", SAY),
        node("T", "mcode.trigger", { triggerKind: "schedule" }),
        node("C", "mcode.agent", SAY),
      ],
      [edge("e1", "M", "T"), edge("e2", "T", "C")],
    ),
  ),
  OPTS,
);
check(
  "导入成功时带回 warnings(不再是 {ok, doc} 两键)",
  importInEdge.ok && "warnings" in importInEdge,
  importInEdge,
);
check(
  "导入那条路也算得出来「触发器有入边」",
  importInEdge.ok && hasWarning(importInEdge, "graph.trigger-has-in-edge", "T"),
  importInEdge.ok ? importInEdge.warnings : importInEdge.report,
);
// **只提醒不拦**:这一条和上面那条是一对 —— 只断言"报出来了"的话,把它升级成
// error 也照样过。存量图(_validateDag 从不查入边)必须还存得下、还进得来。
check("而且导入照旧放行(没有升级成错误)", importInEdge.ok, importInEdge.ok ? undefined : importInEdge.report.errors);

// 反面:触发器只往外出边是**正常**的,不能连这个也一起报。少了这条,"一律有触发器就提醒"
// 那种写坏也会绿。
const importNoInEdge = importWorkflowDoc(
  exportWorkflowDoc(
    doc(
      [
        node("M", "mcode.main", SAY),
        node("T", "mcode.trigger", { triggerKind: "schedule" }),
        node("C", "mcode.agent", SAY),
      ],
      [edge("e1", "T", "C")],
    ),
  ),
  OPTS,
);
check(
  "触发器没有入边 → 导入不带这条提醒(不误报)",
  importNoInEdge.ok && !hasWarning(importNoInEdge, "graph.trigger-has-in-edge"),
  importNoInEdge.ok ? importNoInEdge.warnings : importNoInEdge.report,
);

// **同一份判断,导入与校验器必须说同一句话。** 这一条盯的是"别在导入那条路里另写一遍
// 判据" —— 两处各写一份,迟早一边报一边不报,而用户看到的是同一张图两种说法。
const sideBySide = validateWorkflowDoc(
  doc(
    [
      node("M", "mcode.main", SAY),
      node("T", "mcode.trigger", { triggerKind: "schedule" }),
      node("C", "mcode.agent", SAY),
    ],
    [edge("e1", "M", "T"), edge("e2", "T", "C")],
  ),
  OPTS,
);
check(
  "导入与直接校验:同一张图、同一份警告",
  importInEdge.ok &&
    JSON.stringify((importInEdge.warnings ?? []).map((w) => [w.code, w.nodeId])) ===
      JSON.stringify(sideBySide.warnings.map((w) => [w.code, w.nodeId])),
  { imported: importInEdge.ok ? importInEdge.warnings : null, direct: sideBySide.warnings },
);

/* ── 4g. 命令节点的「能力」那一项:文案不能承诺一件实现里没有的事(2026-09-20) ──
 *
 * 起因:`mcode.command` 的 `usage` 里原本写着"这一步声明了 `exec` 能力,**受工作流权限
 * 那一套约束**"。这句话跟实现**对不上**:
 *
 *  - 能力→权限模式只有 `prompt`(子 agent)那条路在用(`permissionModeForCapability`
 *    只被 `createNodeSession` 调用);命令节点根本不建会话,它 `spawn` 一个进程,
 *    进程没有"权限模式"这回事;
 *  - `@contracts/nodeType` 的 `showsNodeCapability` 把 `command` / `code` 明确归到
 *    **"不管"**那一档,界面据此**不给它摆那个控件**(摆一个不生效的框 = 承诺一件做
 *    不到的事)。
 *
 * 于是同一件事有了两个说法:清单对模型说"受约束",界面 AND 契约说"管不着"。修的是
 * 清单那一句(实现不动 —— 见报告里"为什么没有实现审批")。
 *
 * 这一段断言的是**两句话必须同一个方向**,而不是"某个词在不在":只钉"没有『受工作流
 * 权限』"的话,以后把它换成"受权限约束"照样绿。所以先取契约的结论,再要求文案顺从它。
 */
const cmdForClaim = builtinCommandManifest();
const capabilityCounts = showsNodeCapability(cmdForClaim);
check(
  "4g-1 契约:命令节点的「能力」那一项不管事(它就是 '不管' 那一档)",
  capabilityCounts === false,
  { showsNodeCapability: capabilityCounts, runner: cmdForClaim.runner.kind },
);
check(
  "4g-2 文案与契约同向:不再说它受工作流权限约束",
  !(cmdForClaim.usage ?? "").includes("受工作流权限"),
  cmdForClaim.usage,
);
// 反过来,那句话**该说清的**是"没有审批" —— 它是这张图最招恨的翻车方式(不认识的图里
// 一个命令节点会原样跑起来,没人先问一句)。删掉整段而不是改对,会让这一条红。
check(
  "4g-3 但「没有审批」这句警示还在(不能靠删掉了事)",
  (cmdForClaim.usage ?? "").includes("没有审批"),
  cmdForClaim.usage,
);
// 命令节点**没有任何审批闸门**这件事,在节点类型契约那边也是写死的口径 —— 这条把
// 两处口径绑在一起,免得以后有人只改一边。
check(
  "4g-4 参数表里确实有「产出变量」那一格(下游能不能取值取决于用户填不填它)",
  cmdForClaim.params.some((p) => p.key === "outputVars"),
  cmdForClaim.params.map((p) => p.key),
);

/* ── 4h. 命令节点:那张产出变量表,在哪一步才变成下游能取到的值(2026-09-20) ──
 *
 * 起因是一条提醒:命令 / 终端节点会**静默跳过**产出变量表,下游 `{{某步.某变量}}`
 * 永远取不到值,界面上也没有任何提示。分开验之后,**两半的结论是相反的**:
 *
 *  - 「终末节点跳过」**是设计,不是 bug**。`withOutputCheck` 只对**没有下游**的节点
 *    跳过(表既不进提示词也不查):没有下游就没人取,硬查只会让最后一步平白失败。
 *    `mcode.agent` 这类节点的终末一步也一样跳过 —— 它是**所有**节点的规矩,不是命令
 *    节点被特殊对待。**这一半是伪问题。**
 *
 *  - 非终末命令节点上,那张表**曾经**只能被一种东西满足:命令自己**打印出一个 JSON
 *    对象**。因为校验和取值读的一直是 `outcome.summary`;而 `commandRunner` 的
 *    `summary` = stdout 尾部(协议里的 `summary` 有就优先)。缺口比"要打印 JSON"更深:
 *    清单把 `@@mcode:result` 写成脚本上报结构化产出的正式办法、协议里明明白白有个
 *    `outputs` 字段,可**只用协议、不写 summary**,值落在 `outcome.outputs` 上,校验却
 *    读不到 —— 这一步反而**失败**。等于说:照文档做的脚本会翻车,把同一个值再
 *    `JSON.stringify` 一遍塞进 `summary` 才行。
 *
 * **这个已经修了**(`scheduler.ts` 的 `checkOutputFrom`):原文解不出时退回
 * `outcome.outputs`,只看**表里点名的**那几样在不在,齐了就算交差。于是:
 *
 *  - 4h-1、4h-2 不受影响 —— 走的是原文本那条老路,回归网证明没被这条退路削弱。
 *  - 4h-3b **反过来了**:只用协议的脚本现在成功,下游也取到了值。这正是当初写下
 *    "真去修的时候 4h-3 会反过来"时说的那个证据,不是把断言改成了需求。
 *  - 4h-4 从"对照组"降级成"也通的一条路",留着是为了钉第四条:**运行时已经填好的值
 *    不许被原文里的同名键盖掉** —— 它和 4h-3b 两个方向合起来才是完整的口径。
 */

/** 假 spawn:`deps.spawn` 要的是**一个和 `node:child_process.spawn` 同形状的函数**,
 *  不是它起出来的那个子进程(也不是自己现编的一个普通对象)。返回处按 `SpawnFn`
 *  断言一次 —— 形状漂了在 tsc 就报,不用等跑起来才发现。
 *  产出按 Buffer 给 —— 真解码器认的是字节,不是字符串(见 `spawnRun`)。 */
function fakeSpawn(lines: string[]): SpawnFn {
  return (() => {
    const child = new EventEmitter() as never as Record<string, unknown>;
    (child as { stdout: unknown }).stdout = Readable.from([Buffer.from(lines.join("\n") + "\n", "utf8")]);
    (child as { stderr: unknown }).stderr = Readable.from([Buffer.alloc(0)]);
    (child as { killed: boolean }).killed = false;
    (child as { kill: () => void }).kill = () => undefined;
    (child as { pid: number }).pid = 4242;
    setTimeout(() => {
      (child as unknown as EventEmitter).emit("exit", 0, null);
      (child as unknown as EventEmitter).emit("close", 0, null);
    }, 5);
    return child;
  }) as unknown as SpawnFn;
}

const cmdManifest = builtinCommandManifest();
const cmdVars = outputVarsOf(cmdManifest, { outputVars: [{ name: "年份", example: "2024" }] });

const CMD_TYPES = new Map<string, NodeTypeManifest>([
  [cmdManifest.id, cmdManifest],
  ["mcode.agent", agentManifest("mcode.agent")],
]);

/**
 * 把「命令节点 A → 子 agent B」这张图**真跑一遍**(真调度器 + 假 spawn),把 A 的结局
 * 和 B 收到的提示词一起带回来。这是唯一能同时看到"校验判了什么"和"下游取到了什么"的
 * 玩法 —— 单跑 `runCommandNode` 看不到校验,单看 outcome 看不到下游。
 */
async function runCmdChain(
  lines: string[],
  vars: { name: string; example?: string }[] = [{ name: "年份", example: "2024" }],
): Promise<{ outcome?: NodeOutcome; bPrompt: string }> {
  const workflow = doc(
    [
      node("A", cmdManifest.id, { command: "冒烟用的假命令", outputVars: vars }),
      node("B", "mcode.agent", { instruction: "用 A 交出来的年份" }),
    ],
    [edge("e1", "A", "B")],
  );
  const reports: RunReport[] = [];
  let bPrompt = "<B 没跑>";
  const ports: RunPorts = {
    async manifestOf(type) {
      return CMD_TYPES.get(type);
    },
    async execute(n, _m, input) {
      if (n.id === "B") {
        bPrompt = input.prompt;
        return { status: "success", summary: "好" };
      }
      return runCommandNode(
        { command: "冒烟用的假命令", timeoutMs: 0, signal: input.signal },
        { spawn: fakeSpawn(lines) },
      );
    },
    contextLines: () => [],
    // 这两张图里没有分支节点,`choose` 调不到。真被调到说明夹具搭错了 —— 抛出来比
    // 悄悄返回一个"选了第一条"更早暴露问题(CLAUDE.md:坏东西显式报出来)。
    choose: () => {
      throw new Error("冒烟夹具:这两张图里不该有分支节点");
    },
    report: (e) => void reports.push(e),
  };
  await runWorkflow({ doc: workflow, prompt: "开始", ports, signal: new AbortController().signal });
  const settled = reports.find(
    (r): r is Extract<RunReport, { kind: "node.settled" }> => r.kind === "node.settled" && r.node.id === "A",
  );
  return { ...(settled !== undefined ? { outcome: settled.outcome } : {}), bPrompt };
}

// 4h-1 · 表是**真被读的**:命令只打印一行普通文本 → 这一步失败、下游被跳过。
// 失败本身是对的(表是一句承诺);这条只钉"不是静默跳过"。**它同时是那条退路的反例**:
// 退回 `outcome.outputs` 之后,这里仍然必须红 —— 否则不叫"退回",叫"不查了"。
const plain = await runCmdChain(["版本 1.2.3,已就绪"]);
check(
  "4h-1 命令打印普通文本 → 这一步失败、下游不跑(表被读了,不是静默跳过)",
  plain.outcome?.status === "failed" && plain.bPrompt === "<B 没跑>",
  plain,
);

// 4h-2 · 原文本那条路:命令自己打印一个 JSON 对象,照样能交差。
const jsonLine = JSON.stringify({ 年份: "2024" });
const asJson = await runCmdChain([jsonLine]);
check(
  "4h-2 命令打印一个 JSON 对象 → 这一步成功,下游能取到那个值",
  asJson.outcome?.status === "success" && asJson.bPrompt.includes("2024"),
  asJson,
);

// 4h-3 · **这就是当初查出来的那个真问题。** 清单把 `@@mcode:result` 写成正式上报办法,
// 协议里 `outputs` 字段就是放结构化产出的(`commandRunner.consumeProtocolLine`),值确实
// 进了 `outcome.outputs`(4h-3a)。修之前校验只读 `summary`,于是这一步**失败**(4h-3b)。
//
// 两条要分开断,因为 4h-3a 检的是**执行器原样返回的那份 outcome**,而校验失败时
// `withOutputCheck` 造的是一个只有 `summary` / `error` 的新 outcome(会把 `outputs`
// 丢掉)—— 那也正是这段链上唯一能证明"缺的不是解析、是取值口径"的证据。
const protoLine = `@@mcode:result ${JSON.stringify({ outputs: { 年份: "2024" } })}`;
const protoRaw = await runCommandNode(
  { command: "冒烟用的假命令", timeoutMs: 0, signal: new AbortController().signal },
  { spawn: fakeSpawn([protoLine]) },
);
check(
  "4h-3a 执行器把协议里的 outputs 原样解了出来(值确实到了 outcome.outputs)",
  protoRaw.status === "success" && (protoRaw.outputs as Record<string, unknown> | undefined)?.["年份"] === "2024",
  protoRaw,
);
const protoOnly = await runCmdChain([protoLine]);
check(
  "4h-3b 只用协议、不写 summary 的脚本也能交差 —— 下游真的取到了值",
  protoOnly.outcome?.status === "success" && protoOnly.bPrompt.includes("2024"),
  protoOnly,
);

// 4h-4 · 另一条也通的路:协议 + 顺手把同一个值也写进 `summary`。
//
// 它现在钉的是**第四条规矩**:`outcome.outputs` 里已经填好的值不许被原文里的同名键
// 盖掉。这里两边恰好同值,看不出差别;真正会出事的形状是"协议给的是算出来的结果,
// 原文里那一段只是它的另一种写法" —— 那时候拿原文去盖,用户拿到的就不是命令交的那个
// 值了。所以 `checkOutputFrom` 命中运行时产出时返回 `value: undefined`,调用方原样返回
// outcome、一个字节都不重写。4h-3b 与它合起来才是完整口径:两个方向都通,且都不改写。
const protoWithSummary = await runCmdChain([
  `@@mcode:result ${JSON.stringify({ outputs: { 年份: "2024" }, summary: JSON.stringify({ 年份: "2024" }) })}`,
]);
check(
  "4h-4 协议之外又写了 summary 也成功(并且两边同值时以运行时那份为准)",
  protoWithSummary.outcome?.status === "success" &&
    (protoWithSummary.outcome.outputs as Record<string, unknown> | undefined)?.["年份"] === "2024" &&
    protoWithSummary.bPrompt.includes("2024"),
  protoWithSummary,
);

// 4h-4b · **退路的边界**:退回去看的只是表里**点名的**那几样。命令交了个别的东西、
// 唯独没有点名的那一样 → 仍然要失败。少了这条,"只要 outputs 非空就放行"那种写坏
// 也会绿,而它会把这张表彻底废掉。
const protoWrongKey = await runCmdChain([`@@mcode:result ${JSON.stringify({ outputs: { 月份: "3" } })}`]);
check(
  "4h-4b 协议里交的是别的东西、没有点名的那一样 → 仍然失败(退路只认表里点名的键)",
  protoWrongKey.outcome?.status === "failed" && protoWrongKey.bPrompt === "<B 没跑>",
  protoWrongKey,
);

// 4h-4c · **表里点名的必须全都到位。** 上面几条表里只有一样,`every` 和 `some` 在这种
// 表上分不出来 —— 少了这条,退回逻辑写成"点名的**任意一样**在 outputs 里就放行"也会
// 绿,而那张表就成了一句空话(用户要两样,拿到一样也算交差)。
const protoHalf = await runCmdChain(
  [`@@mcode:result ${JSON.stringify({ outputs: { 年份: "2024" } })}`],
  [{ name: "年份", example: "2024" }, { name: "月份", example: "3" }],
);
check(
  "4h-4c 表里点名两样、只交了一样 → 仍然失败(是 every,不是 some/非空)",
  protoHalf.outcome?.status === "failed" && protoHalf.bPrompt === "<B 没跑>",
  protoHalf,
);

// 4h-5 · 清单声明的 `exitCode` / `stdout` 走的是**另一条路**:运行时真的进了
// `outcome.outputs`,校验也放行 `{{某步.exitCode}}`,「插入变量」菜单也列它们
// (`manifestOutputVars`)。这条钉住"这一半是通的",免得报告把两件事混成一件。
check(
  "4h-5 清单声明的 exitCode/stdout 真的在 outcome.outputs 里",
  typeof (asJson.outcome?.outputs as Record<string, unknown> | undefined)?.exitCode === "number" &&
    (asJson.outcome?.outputs as Record<string, unknown>)?.["stdout"] === jsonLine,
  asJson.outcome?.outputs,
);
check(
  "4h-5b 这两样对下游是可引用的(菜单 = 用户定的 + 清单声明的)",
  JSON.stringify(referenceableOutputsOf(cmdManifest, {}, []).map((v) => v.name)) ===
    JSON.stringify(["exitCode", "stdout"]) && usesOutputRules(cmdManifest),
  referenceableOutputsOf(cmdManifest, {}, []),
);

// 4h-6 · **终末节点是另一条规矩**(这半是伪问题的那一边):同一张表,挂在**没有下游**的
// 命令节点上时,不查也不拦 —— 这一步照样成功。少了这条,4h-1 那种"一律失败"的写坏
// 也会绿,而它恰恰会把"最后一步"毁掉(用户看到的会是"少了一样",而它压根没被要求过)。
const terminal = doc(
  [node("A", cmdManifest.id, { command: "冒烟用的假命令", outputVars: [{ name: "年份", example: "2024" }] })],
  [],
);
const terminalReports: RunReport[] = [];
await runWorkflow({
  doc: terminal,
  prompt: "开始",
  signal: new AbortController().signal,
  ports: {
    async manifestOf(type) {
      return CMD_TYPES.get(type);
    },
    async execute(_n, _m, input) {
      return runCommandNode(
        { command: "冒烟用的假命令", timeoutMs: 0, signal: input.signal },
        { spawn: fakeSpawn(["版本 1.2.3,已就绪"]) },
      );
    },
    contextLines: () => [],
    choose: () => {
      throw new Error("冒烟夹具:终末那张图里没有分支节点");
    },
    report: (e) => void terminalReports.push(e),
  },
});
const terminalOutcome = terminalReports.find(
  (r): r is Extract<RunReport, { kind: "node.settled" }> => r.kind === "node.settled" && r.node.id === "A",
)?.outcome;
check(
  "4h-6 终末命令节点:同一张表,不查也不拦,这一步照样成功",
  terminalOutcome?.status === "success",
  terminalOutcome,
);

/* ── 5. 导入 / 导出(WF-08) ── */

const badJson = importWorkflowDoc("{oops", OPTS);
check("非法 JSON 被拒", !badJson.ok && badJson.report.errors[0]?.code === "schema.invalid-json", badJson.ok ? badJson : badJson.report.errors);

const badShapeDoc = importWorkflowDoc(JSON.stringify({ id: "x" }), OPTS);
check("形状不符契约被拒", !badShapeDoc.ok && badShapeDoc.report.errors[0]?.code === "schema.invalid", badShapeDoc.ok ? badShapeDoc : badShapeDoc.report.errors);

const futureVersion = importWorkflowDoc(JSON.stringify({ ...validDoc, schemaVersion: "9" }), OPTS);
check("不支持的 schemaVersion 被拒", !futureVersion.ok && futureVersion.report.errors[0]?.code === "schema.version-unsupported", futureVersion.ok ? futureVersion : futureVersion.report.errors);

const failingDoc = importWorkflowDoc(JSON.stringify(doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", {})], [edge("e1", "A", "B")])), OPTS);
check("校验失败的文档被拒并带回 report", !failingDoc.ok && hasCode(failingDoc.ok ? { errors: [] } : failingDoc.report, "param.missing"), failingDoc.ok ? "ok?!" : failingDoc.report.errors);

const unknownDoc = JSON.stringify({ ...doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]) });
// 默认档 = 注入类型清单、unknownTypeSeverity 走默认 error;宽松档显式降级。
const importStrict = importWorkflowDoc(unknownDoc, OPTS);
const importLenient = importWorkflowDoc(unknownDoc, { types: TYPES, unknownTypeSeverity: "warning" });
check("导入默认档:未知类型 = error", !importStrict.ok && importStrict.report.errors.some((e) => e.code === "node.unknown-kind"), importStrict.ok ? importStrict : importStrict.report.errors);
check("导入宽松档:未知类型 = warning 放行", importLenient.ok && importLenient.doc.schemaVersion === WORKFLOW_SCHEMA_VERSION, importLenient.ok ? importLenient.doc : importLenient.report);

const roundtrip = importWorkflowDoc(exportWorkflowDoc(validDoc), OPTS);
check("export→import 往返无损", roundtrip.ok, roundtrip.ok ? roundtrip.doc : roundtrip.report.errors);
check(
  "往返内容逐字段一致",
  roundtrip.ok && JSON.stringify(JSON.parse(exportWorkflowDoc(validDoc))) === JSON.stringify({ ...validDoc, schemaVersion: WORKFLOW_SCHEMA_VERSION }),
  roundtrip.ok ? undefined : roundtrip.report,
);
check("导入成功时补上 schemaVersion", roundtrip.ok && roundtrip.doc.schemaVersion === WORKFLOW_SCHEMA_VERSION, roundtrip.ok ? roundtrip.doc.schemaVersion : roundtrip.report);

console.log(`\nPASS: ${total - failures}/${total} checks`);
if (failures > 0) process.exitCode = 1;
