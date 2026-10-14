/**
 * **无人值守任务计划的 IPC handler**(MC-059 的用户可达通道)。
 *
 * 这一层很薄,照 `ipc/scene.ts` 的 `SCENE_APPROVE` / `SCENE_APPLY` 那两条抄 ——
 * **校验入参 → 调 `appServices/unattendedTaskPlan.ts` → 返回**。计划语义(有界操作序列、
 * 判据、执行监督)都在那边,这里不重复实现(同一套规则有两个地方会漂移)。
 *
 * ## 这两条是「用户点头」的落点,agent 够不到(三层防线)
 *
 *   ① agent 侧 `app_api_call` 的 policy 判 **blocked**(`appControl/policy.ts` 把
 *      `unattended.approve` / `unattended.run` 显式钉在 BLOCKED 表里 —— 它们不在
 *      `API_CATALOG` 的 `POLICY` 兜底之外,不显式钉就会被动词兜底猜成 `write` 并弹卡);
 *   ② 签发主体由本 handler **写死为 user**(`approveUnattendedPlan` 自己补 `actor`,调用方
 *      的 schema 里根本没有 `actor` 字段 —— 给不了、也改不了);
 *   ③ `runUnattendedPlanWithGrant` 只认 `GrantStore` **取回**的授权(收不到自填的授权内容),
 *      取不到一律拒绝执行、一步不建。
 *
 * 渲染端的 `window.api.unattended.*` 走的就是这里;手机端 `webApi.ts` 显式 unsupported
 * (批准一份会真的建会话 / 发首条的计划,是坐在那台机器前的动作)。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { UnattendedApproveInputSchema, UnattendedRunInputSchema } from "@contracts/ipc/unattended.js";
import {
  SESSION_CREATE_METHOD,
} from "@main/appServices/sessionCommands.js";
import {
  approveUnattendedPlan,
  runUnattendedPlanWithGrant,
  type UnattendedOperation,
} from "@main/appServices/unattendedTaskPlan.js";

/**
 * 把契约里的操作声明翻成计划的操作 —— **`method` 由宿主写死为 `session.create`**。契约里
 * 的操作 schema 根本没有 `method` 字段,调用方给不了别的动作,也就夹带不了别的方法。
 */
function toOperation(op: {
  operationId: string;
  title?: string;
  prompt?: string;
  expectedRevision?: string;
}): UnattendedOperation {
  return {
    operationId: op.operationId,
    method: SESSION_CREATE_METHOD,
    ...(op.title !== undefined ? { title: op.title } : {}),
    ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
    ...(op.expectedRevision !== undefined ? { expectedRevision: op.expectedRevision } : {}),
  };
}

export function registerUnattendedHandlers(ipc: IpcMain): void {
  // 【MC-059】**用户签发计划级授权** —— 用户在无人值守计划预览页本人点「批准」的落点。
  // 签发主体在服务函数里**写死为 user**,调用方给不了身份。
  ipc.handle(IPC.UNATTENDED_APPROVE, (_event, raw) => {
    const input = UnattendedApproveInputSchema.parse(raw);
    return approveUnattendedPlan({
      planId: input.planId,
      projectId: input.projectId,
      operations: input.operations.map(toOperation),
      ttlMs: input.ttlMs,
      maxCount: input.maxCount,
    });
  });
  // 【MC-059】**执行已批准的计划** —— 授权**不给内容、只给 id**,由服务函数从 `GrantStore`
  // 取回;取不到一律拒绝执行、一步不建(与 `scene.apply` 同一条纪律)。
  ipc.handle(IPC.UNATTENDED_RUN, (_event, raw) => {
    const input = UnattendedRunInputSchema.parse(raw);
    return runUnattendedPlanWithGrant(
      {
        planId: input.planId,
        projectId: input.projectId,
        operations: input.operations.map(toOperation),
        maxCount: input.maxCount,
        grantId: input.grantId,
      },
      // actorId 只用于执行报告 / 对账,不参与判定(判定看的是授权)—— 桌面 IPC 无会话上下文,
      // 故留一个稳定标识;真起无人值守运行的调用方(未来)可换成真实发起者 id。
      "unattended.ipc",
    );
  });
}
