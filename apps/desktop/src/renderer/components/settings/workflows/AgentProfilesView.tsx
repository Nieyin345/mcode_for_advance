/**
 * 代理档案(工作流面板「节点类型」页签里的下半页)。
 *
 * ## 为什么和节点类型挤在同一页
 *
 * 两者回答的是同一个问题的两面:"**有哪些节点**可用"和"**我配好的那几个子 agent**
 * 长什么样"。分开成两个页签的话,用户看完"子 agent 这个类型要哪些参数"之后要换个页签
 * 才能去改那几份配置 —— 而后者正是他刚才那份清单的产物。
 *
 * 更重要的是:档案**没有自己的类型**。一份档案是"某个节点类型的一组参数"
 * (见 `@contracts/agentProfile` 文件头),所以它天然该出现在那一页的旁边。
 *
 * ## 编辑在这里,创建不在这里
 *
 * 「新建」的正路是在画布上配好一个节点、按「存为档案」—— 那样参数是**试过**的。这一页
 * 也留了一个「新建」(给"我先建一份空的一点点配"的人),但它只是把那件事反过来做。
 *
 * 二次编辑则只有这里有:一份存下来的档案,名字要改、指令要改、技能要加一个,都不该
 * 逼着用户先建一个节点、改好、再覆盖回去。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { Menu } from "@base-ui/react/menu";
import { makeAgentProfileId, type AgentProfile } from "@contracts/agentProfile";
import { defaultParamsOf, isRunnerImplemented, type NodeTypeCatalog } from "@contracts/nodeType";
import { IconAlertTriangle, IconCheck, IconChevronDown, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { Field, ParamField } from "./ParamField.js";
import { WorkflowBadge } from "./WorkflowBadge.js";

export function AgentProfilesView({
  catalog,
  profiles,
  problems,
  error,
  onSave,
  onRemove,
}: {
  /** 用来把档案的参数渲染成控件、以及显示类型名。 */
  catalog: NodeTypeCatalog | null;
  profiles: AgentProfile[];
  /** 读得见但用不了的文件(见 `@contracts/agentProfile` 的 `AgentProfileCatalog`)。 */
  problems: Array<{ file: string; error: string }>;
  /** 上一次存/删失败的原因。**由上面持有** —— 它不是这一页自己的状态。 */
  error: string | null;
  onSave: (profile: AgentProfile) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  /** 正在编辑的那一份(草稿)。`null` = 没有在编辑。 */
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const manifestOf = (typeId: string) =>
    catalog?.entries.find((e) => e.id === typeId)?.manifest ?? null;

  const startNew = (typeId: string): void => {
    const manifest = manifestOf(typeId);
    if (!manifest) return;
    const now = Date.now();
    setDraft({
      version: 1,
      id: makeAgentProfileId(now),
      name: manifest.name,
      type: typeId,
      // 空档案 = 那个类型的**默认参数**,不是空对象 —— 空对象在编辑界面里什么都画不出
      // 来(每个字段都缺),而默认值至少让用户看到"一份没改过的配置长什么样"。
      params: defaultParamsOf(manifest),
      createdAt: now,
      updatedAt: now,
    });
  };

  const submit = async (): Promise<void> => {
    if (!draft || draft.name.trim().length === 0) return;
    setBusy(true);
    await onSave({ ...draft, name: draft.name.trim(), updatedAt: Date.now() });
    setBusy(false);
    setDraft(null);
  };

  // 能拿来新建档案的类型:**跑得了的**那些。一个跑不了的类型存出来的档案,套到节点上
  // 也一样跑不了 —— 与其让它出现在这里,不如就让那个类型只出现在上面的清单里。
  const runnableTypes = (catalog?.entries ?? []).filter((e) =>
    isRunnerImplemented(e.manifest.runner.kind),
  );

  return (
    <section className="mt-5 border-t border-edge pt-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
          {t("settings.workflows.profilesTitle")}
        </span>
        <span className="tabular-nums text-[0.7143em] text-content-subtle">{profiles.length}</span>
        <div className="flex-1" />
        <Menu.Root open={newMenuOpen} onOpenChange={setNewMenuOpen}>
          <Menu.Trigger
            disabled={runnableTypes.length === 0 || draft !== null}
            className={cn(
              "flex items-center gap-1 rounded border border-edge bg-surface px-2 py-0.5 text-[0.7143em]",
              "text-content-muted transition-colors hover:bg-surface-hover/60 hover:text-content",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <IconPlus size={11} />
            {t("settings.workflows.profileNew")}
            <IconChevronDown size={10} className="opacity-70" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
              <Menu.Popup className="max-h-[260px] min-w-[200px] overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-2xl">
                {runnableTypes.map((entry) => (
                  <Menu.Item
                    key={entry.id}
                    onClick={() => {
                      startNew(entry.id);
                      setNewMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left outline-none select-none",
                      "data-[highlighted]:bg-surface-muted",
                    )}
                  >
                    <span className="text-[0.8571em] text-content">{entry.manifest.name}</span>
                    <code className="text-[0.7143em] text-content-subtle">{entry.id}</code>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      <p className="mb-2 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("settings.workflows.profilesIntro")}
      </p>

      {error !== null && (
        <div className="mb-2 flex items-start gap-2 rounded border border-edge p-2 text-[0.7143em] leading-relaxed text-danger">
          <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* 坏文件**不静默丢弃**:用户看到的现象会是"我存的档案不见了",而这里是他唯一
          能知道为什么的地方(同上面节点类型那块)。 */}
      {problems.length > 0 && (
        <div className="mb-2 rounded border border-warning/40 bg-warning/5 p-2">
          <div className="flex items-center gap-2 text-[0.7143em] font-medium text-content">
            <IconAlertTriangle size={12} className="shrink-0 text-warning" />
            {t("settings.workflows.problemsTitle", { n: problems.length })}
          </div>
          <ul className="mt-1 space-y-0.5">
            {problems.map((problem) => (
              <li key={problem.file} className="text-[0.7143em] leading-relaxed">
                <code className="break-all text-content-muted">{problem.file}</code>
                <div className="text-danger">{problem.error}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draft !== null ? (
        <ProfileEditor
          draft={draft}
          manifest={manifestOf(draft.type)}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmit={() => void submit()}
        />
      ) : null}

      {profiles.length === 0 && draft === null ? (
        <p className="py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.profilesEmpty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {profiles.map((profile) => {
            const manifest = manifestOf(profile.type);
            return (
              <li
                key={profile.id}
                className="flex items-start gap-2 rounded border border-edge bg-surface/40 p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[0.7857em] font-medium text-content">
                      {profile.name}
                    </span>
                    <code className="rounded bg-surface-muted px-1 text-[0.7143em] text-content-subtle">
                      {profile.type}
                    </code>
                    {/* 类型没装:一份档案引用了没装的类型 —— **不是错误**(同工作流里
                        "类型缺失不算错误"),但它跑不了,得说出来。 */}
                    {manifest === null ? (
                      <WorkflowBadge tone="muted">
                        {t("settings.workflows.profileTypeMissing")}
                      </WorkflowBadge>
                    ) : (
                      <span className="text-[0.7143em] text-content-subtle">{manifest.name}</span>
                    )}
                  </div>
                  {profile.description && (
                    <p className="mt-0.5 text-[0.7143em] leading-relaxed text-content-muted">
                      {profile.description}
                    </p>
                  )}
                  {manifest !== null && <ParamSummary profile={profile} manifest={manifest} />}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft({ ...profile })}
                    disabled={draft !== null}
                  >
                    {t("common.edit")}
                  </Button>
                  <button
                    type="button"
                    title={t("settings.workflows.removeProfile")}
                    onClick={() => void onRemove(profile.id)}
                    className="rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-danger"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 一份档案里**填过**的那几个参数,压成一行小字。让人一眼看出这份配置和别的那份差在
 *  哪里 —— 否则列表里几份同名不同配置的档案完全分不出来。 */
function ParamSummary({
  profile,
  manifest,
}: {
  profile: AgentProfile;
  manifest: { params: Array<{ key: string; label: string }> };
}) {
  const filled = manifest.params.filter((spec) => {
    const value = profile.params[spec.key];
    if (value === undefined || value === null || value === "") return false;
    return !(Array.isArray(value) && value.length === 0);
  });
  if (filled.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {filled.map((spec) => (
        <span
          key={spec.key}
          className="rounded bg-surface-muted px-1 py-0.5 text-[0.7143em] text-content-subtle"
        >
          {spec.label}
        </span>
      ))}
    </div>
  );
}

/** 一份档案的编辑态:名字、说明,加上**那个类型的全部参数**(形状由清单说了算,所以
 *  控件和节点检查器里的完全是同一套 —— 见 `ParamField` 的文件头)。 */
function ProfileEditor({
  draft,
  manifest,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: AgentProfile;
  manifest: NodeTypeCatalog["entries"][number]["manifest"] | null;
  busy: boolean;
  onChange: (draft: AgentProfile) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const canSave = draft.name.trim().length > 0 && !busy;

  return (
    <div className="mb-2 rounded border border-accent/40 bg-surface/60 p-2.5">
      <Field label={t("settings.hooks.fieldName")} required>
        <Input
          type="text"
          autoFocus
          value={draft.name}
          maxLength={60}
          spellCheck={false}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </Field>
      <Field label={t("settings.workflows.fieldDescription")}>
        <Input
          type="text"
          value={draft.description ?? ""}
          maxLength={200}
          spellCheck={false}
          onChange={(e) =>
            onChange({
              ...draft,
              ...(e.target.value.length > 0
                ? { description: e.target.value }
                : { description: undefined }),
            })
          }
        />
      </Field>

      {manifest === null ? (
        <p className="mb-2 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-warning">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t("settings.workflows.profileTypeMissingDetail", { type: draft.type })}
        </p>
      ) : (
        manifest.params.map((spec) => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={draft.params[spec.key]}
            onChange={(value) =>
              onChange({ ...draft, params: { ...draft.params, [spec.key]: value } })
            }
          />
        ))
      )}

      <div className="mt-1 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!canSave} onClick={onSubmit} className="gap-1">
          <IconCheck size={12} />
          {t("common.save")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
