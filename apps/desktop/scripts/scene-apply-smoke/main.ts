/**
 * Headless smoke for **场景部署执行端**(MC-058 / ARC-002 的 dry-run + apply + 真实回读 + 补偿)。
 *
 * 被测:`@main/appServices/sceneDeploy.ts`(`dryRunScene` / `applyScene` / `readbackScene`)。它们把
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
 *  - ★ 承重:**没有计划级授权 / 授权绑的是另一份计划** → 拒绝执行,连部署记录都不建;
 *  - ★★ 承重(本片新增):**验收的 observed 取自独立回读宿主真实资源**,不是部署记录里「走到 done
 *    的步」—— 资源被**带外删掉**后记录仍说 done,但回读查不到 → 验收不通过;
 *  - ★★ 承重(本片新增):**中途失败时补偿之前已建成、可补偿的步**(逆序撤销),失败不留孤儿;
 *    不可补偿 / 无逆操作 / 逆操作失败的步**如实记一条**「未补偿 + 原因」,**不静默**。
 *
 * ## 它怎么模拟「宿主真实资源」
 *
 * 各服务的 handler 换桩成一个内存宿主(`Host`):save 把资源登记进去,read 按 id 查它是否存在,
 * remove 删掉它。于是 `readbackScene` 的 observed 真的反映**宿主当前状态** —— 从宿主里删掉一条,
 * 回读就查不到,验收随之失败(这正是本片要证明的:观察值不是从部署记录里抄的)。
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
import { evaluateAcceptance } from "@contracts/sceneDeployment";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
import type { Grant } from "@contracts/policyEngine";
import type { SceneDeploymentActor } from "@contracts/sceneDeployment";
import {
  dryRunScene,
  applyScene,
  readbackScene,
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

/* ───────────────────────── 内存宿主(模拟各服务背后的真实资源) ───────────────────────── */

interface Host {
  /** 工作流/自动化共用一个库,键是资源 id(= 声明正文里的 `id`,与 WorkflowDoc.id 同义)。 */
  workflows: Map<string, Record<string, unknown>>;
  skills: Set<string>;
  mcps: Set<string>;
  hooks: Set<string>;
  modules: Set<string>;
}

function newHost(): Host {
  return { workflows: new Map(), skills: new Set(), mcps: new Set(), hooks: new Set(), modules: new Set() };
}

interface MountOpts {
  /** 返回非 null 则 save 抛错(带该消息)—— 用来注入「某步失败」。 */
  failSave?: (payload: Record<string, unknown>) => string | null;
  /** 记录每次 save 的载荷(断言派发顺序/内容)。 */
  onSave?: (payload: Record<string, unknown>) => void;
  /** 返回非 null 则 remove 抛错 —— 用来注入「逆操作失败」。 */
  failRemove?: (id: string) => string | null;
  /** 记录每次 remove 的资源 id。 */
  onRemove?: (id: string) => void;
  /** 返回 true 则 save **成功返回但不在宿主里登记**(模拟「入口说成功、资源却没真建成」)。 */
  silentSave?: (payload: Record<string, unknown>) => boolean;
}

/**
 * 把「各服务」的 save / read / remove handler 挂上,背后是内存宿主 `host`。
 * 形状与生产各服务入口一致(save 收声明正文、read 按 id 查、remove 按 id 删)。
 */
function mountHost(host: Host, opts: MountOpts = {}): void {
  recordRpcHandler("workflow:save", (_e, raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    // onSave = 「这个入口**被派发到了**」的记录,先于注入的失败 —— 失败也要能证明"被调过"。
    opts.onSave?.(p);
    const fail = opts.failSave?.(p);
    if (fail) throw new Error(fail);
    const id = typeof p.id === "string" ? p.id : null;
    // silentSave:入口**返回成功**却不在宿主里登记(模拟"报成功但资源没真建成")—— 独立回读会
    // 据此判它不存在,证明验收的 observed 不是照抄部署记录里 done 的步。
    if (id !== null && !opts.silentSave?.(p)) host.workflows.set(id, p);
    return { ok: true };
  });
  recordRpcHandler("workflow:get", (_e, raw) => {
    const id = (raw as Record<string, unknown> | undefined)?.id;
    return { workflow: typeof id === "string" && host.workflows.has(id) ? { id } : null, revision: null, review: null };
  });
  recordRpcHandler("workflow:remove", (_e, raw) => {
    const id = String((raw as Record<string, unknown> | undefined)?.id ?? "");
    const fail = opts.failRemove?.(id);
    if (fail) throw new Error(fail);
    opts.onRemove?.(id);
    return { ok: host.workflows.delete(id), wasBuiltin: false };
  });
  recordRpcHandler("skills:save", (_e, raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const fail = opts.failSave?.(p);
    if (fail) throw new Error(fail);
    opts.onSave?.(p);
    if (typeof p.name === "string") host.skills.add(p.name);
    return { ok: true };
  });
  recordRpcHandler("skills:list", () => ({
    skills: [...host.skills].map((name) => ({ name, description: "", source: "global" })),
  }));
  // skills.delete 需要 source 才能定位 —— 本层不调它(逆操作标 null);这里也不注册。
  recordRpcHandler("mcp:save", (_e, raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const fail = opts.failSave?.(p);
    if (fail) throw new Error(fail);
    opts.onSave?.(p);
    if (typeof p.name === "string") host.mcps.add(p.name);
    return { ok: true };
  });
  recordRpcHandler("mcp:list", () => ({ servers: [...host.mcps].map((name) => ({ name, scope: "user", kind: "stdio", detail: "", enabled: true })) }));
  recordRpcHandler("mcp:remove", (_e, raw) => {
    const id = String((raw as Record<string, unknown> | undefined)?.name ?? "");
    const fail = opts.failRemove?.(id);
    if (fail) throw new Error(fail);
    opts.onRemove?.(id);
    return { ok: host.mcps.delete(id) };
  });
  recordRpcHandler("hooks:list", () => ({ hooks: [...host.hooks].map((id) => ({ id })), problems: [] }));
  recordRpcHandler("modules:catalog", () => ({ modules: [...host.modules].map((id) => ({ id })) }));
}

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

/**
 * 一条 workflow/automation 资源 —— 声明正文里带 `id`(= 场景资源 id,与 WorkflowDoc.id 同义),
 * 宿主据此登记/回读。资源 id 与声明正文的 `id` 一致才回读得到(这就是「按 id 独立回读」)。
 */
function wfRes(id: string, spec: Record<string, unknown> = {}, dependsOn?: string[]): SceneSpec["resources"][number] {
  return { kind: "workflow", id, spec: { id, ...spec }, ...(dependsOn ? { dependsOn } : {}) };
}
function autoRes(id: string, spec: Record<string, unknown> = {}, dependsOn?: string[]): SceneSpec["resources"][number] {
  return { kind: "automation", id, spec: { id, ...spec }, ...(dependsOn ? { dependsOn } : {}) };
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
      wfRes("wf", { name: "巡检" }),
      autoRes("auto", { cron: "0 9 * * *" }, ["wf"]),
    ],
    ["wf", "auto"],
  );
  let calls = 0;
  const host = newHost();
  mountHost(host, { onSave: () => { calls += 1; } });
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

/* ── 3. apply 成功:逐步派发、记录、验收(独立回读) ── */
console.log("\n③ apply:逐步派发 + 记录 + 独立回读验收");
{
  clearRpcHandlers();
  const host = newHost();
  const calls: Array<Record<string, unknown>> = [];
  mountHost(host, { onSave: (p) => calls.push(p) });
  const spec = checked(specWith(
    "happy_scene",
    [
      wfRes("wf", { name: "巡检" }),
      autoRes("auto", { cron: "0 9 * * *" }, ["wf"]),
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_happy", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 整体状态 ACTIVE(两步都成)", r.deployment.status, "active");
    check("两步都 done", r.deployment.steps.every((s) => s.status === "done"), r.deployment.steps);
    eq("★ 验收通过(独立回读到两条真实资源)", r.deployment.acceptance?.passed, true);
    eq("★ 验收 observed 取自回读 = 两条资源 id", (r.deployment.acceptance?.observed ?? []).join(","), "wf,auto");
    eq("★ apply 回传独立回读结果(两步都查得到)", r.readback.observed.join(","), "wf,auto");
    eq("部署记下发起者身份", r.deployment.actor.actorId, "sess_1");
  }
  eq("★ 既有服务被调两次(两条命令各一次)", calls.length, 2);
  check("★ 派发顺序 = 拓扑序(先工作流载荷、后触发器载荷)", calls[0]?.name !== undefined && calls[1]?.cron !== undefined, calls);
  check("★ 宿主里真的建成了这两条", host.workflows.has("wf") && host.workflows.has("auto"));
  // 逐步落盘:回读得到同一份。
  const back = loadDeployment("dep_happy");
  eq("★ 部署真落进 scene_deployments(回读得到)", back?.status, "active");
  eq("★ 回读的部署 id 对得上", back?.deploymentId, "dep_happy");
}

/* ── 4. ★ 一步失败 → PARTIAL(不是 ACTIVE)(不补偿路径) ── */
console.log("\n④ apply:一步失败 → 整体 PARTIAL,绝不报成 ACTIVE");
{
  clearRpcHandlers();
  const host = newHost();
  mountHost(host, { failSave: (p) => (p.cron !== undefined ? "cron 语法被拒(测试注入)" : null) });
  const spec = checked(specWith(
    "partial_scene",
    [
      wfRes("wf", { name: "巡检" }),
      autoRes("auto", { cron: "坏表达式" }, ["wf"]),
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  // 显式关掉补偿:本组测的是「不补偿时部分成功照实报 PARTIAL」。
  const r = await applyScene({ deploymentId: "dep_partial", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
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
  const host = newHost();
  let calls = 0;
  mountHost(host, { failSave: (p) => (p.cron !== undefined ? null : "建工作流失败(测试注入)"), onSave: () => { calls += 1; } });
  const spec = checked(specWith(
    "dep_scene",
    [
      wfRes("wf", { name: "巡检" }),
      autoRes("auto", { cron: "0 9 * * *" }, ["wf"]),
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_dep", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
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
  const host = newHost();
  mountHost(host);
  const spec = checked(specWith(
    "plugin_scene",
    [
      wfRes("wf", { name: "巡检" }),
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

  const r = await applyScene({ deploymentId: "dep_plugin", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
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
  const host = newHost();
  let calls = 0;
  mountHost(host, { onSave: () => { calls += 1; } });
  const spec = checked(specWith("auth_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
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
      [wfRes("wf", { name: "被偷改后的载荷" })],
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
  const host = newHost();
  let calls = 0;
  mountHost(host, { onSave: () => { calls += 1; } });
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

/* ── 9. ★★ 独立回读反映真实资源状态(带外删除 → 缺失 → 验收失败) ── */
console.log("\n⑨ 独立回读:资源被带外删掉 → 回读查不到 → 验收失败(不是照抄记录里的 done)");
{
  clearRpcHandlers();
  const host = newHost();
  mountHost(host);
  const spec = checked(specWith(
    "readback_scene",
    [wfRes("wf", { name: "巡检" })],
    ["wf"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_readback", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
  if (!r.ok || r.kind !== "applied") { /* 后面的断言会红 */ }
  else {
    eq("前置:记录里那步走到 done", r.deployment.steps[0]?.status, "done");
    eq("前置:初次回读验收通过", r.deployment.acceptance?.passed, true);

    // 带外删除:像用户/别的进程把这条工作流删了 —— 部署记录里那步仍是 done。
    host.workflows.delete("wf");

    // 独立回读:**重新查询宿主**,查不到了。
    const rb = await readbackScene(r.deployment, spec);
    eq("★ 回读 observed 为空(宿主里已没有这条)", rb.observed.length, 0);
    eq("★ 部署记录里那步仍是 done(记录没变)", r.deployment.steps[0]?.status, "done");

    // 重新验收:observed 空了 → 不通过(若照抄记录里 done 的步,这里会假绿)。
    const reAccepted = evaluateAcceptance(r.deployment, spec.acceptance.expectResourceIds, rb.observed, 9999);
    eq("★★ 带外删除后验收不通过(观察值取自真实资源,不是记录)", reAccepted.acceptance?.passed, false);
    eq("★ 缺的那条资源列进 missing", (reAccepted.acceptance?.missing ?? []).join(","), "wf");
  }
}

/* ── 10. ★★ 中途失败 → 补偿之前已建成、可补偿的步(不留孤儿) ── */
console.log("\n⑩ 补偿:一步失败 → 逆序撤销前面已建成、可补偿的步(失败不留孤儿)");
{
  clearRpcHandlers();
  const host = newHost();
  const removed: string[] = [];
  mountHost(host, {
    failSave: (p) => (p.cron !== undefined ? "触发器建不起来(测试注入)" : null),
    onRemove: (id) => removed.push(id),
  });
  const spec = checked(specWith(
    "compensate_scene",
    [
      wfRes("wf", { name: "巡检" }),
      autoRes("auto", { cron: "坏表达式" }, ["wf"]),
    ],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_compensate", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    const wfStep = r.deployment.steps.find((s) => s.actionId === "wf");
    const autoStep = r.deployment.steps.find((s) => s.actionId === "auto");
    eq("触发步失败", autoStep?.status, "failed");
    eq("★ 已建成的工作流步被补偿(状态 compensated)", wfStep?.status, "compensated");
    eq("★ 补偿记下逆操作入口", wfStep?.compensation?.inverseLabel, "workflow.remove");
    eq("★ 补偿 applied=true", wfStep?.compensation?.applied, true);
    eq("★ 逆操作真的被调一次", removed.join(","), "wf");
    check("★ 宿主里的孤儿被清掉(workflow 没了)", !host.workflows.has("wf"));
    eq("★ 全被补偿(没留下资源)→ 整体 FAILED(不是 partial、更不是 active)", r.deployment.status, "failed");
    eq("★ 补偿后独立回读也查不到", r.readback.observed.includes("wf"), false);

    // 补偿结果**落盘**(解码器要认 `compensated` 状态与 `compensation` 字段)—— 回读同一份。
    const back = loadDeployment("dep_compensate");
    const backWf = back?.steps.find((s) => s.actionId === "wf");
    eq("★ 落盘的补偿步仍是 compensated(解码器认这个状态)", backWf?.status, "compensated");
    eq("★ 落盘的补偿记录保留逆操作入口", backWf?.compensation?.inverseLabel, "workflow.remove");
    eq("★ 落盘整体仍 FAILED(重算不回落)", back?.status, "failed");
  }
}

/* ── 11. ★★ 不可补偿 / 无逆操作的步:如实记「未补偿 + 原因」,不静默 ── */
console.log("\n⑪ 补偿:不可补偿 / 无逆操作 → 如实记未补偿(不静默、不猜入口乱删)");
{
  // 11a. 声明 compensable=false 的步:失败触发补偿时**不撤销**,记原因,资源留着。
  {
    clearRpcHandlers();
    const host = newHost();
    const removed: string[] = [];
    mountHost(host, { failSave: (p) => (p.cron !== undefined ? "触发器建不起来(测试注入)" : null), onRemove: (id) => removed.push(id) });
    const spec = checked(specWith(
      "noncomp_scene",
      [
        { kind: "workflow", id: "wf", spec: { id: "wf", name: "巡检", compensable: false } },
        autoRes("auto", { cron: "坏表达式" }, ["wf"]),
      ],
      ["wf", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_noncomp", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf");
      eq("★ 不可补偿的步保持 done(未被撤销)", wfStep?.status, "done");
      eq("★ 补偿 applied=false", wfStep?.compensation?.applied, false);
      check("★ 记下「不可补偿」的原因(不静默)", (wfStep?.compensation?.reason ?? "").includes("不可补偿"), wfStep?.compensation);
      eq("★ 逆操作一次都没调", removed.length, 0);
      check("★ 资源仍留在宿主(如实留下,不假撤销)", host.workflows.has("wf"));
    } else {
      check("apply 应返回 applied", false, r);
    }
  }

  // 11b. 无稳妥逆操作的 kind(skill:skills.delete 还要 source):同样如实记,不猜入口。
  {
    clearRpcHandlers();
    const host = newHost();
    const removed: string[] = [];
    mountHost(host, { failSave: (p) => (p.cron !== undefined ? "触发器建不起来(测试注入)" : null), onRemove: (id) => removed.push(id) });
    const spec = checked(specWith(
      "noinverse_scene",
      [
        { kind: "skill", id: "sk", spec: { name: "sk", content: "---\nname: sk\n---\n" } },
        autoRes("auto", { cron: "坏表达式" }, ["sk"]),
      ],
      ["sk", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_noinverse", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    if (r.ok && r.kind === "applied") {
      const skStep = r.deployment.steps.find((s) => s.actionId === "sk");
      eq("★ 无逆操作的步保持 done(未被撤销)", skStep?.status, "done");
      eq("★ 补偿 applied=false", skStep?.compensation?.applied, false);
      check("★ 记下「无稳妥逆操作」的原因(不静默)", (skStep?.compensation?.reason ?? "").includes("逆操作"), skStep?.compensation);
      eq("★ 没有乱猜一个删除入口去调", removed.length, 0);
      check("★ 技能仍在宿主里", host.skills.has("sk"));
    } else {
      check("apply 应返回 applied", false, r);
    }
  }

  // 11c. 逆操作**执行失败**:保守保留资源、记下真实错误(不假报已撤销)。
  {
    clearRpcHandlers();
    const host = newHost();
    mountHost(host, {
      failSave: (p) => (p.cron !== undefined ? "触发器建不起来(测试注入)" : null),
      failRemove: () => "删工作流被拒(测试注入)",
    });
    const spec = checked(specWith(
      "failremove_scene",
      [wfRes("wf", { name: "巡检" }), autoRes("auto", { cron: "坏表达式" }, ["wf"])],
      ["wf", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_failremove", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf");
      eq("★ 逆操作失败 → 该步保持 done(保守,不假报已撤)", wfStep?.status, "done");
      eq("★ 补偿 applied=false", wfStep?.compensation?.applied, false);
      check("★ 记下逆操作的真实错误", (wfStep?.compensation?.reason ?? "").includes("删工作流被拒"), wfStep?.compensation);
      check("★ 资源仍在(没被删掉)", host.workflows.has("wf"));
    } else {
      check("apply 应返回 applied", false, r);
    }
  }
}

/* ── 12. ★★ 收尾验收取自独立回读(不是记录里 done 的步) ── */
console.log("\n⑫ 收尾验收:入口报成功、资源却没真建成 → 记录 done,但验收按回读判失败");
{
  clearRpcHandlers();
  const host = newHost();
  // 工作流 save 返回 `{ok:true}` 却不登记到宿主 —— 记录里那步会走到 done。
  mountHost(host, { silentSave: (p) => p.id === "wf" });
  const spec = checked(specWith("silentsave_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
  const plan = compileScenePlan(spec);
  const r = await applyScene({ deploymentId: "dep_silentsave", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("apply 返回 applied(入口没抛)", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("记录里那步走到 done(入口报成功)", r.deployment.steps[0]?.status, "done");
    check("宿主里其实没有这条资源(入口没真建成)", !host.workflows.has("wf"));
    // ★★ 承重:若验收照抄「记录里 done 的步」→ passed=true(假绿);取自独立回读 → passed=false。
    eq("★★ 验收不通过(回读查不到,没照抄记录里 done 的步)", r.deployment.acceptance?.passed, false);
    eq("★ 缺的这条列进 missing", (r.deployment.acceptance?.missing ?? []).join(","), "wf");
    eq("★ 回读 observed 为空", r.readback.observed.length, 0);
  }
}

closeDb();

console.log(`\nscene-apply-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
