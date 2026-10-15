/**
 * 场景部署 —— scene_deployments 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";

/* ────────────────────────── 场景部署(MC-058)────────────────────────────── */

/**
 * **一条场景部署的持久事实** —— `scene_deployments` 表里的一行。
 *
 * 这一层**只管存储**:与 `workflow_runs` 对 `RunSnapshot` 同一条边界 —— 表里只留一个
 * `payload`(整条 `SceneDeployment` 的 JSON)+ 几个**可查询投影列**(sceneId / status /
 * 两个 digest,便于"按场景列 / 按状态筛"而不必每次解 JSON)。形状的编码 / 解码 + 强校验收在
 * `@main/appServices/sceneDeploymentStore.ts` 一处,这一层不认识 `SceneDeployment` 的内容。
 *
 * `status` 是**投影**不是第二份真相:它按定义由各步推导(见 `deriveDeploymentStatus`),
 * 落盘时抄一份、解码时重算,两者永远一致。
 */
export interface SceneDeploymentRow {
  deploymentId: string;
  sceneId: string;
  /** 可查询投影 —— 整体状态由各步推导,同 `SceneDeployment.status`。 */
  status: string;
  specDigest: string;
  planDigest: string;
  /** JSON:`SceneDeployment`。消费层不认识编码。 */
  payload: string;
  createdAt: number;
  updatedAt: number;
}

interface SceneDeploymentDbRow {
  deployment_id: string;
  scene_id: string;
  status: string;
  spec_digest: string;
  plan_digest: string;
  payload: string;
  created_at: number;
  updated_at: number;
}

function rowToSceneDeployment(r: SceneDeploymentDbRow): SceneDeploymentRow {
  return {
    deploymentId: r.deployment_id,
    sceneId: r.scene_id,
    status: r.status,
    specDigest: r.spec_digest,
    planDigest: r.plan_digest,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const SceneDeploymentRepo = {
  /**
   * 写下一条部署**此刻的样子**(第一次写就是建行;`deploymentId` 是主键,重试沿用同一个 id)。
   *
   * 与 `WorkflowRunRepo.save` 同款:`created_at` 只在第一次写时定下(upsert 的 DO UPDATE
   * 不碰它),所以它是"这次部署什么时候开始的";`updated_at` 每次覆盖都刷新。
   *
   * `status` 由调用方(消费层,从各步推导后)传入 —— 这里只把这三列当**投影**存下来。
   */
  save(args: {
    deploymentId: string;
    sceneId: string;
    status: string;
    specDigest: string;
    planDigest: string;
    payload: string;
  }): void {
    const now = Date.now();
    getDb().run(
      `INSERT INTO scene_deployments
         (deployment_id, scene_id, status, spec_digest, plan_digest, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deployment_id) DO UPDATE SET
         scene_id    = excluded.scene_id,
         status      = excluded.status,
         spec_digest = excluded.spec_digest,
         plan_digest = excluded.plan_digest,
         payload     = excluded.payload,
         updated_at  = excluded.updated_at`,
      [
        v(args.deploymentId),
        v(args.sceneId),
        v(args.status),
        v(args.specDigest),
        v(args.planDigest),
        v(args.payload),
        v(now),
        v(now),
      ],
    );
    persist();
  },

  /** 一条部署。没有返回 null。 */
  get(deploymentId: string): SceneDeploymentRow | null {
    const stmt = getDb().prepare("SELECT * FROM scene_deployments WHERE deployment_id = ?");
    stmt.bind([v(deploymentId)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SceneDeploymentDbRow) : null;
    stmt.free();
    return row ? rowToSceneDeployment(row) : null;
  },

  /** 某个场景的全部部署,新的在前(重试是同一个 id 的覆盖,所以这里每个 id 只出现一次)。 */
  listByScene(sceneId: string, limit: number): SceneDeploymentRow[] {
    const stmt = getDb().prepare(
      `SELECT * FROM scene_deployments
        WHERE scene_id = ?
        ORDER BY updated_at DESC, deployment_id DESC LIMIT ?`,
    );
    stmt.bind([v(sceneId), v(limit)]);
    const out: SceneDeploymentRow[] = [];
    while (stmt.step()) out.push(rowToSceneDeployment(stmt.getAsObject() as unknown as SceneDeploymentDbRow));
    stmt.free();
    return out;
  },

  /** 删一条(没有也不算错)—— 回滚这次新建的行 / 人工清理用。 */
  remove(deploymentId: string): void {
    getDb().run("DELETE FROM scene_deployments WHERE deployment_id = ?", [v(deploymentId)]);
    persist();
  },
};
