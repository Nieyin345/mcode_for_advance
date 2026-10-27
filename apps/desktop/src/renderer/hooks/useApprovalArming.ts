import { useEffect, useState } from "react";

/**
 * useApprovalArming —— 高风险审批主动作的**短延迟启用**（ARC-005 输入保护）。
 *
 * ## 为什么是延迟而不是二次确认
 *
 * 审批卡是危险操作的最后一道人闸（Claude 工具审批、计划执行审批、第三方引擎节点包安装——
 * 后者等于往引擎里放一份会被 `require()` 执行的代码）。这些高风险确认卡共用这一份实现：
 * 主要确认动作（允许/批准/交接）在卡片出现后的 `APPROVAL_ARM_DELAY_MS` 内保持 `disabled`，期间回车、
 * 连击、双击都落不到它上面；「拒绝」永远立即可用（fail-closed 不该被延迟）。
 *
 * 选短延迟而不是「再点一次确认」：后者要给各类审批卡再加一层确认壳、改布局、加文案键，
 * 还会让正常审批多一次点击；这些卡的风险窗口就发生在**开卡瞬间**（消息推送
 * 与用户手上正在按的回车/连击撞车）。500ms 覆盖人从"看到卡"到"决定点允许"的
 * 最短反应时间，侵入面只有一条 `disabled`。
 *
 * ## 复位
 *
 * `resetKey` 变化（新的 requestId、队列换头）时**立即**回到未武装：渲染阶段就
 * 把 `armed` 置 false，不等 effect —— 否则新请求会带着上一张卡的 `armed=true`
 * 渲染一帧，那一帧里「允许」可点。
 *
 * SSR 下 `useEffect` 不跑，`armed` 恒为 false（「允许」默认不可点）—— 安全方向。
 */
export const APPROVAL_ARM_DELAY_MS = 500;

export function useApprovalArming(resetKey: unknown): boolean {
  const [armedKey, setArmedKey] = useState<unknown>(resetKey);
  const [armed, setArmed] = useState(false);

  // 渲染阶段复位（React 的 derived-state 模式）：换请求的那一帧就不许点「允许」。
  if (!Object.is(armedKey, resetKey)) {
    setArmedKey(resetKey);
    setArmed(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), APPROVAL_ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [resetKey]);

  return armed;
}
