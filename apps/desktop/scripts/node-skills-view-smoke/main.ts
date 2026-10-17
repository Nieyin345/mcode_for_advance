/**
 * 「节点技能总览」那个 tab 的**读取视图模型**回归网。
 *
 * ## 为什么要单独钉这个
 *
 * `SkillNodesView` 做的事是"从技能出发反查谁在用它"，它读的东西**只有一处的形状**
 * 是它自己的假设：`params.skills` 是一个**字符串数组**（`kind: "ref"` + `multiple`
 * 的参数，见 `ParamField.tsx` 的 `MultiRefValue` / `stringListOf`）。
 *
 * 这个假设错了的表现是**静默的**：tab 上永远显示"还没有任何节点用到技能"，而用户
 * 明明在图上挂过。没有任何报错、没有任何线索 —— 这类 bug 只能靠断言钉住。
 *
 * ## 2026-10-17 起：钉的是**生产代码本身**
 *
 * 这一套从前复刻了组件里的收集算法（`.tsx` 带 React，无头跑不了）。现在算法搬进了
 * 纯模块 `renderer/components/settings/nodesUsageView.ts`，这里直接 import 它 ——
 * 断言测的就是界面真用的那份代码，不再是"两边改动必须同步"的副本。
 *
 * 新增的 §3 钉 **MC-050 同类**的完整度判据：一份工作流 `workflow.get` 失败时，
 * 结果必须是**不完整**（逐条记下读不回来的 id），而不是像从前那样悄悄跳过、
 * 让它的技能掉进"没被任何节点用到"那一栏。
 *
 * Run: scripts/node-skills-view-smoke/run.sh
 */
import type { WorkflowDoc } from "@contracts/workflow";
import { NODE_SKILLS_PARAM_KEY } from "@contracts/nodeType";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildNodesUsage,
  collectProfileUses,
  collectWorkflowUses,
  splitUsedAndUnused,
  usageIsComplete,
  type ReferenceUse,
} from "../../src/renderer/components/settings/nodesUsageView.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 造一份最小的工作流文档。 */
function docWith(nodes: Array<{ id: string; title?: string; params: Record<string, unknown> }>): WorkflowDoc {
  return {
    id: "wf_1",
    name: "文献评审",
    kind: "graph",
    builtin: false,
    prompt: "",
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "mcode.agent",
      ...(n.title !== undefined ? { title: n.title } : {}),
      params: n.params,
      position: { x: 0, y: 0 },
    })),
    edges: [],
    updatedAt: 0,
  } as unknown as WorkflowDoc;
}

console.log("\n参数键名");

{
  // ★ 这是唯一会漂的东西：界面读的键必须和节点清单声明的键是同一个。
  //   清单里那格写的是 `NODE_SKILLS_PARAM_KEY`（见 nodeTypes.ts 的 capabilityParams），
  //   而 nodesUsageView 读的也是它 —— 两边都 import 同一个常量，所以这条断言
  //   钉的是"那个常量还是 skills"。
  eq("NODE_SKILLS_PARAM_KEY 就是 skills", NODE_SKILLS_PARAM_KEY, "skills");
}

{
  // *反*漂移：组件必须真的 import 这份视图模型，不能自己再长一份收集循环
  // （那正是本次提取要消灭的"两份实现"形态）。读源码是静态检查里最便宜的一种，
  // 但它抓的正是"有人复制粘贴回去"。
  // 打包后 `import.meta.dirname` 是临时目录 —— 用 run.sh `cd` 到的那一层(apps/desktop)。
  const view = readFileSync(join(process.cwd(), "src/renderer/components/settings/SkillNodesView.tsx"), "utf-8");
  check("组件 import 了共享视图模型", view.includes("./nodesUsageView.js"));
  check("组件不再自己写收集循环", !view.includes("function collectWorkflowUses"));
  check("组件不再静默跳过读失败的工作流", !view.includes("刚被删）不该让整页失败"));
}

console.log("\n读取形状");

{
  // 正常：一个节点挂了两个技能。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(
    docWith([
      { id: "n1", title: "评审", params: { skills: ["reviewer", "reader"] } },
      { id: "n2", title: "写作", params: {} },
    ]),
    into,
  );
  eq("★ 两个技能都收到了", [...into.keys()].sort().join(","), "reader,reviewer");
  eq("★ 引用来自哪一格记对了", into.get("reviewer")?.[0]?.label, "文献评审");
  eq("★ 引用记了节点标题", into.get("reviewer")?.[0]?.nodeTitle, "评审");
  check("没挂技能的节点不产生引用", !into.has("写作"), [...into.keys()]);
}

{
  // 空数组 = "不限制"（见 runner.ts 那句注释），**不是**"一个都不许" ——
  // 所以它不该产生任何引用，也不该报错。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(docWith([{ id: "n1", title: "A", params: { skills: [] } }]), into);
  eq("空数组 → 没有引用", into.size, 0);
}

{
  // 坏形状不该崩 —— 手改过的存档、别处写进去的值都可能不是数组。
  const into = new Map<string, ReferenceUse[]>();
  for (const bad of [null, undefined, "reviewer", 42, { a: 1 }]) {
    collectWorkflowUses(docWith([{ id: "n1", title: "A", params: { skills: bad } }]), into);
  }
  eq("★ 非数组的值全部忽略,不崩", into.size, 0);
}

{
  // 数组里混进非字符串 / 空串 —— 手改过的存档真会这样。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(
    docWith([{ id: "n1", title: "A", params: { skills: ["ok", "", 42, null, "also-ok"] } }]),
    into,
  );
  eq("★ 只收非空字符串", [...into.keys()].sort().join(","), "also-ok,ok");
}

{
  // 同一格挂同名两次（手改过）→ 记两次引用。**不去重**是刻意的：这里报的是
  // "有几处引用"，去重会让数字骗人。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(
    docWith([{ id: "n1", title: "A", params: { skills: ["dup", "dup"] } }]),
    into,
  );
  eq("同名两次 → 两处引用(不去重)", into.get("dup")?.length, 2);
}

{
  // 跨多份工作流汇总 —— 调用方把同一个 map 传进去累积。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(docWith([{ id: "n1", title: "评审", params: { skills: ["shared"] } }]), into);
  const doc2 = docWith([{ id: "n9", title: "复核", params: { skills: ["shared"] } }]);
  (doc2 as unknown as { name: string }).name = "另一张图";
  collectWorkflowUses(doc2, into);
  eq("★ 跨图汇总到同一条", into.get("shared")?.length, 2);
}

{
  // 节点没有 title（旧存档可能没有）→ 不产生 nodeTitle 字段，不能变成 undefined。
  const into = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(docWith([{ id: "n7", params: { skills: ["s"] } }]), into);
  eq("没有 title → 不写 nodeTitle", into.get("s")?.[0]?.nodeTitle, undefined);
  eq("没有 title → refId 仍是工作流 id", into.get("s")?.[0]?.refId, "wf_1");
}

{
  // 档案那条与工作流那条共用同一张反查表 —— 档案没有节点概念，refId 是档案 id。
  const into = new Map<string, ReferenceUse[]>();
  collectProfileUses(
    { id: "p_1", name: "档案甲", params: { skills: ["reviewer"] } } as never,
    into,
  );
  eq("★ 档案的引用进同一张表", into.get("reviewer")?.[0]?.label, "档案甲");
  eq("★ 档案引用 kind=profile", into.get("reviewer")?.[0]?.kind, "profile");
  eq("档案引用 refId 是档案 id", into.get("reviewer")?.[0]?.refId, "p_1");
}

console.log("\n完整度（MC-050 同类）");

{
  // ★ 台账红例：一份工作流 `workflow.get` 失败。从前的 `catch { 跳过 }` 让它引用的
  //   技能悄悄掉进"未使用"；现在必须落进 `unreadWorkflows`，并让结果标为不完整。
  const result = buildNodesUsage({
    profiles: [{ id: "p_1", name: "档案甲", params: {} } as never],
    workflows: [
      { id: "wf_ok", name: "好的" },
      { id: "wf_bad", name: "坏的" },
    ],
    workflowGets: [
      { workflow: docWith([{ id: "n1", title: "A", params: { skills: ["alive"] } }]) },
      { workflow: null, error: "存档损坏" },
    ],
    paramKey: NODE_SKILLS_PARAM_KEY,
  });
  eq("★ 读得回来的工作流照常入表", result.usage.get("alive")?.length, 1);
  eq("★ 读不回来的工作流被逐条记下", result.unreadWorkflows.length, 1);
  eq("★ 记下的是它的 id", result.unreadWorkflows[0]?.id, "wf_bad");
  eq("★ 记下的是原始原因", result.unreadWorkflows[0]?.error, "存档损坏");
  eq("★ 有人读不回来 → 结果不完整", usageIsComplete(result), false);
}

{
  // 全读回来 → 完整。这是正控：防"一律标不完整"这种过度保守让提示常驻。
  const result = buildNodesUsage({
    profiles: [],
    workflows: [{ id: "wf_ok", name: "好的" }],
    workflowGets: [{ workflow: docWith([{ id: "n1", title: "A", params: { skills: ["x"] } }]) }],
    paramKey: NODE_SKILLS_PARAM_KEY,
  });
  eq("全部读回来 → 完整", usageIsComplete(result), true);
  eq("没有未读条目", result.unreadWorkflows.length, 0);
}

{
  // `get` 成功但返回 workflow:null（不存在）—— 与"读失败"同一档：不知道它引用了什么。
  const result = buildNodesUsage({
    profiles: [],
    workflows: [{ id: "wf_gone", name: "没了" }],
    workflowGets: [{ workflow: null }],
    paramKey: NODE_SKILLS_PARAM_KEY,
  });
  eq("workflow:null 也计入未读", result.unreadWorkflows.length, 1);
  eq("缺原因时有兜底文案", result.unreadWorkflows[0]?.error, "没有返回工作流");
  eq("workflow:null → 不完整", usageIsComplete(result), false);
}

{
  // 分组:有引用的按引用数降序,没引用的原样留在 unused —— 两个用途不同,不能混。
  const usage = new Map<string, ReferenceUse[]>();
  collectWorkflowUses(docWith([{ id: "n1", title: "A", params: { skills: ["hot"] } }]), usage, NODE_SKILLS_PARAM_KEY);
  collectWorkflowUses(docWith([{ id: "n2", title: "B", params: { skills: ["hot"] } }]), usage, NODE_SKILLS_PARAM_KEY);
  collectWorkflowUses(docWith([{ id: "n3", title: "C", params: { skills: ["cold"] } }]), usage, NODE_SKILLS_PARAM_KEY);
  const { used, unused } = splitUsedAndUnused([{ name: "cold" }, { name: "hot" }, { name: "never" }], usage);
  eq("★ 有引用的排前面且按次数降序", used.map((r) => r.name).join(","), "hot,cold");
  eq("没引用的留在 unused", unused.map((s) => s.name).join(","), "never");
}

console.log(`\nnode-skills-view-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
