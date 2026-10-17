/**
 * **场景部署的存档** —— 把一次 `SceneDeployment` 写成一行、再读回来,并让"写下去"这件事
 * 真的落到磁盘(MC-058 / ARC-002 的持久化切片)。
 *
 * ## 这一层补的洞
 *
 * `@contracts/sceneDeployment` 交付了 `SceneDeployment` 的形状与纯状态机,但它是**纯内存**的
 * —— 进程一关,「这次部署到底建成了什么、哪一步失败、验收过没过」就没了。部署报告、重启后的
 * 回读、按计划重试都需要它**跨重启**。本文件给它一条持久化路径,落进 `scene_deployments` 表
 * (见 `store/db.ts` 与 `store/repositories.ts` 的 `SceneDeploymentRepo`)。
 *
 * ## 边界(与 `runStore.ts` 对 `RunSnapshot` 同形)
 *
 * - **单一真相**:一条部署的真相是那一行 `payload`(整条 `SceneDeployment` 的 JSON)。表里
 *   `scene_id` / `status` / 两个 digest 是**可查询投影**,不是第二份。
 * - **读不回来不抛**:存档可能是更老的进程写的或被外部改坏。`decodeDeployment` 逐字段验形状,
 *   收不回来返回 `null`(那张部署当"读不到"),绝不让一份坏 JSON 把整个列表打不开。
 * - **整体状态一律重算**:`status` 按定义由各步推导(见 `deriveDeploymentStatus`),解码时**重新
 *   推导**,不信任存档里那一列 —— 存档被手改成 `active` 也骗不过这一步。
 * - **durable 闸门**:`saveDeployment({durable:true})` 走 `commitNow()` 的三态结果;**只有
 *   `DURABLE` 才 return true**;`APPLIED_NOT_DURABLE`(内存改了、磁盘没写)一律**回滚内存那一行
 *   + return false**,保住"内存 == 磁盘"这条不变量(与 `saveRun` 的 MC-053 反例三同款)。
 *
 * ## 这一层**不做**什么(MC-058 仍未关闭的部分)
 *
 * 只做**记录形状的持久化**。SceneCompiler(把声明翻成对现有服务的命令)、dryRun/apply/readback
 * API、真实资源回读均**未做** —— 没有"部署器来建资源然后写记录"的执行端,所以今天 `saveDeployment`
 * 的调用方是测试;等执行端切片落地时,它接的就是这里。
 */
import { log } from "@main/lib/logger.js";
import { SceneDeploymentRepo } from "@main/store/repositories.js";
import { commitNow } from "@main/store/db.js";
import {
  deriveDeploymentStatus,
  type SceneDeployment,
  type SceneDeploymentActor,
  type SceneDeploymentStep,
  type SceneDeploymentStatus,
  type SceneStepPriorExistence,
  type SceneStepStatus,
} from "@contracts/sceneDeployment";

const STEP_STATUSES: readonly SceneStepStatus[] = ["pending", "running", "done", "failed", "compensated"];
const PRIOR_EXISTENCES: readonly SceneStepPriorExistence[] = ["created", "preExisting", "unknown"];
const ACTOR_KINDS: readonly SceneDeploymentActor["actorKind"][] = ["user", "agent", "system"];

/** 编码:整条 `SceneDeployment` → 落 `payload` 的 JSON 串。 */
export function encodeDeployment(d: SceneDeployment): string {
  return JSON.stringify(d);
}

/**
 * 解码 + **逐字段强校验** —— 读侧这唯一一份校验。收不回来返回 `null`(不抛)。
 *
 * 判据一律是"形状对不对",不做业务判断。整体 `status` **重新推导**(不信存档那一列):
 * 存档里的 `status` 只能是各步的函数,若被写成别的,以推导值为准。
 */
export function decodeDeployment(raw: string): SceneDeployment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("scene deployment payload: 不是合法 JSON,读不回来");
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;

  if (typeof r.deploymentId !== "string" || r.deploymentId.length === 0) return null;
  if (typeof r.sceneId !== "string" || r.sceneId.length === 0) return null;
  if (typeof r.specDigest !== "string" || r.specDigest.length === 0) return null;
  if (typeof r.planDigest !== "string" || r.planDigest.length === 0) return null;

  const actorRaw = r.actor as { actorKind?: unknown; actorId?: unknown } | null;
  if (typeof actorRaw !== "object" || actorRaw === null) return null;
  if (!ACTOR_KINDS.includes(actorRaw.actorKind as SceneDeploymentActor["actorKind"])) return null;
  if (typeof actorRaw.actorId !== "string" || actorRaw.actorId.length === 0) return null;
  const actor: SceneDeploymentActor = {
    actorKind: actorRaw.actorKind as SceneDeploymentActor["actorKind"],
    actorId: actorRaw.actorId,
  };

  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;

  if (!Array.isArray(r.steps)) return null;
  const steps: SceneDeploymentStep[] = [];
  for (const s of r.steps) {
    if (typeof s !== "object" || s === null) return null;
    const step = s as Record<string, unknown>;
    if (typeof step.actionId !== "string" || step.actionId.length === 0) return null;
    if (!STEP_STATUSES.includes(step.status as SceneStepStatus)) return null;
    const out: SceneDeploymentStep = { actionId: step.actionId, status: step.status as SceneStepStatus };
    if (step.resourceUid !== undefined) {
      if (typeof step.resourceUid !== "string") return null;
      out.resourceUid = step.resourceUid;
    }
    if (step.error !== undefined) {
      if (typeof step.error !== "string") return null;
      out.error = step.error;
    }
    if (step.startedAt !== undefined) {
      if (typeof step.startedAt !== "number" || !Number.isFinite(step.startedAt)) return null;
      out.startedAt = step.startedAt;
    }
    if (step.finishedAt !== undefined) {
      if (typeof step.finishedAt !== "number" || !Number.isFinite(step.finishedAt)) return null;
      out.finishedAt = step.finishedAt;
    }
    // 派发前探测的三项(MC-058 补偿安全闸):形状不对就拒收整条(不静默吞成 undefined)。
    if (step.priorExistence !== undefined) {
      if (!PRIOR_EXISTENCES.includes(step.priorExistence as SceneStepPriorExistence)) return null;
      out.priorExistence = step.priorExistence as SceneStepPriorExistence;
    }
    if (step.priorRevision !== undefined) {
      if (step.priorRevision !== null && typeof step.priorRevision !== "string") return null;
      out.priorRevision = (step.priorRevision as string | null) ?? null;
    }
    if (step.createdRevision !== undefined) {
      if (step.createdRevision !== null && typeof step.createdRevision !== "string") return null;
      out.createdRevision = (step.createdRevision as string | null) ?? null;
    }
    if (step.compensation !== undefined) {
      const c = step.compensation as Record<string, unknown>;
      if (typeof c !== "object" || c === null) return null;
      if (typeof c.applied !== "boolean") return null;
      if (c.inverseLabel !== null && typeof c.inverseLabel !== "string") return null;
      if (typeof c.reason !== "string") return null;
      out.compensation = {
        applied: c.applied,
        inverseLabel: (c.inverseLabel as string | null) ?? null,
        reason: c.reason,
      };
    }
    steps.push(out);
  }

  // acceptance:null 或一份形状完整的验收结果。
  let acceptance: SceneDeployment["acceptance"] = null;
  if (r.acceptance !== null && r.acceptance !== undefined) {
    const a = r.acceptance as Record<string, unknown>;
    if (typeof a !== "object" || a === null) return null;
    const strArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x): x is string => typeof x === "string");
    if (!strArray(a.expected) || !strArray(a.observed) || !strArray(a.missing)) return null;
    if (typeof a.passed !== "boolean") return null;
    if (typeof a.checkedAt !== "number" || !Number.isFinite(a.checkedAt)) return null;
    acceptance = {
      expected: [...a.expected],
      observed: [...a.observed],
      missing: [...a.missing],
      passed: a.passed,
      checkedAt: a.checkedAt,
    };
  }

  // 【MC-002】声明快照(可选;旧存档没有就是 undefined)。有它时**必须**与顶层 specDigest
  // 一致 —— 一份对不上的快照比没有更糟:UI 会把它当"当初那份声明"恢复出来,而 digest
  // 说的却是另一份。不一致整条读不回来(与其它字段形状不对同档)。
  let specSnapshot: SceneDeployment["specSnapshot"];
  if (r.specSnapshot !== undefined && r.specSnapshot !== null) {
    const s = r.specSnapshot as Record<string, unknown>;
    if (typeof s !== "object" || s === null) return null;
    if (typeof s.specDigest !== "string" || s.specDigest !== r.specDigest) return null;
    if (s.spec === undefined) return null;
    specSnapshot = { spec: s.spec, specDigest: s.specDigest };
  }

  return {
    deploymentId: r.deploymentId,
    sceneId: r.sceneId,
    specDigest: r.specDigest,
    planDigest: r.planDigest,
    actor,
    createdAt: r.createdAt,
    // **重新推导**,不信存档里那一列 —— 它是各步的函数。
    status: deriveDeploymentStatus(steps),
    steps,
    acceptance,
    ...(specSnapshot === undefined ? {} : { specSnapshot }),
  };
}

/**
 * 把一条部署写下来(第一次写 = 建行)。**durable 时提交前的"内存已应用、磁盘没写"会被回滚**,
 * 返回值严格回答"这一份真的落盘了吗"。
 *
 * @param d 当前部署记录(deploymentId 是主键;重试是同一 id 的覆盖)。
 * @param opts.durable 为真时同步 fsync 整库 —— 与 `saveRun` 同一条 durable 语义。
 * @returns 正常写(非 durable)恒为 true;durable 时只在 `DURABLE` 提交后为 true。
 */
export function saveDeployment(d: SceneDeployment, opts: { durable?: boolean } = {}): boolean {
  let payload: string;
  try {
    payload = encodeDeployment(d);
  } catch (err) {
    // 编码失败 → 一个字节都不落库,保住上一次有效存档(与 saveRun 的 MC-053 同款)。
    log.warn(`scene deployment ${d.deploymentId}: 编码失败,保留上一次有效存档不动 ${(err as Error).message}`);
    return false;
  }
  // 「能编码」≠「写得进来」:把刚落盘的同一段 payload 交给读侧解码器走一趟,收不回来就拒写。
  if (decodeDeployment(payload) === null) {
    log.warn(`scene deployment ${d.deploymentId}: 存档结构通不过解码器校验,拒写以保住上一次有效存档`);
    return false;
  }

  // durable 落盘失败要回滚内存那一行(内存 == 磁盘的不变量,见 saveRun 的 MC-053 反例三)。
  let prevRow: ReturnType<typeof SceneDeploymentRepo.get> = null;
  try {
    prevRow = SceneDeploymentRepo.get(d.deploymentId);
  } catch (err) {
    log.warn(`scene deployment ${d.deploymentId}: 读取旧存档失败,落盘失败时将无法回滚 ${(err as Error).message}`);
  }
  try {
    SceneDeploymentRepo.save({
      deploymentId: d.deploymentId,
      sceneId: d.sceneId,
      status: d.status,
      specDigest: d.specDigest,
      planDigest: d.planDigest,
      payload,
    });
    if (opts.durable) {
      if (commitNow().outcome !== "DURABLE") {
        try {
          if (prevRow) {
            SceneDeploymentRepo.save({
              deploymentId: prevRow.deploymentId,
              sceneId: prevRow.sceneId,
              status: prevRow.status,
              specDigest: prevRow.specDigest,
              planDigest: prevRow.planDigest,
              payload: prevRow.payload,
            });
          } else {
            SceneDeploymentRepo.remove(d.deploymentId);
          }
        } catch (rollbackErr) {
          log.error(
            `scene deployment ${d.deploymentId}: 落盘失败且内存回滚也失败,本进程内存已污染 ` +
              `${(rollbackErr as Error).message}`,
          );
        }
        log.warn(`scene deployment ${d.deploymentId}: durable 提交未落盘,返回失败`);
        return false;
      }
    }
    return true;
  } catch (err) {
    log.warn(`scene deployment ${d.deploymentId}: 存档写不进去 ${(err as Error).message}`);
    return false;
  }
}

/** 读回一条部署(行 → 解码)。行不在 / 解码失败都返回 `null`。 */
export function loadDeployment(deploymentId: string): SceneDeployment | null {
  let row;
  try {
    row = SceneDeploymentRepo.get(deploymentId);
  } catch (err) {
    log.warn(`scene deployment ${deploymentId}: 读取失败 ${(err as Error).message}`);
    return null;
  }
  if (row === null) return null;
  return decodeDeployment(row.payload);
}

/** 场景部署列表里的一项 —— 存档读不回来时 `deployment` 为 `null`(那一行**仍然列出**)。 */
export interface SceneDeploymentListEntry {
  deploymentId: string;
  sceneId: string;
  /** 可查询投影(重建自消费层的推导,与 payload 应一致)。 */
  status: SceneDeploymentStatus;
  createdAt: number;
  updatedAt: number;
  /** 解码所得;读不回来为 `null`(那一行存在过是真的,只是没有可读的状态)。 */
  deployment: SceneDeployment | null;
}

/**
 * 【MC-002】**重启后发现的未完成部署** —— 给渲染端的投影(与 `scene.listDeployments` 的
 * 线格同形)。`resumable` 是**只读推导**:状态上还有没跑完的步骤 **且** 存档读得回来
 * (读不回来就无从续跑)。它**不是授权** —— 真正续跑仍要用户重新预览 + 批准。
 *
 * 投影住在 store 层而不是 IPC handler 里:同一份判据要让无头套件针对**真数据库**验证,
 * handler 也就只剩"解析入参 + 包装 ok/error"这一层(不复制判据)。
 */
export function listDeploymentEntries(sceneId: string, limit: number): Array<{
  deploymentId: string;
  sceneId: string;
  status: SceneDeploymentStatus;
  createdAt: number;
  updatedAt: number;
  deployment: SceneDeployment | null;
  resumable: boolean;
}> {
  return listDeploymentsByScene(sceneId, limit).map((entry) => ({
    deploymentId: entry.deploymentId,
    sceneId: entry.sceneId,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deployment: entry.deployment,
    resumable: entry.deployment !== null && (entry.deployment.status === "partial" || entry.deployment.status === "failed"),
  }));
}

/**
 * 某个场景的部署列表,新的在前。与 `runHistory` 同一取舍:读不回来的行**照样列出**
 * (`deployment: null`)—— 「这次部署存在过」这件事仍然是真的,凭空少一行更让人看不懂。
 */
export function listDeploymentsByScene(sceneId: string, limit: number): SceneDeploymentListEntry[] {
  let rows;
  try {
    rows = SceneDeploymentRepo.listByScene(sceneId, limit);
  } catch (err) {
    log.warn(`scene deployment list read failed: ${(err as Error).message}`);
    return [];
  }
  return rows.map((row) => {
    const deployment = decodeDeployment(row.payload);
    return {
      deploymentId: row.deploymentId,
      sceneId: row.sceneId,
      status: (deployment?.status ?? row.status) as SceneDeploymentStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deployment,
    };
  });
}
