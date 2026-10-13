import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { SceneApplyInputSchema, SceneApprovalInputSchema } from "@contracts/ipc/scene.js";
import { planScene } from "@main/appServices/scenePlanning.js";
import { preflightScene } from "@main/appServices/scenePreflight.js";
import { approveSceneDeployment, applySceneWithGrant } from "@main/appServices/sceneDeploy.js";

/** 【ARC-002 / MC-058】**只读**的场景规划:校验候选 SceneSpec 并编译出有序变更计划。
 *  不建资源、不申请授权(模型提出计划 ≠ 获得执行权限)。 */
export function registerSceneHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.SCENE_PLAN, (_event, input: Parameters<typeof planScene>[0]) => planScene(input));
  // 预检多的那一步是**能力预检**:把宿主已装配的清单喂给 sceneCapabilityPreflight,
  // 一次说清「缺什么」。同样只读 —— 不建资源、不装插件、不申请授权。
  ipc.handle(IPC.SCENE_PREFLIGHT, (_event, input: Parameters<typeof preflightScene>[0]) => preflightScene(input));

  // 【MC-058】**写**的两条 —— 用户签发计划级授权 + 正式部署入口。
  //
  // ⚠️ 这两条是「用户点头」的落点,**agent 够不到**:渲染端的 `window.api.scene.*` 走的就是这里;
  // agent 侧的 `app_api_call` 查 `policy.ts` 的 `policyFor`,`scene.approve` / `scene.apply` 都不在
  // 那份 `API_CATALOG` 里(B 类通道),而它们不在 BLOCKED/DANGER 表里时按动词猜也猜不到 —— 见
  // `policy.ts` 里对这两条补的**显式 blocked** 档。真正的防线是三层:
  //   ① agent 侧 `app_api_call` 的 policy 判 blocked(拿不到);
  //   ② 签约主体由本 handler **写死为 user**(调用方给不了身份);
  //   ③ `applyScene` 的执行点只认 `GrantStore` 取回的授权,收不到自填的授权内容。
  ipc.handle(IPC.SCENE_APPROVE, (_event, raw) => {
    const input = SceneApprovalInputSchema.parse(raw);
    //  在 schema 里是 (可选) —— 显式补成 ,与  同形。
    return approveSceneDeployment({ spec: input.spec, planDigest: input.planDigest, ttlMs: input.ttlMs });
  });
  ipc.handle(IPC.SCENE_APPLY, async (_event, raw) => {
    const input = SceneApplyInputSchema.parse(raw);
    return applySceneWithGrant({
      deploymentId: input.deploymentId,
      grantId: input.grantId,
      spec: input.spec,
      actor: { actorKind: input.actorKind, actorId: input.actorId },
      ...(input.compensateOnFailure !== undefined ? { compensateOnFailure: input.compensateOnFailure } : {}),
    });
  });
}
