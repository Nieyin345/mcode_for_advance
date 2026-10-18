/**
 * workflow-seed-smoke — 【MC-053】出厂工作流播种名单损坏不许复活已删内容。
 *
 * ## 盯的是什么
 *
 * `library.ts` 的 `ensureShippedSeeded` 从前把"名单读不出来"当空名单 —— 已删除的
 * 出厂工作流在坏 JSON 下会被**重新播回表里**,违背产品承诺"删了就是删了"。修复后
 * 名单分三态:NEVER_SEEDED(真新用户,照播)/ SEEDED(照常补缺)/ CORRUPT(不播、
 * 不覆盖名单,显式记诊断)。
 *
 * ## 判据立在"被删的那一行在不在表里"
 *
 * 这是用户可观察的事实,也是台账红例本身:删除 → 砸坏名单 → 读列表,那一行必须
 * **不回来**;而新用户(空库)第一次读必须照常播种(防"一律不播"这种过度保守)。
 *
 * ## 两趟进程(见 run.sh)
 *
 * `seed`:空库执行第一次读取(触发播种)→ 删掉一个出厂工作流 → 留下名字与 id。
 * `verify`:新进程重新读库 —— 播种闸是进程内的,"重启"才是用户真实场景。
 *
 * 数据根由 `MCODE_SMOKE_DATA_ROOT`(mktemp -d)钉住,桩里没设就抛;跑完即删。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const { SettingRepo, WorkflowRepo } = await import("@main/store/repositories.js");
const { BUILTIN_WORKFLOWS } = await import("@main/orchestration/builtins.js");
const lib = await import("@main/orchestration/library.js");
// 导出用的是 `library.ts` 内部同一份 `exportWorkflowDoc`(纯函数,不起 DB / Electron)。
const { exportWorkflowDoc } = await import("@main/orchestration/workflowValidation.js");

await initDb();

const SEEDED_KEY = "workflow.seededShipped";
const FIXTURE = join(DATA, "seed-fixture.json");

if (process.argv.includes("seed")) {
  // ── 第一趟:空库第一次读取 = 真·新用户路径 ──
  console.log("\n【MC-053】第一趟:空库播种 + 用户删除");
  const first = lib.listWorkflows();
  check("空库第一次读取:出厂工作流被播种(不是一律不播)", first.length === BUILTIN_WORKFLOWS.length, {
    listed: first.length,
    shipped: BUILTIN_WORKFLOWS.length,
  });
  const victim = BUILTIN_WORKFLOWS[0]!;
  check("播种名单已写入且含全部出厂 id", (() => {
    const ids: unknown = JSON.parse(SettingRepo.get(SEEDED_KEY) ?? "[]");
    return Array.isArray(ids) && BUILTIN_WORKFLOWS.every((d) => (ids as string[]).includes(d.id));
  })(), SettingRepo.get(SEEDED_KEY));

  // 用户主动删除一个出厂工作流(走真删除口)。
  const removed = lib.removeWorkflow(victim.id);
  check("删除成功(真删除口)", removed.ok === true, removed);
  check("删后表里没有它", lib.getWorkflow(victim.id) === null);

  writeFileSync(FIXTURE, JSON.stringify({ id: victim.id, name: victim.name }));
  console.log(`第一趟完成:已删除出厂工作流「${victim.name}」(${victim.id})`);
} else if (process.argv.includes("verify")) {
  // ── 第二趟:新进程读同一个库 ──
  console.log("\n【MC-053】第二趟:重启后删的不复活;名单损坏也不复活");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { id: string; name: string };

  // ① 健康名单:重启后删的不复活(既有语义,不许退化)。
  const healthy = lib.listWorkflows();
  check("★ 重启后(健康名单)被删的出厂工作流不复活", !healthy.some((w) => w.id === fixture.id), {
    ids: healthy.map((w) => w.id).includes(fixture.id),
  });
  check("重启后其余出厂工作流还在", healthy.length === BUILTIN_WORKFLOWS.length - 1, healthy.length);

  // ② 名单损坏(截断 JSON,台账原例):重启读列表,被删的仍不许复活。
  SettingRepo.set(SEEDED_KEY, "{truncated");
  // 注意:同一个进程里 seededThisRun 已经是 true —— 这正是重启场景要跨进程的原因。
  // 这里用"再起一次同样读取"模拟足够吗?不够:闸已关。所以验证损坏态要走一条
  // **新进程**才看得到的路 —— run.sh 第三趟(见 verify-corrupt)。此处先断言分类器。
  const status = lib.workflowSeedStatus();
  check("★ 损坏名单被分类为 CORRUPT(不是静默当空)", status.state === "CORRUPT" && status.seedable === false, status);

  // ③ 非数组、混进非字符串:同判 CORRUPT。
  SettingRepo.set(SEEDED_KEY, JSON.stringify({ not: "array" }));
  check("非数组名单同样判 CORRUPT", lib.workflowSeedStatus().state === "CORRUPT", lib.workflowSeedStatus());
  SettingRepo.set(SEEDED_KEY, JSON.stringify(["ok-id", 42]));
  check("混进非字符串同样判 CORRUPT", lib.workflowSeedStatus().state === "CORRUPT", lib.workflowSeedStatus());

  // ④ 好名单:判 SEEDED(防"一律 CORRUPT"的过度保守)。
  SettingRepo.set(SEEDED_KEY, JSON.stringify(BUILTIN_WORKFLOWS.map((d) => d.id)));
  check("健康名单判 SEEDED 且可播种", lib.workflowSeedStatus().state === "SEEDED" && lib.workflowSeedStatus().seedable === true, lib.workflowSeedStatus());

  // ⑤ 缺省:NEVER_SEEDED(真新用户)。
  SettingRepo.set(SEEDED_KEY, "");
  check("键为空判 NEVER_SEEDED", lib.workflowSeedStatus().state === "NEVER_SEEDED", lib.workflowSeedStatus());

  // 收尾:把名单留在**损坏**值上 —— 第三趟(新进程)要拿它验跨进程的"不复活"。
  SettingRepo.set(SEEDED_KEY, "{truncated");
} else if (process.argv.includes("verify-corrupt")) {
  // ── 第三趟:新进程 + 损坏名单 —— 真正跨进程的"坏名单不复活"。 ──
  console.log("\n【MC-053】第三趟:新进程 + 损坏名单,读列表");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { id: string; name: string };
  const listed = lib.listWorkflows();
  check("★ 新进程读到损坏名单:被删的出厂工作流没有复活", !listed.some((w) => w.id === fixture.id), {
    reappeared: listed.map((w) => w.id).includes(fixture.id),
  });
  check("★ 损坏名单没有被覆盖写(原损坏值保留,等修复)", SettingRepo.get(SEEDED_KEY) === "{truncated", {
    value: SettingRepo.get(SEEDED_KEY),
  });
  // 正控:库里原有的别的行照常列出来(不是"读列表整个挂了")。
  check("读列表本身没挂(其余行照常列出)", listed.length >= BUILTIN_WORKFLOWS.length - 1, listed.length);
} else if (process.argv.includes("import-fidelity")) {
  // ── 第四趟:【ARC-006】导入不得无声丢未知节点/字段,提醒必须随结果出来。 ──
  //
  // 判据立在**真实的导入入口** `importWorkflowInto`(界面「从文件导入」、Agent 的
  // `workflow.import`、出厂预设四条路共用这一个函数)上,不是解析器单测:
  //  - 从前 `parseWorkflowText` 算出的提醒(`node.unknown-kind` / `schema.unknown-field`)
  //    在 `const doc = parsed.doc` 那一行之后**整批丢掉**,用户只看到"导入成功";
  //  - 未知**节点**按契约是 `{id,type,title,params}` 的自由类型 id,不该被导入路径丢弃;
  //  - 未知**字段**由 `mergeUnknownWorkflowFields` 按身份贴回,落库后再读出来必须还在。
  //
  // 用虚构档案(临时数据根),不碰用户文件。
  console.log("\n【ARC-006】第四趟:导入含未知节点类型与未知字段的档案");
  const archive = {
    id: "wf_import_fidelity_source",
    name: "导入保真冒烟",
    builtin: false,
    updatedAt: 0,
    // 文档级未知字段(未来版本写的档案)
    futureDocField: { keep: true },
    nodes: [
      { id: "A", type: "mcode.main", title: "主对话", params: { instruction: "拆成几步" }, position: { x: 0, y: 0 } },
      {
        id: "B",
        type: "acme.future-node", // 这台机器没装的节点类型
        title: "未来节点",
        params: { instruction: "做这一步" },
        position: { x: 0, y: 120 },
        futureNodeField: ["keep"], // 节点级未知字段
      },
    ],
    edges: [{ id: "e1", from: "A", to: "B", futureEdgeField: "e" }], // 边级未知字段
  };
  const imported = await lib.importWorkflowInto(JSON.stringify(archive));
  check("★ 未知节点类型/字段不拦导入(只提醒)", imported.ok === true, imported);
  const warnings = imported.ok ? (imported.warnings ?? []) : imported.warnings;
  check("★ 导入结果**带回** warnings(不再无声)", warnings.length > 0, imported);
  check(
    "★ 提醒点名未知节点类型(acme.future-node)",
    warnings.some((w) => w.includes("acme.future-node")),
    warnings,
  );
  check(
    "★ 提醒点名已保留的未知字段(futureDocField / futureNodeField / futureEdgeField)",
    warnings.some((w) => w.includes("futureDocField")) &&
      warnings.some((w) => w.includes("futureNodeField")) &&
      warnings.some((w) => w.includes("futureEdgeField")),
    warnings,
  );
  check(
    "提醒里明说未知字段「已原样保留」(不是含糊带过)",
    warnings.some((w) => w.includes("已原样保留")),
    warnings,
  );

  const stored = imported.ok ? lib.getWorkflow(imported.id) : null;
  check("落库后读得回来", stored !== null, imported.ok ? imported.id : imported);
  const storedRaw = (stored ?? {}) as unknown as Record<string, unknown>;
  const storedNodes = (stored?.nodes ?? []) as unknown as Array<Record<string, unknown>>;
  const storedEdges = (stored?.edges ?? []) as unknown as Array<Record<string, unknown>>;
  check(
    "★ 未知节点没有被丢:落库仍有 acme.future-node 且 id/type 原样",
    storedNodes.some((n) => n.id === "B" && n.type === "acme.future-node"),
    storedNodes.map((n) => n.type),
  );
  check(
    "★ 未知字段没有被丢:文档级/节点级/边级都原样留在库里",
    JSON.stringify(storedRaw.futureDocField) === JSON.stringify({ keep: true }) &&
      JSON.stringify(storedNodes.find((n) => n.id === "B")?.futureNodeField) === JSON.stringify(["keep"]) &&
      storedEdges[0]?.futureEdgeField === "e",
    { doc: storedRaw.futureDocField, node: storedNodes.find((n) => n.id === "B")?.futureNodeField, edge: storedEdges[0]?.futureEdgeField },
  );
  // 导出再读一遍 —— "一进一出瘦一圈"那条反例的正面:导出文本里它们也在。
  const exported = stored === null ? "" : exportWorkflowDoc(stored);
  check(
    "★ 导出文本仍带未知节点与字段(导入→导出不在库里瘦一圈)",
    exported.includes("acme.future-node") && exported.includes("futureDocField") &&
      exported.includes("futureNodeField") && exported.includes("futureEdgeField"),
    exported.slice(0, 300),
  );
  // 负面:干净档案不该凭空多一批提醒,否则"未知项"这条提醒会被噪声淹没。
  const clean = await lib.importWorkflowInto(JSON.stringify({
    id: "wf_import_clean_source",
    name: "干净导入冒烟",
    builtin: false,
    updatedAt: 0,
    nodes: [{ id: "A", type: "mcode.main", title: "主对话", params: { instruction: "拆成几步" }, position: { x: 0, y: 0 } }],
    edges: [],
  }));
  check("干净档案导入成功且不带提醒(不误报)", clean.ok && (clean.warnings ?? []).length === 0, clean);

  // 失败路径:档案同时有**硬错误**(悬空边)与**未知节点类型** —— 整份拒绝,
  // 但已经算出来的未知类型提醒同样要带回去(它描述的是档案本身,不是"存不存").
  const rejected = await lib.importWorkflowInto(JSON.stringify({
    id: "wf_import_rejected_source",
    name: "被拒导入冒烟",
    builtin: false,
    updatedAt: 0,
    nodes: [
      { id: "A", type: "mcode.main", title: "主对话", params: { instruction: "拆成几步" }, position: { x: 0, y: 0 } },
      { id: "B", type: "acme.future-node", title: "未来节点", params: {}, position: { x: 0, y: 120 } },
    ],
    edges: [{ id: "e_bad", from: "A", to: "ghost" }],
  }));
  check("硬错误仍然整份拒绝(警告不把拒绝变成成功)", rejected.ok === false, rejected);
  check(
    "★ 拒绝时也不丢掉已算出的未知类型提醒",
    !rejected.ok && rejected.warnings.some((w) => w.includes("acme.future-node")),
    rejected,
  );
}

console.log(`\nworkflow-seed-smoke(${process.argv[2] ?? ""}):${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
