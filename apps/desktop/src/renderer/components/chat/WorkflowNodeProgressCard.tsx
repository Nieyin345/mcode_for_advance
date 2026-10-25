import { cn } from "@renderer/lib/cn.js";
import { SpinnerIcon } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useQueuedNode } from "@renderer/lib/workflowQueued.js";
import type { Block } from "@renderer/stores/sessionStore.js";
import { workflowProgressPercent } from "./workflowProgressPercent.js";

type WorkflowNodeProgressBlock = Extract<Block, { kind: "workflow-node-progress" }>;

/** Live runtime surface for a workflow node. The main-process progress event is
 * deliberately rendered as a separate transient block; the store removes it
 * when the corresponding settled result arrives. */
export function WorkflowNodeProgressCard({ block }: { block: WorkflowNodeProgressBlock }) {
  const { t } = useI18n();
  // 节点进了队列还没起跑时,「排队中」和「执行中」摆在同一行 —— 两者分得开,
  // 排队不烧 token(见 `workflowQueued.ts`)。
  const queued = useQueuedNode(block.runId, block.nodeId);
  const percent = workflowProgressPercent(block.percent);
  const label = block.phase?.trim() || t("chatStream.ledgerRunning");

  return (
    <div role="group" aria-label={block.title} className="min-w-0 max-w-full rounded-[var(--radius-card)] border border-accent/30 bg-accent/5 px-3 py-2 [font-size:var(--chat-fs-sm)]">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SpinnerIcon size={14} className={cn("shrink-0 text-accent", !queued && "animate-spin")} aria-hidden="true" />
        <span className="min-w-0 flex-[1_1_9rem] truncate font-medium text-content" title={block.title}>{block.title}</span>
        <code className="max-w-[min(12rem,60%)] min-w-0 truncate text-[0.85em] text-content-subtle" title={block.nodeType}>{block.nodeType}</code>
        {queued && (
          <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[0.85em] text-content-muted">
            {t("chatStream.workflowStep.queued")}
          </span>
        )}
        <span role="status" aria-live="polite" className="max-w-full min-w-0 break-words text-accent">{label}</span>
      </div>
      {percent !== undefined && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label={block.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 tabular-nums text-[0.85em] text-content-subtle">{Math.round(percent)}%</span>
        </div>
      )}
      {block.message && (
        <p className={cn("mt-1 break-words text-content-muted", percent === undefined && "ml-6")}>{block.message}</p>
      )}
    </div>
  );
}
