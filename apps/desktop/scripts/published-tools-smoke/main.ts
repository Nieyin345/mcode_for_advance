/**
 * published-tools-smoke — 【MC-041】自建工作流发布为带参数的派生工具。
 *
 * ## 盯的是什么(台账失败反例的原文)
 *
 * AI 建一份声明必填 `paperId: string` 的工作流「文献整理」;用户说「调用文献整理
 * 工具,paperId=123」。从前:控制目录**找不到**派生工具、`app_workflow_run` **传不进**
 * 结构化实参、`inputSchema` 声明**没有读方**。修复后要成立的是完整闭环:
 * 发布 → 按名字检索 → help(参数) → 结构化执行(坏参**执行前**拒)→ 撤销。
 *
 * ## 判据立在"用户可观察的合同面"上
 *
 * 真 SQLite 里建真工作流(带 inputSchema),然后:
 *   §1 发布:表里真的写了记录;同名冲突/不存在的工作流被拒;
 *   §2 检索:名字能查 `workflow.run.<name>`(与静态目录同一条查询);
 *   §3 help:describe 交回参数 schema(必填、类型、说明);
 *   §4 校验:缺必填/类型不符 → **不执行**;好参 → 放行并渲染成正文;
 *   §5 撤销:检索不到;撤销幂等;未发布的撤销也 ok。
 *
 * Run: scripts/published-tools-smoke/run.sh
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

const DATA = process.env.MCODE_SMOKE_DATA_ROOT;
if (!DATA) throw new Error("MCODE_SMOKE_DATA_ROOT unset — run via run.sh");

const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");
const lib = await import("@main/orchestration/library.js");
const pt = await import("@main/orchestration/publishedTools.js");

await initDb();

console.log("\n【MC-041】准备:建一份声明 inputSchema 的工作流(台账失败反例的形状)");
/** 与 `newWorkflowDoc` 形状一致的最小合法图(触发方式 manual → prompt 型可跑)。 */
const doc = {
  id: "wf_paper_tool",
  name: "文献整理",
  builtin: false,
  updatedAt: Date.now(),
  prompt: "整理这篇文献。",
  inputSchema: {
    type: "object",
    required: ["paperId"],
    properties: {
      paperId: { type: "string", description: "文献条目 id" },
      depth: { type: "integer", description: "整理深度(可选)" },
      verbose: { type: "boolean" },
    },
  },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  nodes: [],
  edges: [],
};
{
  const r = (await lib.saveWorkflow({ ...doc, builtin: false } as never, { expectedRevision: null } as never)) as { ok?: boolean; error?: string };
  const saved = r.ok !== false;
  check("守卫:工作流真的存进了库(不是在空台上跑)", saved && lib.getWorkflow(doc.id) !== null, r);
}

console.log("\n【MC-041】§1 发布");
{
  const bad = pt.publishWorkflowTool({ workflowId: "wf_nope", name: "不存在" });
  check("★ 不存在的 workflow_id 被拒", bad.ok === false && (bad.error ?? "").includes("不存在"), bad);
  const ok = pt.publishWorkflowTool({ workflowId: doc.id, name: "文献整理", description: "把一篇文献做结构化整理" });
  check("★ 发布成功(真写了设置表)", ok.ok === true, ok);
  const raw = SettingRepo.get("workflow.publishedTools") ?? "";
  check("★ 表里以 workflowId 为键记录了名字", raw.includes(doc.id) && raw.includes("文献整理"), raw.slice(0, 160));
  // 同名冲突:另一份工作流用同名发布 → 拒。
  await lib.saveWorkflow({ ...doc, id: "wf_other", name: "另一份" } as never, { expectedRevision: null } as never);
  const clash = pt.publishWorkflowTool({ workflowId: "wf_other", name: "文献整理" });
  check("★ 同名冲突被拒(两个工具不能重名)", clash.ok === false && (clash.error ?? "").includes("已被"), clash);
  // 同一份重新发布(改名)是允许的(覆盖自己的记录)。
  const rename = pt.publishWorkflowTool({ workflowId: doc.id, name: "文献整理工具", description: "把一篇文献做结构化整理" });
  check("同一份可重新发布(改名 = 更新自己的记录)", rename.ok === true, rename);
  pt.publishWorkflowTool({ workflowId: doc.id, name: "文献整理", description: "把一篇文献做结构化整理" });
}

console.log("\n【MC-041】§2 检索(app_api_list 的动态实例)");
{
  const { publishedToolsWithDocs } = pt;
  const listed = publishedToolsWithDocs();
  const mine = listed.find((p) => p.workflowId === doc.id);
  check("★ 已发布的能在索引里查到", mine !== undefined, listed.map((p) => p.name));
  check("★ 派生工具方法名形如 workflow.run.<name>", mine !== undefined && pt.publishedToolMethodName(mine.tool) === "workflow.run.文献整理", mine && pt.publishedToolMethodName(mine.tool));
  check("★ 挂上工作流可读名与描述", mine?.docName === "文献整理" && (mine?.tool.description ?? "").includes("结构化"), mine);
}

console.log("\n【MC-041】§3 help:参数 schema 可见");
{
  const text = pt.describeWorkflowToolParams(doc.id);
  check("★ 必填参数在 help 里(paperId 不带 ?)", text.includes("paperId:") && !text.includes("paperId?:"), text);
  check("★ 可选参数带 ? 标记", text.includes("depth?:") && text.includes("verbose?:"), text);
  check("★ 字段说明带出来(用户/模型能读懂)", text.includes("文献条目 id"), text);
}

console.log("\n【MC-041】§4 结构化实参校验(台账验收:坏参**执行前**拒)");
{
  const missing = pt.validateWorkflowParams(lib.getWorkflow(doc.id), {});
  check("★ 缺必填 → 拒(且原因点名 paperId)", missing.ok === false && missing.error.includes("paperId"), missing);
  const wrongType = pt.validateWorkflowParams(lib.getWorkflow(doc.id), { paperId: 123 });
  check("★ 类型不符(要 string 给 number)→ 拒", wrongType.ok === false && wrongType.error.includes("paperId"), wrongType);
  const badInt = pt.validateWorkflowParams(lib.getWorkflow(doc.id), { paperId: "p1", depth: 1.5 });
  check("★ integer 收到小数 → 拒", badInt.ok === false && badInt.error.includes("depth"), badInt);
  const good = pt.validateWorkflowParams(lib.getWorkflow(doc.id), { paperId: "123", depth: 2, verbose: true });
  check("★ 合法实参放行", good.ok === true, good);
  const unknownField = pt.validateWorkflowParams(lib.getWorkflow(doc.id), { paperId: "p1", extraThing: { nested: 1 } });
  check("未声明的字段不拦(宽松契约;只有声明过的参与校验)", unknownField.ok === true, unknownField);
  const rendered = pt.renderWorkflowParams(lib.getWorkflow(doc.id), { paperId: "123" });
  check("★ 实参能渲染成正文(执行仍走既有 app_workflow_run)", rendered.includes("paperId") && rendered.includes("123") && rendered.includes("inputSchema"), rendered);
  // 没声明 inputSchema 的工作流:给对象放行、给标量拒。
  const noSchema = pt.validateWorkflowParams({}, { anything: 1 });
  check("没声明输入的工作流:对象实参放行", noSchema.ok === true, noSchema);
  const scalar = pt.validateWorkflowParams({}, "not-an-object");
  check("没声明输入的工作流:非对象实参仍拒(params 必须是键值对)", scalar.ok === false, scalar);
}

console.log("\n【MC-041】§5 撤销");
{
  const r = pt.unpublishWorkflowTool(doc.id);
  check("★ 撤销成功", r.ok === true && r.existed === true, r);
  check("★ 撤销后索引里没有它", pt.publishedToolsWithDocs().every((p) => p.workflowId !== doc.id), pt.publishedToolsWithDocs().map((p) => p.name));
  const again = pt.unpublishWorkflowTool(doc.id);
  check("★ 再撤销幂等(目标状态已达成)", again.ok === true && again.existed === false, again);
  check("★ 工作流本体没被撤销动作碰到", lib.getWorkflow(doc.id)?.name === "文献整理", lib.getWorkflow(doc.id)?.name);
}

console.log("\n【MC-041】§6 发布表损坏 → 拒绝写(与 MC-051/053/054 同一协议)");
{
  SettingRepo.set("workflow.publishedTools", "{truncated");
  const r = pt.publishWorkflowTool({ workflowId: doc.id, name: "文献整理" });
  check("★ 发布表损坏时拒绝发布(不覆盖现场)", r.ok === false && (r.error ?? "").includes("损坏"), r);
  const list = pt.publishedWorkflowTools();
  check("★ 损坏时如实报 corrupted(不静默当空表)", list.corrupted === true && list.tools.length === 0, list);
  const un = pt.unpublishWorkflowTool(doc.id);
  check("★ 损坏时撤销也拒绝(不静默覆盖)", un.ok === false, un);
  SettingRepo.set("workflow.publishedTools", "");
}

rmSync(DATA, { recursive: true, force: true });
console.log(`\npublished-tools-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
