/**
 * 运行监控面板:**所有自动化工作流**的运行事实总览。
 *
 * ## 它和「自动化」页的关系
 *
 * 自动化页管**一张图**(挂触发器、看它自己的运行段);这一页把所有图的运行摆在一起
 * —— 哪张在跑、哪张在失败,跨图扫一眼。数据读 `monitoring.overview` /
 * `monitoring.runs`(主进程聚合,契约见 `@contracts/ipc` 的 orchestration 域)。
 *
 * ## 列表行能展开看什么
 *
 * `MonitoringRunSummary` 带 `nodes` —— 每个定案节点的 id / 类型 / 状态。这是**定案
 * 摘要**而不是过程流:节点说过什么、产出过什么不在监控存储里。展开只答一件事:
 * "这次败在第几步",不用点进单图就知道。想看过程,去自动化页。
 *
 * ## 读不到怎么办
 *
 * 通道没就绪/读失败:**一句错误小字**,不弹错 —— 监控页不是关键路径,为一条还没
 * 就绪的通道常驻红字没有意义(同 `RunHistorySection` 的纪律)。概览卡与列表归空。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MonitoringNodeSummary,
  MonitoringOverview,
  MonitoringRunSummary,
} from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Card } from "@renderer/components/ui/index.js";
import {
  IconActivity,
  IconChevronDown,
  IconChevronRight,
  IconLoader2,
  IconRefresh,
} from "@renderer/lib/icons.js";
import { formatFullTime, formatRelativeTime } from "@renderer/lib/time.js";
import { formatDuration } from "@renderer/components/chat/activityShared.js";
import { PANEL_MAX_W } from "../settings/panelWidth.js";
import { PanelHeader } from "../settings/PanelHeader.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { RUN_STATUS_META } from "../settings/workflows/RunHistorySection.js";

/** 最近运行列表的条数。概览看趋势,细节去自动化页看单图 —— 20 条够了。 */
const RECENT_RUNS_LIMIT = 20;

/** 时长格式化用的是 `activityShared.ts` 里的那一份,在下面 import 进来。
 *
 *  ⚠️ **别在这儿自己写一份。** 这里原来有一份独立的实现,它把秒四舍五入而分钟向下
 *  取整 —— `s % 60` 进得到 60,却永远进不了位,于是 119.5 秒显示成 `1m60s`、
 *  3599.6 秒显示成 `59m60s`。谁都读不出那是对的。
 *
 *  共用的那份文件头写着「Shared vocabulary for the chat activity rail + console ...
 *  One copy is what keeps "运行中" the same colour and wording everywhere」——
 *  时长也在它管的范围里。
 *
 *  (`WorkflowBoardPanel.tsx` 里还有一份自己写的,但那份用 `sec % 60` 取模、不进位,
 *  所以出不了 60 —— 是另一种写法,不是同一个 bug。)
 */

/** `MonitoringNodeSummary.status` 透传 `NodeOutcomeStatus`(开放字符串):认不出的
 *  值原样显示,这张表只兜契约里的集合(同 `AutomationRunSection` 的那张 step 表)。 */
const NODE_STATUS_LABELS: Record<string, MessageId> = {
  success: "monitoring.nodeStatus.success",
  failed: "monitoring.nodeStatus.failed",
  cancelled: "monitoring.nodeStatus.cancelled",
  skipped: "monitoring.nodeStatus.skipped",
  unselected: "monitoring.nodeStatus.unselected",
};

/** 最近运行里的一行。展开态是本地 UI 事实(契约不关心谁展开了哪行),不进 store。 */
function RunRow({ run }: { run: MonitoringRunSummary }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const meta = RUN_STATUS_META[run.status];
  return (
    <div className="rounded border border-edge bg-surface text-[0.7143em]">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {meta ? (
          <meta.Icon size={12} className={cn("shrink-0", meta.tone)} />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-surface-muted" />
        )}
        <span className={cn("shrink-0 font-medium", meta?.tone ?? "text-content-muted")}>
          {meta ? t(meta.labelKey) : run.status}
        </span>
        {/* 相对时间读起来快,准确时刻进 title(同 RunHistorySection)。 */}
        <span className="shrink-0 text-content-subtle" title={formatFullTime(run.startedAt)}>
          {formatRelativeTime(run.startedAt)}
        </span>
        <code className="min-w-0 flex-1 truncate text-content-subtle">{run.workflowId}</code>
        <span className="shrink-0 tabular-nums text-content-muted">
          {formatDuration(run.durationMs)}
        </span>
        <span className="shrink-0 tabular-nums text-content-muted">
          {t("monitoring.nodeCount", { n: run.nodes.length })}
        </span>
        {run.nodes.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          >
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1 border-t border-edge px-2 py-1.5 text-[0.9286em]">
          {run.nodes.map((node) => (
            <NodeRow key={node.nodeId} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeRow({ node }: { node: MonitoringNodeSummary }) {
  const { t } = useI18n();
  const labelKey = NODE_STATUS_LABELS[node.status];
  return (
    <div className="flex items-center gap-1.5 text-content-subtle">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          node.status === "success"
            ? "bg-success"
            : node.status === "failed"
              ? "bg-danger"
              : "bg-surface-muted",
        )}
      />
      <code className="min-w-0 max-w-40 shrink-0 truncate" title={node.nodeId}>
        {node.nodeId}
      </code>
      <span className="min-w-0 flex-1 truncate">{node.kind}</span>
      <span className="shrink-0">{labelKey !== undefined ? t(labelKey) : node.status}</span>
    </div>
  );
}

export function MonitoringPanel() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);
  const [runs, setRuns] = useState<MonitoringRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 单调序号:只有最新一次在飞的请求能写 state。`refresh` 由初始挂载、那颗「刷新」
  // 按钮、以及 StrictMode 的双挂载触发,两次调用可以重叠 —— 没有它的话,先发后回的
  // 那次会把新数据盖成旧的(点刷新看到的还是上一次的数,与按钮高亮对不上)。
  // 仓库里同类加载都补了 *Seq 守卫(GitPanel.scanSeqRef / UsagePanel.loadSeqRef /
  // useRpc.seqRef),这里补齐同一份。
  const seqRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const [ov, rows] = await Promise.all([
        api.monitoring.overview(),
        api.monitoring.runs({ limit: RECENT_RUNS_LIMIT }),
      ]);
      if (seq !== seqRef.current) return; // 有更新的一次在飞,这次作废
      setOverview(ov);
      setRuns(rows);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setOverview(null);
      setRuns([]);
      setError((err as Error).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cards = overview
    ? [
        {
          key: "total",
          label: t("monitoring.totalRuns"),
          value: overview.totalRuns.toLocaleString(),
        },
        {
          key: "ok",
          label: t("monitoring.succeeded"),
          value: overview.succeeded.toLocaleString(),
        },
        {
          key: "bad",
          label: t("monitoring.failed"),
          value: overview.failed.toLocaleString(),
        },
        {
          key: "avg",
          label: t("monitoring.avgDuration"),
          // 一条都没有时契约给 0 —— 那不是"平均耗时 0",是"还没有均值",画横线。
          value: overview.totalRuns > 0 ? formatDuration(overview.avgDurationMs) : "—",
        },
      ]
    : [];

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader
        title={t("settings.nav.monitoring")}
        icon={IconActivity}
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={() => void refresh()}
            className="gap-1"
          >
            <IconRefresh size={12} />
            {t("common.refresh")}
          </Button>
        }
      />

      {error !== null && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {t("monitoring.loadFailed", { error })}
        </div>
      )}

      {loading && overview === null && runs.length === 0 && error === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <>
          {/* ───────── 概览 ───────── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {cards.map((card) => (
              <Card key={card.key} className="px-3 py-2.5">
                <div className="text-[0.7143em] text-content-subtle">{card.label}</div>
                <div className="mt-0.5 text-[1.2em] font-semibold tabular-nums leading-relaxed text-content">
                  {card.value}
                </div>
              </Card>
            ))}
          </div>
          {overview?.lastErrorMessage !== undefined && (
            // 概览只给总数,最近一次为什么败要说出来 —— 总数答不出"配置写坏了"。
            <p
              className="truncate text-[0.7857em] leading-relaxed text-danger"
              title={
                overview.lastErrorAt !== undefined
                  ? formatFullTime(overview.lastErrorAt)
                  : overview.lastErrorMessage
              }
            >
              {t("monitoring.lastError")}: {overview.lastErrorMessage}
            </p>
          )}

          {/* ───────── 最近运行 ───────── */}
          <SettingsSection title={t("monitoring.recent")}>
            {runs.length === 0 && error === null ? (
              <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("monitoring.empty")}
              </div>
            ) : (
              <div className="space-y-1.5 px-4 py-3">
                {runs.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}
    </section>
  );
}
