/**
 * 「节点技能总览」那个 tab 的**数据来源**回归网。
 *
 * ## 为什么要单独钉这个
 *
 * `SkillNodesView` 做的事是"从技能出发反查谁在用它"，而它读的东西**只有一处的形状**
 * 是它自己的假设：`params.skills` 是一个**字符串数组**（`kind: "ref"` + `multiple`
 * 的参数，见 `ParamField.tsx` 的 `MultiRefValue` / `stringListOf`）。
 *
 * 这个假设错了的表现是**静默的**：tab 上永远显示"还没有任何节点用到技能"，而用户
 * 明明在图上挂过。没有任何报错、没有任何线索 —— 这类 bug 只能靠断言钉住。
 *
 * ## 别的地方已经钉住的
 *
 * `workflow-validation-smoke` 那边钉的是校验与解算；这一套只钉"**读取**这一侧的形状"，
 * 两边不重叠。
 *
 * Run: scripts/node-skills-view-smoke/run.sh
 */
import type { WorkflowDoc } from "@contracts/workflow";
import { NODE_SKILLS_PARAM_KEY } from "@contracts/nodeType";

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

// 从 SkillNodesView.tsx 复刻出来的两个收集函数（那个文件是 .tsx，带 React，
// 无头跑不了；这里钉的是**同一个算法**，所以两边改动必须同步 —— 下面有一条断言
// 专门盯着"键名"这个唯一会漂的地方）。
function collectWorkflowUses(doc: WorkflowDoc, into: Map<string, string[]>): void {
  for (const node of doc.nodes) {
    const raw = node.params?.[NODE_SKILLS_PARAM_KEY];
    if (!Array.isArray(raw)) continue;
    for (const name of raw) {
      if (typeof name !== "string" || name.length === 0) continue;
      const list = into.get(name) ?? [];
      list.push(`${doc.name}·${node.title ?? node.id}`);
      into.set(name, list);
    }
  }
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
  //   而 SkillNodesView 读的也是它 —— 两边都 import 同一个常量，所以这条断言
  //   钉的是"那个常量还是 skills"。
  eq("NODE_SKILLS_PARAM_KEY 就是 skills", NODE_SKILLS_PARAM_KEY, "skills");
}

console.log("\n读取形状");

{
  // 正常：一个节点挂了两个技能。
  const into = new Map<string, string[]>();
  collectWorkflowUses(
    docWith([
      { id: "n1", title: "评审", params: { skills: ["reviewer", "reader"] } },
      { id: "n2", title: "写作", params: {} },
    ]),
    into,
  );
  eq("★ 两个技能都收到了", [...into.keys()].sort().join(","), "reader,reviewer");
  eq("★ 引用来自哪一格记对了", into.get("reviewer")?.[0], "文献评审·评审");
  check("没挂技能的节点不产生引用", !into.has("写作"), [...into.keys()]);
}

{
  // 空数组 = "不限制"（见 runner.ts 那句注释），**不是**"一个都不许" ——
  // 所以它不该产生任何引用，也不该报错。
  const into = new Map<string, string[]>();
  collectWorkflowUses(docWith([{ id: "n1", title: "A", params: { skills: [] } }]), into);
  eq("空数组 → 没有引用", into.size, 0);
}

{
  // 坏形状不该崩 —— 手改过的存档、别处写进去的值都可能不是数组。
  const into = new Map<string, string[]>();
  for (const bad of [null, undefined, "reviewer", 42, { a: 1 }]) {
    collectWorkflowUses(docWith([{ id: "n1", title: "A", params: { skills: bad } }]), into);
  }
  eq("★ 非数组的值全部忽略,不崩", into.size, 0);
}

{
  // 数组里混进非字符串 / 空串 —— 手改过的存档真会这样。
  const into = new Map<string, string[]>();
  collectWorkflowUses(
    docWith([{ id: "n1", title: "A", params: { skills: ["ok", "", 42, null, "also-ok"] } }]),
    into,
  );
  eq("★ 只收非空字符串", [...into.keys()].sort().join(","), "also-ok,ok");
}

{
  // 同一格挂同名两次（手改过）→ 记两次引用。**不去重**是刻意的：这里报的是
  // "有几处引用"，去重会让数字骗人。
  const into = new Map<string, string[]>();
  collectWorkflowUses(
    docWith([{ id: "n1", title: "A", params: { skills: ["dup", "dup"] } }]),
    into,
  );
  eq("同名两次 → 两处引用(不去重)", into.get("dup")?.length, 2);
}

{
  // 跨多份工作流汇总 —— 调用方把同一个 map 传进去累积。
  const into = new Map<string, string[]>();
  collectWorkflowUses(docWith([{ id: "n1", title: "评审", params: { skills: ["shared"] } }]), into);
  const doc2 = docWith([{ id: "n9", title: "复核", params: { skills: ["shared"] } }]);
  (doc2 as unknown as { name: string }).name = "另一张图";
  collectWorkflowUses(doc2, into);
  eq("★ 跨图汇总到同一条", into.get("shared")?.length, 2);
}

{
  // 节点没有 title（旧存档可能没有）→ 退回用 id，不能变成 undefined。
  const into = new Map<string, string[]>();
  collectWorkflowUses(docWith([{ id: "n7", params: { skills: ["s"] } }]), into);
  eq("没有 title → 用节点 id 兜底", into.get("s")?.[0], "文献评审·n7");
}

console.log(`\nnode-skills-view-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
