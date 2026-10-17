/**
 * **节点技能总览** —— 设置页技能面板的第三个 tab。
 *
 * ## 它回答的问题：谁在用什么
 *
 * 技能有三个作用域：通用库、项目、**以及"某个节点挂的那几个"**。前两个在这一页
 * 的另外两个 tab 里管，而节点那一层**不在设置里配** —— 它长在工作流图上（节点
 * 参数那格「技能」）和代理档案里（`<数据根>/workflows/agents/*.json`，
 * "某个节点类型的一袋参数"）。同一份数据两处能改，迟早"这边改了那边没变"，
 * 所以这一页**刻意只读**。
 *
 * 它做的是**反向查询**：从技能出发，看它被哪些节点、哪些档案引用了。
 * 这是别处都没有的视角 —— 在工作流图上你只能看到"这一格挂了哪几个技能"，
 * 反过来（"这个技能还有谁在用、删了会伤到谁"）没人答得上来。
 *
 * ## 为什么不做成"在这里直接改"
 *
 * 因为"改哪个"是答不出来的：同一份档案插到十个节点里，点一下改谁？而工作流图上
 * 的每个节点各有各的参数。所以这里给的是**跳转** —— 点一行去到那个地方改。
 * 仓库里为同一个理由删过两个面板（注释原话："同一个东西两个地方改，迟早出现
 * '这边改了那边没变'"）。
 *
 * ## 数据从哪来
 *
 * `workflow.list` 只给列表项（**不含 `nodes`**），所以要知道每个节点挂了什么，
 * 得逐个 `workflow.get`。档案那条一次 `agent_profiles.list` 就够（它带 `params`）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { NODE_SKILLS_PARAM_KEY } from "@contracts/nodeType";
import type { SkillInfo } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconSparkles, IconArrowsSplit, IconRobotFace, IconAlertTriangle } from "@renderer/lib/icons.js";
import {
  buildNodesUsage,
  splitUsedAndUnused,
  type ReferenceUse,
  type UnreadWorkflow,
} from "./nodesUsageView.js";

export function SkillNodesView({
  skills,
  onJumpToWorkflow,
  onJumpToProfile,
  paramKey = NODE_SKILLS_PARAM_KEY,
  hint,
  empty,
  icon: RowIcon = IconSparkles,
  selectedRef = null,
}: {
  /** The inventory to report on (skills by default; MCP servers / plugins
   *  reuse the view with their own `paramKey`). */
  skills: ReadonlyArray<Pick<SkillInfo, "name"> & { description?: string }>;
  /** Node param holding the name list (skills / mcp / plugins). */
  paramKey?: string;
  /** Replaces the skills hint line above the list. */
  hint?: string;
  /** Replaces the "no node uses a skill" line. */
  empty?: string;
  icon?: typeof IconSparkles;
  /** 跳到工作流那一页并选中这一份。 */
  onJumpToWorkflow: (workflowId: string) => void;
  /** 跳到代理档案那一页。 */
  onJumpToProfile: (profileId: string) => void;
  /** 当前选中/正在看的那一处引用 —— 命中它的行加 `aria-current` 与高亮。
   *  可省略;省略时与从前完全一样(不亮任何一行)。 */
  selectedRef?: { kind: "workflow" | "profile"; refId: string } | null;
}) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<Map<string, ReferenceUse[]> | null>(null);
  const [unread, setUnread] = useState<UnreadWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // 档案那一条一次就够（`agent_profiles.list` 带 params）。
      const catalog = await api.workflow.agentProfiles();

      // 工作流**得逐个 get** —— `workflow.list` 只给列表项，不含 nodes。
      // 串行不并行：这些是本地 sqlite 读，并发几十个只会把连接池打满，
      // 而这里本来就是个设置页的一次性加载。
      //
      // ⚠️ **单份读不回来不等于"没人用"**（【MC-050 同类】）：从前的 `catch { 跳过 }`
      // 让一份读不回来的工作流**悄悄**从"被使用"里消失，它的技能掉进"没用到"那栏 ——
      // 而那一栏的用途是清理。现在失败**逐条记下**，结果标为不完整（见 `nodesUsageView`）。
      const list = await api.workflow.list();
      const gets: Array<{ workflow: Awaited<ReturnType<typeof api.workflow.get>>["workflow"]; error?: string }> = [];
      for (const entry of list.workflows) {
        try {
          const res = await api.workflow.get({ id: entry.id });
          gets.push({ workflow: res.workflow });
        } catch (err) {
          gets.push({ workflow: null, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const result = buildNodesUsage({
        profiles: catalog.profiles,
        workflows: list.workflows.map((w) => ({ id: w.id, name: w.name })),
        workflowGets: gets,
        paramKey,
      });
      setUsage(result.usage);
      setUnread(result.unreadWorkflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUsage(new Map());
      setUnread([]);
    }
  }, [paramKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // 把"有引用的"和"没引用的"分开 —— 判据在 `nodesUsageView.splitUsedAndUnused`。
  const { used, unused } = useMemo(() => splitUsedAndUnused(skills, usage), [skills, usage]);

  if (usage === null) {
    return (
      <div className="flex h-full items-center justify-center text-[0.8571em] text-content-subtle">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {hint ?? t("settings.skills.nodesHint")}
      </p>
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.8571em] text-warning">
          <IconAlertTriangle size={14} className="shrink-0" />
          {t("settings.skills.nodesLoadFailed", { error })}
        </div>
      )}
      {/* 【MC-050 同类】目录不完整 —— 读不回来的工作流可能引用了任何名字，
          所以下面"没被任何节点用到"那段**不能当清理依据**。逐条点名是哪几份。 */}
      {unread.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.8571em] text-warning">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div>{t("settings.skills.nodesIncomplete", { n: unread.length })}</div>
            <ul className="mt-1 space-y-0.5 text-[0.8571em] text-warning/90">
              {unread.map((w) => (
                <li key={w.id} className="truncate" title={w.error}>
                  {w.id} · {w.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface/40">
        {used.length === 0 && unused.length === 0 && (
          <div className="px-4 py-8 text-center text-[0.8571em] text-content-subtle">
            {/* 【MC-050 同类】一个名字都没有、又有工作流没读回来 —— 此刻说
                "没有节点用到"是**断言不了**的:那份没读回来的工作流可能引用了
                任何名字。改成说清"目录不完整"。 */}
            {unread.length > 0
              ? t("settings.skills.nodesEmptyIncomplete")
              : (empty ?? t("settings.skills.nodesEmpty"))}
          </div>
        )}

        {used.map((row) => (
          <div key={row.name} className="border-b border-edge/60 last:border-b-0">
            {/* 技能名 + "被 N 处使用" */}
            <div className="flex items-center gap-2 px-3 py-2">
              <RowIcon size={14} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-medium text-content">
                {row.name}
              </span>
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[0.7143em] font-medium text-accent">
                {t("settings.skills.nodesUsedBy", { n: row.uses.length })}
              </span>
            </div>
            {/* 引用列表 —— 点一行跳到那儿去改 */}
            <div className="pb-1.5 pl-9 pr-3">
              {row.uses.map((u, i) => {
                const selected =
                  selectedRef !== null && selectedRef.kind === u.kind && selectedRef.refId === u.refId;
                return (
                  <button
                    key={`${u.kind}:${u.refId}:${u.nodeTitle ?? ""}:${i}`}
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() =>
                      u.kind === "workflow" ? onJumpToWorkflow(u.refId) : onJumpToProfile(u.refId)
                    }
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors",
                      "hover:bg-surface-hover/60",
                      selected && "bg-accent/15",
                    )}
                  >
                    {u.kind === "workflow" ? (
                      <IconArrowsSplit size={12} className="shrink-0 text-content-subtle" />
                    ) : (
                      <IconRobotFace size={12} className="shrink-0 text-content-subtle" />
                    )}
                    <span className="truncate text-[0.7857em] text-content-muted">
                      {u.label}
                      {u.nodeTitle && <span className="text-content-subtle"> · {u.nodeTitle}</span>}
                    </span>
                    <span className="ml-auto shrink-0 text-[0.7143em] text-content-subtle">
                      {u.kind === "workflow"
                        ? t("settings.skills.nodesFromWorkflow")
                        : t("settings.skills.nodesFromProfile")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* 没被任何节点用到的 —— 单独一段，因为它的用途是"清理"。
            ⚠️ 有工作流没读回来时，这一段**不是"确实没人用"**（【MC-050 同类】）。 */}
        {unused.length > 0 && (
          <div className="border-t border-edge">
            <div className="px-3 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
              {t("settings.skills.nodesUnused")}
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 pb-3">
              {unused.map((s) => (
                <span
                  key={s.name}
                  className="rounded border border-edge px-1.5 py-0.5 text-[0.7857em] text-content-muted"
                  title={s.description || undefined}
                >
                  {s.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
