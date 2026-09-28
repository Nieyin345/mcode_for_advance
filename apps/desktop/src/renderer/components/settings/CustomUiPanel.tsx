/**
 * 设置 → **自定义 UI**。
 *
 * 用户定的规矩:主界面只放入口(右键菜单里的一项),点下去做什么、显示什么,全在这一页
 * 定义。左边列挂载位(资料库四级右键 + Files 文件右键),右边是这个位置上的功能项:
 *
 *   - 内置项(文献信息、加入对话、采纳 MD……):只能**显示/隐藏、排序**;
 *   - JSON 模块项(v1 模块清单声明的文件工具):同上;
 *   - 自定义项:还能编辑、删除。
 *
 * 管理项(重命名 / 移动复制 / 删除 / 打开文件夹 / 新建分类 / 新建笔记)不列在这里 ——
 * 它们是固定的。
 *
 * 配置整份存一个设置键(见 `@contracts/customUi`)。每一次改动都是「算出下一份 → save」,
 * 不原地改 store 里那一份(选择器要稳定引用)。
 */
import { useEffect, useMemo, useState } from "react";
import {
  CUSTOM_UI_ICONS,
  CUSTOM_UI_SLOTS,
  CustomUiItemSchema,
  TEMPLATE_VARS_BY_SLOT,
  arrangeSlotEntries,
  builtinKey,
  coerceCustomUiConfig,
  customKey,
  customUiLabel,
  moduleKey,
  normalizeExtension,
  targetKindOfSlot,
  type CustomUiActionType,
  type CustomUiConfig,
  type CustomUiIcon,
  type CustomUiItem,
  type CustomUiSlot,
} from "@contracts/customUi";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { translate, useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, ConfirmDialog, ErrorNote, Switch } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { ModuleSurface, ModuleToolsButton } from "@renderer/components/modules/ModuleSurface.js";
import {
  IconAdjustmentsHorizontal,
  IconArrowDown,
  IconArrowUp,
  IconPencil,
  IconPlus,
  IconTemplate,
  IconTrash,
} from "@renderer/lib/icons.js";
import { BUILTINS, CUSTOM_ICONS, DEFAULT_ACTION_ICON, type IconComponent } from "../customUi/registry.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";

const FIELD =
  "w-full rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs text-content outline-none focus:border-accent";
const LABEL = "block space-y-1 text-[0.8571em] text-content-muted";

/* ────────────────────────── 列表 ────────────────────────── */

interface Row {
  key: string;
  source: "builtin" | "custom" | "module";
  label: string;
  icon: IconComponent;
  hidden: boolean;
  item?: CustomUiItem;
}

/* ────────────────────────── 编辑器草稿 ────────────────────────── */

interface Draft {
  isNew: boolean;
  id: string;
  slot: CustomUiSlot;
  labelZh: string;
  labelEn: string;
  icon: CustomUiIcon | "";
  extensions: string;
  requires: "" | "file" | "pdf" | "markdown";
  groupIds: string[];
  actionType: CustomUiActionType;
  viewTitle: string;
  viewBody: string;
  promptTemplate: string;
  promptAttach: boolean;
  copyTemplate: string;
  workflowId: string;
  triggerNodeId: string;
}

function newId(existing: readonly CustomUiItem[]): string {
  const taken = new Set(existing.map((i) => i.id));
  for (;;) {
    const id = `u-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    if (!taken.has(id)) return id;
  }
}

function blankDraft(slot: CustomUiSlot, items: readonly CustomUiItem[]): Draft {
  return {
    isNew: true,
    id: newId(items),
    slot,
    labelZh: "",
    labelEn: "",
    icon: "",
    extensions: "",
    requires: "",
    groupIds: [],
    actionType: targetKindOfSlot(slot) === "file" ? "copy" : "prompt",
    viewTitle: "",
    viewBody: "",
    promptTemplate: "",
    promptAttach: targetKindOfSlot(slot) !== "file",
    copyTemplate: "",
    workflowId: "",
    triggerNodeId: "",
  };
}

function draftOf(item: CustomUiItem): Draft {
  const d = blankDraft(item.slot, []);
  const a = item.action;
  return {
    ...d,
    isNew: false,
    id: item.id,
    labelZh: item.label.zh,
    labelEn: item.label.en ?? "",
    icon: item.icon ?? "",
    extensions: (item.when?.extensions ?? []).join(", "),
    requires: item.when?.requires ?? "",
    groupIds: item.when?.groupIds ?? [],
    actionType: a.type,
    viewTitle: a.type === "view" ? (a.title ?? "") : "",
    viewBody: a.type === "view" ? a.body : "",
    promptTemplate: a.type === "prompt" ? a.template : "",
    promptAttach: a.type === "prompt" ? a.attach === true : d.promptAttach,
    copyTemplate: a.type === "copy" ? a.template : "",
    workflowId: a.type === "automation" ? a.workflowId : "",
    triggerNodeId: a.type === "automation" ? a.triggerNodeId : "",
  };
}

/** 草稿 → 自定义项。校验失败返回错误键。 */
function itemOf(d: Draft): { ok: true; item: CustomUiItem } | { ok: false; error: MessageId } {
  if (d.labelZh.trim().length === 0) return { ok: false, error: "customUi.editor.errorLabel" };
  const action: CustomUiItem["action"] =
    d.actionType === "view"
      ? { type: "view", ...(d.viewTitle.trim() ? { title: d.viewTitle.trim() } : {}), body: d.viewBody }
      : d.actionType === "prompt"
        ? { type: "prompt", template: d.promptTemplate, attach: d.promptAttach }
        : d.actionType === "copy"
          ? { type: "copy", template: d.copyTemplate }
          : { type: "automation", workflowId: d.workflowId, triggerNodeId: d.triggerNodeId };
  if (action.type === "automation" && (!action.workflowId || !action.triggerNodeId)) {
    return { ok: false, error: "customUi.editor.errorAutomation" };
  }
  const extensions = d.extensions
    .split(/[,，\s]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map(normalizeExtension);
  const when = {
    ...(extensions.length ? { extensions } : {}),
    ...(d.requires ? { requires: d.requires } : {}),
    ...(d.groupIds.length ? { groupIds: d.groupIds } : {}),
  };
  const candidate = {
    id: d.id,
    slot: d.slot,
    label: { zh: d.labelZh.trim(), ...(d.labelEn.trim() ? { en: d.labelEn.trim() } : {}) },
    ...(d.icon ? { icon: d.icon } : {}),
    ...(Object.keys(when).length ? { when } : {}),
    action,
  };
  const r = CustomUiItemSchema.safeParse(candidate);
  return r.success ? { ok: true, item: r.data } : { ok: false, error: "customUi.editor.errorLabel" };
}

/** 模板 → 草稿。名字中英两份都按词典填,提示词按当前界面语言。 */
function templateDraft(
  id: string,
  slot: CustomUiSlot,
  items: readonly CustomUiItem[],
  locale: "zh" | "en",
): Draft {
  const d = blankDraft(slot, items);
  const both = (key: MessageId) => ({ labelZh: translate("zh", key), labelEn: translate("en", key) });
  switch (id) {
    case "transcribe":
      return {
        ...d,
        ...both("customUi.template.transcribe.label"),
        icon: "file-text",
        actionType: "automation",
        requires: slot === "library.item" ? "pdf" : "",
      };
    case "cite":
      return {
        ...d,
        ...both("customUi.template.cite.label"),
        icon: "quote",
        actionType: "prompt",
        promptTemplate: translate(locale, "customUi.template.cite.prompt"),
        promptAttach: true,
      };
    case "summarize":
      return {
        ...d,
        ...both("customUi.template.summarize.label"),
        icon: "sparkles",
        actionType: "prompt",
        promptTemplate: translate(locale, "customUi.template.summarize.prompt"),
        promptAttach: true,
      };
    default:
      return {
        ...d,
        ...both("customUi.template.copyPath.label"),
        icon: "copy",
        actionType: "copy",
        copyTemplate: "{{file.path}}",
      };
  }
}

const TEMPLATES_BY_SLOT: Record<CustomUiSlot, readonly { id: string; labelKey: MessageId }[]> = {
  "library.item": [
    { id: "transcribe", labelKey: "customUi.template.transcribe.label" },
    { id: "cite", labelKey: "customUi.template.cite.label" },
  ],
  "library.collection": [
    { id: "summarize", labelKey: "customUi.template.summarize.label" },
    { id: "transcribe", labelKey: "customUi.template.transcribe.label" },
  ],
  "library.subcategory": [
    { id: "summarize", labelKey: "customUi.template.summarize.label" },
    { id: "transcribe", labelKey: "customUi.template.transcribe.label" },
  ],
  "library.group": [{ id: "transcribe", labelKey: "customUi.template.transcribe.label" }],
  "files.context": [{ id: "copyPath", labelKey: "customUi.template.copyPath.label" }],
};

/* ────────────────────────── 面板 ────────────────────────── */

export function CustomUiPanel() {
  const { t, locale } = useI18n();
  const config = useCustomUiStore((s) => s.config);
  const loaded = useCustomUiStore((s) => s.loaded);
  const load = useCustomUiStore((s) => s.load);
  const save = useCustomUiStore((s) => s.save);
  const focusSlot = useCustomUiStore((s) => s.focusSlot);
  const setFocusSlot = useCustomUiStore((s) => s.setFocusSlot);
  const [slot, setSlot] = useState<CustomUiSlot>(focusSlot ?? "library.item");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CustomUiItem | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);
  // 从菜单「自定义 UI…」进来:选中那个挂载位,然后把一次性的「聚焦」清掉
  useEffect(() => {
    if (focusSlot) {
      setSlot(focusSlot);
      setFocusSlot(null);
    }
  }, [focusSlot, setFocusSlot]);
  useEffect(() => setTemplateOpen(false), [slot]);

  const catalog = useRpc(() => api.modules.catalog(), [], { toastOnError: false });

  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, Row>();
    for (const b of BUILTINS[slot]) {
      byKey.set(builtinKey(b.id), { key: builtinKey(b.id), source: "builtin", label: t(b.labelKey), icon: b.icon, hidden: false });
    }
    if (slot === "files.context") {
      for (const m of catalog.data?.modules ?? []) {
        for (const c of m.contributions) {
          const key = moduleKey(m.id, c.id);
          byKey.set(key, { key, source: "module", label: c.title[locale], icon: DEFAULT_ACTION_ICON.view, hidden: false });
        }
      }
    }
    for (const item of config.items) {
      if (item.slot !== slot) continue;
      const key = customKey(item.id);
      byKey.set(key, {
        key,
        source: "custom",
        label: customUiLabel(item.label, locale),
        icon: item.icon ? CUSTOM_ICONS[item.icon] : DEFAULT_ACTION_ICON[item.action.type],
        hidden: false,
        item,
      });
    }
    const layout = config.layout[slot];
    const hidden = new Set(layout?.hidden ?? []);
    return arrangeSlotEntries([...byKey.keys()], layout, { includeHidden: true }).flatMap((k) => {
      const r = byKey.get(k);
      return r ? [{ ...r, hidden: hidden.has(k) }] : [];
    });
  }, [slot, config, catalog.data, locale, t]);

  const saveLayout = (order: string[], hidden: string[]) => {
    void save({ ...config, layout: { ...config.layout, [slot]: { order, hidden } } });
  };
  const hiddenNow = config.layout[slot]?.hidden ?? [];
  const move = (index: number, delta: -1 | 1) => {
    const order = rows.map((r) => r.key);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j] as string, order[index] as string];
    saveLayout(order, hiddenNow);
  };
  const toggle = (key: string, visible: boolean) => {
    const set = new Set(hiddenNow);
    if (visible) set.delete(key);
    else set.add(key);
    saveLayout(
      rows.map((r) => r.key),
      [...set],
    );
  };
  const resetLayout = () => {
    const layout = { ...config.layout };
    delete layout[slot];
    void save({ ...config, layout });
  };
  const commitDraft = (item: CustomUiItem) => {
    const exists = config.items.some((i) => i.id === item.id);
    const items = exists ? config.items.map((i) => (i.id === item.id ? item : i)) : [...config.items, item];
    void save({ ...config, items });
    setDraft(null);
  };
  const removeItem = (item: CustomUiItem) => {
    const key = customKey(item.id);
    const layout: CustomUiConfig["layout"] = {};
    for (const s of CUSTOM_UI_SLOTS) {
      const l = config.layout[s];
      if (l) layout[s] = { order: l.order.filter((k) => k !== key), hidden: l.hidden.filter((k) => k !== key) };
    }
    void save({ ...config, items: config.items.filter((i) => i.id !== item.id), layout });
  };

  return (
    <div className="space-y-5 pb-6">
      <PanelHeader title={t("customUi.title")} icon={IconAdjustmentsHorizontal} />
      <p className="text-[0.8571em] leading-relaxed text-content-subtle">{t("customUi.intro")}</p>

      <div className="flex min-h-[320px] gap-4">
        {/* 挂载位 */}
        <nav className="w-52 shrink-0 space-y-0.5" data-testid="custom-ui-slots">
          {CUSTOM_UI_SLOTS.map((s) => {
            const count = config.items.filter((i) => i.slot === s).length;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSlot(s)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-xs transition-colors",
                  s === slot
                    ? "bg-surface-hover font-medium text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
              >
                <span className="truncate">{t(`customUi.slot.${s}` as MessageId)}</span>
                {count > 0 && <span className="shrink-0 text-[0.8571em] text-content-subtle">{count}</span>}
              </button>
            );
          })}
        </nav>

        {/* 这个挂载位上的功能项 */}
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-[0.8571em] text-content-subtle">{t(`customUi.slotHint.${slot}` as MessageId)}</p>
          <SettingsSection title={t("customUi.entries.title")}>
            {!loaded ? (
              <div className="px-3 py-3 text-xs text-content-subtle">{t("common.loading")}</div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-content-subtle">{t("customUi.entries.empty")}</div>
            ) : (
              rows.map((r, i) => {
                const Icon = r.icon;
                return (
                  <div key={r.key} className="flex items-center gap-2 px-3 py-2" data-testid="custom-ui-row">
                    <Icon size={14} className={cn("shrink-0", r.hidden ? "text-content-subtle" : "text-content-muted")} />
                    <span className={cn("min-w-0 flex-1 truncate text-xs", r.hidden ? "text-content-subtle line-through" : "text-content")}>
                      {r.label}
                    </span>
                    <span className="shrink-0 rounded border border-edge px-1.5 py-px text-[0.7143em] text-content-subtle">
                      {t(`customUi.source.${r.source}` as MessageId)}
                    </span>
                    <Button size="icon" variant="ghost" title={t("customUi.entry.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
                      <IconArrowUp size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("customUi.entry.moveDown")}
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <IconArrowDown size={13} />
                    </Button>
                    {r.item ? (
                      <>
                        <Button size="icon" variant="ghost" title={t("customUi.entry.edit")} onClick={() => r.item && setDraft(draftOf(r.item))}>
                          <IconPencil size={13} />
                        </Button>
                        <Button size="icon" variant="danger" title={t("customUi.entry.delete")} onClick={() => setDeleting(r.item ?? null)}>
                          <IconTrash size={13} />
                        </Button>
                      </>
                    ) : (
                      <span className="w-12 shrink-0" />
                    )}
                    <Switch checked={!r.hidden} onCheckedChange={(v) => toggle(r.key, v)} label={t("customUi.entry.show")} />
                  </div>
                );
              })
            )}
          </SettingsSection>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="md" onClick={() => setDraft(blankDraft(slot, config.items))}>
              <IconPlus size={13} />
              {t("customUi.entry.new")}
            </Button>
            <div className="relative">
              <Button size="md" onClick={() => setTemplateOpen((v) => !v)}>
                <IconTemplate size={13} />
                {t("customUi.entry.fromTemplate")}
              </Button>
              {templateOpen && (
                <div className="absolute left-0 top-full z-20 mt-1 min-w-[240px] rounded-md border border-edge bg-surface py-1 shadow-xl">
                  {TEMPLATES_BY_SLOT[slot].map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-xs text-content-muted hover:bg-surface-muted hover:text-content"
                      onClick={() => {
                        setTemplateOpen(false);
                        setDraft(templateDraft(tpl.id, slot, config.items, locale));
                      }}
                    >
                      {t(tpl.labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {config.layout[slot] && (
              <Button size="md" variant="ghost" onClick={resetLayout}>
                {t("customUi.entry.resetLayout")}
              </Button>
            )}
          </div>
        </div>
      </div>

      <AdvancedSection />

      {draft && (
        <ItemEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={commitDraft}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        danger
        title={t("customUi.entry.delete")}
        description={deleting ? t("customUi.entry.deleteConfirm", { name: customUiLabel(deleting.label, locale) }) : ""}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting) removeItem(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}

/* ────────────────────────── 编辑器 ────────────────────────── */

function ItemEditor({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: (item: CustomUiItem) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<MessageId | null>(null);
  const kind = targetKindOfSlot(draft.slot);
  const isLibrary = kind !== "file";
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });

  const needAutomations = draft.actionType === "automation";
  const workflows = useRpc(() => api.workflow.list(), [], { enabled: needAutomations, toastOnError: false });
  const facts = useRpc(() => api.automation.statusAll(), [], { enabled: needAutomations, toastOnError: false });
  const groups = useRpc(() => api.library.groupsGet({}), [], { enabled: isLibrary, toastOnError: false });
  const automations = (workflows.data?.workflows ?? []).filter((w) => w.trigger !== undefined);
  const triggers = (facts.data ?? []).filter((f) => f.workflowId === draft.workflowId);

  const actionTypes: CustomUiActionType[] = ["view", "prompt", "copy", "automation"];
  const vars = TEMPLATE_VARS_BY_SLOT[draft.slot];
  const varsHint = (
    <p className="text-[0.7857em] text-content-subtle">
      {t("customUi.editor.vars")} {vars.map((v) => `{{${v}}}`).join("  ")}
    </p>
  );

  const submit = () => {
    const r = itemOf(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSave(r.item);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit max-h-[88vh] w-[600px] max-w-[94vw] transform-none space-y-3 overflow-y-auto p-5">
          <Dialog.Title>{draft.isNew ? t("customUi.editor.newTitle") : t("customUi.editor.editTitle")}</Dialog.Title>
          <Dialog.Description>{t(`customUi.slot.${draft.slot}` as MessageId)}</Dialog.Description>
          {error && <ErrorNote>{t(error)}</ErrorNote>}

          <div className="grid grid-cols-2 gap-3">
            <label className={LABEL}>
              <span>{t("customUi.editor.labelZh")}</span>
              <input className={FIELD} value={draft.labelZh} onChange={(e) => set("labelZh", e.target.value)} maxLength={60} />
            </label>
            <label className={LABEL}>
              <span>{t("customUi.editor.labelEn")}</span>
              <input className={FIELD} value={draft.labelEn} onChange={(e) => set("labelEn", e.target.value)} maxLength={60} />
            </label>
          </div>

          <div className={LABEL}>
            <span>{t("customUi.editor.icon")}</span>
            <div className="flex flex-wrap gap-1">
              {CUSTOM_UI_ICONS.map((name) => {
                const Icon = CUSTOM_ICONS[name];
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => set("icon", draft.icon === name ? "" : name)}
                    className={cn(
                      "rounded border p-1.5",
                      draft.icon === name ? "border-accent bg-accent/10 text-accent" : "border-edge text-content-muted hover:bg-surface-muted",
                    )}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>
          </div>

          <fieldset className="space-y-2 rounded-md border border-edge p-3">
            <legend className="px-1 text-[0.8571em] font-medium text-content">{t("customUi.editor.when")}</legend>
            <p className="text-[0.7857em] text-content-subtle">{t("customUi.editor.whenHint")}</p>
            {(kind === "item" || kind === "file") && (
              <label className={LABEL}>
                <span>{t("customUi.editor.extensions")}</span>
                <input className={FIELD} value={draft.extensions} onChange={(e) => set("extensions", e.target.value)} placeholder=".pdf, .md" />
              </label>
            )}
            {kind === "item" && (
              <label className={LABEL}>
                <span>{t("customUi.editor.requires")}</span>
                <select className={FIELD} value={draft.requires} onChange={(e) => set("requires", e.target.value as Draft["requires"])}>
                  <option value="">{t("customUi.editor.requires.none")}</option>
                  <option value="file">{t("customUi.editor.requires.file")}</option>
                  <option value="pdf">{t("customUi.editor.requires.pdf")}</option>
                  <option value="markdown">{t("customUi.editor.requires.markdown")}</option>
                </select>
              </label>
            )}
            {isLibrary && kind !== "group" && (groups.data?.groups.length ?? 0) > 0 && (
              <div className={LABEL}>
                <span>
                  {t("customUi.editor.groups")} <span className="text-content-subtle">{t("customUi.editor.groupsAll")}</span>
                </span>
                <div className="flex flex-wrap gap-3">
                  {groups.data?.groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-1.5 text-xs text-content">
                      <input
                        type="checkbox"
                        checked={draft.groupIds.includes(g.id)}
                        onChange={(e) =>
                          set("groupIds", e.target.checked ? [...draft.groupIds, g.id] : draft.groupIds.filter((x) => x !== g.id))
                        }
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-edge p-3">
            <legend className="px-1 text-[0.8571em] font-medium text-content">{t("customUi.editor.action")}</legend>
            <div className="flex flex-wrap gap-1">
              {actionTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => set("actionType", type)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs",
                    draft.actionType === type ? "border-accent bg-accent/10 text-accent" : "border-edge text-content-muted hover:bg-surface-muted",
                  )}
                >
                  {t(`customUi.editor.action.${type}` as MessageId)}
                </button>
              ))}
            </div>

            {draft.actionType === "view" && (
              <>
                <label className={LABEL}>
                  <span>{t("customUi.editor.viewTitle")}</span>
                  <input className={FIELD} value={draft.viewTitle} onChange={(e) => set("viewTitle", e.target.value)} />
                </label>
                <label className={LABEL}>
                  <span>{t("customUi.editor.viewBody")}</span>
                  <textarea
                    className={cn(FIELD, "h-40 font-mono")}
                    value={draft.viewBody}
                    onChange={(e) => set("viewBody", e.target.value)}
                    spellCheck={false}
                  />
                </label>
                {varsHint}
              </>
            )}
            {draft.actionType === "prompt" && (
              <>
                <label className={LABEL}>
                  <span>{t("customUi.editor.promptTemplate")}</span>
                  <textarea
                    className={cn(FIELD, "h-36")}
                    value={draft.promptTemplate}
                    onChange={(e) => set("promptTemplate", e.target.value)}
                  />
                </label>
                {isLibrary && (
                  <label className="flex items-center gap-2 text-xs text-content">
                    <input type="checkbox" checked={draft.promptAttach} onChange={(e) => set("promptAttach", e.target.checked)} />
                    {t("customUi.editor.promptAttach")}
                  </label>
                )}
                <p className="text-[0.7857em] text-content-subtle">{t("customUi.editor.promptHint")}</p>
                {varsHint}
              </>
            )}
            {draft.actionType === "copy" && (
              <>
                <label className={LABEL}>
                  <span>{t("customUi.editor.copyTemplate")}</span>
                  <textarea
                    className={cn(FIELD, "h-24 font-mono")}
                    value={draft.copyTemplate}
                    onChange={(e) => set("copyTemplate", e.target.value)}
                    spellCheck={false}
                  />
                </label>
                {varsHint}
              </>
            )}
            {draft.actionType === "automation" && (
              <>
                {workflows.data && automations.length === 0 ? (
                  <p className="text-xs text-content-subtle">{t("customUi.editor.automationNone")}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className={LABEL}>
                      <span>{t("customUi.editor.automation")}</span>
                      <select
                        className={FIELD}
                        value={draft.workflowId}
                        onChange={(e) => onChange({ ...draft, workflowId: e.target.value, triggerNodeId: "" })}
                      >
                        <option value="">{t("customUi.editor.automationPick")}</option>
                        {automations.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                        {/* 选中的那条已经不在了(被删)也列出来,免得下拉框悄悄变成「未选」 */}
                        {draft.workflowId && !automations.some((w) => w.id === draft.workflowId) && (
                          <option value={draft.workflowId}>{draft.workflowId}</option>
                        )}
                      </select>
                    </label>
                    <label className={LABEL}>
                      <span>{t("customUi.editor.trigger")}</span>
                      <select className={FIELD} value={draft.triggerNodeId} onChange={(e) => set("triggerNodeId", e.target.value)}>
                        <option value="">—</option>
                        {triggers.map((f) => (
                          <option key={f.nodeId} value={f.nodeId}>
                            {f.title} · {f.kind}
                          </option>
                        ))}
                        {draft.triggerNodeId && !triggers.some((f) => f.nodeId === draft.triggerNodeId) && (
                          <option value={draft.triggerNodeId}>{draft.triggerNodeId}</option>
                        )}
                      </select>
                    </label>
                  </div>
                )}
                <p className="text-[0.7857em] leading-relaxed text-content-subtle">{t("customUi.editor.automationHint")}</p>
              </>
            )}
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button size="md" variant="ghost" onClick={onCancel}>
              {t("customUi.editor.cancel")}
            </Button>
            <Button size="md" variant="primary" onClick={submit} data-testid="custom-ui-save">
              {t("customUi.editor.save")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────────── 高级 ────────────────────────── */

function AdvancedSection() {
  const { t } = useI18n();
  const config = useCustomUiStore((s) => s.config);
  const save = useCustomUiStore((s) => s.save);
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // 配置在别处改了(上面的列表)而用户没在这里手改过:跟着刷新
  useEffect(() => {
    if (!dirty) setText(JSON.stringify(config, null, 2));
  }, [config, dirty]);

  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const envPath = useSessionStore(selectActiveEnvPath);
  const projectPath = envPath ?? projects.find((p) => p.id === activeProjectId)?.path ?? null;

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setNote(t("customUi.advanced.invalid"));
      return;
    }
    const next = coerceCustomUiConfig(parsed);
    void save(next);
    setDirty(false);
    setNote(t("customUi.advanced.applied", { n: next.items.length }));
  };

  return (
    <div className="space-y-4">
      <SettingsSection title={t("customUi.advanced.json")} desc={t("customUi.advanced.jsonHint")}>
        <div className="space-y-2 p-3">
          <textarea
            data-testid="custom-ui-json"
            className={cn(FIELD, "h-48 font-mono")}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
              setNote(null);
            }}
          />
          <div className="flex items-center gap-2">
            <Button onClick={() => void navigator.clipboard.writeText(text)}>{t("customUi.advanced.copy")}</Button>
            <Button variant="primary" onClick={apply}>
              {t("customUi.advanced.apply")}
            </Button>
            {note && <span className="text-[0.8571em] text-content-subtle">{note}</span>}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={t("customUi.advanced.modules")} desc={t("customUi.advanced.modulesHint")}>
        <div className="p-3">
          {projectPath ? (
            <ModuleSurface key={projectPath} projectPath={projectPath}>
              <ModuleToolsButton />
            </ModuleSurface>
          ) : (
            <p className="text-xs text-content-subtle">{t("customUi.advanced.modulesNoProject")}</p>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
