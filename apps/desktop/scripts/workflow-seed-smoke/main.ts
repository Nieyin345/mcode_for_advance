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
}

console.log(`\nworkflow-seed-smoke(${process.argv[2] ?? ""}):${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
