/**
 * Headless smoke for **SceneDeployment 记录 + 纯状态机**(ARC-002 / MC-058 的第三片)。
 *
 * 纯契约、纯函数:只验「一条部署事实的形状」与「步骤/整体状态怎么由各步推导」。**不碰 DB/IPC**
 * —— 持久化与部署器执行是后续切片。
 *
 * ## 它钉死的判据
 *
 *  - 新建部署:各步 `pending`、整体 `deploying`,并绑定 sceneId / specDigest / planDigest / actor;
 *  - ★ 承重:**一步失败 → 整体 PARTIAL(不是 ACTIVE)** —— MC-058 拒绝「把部分成功报成 ACTIVE」的
 *    假方案,这是那块验收的判据落点;
 *  - 重试补全失败的步 → 整体回到 ACTIVE;
 *  - 整体状态**完全由各步推导**(全 done→ACTIVE / 全 failed→FAILED / 有失败有成功→PARTIAL /
 *    仍在跑→DEPLOYING),不是调用方手填;
 *  - `advanceDeployment` **不改入参**(返回新记录);
 *  - 验收:期望回读的资源全在回读集合里才算通过,缺的列进 `missing`;
 *  - 给一个计划里不存在的 actionId → **抛错**(不静默跳过,硬规矩 3)。
 *
 * Run: scripts/scene-deploy-smoke/run.sh
 */
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import {
  createDeployment,
  advanceDeployment,
  evaluateAcceptance,
  deriveDeploymentStatus,
  type SceneDeployment,
  type SceneDeploymentActor,
} from "@contracts/sceneDeployment";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const ACTOR: SceneDeploymentActor = { actorKind: "user", actorId: "desktop" };

/** 一份合法的「代码巡检」场景:定时触发器依赖巡检工作流。 */
function plan() {
  const r = validateSceneSpec({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId: "code-inspect-daily",
    goal: "每天检查代码、执行测试,失败后通知我",
    capabilities: [],
    resources: [
      { kind: "workflow", id: "wf_inspect", spec: { name: "代码巡检" } },
      { kind: "automation", id: "auto_daily", spec: { cron: "0 9 * * *" }, dependsOn: ["wf_inspect"] },
    ],
    acceptance: { description: "工作流与定时触发器都可见", expectResourceIds: ["wf_inspect", "auto_daily"] },
  });
  if (!r.ok) throw new Error("前置场景不合法:" + JSON.stringify(r.problems));
  return compileScenePlan(r.spec);
}

/* ── 1. 新建部署:形状与初始状态 ── */
{
  const p = plan();
  const d = createDeployment({ deploymentId: "dep_1", plan: p, actor: ACTOR, now: 1000 });
  eq("新建部署行数 = 计划步骤数", d.steps.length, 2);
  check("新建部署:整体为 deploying", d.status === "deploying", d.status);
  check("新建部署:所有步骤 pending", d.steps.every((s) => s.status === "pending"), d.steps);
  eq("新建部署绑定 sceneId", d.sceneId, "code-inspect-daily");
  eq("新建部署绑定 specDigest(= 计划的 specDigest)", d.specDigest, p.specDigest);
  eq("新建部署绑定 planDigest(= 计划的 digest)", d.planDigest, p.digest);
  eq("新建部署记下发起者身份 actorKind", d.actor.actorKind, "user");
  eq("新建部署记下发起者身份 actorId", d.actor.actorId, "desktop");
  eq("新建部署记下 createdAt", d.createdAt, 1000);
  eq("新建部署步骤顺序 = 计划顺序(拓扑序)", d.steps.map((s) => s.actionId).join(","), "wf_inspect,auto_daily");
}

/* ── 2. ★ 状态机走一遍:部署 → 部分失败 → PARTIAL → 重试补全 → ACTIVE ── */
{
  const p = plan();
  let d: SceneDeployment = createDeployment({ deploymentId: "dep_1", plan: p, actor: ACTOR, now: 1000 });

  // 建工作流步开始跑。
  d = advanceDeployment(d, { actionId: "wf_inspect", status: "running" }, 1100);
  eq("工作流步 running 时记下 startedAt", d.steps[0].startedAt, 1100);
  check("工作流步 running 时整体仍 deploying", d.status === "deploying", d.status);

  // 工作流建成。
  d = advanceDeployment(d, { actionId: "wf_inspect", status: "done", resourceUid: "wf_uid_1" }, 1200);
  eq("工作流步 done 后记下 resourceUid", d.steps[0].resourceUid, "wf_uid_1");
  check("工作流步 done 后整体仍 deploying(触发器还没跑)", d.status === "deploying", d.status);

  // 触发器步失败。
  d = advanceDeployment(d, { actionId: "auto_daily", status: "running" }, 1300);
  d = advanceDeployment(d, { actionId: "auto_daily", status: "failed", error: "cron 语法被拒" }, 1400);

  // ★★ 承重:有 done(工作流)+ 有 failed(触发器) → 部分成功,必须是 PARTIAL,绝不许报成 ACTIVE。
  eq("★ 一步失败、另一步成功 → 整体 PARTIAL(不是 ACTIVE)", d.status, "partial");
  eq("失败步的 error 被记下", d.steps[1].error, "cron 语法被拒");
  check("失败步没有被抹掉顺序(仍在第 2 步)", d.steps[1].actionId === "auto_daily", d.steps);

  // 重试补全:failed → running → done。
  d = advanceDeployment(d, { actionId: "auto_daily", status: "running" }, 1500);
  eq("重试时:该步回到 running", d.steps[1].status, "running");
  eq("重试 running 时整体回到 deploying", d.status, "deploying");
  d = advanceDeployment(d, { actionId: "auto_daily", status: "done", resourceUid: "auto_uid_1" }, 1600);

  // ★ 全部补全 → ACTIVE。
  eq("★ 重试补全后整体转为 ACTIVE", d.status, "active");
  eq("补全后触发器步也带上 resourceUid", d.steps[1].resourceUid, "auto_uid_1");
  check("补全后两步都是 done", d.steps.every((s) => s.status === "done"), d.steps);
  check("失败步重试后 error 不残留", d.steps[1].error === undefined, d.steps[1]);
}

/* ── 3. 整体状态推导的其它档(纯函数直测) ── */
{
  const S = (actionId: string, status: "pending" | "running" | "done" | "failed") => ({ actionId, status });
  eq("全 done → ACTIVE", deriveDeploymentStatus([S("a", "done"), S("b", "done")]), "active");
  eq("有 failed 且有 done → PARTIAL", deriveDeploymentStatus([S("a", "done"), S("b", "failed")]), "partial");
  eq("全 failed → FAILED", deriveDeploymentStatus([S("a", "failed"), S("b", "failed")]), "failed");
  eq("单步 failed(无 done)→ FAILED", deriveDeploymentStatus([S("a", "failed")]), "failed");
  eq("任一步 running → DEPLOYING", deriveDeploymentStatus([S("a", "done"), S("b", "running")]), "deploying");
  eq("任一步 pending → DEPLOYING", deriveDeploymentStatus([S("a", "done"), S("b", "pending")]), "deploying");
  eq("全 pending → DEPLOYING", deriveDeploymentStatus([S("a", "pending")]), "deploying");
}

/* ── 4. advanceDeployment 不改入参 ── */
{
  const p = plan();
  const before = createDeployment({ deploymentId: "dep_1", plan: p, actor: ACTOR, now: 1000 });
  const after = advanceDeployment(before, { actionId: "wf_inspect", status: "running" }, 1100);
  eq("原记录的该步仍是 pending(入参未被改)", before.steps[0].status, "pending");
  check("返回的是新对象(引用不同)", after !== before, { same: after === before });
  check("返回的 steps 是新数组", after.steps !== before.steps, { same: after.steps === before.steps });
  eq("新记录的该步已变 running", after.steps[0].status, "running");
}

/* ── 5. 未知 actionId 抛错(不静默跳过) ── */
{
  const p = plan();
  const d = createDeployment({ deploymentId: "dep_1", plan: p, actor: ACTOR, now: 1000 });
  let threw = false;
  try {
    advanceDeployment(d, { actionId: "ghost_step", status: "running" }, 1100);
  } catch {
    threw = true;
  }
  check("★ advance 一个计划里不存在的 actionId → 抛错(不静默跳过)", threw, { threw });
}

/* ── 6. 验收判定 ── */
{
  const p = plan();
  let d = createDeployment({ deploymentId: "dep_1", plan: p, actor: ACTOR, now: 1000 });
  d = advanceDeployment(d, { actionId: "wf_inspect", status: "done", resourceUid: "u1" }, 1100);
  d = advanceDeployment(d, { actionId: "auto_daily", status: "done", resourceUid: "u2" }, 1200);

  // ★ 承重:期望回读的 automation 没出现在回读集合里 → 验收不通过。
  const bad = evaluateAcceptance(d, ["wf_inspect", "auto_daily"], ["wf_inspect"], 2000);
  check("★ 期望的 automation 没回读到 → 验收不通过", bad.acceptance?.passed === false, bad.acceptance);
  eq("缺的回读资源列进 missing", (bad.acceptance?.missing ?? []).join(","), "auto_daily");
  eq("验收结果写在 deployment.acceptance 里", bad.acceptance?.checkedAt, 2000);
  check("未通过时 steps 不受影响(状态仍由各步推导)", bad.steps.every((s) => s.status === "done"), bad.steps);

  // 回读齐全 → 通过。
  const good = evaluateAcceptance(d, ["wf_inspect", "auto_daily"], ["wf_inspect", "auto_daily", "extra"], 2100);
  check("期望资源全部回读到 → 验收通过", good.acceptance?.passed === true, good.acceptance);
  eq("通过时 missing 为空", (good.acceptance?.missing ?? []).join(","), "");
  eq("通过时保留 observed 原始集合", (good.acceptance?.observed ?? []).join(","), "wf_inspect,auto_daily,extra");
}

console.log(`\nscene-deploy-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
