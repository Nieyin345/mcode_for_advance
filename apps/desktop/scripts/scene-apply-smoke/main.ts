/**
 * Headless smoke for **场景部署执行端**(MC-058 / ARC-002 的 dry-run + apply)。
 *
 * 被测:`@main/appServices/sceneDeploy.ts`(`dryRunScene` / `applyScene`)。它们把
 * `compileSceneCommands` 产出的命令描述符**逐步派发到既有服务**(经 `appControl/tools.ts` 的
 * `findEntry` + `callRpc` —— 与 `app_api_call` **同一条**通路),并在每一步后落盘 `SceneDeployment`。
 *
 * ## 它钉死的判据
 *
 *  - **dry-run 无副作用**:只回静态预判,不建行、不调任何 handler;
 *  - **apply 逐步记录**:按拓扑序逐步派发,每步 running→done,落进 `scene_deployments`;
 *  - ★ 承重:**一步失败 → 整体 `partial`(不是 `active`)** —— MC-058 拒绝「把部分成功报成 active」;
 *  - **依赖闸**:依赖的步没走到 done → 被依赖步**不执行**(记 failed 并点名依赖),handler 不被调;
 *  - **needsResolution(plugin/panel/scaffold)** → 该步**明确不执行**(记 failed + 说明),不猜入口;
 *  - ★ 承重:**没有计划级授权 / 授权绑的是另一份计划** → 拒绝执行,连部署记录都不建。
 *
 * ## 安全前提
 *
 * 数据根走 `$MCODE_SMOKE_DATA_ROOT`(见 run-store-smoke/stubs/dataRoot.ts 里那句"没设就抛")。
 * `run.sh` 用 `mktemp -d` 建它、跑完删 —— `initDb()` 在路径不存在时会新建空库,指错地方就是
 * 拿空库盖掉用户的聊天记录。
 *
 * Run: scripts/scene-apply-smoke/run.sh
 */
import { initDb, closeDb, getDb } from "@main/store/db.js";
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
import type { Grant } from "@contracts/policyEngine";
import type { SceneDeploymentActor } from "@contracts/sceneDeployment";
import {
  dryRunScene,
  applyScene,
  SCENE_APPLY_METHOD,
} from "@main/appServices/sceneDeploy.js";
import { loadDeployment } from "@main/appServices/sceneDeploymentStore.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const ACTOR: SceneDeploymentActor = { actorKind: "agent", actorId: "sess_1" };

/** 合法 spec 的一处构造器 —— 资源数组由调用方给(便于各场景定制)。 */
function specWith(sceneId: string, resources: SceneSpec["resources"], expect: string[]): SceneSpec {
  return {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId,
    goal: "每天检查代码、执行测试,失败后通知我",
    capabilities: [],
    resources,
    acceptance: { description: "资源都可见", expectResourceIds: expect },
  };
}

/** 校验后的 spec(前置断言,不合法直接抛,免得后面测的是坏输入)。 */
function checked(raw: SceneSpec): SceneSpec {
  const r = validateSceneSpec(raw);
  if (!r.ok) throw new Error("前置场景不合法:" + JSON.stringify(r.problems));
  return r.spec;
}

/** 一枚**绑定本计划**的用户计划级授权(默认各字段合法,可覆写来造每一档失效)。 */
function grantFor(planDigest: string, overrides: Partial<Grant> = {}): Grant {
  return {
    grantId: "g1",
    sceneId: "scene",
    allowedActions: [SCENE_APPLY_METHOD],
    scopedCore: { scenePlan: planDigest },
    configHash: "",
    expiresAt: Date.now() + 60_000,
    approvalSource: { kind: "user", id: "desktop" },
    revoked: false,
    usedCount: 0,
    ...overrides,
  };
}

function countRows(): number {
  const stmt = getDb().prepare("SELECT COUNT(*) AS n FROM scene_deployments");
  stmt.step();
  const n = Number((stmt.getAsObject() as { n: number }).n);
  stmt.free();
  return n;
}

await initDb();
clearRpcHandlers();

/* ── 1. dry-run:无副作用 ── */
console.log("\n① dry-run:静态预判,无副作用");
{
  const spec = specWith(
    "dry_scene",
    [
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "automation", id: "auto", spec: { cron: "0 9 * * *" }, dependsOn: ["wf"] },
    ],
    ["wf", "auto"],
  );
  let calls = 0;
  recordRpcHandler("workflow:save", () => { calls += 1; return {}; });
  const before = countRows();
  const r = dryRunScene(spec);
  check("dry-run 校验通过", r.ok === true, r);
  if (r.ok) {
    eq("dry-run 给两条命令(计划顺序)", r.steps.length, 2);
    eq("dry-run 第一步是工作流(拓扑序)", r.steps[0]?.actionId, "wf");
    check("dry-run 两步都会跑(无 needsResolution)", r.steps.every((s) => s.willRun), r.steps);
    eq("dry-run 第一步的服务标签是 workflow.save", r.steps[0]?.serviceLabel, "workflow.save");
    eq("dry-run 没有需决议的命令", r.unresolved.length, 0);
  }
  eq("★ dry-run 没有任何 handler 被调", calls, 0);
  eq("★ dry-run 没有建部署行", countRows(), before);
}

/* ── 2. dry-run 校验失败:一次报全,不执行 ── */
console.log("\n② dry-run:声明不合法 → 报全部问题,不执行");
{
  const bad = { schemaVersion: 99, sceneId: "BAD ID", goal: "", capabilities: [], resources: [], acceptance: {} };
  const r = dryRunScene(bad);
  check("校验失败返回 ok:false", r.ok === false, r);
  if (!r.ok) check("一次报出多个问题(不是报第一个就停)", r.problems.length >= 2, r.problems);
}

/* ── 3. apply 成功:逐步派发、记录、验收 ── */
console.log("\n③ apply:逐步派发到既有服务 + 记录每一步");
{
  clearRpcHandlers();
  const calls: Array<Record<string, unknown>> = [];
  recordRpcHandler("workflow:save", (_e, raw) => { calls.push(raw as Record<string, unknown>); return { ok: true }; });
  const spec = checked(specWith(
    "happy_scene",
    [
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "automation", id: "auto", spec: { cron: "0 9 * * *" }, dependsOn: ["wf"] },
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_happy", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 整体状态 ACTIVE(两步都成)", r.deployment.status, "active");
    check("两步都 done", r.deployment.steps.every((s) => s.status === "done"), r.deployment.steps);
    eq("★ 验收通过(期望资源都进了 observed)", r.deployment.acceptance?.passed, true);
    eq("验收 observed = 两步 actionId", (r.deployment.acceptance?.observed ?? []).join(","), "wf,auto");
    eq("部署记下发起者身份", r.deployment.actor.actorId, "sess_1");
  }
  eq("★ 既有服务被调两次(两条命令各一次)", calls.length, 2);
  check("★ 派发顺序 = 拓扑序(先工作流载荷、后触发器载荷)", calls[0]?.name !== undefined && calls[1]?.cron !== undefined, calls);
  // 逐步落盘:回读得到同一份。
  const back = loadDeployment("dep_happy");
  eq("★ 部署真落进 scene_deployments(回读得到)", back?.status, "active");
  eq("★ 回读的部署 id 对得上", back?.deploymentId, "dep_happy");
}

/* ── 4. ★ 一步失败 → PARTIAL(不是 ACTIVE) ── */
console.log("\n④ apply:一步失败 → 整体 PARTIAL,绝不报成 ACTIVE");
{
  clearRpcHandlers();
  recordRpcHandler("workflow:save", (_e, raw) => {
    const p = raw as Record<string, unknown>;
    if (p.cron !== undefined) throw new Error("cron 语法被拒(测试注入)");
    return {};
  });
  const spec = checked(specWith(
    "partial_scene",
    [
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "automation", id: "auto", spec: { cron: "坏表达式" }, dependsOn: ["wf"] },
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_partial", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 仍返回 applied(执行过,只是没全成)", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 一步失败、另一步成功 → 整体 PARTIAL(不是 ACTIVE)", r.deployment.status, "partial");
    eq("失败步记下服务真实错误", r.deployment.steps[1]?.error, "cron 语法被拒(测试注入)");
    eq("★ 验收不通过(期望资源没全回读到)", r.deployment.acceptance?.passed, false);
    eq("缺的回读资源列进 missing", (r.deployment.acceptance?.missing ?? []).join(","), "auto");
  }
  // 落盘那句也要是 partial,不能回落成 active。
  eq("★ 落盘的整体状态也是 PARTIAL", loadDeployment("dep_partial")?.status, "partial");
}

/* ── 5. 依赖闸:依赖的步没成功 → 被依赖步不执行 ── */
console.log("\n⑤ apply:依赖不成立 → 被依赖步不执行(不猜、不跳过)");
{
  clearRpcHandlers();
  let calls = 0;
  recordRpcHandler("workflow:save", () => { calls += 1; throw new Error("建工作流失败(测试注入)"); });
  const spec = checked(specWith(
    "dep_scene",
    [
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "automation", id: "auto", spec: { cron: "0 9 * * *" }, dependsOn: ["wf"] },
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_dep", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  if (r.ok && r.kind === "applied") {
    eq("★ 工作流步失败", r.deployment.steps[0]?.status, "failed");
    eq("★ 触发器步也失败(依赖未成功)", r.deployment.steps[1]?.status, "failed");
    check(
      "★ 触发器步的错说明了是依赖未成功(不是它自己跑了)",
      (r.deployment.steps[1]?.error ?? "").includes("依赖") && (r.deployment.steps[1]?.error ?? "").includes("wf"),
      r.deployment.steps[1]?.error,
    );
    eq("★ 两步都没成 → 整体 FAILED", r.deployment.status, "failed");
  } else {
    check("apply 应返回 applied", false, r);
  }
  eq("★ 服务只被调一次(依赖未成立的触发器步没被派发)", calls, 1);
}

/* ── 6. needsResolution:明确不执行,不猜入口 ── */
console.log("\n⑥ apply:needsResolution(plugin/panel/scaffold)→ 明确不执行,不猜入口");
{
  clearRpcHandlers();
  recordRpcHandler("workflow:save", () => ({}));
  const spec = checked(specWith(
    "plugin_scene",
    [
      { kind: "workflow", id: "wf", spec: { name: "巡检" } },
      { kind: "plugin", id: "plug", spec: { source: "local" } },
    ],
    ["wf", "plug"],
  ));
  const plan = compileScenePlan(spec);

  // dry-run 先如实说这一步不会跑。
  const dry = dryRunScene(spec);
  if (dry.ok) {
    const plug = dry.steps.find((s) => s.actionId === "plug");
    eq("dry-run:plugin 步静态判定不会跑", plug?.willRun, false);
    check("dry-run:给出不执行的原因", (plug?.notAppliedReason ?? "").length > 0, plug);
    eq("dry-run:plugin 被列进需决议清单", dry.unresolved.length, 1);
  } else {
    check("dry-run 应通过", false, dry);
  }

  const r = await applyScene({ deploymentId: "dep_plugin", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  if (r.ok && r.kind === "applied") {
    const plugStep = r.deployment.steps.find((s) => s.actionId === "plug");
    eq("★ plugin 步明确记为 failed(未执行)", plugStep?.status, "failed");
    check(
      "★ 记下「需决议、未执行」的原因(不静默跳过)",
      (plugStep?.error ?? "").includes("决议") && (plugStep?.error ?? "").includes("未执行"),
      plugStep?.error,
    );
    eq("工作流步照常建成", r.deployment.steps[0]?.status, "done");
    eq("★ 有成功有未执行 → PARTIAL", r.deployment.status, "partial");
  } else {
    check("apply 应返回 applied", false, r);
  }
}

/* ── 7. ★★ 授权闸:没有授权 / 授权绑错计划 → 拒绝执行 ── */
console.log("\n⑦ apply:计划级授权闸(无授权 / 错计划 → 不执行、不建记录)");
{
  clearRpcHandlers();
  let calls = 0;
  recordRpcHandler("workflow:save", () => { calls += 1; return {}; });
  const spec = checked(specWith(
    "auth_scene",
    [{ kind: "workflow", id: "wf", spec: { name: "巡检" } }],
    ["wf"],
  ));
  const plan = compileScenePlan(spec);
  const rowsBefore = countRows();

  // 7a. 授权来自非用户(agent 自铸)→ 拒。
  {
    const r = await applyScene({
      deploymentId: "dep_nonuser", spec, actor: ACTOR,
      grant: grantFor(plan.digest, { approvalSource: { kind: "agent", id: "x" } }),
    });
    check("非用户签发的授权 → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("拒绝码 = not_user", r.refusal.code, "not_user");
  }
  // 7b. 授权已撤销 → 拒。
  {
    const r = await applyScene({
      deploymentId: "dep_revoked", spec, actor: ACTOR,
      grant: grantFor(plan.digest, { revoked: true }),
    });
    check("已撤销的授权 → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("拒绝码 = revoked", r.refusal.code, "revoked");
  }
  // 7c. 授权已过期 → 拒。
  {
    const r = await applyScene({
      deploymentId: "dep_expired", spec, actor: ACTOR,
      grant: grantFor(plan.digest, { expiresAt: 1 }),
    });
    check("已过期的授权 → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("拒绝码 = expired", r.refusal.code, "expired");
  }
  // 7d. 授权没允许 scene.apply → 拒。
  {
    const r = await applyScene({
      deploymentId: "dep_method", spec, actor: ACTOR,
      grant: grantFor(plan.digest, { allowedActions: ["workflow.save"] }),
    });
    check("授权动作表不含 scene.apply → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("拒绝码 = method_not_allowed", r.refusal.code, "method_not_allowed");
  }
  // 7e. ★ 授权绑的是**另一份计划**(批准后 spec 被偷改)→ 拒。
  {
    const otherPlan = compileScenePlan(checked(specWith(
      "auth_scene",
      [{ kind: "workflow", id: "wf", spec: { name: "被偷改后的载荷" } }],
      ["wf"],
    )));
    check("前置:两份计划的 digest 不同", otherPlan.digest !== plan.digest);
    const r = await applyScene({
      deploymentId: "dep_wrongplan", spec, actor: ACTOR,
      grant: grantFor(otherPlan.digest),
    });
    check("★ 授权绑另一份计划 → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("★ 拒绝码 = plan_mismatch", r.refusal.code, "plan_mismatch");
  }

  eq("★ 五次拒绝执行:任何 handler 都没被调", calls, 0);
  eq("★ 五次拒绝执行:一条部署记录都没建", countRows(), rowsBefore);
  check("被拒绝的部署 id 确实读不到", loadDeployment("dep_wrongplan") === null);

  // 7f. 同一份计划 + 有效用户授权 → 放行(对照组:证明闸门不是"一律拒")。
  {
    const r = await applyScene({ deploymentId: "dep_ok", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("★ 有效用户授权 + 绑定本计划 → applied(闸门不是一律拒)", r.ok === true && r.kind === "applied", r);
    eq("照常建成 ACTIVE", r.ok && r.kind === "applied" ? r.deployment.status : null, "active");
  }
  eq("放行那次:服务被调一次", calls, 1);
}

/* ── 8. apply 对不合法声明:拒绝且不抛、不执行 ── */
console.log("\n⑧ apply:声明不合法 → 返回 invalid,不抛、不执行、不建记录");
{
  clearRpcHandlers();
  let calls = 0;
  recordRpcHandler("workflow:save", () => { calls += 1; return {}; });
  const rowsBefore = countRows();
  // 声明不合法时 `applyScene` **不抛**、返回 `{kind:"invalid"}`。把可能的抛接住转成明确断言 ——
  // 若哪天校验闸被拆掉(非法 spec 直落编译),这里会是一行 FAIL(而不是一个 stack trace)。
  let r: Awaited<ReturnType<typeof applyScene>> | null = null;
  try {
    r = await applyScene({
      deploymentId: "dep_badspec",
      spec: { schemaVersion: 99, sceneId: "BAD", goal: "", capabilities: [], resources: [], acceptance: {} },
      actor: ACTOR,
      grant: grantFor("x"),
    });
  } catch (err) {
    check("★ 声明不合法时 apply 不抛(校验闸在编译之前)", false, (err as Error).message);
  }
  check("★ 声明不合法 → 返回 invalid(不执行)", r !== null && r.ok === false && r.kind === "invalid", r);
  if (r !== null && r.ok === false && r.kind === "invalid") {
    check("一次报出多个问题", r.problems.length >= 2, r.problems);
  }
  eq("★ 没有任何 handler 被调", calls, 0);
  eq("★ 没有建部署记录", countRows(), rowsBefore);
}

closeDb();

console.log(`\nscene-apply-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
