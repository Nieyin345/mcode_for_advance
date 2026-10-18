/**
 * Headless smoke for **场景部署的持久化**(MC-058 / ARC-002)。
 *
 * 被测:`@main/appServices/sceneDeploymentStore.ts`(`saveDeployment` / `loadDeployment` /
 * `decodeDeployment` / `encodeDeployment` / `listDeploymentsByScene`)+ `@main/store` 的
 * `SceneDeploymentRepo` + `scene_deployments` 表。
 *
 * ## 它验的是那些**只有真落一次盘才验得了**的东西
 *
 *  1. 一条 `SceneDeployment` 写进去、读回来,形状在 JSON 往返里一样没丢;
 *  2. `durable` 写在**独立句柄**上读得到(真的 fsync 过,不是排了个微任务);
 *  3. `durable` 落盘**物理失败**时返回 false,内存那一行**被回滚**(内存 == 磁盘),
 *     磁盘上那份旧存档一个字节没动;
 *  4. 覆盖写复用同一行(deploymentId 主键),不新开一行 —— 重试是覆盖不是堆行;
 *  5. 第二趟**全新进程**读回第一趟 durable 写下的那条 —— 跨进程持久。
 *
 * ## 为什么跑两遍
 *
 * 第 5 条按定义跨进程(sql.js 内存表重启即失)。`run.sh` 第一趟写、第二趟读。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 run-store-smoke/stubs/dataRoot.ts),
 * 那是 run.sh 用 `mktemp -d` 建的目录,跑完就删 —— `initDb()` 在路径不存在时会新建空库,
 * 指错地方就是拿空库盖掉用户数据。
 *
 * Run: scripts/scene-deploy-persist-smoke/run.sh
 */
import initSqlJs from "sql.js/dist/sql-asm.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { armFault, clearFault, faultHits } from "../db-persistence-smoke/stubs/fs.js";
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { SceneDeploymentRepo } from "@main/store/repositories.js";
import { validateSceneSpec, SCENE_SPEC_SCHEMA_VERSION, type SceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import {
  createDeployment,
  advanceDeployment,
  evaluateAcceptance,
  type SceneDeployment,
  type SceneDeploymentActor,
} from "@contracts/sceneDeployment";
import {
  encodeDeployment,
  decodeDeployment,
  saveDeployment,
  loadDeployment,
  listDeploymentsByScene,
  listDeploymentEntries,
  listRecentDeploymentEntries,
} from "@main/appServices/sceneDeploymentStore.js";
import { dataRoot, DATA_DB_FILENAME } from "../run-store-smoke/stubs/dataRoot.js";

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

/** 稳定序列化(对象 key 排序、数组保序)—— 用于**顺序无关**的深比较。 */
function canon(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x === undefined ? null : x;
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
    return out;
  };
  return JSON.stringify(walk(v));
}

const ACTOR: SceneDeploymentActor = { actorKind: "agent", actorId: "sess_1" };

/** 一份合法的「代码巡检」场景(定时触发器依赖巡检工作流)。 */
function plan(sceneId: string, wfId: string, autoId: string) {
  const raw: SceneSpec = {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId,
    goal: "每天检查代码、执行测试,失败后通知我",
    capabilities: [],
    resources: [
      { kind: "workflow", id: wfId, spec: { name: "代码巡检" } },
      { kind: "automation", id: autoId, spec: { cron: "0 9 * * *" }, dependsOn: [wfId] },
    ],
    acceptance: { description: "工作流与定时触发器都可见", expectResourceIds: [wfId, autoId] },
  };
  const v = validateSceneSpec(raw);
  if (!v.ok) throw new Error("前置场景不合法:" + JSON.stringify(v.problems));
  return { plan: compileScenePlan(v.spec), spec: v.spec };
}

/** 驱动状态机建一条**部分成功**的部署(工作流 done、触发器 failed → PARTIAL)。 */
function partialDeployment(deploymentId: string, sceneId: string, wfId: string, autoId: string): SceneDeployment {
  const { plan: p, spec: sceneSpec } = plan(sceneId, wfId, autoId);
  // 【MC-002】与生产 `applyScene` 一致:部署记录带声明快照(重启后 UI 靠它恢复输入框)。
  let d = createDeployment({ deploymentId, plan: p, actor: ACTOR, now: 1000, specSnapshot: { spec: sceneSpec, specDigest: p.specDigest } });
  d = advanceDeployment(d, { actionId: wfId, status: "running" }, 1100);
  d = advanceDeployment(d, { actionId: wfId, status: "done", resourceUid: `${wfId}_uid` }, 1200);
  d = advanceDeployment(d, { actionId: autoId, status: "running" }, 1300);
  d = advanceDeployment(d, { actionId: autoId, status: "failed", error: "cron 语法被拒" }, 1400);
  return d;
}

const SCENE = "code-inspect-daily";
const SCENE_B = "backup-daily";
const DEP_A = "dep_a";

const MODE = process.argv[2];
await initDb();

const dbFile = join(dataRoot(), DATA_DB_FILENAME);

/** 从**独立**句柄读磁盘上的 payload —— "提交没提交"的判据不能靠内存。 */
async function diskPayload(deploymentId: string): Promise<string | null> {
  const SQL = await initSqlJs();
  let copy: InstanceType<typeof SQL.Database>;
  try { copy = new SQL.Database(readFileSync(dbFile)); }
  catch { return null; }
  try {
    const stmt = copy.prepare("SELECT payload FROM scene_deployments WHERE deployment_id = ?");
    stmt.bind([deploymentId]);
    const payload = stmt.step() ? String(stmt.getAsObject().payload) : null;
    stmt.free();
    return payload;
  } catch { return null; } finally { copy.close(); }
}

function countRows(): number {
  const stmt = getDb().prepare("SELECT COUNT(*) AS n FROM scene_deployments");
  stmt.step();
  const n = Number((stmt.getAsObject() as { n: number }).n);
  stmt.free();
  return n;
}

if (MODE === "write") {
  /* ── 0. 表由迁移建出来 ── */
  {
    const stmt = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scene_deployments'");
    const exists = stmt.step();
    stmt.free();
    check("迁移建出 scene_deployments 表", exists);
  }

  /* ── 1. encode / decode 往返 fidelity ── */
  console.log("\n① 一条部署 JSON 往返:形状不丢");
  {
    const d = partialDeployment(DEP_A, SCENE, "wf_inspect", "auto_daily");
    const round = decodeDeployment(encodeDeployment(d));
    check("能解回来", round !== null);
    eq("★ 整条结构往返逐字段一致(顺序无关深比较)", round ? canon(round) : null, canon(d));
    eq("往返后仍是 PARTIAL(没被冲成 active)", round?.status, "partial");
    eq("往返后失败步的 error 保留", round?.steps[1]?.error, "cron 语法被拒");
    eq("往返后成功步的 resourceUid 保留", round?.steps[0]?.resourceUid, "wf_inspect_uid");
    eq("往返后 actor 保留", round ? canon(round.actor) : null, canon(ACTOR));
  }

  /* ── 2. 解码器拒坏形状(读侧唯一那份强校验) ── */
  console.log("\n② 解码器拒坏形状(不静默收下)");
  {
    check("非 JSON → null", decodeDeployment("{坏") === null);
    check("缺 steps → null", decodeDeployment(JSON.stringify({ deploymentId: "x", sceneId: "s", specDigest: "a", planDigest: "b", actor: ACTOR, createdAt: 1 })) === null);
    check("未知步骤状态 → null", decodeDeployment(JSON.stringify({
      deploymentId: "x", sceneId: "s", specDigest: "a", planDigest: "b", actor: ACTOR, createdAt: 1,
      steps: [{ actionId: "a", status: "bogus" }], acceptance: null,
    })) === null);
    check("非法 actorKind → null", decodeDeployment(JSON.stringify({
      deploymentId: "x", sceneId: "s", specDigest: "a", planDigest: "b", actor: { actorKind: "root", actorId: "z" }, createdAt: 1,
      steps: [], acceptance: null,
    })) === null);
  }

  /* ── 3. 整体状态**重新推导**,不信存档那一列 ── */
  console.log("\n③ 解码重算整体状态(存档里的 status 骗不过)");
  {
    const d = partialDeployment("dep_recompute", SCENE, "wf_inspect", "auto_daily");
    const tampered = JSON.stringify({ ...d, status: "active" }); // 手改成 active
    const round = decodeDeployment(tampered);
    eq("★ 存档被手改成 active,解码仍按各步推导为 PARTIAL", round?.status, "partial");
  }

  /* ── 4. durable 写到独立句柄可见 ── */
  console.log("\n④ durable 写:返回前已在磁盘(独立句柄读得到)");
  {
    const d = partialDeployment(DEP_A, SCENE, "wf_inspect", "auto_daily");
    eq("durable 写返回 true", saveDeployment(d, { durable: true }), true);
    const back = decodeDeployment((await diskPayload(DEP_A)) ?? "");
    check("★ 独立句柄上的磁盘 payload 解回来 == 落的那条", back !== null);
    eq("★ 磁盘上就是这一条(深比较)", back ? canon(back) : null, canon(d));
  }

  /* ── 5. 覆盖写复用同一行(deploymentId 主键),不堆行 ── */
  console.log("\n⑤ 重试/推进:覆盖同一行,不新开一行");
  {
    const advanced = advanceDeployment(
      partialDeployment(DEP_A, SCENE, "wf_inspect", "auto_daily"),
      { actionId: "auto_daily", status: "done", resourceUid: "auto_daily_uid" },
      1500,
    );
    const accepted = evaluateAcceptance(advanced, ["wf_inspect", "auto_daily"], ["wf_inspect", "auto_daily"], 1600);
    eq("覆盖写返回 true", saveDeployment(accepted, { durable: true }), true);
    eq("★ 同一个 deploymentId 仍只有一行", countRows(), 1);
    const back = loadDeployment(DEP_A);
    eq("★ 读回的是补全后的 ACTIVE", back?.status, "active");
    eq("★ 验收结果被持久化", back?.acceptance?.passed, true);
  }

  /* ── 6. 一个场景多条部署 + 场景隔离 ── */
  console.log("\n⑥ 列表按场景收窄");
  {
    const b = partialDeployment("dep_b", SCENE, "wf_inspect2", "auto_daily2");
    eq("另一条部署(同场景)写入成功", saveDeployment(b, { durable: true }), true);
    const c = partialDeployment("dep_other", SCENE_B, "wf_backup", "auto_backup");
    eq("另一场景的部署写入成功", saveDeployment(c, { durable: true }), true);

    const listA = listDeploymentsByScene(SCENE, 50);
    eq("★ 只列本场景的部署(2 条)", listA.length, 2);
    check("★ 不含别的场景的部署", listA.every((e) => e.sceneId === SCENE), listA.map((e) => e.deploymentId));
    check("列表项带解码后的部署", listA.every((e) => e.deployment !== null));
    const listB = listDeploymentsByScene(SCENE_B, 50);
    eq("另一场景各一条", listB.length, 1);
    eq("另一场景那条是 PARTIAL", listB[0]?.deployment?.status, "partial");
  }

  /* ── 7. corrupt 行:读不回来返回 null,不抛 ── */
  console.log("\n⑦ 库里被外部改坏的行:读回 null,不拖垮列表");
  {
    SceneDeploymentRepo.save({
      deploymentId: "dep_corrupt", sceneId: SCENE, status: "active",
      specDigest: "x", planDigest: "y", payload: "{不是合法 JSON",
    });
    eq("★ 坏行解码返回 null(不抛)", loadDeployment("dep_corrupt"), null);
    const list = listDeploymentsByScene(SCENE, 50);
    check("★ 坏行仍被列出(存在过是真的),但 deployment 为 null",
      list.some((e) => e.deploymentId === "dep_corrupt" && e.deployment === null));
    eq("坏行在列表里的 status 回退为投影列", list.find((e) => e.deploymentId === "dep_corrupt")?.status, "active");
    SceneDeploymentRepo.remove("dep_corrupt");
  }

  /* ── 8. durable 物理落盘失败:返回 false + 回滚内存 + 磁盘旧档不动 ── */
  console.log("\n⑧ durable 物理失败:不假报成功、磁盘旧档不动、内存回滚");
  {
    const v1 = partialDeployment("dep_fault", SCENE, "wf_f", "auto_f");
    eq("前置:V1 durable 写成功", saveDeployment(v1, { durable: true }), true);
    const diskV1 = (await diskPayload("dep_fault")) ?? "";
    check("前置:磁盘上有 V1", decodeDeployment(diskV1) !== null);

    const v2 = evaluateAcceptance(
      advanceDeployment(v1, { actionId: "auto_f", status: "done", resourceUid: "u" }, 2000),
      ["wf_f", "auto_f"], ["wf_f", "auto_f"], 2100,
    );
    armFault(dbFile, "write");
    let ok = true;
    try { ok = saveDeployment(v2, { durable: true }); } finally { clearFault(); }
    eq("★ 物理写失败 → durable 写返回 false(绝不假报成功)", ok, false);
    check("★ 故障确实击中了落盘", faultHits > 0);
    eq("★ 磁盘仍是 V1(逐字节未变)", (await diskPayload("dep_fault")) ?? "", diskV1);
    const mem = SceneDeploymentRepo.get("dep_fault");
    eq("★ 内存那一行被回滚(V2 的 active 没留在内存)", decodeDeployment(mem?.payload ?? "")?.status, "partial");

    // 故障解除后重试 → 成功,磁盘 == 内存(V2 真的落上)。
    eq("故障解除后重试返回成功", saveDeployment(v2, { durable: true }), true);
    eq("★ 重试成功后磁盘真的有了 V2", decodeDeployment((await diskPayload("dep_fault")) ?? "")?.status, "active");
  }

  /* ── 9. 编码失败一个字节都不落库(保住旧档) ── */
  console.log("\n⑨ 编码失败:不覆盖上一次有效存档");
  {
    const good = partialDeployment("dep_enc", SCENE, "wf_e", "auto_e");
    eq("前置:V1 落盘", saveDeployment(good, { durable: true }), true);
    const v1Disk = (await diskPayload("dep_enc")) ?? "";
    // 造一个**循环引用** → JSON.stringify 必抛。
    const circular = { ...good } as unknown as Record<string, unknown>;
    circular.self = circular;
    eq("★ 编码失败返回 false", saveDeployment(circular as unknown as SceneDeployment, { durable: true }), false);
    eq("★ 磁盘上的 V1 逐字节未变(没被覆盖)", (await diskPayload("dep_enc")) ?? "", v1Disk);
  }

  /* ── 10.【MC-002】声明快照:随记录落盘、往返保真、digest 不符整条拒收 ── */
  console.log("\n⑩ 声明快照:往返保真 / digest 不符拒收 / 旧记录兼容");
  {
    const d = partialDeployment("dep_snap", SCENE, "wf_s", "auto_s");
    check("生产形状带 specSnapshot", d.specSnapshot !== undefined);
    saveDeployment(d, { durable: true });
    const back = loadDeployment("dep_snap");
    check("★ 快照在磁盘往返后仍在", back?.specSnapshot !== undefined);
    eq("★ 快照 digest 与顶层 specDigest 一致", back?.specSnapshot?.specDigest, back?.specDigest);
    check("★ 快照里的声明能重新通过校验(重启后可直接恢复输入框)",
      validateSceneSpec(back?.specSnapshot?.spec).ok === true, back?.specSnapshot?.spec);

    // digest 不符:整条读不回来(一份对不上的快照比没有更糟)。
    const tampered = JSON.stringify({ ...d, specSnapshot: { spec: d.specSnapshot?.spec, specDigest: "scenespec:fnv1a:01020304" } });
    eq("★ 快照 digest 与记录不一致 → 解码拒收整条", decodeDeployment(tampered), null);

    // 旧记录(无快照)照常可读 —— 兼容不回退。
    const legacy = JSON.stringify({ ...d, specSnapshot: undefined });
    check("★ 没有快照的旧记录仍能解码(兼容)", decodeDeployment(legacy) !== null && decodeDeployment(legacy)?.specSnapshot === undefined);

    // 【MC-002】列表投影:resumable 只对 partial/failed 且存档可读为真(这是 IPC 线格
    // 判据的唯一一份,handler 只是包装)。
    const entries = listDeploymentEntries(SCENE, 50);
    const snapEntry = entries.find((e) => e.deploymentId === "dep_snap");
    eq("★ 列表投影:partial 记录标可续跑", snapEntry?.resumable, true);
    check("★ 列表投影:记录带声明快照(UI 可恢复输入)", snapEntry?.deployment?.specSnapshot !== undefined);
    const activeEntry = entries.find((e) => e.deploymentId === DEP_A);
    eq("★ 列表投影:active 记录不可续跑", activeEntry?.resumable, false);

    // 坏存档 → 行仍列出,但不可续跑(没有可续的起点)。
    SceneDeploymentRepo.save({
      deploymentId: "dep_broken_resume", sceneId: SCENE, status: "partial",
      specDigest: "x", planDigest: "y", payload: "{坏",
    });
    const broken = listDeploymentEntries(SCENE, 50).find((e) => e.deploymentId === "dep_broken_resume");
    check("★ 坏存档行仍列出,但 resumable=false(不假装能续跑)", broken !== undefined && broken.resumable === false && broken.deployment === null);
    SceneDeploymentRepo.remove("dep_broken_resume");

    // 【MC-002 第十七轮】崩溃后**从零发现**:用户手里没有 sceneId(粘贴的 spec 随
    // 进程消失),只有跨场景列表能找回盘上的 partial/failed。
    const recentAll = listRecentDeploymentEntries(50);
    check("★ 跨场景列表能列出盘上的记录(不依赖调用方给 sceneId)",
      recentAll.some((e) => e.deploymentId === "dep_snap"), recentAll.map((e) => e.deploymentId));
    const recentResumable = listRecentDeploymentEntries(50, { resumableOnly: true });
    check("★ 只取可续跑的:partial 在", recentResumable.some((e) => e.deploymentId === "dep_snap"));
    check("★ 只取可续跑的:active 不在", !recentResumable.some((e) => e.deploymentId === DEP_A));
    check("★ 跨场景项的投影形状与按场景一致(带 snapshot/resumable)",
      recentAll.find((e) => e.deploymentId === "dep_snap")?.deployment?.specSnapshot !== undefined,
      recentAll.find((e) => e.deploymentId === "dep_snap"));
    // 排序:新的在前(updated_at DESC)。dep_snap 是后写的,应排在旧记录之前。
    const idxSnap = recentAll.findIndex((e) => e.deploymentId === "dep_snap");
    const idxOld = recentAll.findIndex((e) => e.deploymentId === DEP_A);
    check("★ 跨场景按最近更新排序(新的在前)", idxSnap >= 0 && (idxOld < 0 || idxSnap < idxOld), { idxSnap, idxOld });
  }

  /* ── 11.【MC-002 复审】坏数据库读取≠空部署历史：必须显式报错 ── */
  console.log("\n⑪ 部署历史读取失败必须抛到 IPC：不许谎报没有待恢复记录");
  {
    const before = (await diskPayload("dep_snap")) ?? "";
    const recent = SceneDeploymentRepo.listRecent;
    const byScene = SceneDeploymentRepo.listByScene;
    const injected = "FAKE_DB_IO_ERROR_SCENE";
    try {
      SceneDeploymentRepo.listRecent = () => { throw new Error(injected); };
      SceneDeploymentRepo.listByScene = () => { throw new Error(injected); };
      let recentErr = "";
      let sceneErr = "";
      try { listRecentDeploymentEntries(20, { resumableOnly: true }); }
      catch (err) { recentErr = (err as Error).message; }
      try { listDeploymentEntries(SCENE, 20); }
      catch (err) { sceneErr = (err as Error).message; }
      check("★ 跨场景查最近部署：仓库读失败向调用方抛出，不能被包装为空表", recentErr.includes(injected), recentErr);
      check("★ 按 sceneId 查部署：同一种读取失败合同，不得另有静默空表", sceneErr.includes(injected), sceneErr);
    } finally {
      SceneDeploymentRepo.listRecent = recent;
      SceneDeploymentRepo.listByScene = byScene;
    }
    // MC-002: the single-record resume path and the save rollback pre-read
    // must also fail closed on I/O errors, not pretend the row is absent.
    const prevGet = SceneDeploymentRepo.get;
    const prevSave = SceneDeploymentRepo.save;
    let unexpectedSaveCalls = 0;
    try {
      SceneDeploymentRepo.get = () => { throw new Error(injected); };
      SceneDeploymentRepo.save = () => { unexpectedSaveCalls++; };
      let singleReadError = "";
      try { loadDeployment("dep_snap"); }
      catch (err) { singleReadError = (err as Error).message; }
      check("★ single deployment DB read error reaches the caller", singleReadError.includes(injected));
      const pending = partialDeployment("dep_snap", SCENE, "wf_s", "auto_s");
      eq("★ previous-record read error refuses a write before mutation",
        saveDeployment(pending, { durable: true }), false);
      eq("★ pre-read error causes zero writes", unexpectedSaveCalls, 0);
    } finally {
      SceneDeploymentRepo.get = prevGet;
      SceneDeploymentRepo.save = prevSave;
    }
    eq("★ 失败注入不动已有用户存档字节", (await diskPayload("dep_snap")) ?? "", before);
    check("★ 故障解除后跨场景仍能列出原记录",
      listRecentDeploymentEntries(20).some((entry) => entry.deploymentId === "dep_snap"));
  }

  console.log(`\n[write 阶段] 通过 ${total - failures}/${total}`);
  if (failures > 0) process.exitCode = 1;
  closeDb();
} else if (MODE === "verify") {
  /* ── 跨进程:第一趟 durable 写下的,新进程读回 ── */
  console.log("\n[verify] 新进程读回第一趟 durable 写下的部署");
  {
    const a = loadDeployment(DEP_A);
    check("★ 新进程能读回 dep_a", a !== null);
    eq("★ dep_a 是补全后的 ACTIVE", a?.status, "active");
    eq("★ dep_a 的验收通过", a?.acceptance?.passed, true);
    check("★ dep_a 两步都 done", (a?.steps ?? []).every((s) => s.status === "done"), a?.steps);

    const f = loadDeployment("dep_fault");
    eq("★ dep_fault 是重试补全后的 ACTIVE", f?.status, "active");

    const list = listDeploymentsByScene(SCENE, 50);
    check("★ 新进程里按场景列得出这几条", list.length >= 3, list.map((e) => e.deploymentId));

    // 名字对得上内容:fault 那条不应是别的。
    check("★ 列表里部署内容都能解码", list.every((e) => e.deployment !== null));
    // 【MC-002】跨进程:重启后新进程从盘上记录里拿得到当初那份声明(发现链的最后一步)。
    const snap = list.find((e) => e.deploymentId === "dep_snap")?.deployment?.specSnapshot;
    check("★ 新进程里从部署记录读回声明快照(重启后能恢复输入框)", snap !== undefined);
    eq("★ 读回的快照能重新通过校验", validateSceneSpec(snap?.spec).ok, true);
  }

  console.log(`\n[verify 阶段] 通过 ${total - failures}/${total}`);
  if (failures > 0) process.exitCode = 1;
  closeDb();
} else {
  throw new Error("用法: smoke.mjs write|verify");
}
