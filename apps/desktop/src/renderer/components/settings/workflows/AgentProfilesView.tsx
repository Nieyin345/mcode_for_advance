/**
 * 代理档案页(工作流面板的第三个页签)。
 *
 * ## 这一页回答的问题
 *
 * 「我配好的那几个步骤在哪、哪个是哪个、怎么改」。
 *
 * 从前它是**节点类型那一页的下半部分** —— 一个平铺的列表,分不出「读论文」和
 * 「读论文(快)」哪个是子 agent、哪个是对话节点。节点类型多起来之后(用户的原话:
 * 「现在的节点类型也多了」),那个列表就变成了"一堆名字"。现在它是自己的一页:
 *
 *   ┌─ 左:按节点类型 ─┬─ 右:这一类的档案 ────────────────┐
 *   │ 通用                       │ 子 agent            通用  │
 *   │  • 子 agent          3     │ code-instruction          │
 *   │  • 对话节点          1     │   · 读论文      编辑 删除  │
 *   │ 自动化                     │   · 读论文(快)  编辑 删除  │
 *   │  • 命令              2     │ ─────────────────────────  │
 *   │ [+ 新建档案]               │ （点「编辑」就地展开表单） │
 *   └────────────────────────────┴────────────────────────────┘
 *
 * ## 分类的规则只有一份
 *
 * 「同一种节点的档案归一组」这条算术在 `agentProfileGroups.ts` 里,是个纯函数 —— 这
 * 一页只负责把它画出来。分清"算"和"画"是为了能单独断言前者:SSR 下点不动任何东西,
 * 而分组次序错了正是那种"看着有点怪但说不上哪错"的毛病。
 *
 * ## 编辑在这里,创建有两个入口
 *
 * - 左边那个「新建档案」是**先挑类型、再配参数**(给"我先建一份空的一点点配"的人);
 * - 画布上配好一个节点、按「存为档案」是反过来(那样参数是**试过**的,见
 *   `NodeInspector`),这一页不重复那条路,只是能看见它的结果。
 * - 每一组右上角还有一个「+」:在那个类型下面直接加一份,不用在菜单里再找一次类型。
 *
 * 二次编辑则只有这里有:一份存下来的档案,名字要改、指令要改、技能要加一个,都不该
 * 逼着用户先建一个节点、改好、再覆盖回去。
 *
 * ## 一次只开一份草稿
 *
 * 草稿是**内存里的**,存下去才落盘。开着草稿时「编辑」「新建」都按不动 —— 不是防
 * 用户,是因为这一页只有**一个**草稿位:允许点第二个就等于允许静默丢掉第一个。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { Menu } from "@base-ui/react/menu";
import { makeAgentProfileId, type AgentProfile } from "@contracts/agentProfile";
import { defaultParamsOf, isNodeRunnable, type NodeTypeCatalog } from "@contracts/nodeType";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconLoader2,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { Field, ParamField } from "./ParamField.js";
import { WorkflowBadge } from "./WorkflowBadge.js";
import { groupProfiles } from "./agentProfileGroups.js";

export function AgentProfilesView({
  catalog,
  profiles,
  loading,
  problems,
  error,
  onSave,
  onRemove,
}: {
  /** 用来把档案的参数渲染成控件、以及显示类型名。`null` = 还没读回来。 */
  catalog: NodeTypeCatalog | null;
  profiles: AgentProfile[];
  /** 第一次拉档案还没回来。**与"拉回来了但是空的"必须分开** —— 否则每次打开这一页
   *  都会先闪一下"还没有档案"。 */
  loading: boolean;
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
  /** 左栏选中的那一组(节点类型 id)。`null` = 用户还没点过,用第一组。 */
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const manifestOf = (typeId: string) =>
    catalog?.entries.find((e) => e.id === typeId)?.manifest ?? null;

  const groups = groupProfiles(profiles, catalog);
  // 当前这一组。**用户点过的那个优先**:开着草稿时点了别的组,右栏要跟着走 ——
  // 草稿留在它自己那一组里(左栏那一行会带上「未保存」),回来就还在。
  const activeType = selectedType ?? draft?.type ?? groups[0]?.typeId ?? null;
  const activeGroup = groups.find((g) => g.typeId === activeType) ?? null;
  /** 左栏要画的那几行 = 已存在的组 + 草稿所在的那个类型(第一次新建时它还不成组)。 */
  const draftType = draft !== null && !groups.some((g) => g.typeId === draft.type) ? draft.type : null;

  const startNew = (typeId: string): void => {
    const manifest = manifestOf(typeId);
    if (!manifest) return;
    const now = Date.now();
    setSelectedType(typeId);
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
  // 也一样跑不了 —— 与其让它出现在这里,不如就让那个类型只出现在节点类型那一页里。
  // 判据用 `isNodeRunnable`(清单 + 参数的形状),与调度器的拒绝同一份答案。
  const runnableTypes = (catalog?.entries ?? []).filter((e) => isNodeRunnable(e.manifest));

  /** 一行档案。列表行与"刚新建的那一份"长得一样,所以只有这一份。 */
  const profileRow = (profile: AgentProfile, manifest: ReturnType<typeof manifestOf>) => (
    <li
      key={profile.id}
      className="flex items-start gap-2 rounded border border-edge bg-surface/40 p-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.7857em] font-medium text-content">{profile.name}</span>
          {profile.description && (
            <span className="min-w-0 text-[0.7143em] leading-relaxed text-content-muted">
              {profile.description}
            </span>
          )}
        </div>
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

  return (
    <section className="flex min-h-0 flex-1 gap-4">
      {/* ───────── 左栏:按节点类型的分类 ───────── */}
      <aside className="flex w-56 shrink-0 flex-col rounded-md border border-edge bg-surface/40">
        <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
          <span>{t("settings.agentProfiles.byType")}</span>
          <span className="tabular-nums">{loading ? "…" : profiles.length}</span>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
          {groups.length === 0 && draftType === null && (
            <p className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
              {loading ? t("common.loading") : t("settings.workflows.profilesEmpty")}
            </p>
          )}
          {groups.map((group) => {
            const active = group.typeId === activeType;
            return (
              <button
                key={group.typeId}
                type="button"
                onClick={() => setSelectedType(group.typeId)}
                className={cn(
                  "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                  active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                )}
                {/* 分类是清单里写的字(「通用」「自动化」…),原样显示 —— 它是数据,
                    不是界面词。装在没写分类的类型上时这一行不出现。 */}
                {group.category !== "" && (
                  <div className="truncate text-[10px] uppercase tracking-wide text-content-subtle/80">
                    {group.category}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[0.7857em] font-medium",
                      active ? "text-content" : "text-content-muted",
                    )}
                  >
                    {group.title}
                  </span>
                  {draft !== null && draft.type === group.typeId && (
                    <WorkflowBadge tone="accent">
                      {t("settings.agentProfiles.draftBadge")}
                    </WorkflowBadge>
                  )}
                  <span className="shrink-0 tabular-nums text-[0.7143em] text-content-subtle">
                    {group.profiles.length}
                  </span>
                </div>
              </button>
            );
          })}
          {/* 刚点开的新建还没存过 —— 它还不算一组,但用户必须看得见自己在哪儿,否则
              左栏会指在别的一组上(或者什么都没有)。 */}
          {draftType !== null && (
            <div className="relative rounded bg-surface-hover px-2.5 py-1.5">
              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
              <div className="truncate text-[0.7857em] font-medium text-content">
                {manifestOf(draftType)?.name ?? draftType}
              </div>
              <code className="block truncate text-[10px] text-content-subtle">{draftType}</code>
            </div>
          )}
        </nav>
        <div className="border-t border-edge p-1.5">
          <Menu.Root open={newMenuOpen} onOpenChange={setNewMenuOpen}>
            <Menu.Trigger
              disabled={runnableTypes.length === 0 || draft !== null}
              className={cn(
                "flex w-full items-center justify-center gap-1 rounded border border-edge bg-surface px-2 py-1 text-[0.7857em]",
                "text-content-muted transition-colors hover:bg-surface-hover/60 hover:text-content",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <IconPlus size={11} />
              {t("settings.workflows.profileNew")}
              <IconChevronDown size={10} className="opacity-70" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
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
      </aside>

      {/* ───────── 右栏:这一类的档案 + 就地编辑 ───────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pr-1">
        {/* 存/删失败与坏文件都摆在**最上面**:它们是这一页整体的问题,不属于任何一组。
            坏文件**不静默丢弃** —— 用户看到的现象会是"我存的档案不见了",而这里是
            他唯一能知道为什么的地方。 */}
        {error !== null && (
          <div className="mb-2 flex items-start gap-2 rounded border border-edge p-2 text-[0.7857em] leading-relaxed text-danger">
            <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {problems.length > 0 && (
          <div className="mb-2 rounded border border-warning/40 bg-warning/5 p-2.5">
            <div className="flex items-center gap-2 text-[0.7857em] font-medium text-content">
              <IconAlertTriangle size={13} className="shrink-0 text-warning" />
              {t("settings.agentProfiles.brokenFiles", { n: problems.length })}
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

        {activeGroup === null && draft === null ? (
          // 一份档案都没有:说的是**怎么才能有**。旋转图标只在"还没读回来"时出现 ——
          // 空列表和"还在读"是两件事。
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            {loading ? (
              <div className="flex items-center gap-2 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <>
                <p className="text-[0.7857em] text-content-muted">
                  {t("settings.workflows.profilesEmpty")}
                </p>
                <p className="max-w-[420px] text-[0.7143em] leading-relaxed text-content-subtle">
                  {t("settings.workflows.profilesIntro")}
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="min-w-0 truncate text-[0.8571em] font-medium text-content">
                {activeGroup?.title ?? (draft !== null ? manifestOf(draft.type)?.name ?? draft.type : "")}
              </span>
              <code className="shrink-0 rounded bg-surface-muted px-1 text-[0.7143em] text-content-subtle">
                {activeType}
              </code>
              {/* 类型没装:一份档案引用了没装的类型 —— **不是错误**(同工作流里
                  "类型缺失不算错误"),但它跑不了,得说出来。 */}
              {activeGroup !== null && activeGroup.manifest === null && (
                <WorkflowBadge tone="muted">
                  {t("settings.workflows.profileTypeMissing")}
                </WorkflowBadge>
              )}
              <div className="flex-1" />
              {activeType !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={draft !== null || manifestOf(activeType) === null}
                  onClick={() => startNew(activeType)}
                  title={t("settings.agentProfiles.newInGroup")}
                  className="shrink-0 gap-1"
                >
                  <IconPlus size={11} />
                  {t("common.create")}
                </Button>
              )}
            </div>

            {activeGroup !== null && activeGroup.manifest === null && (
              <p className="mb-2 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-warning">
                <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                {t("settings.workflows.profileTypeMissingDetail", { type: activeGroup.typeId })}
              </p>
            )}

            {/* 编辑就地展开在**这一组的最上面**:改完存下,内容回到下面的列表里,
                眼睛不用换地方。 */}
            {draft !== null && draft.type === activeType && (
              <ProfileEditor
                draft={draft}
                manifest={manifestOf(draft.type)}
                busy={busy}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSubmit={() => void submit()}
              />
            )}

            <ul className="space-y-1.5">
              {activeGroup?.profiles.map((profile) =>
                profileRow(profile, manifestOf(profile.type)),
              )}
              {activeGroup === null && (
                <li className="py-3 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                  {t("settings.agentProfiles.emptyGroup")}
                </li>
              )}
            </ul>
          </>
        )}
      </div>
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
            // 清单写了 `fromParam` 的参数,候选要跟着**它指的那个参数此刻的值**收窄
            // (见 `NodeParamSpecSchema.fromParam`)。档案这一页的顺序保证与检查器一致:
            // 那两个参数在 `params[]` 里的先后由清单决定。
            {...(spec.fromParam !== undefined
              ? { resolvedFrom: asParamText(draft.params[spec.fromParam]) }
              : {})}
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

/** 参数值当文本读(级联的 `resolvedFrom` 只认字符串)。 */
function asParamText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
