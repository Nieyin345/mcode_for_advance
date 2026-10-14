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
import { initDb, closeDb, getDb, commitNow } from "@main/store/db.js";
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import { evaluateAcceptance } from "@contracts/sceneDeployment";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
import type { Grant } from "@contracts/policyEngine";
import type { SceneDeploymentActor, SceneDeployment } from "@contracts/sceneDeployment";
import {
  dryRunScene,
  applyScene,
  readbackScene,
  approveSceneDeployment,
  applySceneWithGrant,
  resumeScene,
  resumeSceneWithGrant,
  SCENE_APPLY_METHOD,
} from "@main/appServices/sceneDeploy.js";
import { setGrantStore, assembleGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { GrantStore } from "@main/appControl/grantStore.js";
import { loadDeployment, decodeDeployment } from "@main/appServices/sceneDeploymentStore.js";
// ★ MC-058 / ARC-002 崩溃—重启—续跑(**真跨进程**,不是同进程模拟):起真子进程 + 磁盘上的
//   宿主快照 / 调用日志(内存不跨进程,跨进程事实必须落盘才能核对)。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { dataRoot, DATA_DB_FILENAME } from "@main/lib/dataRoot.js";

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

/* ═══════════════════════════════════════════════════════════════════════════════
 * ★★ MC-058 / ARC-002 崩溃 → 重启 → 续跑 → 验证(**真跨进程**,不是同进程模拟)
 *
 * 上面 ⑱⑲⑳ 测 resumeScene / resumeSceneWithGrant 的判据,但**全在同一进程内** —— DB 一直
 * 开着,`loadDeployment` 读的是同一个连接。复审要的是**真的崩了再起来**:一个进程写到一半
 * **被杀**,另一个**全新进程**读回盘上那份半成品、跳过已建成、只跑剩下的。
 *
 * ## 怎么搭(三段)
 *
 *  - **父进程**(本文件,非 crash/restart 模式)编排:`spawn(node, [自己, "crash"])` 起一个真子进程;
 *    子进程里真发生 `SIGKILL(self)`(证明它**没跑完**);父进程再 `spawn(node, [自己, "restart"])`
 *    起第二个真进程续跑;最后父进程按 **磁盘上的宿主快照**(子进程每步 save 后写下的 host.json)
 *    与**另开句柄读 mcode.db** 做独立验证。
 *  - **子进程**(同一个 bundle,靠 `process.argv[2]` 分模式)各自 `initDb()` —— 各自的 sql.js 内存库
 *    独立,但**同一个 `MCODE_SMOKE_DATA_ROOT`**(临时目录),于是盘上 `mcode.db` / `host.json` /
 *    `grant.json` / `calls.log` 都是那**同一份**跨进程共享的事实。走**落盘版** `GrantStore`
 *    (`assembleGrantStore`),否则新进程读不回上一步签的授权(`findBoundFor` 找不到 → 莫名 no_grant)。
 *  - **宿主快照**:上面各节的服务 handler 后面是内存 `Map`;内存不跨进程,所以本节的 handler 每步
 *    save 后把宿主序列化到 `<dataRoot>/host.json`。子进程启动时读它 —— 于是「宿主里真的建成了什么」
 *    在两个进程之间是**同一份可核对的磁盘事实**。
 *
 * ## 「已建成的步没被重跑」的证据(不是记录里的状态)
 *
 * 每个进程每次派发都往 `<dataRoot>/calls.log` **追加一行**资源 id(append-only,跨进程累积)。
 * 「续跑没重跑已建成的工作流」= 那一步的 id 在 calls.log 里**恰好出现一次**(总调用 3 行 =
 * wf 1 + auto 2),而**不是**看部署记录里那步是不是 done(记录本来就在盘上,不证明没重跑)。
 *
 * ## 安全前提(与 run.sh 同一条,不放松)
 *
 * 子进程继承父进程的 `MCODE_SMOKE_DATA_ROOT`(=run.sh 的 mktemp 临时目录);`initDb()` 在路径不存在时
 * 会新建空库,**指错地方等于毁用户数据**。三个进程指向**同一个**临时目录,才不会读到彼此没写的库。
 * ═══════════════════════════════════════════════════════════════════════════════ */

const SMOKE_MODE = process.argv[2] ?? "";
const CRASH_SCENE = "crash_resume_scene";
const CRASH_DEPLOY = "dep_crash_resume";
const CRASH_WF = "wf_crash";
const CRASH_AUTO = "auto_crash";

/** 本节那份场景声明(工作流 + 依赖它的自动化)。三处 spec 逐字相同,重编译出的 digest 才一致,
 *  `resumeScene` 的「plan digest 必须与盘上那份一致」那道闸才放行。 */
function crashSpec(): SceneSpec {
  return checked(specWith(
    CRASH_SCENE,
    [wfRes(CRASH_WF, { name: "巡检" }), autoRes(CRASH_AUTO, { cron: "0 9 * * *" }, [CRASH_WF])],
    [CRASH_WF, CRASH_AUTO],
  ));
}

function hostFile(): string { return join(dataRoot(), "host.json"); }
function callsFile(): string { return join(dataRoot(), "calls.log"); }
function grantFile(): string { return join(dataRoot(), "grant.json"); }
function survivedFile(): string { return join(dataRoot(), "CRASH_SURVIVED"); }
function restartResultFile(): string { return join(dataRoot(), "restart-result.json"); }
function existsFile(f: string): boolean { try { readFileSync(f); return true; } catch { return false; } }

/** 读共享的宿主快照(不存在 = 空宿主)。子进程启动时读盘,把**内存里没有**的宿主状态补回来。 */
function loadHost(): Host {
  const h = newHost();
  try {
    const raw = JSON.parse(readFileSync(hostFile(), "utf8")) as { workflows?: Record<string, Record<string, unknown>> };
    for (const [id, doc] of Object.entries(raw.workflows ?? {})) h.workflows.set(id, doc);
  } catch { /* 没有快照 = 空宿主(第一个进程第一次跑) */ }
  return h;
}
function saveHost(h: Host): void {
  writeFileSync(hostFile(), JSON.stringify({ workflows: Object.fromEntries(h.workflows) }), "utf8");
}
/** append-only 调用日志:**跨进程累积**,是「某一步到底被派发了几次」的唯一判据。 */
function logCall(id: string): void { writeFileSync(callsFile(), id + "\n", { flag: "a" }); }
function readCalls(): string[] {
  try { return readFileSync(callsFile(), "utf8").split("\n").filter((s) => s !== ""); } catch { return []; }
}

/**
 * 挂本节的「可跨进程」服务:每次 `workflow:save` 先 append 一行调用记录(失败也记 —— 要能证明
 * 这一步**被派发过**),再按注入开关决定抛不抛;成功则更新内存宿主**并落盘** host.json。
 * 形状与上面 `mountHost` 同(收 `{workflow}`、回读 `{workflow,revision}`)。
 */
function mountCrossProcessHost(host: Host, autoFails: () => boolean): void {
  recordRpcHandler("workflow:save", (_e, raw) => {
    const wf = (raw as Record<string, unknown> | undefined)?.workflow as Record<string, unknown> | undefined;
    if (wf === undefined || typeof wf.id !== "string" || typeof wf.name !== "string") {
      throw new Error("workflow.save:入参缺 workflow(真实 WorkflowSaveSchema 会拒)");
    }
    logCall(wf.id); // 「这个入口被派发到了」——失败也要能证明被调过。
    if (autoFails() && wf.trigger !== undefined) throw new Error("触发器建不起来(测试注入,模拟崩溃前失败)");
    host.workflows.set(wf.id, wf);
    saveHost(host);
    return { ok: true };
  });
  recordRpcHandler("workflow:get", (_e, raw) => {
    const id = (raw as Record<string, unknown> | undefined)?.id;
    const present = typeof id === "string" && host.workflows.has(id);
    return { workflow: present ? { id } : null, revision: null, review: null };
  });
  recordRpcHandler("workflow:remove", (_e, raw) => {
    const id = String((raw as Record<string, unknown> | undefined)?.id ?? "");
    host.workflows.delete(id);
    saveHost(host);
    return { ok: true, wasBuiltin: false };
  });
}

/**
 * **子进程**(同一个 bundle,靠 `process.argv[2]` = `crash` / `restart` 分模式)。两个子进程各自
 * `initDb()` —— 各自的 sql.js **内存库**独立,但**同一个** `MCODE_SMOKE_DATA_ROOT`(run.sh 的临时
 * 目录,经环境变量继承),于是盘上 `mcode.db` / `host.json` / `grant.json` / `calls.log` 都是那**同一份**
 * 跨进程共享的事实。走**落盘版** `GrantStore`(`assembleGrantStore`),否则新进程读不回上一步签的授权。
 */
async function runChild(mode: string): Promise<void> {
  assembleGrantStore(dataRoot());
  await initDb();
  clearRpcHandlers();

  if (mode === "crash") {
    // ① 校验(不合法则在这里抛,进程非零退出,父进程会看到)→ ② 申请计划级授权(落盘) → ③ 部署。
    const spec = crashSpec();
    const plan = compileScenePlan(spec);
    const approved = approveSceneDeployment({ spec, planDigest: plan.digest, ttlMs: 60_000 });
    if (!(approved.ok && approved.kind === "granted")) throw new Error("crash 子进程:签授权失败 " + JSON.stringify(approved));
    writeFileSync(grantFile(), approved.grantId, "utf8");

    const host = loadHost();
    mountCrossProcessHost(host, () => true); // 触发器一步恒失败
    // 补偿**关掉**:要的是一份「工作流 done、触发器 failed」的半成品留在盘上(与 ⑱ 的起点同一形状,
    // 只是这一份真的跨进程)。
    const r = await applySceneWithGrant({
      deploymentId: CRASH_DEPLOY, grantId: approved.grantId, spec, actor: ACTOR, compensateOnFailure: false,
    });
    if (!(r.ok && r.kind === "applied")) throw new Error("crash 子进程:半部署未返回 applied " + JSON.stringify(r));

    // ★ 模拟**进程被杀**。下面那行「幸存标记」若被写出来,说明 kill 没生效 —— 父进程据此证明
    //   这个进程**真的死在第③步之后**,而不是跑到了正常结尾。
    process.kill(process.pid, "SIGKILL");
    writeFileSync(survivedFile(), "进程没有真的死掉(kill 未生效)", "utf8");
    return;
  }

  if (mode === "restart") {
    // 全新进程:内存里**什么都没有**(下面两条前置断言就是钉这个)。
    const freshHost = newHost();
    // ① 盘上那份半成品记录**读得回来** —— 它来自磁盘的 mcode.db,不是本进程内存。
    const record = loadDeployment(CRASH_DEPLOY);
    // ② 内存宿主此刻是**空的**(新起的进程);host.json 里才有上一步建成的 wf。
    const diskHost = loadHost();
    const grantId = readFileSync(grantFile(), "utf8").trim();

    const spec = crashSpec();
    mountCrossProcessHost(diskHost, () => false); // 这次触发器一步会成功
    const r = await resumeSceneWithGrant({
      deploymentId: CRASH_DEPLOY, grantId, spec, actor: ACTOR,
    });
    writeFileSync(restartResultFile(), JSON.stringify({
      recordBefore: record === null ? null : { status: record.status, wf: record.steps.find((s) => s.actionId === CRASH_WF)?.status, auto: record.steps.find((s) => s.actionId === CRASH_AUTO)?.status },
      freshHostHasWf: freshHost.workflows.has(CRASH_WF),
      diskHostHasWf: diskHost.workflows.has(CRASH_WF),
      result: r.ok && r.kind === "applied" ? { status: r.deployment.status, passed: r.deployment.acceptance?.passed ?? null, steps: r.deployment.steps.map((s) => `${s.actionId}:${s.status}`) } : { error: JSON.stringify(r) },
    }), "utf8");
    return;
  }
}

/** 父进程侧:起一个真子进程跑某个模式,收齐它的退出码与输出。 */
function spawnChild(mode: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const script = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [script, mode], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 父进程侧**独立回读**盘上的部署记录(另开一个 sql.js 句柄读 mcode.db,不看任何内存)。 */
async function diskDeployment(id: string): Promise<SceneDeployment | null> {
  const SQL = await initSqlJs();
  let copy: InstanceType<typeof SQL.Database>;
  try { copy = new SQL.Database(readFileSync(join(dataRoot(), DATA_DB_FILENAME))); }
  catch { return null; }
  try {
    const stmt = copy.prepare("SELECT payload FROM scene_deployments WHERE deployment_id = ?");
    stmt.bind([id]);
    const payload = stmt.step() ? String(stmt.getAsObject().payload) : null;
    stmt.free();
    return payload ? decodeDeployment(payload) : null;
  } catch { return null; } finally { copy.close(); }
}

// ── 子进程早退:crash / restart 只跑 runChild,**绝不**落到下面那整段 smoke ──
// 否则子进程会把整段 smoke 的行也写进共享的 mcode.db,污染跨进程证据。
if (SMOKE_MODE === "crash" || SMOKE_MODE === "restart") {
  await runChild(SMOKE_MODE);
  process.exit(0);
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

/* ── 15. ★★ MC-058:handler **合法返回** `{ok:false,error}`(不抛异常)→ 该步记 failed、不报 active、
 *       验收不通过(从前「只要没抛就记 done + acceptancePassed:true」) ── */
console.log("\n⑮ 业务层拒绝({ok:false} 而非抛异常)→ 该步 failed、不 active、验收不通过");
{
  // 15a. ★★ 承重:服务**不抛**、而是合法回 `{ok:false,error}`(仓里 `workflow.save` 结构化校验不过 /
  //      `mcp.save` 同名已存在 就是这么回的)。旧行为:callRpc resolve 即记 done,一步被拒也被报成
  //      「建成」,整体还落 active、验收 passed:true。修法:派发后过**共享**解码器 `decodeDomainOutcome`,
  //      `{ok:false}` 判 rejected → 该步记 failed、带服务的真实错误。
  {
    clearRpcHandlers();
    const host = newHost();
    let calls = 0;
    // 这个 handler 复刻生产形状:收下 {workflow},**合法返回** {ok:false,error}(不抛),根本不登记资源。
    recordRpcHandler("workflow:save", (_e, raw) => {
      calls += 1;
      const wf = (raw as Record<string, unknown> | undefined)?.workflow as Record<string, unknown> | undefined;
      void wf;
      return { ok: false as const, error: "工作流结构化校验不过:图里有环(测试注入,合法拒绝非抛错)" };
    });
    // 回读入口:资源从没被登记 → 查不到(回读 observed 为空)。
    recordRpcHandler("workflow:get", (_e, raw) => ({
      workflow: null,
      revision: null,
      review: null,
      id: (raw as Record<string, unknown> | undefined)?.id,
    }));
    const spec = checked(specWith("reject_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_reject", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied(执行过,只是被业务拒绝)", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("★★ 合法 ok:false 的步记为 FAILED(不是 done)", r.deployment.steps[0]?.status, "failed");
      check("★ 失败原因原样带出服务返回的真实错误", (r.deployment.steps[0]?.error ?? "").includes("图里有环"), r.deployment.steps[0]?.error);
      check("★ 失败原因点明是「业务层明确拒绝」", (r.deployment.steps[0]?.error ?? "").includes("明确拒绝"), r.deployment.steps[0]?.error);
      eq("★★ 整体不是 ACTIVE(没有资源被建成)", r.deployment.status, "failed");
      eq("★★ 验收不通过(这一步没建成,绝不据此报 passed)", r.deployment.acceptance?.passed, false);
    }
    eq("★ 服务确实被派发一次(证明是「跑过了但被拒」,不是「没跑」)", calls, 1);
    check("★ 宿主里没有任何资源(被拒绝 = 没建成)", host.workflows.size === 0);

    // 落盘那份也要是 failed,不能回落成 done / active。
    eq("★ 落盘的整体状态也是 FAILED", loadDeployment("dep_reject")?.status, "failed");
  }

  // 15b. ★ 承重(混合):一步真建成(done)、另一步被业务**合法拒绝**({ok:false})→ 整体 PARTIAL
  //      (绝不是 active),验收不通过。证明拒绝与抛错在整体推导里得到同样处置。
  {
    clearRpcHandlers();
    const host = newHost();
    // 工作流成功登记;触发器的 save 合法回 {ok:false}(不抛)。
    recordRpcHandler("workflow:save", (_e, raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      const wf = p.workflow as Record<string, unknown> | undefined;
      if (wf !== undefined && wf.trigger !== undefined) {
        return { ok: false as const, error: "自动化名非法(测试注入,合法拒绝非抛错)" };
      }
      if (wf !== undefined && typeof wf.id === "string") host.workflows.set(wf.id, wf);
      return { ok: true as const };
    });
    recordRpcHandler("workflow:get", (_e, raw) => {
      const id = (raw as Record<string, unknown> | undefined)?.id;
      const present = typeof id === "string" && host.workflows.has(id);
      return { workflow: present ? { id } : null, revision: null, review: null };
    });
    const spec = checked(specWith(
      "reject_mix_scene",
      [wfRes("wf", { name: "巡检" }), autoRes("auto", { cron: "0 9 * * *" }, ["wf"])],
      ["wf", "auto"],
    ));
    const plan = compileScenePlan(spec);
    // 关补偿,免得工作流被撤掉而掩盖「部分成功」。
    const r = await applyScene({ deploymentId: "dep_reject_mix", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("工作流步 done(真建成)", r.deployment.steps[0]?.status, "done");
      eq("★ 被业务拒绝的触发器步 failed", r.deployment.steps[1]?.status, "failed");
      check("★ 触发器步带出服务返回的真实拒绝原因", (r.deployment.steps[1]?.error ?? "").includes("自动化名非法"), r.deployment.steps[1]?.error);
      eq("★★ 一成一拒 → 整体 PARTIAL(不是 ACTIVE)", r.deployment.status, "partial");
      eq("★★ 验收不通过", r.deployment.acceptance?.passed, false);
      eq("★ 缺的触发器列进 missing", (r.deployment.acceptance?.missing ?? []).join(","), "auto");
    }
  }

  // 15c. ★ 负控(证明 15a 的判据不是「一律失败」):服务合法回 `{ok:true}` → 照常 done、active、验收通过。
  {
    clearRpcHandlers();
    const host = newHost();
    mountHost(host);
    const spec = checked(specWith("ok_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_ok_ctl", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    if (r.ok && r.kind === "applied") {
      eq("★ 负控:{ok:true} 的步照常 done", r.deployment.steps[0]?.status, "done");
      eq("★ 负控:整体 ACTIVE", r.deployment.status, "active");
      eq("★ 负控:验收通过", r.deployment.acceptance?.passed, true);
    } else {
      check("apply 应返回 applied", false, r);
    }
  }

  // 15d. ★ mcp kind → `mcp.save`:该服务**合法返回** `{ok:false}`(同名已存在),不抛。
  //      这一 kind 的 ok/error 信封合同是本次切片**新登记**到共享解码器里的(`commandOutcome.ts`
  //      的 `mcp.save` → maybePartial);不登记的话它会落 `accepted`,被误记 done。这里证明它承重。
  {
    clearRpcHandlers();
    // mcp.save 合法回 {ok:false}(不抛);mcp.list 回读空名单(资源没建成)。
    recordRpcHandler("mcp:save", () => ({ ok: false as const, error: "同名 server 已存在(测试注入,合法拒绝非抛错)" }));
    recordRpcHandler("mcp:list", () => ({ servers: [] }));
    const spec = checked(specWith(
      "mcp_reject_scene",
      [{ kind: "mcp", id: "srv", spec: { name: "srv", config: { type: "stdio", command: "npx" } } }],
      ["srv"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_mcp_reject", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied(执行过,只是被业务拒绝)", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("★★ mcp.save 合法 ok:false 的步记为 FAILED(不是 done)", r.deployment.steps[0]?.status, "failed");
      check("★ 带出服务返回的真实拒绝原因", (r.deployment.steps[0]?.error ?? "").includes("同名 server 已存在"), r.deployment.steps[0]?.error);
      eq("★ 整体 FAILED", r.deployment.status, "failed");
      eq("★ 验收不通过", r.deployment.acceptance?.passed, false);
    }
  }

  // 15e. ★★ 承重(reviewer 打的探针):服务合法回 `{ok:false}`,**但那一步的 actionId 恰好回读得到**
  //      (例:同名资源本就在、或入口对不存在的资源也回一个空壳)。此时 `missing` 为空 —— 若验收**只**
  //      看 missing,就会把「记录里明明 failed 的一步」报成 passed:true(与失败事实直接矛盾)。
  //      这道判据逼 `evaluateAcceptance` 把「有步骤失败」也算进否决,不能只信回读到的集合。
  {
    clearRpcHandlers();
    const host = newHost();
    // save 合法回 {ok:false}(不抛)—— 这一步在记录里是 failed;但宿主里**预置**了同名资源,
    // 于是 workflow.get 回读得到它 → observed 含 "wf" → missing 为空。
    recordRpcHandler("workflow:save", () => ({ ok: false as const, error: "保存被业务拒绝(测试注入)" }));
    recordRpcHandler("workflow:get", (_e, raw) => {
      const id = (raw as Record<string, unknown> | undefined)?.id;
      // 故意让回读**查得到**(模拟同 id 资源本就在 / 空壳)—— 这正是「只信回读会假绿」的入口。
      return { workflow: typeof id === "string" ? { id } : null, revision: null, review: null };
    });
    host.workflows.set("wf", { id: "wf" });
    const spec = checked(specWith("reject_readback_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_reject_readback", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      eq("★ 该步是 failed(服务业务拒绝)", r.deployment.steps[0]?.status, "failed");
      eq("★ 前置:回读 observed 里其实有这条(故 missing 为空)", (r.deployment.acceptance?.missing ?? []).join(","), "");
      eq("★★ 验收**仍不通过** —— 记录说这一步失败了,回读到了也不能算它成", r.deployment.acceptance?.passed, false);
    }
  }
}

/* ── ⑯ MC-058:正式生产入口 —— 用户签发计划级授权 → 部署 ──
 *
 * 上面每一节都是直接造一枚 `Grant` 喂 `applyScene`(单元口径)。这一节验**生产入口那一对**:
 * `approveSceneDeployment`(宿主重编译 + 与调用方递来的 planDigest **对账** + 走唯一签发口)
 * 与 `applySceneWithGrant`(只收 `grantId`,自己去 `GrantStore` 取回授权交判定核)。
 * 复核点名的那条「尚无正式生产入口消费 applyScene」指的就是这里。
 */
console.log("\n⑯ MC-058:生产入口(签发 → 部署)");
{
  const spec = checked(specWith("entry_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
  const plan = compileScenePlan(spec);

  // ---- 16a 对账:调用方声称的 planDigest 与重编译结果不一致 → 拒签 ----
  setGrantStore(null); // 每节干净起步(模块级单例,别串味)
  const mismatched = approveSceneDeployment({ spec, planDigest: "deadbeef".repeat(8), ttlMs: 60_000 });
  check("★ 计划摘要对不上 → 拒签(不按新计划偷发一份授权)", mismatched.ok === false && mismatched.kind === "refused", mismatched);
  if (!mismatched.ok && mismatched.kind === "refused") {
    check("拒签理由点名了「计划不一致」", mismatched.reason.includes("不一致"), mismatched.reason);
  }
  eq("★ 拒签没有在授权库里留下任何东西", new GrantStore().get("grant-1", Date.now()), null);

  // ---- 16b spec 不合法 → 三态的 invalid(与 scene.plan 同形) ----
  const bad = approveSceneDeployment({ spec: { schemaVersion: 99 }, planDigest: "x", ttlMs: 60_000 });
  check("★ spec 不合法 → kind=invalid 且报出问题", bad.ok === false && bad.kind === "invalid" && bad.problems.length > 0, bad);

  // ---- 16c 摘要对得上 → 签出授权,且它绑的是这一份计划 ----
  const approved = approveSceneDeployment({ spec, planDigest: plan.digest, ttlMs: 60_000 });
  check("★ 摘要一致 → 签出授权", approved.ok === true && approved.kind === "granted", approved);
  let grantId = "";
  if (approved.ok && approved.kind === "granted") grantId = approved.grantId;

  // ---- 16d grantId 取不到 → 拒绝执行,一步都不建(不留后门) ----
  clearRpcHandlers();
  const host = newHost();
  let calls = 0;
  mountHost(host, { onSave: () => { calls += 1; } });
  const before = countRows();
  const ghost = await applySceneWithGrant({
    deploymentId: "dep_ghost", grantId: "grant-does-not-exist", spec, actor: ACTOR,
  });
  check("★ 授权取不到 → refused(不是静默放行)", ghost.ok === false && ghost.kind === "refused", ghost);
  if (ghost.ok === false && ghost.kind === "refused") {
    eq("取不到授权的拒绝码是 no_grant", ghost.refusal.code, "no_grant");
  }
  eq("★ 取不到授权时一个 handler 都没被调", calls, 0);
  eq("★ 取不到授权时没建部署行", countRows(), before);

  // ---- 16e 合法授权 → 真的部署,且资源建成了 ----
  const r = await applySceneWithGrant({
    deploymentId: "dep_entry", grantId, spec, actor: ACTOR,
  });
  check("★ 持有效授权 → 真的执行", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 整体 ACTIVE", r.deployment.status, "active");
    eq("★ 验收通过", r.deployment.acceptance?.passed, true);
  }
  check("★ 宿主里真的建成了工作流", host.workflows.has("wf"));
  eq("★ 生产入口真落盘(回读得到)", loadDeployment("dep_entry")?.status, "active");

  // ---- 16f 授权的对象是**计划**:spec 在批准后被改一个字节 → 重编译 digest 变 → 部署被拒 ----
  const tampered = checked(specWith("entry_scene", [wfRes("wf", { name: "巡检(被改过)" })], ["wf"]));
  const r2 = await applySceneWithGrant({
    deploymentId: "dep_tamper", grantId, spec: tampered, actor: ACTOR,
  });
  check("★ 批准后被偷改 spec → 授权绑的是旧计划摘要,部署被拒", r2.ok === false && r2.kind === "refused", r2);

  setGrantStore(null);
}

/* ── ⑰ MC-058:存档 durable 落不下去就不开工 ──
 *
 * 复核点名的另一条:`saveDeployment` 的 durable 写失败时,从前只 `log.warn` 然后**照常执行**
 * —— 建出来的资源没有任何可回读的凭据(崩溃后无从补偿、无从验收)。现在**初始那一笔**落不下去
 * 就整个不执行,并且是**显式拒绝**(带稳定码),不是静默继续。
 */
console.log("\n⑰ MC-058:初始存档 durable 失败 → 拒绝开工");
{
  clearRpcHandlers();
  const host = newHost();
  let calls = 0;
  mountHost(host, { onSave: () => { calls += 1; } });
  const spec = checked(specWith("durable_scene", [wfRes("wf", { name: "巡检" })], ["wf"]));
  const plan = compileScenePlan(spec);

  // 让 durable 提交**不落盘**:commitNow 由 `saveDeployment` 内部调用,这里从**磁盘侧**制造失败
  // (数据目录只读是最贴近真实的做法,但跨平台不稳),故改从**持久层**注入:重命名 repo 落盘
  // 必定抛 —— 用一份会抛的 `SceneDeploymentRepo.save`。
  const before = countRows();
  const { SceneDeploymentRepo } = await import("@main/store/repositories.js");
  const originalSave = SceneDeploymentRepo.save;
  SceneDeploymentRepo.save = () => { throw new Error("injected archive write failure"); };
  let r;
  try {
    r = await applyScene({ deploymentId: "dep_durable", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  } finally {
    SceneDeploymentRepo.save = originalSave;
  }
  check("★ 存档写不进去 → 拒绝执行(不是照常建资源)", r.ok === false && r.kind === "refused", r);
  if (r.ok === false && r.kind === "refused") {
    eq("拒绝码是 archive_not_durable", r.refusal.code, "archive_not_durable");
    check("拒因说清了「建了也记不住」", r.refusal.reason.includes("记录"), r.refusal.reason);
  }
  eq("★ 一步都没派发", calls, 0);
  check("★ 宿主里没建出任何资源", !host.workflows.has("wf"));
  eq("★ 也没留下部署行", countRows(), before);
}

/* ── ⑱ ★★ MC-058 残余:崩溃续跑的 resume 入口 —— 跳过已建成、只跑剩下的 ──
 *
 * 复核点名的那条残余是:**落盘够了(每步 durable 存档),但没有一个 resume 入口把已 done 的步跳过
 * 重跑。** 这一节先制造一份**真的部分执行**的部署(一步成、一步败,补偿关掉),再 `resumeScene`
 * 读盘续跑:**已 done 的步不重跑(handler 不再被调一次 —— 这是本条的核心判据,断言的是 handler
 * 调用次数,不是记录里的状态),failed 的步重试。** 另测:授权缺失/不符拒 resume、plan digest 变了
 * 拒 resume、读不到记录拒 resume、`compensated` 的步在 resume 时**重建**(资源被撤过,必须补回)。
 */
console.log("\n⑱ MC-058 残余:resume 入口:跳过已建成步(handler 不再调)、只重试剩下的");
{
  clearRpcHandlers();
  const host = newHost();
  // 逐次 save 的**资源 id** 记录 —— 用它数「某一步的 handler 到底被调了几次」。
  let saveCalls: string[] = [];
  // 可变的失败开关:第一趟(模拟崩溃前)触发器失败;续跑前关掉 → 重试会成功。
  let failAuto = true;
  mountHost(host, {
    failSave: (p) => (failAuto && isAutoPayload(p) ? "触发器建不起来(测试注入,模拟崩溃前失败)" : null),
    onSave: (p) => { saveCalls.push(String(docOf(p).id)); },
  });
  const spec = checked(specWith(
    "resume_scene",
    [wfRes("wf", { name: "巡检" }), autoRes("auto", { cron: "0 9 * * *" }, ["wf"])],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);

  // 第一趟:一次**部分执行**的部署(wf 成、auto 败),补偿关掉 → 盘上留一份 partial 记录。
  const first = await applyScene({
    deploymentId: "dep_resume", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false,
  });
  check("前置:首趟部署返回 applied", first.ok === true && first.kind === "applied", first);
  if (first.ok && first.kind === "applied") {
    eq("前置:工作流步成", first.deployment.steps[0]?.status, "done");
    eq("前置:触发器步败", first.deployment.steps[1]?.status, "failed");
    eq("前置:整体 PARTIAL", first.deployment.status, "partial");
  }
  eq("前置:首趟两个 handler 各被调一次(wf, auto)", saveCalls.join(","), "wf,auto");
  // 盘上那份记录确实是 partial(延续的前提是它真的在盘上)。
  const onDisk = loadDeployment("dep_resume");
  eq("前置:盘上记录是 PARTIAL(部分执行真的落盘了)", onDisk?.status, "partial");
  eq("前置:盘上 wf 步是 done", onDisk?.steps.find((s) => s.actionId === "wf")?.status, "done");

  // 「崩溃」后再来:关掉失败、清空调用记录 —— 续跑。
  failAuto = false;
  saveCalls = [];
  const r2 = await resumeScene({ deploymentId: "dep_resume", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("★ resume 返回 applied", r2.ok === true && r2.kind === "applied", r2);
  if (r2.ok && r2.kind === "applied") {
    eq("★ 续跑后整体 ACTIVE(两步都成)", r2.deployment.status, "active");
    check("★ 两步都 done", r2.deployment.steps.every((s) => s.status === "done"), r2.deployment.steps);
    eq("★ 续跑后验收通过", r2.deployment.acceptance?.passed, true);
  }
  // ★★ 承重:已 done 的 wf 步**没有被再派发一次** —— 只重试了 failed 的 auto。判据是 handler 调用
  //     次数(不是记录里的状态:状态本来就在盘上,不证明它没重跑)。
  eq("★★ 续跑只重试失败的那一步 —— handler 只被 auto 调一次(wf 未重跑)", saveCalls.join(","), "auto");
  eq("★ 盘上记录续跑后也更新为 ACTIVE", loadDeployment("dep_resume")?.status, "active");

  // 18b. 授权闸在 resume 上一样严:**不因「是 resume」放宽** —— 已撤销的授权照样拒,一步不跑。
  saveCalls = [];
  const revoked = await resumeScene({
    deploymentId: "dep_resume", spec, actor: ACTOR,
    grant: grantFor(plan.digest, { revoked: true }),
  });
  check("★ resume 用已撤销的授权 → refused(不放宽)", revoked.ok === false && revoked.kind === "refused", revoked);
  if (revoked.ok === false && revoked.kind === "refused") eq("拒绝码 = revoked", revoked.refusal.code, "revoked");
  eq("★ 被拒的 resume 一个 handler 都没调", saveCalls.length, 0);

  // 18c. resume 用**绑另一份计划**的授权 → 拒(与 applyScene 同一条判定)。
  saveCalls = [];
  const wrongPlanGrant = await resumeScene({
    deploymentId: "dep_resume", spec, actor: ACTOR,
    grant: grantFor("deadbeef".repeat(8)),
  });
  check("★ resume 用绑错计划的授权 → refused", wrongPlanGrant.ok === false && wrongPlanGrant.kind === "refused", wrongPlanGrant);
  if (wrongPlanGrant.ok === false && wrongPlanGrant.kind === "refused") eq("拒绝码 = plan_mismatch", wrongPlanGrant.refusal.code, "plan_mismatch");
  eq("★ 被拒的 resume 一个 handler 都没调", saveCalls.length, 0);

  // 18d. ★ plan digest 变了(声明在崩溃后被改过)→ 拒 resume,绝不把新计划套到旧记录上。
  {
    const tampered = checked(specWith(
      "resume_scene",
      [wfRes("wf", { name: "巡检(崩溃后被改过)" }), autoRes("auto", { cron: "0 9 * * *" }, ["wf"])],
      ["wf", "auto"],
    ));
    const tamperedPlan = compileScenePlan(tampered);
    check("前置:改过声明的计划 digest 与盘上那份不同", tamperedPlan.digest !== plan.digest);
    saveCalls = [];
    // 授权绑**新**计划(先过授权闸),但盘上记录还是**旧**计划 → digest 对不上 → 拒续跑。
    const r = await resumeScene({
      deploymentId: "dep_resume", spec: tampered, actor: ACTOR, grant: grantFor(tamperedPlan.digest),
    });
    check("★ 声明在崩溃后改过(digest 变)→ 拒 resume", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") {
      eq("★ 拒绝码 = resume_plan_changed", r.refusal.code, "resume_plan_changed");
      check("拒因点明「计划不一致」(不静默)", r.refusal.reason.includes("不一致"), r.refusal.reason);
    }
    eq("★ 被拒的 resume 一个 handler 都没调", saveCalls.length, 0);
    // 盘上那份记录**没被改动**(拒绝不留痕)。
    eq("★ 盘上记录仍是续跑前的 ACTIVE(digest 不符时没碰它)", loadDeployment("dep_resume")?.status, "active");
  }

  // 18e. 盘上没有这份记录 → 拒 resume(无从续跑,不静默当成新部署去建)。
  saveCalls = [];
  const noRec = await resumeScene({ deploymentId: "dep_no_such", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("★ 盘上无记录 → 拒 resume(不当作全新部署)", noRec.ok === false && noRec.kind === "refused", noRec);
  if (noRec.ok === false && noRec.kind === "refused") eq("拒绝码 = no_record", noRec.refusal.code, "no_record");
  eq("★ 无记录的 resume 一个 handler 都没调", saveCalls.length, 0);
  check("★ 也没为它凭空建一条部署行", loadDeployment("dep_no_such") === null);
}

/* ── ⑲ ★★ MC-058 残余:compensated 的步在 resume 时**重建**(资源被撤过,必须补回,不是跳过) ──
 *
 * `compensated` = 本步建成过、但后续步失败触发了补偿、其资源已被逆操作撤销 —— **资源当下已不在**。
 * 故它不是「已建成」,resume 必须**重试重建**(否则场景少一条资源、验收永远过不了)。
 */
console.log("\n⑲ MC-058 残余:resume 对 compensated 的步**重建**(不是跳过 —— 资源已被撤)");
{
  clearRpcHandlers();
  const host = newHost();
  let saveCalls: string[] = [];
  let failAuto = true;
  mountHost(host, {
    failSave: (p) => (failAuto && isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
    onSave: (p) => { saveCalls.push(String(docOf(p).id)); },
  });
  const spec = checked(specWith(
    "resume_comp_scene",
    [wfRes("wf", { name: "巡检" }), autoRes("auto", { cron: "0 9 * * *" }, ["wf"])],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);

  // 第一趟:补偿**开**着 → wf 建成后被补偿撤销(状态 compensated),auto 败。
  const first = await applyScene({ deploymentId: "dep_resume_comp", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("前置:首趟部署返回 applied", first.ok === true && first.kind === "applied", first);
  if (first.ok && first.kind === "applied") {
    const wfStep = first.deployment.steps.find((s) => s.actionId === "wf");
    eq("前置:wf 步被补偿(compensated)", wfStep?.status, "compensated");
    eq("前置:整体 FAILED(没留下资源)", first.deployment.status, "failed");
  }
  check("前置:宿主里 wf 已被撤销(资源不在)", !host.workflows.has("wf"));
  const onDiskComp = loadDeployment("dep_resume_comp");
  eq("前置:盘上 wf 步是 compensated", onDiskComp?.steps.find((s) => s.actionId === "wf")?.status, "compensated");

  // 「崩溃」后关掉失败 → 续跑。compensated 的 wf 与 failed 的 auto **都要重建**。
  failAuto = false;
  saveCalls = [];
  const r = await resumeScene({ deploymentId: "dep_resume_comp", spec, actor: ACTOR, grant: grantFor(plan.digest) });
  check("★ resume 返回 applied", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★★ compensated 的 wf 步被**重建**(不是跳过)", r.deployment.steps.find((s) => s.actionId === "wf")?.status, "done");
    eq("★ 失败的 auto 步重试成功", r.deployment.steps.find((s) => s.actionId === "auto")?.status, "done");
    eq("★ 续跑后整体 ACTIVE", r.deployment.status, "active");
    eq("★ 续跑后验收通过", r.deployment.acceptance?.passed, true);
    check("★ 宿主里 wf 真的被补回来了", host.workflows.has("wf") && host.workflows.has("auto"));
  }
  // ★ 两条都重试了(compensated 的 wf + failed 的 auto);都不算「已建成」故都不能跳过。
  eq("★ 续跑重试了 wf(重建)与 auto 两步", saveCalls.join(","), "wf,auto");
}

/* ── ⑳ ★ MC-058 残余:resume 的**正式生产入口**(grantId → 取回授权 → 续跑) ── */
console.log("\n⑳ MC-058 残余:resume 生产入口 resumeSceneWithGrant");
{
  clearRpcHandlers();
  setGrantStore(null); // 干净起步(模块级单例)。
  const host = newHost();
  let failAuto = true;
  let saveCalls: string[] = [];
  mountHost(host, {
    failSave: (p) => (failAuto && isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
    onSave: (p) => { saveCalls.push(String(docOf(p).id)); },
  });
  const spec = checked(specWith(
    "resume_entry_scene",
    [wfRes("wf", { name: "巡检" }), autoRes("auto", { cron: "0 9 * * *" }, ["wf"])],
    ["wf", "auto"],
  ));
  const plan = compileScenePlan(spec);

  // 首趟:直接 applyScene 造一份 partial 记录(补偿关,让 wf 留在盘上)。
  await applyScene({ deploymentId: "dep_resume_entry", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
  eq("前置:盘上是 PARTIAL", loadDeployment("dep_resume_entry")?.status, "partial");

  // grantId 取不到 → 拒(不留后门)。
  const ghost = await resumeSceneWithGrant({
    deploymentId: "dep_resume_entry", grantId: "grant-does-not-exist", spec, actor: ACTOR,
  });
  check("★ 授权取不到 → refused(不是静默放行)", ghost.ok === false && ghost.kind === "refused", ghost);
  if (ghost.ok === false && ghost.kind === "refused") eq("拒绝码 = no_grant", ghost.refusal.code, "no_grant");

  // 正路:签发一枚真授权 → resumeSceneWithGrant 取回它续跑(已 done 的 wf 不重跑)。
  failAuto = false;
  saveCalls = [];
  const approved = approveSceneDeployment({ spec, planDigest: plan.digest, ttlMs: 60_000 });
  check("前置:签出计划级授权", approved.ok === true && approved.kind === "granted", approved);
  let grantId = "";
  if (approved.ok && approved.kind === "granted") grantId = approved.grantId;
  const r = await resumeSceneWithGrant({
    deploymentId: "dep_resume_entry", grantId, spec, actor: ACTOR,
  });
  check("★ 持有效授权 → 真的续跑", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 续跑后整体 ACTIVE", r.deployment.status, "active");
    eq("★ 验收通过", r.deployment.acceptance?.passed, true);
  }
  check("★ 宿主里两步都建成", host.workflows.has("wf") && host.workflows.has("auto"));
  eq("★ 生产入口真落盘(回读得到)", loadDeployment("dep_resume_entry")?.status, "active");
  // ★ 生产入口续跑**也**跳过已 done 的 wf —— 只重试了 auto(证明它派发到 resumeScene 而非
  //   applyScene:后者会把全 pending 的步骤重跑一遍)。
  eq("★ 生产入口续跑只重试失败的 auto(wf 未重跑)", saveCalls.join(","), "auto");

  setGrantStore(null);
}

/* ── ㉑ ★★ MC-058 残余②③:回读/补偿按**真实服务身份**钉死 + `resourceUid` 落盘 ──
 *
 * 回读与补偿用的**不是**场景内的资源 id(`actionId`),而是该资源在**它自己的服务**里的稳定身份
 * (`workflow/automation`→`doc.id`、`skill`→`SkillInfo.name`、`mcp`→`McpServerEntry.name`、
 * `hook`→`HookSpec.id`、`module`→`ModuleManifest.id`;见 `sceneCommands.ts` 的 `identityPath`)。
 * **声明里推不出稳定身份**的 kind(plugin/panel/scaffold)回读时如实记 `unverifiable`,**绝不**
 * 拿一个永远匹配不上的值假装回读过了。承重判据:**故意让场景 id 与服务身份不同** —— 旧行为按场景
 * id 查一个按服务身份索引的列表,**永远匹配不上**(observed 空、验收假失败 / 补偿删错或删不掉)。
 */
console.log("\n㉑ MC-058 残余②③:回读/补偿按真实服务身份钉死 + resourceUid 落盘");
{
  // 21a. ★★ 承重:workflow 的场景 id 与 doc.id **不同** → 回读按 `doc.id` 命中,resourceUid 落 doc.id。
  {
    clearRpcHandlers();
    const host = newHost();
    mountHost(host);
    const spec = checked(specWith(
      "identity_scene",
      // 场景资源 id = "wf_scene";声明正文的 WorkflowDoc.id = "wf_real"(两者刻意不同)。
      [{ kind: "workflow", id: "wf_scene", spec: wfDoc("wf_real", { name: "巡检" }) }],
      ["wf_scene"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_identity", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const step = r.deployment.steps.find((s) => s.actionId === "wf_scene");
      eq("★ 工作流步 done", step?.status, "done");
      // ★★ 承重:旧行为按 actionId("wf_scene")查 workflow.get → 宿主里没有它 → observed 空、验收假失败。
      eq("★★ 回读按 doc.id 命中(不是按场景 id)", r.readback.observed.join(","), "wf_scene");
      eq("★★ 验收通过(观察值取自真实服务身份)", r.deployment.acceptance?.passed, true);
      eq("★★ resourceUid 落该资源的服务侧身份(doc.id)", step?.resourceUid, "wf_real");
      check("★ 宿主里登记的是 doc.id(wf_real)", host.workflows.has("wf_real"));
      check("★ 宿主里没有以场景 id 命名的资源(证明回读没按场景 id 查)", !host.workflows.has("wf_scene"));
    }
  }

  // 21b. ★★ 承重:compensation 的逆操作按**服务身份**调 —— workflow.remove 收到 doc.id,不是场景 id。
  {
    clearRpcHandlers();
    const host = newHost();
    const removed: string[] = [];
    mountHost(host, {
      failSave: (p) => (isAutoPayload(p) ? "触发器建不起来(测试注入)" : null),
      onRemove: (id) => removed.push(id),
    });
    const spec = checked(specWith(
      "comp_identity_scene",
      [
        { kind: "workflow", id: "wf_scene", spec: wfDoc("wf_real", { name: "巡检" }) },
        autoRes("auto", { cron: "坏表达式" }, ["wf_scene"]),
      ],
      ["wf_scene", "auto"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_comp_identity", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const wfStep = r.deployment.steps.find((s) => s.actionId === "wf_scene");
      eq("★ 已建成的工作流步被补偿", wfStep?.status, "compensated");
      // ★★ 承重:逆操作按服务身份(doc.id="wf_real")删 —— 旧行为按场景 id("wf_scene")删,删不到真资源。
      eq("★★ 逆操作按 doc.id 调(不是场景 id)", removed.join(","), "wf_real");
      check("★ 宿主里的真资源被清掉(按 doc.id)", !host.workflows.has("wf_real"));
    }
  }

  // 21c. ★ skill:hooks.save 由 HookSpec.id 回读;场景 id 与 HookSpec.id 不同 → 按后者命中。
  {
    clearRpcHandlers();
    const host = newHost();
    // hooks 的 save/list 走 HookSpec.id。场景 id 用 "hk_scene",HookSpec.id 用 "h_real"。
    recordRpcHandler("hooks:save", (_e, raw) => {
      const h = (raw as Record<string, unknown> | undefined)?.hook as Record<string, unknown> | undefined;
      if (h !== undefined && typeof h.id === "string") host.hooks.add(h.id);
      return { ok: true };
    });
    recordRpcHandler("hooks:list", () => ({ hooks: [...host.hooks].map((id) => ({ id })), problems: [] }));
    recordRpcHandler("workflow:get", () => ({ workflow: null, revision: null, review: null }));
    const spec = checked(specWith(
      "hook_identity_scene",
      [{ kind: "hook", id: "hk_scene", spec: { id: "h_real", name: "记录", event: "tool.use", command: "echo hi", enabled: true } }],
      ["hk_scene"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_hook_identity", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const step = r.deployment.steps.find((s) => s.actionId === "hk_scene");
      eq("★ 钩子步 done", step?.status, "done");
      eq("★★ 回读按 HookSpec.id 命中", r.readback.observed.join(","), "hk_scene");
      eq("★ resourceUid 落 HookSpec.id", step?.resourceUid, "h_real");
      check("★ 宿主里登记的是 HookSpec.id(h_real)", host.hooks.has("h_real"));
    }
  }

  // 21d. ★ module:回读按 `ModuleManifest.id`(声明里的 spec.manifest.id);resourceUid 落该 id。
  {
    clearRpcHandlers();
    const host = newHost();
    // modules:install 收 {manifest, confirmReadAccess},把 manifest.id 登记进 catalog。
    recordRpcHandler("modules:install", (_e, raw) => {
      const m = (raw as Record<string, unknown> | undefined)?.manifest as Record<string, unknown> | undefined;
      if (m !== undefined && typeof m.id === "string") host.modules.add(m.id);
      return { modules: [...host.modules].map((id) => ({ id })), capabilities: [], workflowTargets: [] };
    });
    recordRpcHandler("modules:catalog", () => ({ modules: [...host.modules].map((id) => ({ id })) }));
    recordRpcHandler("workflow:get", () => ({ workflow: null, revision: null, review: null }));
    const manifest = {
      apiVersion: 1, id: "user.coverage.report", version: "1.0.0",
      title: { zh: "覆盖率报告", en: "Coverage" }, permissions: ["resource.read"],
      contributions: [{
        id: "inspect", slot: "files.context", title: { zh: "生成", en: "Create" }, capability: "core.file.inspect",
        view: { title: { zh: "报告", en: "Report" }, fields: [{ key: "bytes", title: { zh: "字节", en: "Bytes" } }] },
      }],
    };
    const spec = checked(specWith(
      "module_identity_scene",
      [{ kind: "module", id: "md_scene", spec: { manifest, confirmReadAccess: true } }],
      ["md_scene"],
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_module_identity", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    check("apply 返回 applied", r.ok === true && r.kind === "applied", r);
    if (r.ok && r.kind === "applied") {
      const step = r.deployment.steps.find((s) => s.actionId === "md_scene");
      eq("★ 模块步 done", step?.status, "done");
      eq("★★ 回读按 ModuleManifest.id 命中", r.readback.observed.join(","), "md_scene");
      eq("★★ resourceUid 落 ModuleManifest.id", step?.resourceUid, "user.coverage.report");
      check("★ 宿主里登记的是 ModuleManifest.id", host.modules.has("user.coverage.report"));
    }
  }

  // 21e. ★★ 承重:plugin/panel/scaffold 声明里推不出稳定身份 → 回读**如实记 unverifiable**(不是 observed)。
  //      这里用**市场来源**的插件(声明里带 `spec.name` —— 但那是市场**条目名**,不等于安装后插件
  //      manifest 给出的 `PluginState.name`,故仍不是可从声明推出的稳定身份)。
  {
    clearRpcHandlers();
    const host = newHost();
    mountHost(host);
    const spec = checked(specWith(
      "unverifiable_scene",
      [
        wfRes("wf", { name: "巡检" }),
        { kind: "plugin", id: "pl", spec: { source: "marketplace", name: "research-pack" } },
      ],
      ["wf"], // 只期望回读工作流(plugin 无稳定身份,不列入验收期望)
    ));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_unverifiable", spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false });
    if (r.ok && r.kind === "applied") {
      eq("★ 工作流回读得到", r.readback.observed.join(","), "wf");
      // ★★ 承重:plugin 落进 unverifiable,且原因点名「稳定身份」,readLabel 是它在读的入口。
      //   若有人给 plugin 编一个 identityPath(如 name),这里会拿市场的**条目名**去查
      //   plugins.list —— 查不到 / 报错 → 原因不再是「稳定身份」,本断言真红。
      check("★★ plugin 被如实列入 unverifiable(不当成 present)", r.readback.unverifiable.includes("pl"), r.readback);
      const plStep = r.readback.steps.find((s) => s.actionId === "pl");
      check("★★ unverifiable 原因点名「稳定身份」(不静默当成查过了)", (plStep?.unverifiableReason ?? "").includes("稳定身份"), plStep?.unverifiableReason);
      eq("★ unverifiable 也带上它尝试读的入口标签", plStep?.readLabel, "plugins.list");
      check("★ plugin 不在 observed 里(没被当成回读到了)", !r.readback.observed.includes("pl"));
    } else {
      check("apply 应返回 applied", false, r);
    }
  }

  // 21f. ★ 声明缺稳定身份字段(workflow 只有 name、没有 id)→ 回读也如实记 unverifiable,不冒充。
  {
    clearRpcHandlers();
    const host = newHost();
    mountHost(host);
    // workflow 只给 name(缺 doc.id)→ 投影本就失败(failed),回读时身份也取不到。
    const spec = checked(specWith("missing_identity_scene", [{ kind: "workflow", id: "wf_scene", spec: { name: "只有名字" } }], ["wf_scene"]));
    const plan = compileScenePlan(spec);
    const r = await applyScene({ deploymentId: "dep_missing_identity", spec, actor: ACTOR, grant: grantFor(plan.digest) });
    if (r.ok && r.kind === "applied") {
      const step = r.readback.steps.find((s) => s.actionId === "wf_scene");
      check("★★ 缺稳定身份字段 → 回读如实记 unverifiable", r.readback.unverifiable.includes("wf_scene"), r.readback);
      check("★ 原因点名缺的是哪个身份字段(不静默)", (step?.unverifiableReason ?? "").includes("id"), step?.unverifiableReason);
      check("★ 不在 observed 里(没被当成回读到了)", !r.readback.observed.includes("wf_scene"));
    } else {
      check("apply 应返回 applied", false, r);
    }
  }
}

console.log("\n㉒ MC-058/ARC-002:崩溃 → 真重启 → 续跑 → 独立验证(跨进程)");
{
  // 干净起步:清掉上一轮的共享文件(临时目录里,删了无害)。
  for (const f of [hostFile(), callsFile(), grantFile(), survivedFile(), restartResultFile()]) {
    try { rmSync(f, { force: true }); } catch { /* 没有就算了 */ }
  }
  // 把父进程自己的库 flush 到盘上,给子进程一个一致的起点(子进程会读这份 mcode.db)。
  commitNow();

  // ── 第一段:真子进程跑「校验 → 授权 → 部署到一半 → 被杀」。──
  const crash = await spawnChild("crash");
  check("① 崩溃子进程收到信号(非零退出 = 被真的杀掉,不是正常跑完)", crash.code !== 0, { code: crash.code, stderr: crash.stderr.slice(0, 400) });
  check("★★ 崩溃子进程没能跑到「幸存标记」那一行(kill 真的生效了)", !existsFile(survivedFile()), { stderr: crash.stderr.slice(0, 200) });
  // 父进程**独立**读盘:崩溃那一步留下的部分执行记录真的在磁盘上。
  const diskAfterCrash = await diskDeployment(CRASH_DEPLOY);
  check("★★ 盘上读得到那份**半成品**记录(真正落过盘、跨进程还在)", diskAfterCrash !== null);
  eq("★★ 盘上记录:工作流步 done、触发器步 failed(部分执行)", diskAfterCrash ? `${diskAfterCrash.steps.find((s) => s.actionId === CRASH_WF)?.status},${diskAfterCrash.steps.find((s) => s.actionId === CRASH_AUTO)?.status}` : "", "done,failed");
  eq("★★ 盘上记录整体为 PARTIAL", diskAfterCrash?.status, "partial");
  // 崩溃子进程派发过的两步(各一次)。
  eq("崩溃子进程派发过 wf、auto 各一次", readCalls().join(","), `${CRASH_WF},${CRASH_AUTO}`);
  // 宿主快照(磁盘)里只建成了 wf。
  check("崩溃后磁盘宿主快照里只有工作流(触发器没建成)", existsFile(hostFile()) && !readFileSync(hostFile(), "utf8").includes(CRASH_AUTO));

  // ── 第二段:全新进程读回记录、跳过已建成、只跑剩下的。──
  const restart = await spawnChild("restart");
  eq("② 重启子进程正常退出(0)", restart.code, 0);
  const rr = JSON.parse(readFileSync(restartResultFile(), "utf8")) as {
    recordBefore: { status: string; wf: string; auto: string } | null;
    freshHostHasWf: boolean; diskHostHasWf: boolean;
    result: { status?: string; passed?: boolean; steps?: string[]; error?: string };
  };
  // 重启是**真的重启**:新进程内存里没有任何记录(先断言内存是空的,再证明它从磁盘读回)。
  eq("★★ 重启进程**内存里**原本没有那条记录(recordBefore 是从磁盘读回的)", rr.recordBefore?.status, "partial");
  eq("★★ 重启进程内存宿主原本为空(wf 来自磁盘,不是内存)", rr.freshHostHasWf, false);
  eq("★★ 重启进程从**磁盘快照**读回了已建成的 wf", rr.diskHostHasWf, true);
  // 续跑结果。
  eq("★★ 续跑后整体 ACTIVE(已建成的跳过、失败的补上)", rr.result.status, "active");
  eq("★★ 续跑后验收通过", rr.result.passed, true);
  check("★★ 续跑后两步都 done", rr.result.steps?.join(",") === `${CRASH_WF}:done,${CRASH_AUTO}:done`, rr.result.steps);

  // ── 第三段:父进程**独立第三视角**回读磁盘 —— 最终资源真的都在、且已建成步没被重跑。──
  const finalDisk = await diskDeployment(CRASH_DEPLOY);
  eq("★★ 父进程独立回读盘上记录:整体 ACTIVE", finalDisk?.status, "active");
  eq("★★ 父进程独立回读:验收通过", finalDisk?.acceptance?.passed, true);
  const finalHost = JSON.parse(readFileSync(hostFile(), "utf8")) as { workflows: Record<string, unknown> };
  check("★★ 磁盘宿主快照里最终两条资源都在(工作流 + 触发器真的建成了)", CRASH_WF in finalHost.workflows && CRASH_AUTO in finalHost.workflows, Object.keys(finalHost.workflows));
  // ★★ 承重:已建成的 wf **没有被重跑** —— 它全程只在 calls.log 里出现**一次**(跨两个进程共 3 行:wf 1 + auto 2)。
  //     判据是 handler 被派发的次数,不是记录里的状态(状态本来就在盘上,不证明它没重跑)。
  const allCalls = readCalls();
  eq("★★ wf 全程只被派发一次(已建成步没被重跑)—— handler 调用次数判据", allCalls.filter((c) => c === CRASH_WF).length, 1);
  eq("★★ 总派发 = wf 一次 + auto 两次(崩溃前一次 + 续跑一次)", allCalls.join(","), `${CRASH_WF},${CRASH_AUTO},${CRASH_AUTO}`);
}

closeDb();

console.log(`\nscene-apply-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);