import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { mcpDecisionView, type McpExecutionState } from "./mcpDecision.js";

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
  const outcome = mcpDecisionView(status, result);
  const provider = toolName.split("__")[1];
  return (
    <section
      data-mcp-tool-status={outcome}
      role="region"
      aria-label={toolName}
      className={cn("relative my-1 overflow-hidden rounded-[var(--radius-card)] border bg-surface px-2 py-1.5",
        outcome === "running" ? "border-accent/40" : outcome === "success" ? "border-edge" : "border-danger/50")}
    >
      <div className="flex items-center justify-between gap-2 border-b border-edge/60 pb-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-content-subtle" title={toolName}>{provider || toolName}</span>
        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 font-medium",
          outcome === "running" ? "bg-accent/10 text-accent" : outcome === "success" ? "bg-surface-muted text-content-muted" : "bg-danger/10 text-danger")}
        >{t(`chatStream.mcp.${outcome}`)}</span>
      </div>
      {children}
    </section>
  );
}
