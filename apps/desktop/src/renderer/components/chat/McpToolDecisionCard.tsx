import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { mcpDecisionView, type McpDecisionView, type McpExecutionState } from "./mcpDecision.js";

/** turn.done 会把仍在 running 的工具收成 status:"done" + 这条结果
 *  (sessionStore 的 turn.done 分支)。工具**从未返回结果** —— 用户中断了
 *  回合，或有审批还没决定。它不是执行成功。 */
const NO_RESULT_MARKER = /^\(no result — turn ended\)$/i;

/** 视图判定：先走共享的 mcpDecisionView，再把「done 但没有结果」从 success
 *  拉回 error（fail-closed：未执行不许显示为已完成）。 */
export function mcpCardOutcome(status: McpExecutionState, result: string): McpDecisionView {
  const view = mcpDecisionView(status, result);
  if (view === "success" && (!result.trim() || NO_RESULT_MARKER.test(result.trim()))) return "error";
  return view;
}

/** Live, read-only REA MCP decision card for model tool-use blocks.
 * The authoritative decision controls remain in ApprovalPrompt while pending:
 * never synthesize a permission result or change state on a timer. */
export function McpToolDecisionCard({ toolName, status, result, children }: {
  toolName: string;
  status: McpExecutionState;
  result: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const outcome = mcpCardOutcome(status, result);
  const provider = toolName.split("__")[1];
  return (
    <section
      data-mcp-tool-status={outcome}
      role="region"
      aria-label={toolName}
      aria-busy={outcome === "running"}
      className={cn("relative my-1 min-w-0 max-w-full overflow-hidden rounded-[var(--radius-card)] border bg-surface px-2 py-1.5",
        outcome === "running" ? "border-accent/40" : outcome === "success" ? "border-edge" : "border-danger/50")}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-edge/60 pb-1 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-content-subtle" title={toolName}>{provider || toolName}</span>
        <span role="status" aria-live="polite" aria-atomic="true" className={cn("inline-flex min-h-6 shrink-0 items-center rounded-full px-2 py-0.5 font-medium",
          outcome === "running" ? "bg-accent/10 text-accent" : outcome === "success" ? "bg-surface-muted text-content-muted" : "bg-danger/10 text-danger")}
        >{t(`chatStream.mcp.${outcome}`)}</span>
      </div>
      {children}
    </section>
  );
}
