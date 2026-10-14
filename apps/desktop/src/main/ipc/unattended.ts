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
 *
 * ## 【MC-059 残余 ②】发起者身份不再写死
 *
 * `unattended.run` 从前把执行报告的 `actorId` 写死成常量 `"unattended.ipc"`(追不到「谁点的」)。
 * 现在由 {@link resolveUnattendedInitiator} 从一枚**宿主核实得动**的坐标产出(真实会话 id /
 * IPC 事件的 sender)—— 给坐标就核实,核不到即拒;调用方**给不了身份**(见该函数)。
 *
 * ## 【MC-059 残余 ④】跨重启面(独立命名空间 `unattendedPlans`)
 *
 * 计划的**正文**由 `appServices/unattendedPlanStore.ts` 落盘(`<数据根>/appControl/
 * unattended-plans.json`),于是进程重启后能**列出**「等待批准 / 待执行」的计划、**续跑**
 * (跳过已建成、只跑剩下的)或**明确放弃**。这三条落在**独立命名空间**(不塞进既有 `unattended`):一来它们是「重启后才用得上的发现 / 治理动作」,与 approve/run 不是一回事;二来
 * 独立命名空间在手机端 `webApi.ts` 的 Proxy 兜底里**自然**变 unsupported,不必去改那个
 * 「手机端故意不做」的渲染端文件(与 `unattended.*` 靠 `satisfies` 显式列出不同)。
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { IPC } from "@contracts/ipc";
import {
  UnattendedApproveInputSchema,
  UnattendedRunInputSchema,
  UnattendedResumeInputSchema,
  UnattendedAbandonInputSchema,
} from "@contracts/ipc/unattended.js";
import { SessionRepo } from "@main/store/repositories.js";
import {
  SESSION_CREATE_METHOD,
} from "@main/appServices/sessionCommands.js";
import {
  approveUnattendedPlan,
  abandonUnattendedPlan,
  listUnattendedPlans,
  resumeUnattendedPlanWithGrant,
  runUnattendedPlanWithGrant,
  type UnattendedOperation,
} from "@main/appServices/unattendedTaskPlan.js";

/**
 * **解析这次无人值守运行的发起者标识**(MC-059 残余 ②)—— 从一枚**宿主核实得动**的坐标产出,
 * **绝不让调用方自填身份**。
 *
 * ## 从前为什么是写死的
 *
 * 桌子 IPC 没有会话上下文,所以上一轮把 `actorId` 写死成 `"unattended.ipc"` —— 一个**常量**。
 * 它能把「这一次无人值守运行」对账到某个标识,但那标识(①)不指向任何一次真实的 UI 动作、
 * (②)每次运行都一样,追不到「用户本人在哪条会话里点的执行」。
 *
 * ## 现在怎么产出可追溯的发起者(两条来源,都**由宿主产生**)
 *
 *  1. **优先**:渲染端在入参里给 `initiatorSessionId`(它**坐**在哪条会话里点的「执行」)——
 *     但这只是一枚**坐标**,不是身份:宿主拿它去 `SessionRepo.get` **核实这条会话真的存在**,
 *     存在才认,产出 `session:<id>`;不存在 = 一枚伪造的坐标 → **拒绝执行**(`unknown_initiator`),
 *     **绝不**把它当成一个能用的身份字符串放行(硬规矩 3:坏东西显式报出来)。
 *  2. **缺省**:没给坐标时,退回按 **IPC 事件本身的 `sender`**(发起这次调用的渲染进程
 *     webContents)派生 `desktop:wc:<id>` —— 这也是宿主事实,不是调用方能自填的字符串。
 *     无 `sender`(如无头测试的 fakeIpc)时退回稳定的 `desktop`。
 *
 * @returns 可信的发起者标识;若给了坐标却核不到那条会话 → `null`(调用方据此拒绝执行)。
 */
export function resolveUnattendedInitiator(event: IpcMainInvokeEvent | null, initiatorSessionId?: string): string | null {
  if (initiatorSessionId !== undefined) {
    const session = SessionRepo.get(initiatorSessionId);
    if (!session) return null; // 伪造的坐标 —— 拒绝,不静默采信
    return `session:${initiatorSessionId}`;
  }
  const wcId = (event as { sender?: { id?: unknown } } | null)?.sender?.id;
  return typeof wcId === "number" ? `desktop:wc:${wcId}` : "desktop";
}

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
  ipc.handle(IPC.UNATTENDED_RUN, (event, raw) => {
    const input = UnattendedRunInputSchema.parse(raw);
    // 【MC-059 残余 ②】发起者标识由**宿主**从一枚可信坐标产出(渲染端坐在哪条会话里点的执行 /
    // IPC 事件的 sender)—— **绝不让调用方自填身份**。给了坐标却核不到那条会话 → 拒绝执行。
    const initiator = resolveUnattendedInitiator(event, input.initiatorSessionId);
    if (initiator === null) {
      return {
        ok: false as const,
        kind: "refused" as const,
        code: "unknown_initiator",
        reason: `入参里的发起会话「${input.initiatorSessionId}」不存在 —— 发起者身份须可追溯到一次真实的用户动作,拒绝执行,一步不建。`,
      };
    }
    return runUnattendedPlanWithGrant(
      {
        planId: input.planId,
        projectId: input.projectId,
        operations: input.operations.map(toOperation),
        maxCount: input.maxCount,
        grantId: input.grantId,
      },
      // actorId 只用于执行报告 / 对账,不参与判定(判定看的是授权);它现在是**可追溯**的
      // 发起者(真实会话 id 或发起这次调用的 webContents),不再是写死的常量。
      initiator,
    );
  });
  // 【MC-059 残余 ④】**列出等待批准 / 待执行**的计划(跨重启)—— 只读,一步不执行。
  ipc.handle(IPC.UNATTENDED_PLANS_LIST, () => {
    return { plans: listUnattendedPlans() };
  });
  // 【MC-059 残余 ④】**续跑**一份等待中的计划 —— 只给 planId,正文与授权由服务函数从存档 +
  // `GrantStore` 取回(取不到即拒、一步不建)。已建成的操作**跳过**(不重复外部副作用)。
  ipc.handle(IPC.UNATTENDED_PLANS_RESUME, (event, raw) => {
    const input = UnattendedResumeInputSchema.parse(raw);
    // 续跑也要一个可追溯的发起者(进执行报告,不参与判定)—— 与 run 同一条纪律:给坐标就核实。
    const initiator = resolveUnattendedInitiator(event, input.initiatorSessionId);
    if (initiator === null) {
      return {
        ok: false as const,
        kind: "refused" as const,
        code: "unknown_initiator",
        reason: `入参里的发起会话「${input.initiatorSessionId}」不存在 —— 发起者身份须可追溯到一次真实的用户动作,拒绝续跑,一步不建。`,
      };
    }
    return resumeUnattendedPlanWithGrant(input.planId, initiator);
  });
  // 【MC-059 残余 ④】**明确放弃**一份等待中的计划(不再列出、不再可续跑)。幂等。
  ipc.handle(IPC.UNATTENDED_PLANS_ABANDON, (_event, raw) => {
    const input = UnattendedAbandonInputSchema.parse(raw);
    return { planId: input.planId, abandoned: abandonUnattendedPlan(input.planId) };
  });
}
