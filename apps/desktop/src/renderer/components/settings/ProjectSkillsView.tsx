/**
 * **项目技能** —— 设置页技能面板的第二个 tab。
 *
 * ## 它解决的是哪件事
 *
 * 技能从前只有"通用库"一个作用域（`~/.mcode/skills`，三个引擎共用）。用户
 * 2026-09-20 要把技能**放进项目**：跟着项目目录走、能改成本项目专用、能分享给
 * 同事 —— 那只有落在 `<项目>/.claude/skills/` 才成立。
 *
 * 这一页两件事：
 *  1. **列出这个项目自己的技能**（来源 `project`）；
 *  2. **从通用库勾选复制过来**（`skills.copyToProject`，批量）。
 *
 * ## 为什么复制在「总库」那一栏里勾、在这里按按钮
 *
 * 因为"复制"这个动作的两端分别属于两栏：源在总库（那是唯一事实源），目标在项目。
 * 把勾选放在**总库那一栏**、把按钮放在**这一栏**，用户看得见的两边正好就是这次
 * 复制真正涉及的两边 —— 反过来（在这一栏列一份总库的清单再勾）会让人以为项目里
 * 已经有那些技能了。
 *
 * ## 复制之后**两边脱钩**，这一条要说出来
 *
 * 不复用、不引用、不跟着变 —— 项目里那一份是**独立的一份**。用户要的正是这个
 * （改成本项目专用的版本、分享给同事），但不说清楚的话，他改完总库发现项目里没变
 * 会以为是 bug。所以下面有一行常驻说明。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillInfo } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button } from "@renderer/components/ui/button.js";
import { IconCopy, IconSparkles, IconFolderOpen } from "@renderer/lib/icons.js";

/** 一次复制的结果，用来在界面上如实回报三种下场（成了 / 跳过 / 失败）。 */
interface CopyOutcome {
  copied: number;
  skipped: number;
  failed: number;
}

export function ProjectSkillsView({
  skills,
  loading,
  selected,
  onToggleSelect,
  onClearSelection,
  onCopied,
}: {
  /** **总库那一栏当前勾选的技能名**（源）。 */
  selected: readonly string[];
  onToggleSelect: (name: string) => void;
  onClearSelection: () => void;
  /** 项目技能列表（本页自己拉）。 */
  skills: SkillInfo[];
  loading: boolean;
  onCopied: () => void;
}) {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );

  const [busy, setBusy] = useState(false);

  const copy = useCallback(async (): Promise<void> => {
    if (!project || selected.length === 0) return;
    setBusy(true);
    try {
      const res = await api.skills.copyToProject({
        projectPath: project.path,
        names: [...selected],
      });
      const outcome: CopyOutcome = {
        copied: res.copied.length,
        skipped: res.skipped.length,
        failed: res.failed.length,
      };
      // **如实回报三种下场。** "复制了 3 个"之后再补一句"跳过了 2 个"很重要 ——
      // 用户勾了 5 个却只看到 3 个复制过去，不解释就是"软件丢了两个"。
      const parts: string[] = [];
      if (outcome.copied > 0) parts.push(t("settings.skills.copyDone", { n: outcome.copied }));
      if (outcome.skipped > 0) parts.push(t("settings.skills.copySkipped", { n: outcome.skipped }));
      if (outcome.failed > 0) parts.push(t("settings.skills.copyFailed", { n: outcome.failed }));
      useToastStore.getState().push({
        kind: outcome.failed > 0 ? "warning" : "info",
        title: parts.join(";") || t("settings.skills.copyNoneSelected"),
      });
      if (outcome.copied > 0) {
        onClearSelection();
        onCopied();
      }
    } catch (err) {
      useToastStore.getState().push({
        kind: "error",
        title: t("settings.skills.copyFailed", { n: selected.length }),
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [project, selected, t, onClearSelection, onCopied]);

  // ── 没有项目：这一页没有意义，直说 ──
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-[0.8571em] leading-relaxed text-content-muted">
          {t("settings.skills.projectNoProject")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 项目名 + 复制按钮。项目路径一并给出来 —— "复制到哪儿"是这一页唯一要紧的
          事实，而项目名可能重名（两个都叫"论文"），路径不会。 */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-edge bg-surface/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconFolderOpen size={14} className="shrink-0 text-content-subtle" />
          <div className="min-w-0">
            <div className="truncate text-[0.8571em] font-medium text-content">{project.name}</div>
            <div className="truncate font-mono text-[0.7143em] text-content-subtle" title={project.path}>
              {project.path}
            </div>
          </div>
        </div>
        <Button
          variant="primary"
          disabled={busy || selected.length === 0}
          onClick={() => void copy()}
          title={selected.length === 0 ? t("settings.skills.copyNoneSelected") : undefined}
        >
          <IconCopy size={13} />
          {selected.length > 0
            ? t("settings.skills.copySelected", { n: selected.length })
            : t("settings.skills.copyToProject")}
        </Button>
      </div>

      {/* 脱钩这件事**常驻**说一句，不做成一次性提示。 */}
      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.skills.copyHint")}
      </p>

      {/* ── 项目自己的技能 ── */}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface/40">
        {loading && (
          <div className="px-3 py-6 text-center text-[0.8571em] text-content-subtle">
            {t("common.loading")}
          </div>
        )}
        {!loading && skills.length === 0 && (
          <div className="px-4 py-8 text-center text-[0.8571em] leading-relaxed text-content-subtle">
            {t("settings.skills.projectEmpty1")}
            <br />
            {t("settings.skills.projectEmpty2")}
          </div>
        )}
        {!loading &&
          skills.map((s) => (
            <div
              key={s.name}
              className="flex items-start gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0"
            >
              <IconSparkles size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.8571em] font-medium text-content">{s.name}</div>
                <div className="truncate text-[0.7857em] text-content-muted">
                  {s.description || t("settings.skills.noDesc")}
                </div>
              </div>
            </div>
          ))}
      </div>

      {/* 提示：勾选是在「总库」那一栏做的。两栏分属不同的 tab，用户看不到对方，
          所以要明说去哪儿勾 —— 否则他会盯着这一页找复选框。 */}
      {selected.length === 0 && !loading && skills.length > 0 && (
        <p className="px-1 text-[0.7857em] text-content-subtle">
          {t("settings.skills.copyNoneSelected")} —— {t("settings.skills.tabLibrary")} ({t("settings.skills.selectAll")})
        </p>
      )}
      {selected.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[0.7857em] text-content-muted">
            {t("settings.skills.copySelected", { n: selected.length })}
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className={cn(
              "rounded px-1.5 py-0.5 text-[0.7857em] text-content-subtle transition-colors",
              "hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            {t("settings.skills.clearSelection")}
          </button>
        </div>
      )}
    </div>
  );
}
