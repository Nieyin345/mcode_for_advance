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
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { IconCopy, IconSparkles, IconFolderOpen, IconTrash } from "@renderer/lib/icons.js";

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
  onGoToLibrary,
}: {
  /** **总库那一栏当前勾选的技能名**（源）。 */
  selected: readonly string[];
  onToggleSelect: (name: string) => void;
  onClearSelection: () => void;
  /** 项目技能列表（本页自己拉）。 */
  skills: SkillInfo[];
  loading: boolean;
  onCopied: () => void;
  /** 切到「总库」那一栏去勾选 —— 底部那句引导可点,省得用户自己找 tab。 */
  onGoToLibrary: () => void;
}) {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );

  const [busy, setBusy] = useState(false);
  /** 待确认删除的项目技能名（null = 没有）。 */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const copy = useCallback(async (): Promise<void> => {
    if (!project) return;
    // **没勾选时要说一句话,不能静默返回。** 按钮一直可点（见下面那个 ⚠️）,所以
    // 这条路径是用户真会走到的 —— 默默什么都不做等于"点了没反应"。
    if (selected.length === 0) {
      useToastStore.getState().push({
        kind: "info",
        title: t("settings.skills.copyNoneSelected"),
        body: t("settings.skills.copyHintWhere", { tab: t("settings.skills.tabLibrary") }),
      });
      return;
    }
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
          // ⚠️ **不要 `disabled`。** 原先这里是 `disabled={busy || selected.length === 0}`,
          // 而"没勾选"恰好是打开这一页时的**默认状态** —— 于是用户看到的是一个
          // 半透明、点不动的按钮,报告的原话是「根本就没有复制按钮」。
          // 变灰的按钮什么也没告诉他;点一下给一句话才有用。
          disabled={busy}
          onClick={() => void copy()}
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
              className="group flex items-start gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0"
            >
              <IconSparkles size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.8571em] font-medium text-content">{s.name}</div>
                <div className="truncate text-[0.7857em] text-content-muted">
                  {s.description || t("settings.skills.noDesc")}
                </div>
              </div>
              {/* 删除 —— 删的是**项目目录里的文件**（`<项目>/.claude/skills/<名字>/`），
                  不是总库里那份。确认框里要把这件事说清楚，否则用户会以为连总库一起删了。 */}
              <button
                type="button"
                title={t("settings.skills.removeFromProject")}
                onClick={() => setPendingRemove(s.name)}
                className="mt-0.5 shrink-0 rounded p-1 text-content-subtle/50 opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover:opacity-100"
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))}
      </div>

      {/* 引导：勾选在「总库」那一栏做,两栏分属不同 tab,用户看不到对方 ——
          所以要说清去哪儿勾。
          ⚠️ **不看 `skills.length`。** 原先条件是 `skills.length > 0`,于是"项目里
          一个技能都还没有"时——也就是最需要这句话的时候——它恰好不显示。
          要么有勾选（报数量）、要么没勾选（告诉去哪儿勾）,两种状态都给出交代。 */}
      {selected.length > 0 ? (
        <div className="flex items-center justify-between px-1">
          <span className="text-[0.7857em] font-medium text-content-muted">
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
      ) : (
        // 可点 —— 点了直接切到总库那一栏去勾。不然用户得自己找到那个 tab。
        <button
          type="button"
          onClick={onGoToLibrary}
          className={cn(
            "rounded px-1 py-1 text-left text-[0.8571em] leading-relaxed text-content-muted transition-colors",
            "hover:bg-surface-hover/60 hover:text-content",
          )}
        >
          <span className="font-medium text-accent">{t("settings.skills.tabLibrary")}</span>
          {" — "}
          {t("settings.skills.copyHintWhere", { tab: t("settings.skills.tabLibrary") })}
        </button>
      )}

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("settings.skills.removeFromProject")}
        danger
        description={t("settings.skills.removeFromProjectDesc", { name: pendingRemove ?? "" })}
        confirmText={t("common.delete")}
        onOpenChange={(o) => {
          if (!o) setPendingRemove(null);
        }}
        onConfirm={() => {
          const name = pendingRemove;
          setPendingRemove(null);
          if (!name || !project) return;
          void (async () => {
            try {
              const res = await api.skills.delete({ source: "project", projectPath: project.path, name });
              if (!res.ok) {
                useToastStore.getState().push({ kind: "error", title: res.error ?? "" });
              }
              onCopied();
            } catch (err) {
              useToastStore.getState().push({
                kind: "error",
                title: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        }}
      />
    </div>
  );
}
