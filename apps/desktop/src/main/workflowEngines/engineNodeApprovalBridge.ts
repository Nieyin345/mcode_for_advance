/**
 * 【ARC-006 Gate E】**节点安装审批桥** —— 主进程把一张安装审批卡推给渲染端，
 * 等它回答「批准 / 拒绝」，超时或无窗口一律 fail-closed。
 *
 * ## 为什么不是原生框
 *
 * `modules/moduleApproval.ts` 用的是原生确认框（`dialog.showMessageBox`），因为它要在
 * **任意时刻**（工作流后台执行）拿到点头。节点安装不同：它由用户**在设置页里主动点
 * 「安装」**发起，界面一定在，卡片放在面板里更说得清（能力声明、network、许可、
 * 哈希都是结构化字段）。所以本桥走**渲染端审批卡**，与 `moduleApproval` 同一条分工：
 * 主进程只发请求、收布尔，卡片怎么画是渲染端的事。
 *
 * ## 桥接法（复用仓库现有模式，不新造第二套）
 *
 * 与 `ApprovalBridge`（Claude 工具审批）同形：
 *   - 主进程 `request()` 生成 `requestId`，把 `{requestId, ...卡片字段}` 存进 pending Map，
 *     再经**推送通道** `workflowEngine:nodeInstallApproval` 发给渲染端；
 *   - 渲染端画卡，用户点「允许/拒绝」后调 **RPC** `workflowEngine.respondNodeInstallApproval`
 *     （带同一个 `requestId` + `approved`）；
 *   - handler 调 {@link resolve} 把 pending promise 兑现成布尔。
 *
 * 没有新增"第二种审批机制"：推送用的是本仓库 `MainToRendererMessage` 的同一套
 * （`sendToRenderer` → preload `on`），应答走的是普通 RPC handler。
 *
 * ## fail-closed
 *
 *   - 没有 `send` 端口（窗口未就绪 / 无头环境）→ 立刻 `false`；
 *   - 超时（默认 120 秒，本桥常量）→ `false` 并清掉 pending（迟到的应答找不到请求，
 *     不会误兑现下一次）；
 *   - `resolve` 找不到 `requestId` → 返回 `false`（不抛：这是"已经超时/被取消"的正常晚到）。
 *
 * ## 可测性
 *
 * `send` 端口注入；套件用假端口断言"审批请求真的发出去""超时 fail-closed""拒绝不落盘"。
 * 不 import electron。
 */
import { randomUUID } from "node:crypto";
import type {
  WorkflowEngineNodeInstallApprovalMessage,
  WorkflowEngineNodeInstallRespondInput,
} from "@contracts/ipc/workflowEngine";

/** 审批等待上限。安装是用户主动点的，界面一定在；给足但别无限等。 */
export const NODE_INSTALL_APPROVAL_TIMEOUT_MS = 120_000;

/** 发送端口（生产传 `sendToRenderer` 的包装；无头传假实现）。 */
export interface NodeInstallApprovalSender {
  /** 把审批卡推给渲染端。返回 false = 窗口不在（fail-closed）。 */
  send(message: WorkflowEngineNodeInstallApprovalMessage, expectedSenderId: number): boolean;
}

interface PendingInstallApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 只能由发起此次安装的受信窗口回答，requestId 自身不是授权。 */
  expectedSenderId: number;
}

export class NodeInstallApprovalBridge {
  private readonly pending = new Map<string, PendingInstallApproval>();
  private readonly sender: NodeInstallApprovalSender;
  private readonly timeoutMs: number;

  constructor(sender: NodeInstallApprovalSender, timeoutMs = NODE_INSTALL_APPROVAL_TIMEOUT_MS) {
    this.sender = sender;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 请求一次安装审批。**resolve 为 true 才算批准**；无窗口/超时都 resolve false。
   * 卡片字段来自调用方（`describeEngineNodeInstall` 的输出），本桥不加工。
   */
  request(card: Omit<WorkflowEngineNodeInstallApprovalMessage, "channel" | "requestId">, expectedSenderId: number): Promise<boolean> {
    // 不接受无身份/合成 IPC：Agent 不能通过随便填一个 requestId 获得真人授权。
    if (!Number.isSafeInteger(expectedSenderId) || expectedSenderId < 1) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        resolve(false);
      }, this.timeoutMs);
      // ⚠️ **不能 unref**：这个计时器就是"超时必然拒绝"的唯一保证。unref 之后
      // 事件循环里没有别的句柄时进程会直接退出，等待永远不兑现（套件实测挂住）。
      this.pending.set(requestId, { resolve, timer, expectedSenderId });
      let delivered = false;
      try {
        delivered = this.sender.send({
          channel: "workflowEngine:nodeInstallApproval",
          requestId,
          ...card,
        }, expectedSenderId);
      } catch {
        // 窗口销毁与 send 抛异常都视作无审批端口；不能留下 pending。
      }
      if (!delivered) {
        // 没有窗口可问 → 立刻拒绝（不等超时）。
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(false);
      }
    });
  }

  /** 渲染端的应答。找不到 `requestId`（已超时 / 已被另一次回答）→ false，不抛。 */
  resolve(input: WorkflowEngineNodeInstallRespondInput, actualSenderId: number): boolean {
    const pending = this.pending.get(input.requestId);
    // 错误窗口即使知道 UUID 也不能消费/批准（保留给真正发起窗口）。
    if (pending === undefined || pending.expectedSenderId !== actualSenderId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(input.requestId);
    pending.resolve(input.approved === true);
    return true;
  }

  /** 测试/退出用：把未决请求全部按拒绝兑现（不留下永远挂着的 Promise）。 */
  dispose(): void {
    for (const [requestId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(false);
    }
  }
}
