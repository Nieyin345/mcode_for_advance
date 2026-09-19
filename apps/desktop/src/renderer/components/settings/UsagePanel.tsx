/**
 * UsagePanel — 设置页「用量统计」面板。
 *
 * Aggregates the per-turn usage history persisted on session rows into three
 * views (data computed in main by lib/usageStats.ts, provider accounting
 * already normalized — Pi sessions are cumulative and get diffed there):
 *   1. Summary cards over the selected time range (turns / sessions /
 *      tokens breakdown).
 *   2. A fixed full-year (53-week) GitHub-style daily heatmap; days outside
 *      the selected range are dimmed so the range choice reads on the grid.
 *   3. A per-model ranking with proportional bars.
 *
 * Charts are hand-rolled (no chart lib in the project): the heatmap is a
 * column-flow CSS grid, the model bars reuse the AboutPanel progress-bar
 * pattern, colors are accent-alpha tiers over semantic tokens.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type UsageDayStat,
  type UsageStatsPreset,
  type UsageStatsResult,
} from "@contracts/ipc";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { fmtCost, fmtTokens } from "@renderer/lib/contextWindow.js";
import { Button, Card, Input } from "@renderer/components/ui/index.js";
import { IconChartBar, IconLoader2 } from "@renderer/lib/icons.js";
import { WORKFLOW_MAX_PARALLEL_MAX, WORKFLOW_MAX_PARALLEL_MIN } from "@contracts/ipc";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

const PRESETS: Array<{ id: UsageStatsPreset; labelKey: MessageId }> = [
  { id: "today", labelKey: "settings.usage.range.today" },
  { id: "7d", labelKey: "settings.usage.range.sevenDays" },
  { id: "30d", labelKey: "settings.usage.range.thirtyDays" },
  { id: "all", labelKey: "settings.usage.range.all" },
];

/** Heatmap geometry: cells are square via aspect-square and columns are 1fr,
 *  so the grid stretches to fill the available width; the fixed 3px gap (not
 *  em) keeps spacing stable across font-size settings. */

/* 月份缩写走 Intl 而不是手写表:这是一份**语言数据**,不是说法。中英两份本来
 * 就是 `Intl.DateTimeFormat` 的输出(zh → "1月"、en → "Jan"),自己维护一张表
 * 只会漏掉别的语言。按 `<html lang>` 的风格取短名,和 `lib/time.ts` 里那条
 * "交给平台" 的路子一致。 */
const MONTH_LABEL: Record<string, Intl.DateTimeFormat> = {};
function monthLabel(locale: string, month: number): string {
  const tag = locale === "zh" ? "zh-CN" : "en";
  const fmt = (MONTH_LABEL[tag] ??= new Intl.DateTimeFormat(tag, { month: "short" }));
  // 固定用 2021 那一年取名字:这里只要月名,年份不进结果,而写死年份才不会
  // 因为"跨年那一周"取到 12 月/1 月的歧义。
  return fmt.format(new Date(2021, month, 1));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Inclusive start date key (local YYYY-MM-DD) of a preset range, mirroring
 *  main's rangeStart(). null = no lower bound ("all"). */
function rangeStartKey(preset: UsageStatsPreset): string | null {
  if (preset === "all") return null;
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 5-tier accent-alpha ramp relative to the window's busiest day. */
function heatClass(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "bg-surface-muted";
  const ratio = value / max;
  if (ratio <= 0.25) return "bg-accent/25";
  if (ratio <= 0.5) return "bg-accent/45";
  if (ratio <= 0.75) return "bg-accent/70";
  return "bg-accent";
}

/** Parse a local YYYY-MM-DD key into a Date (a bare "YYYY-MM-DD" string would
 *  be parsed as UTC and shift the weekday in non-UTC timezones). */
function parseDateKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

export function UsagePanel() {
  const { t } = useI18n();
  const locale = useSessionStore((s) => s.locale);
  // 工作流那一节(见下面渲染树末尾):并发上限。**真正生效的那一份在主进程** ——
  // 这里只是把同一个设置键读出来显示、改了写回去。
  const maxParallel = useSessionStore((s) => s.workflowMaxParallel);
  const setMaxParallel = useSessionStore((s) => s.setWorkflowMaxParallel);

  const [preset, setPreset] = useState<UsageStatsPreset>("7d");
  const [result, setResult] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── shared cell tooltip: one div for the whole grid (366 per-cell Tooltip
  //    instances would be heavy and flicker between adjacent cells). Position
  //    is cell-relative to the grid wrapper; shown instantly on hover.
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const heatWrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  // Keep the centered tooltip inside the wrapper so first/last columns don't
  // overflow the panel. Direct style write pre-paint — no visible jump.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const wrap = heatWrapRef.current;
    if (!tip || !el || !wrap) return;
    const half = el.offsetWidth / 2;
    const max = Math.max(half + 4, wrap.clientWidth - half - 4);
    el.style.left = `${Math.min(Math.max(tip.x, half + 4), max)}px`;
  }, [tip]);

  const load = useCallback(async (p: UsageStatsPreset) => {
    setLoading(true);
    try {
      const res = await api.usage.stats({ preset: p });
      setResult(res);
      setError(null);
    } catch (err) {
      console.error("UsagePanel load failed:", err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(preset);
  }, [load, preset]);

  const daily = result?.daily ?? [];
  const summary = result?.summary;
  const models = useMemo(() => result?.models ?? [], [result]);

  // ── heatmap geometry: pad the first column so day 1 lands on its weekday ──
  const { cells, weeks, monthLabels, dailyMax } = useMemo(() => {
    const dailyStats: UsageDayStat[] = daily;
    const empty = { cells: [] as Array<UsageDayStat | null>, weeks: [] as Array<Array<UsageDayStat | null>>[], monthLabels: [] as Array<string | null>, dailyMax: 0 };
    if (dailyStats.length === 0) return empty;

    let max = 0;
    for (const d of dailyStats) if (d.totalTokens > max) max = d.totalTokens;

    // Monday-based weekday index (Mon=0 … Sun=6); leading nulls align the
    // first real day to its row inside the first grid column.
    const firstDow = (parseDateKey(dailyStats[0].date).getDay() + 6) % 7;
    const cells: Array<UsageDayStat | null> = [
      ...Array.from({ length: firstDow }, () => null),
      ...dailyStats,
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: Array<Array<UsageDayStat | null>> = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    const monthLabels: Array<string | null> = weeks.map((week, i) => {
      const first = week.find((c) => c != null);
      if (!first) return null;
      const month = parseDateKey(first.date).getMonth();
      const prevWeek = i > 0 ? weeks[i - 1].find((c) => c != null) : undefined;
      const prevMonth = prevWeek ? parseDateKey(prevWeek.date).getMonth() : null;
      if (prevMonth === month) return null;
      return monthLabel(locale, month);
    });

    return { cells, weeks, monthLabels, dailyMax: max };
  }, [daily, locale]);

  const startKey = rangeStartKey(preset);
  const modelMax = models.length > 0 ? models[0].totalTokens : 0;

  const summaryItems: Array<{ key: string; label: string; value: string }> = summary
    ? [
        { key: "turns", label: t("settings.usage.summary.turns"), value: summary.turns.toLocaleString() },
        { key: "sessions", label: t("settings.usage.summary.sessions"), value: summary.sessions.toLocaleString() },
        { key: "totalTokens", label: t("settings.usage.summary.totalTokens"), value: fmtTokens(summary.totalTokens) },
        { key: "subagentTokens", label: t("settings.usage.summary.subagentTokens"), value: fmtTokens(summary.subagentTokens) },
        { key: "outputTokens", label: t("settings.usage.summary.outputTokens"), value: fmtTokens(summary.outputTokens) },
        { key: "cacheRead", label: t("settings.usage.summary.cacheRead"), value: fmtTokens(summary.cacheReadTokens) },
        { key: "cacheWrite", label: t("settings.usage.summary.cacheWrite"), value: fmtTokens(summary.cacheCreationTokens) },
        // **累计花费。** `buildUsageStats` 一直有算它(`summary.costUsd`),只是这里从来没
        // 渲染过 —— 补上。引擎没报花费时(某些第三方端点)显示 `—` **而不是 $0.00**:
        // 那会让人以为免费,而它是"不知道"。
        { key: "cost", label: t("settings.usage.cost"), value: fmtCost(summary.costUsd) },
      ]
    : [];

  return (
    // Constrained width + centered (same pattern as LspLanguagesPanel):
    // the 53-week heatmap stretches by 1fr columns, so at full panel width
    // the cells grow huge — the form width keeps them GitHub-sized.
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader
        title={t("settings.usage.title")}
        icon={IconChartBar}
        action={
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === preset ? "primary" : "secondary"}
                onClick={() => setPreset(p.id)}
                disabled={loading}
              >
                {t(p.labelKey)}
              </Button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {error}
        </div>
      )}

      {loading && !result ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <>
          {/* ───────── 区间汇总 ───────── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {summaryItems.map((item) => (
              <Card key={item.key} className="px-3 py-2.5">
                <div className="text-[0.7143em] text-content-subtle">{item.label}</div>
                <div className="mt-0.5 text-[1.2em] font-semibold tabular-nums leading-relaxed text-content">
                  {item.value}
                </div>
              </Card>
            ))}
          </div>

          {/* ───────── 每日热力图 ───────── */}
          <SettingsSection title={t("settings.usage.heatmap.title")}>
            <div className="px-4 py-3">
              {cells.length === 0 ? (
                <div className="py-4 text-center text-[0.7143em] text-content-subtle">
                  {t("common.loading")}
                </div>
              ) : (
                <div className="flex w-full gap-1.5">
                  {/* weekday labels — h/gap mirror the cell grid so rows align */}
                  <div
                    className="grid shrink-0 gap-[3px] pt-[17px]"
                    style={{ gridTemplateRows: "repeat(7, minmax(0, 1fr))" }}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((row) => (
                      <span
                        key={row}
                        className="flex items-center text-[9px] leading-none text-content-subtle"
                      >
                        {row === 0
                          ? t("settings.usage.heatmap.weekdayMon")
                          : row === 3
                            ? t("settings.usage.heatmap.weekdayThu")
                            : ""}
                      </span>
                    ))}
                  </div>
                  <div ref={heatWrapRef} className="relative min-w-0 flex-1">
                    {/* month labels — one span per week column (same 1fr track
                        sizing as the cell grid), first week of each month
                        carries the label */}
                    <div
                      className="mb-[3px] grid h-[14px] gap-[3px]"
                      style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
                    >
                      {weeks.map((_, i) => (
                        <span
                          key={i}
                          className="whitespace-nowrap text-[9px] leading-none text-content-subtle"
                        >
                          {monthLabels[i] ?? ""}
                        </span>
                      ))}
                    </div>
                    {/* grid-flow-col needs the explicit 7-row template to wrap
                        into the next week column — without it every cell lands
                        in one endless vertical column */}
                    <div
                      className="grid w-full grid-flow-col gap-[3px]"
                      style={{
                        gridTemplateRows: "repeat(7, auto)",
                        gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`,
                      }}
                    >
                      {cells.map((cell, i) =>
                        cell == null ? (
                          <span key={i} className="aspect-square" />
                        ) : (
                          <span
                            key={i}
                            onMouseEnter={(e) => {
                              const wrap = heatWrapRef.current;
                              if (!wrap) return;
                              const r = e.currentTarget.getBoundingClientRect();
                              const w = wrap.getBoundingClientRect();
                              setTip({
                                x: r.left + r.width / 2 - w.left,
                                y: r.top - w.top,
                                text: t("settings.usage.cellTip", {
                                  date: cell.date,
                                  turns: cell.turns.toLocaleString(),
                                  tokens: cell.totalTokens.toLocaleString(),
                                }),
                              });
                            }}
                            onMouseLeave={() => setTip(null)}
                            className={cn(
                              "aspect-square cursor-pointer rounded-[3px] transition-opacity",
                              heatClass(cell.totalTokens, dailyMax),
                              startKey && cell.date < startKey && "opacity-25",
                            )}
                          />
                        ),
                      )}
                    </div>
                    {tip && (
                      <div
                        ref={tipRef}
                        className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-edge bg-surface px-2.5 py-1.5 text-[11px] text-content shadow-lg"
                        style={{ left: tip.x, top: tip.y - 6 }}
                      >
                        {tip.text}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center justify-end gap-1 text-[0.7143em] text-content-subtle">
                {t("settings.usage.heatmap.less")}
                <span className="h-3 w-3 rounded-[3px] bg-surface-muted" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/25" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/45" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/70" />
                <span className="h-3 w-3 rounded-[3px] bg-accent" />
                {t("settings.usage.heatmap.more")}
              </div>
            </div>
          </SettingsSection>

          {/* ───────── 模型用量 ───────── */}
          <SettingsSection title={t("settings.usage.models.title")}>
            {models.length === 0 ? (
              <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.usage.empty")}
              </div>
            ) : (
              models.map((m) => {
                const vendor = m.vendor ?? t("settings.usage.unknownVendor");
                const name = m.model ?? t("settings.usage.unknownModel");
                const title = `${vendor} · ${name}`;
                const pct = modelMax > 0 ? Math.max(2, (m.totalTokens / modelMax) * 100) : 0;
                return (
                  <div key={`${vendor}\u0000${name}`} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[0.8571em] font-medium text-content" title={title}>
                        <span className="mr-1.5 inline-flex translate-y-[-1px] rounded bg-surface-muted px-1 py-px align-baseline text-[0.8em] font-normal text-content-muted">
                          {vendor}
                        </span>
                        {name}
                      </span>
                      <span className="shrink-0 text-[0.7857em] tabular-nums text-content-muted">
                        {fmtTokens(m.totalTokens)} {t("settings.usage.models.tokens")}
                        {" · "}
                        {m.turns.toLocaleString()} {t("settings.usage.models.turns")}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </SettingsSection>

          {/* ───────── 工作流 ─────────
              一张图跑到某一步时,能并排跑的步骤会**一起起跑** —— 每一步都是一轮真的
              模型调用(子 agent 另开一段会话,主代理与对话节点跑在当前这个对话里),
              会真的烧 token。这个数字就是那个闸。放在用量这一页,因为它和上面那些
              统计说的是同一件事的两头:**花了多少** / **一次能同时烧几路**。 */}
          <SettingsSection
            title={t("settings.usage.workflow.title")}
            desc={t("settings.usage.workflow.desc")}
          >
            <SettingRow
              title={t("settings.usage.maxParallel")}
              desc={t("settings.usage.maxParallelDesc", {
                min: WORKFLOW_MAX_PARALLEL_MIN,
                max: WORKFLOW_MAX_PARALLEL_MAX,
              })}
              htmlFor="setting-workflow-max-parallel"
            >
              <Input
                id="setting-workflow-max-parallel"
                type="number"
                min={WORKFLOW_MAX_PARALLEL_MIN}
                max={WORKFLOW_MAX_PARALLEL_MAX}
                step={1}
                value={maxParallel}
                onChange={(e) => void setMaxParallel(Number(e.target.value))}
                className="w-full"
              />
            </SettingRow>
          </SettingsSection>
        </>
      )}
    </section>
  );
}
