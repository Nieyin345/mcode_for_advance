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
 *
 * ⚠️ **形状就是各服务真实 RPC 入参**(不是声明正文):`applyScene` 派发的是投影后的 `rpcInput`
 * (MC-058)。所以 `workflow:save` 收到的是 `{ workflow: WorkflowDoc, expectedRevision? }`,资源 id
 * 在 `workflow.id` 里 —— 与生产 handler `WorkflowSaveSchema.parse(raw)` 同形。
 */
function mountHost(host: Host, opts: MountOpts = {}): void {
  recordRpcHandler("workflow:save", (_e, raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    // onSave = 「这个入口**被派发到了**」的记录,先于注入的失败 —— 失败也要能证明"被调过"。
    opts.onSave?.(p);
    const fail = opts.failSave?.(p);
    if (fail) throw new Error(fail);
    const wf = p.workflow as Record<string, unknown> | undefined;
    const id = wf !== undefined && typeof wf.id === "string" ? wf.id : null;
    // silentSave:入口**返回成功**却不在宿主里登记(模拟"报成功但资源没真建成")—— 独立回读会
    // 据此判它不存在,证明验收的 observed 不是照抄部署记录里 done 的步。
    if (id !== null && !opts.silentSave?.(p)) host.workflows.set(id, wf as Record<string, unknown>);
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
 * 一条 workflow/automation 资源的**声明正文** —— 现在必须是**真实 WorkflowDoc**(含 id/name/
 * nodes/edges/builtin/updatedAt),因为派发前要过 `WorkflowSaveSchema`(MC-058 的载荷适配)。
 * 资源 id 与 doc.id 一致才回读得到(这就是「按 id 独立回读」)。
 */
function wfDoc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, nodes: [], edges: [], builtin: false, updatedAt: 1, ...extra };
}
function wfRes(id: string, spec: Record<string, unknown> = {}, dependsOn?: string[]): SceneSpec["resources"][number] {
  return { kind: "workflow", id, spec: wfDoc(id, spec), ...(dependsOn ? { dependsOn } : {}) };
}
function autoRes(id: string, spec: Record<string, unknown> = {}, dependsOn?: string[]): SceneSpec["resources"][number] {
  // 自动化 = **带 trigger 的** WorkflowDoc(见 @contracts/workflow 文件头)。`trigger` 是真实
  // WorkflowDoc 字段,会**穿过** zod 投影存活到派发入参里 —— 故用它当「这一步是不是自动化」的判据。
  return { kind: "automation", id, spec: wfDoc(id, { trigger: "schedule", ...spec }), ...(dependsOn ? { dependsOn } : {}) };
}

/** 校验后的 spec(前置断言,不合法直接抛,免得后面测的是坏输入)。 */
function checked(raw: SceneSpec): SceneSpec {
  const r = validateSceneSpec(raw);
  if (!r.ok) throw new Error("前置场景不合法:" + JSON.stringify(r.problems));
  return r.spec;
}

/** 一次 `workflow:save` 派发的入参里,那份 WorkflowDoc(适配器把裸声明包成 `{ workflow }`)。 */
function docOf(p: Record<string, unknown>): Record<string, unknown> {
  return (p.workflow ?? {}) as Record<string, unknown>;
}
/** 这条派发是不是「自动化」那一步(它的 WorkflowDoc 带 trigger;工作流那步不带)。 */
function isAutoPayload(p: Record<string, unknown>): boolean {
  return docOf(p).trigger !== undefined;
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
  check("★ 派发顺序 = 拓扑序,且派发的是**投影后**的入参(先工作流 {workflow}、后触发器 {workflow:cron})", docOf(calls[0] ?? {}).name !== undefined && isAutoPayload(calls[1] ?? {}), calls);
  check("★ 派发的确是 { workflow, ... } 形状(不是裸声明)", calls[0]?.workflow !== undefined, calls[0]);
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
  mountHost(host, { failSave: (p) => (isAutoPayload(p) ? "cron 语法被拒(测试注入)" : null) });
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
  mountHost(host, { failSave: (p) => (isAutoPayload(p) ? null : "建工作流失败(测试注入)"), onSave: () => { calls += 1; } });
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
    failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
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
    mountHost(host, { failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null), onRemove: (id) => removed.push(id) });
    const spec = checked(specWith(
      "noncomp_scene",
      [
        // 可补偿性来自**声明正文**的 `compensable`(scene 层字段,投影时被 schema strip 掉,不进 RPC)。
        wfRes("wf", { compensable: false }),
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
    mountHost(host, { failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null), onRemove: (id) => removed.push(id) });
    const spec = checked(specWith(
      "noinverse_scene",
      [
        { kind: "skill", id: "sk", spec: { source: "global", name: "sk", content: "---\nname: sk\n---\n" } },
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
      failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
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
  mountHost(host, { silentSave: (p) => docOf(p).id === "wf" });
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

/* ── 13. ★★ 载荷适配:派发的是**投影后**入参;声明填不全 → 记 failed、不派发半成品(MC-058) ── */
console.log("\n⑬ 载荷适配:派发投影后入参;缺字段 → 明确不执行(不派发会被 Schema 拒的半成品)");
{
  // 13a. ★★ 承重:声明正文**不是** RPC 入参形状(name-only)时,若照旧逐字派发,真实 handler 会
  //      在 Schema.parse 处拒。这里让 handler 就**按真实契约**判(缺 workflow 直接抛)—— 证明层没漏。
  {
    clearRpcHandlers();
    const host = newHost();
    const calls: Array<Record<string, unknown>> = [];
    // 这个 handler 复刻生产 `WorkflowSaveSchema` 的形状要求:必须 `{ workflow:{id,...} }`,否则抛。
    recordRpcHandler("workflow:save", (_e, raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      calls.push(p);
      const wf = p.workflow as Record<string, unknown> | undefined;
      if (wf === undefined || typeof wf.id !== "string" || typeof wf.name !== "string") {
        throw new Error("workflow.save:入参缺 workflow(真实 WorkflowSaveSchema 会拒)");
      }
      host.workflows.set(wf.id, wf);
      return { ok: true };
    });
    recordRpcHandler("workflow:get", (_e, raw) => ({
      workflow: typeof (raw as Record<string, unknown> | undefined)?.id === "string" && host.workflows.has(String((raw as Record<string, unknown>).id)) ? { id: (raw as Record<string, unknown>).id } : null,
      revision: null,
      review: null,
    }));
    // 声明正文给**真实 WorkflowDoc** → 适配器包成 { workflow } → handler 收下。
    const spec = checked(specWith("adapt_scene", [wfRes("wf", { name: "巡检工作流" })], ["wf"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_adapt", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("★ 工作流步 done(投影后入参被真实形状的 handler 收下)", r.deployment.steps[0]?.status, "done");
      eq("★ 整体 ACTIVE", r.deployment.status, "active");
      eq("★ 验收通过", r.deployment.acceptance?.passed, true);
    }
    eq("★ handler 被调一次", calls.length, 1);
    check("★ 派发的入参是 { workflow:{id,name,...} } 形状(不是裸 {name})", calls[0]?.workflow !== undefined && (calls[0].workflow as Record<string, unknown>).id === "wf", calls);
    check("★ 宿主里真的建成了(证明派发形状真被真实契约接受)", host.workflows.has("wf"));
  }

  // 13b. ★★ 承重:声明**缺必需字段** → 该步记 failed、**handler 一次都不被调**(不派发半成品)。
  {
    clearRpcHandlers();
    const host = newHost();
    let calls = 0;
    mountHost(host, { onSave: () => { calls += 1; } });
    // workflow 只给 name(缺 WorkflowDoc 必需字段)→ 投影失败 → 不派发。
    const spec = checked(specWith("missing_scene", [{ kind: "workflow", id: "wf", spec: { name: "只有名字" } }], ["wf"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_missing", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied(执行过,只是没成)", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("★ 缺必需字段的步记为 failed", r.deployment.steps[0]?.status, "failed");
      check("★ 失败原因说明缺该服务真实入参的必需字段(不静默、不派发半成品)", (r.deployment.steps[0]?.error ?? "").includes("真实入参") && (r.deployment.steps[0]?.error ?? "").includes("未执行"), r.deployment.steps[0]?.error);
      eq("★ 整体 FAILED(没有资源被建)", r.deployment.status, "failed");
      eq("★ 验收不通过", r.deployment.acceptance?.passed, false);
    }
    eq("★★ 缺字段的步**一次都没派发**(handler 未被调)", calls, 0);
  }

  // 13c. dry-run 也要如实预判:缺字段的步静态判定**不会跑**并给出原因。
  {
    clearRpcHandlers();
    const spec = specWith("dry_missing_scene", [{ kind: "skill", id: "sk", spec: { name: "cov", content: "x" } }], ["sk"]);
    const dry = dryRunScene(spec);
    check("dry-run 通过(声明形状自洽)", dry.ok === true, dry);
    if (dry.ok) {
      eq("★ 缺 source 的 skill 步静态判定不会跑", dry.steps[0]?.willRun, false);
      check("★ 给出「缺必需字段」的原因(不静默)", (dry.steps[0]?.notAppliedReason ?? "").includes("必需字段"), dry.steps[0]);
      check("★ dry-run 带出投影问题清单", (dry.steps[0]?.payloadProblems.length ?? 0) > 0, dry.steps[0]?.payloadProblems);
    }
  }
}

/* ── 14. ★★ 补偿安全闸:覆盖既有资源 → **绝不打删除**;本次新建 → 才撤(MC-058 危险修复) ── */
console.log("\n⑭ 补偿安全闸:覆盖既有资源失败后**不删除**既有;本次新建的才撤");
{
  /** 带修订号的宿主(save 递增修订号;get 回读 workflow + 当前修订号)—— 用来验「覆盖 vs 新建」判据与 CAS。 */
  interface RHost {
    workflows: Map<string, Record<string, unknown>>;
    rev: Map<string, string>;
    seq: number;
    removed: string[];
  }
  const makeRHost = (): RHost => ({ workflows: new Map(), rev: new Map(), seq: 0, removed: [] });
  /** 挂上按**真实形状**(`{workflow}`)收的 save / 按 id 回读(get) / 删除(remove)。 */
  const mountRHost = (
    h: RHost,
    opts: { failSave?: (p: Record<string, unknown>) => string | null; onFail?: () => void } = {},
  ): void => {
    recordRpcHandler("workflow:save", (_e, raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      const wf = p.workflow as Record<string, unknown> | undefined;
      if (wf === undefined || typeof wf.id !== "string" || typeof wf.name !== "string") {
        throw new Error("workflow.save:入参缺 workflow(真实 WorkflowSaveSchema 会拒)");
      }
      const fail = opts.failSave?.(p);
      if (fail) { opts.onFail?.(); throw new Error(fail); } // 失败也先按需改动宿主(模拟并发写者),再抛。
      const id = String(wf.id);
      h.seq += 1;
      h.workflows.set(id, wf);
      h.rev.set(id, `rev${h.seq}`);
      return { ok: true };
    });
    recordRpcHandler("workflow:get", (_e, raw) => {
      const id = String((raw as Record<string, unknown> | undefined)?.id ?? "");
      const present = h.workflows.has(id);
      return { workflow: present ? { id } : null, revision: present ? (h.rev.get(id) ?? null) : null, review: null };
    });
    recordRpcHandler("workflow:remove", (_e, raw) => {
      const id = String((raw as Record<string, unknown> | undefined)?.id ?? "");
      h.removed.push(id);
      h.workflows.delete(id);
      h.rev.delete(id);
      return { ok: true, wasBuiltin: false };
    });
  };

  // 14a. ★★ 承重:覆盖**部署前已存在**的用户工作流 → 失败后补偿**不删除它**(用户数据幸存)。
  //      这正是复审复现的危险:旧代码会 `workflow.remove({id})` 把用户原有 wf 整个删掉。
  {
    clearRpcHandlers();
    const h = makeRHost();
    // 部署前:用户已有一条 "wf_prior"(带它的原有内容)。
    h.workflows.set("wf_prior", { id: "wf_prior", name: "用户原有的巡检", nodes: [{ id: "n0" }], edges: [], builtin: false, updatedAt: 111 });
    h.rev.set("wf_prior", "rev_user_orig");
    const hadOldAtStart = h.workflows.has("wf_prior");
    mountRHost(h, { failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null) });
    const spec = checked(specWith(
      "overwrite_scene",
      [wfRes("wf_prior", { name: "被场景覆盖后的名字" }), autoRes("auto", { cron: "坏表达式" }, ["wf_prior"])],
      ["wf_prior", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_overwrite", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf_prior");
      const autoStep = r.deployment.steps.find((s) => s.actionId === "auto");
      eq("前置:开始时就存在那条用户工作流", hadOldAtStart, true);
      eq("触发步失败", autoStep?.status, "failed");
      // ★★ 承重:既有资源**必须幸存** —— 补偿不许把它删掉。
      check("★★ 覆盖的**既有工作流幸存**(补偿没删它)", h.workflows.has("wf_prior"));
      eq("★★ 逆操作一次都没对既有资源调(没删)", h.removed.includes("wf_prior"), false);
      // 该步保持 done(资源还在),补偿如实记 applied:false + 原因(不静默)。
      eq("★ 该步保持 done(既有资源未被撤)", wfStep?.status, "done");
      eq("★ 补偿 applied=false(不删除)", wfStep?.compensation?.applied, false);
      check("★ 记下「覆盖了既有资源故不删除」的原因(不静默)", (wfStep?.compensation?.reason ?? "").includes("不删除") && (wfStep?.compensation?.reason ?? "").includes("已存在"), wfStep?.compensation);
      eq("★ 派发前探测记录为 preExisting", wfStep?.priorExistence, "preExisting");
      eq("★ 整体状态 PARTIAL(既有资源还在、触发器没建成)", r.deployment.status, "partial");
      // 落盘也带着 priorExistence(解码器认这三个字段)。
      const backWf = loadDeployment("dep_overwrite")?.steps.find((s) => s.actionId === "wf_prior");
      eq("★ 落盘的步保留 priorExistence=preExisting", backWf?.priorExistence, "preExisting");
    }
  }

  // 14b. ★★ 承重:本次**新建**的资源 → 失败后补偿**真的撤销它**(反之亦须成立,别因噎废食)。
  {
    clearRpcHandlers();
    const h = makeRHost();
    mountRHost(h, { failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null) });
    const spec = checked(specWith(
      "create_scene",
      [wfRes("wf_new", { name: "本次新建的巡检" }), autoRes("auto", { cron: "坏表达式" }, ["wf_new"])],
      ["wf_new", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_create", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf_new");
      eq("★ 派发前探测记录为 created(本次新建)", wfStep?.priorExistence, "created");
      eq("★ 本次新建的步被补偿(状态 compensated)", wfStep?.status, "compensated");
      eq("★ 补偿 applied=true", wfStep?.compensation?.applied, true);
      check("★ 逆操作真的删了本次新建的资源", h.removed.includes("wf_new"));
      check("★ 宿主里本次新建的资源被清掉", !h.workflows.has("wf_new"));
      eq("★ 全被补偿 → 整体 FAILED", r.deployment.status, "failed");
    }
  }

  // 14c. ★ CAS:本次新建、但建成后**被别的写者改过**(修订号变了)→ 补偿**不删除**(免毁后来改动)。
  {
    clearRpcHandlers();
    const h = makeRHost();
    // 失败那一步被派发时,把先前建成的 "wf_cas" 修订号改掉(模拟建成后被并发写者改过),再抛。
    mountRHost(h, {
      failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
      onFail: () => { if (h.workflows.has("wf_cas")) h.rev.set("wf_cas", "rev_changed_by_other_writer"); },
    });
    const spec = checked(specWith(
      "cas_scene",
      [wfRes("wf_cas", { name: "巡检" }), autoRes("auto", { cron: "坏表达式" }, ["wf_cas"])],
      ["wf_cas", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_cas", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf_cas");
      eq("前置:派发前是本次新建(created)", wfStep?.priorExistence, "created");
      // ★ 建后被改过 → CAS 不匹配 → 不删除,如实记原因。
      check("★ 建成后被改动 → 补偿**不删除**", h.workflows.has("wf_cas"));
      eq("★ 该步保持 done(未被撤)", wfStep?.status, "done");
      eq("★ 补偿 applied=false(CAS 不匹配)", wfStep?.compensation?.applied, false);
      check("★ 记下「建成后已被改动故不删」的原因(不静默)", (wfStep?.compensation?.reason ?? "").includes("改动"), wfStep?.compensation);
    }
  }
}

closeDb();

console.log(`\nscene-apply-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);