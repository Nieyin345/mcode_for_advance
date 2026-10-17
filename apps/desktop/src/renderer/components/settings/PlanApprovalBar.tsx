/**
 * **「预览 → 本人批准 → 执行（只递 grantId）」的共享动作栏**（MC-001 系统性修复第 3 条）。
 *
 * ## 它补的是哪条重复
 *
 * 场景部署（`SceneDeployPanel`）与无人值守计划（`UnattendedPlanPanel`）是两族入口，但
 * 用户的心算模型只有一套：**看计划 → 本人点批准 → 执行时宿主只收授权 id**。台账原文：
 * 「`scene.approve/apply`、`unattended.approve/run` 两族应共用**同一个**『计划预览 +
 * 本人批准』渲染组件与**同一份** policy 判据，别再各写一遍」。
 *
 * 判据侧早已共用（两族都过 `policyFor` 的 blocked 档、签发主体都由宿主写死为 user）；
 * 渲染侧此前是两段**长得几乎一样**的 JSX —— 批准钮的忙碌态、授权有效/过期徽标、执行钮的
 * 门控、重置钮。两段各写一遍的后果不是"多几行"，而是**纪律会漂**：一边改了"授权过期
 * 也要禁用执行"，另一边忘了改，用户就会在另一个面板上拿过期授权去撞拒绝。
 *
 * ## 它**不**吞掉各面板自己的形状
 *
 * - 面板特有的按钮（场景的「预览 / 续跑」、无人值守的表格编辑等）通过 `children` 插在
 *   批准钮**之前** —— 顺序即语义：先能预览，才谈得上批准。
 * - 文案全部由面板经 i18n 传进来（两个面板的 `MessageId` 不同，共享组件不持有任何词条）。
 * - 忙碌态是**两个独立布尔**（`busyApprove` / `busyRun`）：任一在飞时两个钮都禁用，
 *   但标签各自显示"批准中 / 执行中"。
 *
 * ## 纯展示
 *
 * 不 import 主进程、不调 `api`、不持有状态 —— 门控与动作全部由面板给。这样它能被无头
 * 套件以假 React 运行时挂载，也能被静态断言核对「两个面板确实用的是它」。
 */
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Badge, Button } from "@renderer/components/ui/index.js";

/** 授权的最小形状 —— 只要到期时刻（与两族 grant 的公共字段一致）。 */
export interface PlanGrantLike {
  expiresAt: number;
}

/**
 * **授权此刻是否有效** —— 两族共用的唯一判据（从前两处各写一遍 `Date.now() < expiresAt`）。
 *
 * `null` / `undefined` = 还没批准 → 假。边界与主进程 `isGrantActive` 同侧：**恰好到期
 * 那一刻算过期**（`now < expiresAt` 才有效）。
 */
export function planGrantActive(grant: PlanGrantLike | null | undefined, now: number = Date.now()): boolean {
  return grant !== null && grant !== undefined && now < grant.expiresAt;
}

export interface PlanApprovalBarProps {
  /** 能不能批准（面板自己的预判 + 是否已有计划）。 */
  canApprove: boolean;
  /** 能不能执行（面板自己的门控，**已经包含**授权有效这一层）。 */
  canRun: boolean;
  /** 已签发的授权（`null` = 还没批准，不显示徽标）。 */
  grant: PlanGrantLike | null;
  busyApprove: boolean;
  busyRun: boolean;
  approveLabel: string;
  approvingLabel: string;
  runLabel: string;
  runningLabel: string;
  /** 授权有效 / 已过期两句文案（`grant !== null` 时才用）。 */
  grantActiveLabel: string;
  grantExpiredLabel: string;
  resetLabel: string;
  onApprove: () => void;
  onRun: () => void;
  onReset: () => void;
  /** 面板特有按钮（预览 / 续跑…），插在批准钮**之前**。 */
  children?: ReactNode;
  /** 额外测试钩子（两个面板的套件各自认自己的前缀）。 */
  testId?: string;
}

export function PlanApprovalBar({
  canApprove,
  canRun,
  grant,
  busyApprove,
  busyRun,
  approveLabel,
  approvingLabel,
  runLabel,
  runningLabel,
  grantActiveLabel,
  grantExpiredLabel,
  resetLabel,
  onApprove,
  onRun,
  onReset,
  children,
  testId,
}: PlanApprovalBarProps): React.JSX.Element {
  const active = planGrantActive(grant);
  const anyBusy = busyApprove || busyRun;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" data-testid={testId}>
      {children}
      <Button variant="primary" size="sm" disabled={!canApprove || anyBusy} onClick={onApprove}>
        {busyApprove ? approvingLabel : approveLabel}
      </Button>
      <Button variant="primary" size="sm" disabled={!canRun || anyBusy} onClick={onRun}>
        {busyRun ? runningLabel : runLabel}
      </Button>
      {grant !== null && (
        <Badge variant={active ? "success" : "warning"}>{active ? grantActiveLabel : grantExpiredLabel}</Badge>
      )}
      <Button variant="ghost" size="sm" className={cn("ml-auto")} onClick={onReset}>
        {resetLabel}
      </Button>
    </div>
  );
}
