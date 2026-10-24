/**
 * **技能预设** —— 设置页技能面板的「项目」tab 里的上半部分。
 *
 * ## 它解决的是哪件事
 *
 * 用户的原话：「之后会有很多的项目」。项目一多，真正重复发生的动作是**"给新项目
 * 配上那几个"**，而不是"盯着二十个项目比对差异"—— 后者只能让你看见重复，前者能
 * 直接消掉重复。所以这里存的是一套一套的**清单**（"论文项目要这几个"）。
 *
 * ## 预设只是清单，不是拷贝
 *
 * 存的是**技能名**，不存文件。用的时候才去总库取 —— 所以改了总库里的技能，下次
 * 用这套预设复制过去的就是新的。这一条刻意的：预设回答"要哪几个"，不回答"那几个
 * 长什么样"。
 *
 * ## 存哪
 *
 * `<通用库>/.skill-presets.json`（dot-prefix，技能扫描会跳过它）。**不存进任何项目
 * 里** —— 预设是跨项目的配置，放进项目就变成"每个项目一套预设"，那正是要消除的重复。
 *
 * ## 读失败不许画成「还没有预设」
 *
 * 从前 `catch { setPresets([]) }` —— 一次读取失败与"真的一套都没存"在界面上长得
 * 一模一样，用户会照着空表去新建、覆盖掉自己原有的预设（硬规矩 3：坏东西显式报出来）。
 * 现在失败进 `loadError` → 错误横幅（标题 + 原因 + 重试）；只有"读成功且为空"才显示
 * 空态。做法与 `SkillProjectOverview` / `VoicePanel` 同一套。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillInfo, SkillPreset } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, ConfirmDialog, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconSparkles,
  IconTrash,
  IconCopy,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import { Input } from "@renderer/components/ui/input.js";

export function SkillPresetsView({
  librarySkills,
  onCopyPreset,
}: {
  /** 通用库的全部技能（可选范围）。 */
  librarySkills: SkillInfo[];
  /** 把这套预设复制到当前项目。 */
  onCopyPreset: (skills: string[]) => void;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<SkillPreset[] | null>(null);
  /** 读失败的原因。从前 catch → `setPresets([])`,界面画成「还没有预设。」——
   *  用户以为真的一套都没存,实际是一次读取失败(硬规矩 3:坏东西显式报出来)。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillPreset | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<SkillPreset | null>(null);
  /** 【MC-053 同族】清单文件损坏的原因。读侧仍给空表(页面可打开),但空态与
   *  「文件坏了」必须分开说 —— 否则用户会照着空表重建,覆盖掉原文件。 */
  const [storeCorrupt, setStoreCorrupt] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.skills.presetsList();
      setPresets(res.presets);
      setStoreCorrupt(res.corrupt?.reason ?? null);
      setLoadError(null);
    } catch (err: unknown) {
      // 保留上一次成功的表(一次瞬时失败不该把它抹掉);没有表 = 状态未知,
      // 由下面的错误横幅替代空态。
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (presets === null) {
    return loadError !== null ? (
      <ErrorNote
        title={t("settings.skills.presetsLoadFailed")}
        action={
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        }
      >
        {loadError}
      </ErrorNote>
    ) : (
      <LoadingNote label={t("common.loading")} className="px-2 py-3" />
    );
  }

  return (
    <div className="rounded-md border border-edge bg-surface/40">
      <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[0.8571em] font-medium text-content">
            {t("settings.skills.presets")}
          </span>
          <span className="truncate text-[0.7857em] text-content-subtle">
            {t("settings.skills.presetsHint")}
          </span>
        </div>
        <Button variant="ghost" size={null}
          type="button"
          onClick={() => setEditing({ id: "", name: "", skills: [], createdAt: 0, updatedAt: 0 })}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.8571em] text-content-muted transition-colors hover:bg-surface-hover/60 hover:text-content"
        >
          <IconPlus size={12} />
          {t("settings.skills.presetNew")}
        </Button>
      </div>

      {/* 刷新失败但旧表还在:横幅说原因,表保持可读(重试就是下面那颗按钮)。 */}
      {loadError !== null && (
        <div className="px-3 pt-2">
          <ErrorNote
            title={t("settings.skills.presetsLoadFailed")}
            action={
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                {t("common.retry")}
              </Button>
            }
          >
            {loadError}
          </ErrorNote>
        </div>
      )}

      {/* 【MC-053 同族】文件损坏:读得出来但读不懂。保存/删除会被主进程拒绝
          (不会拿空表当基准把原文件覆盖掉),这里把原因和恢复办法说清楚。 */}
      {storeCorrupt !== null && (
        <div className="px-3 pt-2">
          <ErrorNote tone="warning" title={t("settings.skills.presetsCorrupt")}>
            {storeCorrupt}
          </ErrorNote>
        </div>
      )}

      {presets.length === 0 && !editing && loadError === null && storeCorrupt === null && (
        <div className="px-3 py-4 text-center text-[0.8571em] text-content-subtle">
          {t("settings.skills.presetEmpty")}
        </div>
      )}

      {presets.map((p) => {
        const open = expanded.has(p.id);
        return (
          <div key={p.id} className="border-b border-edge/60 last:border-b-0">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => toggle(p.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {open ? (
                  <IconChevronDown size={12} className="shrink-0 text-content-subtle" />
                ) : (
                  <IconChevronRight size={12} className="shrink-0 text-content-subtle" />
                )}
                <span className="truncate text-[0.9286em] font-medium text-content">{p.name}</span>
                <span className="shrink-0 text-[0.7857em] text-content-subtle">
                  {t("settings.skills.presetCount", { n: p.skills.length })}
                </span>
              </Button>
              <Button variant="ghost" size={null}
                type="button"
                title={t("settings.skills.presetApply")}
                onClick={() => onCopyPreset(p.skills)}
                className="shrink-0 rounded p-1 text-content-subtle transition-colors hover:text-content"
              >
                <IconCopy size={13} />
              </Button>
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => setEditing(p)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[0.7857em] text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
              >
                {t("common.edit")}
              </Button>
              <Button variant="ghost" size={null}
                type="button"
                title={t("settings.skills.presetDelete")}
                onClick={() => setPendingDelete(p)}
                className="shrink-0 rounded p-1 text-content-subtle/60 transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <IconTrash size={12} />
              </Button>
            </div>
            {open && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-2 pl-8">
                {p.skills.map((n) => (
                  <span
                    key={n}
                    className="rounded border border-edge px-1.5 py-0.5 text-[0.7857em] text-content-muted"
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {editing && (
        <PresetEditor
          preset={editing}
          librarySkills={librarySkills}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title={t("settings.skills.presetDelete")}
        danger
        description={t("settings.skills.presetDeleteDesc", { name: pendingDelete?.name ?? "" })}
        confirmText={t("common.delete")}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        onConfirm={() => {
          const p = pendingDelete;
          setPendingDelete(null);
          if (!p) return;
          void (async () => {
            const res = await api.skills.presetsDelete({ id: p.id });
            if (!res.ok) {
              useToastStore.getState().push({ kind: "error", title: res.error ?? "" });
            }
            void load();
          })();
        }}
      />
    </div>
  );
}

/** 新建 / 编辑一套预设。技能用**勾选**而不是手打名字 —— 名字打错会静默复制不到。 */
function PresetEditor({
  preset,
  librarySkills,
  onCancel,
  onSaved,
}: {
  preset: SkillPreset;
  librarySkills: SkillInfo[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(preset.name);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preset.skills));
  const [busy, setBusy] = useState(false);

  // 只列通用库的 —— 项目技能和插件技能**不能进预设**：项目技能属于某个项目、
  // 复制到别的项目时源不在通用库里；插件技能是别人管的，复制出去会变成孤儿拷贝。
  // 与「复制到项目」的 `canCopy` 同一条判据。
  const candidates = useMemo(
    () => librarySkills.filter((s) => s.source === "global"),
    [librarySkills],
  );

  const save = useCallback(async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await api.skills.presetsSave({
        preset: {
          // 新建时现铸 id —— 主进程按 id 判断是新建还是覆盖。
          id: preset.id || `sp_${Math.random().toString(36).slice(2, 10)}`,
          name: trimmed,
          skills: [...picked],
        },
      });
      if (!res.ok) {
        useToastStore.getState().push({ kind: "error", title: res.error ?? "" });
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [name, picked, preset.id, onSaved]);

  return (
    <div className="border-t border-edge bg-surface-muted/40 px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <label className="w-20 shrink-0 text-[0.8571em] text-content-muted">
          {t("settings.skills.presetName")}
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.skills.presetNamePh")}
          className="min-w-0 flex-1 rounded border border-input-edge bg-surface px-2 py-1 text-[0.9286em] text-content outline-none focus:border-accent"
        />
      </div>
      <div className="mb-1 text-[0.8571em] text-content-muted">
        {t("settings.skills.presetSkills")}
        {picked.size > 0 && (
          <span className="ml-1.5 text-content-subtle">
            {t("settings.skills.presetCount", { n: picked.size })}
          </span>
        )}
      </div>
      <div className="mb-2 max-h-56 overflow-auto rounded border border-edge bg-surface/60 p-1.5">
        {candidates.length === 0 && (
          <div className="px-2 py-3 text-center text-[0.8571em] text-content-subtle">
            {t("settings.skills.listEmpty1")}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {candidates.map((s) => {
            const on = picked.has(s.name);
            return (
              <Button variant="ghost" size={null}
                key={s.name}
                type="button"
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.name)) next.delete(s.name);
                    else next.add(s.name);
                    return next;
                  })
                }
                className={cn(
                  "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.8571em] transition-colors",
                  on
                    ? "border-edge/80 bg-surface-hover font-medium text-content ring-1 ring-inset ring-edge/70"
                    : "border-edge text-content-muted hover:bg-surface-hover/60",
                )}
              >
                <IconSparkles size={11} />
                {s.name}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size={null}
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[0.8571em] text-content-muted transition-colors hover:bg-surface-hover/60 hover:text-content"
        >
          {t("settings.skills.presetCancel")}
        </Button>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {t("settings.skills.presetSave")}
        </Button>
      </div>
    </div>
  );
}
