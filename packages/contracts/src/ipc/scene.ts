/**
 * **场景规划(只读)** —— ARC-002 / MC-058 的 dry-run 规划入口。
 *
 * ## 它是什么
 *
 * 给定一份候选 `SceneSpec`(通常由某个 SDK Agent 把用户的一句话目标翻出来),**只做两件事**:
 *   1. 用 `validateSceneSpec` 做**确定性校验**(一次报全,不是遇到第一个就停);
 *   2. 校验通过时用 `compileScenePlan` **编译**出一份有序变更计划(拓扑排序 + 稳定 digest)。
 *
 * ## 它是**只读**的,这条写在名字里
 *
 * `scene.plan` 只规划、**不执行** —— 它不建任何资源、不碰磁盘、不申请授权。这正是 MC-058
 * 拒绝验收的那条假方案的反面:「模型提出计划 ≠ 获得执行权限」。真正的部署(apply)是**另一条**
 * 命令,且必须有独立的计划级授权(见 `@contracts/policyEngine` 与 ARC-004);本契约刻意**没有**
 * `apply`。
 *
 * ## 为什么要有它
 *
 * 在这之前,`validateSceneSpec` / `compileScenePlan` 是**没有任何生产调用方**的纯函数 ——
 * 一条只在 smoke 里活着的判据。本条 IPC 给了它们第一个真实消费者:Agent 把候选声明递进来,
 * 拿到「哪里不合法」或「会按什么顺序建什么」,再决定要不要请用户批准。
 */
import { z } from "zod";

/**
 * 规划入参:一份**候选** SceneSpec(形状先宽松收下,由 `validateSceneSpec` 做**业务**校验
 * 并把全部问题报回来 —— 用 zod 在这里卡形状只会把「哪里不合法」变成一句笼统的 parse error)。
 */
export const ScenePlanInputSchema = z.object({
  spec: z.unknown(),
});
export type ScenePlanInput = z.infer<typeof ScenePlanInputSchema>;

/** 规划结果:要么带上「全部问题」,要么带上一份编译好的计划。二选一,不并存。 */
export type ScenePlanResult =
  | { ok: false; problems: Array<{ path: string; message: string }> }
  | { ok: true; plan: ScenePlanWire };

/** 过 IPC 的计划形状(与 `@contracts/scenePlan` 的 `ScenePlan` 同形,这里显式给出契约面)。 */
export interface ScenePlanWire {
  sceneId: string;
  specDigest: string;
  digest: string;
  steps: Array<{
    actionId: string;
    resourceId: string;
    kind: string;
    order: number;
    dependsOn: string[];
    compensable: boolean;
    verifier: { kind: "exists"; resourceId: string };
  }>;
}
