import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { planScene } from "@main/appServices/scenePlanning.js";
import { preflightScene } from "@main/appServices/scenePreflight.js";

/** 【ARC-002 / MC-058】**只读**的场景规划:校验候选 SceneSpec 并编译出有序变更计划。
 *  不建资源、不申请授权(模型提出计划 ≠ 获得执行权限)。 */
export function registerSceneHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.SCENE_PLAN, (_event, input: Parameters<typeof planScene>[0]) => planScene(input));
  // 预检多的那一步是**能力预检**:把宿主已装配的清单喂给 sceneCapabilityPreflight,
  // 一次说清「缺什么」。同样只读 —— 不建资源、不装插件、不申请授权。
  ipc.handle(IPC.SCENE_PREFLIGHT, (_event, input: Parameters<typeof preflightScene>[0]) => preflightScene(input));
}
