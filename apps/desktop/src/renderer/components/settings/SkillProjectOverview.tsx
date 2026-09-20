/**
 * **跨项目总览** —— 「项目」tab 里"每个项目各装了什么"那块。
 *
 * ## 它解决的是哪件事
 *
 * 用户的原话：「之后会有很多的项目」。项目一多就有两个问题：**看不见全貌**（哪个
 * 项目装了什么得挨个切过去看）、**不一致也看不见**（A 项目那个技能改过、B 项目的
 * 没改，你无从知道）。
 *
 * 这一块把每个项目的 `<项目>/.claude/skills/` 列成一屏。
 *
 * ## 只读
 *
 * ⚠️ **这里不改任何东西。** 改还是去「项目」那一栏（那是当前项目）。理由同「节点」
 * 那一栏：同一个东西两个地方改，迟早出现"这边改了那边没变"。
 *
 * ## 它会去读你没打开过的项目目录
 *
 * 这是这一页里唯一**越过当前项目**的动作 —— 只列直接子目录、不递归、不写。单个项目
 * 读不动（没权限 / 路径没了）**只把那一个记下来**，不整批失败；目录不存在**不算问题**
 * （绝大多数项目都没放过技能），界面上说成"还没放过技能"而不是画成错误。
 */
import { useCallback, useEffect, useState } from "react";
import type { SkillsProjectOverviewResult } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconFolderOpen, IconLoader2, IconSparkles } from "@renderer/lib/icons.js";

export function SkillProjectOverview({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<SkillsProjectOverviewResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.skills.projectOverview({});
      setData(res);
    } catch {
      setData({ rows: [], problems: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  // `refreshKey` 变了就重扫 —— 当前项目复制完技能之后，那一行要跟着变。
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (data === null) {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-[0.8571em] text-content-subtle">
        <IconLoader2 size={13} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-edge bg-surface/40">
      <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
        <span className="text-[0.8571em] font-medium text-content">
          {t("settings.skills.overview")}
        </span>
        <div className="flex items-center gap-2">
          {data.problems.length > 0 && (
            <span className="flex items-center gap-1 text-[0.7857em] text-warning">
              <IconAlertTriangle size={11} />
              {t("settings.skills.overviewProblems", { n: data.problems.length })}
            </span>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="rounded px-1.5 py-0.5 text-[0.7857em] text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content disabled:opacity-50"
          >
            {t("settings.skills.overviewRefresh")}
          </button>
        </div>
      </div>

      <p className="px-3 pt-2 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.skills.overviewHint")}
      </p>

      {data.rows.length === 0 && (
        <div className="px-3 py-4 text-center text-[0.8571em] text-content-subtle">
          {t("settings.skills.overviewEmpty")}
        </div>
      )}

      <div className="p-1.5">
        {data.rows.map((row) => (
          <div
            key={row.projectId}
            className="flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-surface-hover/40"
          >
            <IconFolderOpen size={13} className="mt-0.5 shrink-0 text-content-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[0.9286em] font-medium text-content">
                  {row.projectName}
                </span>
                {row.skills.length > 0 && (
                  <span className="shrink-0 text-[0.7857em] text-content-subtle">
                    {t("settings.skills.presetCount", { n: row.skills.length })}
                  </span>
                )}
              </div>
              {/* 目录不存在 → 明说"还没放过技能"，而不是画成空的（那样看起来像
                  加载失败）。这是 `missing` 这个字段的全部意义。 */}
              {row.missing ? (
                <div className="text-[0.7857em] italic text-content-subtle">
                  {t("settings.skills.overviewNoSkillDir")}
                </div>
              ) : (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {row.skills.map((n) => (
                    <span
                      key={n}
                      className={cn(
                        "flex items-center gap-0.5 rounded border border-edge px-1.5 py-0.5",
                        "text-[0.7857em] text-content-muted",
                      )}
                    >
                      <IconSparkles size={9} className="text-content-subtle" />
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
