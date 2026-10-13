/**
 * **场景规划服务(只读)** —— ARC-002 / MC-058:把候选 SceneSpec 递进来,校验 + 编译成计划。
 *
 * 全仓此前 `validateSceneSpec` / `compileScenePlan` **没有任何生产调用方** —— 一条只在
 * smoke 里活着的纯函数。本服务给它们第一个真实消费者:Agent 把用户的一句话目标翻成候选
 * 声明,经这里拿到「哪里不合法」或「会按什么顺序建什么」,再决定要不要请用户批准。
 *
 * ## 这条命令**不执行任何东西**
 *
 * 只校验 + 编译。不建资源、不碰磁盘、不申请授权 —— 与 MC-058 拒绝验收的假方案(「模型
 * 说完成了就算完成」)正相反:模型提出计划 ≠ 获得执行权限。真正的 apply 是另一条命令,
 * 且必须带独立的计划级授权(ARC-004)。
 */
import { validateSceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import type { ScenePlanInput, ScenePlanResult } from "@contracts/ipc";

/**
 * 规划一份候选场景声明。校验**一次报全**;通过则编译成有序变更计划。
 *
 * 校验失败时返回**全部问题**(`{ok:false,problems}`),不抛 —— 让调用方(Agent)一次看全
 * 哪里要改,而不是来回试很多轮。编译绕开校验时的抛错(有环/悬空引用)在校验已过的前提下
 * 不可能发生;万一发生,如实冒出去(不吞)。
 */
export function planScene(input: ScenePlanInput): ScenePlanResult {
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) {
    return { ok: false, problems: validation.problems };
  }
  const plan = compileScenePlan(validation.spec);
  return {
    ok: true,
    plan: {
      sceneId: plan.sceneId,
      specDigest: plan.specDigest,
      digest: plan.digest,
      steps: plan.steps.map((s) => ({
        actionId: s.actionId,
        resourceId: s.resourceId,
        kind: s.kind,
        order: s.order,
        dependsOn: [...s.dependsOn],
        compensable: s.compensable,
        verifier: { kind: s.verifier.kind, resourceId: s.verifier.resourceId },
      })),
    },
  };
}
