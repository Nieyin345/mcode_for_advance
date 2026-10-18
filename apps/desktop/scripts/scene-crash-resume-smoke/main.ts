/**
 * Headless smoke for **MC-002 崩溃 → 重启 → 从零发现失败部署 → 续跑**(**真跨进程**)。
 *
 * ## 它和现有套件差在哪
 *
 * `scene-apply-smoke` 的 ㉒ 已经真起过子进程做「崩溃 → 重启 → 续跑」,但那条续跑
 * **手里有 `deploymentId`**(崩溃子进程自己定的常量,重启子进程直接 `loadDeployment(CRASH_DEPLOY)`)。
 * MC-002 第十七轮复核点名的缺口是更外一圈:**进程崩溃后渲染端连 `deploymentId` / `sceneId`
 * 都没有**(粘贴的 spec 文本随进程消失)—— 只能从盘上 **跨场景列出 resumable 记录**、
 * 取回那条记录里的 `specSnapshot`、重新预览授权,才谈得上续跑。
 *
 * 本套件把那条链原样跑一遍,三个**真 node 进程**、一个 `MCODE_SMOKE_DATA_ROOT`(run.sh
 * 里 `mktemp`)、磁盘事实(`host.json` / `calls.log`)共享 —— 照 `scene-apply-smoke` 的
 * 「`process.argv[2]` 分模式 + 落盘共享事实」做法,不另发明一套:
 *
 *  - **进程 A(`crash`)**:真 SQLite 上跑 `applyScene`,在「自动化」那步注入失败 →
 *    盘上留一条 `partial` 部署(带 `specSnapshot`),再写一条 **active 对照记录** 与一条
 *    **坏存档行**,自检结论落盘后 **`SIGKILL` 自己**(真死在中途,不清理)。`deploymentId`
 *    用随机后缀,**不写进任何共享文件** —— 后两个进程无法从入参/文件里捡到它。
 *  - **进程 B(`discover-resume`)**:入参只有模式名。只调
 *    `listRecentDeploymentEntries(N, {resumableOnly:true})` **从盘上发现**那条记录 →
 *    取 `specSnapshot` → 重编译计划对账 → **先试一次无授权续跑(必须被拒)** →
 *    重新签发计划级授权 → `resumeSceneWithGrant`。判「只跑了未完成的步」用
 *    `calls.log` 的 **handler 派发次数**,不是记录里的状态(状态本来就在盘上,不证明没重跑)。
 *  - **进程 C(`verify`)**:全新进程再按盘上场景发现一次,断言最终 `active` + 验收通过 +
 *    `calls.log` 派发次数 + 坏存档行仍列出但 `resumable=false`。
 *
 * ## 断言清单(为什么每条都承重)
 *
 *  - ★ B 的 **argv / env 里没有 deploymentId** —— 证明它是**从列表里拿的**;
 *  - ★★ 已 `done` 的工作流步**全程只被派发一次**(handler 次数判据),auto 恰好两次;
 *  - ★ 坏存档行(payload 坏)**仍列出**、`resumable=false`、**不会被选中续跑**;
 *  - ★ 可续跑列表里**没有 active 记录**(`resumableOnly` 过滤真的在 SQL 层收窄);
 *  - ★★ **没有授权 → resume 被拒**,且一个 handler 都没派发(发现记录 ≠ 获得授权)。
 *
 * ## 安全前提
 *
 * 数据根走 `$MCODE_SMOKE_DATA_ROOT`(`run-store-smoke/stubs/dataRoot.ts` 里没设就抛)。
 * `run.sh` 用 `mktemp -d` 建它、跑完删。**指错地方就是拿空库盖掉用户的聊天记录** ——
 * 三个进程共用同一个临时目录,才不是各自读一份空库。
 *
 * Run: scripts/scene-crash-resume-smoke/run.sh
 */
import { initDb, commitNow } from "@main/store/db.js";
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import {
  createDeployment,
  advanceDeployment,
  evaluateAcceptance,
  type SceneDeploymentActor,
} from "@contracts/sceneDeployment";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import type { Grant } from "@contracts/policyEngine";
import {
  applyScene,
  approveSceneDeployment,
  resumeSceneWithGrant,
  SCENE_APPLY_METHOD,
} from "@main/appServices/sceneDeploy.js";
import { SceneDeploymentRepo } from "@main/store/repositories.js";
import {
  saveDeployment,
  loadDeployment,
  listRecentDeploymentEntries,
} from "@main/appServices/sceneDeploymentStore.js";
import { assembleGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { dataRoot } from "@main/lib/dataRoot.js";

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

/* ───────────────────────── 共享常量与磁盘事实 ───────────────────────── */

const ACTOR: SceneDeploymentActor = { actorKind: "agent", actorId: "sess_crash" };
const CRASH_SCENE = "scene_crash_resume";
const CRASH_WF = "wf_crash_resume";
const CRASH_AUTO = "auto_crash_resume";
/** active 对照记录 —— `resumableOnly` 必须把它排除(变异靶子)。 */
const CONTROL_ID = "dep_control_active";
const CONTROL_SCENE = "scene_control_active";
const CONTROL_WF = "wf_control_active";
/** 坏存档行 —— 行仍列出,但读不回来 → 不可续跑、不会被选中。 */
const BAD_ARCHIVE_ID = "dep_bad_archive";
const BAD_ARCHIVE_SCENE = "scene_bad_archive";

function hostFile(): string { return join(dataRoot(), "host.json"); }
function callsFile(): string { return join(dataRoot(), "calls.log"); }
/** 进程 A 在「被杀」之前写下的自检结果 —— 它自己没机会正常退出,结论交给 B 断言。 */
function crashResultFile(): string { return join(dataRoot(), "crash-result.json"); }
/** A 若在 kill 之后还活着才会写这个文件 —— B 据此证明 A **真的死了**。 */
function survivedFile(): string { return join(dataRoot(), "CRASH_SURVIVED"); }
function existsFile(f: string): boolean { try { readFileSync(f); return true; } catch { return false; } }

/** 跨进程共享的宿主快照(内存不跨进程;「真的建成了什么」必须落盘才核对得了)。 */
type Host = Map<string, Record<string, unknown>>;
function loadHost(): Host {
  const h: Host = new Map();
  try {
    const raw = JSON.parse(readFileSync(hostFile(), "utf8")) as { workflows?: Record<string, Record<string, unknown>> };
    for (const [id, doc] of Object.entries(raw.workflows ?? {})) h.set(id, doc);
  } catch { /* 没有快照 = 空宿主 */ }
  return h;
}
function saveHost(h: Host): void {
  writeFileSync(hostFile(), JSON.stringify({ workflows: Object.fromEntries(h) }), "utf8");
}
/** append-only 调用日志:跨进程累积,是「某一步被派发了几次」的唯一判据。 */
function logCall(id: string): void { writeFileSync(callsFile(), id + "\n", { flag: "a" }); }
function readCalls(): string[] {
  try { return readFileSync(callsFile(), "utf8").split("\n").filter((s) => s !== ""); } catch { return []; }
}

/**
 * 挂「可跨进程」的服务桩:每次 `workflow:save` 先 append 调用记录(**失败也记** ——
 * 要能证明这一步被派发过),再按注入开关决定抛不抛;成功则更新内存宿主**并落盘**。
 */
function mountHost(host: Host, failSave?: (wf: Record<string, unknown>) => string | null): void {
  recordRpcHandler("workflow:save", (_e, raw) => {
    const wf = (raw as { workflow?: Record<string, unknown> } | undefined)?.workflow;
    if (wf === undefined || typeof wf.id !== "string" || typeof wf.name !== "string") {
      throw new Error("workflow.save:入参缺 workflow(真实 WorkflowSaveSchema 会拒)");
    }
    logCall(wf.id);
    const fail = failSave?.(wf);
    if (fail) throw new Error(fail);
    host.set(wf.id, wf);
    saveHost(host);
    return { ok: true };
  });
  recordRpcHandler("workflow:get", (_e, raw) => {
    const id = (raw as { id?: unknown } | undefined)?.id;
    const present = typeof id === "string" && host.has(id);
    return { workflow: present ? { id } : null, revision: null, review: null };
  });
  recordRpcHandler("workflow:remove", (_e, raw) => {
    const id = String((raw as { id?: unknown } | undefined)?.id ?? "");
    host.delete(id);
    saveHost(host);
    return { ok: true, wasBuiltin: false };
  });
}

/* ───────────────────────── 场景声明 / 授权 ───────────────────────── */

function wfDoc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, nodes: [], edges: [], builtin: false, updatedAt: 1, ...extra };
}
function checked(raw: SceneSpec): SceneSpec {
  const r = validateSceneSpec(raw);
  if (!r.ok) throw new Error("前置场景不合法:" + JSON.stringify(r.problems));
  return r.spec;
}
function crashSpec(): SceneSpec {
  return checked({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId: CRASH_SCENE,
    goal: "每天检查代码、执行测试,失败后通知我",
    capabilities: [],
    resources: [
      { kind: "workflow", id: CRASH_WF, spec: wfDoc(CRASH_WF, { name: "巡检" }) },
      { kind: "automation", id: CRASH_AUTO, spec: wfDoc(CRASH_AUTO, { trigger: "schedule", cron: "0 9 * * *" }), dependsOn: [CRASH_WF] },
    ],
    acceptance: { description: "资源都可见", expectResourceIds: [CRASH_WF, CRASH_AUTO] },
  });
}
/** 直接喂 `applyScene` 的计划级授权(进程 A 用;故意**不落盘** —— 进程 B 手上没有任何授权)。 */
function grantFor(planDigest: string): Grant {
  return {
    grantId: "grant_crash_apply",
    sceneId: CRASH_SCENE,
    allowedActions: [SCENE_APPLY_METHOD],
    scopedCore: { scenePlan: planDigest },
    configHash: "",
    expiresAt: Date.now() + 60_000,
    approvalSource: { kind: "user", id: "desktop" },
    revoked: false,
    usedCount: 0,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * 进程 A(crash):真跑 applyScene,中途失败 → 盘上留 partial,然后**真的被杀**
 *
 * A 不写 stdout 断言(它活不到正常退出,stdout 的攒批在 kill 时可能丢)—— 自检结果先
 * 落到 `crash-result.json`,由 B 读回断言;kill 之后若还能继续执行,A 会写
 * `CRASH_SURVIVED`,B 据此证明「A 是死在中途」而不是跑完了。
 * ═══════════════════════════════════════════════════════════════════════════════ */
async function runCrash(): Promise<void> {
  assembleGrantStore(dataRoot());
  await initDb();
  clearRpcHandlers();

  const host = loadHost();
  // 「自动化」那一步恒失败(用现有 smoke 的 failSave 注入手法)—— 工作流成功、触发器失败。
  mountHost(host, (wf) => (wf.trigger !== undefined ? "触发器建不起来(测试注入,模拟崩溃前失败)" : null));

  const spec = crashSpec();
  const plan = compileScenePlan(spec);
  // ★ 随机后缀:deploymentId **不落到任何共享文件**(只活在 mcode.db 的 payload 里),
  //   后两个进程不可能从入参 / 文件里捡到它 —— 只能从列表发现。
  const deploymentId = `dep_crash_${randomBytes(4).toString("hex")}`;
  const selfChecks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
  const sc = (name: string, cond: boolean, detail?: unknown): void => { selfChecks.push({ name, pass: cond, ...(detail === undefined ? {} : { detail }) }); };
  const r = await applyScene({
    deploymentId, spec, actor: ACTOR, grant: grantFor(plan.digest), compensateOnFailure: false,
  });
  sc("A:崩溃前的部署真的执行过(返回 applied)", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    sc("A:整体 PARTIAL(工作流成、触发器败)", r.deployment.status === "partial", r.deployment.status);
    sc("A:工作流步 done", r.deployment.steps.find((s) => s.actionId === CRASH_WF)?.status === "done");
    sc("A:触发器步 failed", r.deployment.steps.find((s) => s.actionId === CRASH_AUTO)?.status === "failed");
  }
  const onDisk = loadDeployment(deploymentId);
  sc("A:半成品记录真的在盘上(PARTIAL)", onDisk?.status === "partial", onDisk?.status);
  sc("A:盘上记录带声明快照(重启后从零发现链的起点)", onDisk?.specSnapshot !== undefined);
  sc("A:崩溃前派发过 wf、auto 各一次", readCalls().join(",") === `${CRASH_WF},${CRASH_AUTO}`, readCalls());

  /* —— 两条对照记录(不派发任何 handler,只写盘) —— */
  // ① active:证明 resumableOnly 真的把「已完成」排除在外。
  const controlSpec = checked({
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId: CONTROL_SCENE,
    goal: "control",
    capabilities: [],
    resources: [{ kind: "workflow", id: CONTROL_WF, spec: wfDoc(CONTROL_WF, { name: "对照" }) }],
    acceptance: { description: "control", expectResourceIds: [CONTROL_WF] },
  });
  const controlPlan = compileScenePlan(controlSpec);
  let control = createDeployment({
    deploymentId: CONTROL_ID, plan: controlPlan, actor: ACTOR, now: Date.now(),
    specSnapshot: { spec: controlSpec, specDigest: controlPlan.specDigest },
  });
  control = advanceDeployment(control, { actionId: CONTROL_WF, status: "done" }, Date.now());
  control = evaluateAcceptance(control, [CONTROL_WF], [CONTROL_WF], Date.now());
  sc("A:active 对照记录落盘", saveDeployment(control, { durable: true }) === true);

  // ② 坏存档行:payload 坏,但 status 投影列写 'partial'(SQL 的 resumableOnly 仍会捞到它)。
  SceneDeploymentRepo.save({
    deploymentId: BAD_ARCHIVE_ID, sceneId: BAD_ARCHIVE_SCENE, status: "partial",
    specDigest: "x", planDigest: "y", payload: "{这条存档坏掉了",
  });
  sc("A:坏存档行已写入", SceneDeploymentRepo.get(BAD_ARCHIVE_ID) !== null);

  // 自检结论 + 坏行的 microtask 落盘,**先钉到磁盘**再赴死。结果里**刻意不带 deploymentId**
  // (B 只能从盘上的列表发现它,不许从这个文件捡)。
  writeFileSync(crashResultFile(), JSON.stringify({ sceneId: CRASH_SCENE, checks: selfChecks }), "utf8");
  commitNow();

  // ★ 模拟**进程被杀**(真正死在中途,不是正常跑完):kill 之后的第 15 行若被执行,
  //   B 会看到 CRASH_SURVIVED 并判红。
  process.kill(process.pid, "SIGKILL");
  writeFileSync(survivedFile(), "进程没有真的死掉(kill 未生效)", "utf8");
  process.exit(0);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * 进程 B(discover-resume):入参只有模式名,从盘上发现 → 重新授权 → 续跑
 * ═══════════════════════════════════════════════════════════════════════════════ */
async function runDiscoverResume(): Promise<void> {
  assembleGrantStore(dataRoot());
  await initDb();
  clearRpcHandlers();

  /* ⓪ 进程 A 真的死在中途(它自己活不到断言,结论由它死前落盘的自检给出)。 */
  check("★★ 崩溃进程没有跑到「幸存标记」(kill 真的生效了)", !existsFile(survivedFile()));
  let crashChecks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
  try {
    crashChecks = (JSON.parse(readFileSync(crashResultFile(), "utf8")) as { checks: typeof crashChecks }).checks;
  } catch { /* 文件不在 = 下面的断言会红 */ }
  check("★★ 崩溃进程死前落盘了自检结论(说明它真跑过那一段)", crashChecks.length > 0);
  for (const c of crashChecks) check(c.name, c.pass, c.detail);

  /* ① 从零发现:没有 sceneId / deploymentId,只有跨场景列表。 */
  const listed = listRecentDeploymentEntries(20, { resumableOnly: true });
  const listedIds = listed.map((e) => e.deploymentId);
  check(
    "★ 可续跑列表里没有 active 对照记录(resumableOnly 真的在 SQL 层收窄)",
    !listed.some((e) => e.deploymentId === CONTROL_ID),
    listedIds,
  );
  check(
    "★ 可续跑列表里每一条要么可续跑、要么是坏存档行(没有别的 active/failed 混进来)",
    listed.every((e) => e.resumable || e.deploymentId === BAD_ARCHIVE_ID),
    listed.map((e) => ({ id: e.deploymentId, resumable: e.resumable, status: e.status })),
  );
  const bad = listed.find((e) => e.deploymentId === BAD_ARCHIVE_ID);
  check("★ 坏存档行仍被列出(它存在过是真的)", bad !== undefined, listedIds);
  check(
    "★ 坏存档行 resumable=false 且没有可读部署(不假装能续跑)",
    bad?.resumable === false && bad?.deployment === null,
    bad,
  );
  const candidates = listed.filter((e) => e.resumable && e.deployment !== null);
  eq("★ 真正可续跑的只有崩溃那条(坏行不会被选中)", candidates.length, 1);
  const sel = candidates[0];
  check("★ 坏存档行没有被选成续跑对象", sel !== undefined && sel.deploymentId !== BAD_ARCHIVE_ID, sel?.deploymentId);
  if (sel === undefined || sel.deployment === null) { finish("B"); return; }
  const record = sel.deployment;

  /* ② B 真的没有入参里的 deploymentId(它是从列表里拿的)。 */
  const argvText = process.argv.slice(2).join(" ");
  check(
    "★ B 的入参只有模式名,不含 deploymentId(不是外部喂进来的)",
    argvText === "discover-resume" && !argvText.includes(sel.deploymentId),
    argvText,
  );
  check(
    "★ B 的环境变量里也没有 deploymentId(只能从盘上列表发现)",
    !JSON.stringify(process.env).includes(sel.deploymentId),
  );
  eq("★ 发现的正是盘上那条半成品(PARTIAL)", record.status, "partial");

  /* ③ 发现链闭合:记录里的 specSnapshot → 重编译 → planDigest 与记录一致。 */
  check("★ 记录带声明快照(用户重启后手里没有任何别的地方能拿到它)", record.specSnapshot !== undefined);
  const snapshot = record.specSnapshot;
  if (snapshot === undefined) { finish("B"); return; }
  const validation = validateSceneSpec(snapshot.spec);
  check("★ 快照本身通过校验(可以直接放回预览)", validation.ok === true, validation);
  if (!validation.ok) { finish("B"); return; }
  const spec = validation.spec;
  const plan = compileScenePlan(spec);
  eq("★ 快照重编译出的 planDigest 与盘上记录一致(发现链闭合)", plan.digest, record.planDigest);

  /* ④ 发现记录 ≠ 获得授权:先挂好宿主,再试一次「没有新授权」的续跑 —— 必须被拒。 */
  const host = loadHost();
  mountHost(host);
  const callsBefore = readCalls().length;
  const unauthorized = await resumeSceneWithGrant({
    deploymentId: sel.deploymentId, grantId: "grant-does-not-exist", spec, actor: ACTOR,
  });
  check(
    "★★ 没有授权 → resume 被拒(不能凭「发现了记录」就执行)",
    unauthorized.ok === false && unauthorized.kind === "refused",
    unauthorized,
  );
  if (unauthorized.ok === false && unauthorized.kind === "refused") {
    eq("拒绝码 = no_grant", unauthorized.refusal.code, "no_grant");
  }
  eq("★ 被拒的续跑一个 handler 都没派发", readCalls().length, callsBefore);

  /* ⑤ 重新预览 + 签发计划级授权 → 续跑。 */
  const approved = approveSceneDeployment({ spec, planDigest: plan.digest, ttlMs: 60_000 });
  check("★ 重新签发计划级授权(granted)", approved.ok === true && approved.kind === "granted", approved);
  if (!(approved.ok && approved.kind === "granted")) { finish("B"); return; }

  const r = await resumeSceneWithGrant({
    deploymentId: sel.deploymentId, grantId: approved.grantId, spec, actor: ACTOR,
  });
  check("★ 持新授权 → 真的续跑(applied)", r.ok === true && r.kind === "applied", r);
  if (r.ok && r.kind === "applied") {
    eq("★ 续跑后整体 ACTIVE", r.deployment.status, "active");
    eq("★ 续跑后验收通过", r.deployment.acceptance?.passed, true);
    check("★ 两步都 done", r.deployment.steps.every((s) => s.status === "done"), r.deployment.steps);
  }

  /* ⑥ 核心判据:calls.log 的 handler 派发次数(不是记录里的状态)。 */
  const calls = readCalls();
  eq("★★ 已 done 的 wf 全程只被派发一次(没有被重跑)", calls.filter((c) => c === CRASH_WF).length, 1);
  eq("★★ auto 全程恰好两次(崩溃前一次 + 续跑一次)", calls.filter((c) => c === CRASH_AUTO).length, 2);
  eq("★★ 总派发序列 = wf, auto, auto", calls.join(","), `${CRASH_WF},${CRASH_AUTO},${CRASH_AUTO}`);
  eq("★ 续跑这一进程只新增了一次派发(auto)", calls.slice(callsBefore).join(","), CRASH_AUTO);

  const finalHost = loadHost();
  check("★ 磁盘宿主快照里最终两条资源都在", finalHost.has(CRASH_WF) && finalHost.has(CRASH_AUTO), [...finalHost.keys()]);
  eq("★ 续跑后盘上记录也是 ACTIVE", loadDeployment(sel.deploymentId)?.status, "active");

  finish("B");
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * 进程 C(verify):全新进程再读一次盘,断言最终状态与验收
 * ═══════════════════════════════════════════════════════════════════════════════ */
async function runVerify(): Promise<void> {
  await initDb();

  check("C 的入参只有模式名(verify)", process.argv.slice(2).join(",") === "verify");
  const all = listRecentDeploymentEntries(50);
  const crash = all.filter((e) => e.sceneId === CRASH_SCENE && e.deployment !== null);
  eq("C:新进程不用任何入参,按盘上场景重新发现崩溃部署(恰好一条)", crash.length, 1);
  const entry = crash[0];
  if (entry === undefined || entry.deployment === null) { finish("C"); return; }

  eq("★ C:最终状态 ACTIVE", entry.deployment.status, "active");
  eq("★ C:验收通过", entry.deployment.acceptance?.passed, true);
  eq("★ C:验收没有缺失资源", (entry.deployment.acceptance?.missing ?? []).join(","), "");
  check("★ C:两步都 done", entry.deployment.steps.every((s) => s.status === "done"), entry.deployment.steps);
  check("★ C:记录仍带声明快照(下次重启还能发现)", entry.deployment.specSnapshot !== undefined);

  const calls = readCalls();
  eq("★★ C:已 done 的 wf 全程只被派发一次(handler 次数判据)", calls.filter((c) => c === CRASH_WF).length, 1);
  eq("★★ C:auto 全程恰好两次", calls.filter((c) => c === CRASH_AUTO).length, 2);
  eq("★★ C:总派发序列 = wf, auto, auto", calls.join(","), `${CRASH_WF},${CRASH_AUTO},${CRASH_AUTO}`);

  const bad = all.find((e) => e.deploymentId === BAD_ARCHIVE_ID);
  check(
    "★ C:坏存档行仍列出,但 resumable=false 且读不回来",
    bad !== undefined && bad.resumable === false && bad.deployment === null,
    bad,
  );
  const control = all.find((e) => e.deploymentId === CONTROL_ID);
  eq("★ C:active 对照记录仍是 active", control?.deployment?.status, "active");
  eq("★ C:active 对照记录不可续跑", control?.resumable, false);

  const finalHost = loadHost();
  check("★ C:磁盘宿主快照里最终两条资源都在", finalHost.has(CRASH_WF) && finalHost.has(CRASH_AUTO), [...finalHost.keys()]);

  finish("C");
}

/* ───────────────────────── 模式分派(每个进程只跑自己那一段,早退) ───────────────────────── */

function finish(label: string): void {
  console.log(`\n[${label}] ${total - failures}/${total} 通过`);
  process.exit(failures > 0 ? 1 : 0);
}

const MODE = process.argv[2] ?? "";
if (MODE === "crash") await runCrash();
else if (MODE === "discover-resume") await runDiscoverResume();
else if (MODE === "verify") await runVerify();
else {
  console.error("用法: smoke.mjs crash|discover-resume|verify");
  process.exit(2);
}
