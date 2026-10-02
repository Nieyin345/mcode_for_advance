/**
 * 设置 → **自定义 UI**。
 *
 * 用户定的规矩:主界面只放入口(右键菜单里的一项、右栏的一个页签、工具栏的一颗按钮),
 * 点下去做什么、显示什么,全在这一页定义。左边列挂载位(资料库四级右键 + Files 文件右键
 * + 右栏页签 + 竖向工具栏),右边是这个位置上的功能项:
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
  ACTIONS_BY_SLOT,
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
  sanitizeWhen,
  targetKindOfSlot,
  unknownTemplateVars,
  whenKeysForSlot,
  type CustomUiActionType,
  type CustomUiConfig,
  type CustomUiIcon,
  type CustomUiItem,
  type CustomUiSlot,
} from "@contracts/customUi";
import { PANEL_HTML_MAX, panelExampleHtml } from "@contracts/customUiPanel";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { translate, useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, ConfirmDialog, ErrorNote, HintLabel, Switch } from "@renderer/components/ui/index.js";
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
import { PanelFrame } from "../customUi/PanelFrame.js";
import { useWorkspaceTarget } from "../customUi/useWorkspaceTarget.js";
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
  /** automation 的 skipWhen v1:只开放 requires 一档(空 = 不过滤)。 */
  skipRequires: "" | "file" | "pdf" | "markdown";
  /** automation 的运行前输入(P2;工具栏挂载位不可用)。 */
  inputs: { key: string; kind: "text" | "files"; labelZh: string; required: boolean }[];
  /**
   * automation 的 `targetMode === "context"`:右键的分类只是**落点**,不展开成条目。
   * 文献导入那类"往这儿收东西"的入口要打开它 —— 不打开的话空分类会被
   * 「这个范围里没有条目」挡死(见 `@contracts/customUi` 的 targetMode)。
   */
  targetIsContext: boolean;
  filePath: string;
  openTab: string;
  /** R39:「打开网址」的模板。 */
  url: string;
  /** R39:「运行终端命令」的模板 + 运行前是否确认(默认确认)。 */
  shellCommand: string;
  shellConfirm: boolean;
  /** R41:自定义面板 —— 标题(浮窗用)、HTML、允许联网、有副作用的调用前确认(默认确认)。 */
  panelTitle: string;
  panelHtml: string;
  panelNetwork: boolean;
  panelConfirm: boolean;
}

/** 资料库那几种挂载位(有分组 / 「附上文献」这些只对它们有意义)。 */
function isLibraryKind(kind: ReturnType<typeof targetKindOfSlot>): boolean {
  return kind === "item" || kind === "collection" || kind === "group";
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
    actionType: slot === "rightPanel.tab" ? "file" : targetKindOfSlot(slot) === "file" ? "copy" : "prompt",
    viewTitle: "",
    viewBody: "",
    promptTemplate: "",
    promptAttach: isLibraryKind(targetKindOfSlot(slot)),
    copyTemplate: "",
    workflowId: "",
    triggerNodeId: "",
    skipRequires: "",
    inputs: [],
    targetIsContext: false,
    filePath: "",
    openTab: "",
    url: "",
    shellCommand: "",
    shellConfirm: true,
    panelTitle: "",
    panelHtml: "",
    panelNetwork: false,
    panelConfirm: true,
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
    skipRequires: a.type === "automation" ? (a.skipWhen?.requires ?? "") : "",
    inputs:
      a.type === "automation"
        ? (a.inputs ?? []).map((i) => ({
            key: i.key,
            kind: i.kind,
            labelZh: i.label?.zh ?? "",
            required: i.required === true,
          }))
        : [],
    targetIsContext: a.type === "automation" && a.targetMode === "context",
    filePath: a.type === "file" ? a.path : "",
    openTab: a.type === "openTab" ? a.tab : "",
    url: a.type === "url" ? a.url : "",
    shellCommand: a.type === "shell" ? a.command : "",
    shellConfirm: a.type === "shell" ? a.confirm !== false : true,
    panelTitle: a.type === "panel" ? (a.title ?? "") : "",
    panelHtml: a.type === "panel" ? a.html : "",
    panelNetwork: a.type === "panel" && a.network === true,
    panelConfirm: a.type === "panel" ? a.confirm !== false : true,
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
          : d.actionType === "file"
            ? { type: "file", path: d.filePath.trim() }
            : d.actionType === "openTab"
              ? { type: "openTab", tab: d.openTab }
              : d.actionType === "url"
                ? { type: "url", url: d.url.trim() }
                : d.actionType === "shell"
                  ? { type: "shell", command: d.shellCommand.trim(), ...(d.shellConfirm ? {} : { confirm: false }) }
                  : d.actionType === "panel"
                    ? {
                        type: "panel",
                        ...(d.panelTitle.trim() && d.slot !== "rightPanel.tab" ? { title: d.panelTitle.trim() } : {}),
                        html: d.panelHtml,
                        ...(d.panelNetwork ? { network: true } : {}),
                        ...(d.panelConfirm ? {} : { confirm: false }),
                      }
                    : {
                  type: "automation",
                  workflowId: d.workflowId,
                  triggerNodeId: d.triggerNodeId,
                  ...(d.targetIsContext ? { targetMode: "context" as const } : {}),
                  ...(d.skipRequires ? { skipWhen: { requires: d.skipRequires } } : {}),
                  ...(d.inputs.length
                    ? {
                        inputs: d.inputs.map((i) => ({
                          key: i.key.trim(),
                          kind: i.kind,
                          ...(i.labelZh.trim() ? { label: { zh: i.labelZh.trim() } } : {}),
                          ...(i.required ? { required: true } : {}),
                        })),
                      }
                    : {}),
                };
  if (action.type === "automation" && (!action.workflowId || !action.triggerNodeId)) {
    return { ok: false, error: "customUi.editor.errorAutomation" };
  }
  if (action.type === "automation" && action.inputs) {
    const keys = action.inputs.map((i) => i.key);
    const keyOk = keys.every((k) => /^[a-z][a-z0-9_]{0,23}$/.test(k));
    if (!keyOk || new Set(keys).size !== keys.length) {
      return { ok: false, error: "customUi.editor.errorInputKey" };
    }
  }
  if (action.type === "file" && !action.path) return { ok: false, error: "customUi.editor.errorFile" };
  if (action.type === "openTab" && !action.tab) return { ok: false, error: "customUi.editor.errorOpenTab" };
  if (action.type === "url" && !action.url) return { ok: false, error: "customUi.editor.errorUrl" };
  if (action.type === "shell" && !action.command) return { ok: false, error: "customUi.editor.errorShell" };
  if (action.type === "panel" && !action.html.trim()) return { ok: false, error: "customUi.editor.errorPanel" };
  if (action.type === "panel" && action.html.length > PANEL_HTML_MAX) return { ok: false, error: "customUi.editor.errorPanelTooLong" };
  const extensions = d.extensions
    .split(/[,，\s]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map(normalizeExtension);
  // 条件按挂载位裁一遍(见契约的 `sanitizeWhen`):草稿上留着的旧值 —— 比如把一项从
  // 「条目右键」改挂到「工具栏」之后还躺在 draft 里的 requires —— 存下去会让这一项
  // **永远不显示**。裁在这里,和读配置那一侧用的是同一把尺。
  const when = sanitizeWhen(
    {
      ...(extensions.length ? { extensions } : {}),
      ...(d.requires ? { requires: d.requires } : {}),
      ...(d.groupIds.length ? { groupIds: d.groupIds } : {}),
    },
    d.slot,
  );
  const candidate = {
    id: d.id,
    slot: d.slot,
    label: { zh: d.labelZh.trim(), ...(d.labelEn.trim() ? { en: d.labelEn.trim() } : {}) },
    ...(d.icon ? { icon: d.icon } : {}),
    ...(when ? { when } : {}),
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
        // 手动转录 = 兜漏:已有转录(MD)的条目自动跳过(P1 skipWhen 检测)。
        skipRequires: "markdown",
      };
    case "itemInfo":
      // 「文献信息」内置项的通用替代(P3 退役后):模板变量拼一张信息卡。
      return {
        ...d,
        ...both("customUi.template.itemInfo.label"),
        icon: "eye",
        actionType: "view",
        viewTitle: "{{item.title}}",
        viewBody: translate(locale, "customUi.template.itemInfo.body"),
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
    case "projectSummary":
      return {
        ...d,
        ...both("customUi.template.projectSummary.label"),
        icon: "sparkles",
        actionType: "prompt",
        promptTemplate: translate(locale, "customUi.template.projectSummary.prompt"),
      };
    case "runAutomation":
      return { ...d, ...both("customUi.template.runAutomation.label"), icon: "bolt", actionType: "automation" };
    case "literatureImport":
      // 文献导入(P2 的样板用法):选 PDF 或填 DOI,自动化那边"哪个有值办哪个"
      //(提取文献信息 / DOI 下载都在自动化里,这里只是入口)。
      return {
        ...d,
        ...both("customUi.template.literatureImport.label"),
        icon: "download",
        actionType: "automation",
        // 右键的分类是**落点**(收进这儿),不是"这次要办的那一批" —— 见 targetMode。
        targetIsContext: true,
        inputs: [
          { key: "files", kind: "files", labelZh: translate("zh", "customUi.template.literatureImport.files"), required: false },
          { key: "doi", kind: "text", labelZh: translate("zh", "customUi.template.literatureImport.doi"), required: false },
        ],
      };
    case "panelDemo":
      return {
        ...d,
        ...both("customUi.template.panelDemo.label"),
        icon: "code",
        actionType: "panel",
        panelHtml: panelExampleHtml(locale),
      };
    case "readme":
      return { ...d, ...both("customUi.template.readme.label"), icon: "notebook", actionType: "file", filePath: "README.md" };
    case "dailyNote":
      return {
        ...d,
        ...both("customUi.template.dailyNote.label"),
        icon: "calendar",
        actionType: "file",
        filePath: "notes/{{today}}.md",
      };
    case "projectInfo":
      return {
        ...d,
        ...both("customUi.template.projectInfo.label"),
        icon: "folder",
        actionType: "view",
        viewBody: translate(locale, "customUi.template.projectInfo.body"),
      };
    case "translateMessage":
      return {
        ...d,
        ...both("customUi.template.translate.label"),
        icon: "sparkles",
        actionType: "prompt",
        promptTemplate: translate(locale, "customUi.template.translate.prompt"),
      };
    case "copyMessage":
      return {
        ...d,
        ...both("customUi.template.copyMessage.label"),
        icon: "copy",
        actionType: "copy",
        copyTemplate: "> {{message.text}}",
      };
    case "explainSelection":
      return {
        ...d,
        ...both("customUi.template.explain.label"),
        icon: "sparkles",
        actionType: "prompt",
        promptTemplate: translate(locale, "customUi.template.explain.prompt"),
      };
    case "searchWeb":
      return {
        ...d,
        ...both("customUi.template.searchWeb.label"),
        icon: "world",
        actionType: "url",
        url: "https://www.google.com/search?q={{selection.text}}",
      };
    case "gitStatus":
      return {
        ...d,
        ...both("customUi.template.gitStatus.label"),
        icon: "terminal",
        actionType: "shell",
        shellCommand: "git status",
      };
    case "copySessionId":
      return {
        ...d,
        ...both("customUi.template.copySessionId.label"),
        icon: "copy",
        actionType: "copy",
        copyTemplate: "{{session.id}}",
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
    { id: "itemInfo", labelKey: "customUi.template.itemInfo.label" },
    { id: "cite", labelKey: "customUi.template.cite.label" },
  ],
  "library.collection": [
    { id: "summarize", labelKey: "customUi.template.summarize.label" },
    { id: "transcribe", labelKey: "customUi.template.transcribe.label" },
    { id: "literatureImport", labelKey: "customUi.template.literatureImport.label" },
  ],
  "library.subcategory": [
    { id: "summarize", labelKey: "customUi.template.summarize.label" },
    { id: "transcribe", labelKey: "customUi.template.transcribe.label" },
    { id: "literatureImport", labelKey: "customUi.template.literatureImport.label" },
  ],
  "library.group": [{ id: "transcribe", labelKey: "customUi.template.transcribe.label" }],
  "files.context": [{ id: "copyPath", labelKey: "customUi.template.copyPath.label" }],
  "rightPanel.tab": [
    { id: "readme", labelKey: "customUi.template.readme.label" },
    { id: "dailyNote", labelKey: "customUi.template.dailyNote.label" },
    { id: "projectInfo", labelKey: "customUi.template.projectInfo.label" },
    { id: "panelDemo", labelKey: "customUi.template.panelDemo.label" },
  ],
  toolbar: [
    { id: "projectSummary", labelKey: "customUi.template.projectSummary.label" },
    { id: "runAutomation", labelKey: "customUi.template.runAutomation.label" },
    { id: "panelDemo", labelKey: "customUi.template.panelDemo.label" },
  ],
  "chat.message": [
    { id: "translateMessage", labelKey: "customUi.template.translate.label" },
    { id: "copyMessage", labelKey: "customUi.template.copyMessage.label" },
  ],
  "text.selection": [
    { id: "explainSelection", labelKey: "customUi.template.explain.label" },
    { id: "searchWeb", labelKey: "customUi.template.searchWeb.label" },
  ],
  "composer.toolbar": [
    { id: "projectSummary", labelKey: "customUi.template.projectSummary.label" },
    { id: "gitStatus", labelKey: "customUi.template.gitStatus.label" },
  ],
  "session.context": [{ id: "copySessionId", labelKey: "customUi.template.copySessionId.label" }],
  "project.context": [{ id: "gitStatus", labelKey: "customUi.template.gitStatus.label" }],
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
  // 失效徽标（B3）：自定义项引用的自动化被删后，列表要标出来，而不是点击才报错。
  // 对齐模块平台的既有原则：「既有选择从目录消失时显示失效状态，不偷偷换成另一项」。
  const workflowsAll = useRpc(() => api.workflow.list(), [], { toastOnError: false });
  const automationMissing = (item: CustomUiItem | undefined): boolean => {
    if (!item || item.action.type !== "automation") return false;
    const list = workflowsAll.data?.workflows;
    if (!list) return false; // 还没加载完 → 不误报
    const wf = item.action.workflowId;
    return !list.some((w) => w.id === wf && w.trigger !== undefined);
  };

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
      <PanelHeader title={t("customUi.title")} icon={IconAdjustmentsHorizontal} hint={t("customUi.intro")} />

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
          <SettingsSection title={t("customUi.entries.title")} desc={t(`customUi.slotHint.${slot}` as MessageId)}>
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
                    {automationMissing(r.item) && (
                      <span
                        className="shrink-0 rounded border border-danger/40 px-1.5 py-px text-[0.7143em] text-danger"
                        title={t("customUi.entry.badgeMissingAutomationHint")}
                      >
                        {t("customUi.entry.badgeMissingAutomation")}
                      </span>
                    )}
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
  const { t, locale } = useI18n();
  const [error, setError] = useState<MessageId | null>(null);
  const kind = targetKindOfSlot(draft.slot);
  const isLibrary = isLibraryKind(kind);
  // 没有「运行目标」的挂载位:工具栏 + R39 新加的几个(自动化走 runNow,没有 skipWhen / 落点 / 运行前输入)。
  const noRunTarget = !isLibrary && kind !== "file";
  const whenKeys = whenKeysForSlot(draft.slot);
  const configItems = useCustomUiStore((s) => s.config.items);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });

  const needAutomations = draft.actionType === "automation";
  const workflows = useRpc(() => api.workflow.list(), [], { enabled: needAutomations, toastOnError: false });
  const facts = useRpc(() => api.automation.statusAll(), [], { enabled: needAutomations, toastOnError: false });
  const groups = useRpc(() => api.library.groupsGet({}), [], { enabled: isLibrary, toastOnError: false });
  const automations = (workflows.data?.workflows ?? []).filter((w) => w.trigger !== undefined);
  const triggers = (facts.data ?? []).filter((f) => f.workflowId === draft.workflowId);

  const actionTypes: readonly CustomUiActionType[] = ACTIONS_BY_SLOT[draft.slot];
  // 「切到右栏页签」可选的:内置页签 + 已有的自定义页签
  const tabChoices = [
    ...BUILTINS["rightPanel.tab"].map((b) => ({ key: builtinKey(b.id), label: t(b.labelKey) })),
    ...configItems
      .filter((i) => i.slot === "rightPanel.tab")
      .map((i) => ({ key: customKey(i.id), label: customUiLabel(i.label, locale) })),
  ];
  const vars = TEMPLATE_VARS_BY_SLOT[draft.slot];
  const varsHint = (
    <p className="text-[0.7857em] text-content-subtle">
      {t("customUi.editor.vars")} {vars.map((v) => `{{${v}}}`).join("  ")}
    </p>
  );
  // 模板变量 lint（B1）：打错的变量运行时会静默渲染成空串（那是对的——原样发给模型
  // 会被当成要填的槽），所以「打错了」必须在这里点名。宽容运行、严格提示：不拦保存。
  const unknownVars = useMemo(() => {
    const parts =
      draft.actionType === "view"
        ? [draft.viewTitle, draft.viewBody]
        : draft.actionType === "prompt"
          ? [draft.promptTemplate]
          : draft.actionType === "copy"
            ? [draft.copyTemplate]
            : draft.actionType === "file"
              ? [draft.filePath]
              : draft.actionType === "url"
                ? [draft.url]
                : draft.actionType === "shell"
                  ? [draft.shellCommand]
                  : draft.actionType === "panel"
                    ? [draft.panelTitle]
                    : [];
    const out: string[] = [];
    for (const p of parts) {
      for (const v of unknownTemplateVars(p, draft.slot)) if (!out.includes(v)) out.push(v);
    }
    return out;
  }, [draft]);

  const submit = () => {
    const r = itemOf(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSave(r.item);
  };

  // 面板「预览」:草稿的一份快照,**就地**显示在编辑框下面(不另开浮窗 —— 两个模态框
  // 叠着,点到上面那个会被下面那个当成「点了外面」而关掉,草稿就没了)。再点一次 = 用
  // 最新的草稿重新加载。目标 = 当前工作区。
  const workspaceTarget = useWorkspaceTarget();
  const [preview, setPreview] = useState<{ item: CustomUiItem; n: number } | null>(null);
  const previewPanel = () => {
    const r = itemOf(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setPreview((prev) => ({ item: r.item, n: (prev?.n ?? 0) + 1 }));
  };
  const isPanel = draft.actionType === "panel";

  return (
    <Dialog.Root
      open
      // 写面板代码时点到框外不关(一大段 HTML 说没就没);面板弹的确认框也在框外。
      disablePointerDismissal={isPanel}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup
          className={cn(
            "bottom-0 left-0 right-0 top-0 m-auto h-fit max-h-[88vh] max-w-[94vw] transform-none space-y-3 overflow-y-auto p-5",
            isPanel ? "w-[860px]" : "w-[600px]",
          )}
        >
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

          {/* 工具栏 / 右栏页签没有「右键的那个东西」,也就没有显示条件 */}
          {whenKeys.length > 0 && (
          <fieldset className="space-y-2 rounded-md border border-edge p-3">
            <legend className="px-1 text-[0.8571em] font-medium text-content">
              <HintLabel hint={t("customUi.editor.whenHint")}>{t("customUi.editor.when")}</HintLabel>
            </legend>
            {whenKeys.includes("extensions") && (
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
          )}

          <fieldset className="space-y-2 rounded-md border border-edge p-3">
            <legend className="px-1 text-[0.8571em] font-medium text-content">
              {draft.slot === "rightPanel.tab" ? t("customUi.editor.tabContent") : t("customUi.editor.action")}
            </legend>
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
                  {t(
                    (draft.slot === "rightPanel.tab" ? `customUi.editor.tabAction.${type}` : `customUi.editor.action.${type}`) as MessageId,
                  )}
                </button>
              ))}
            </div>

            {draft.actionType === "view" && (
              <>
                {draft.slot !== "rightPanel.tab" && (
                  <label className={LABEL}>
                    <span>{t("customUi.editor.viewTitle")}</span>
                    <input className={FIELD} value={draft.viewTitle} onChange={(e) => set("viewTitle", e.target.value)} />
                  </label>
                )}
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
                <div className={LABEL}>
                  <HintLabel hint={t("customUi.editor.promptHint")}>{t("customUi.editor.promptTemplate")}</HintLabel>
                  <textarea
                    className={cn(FIELD, "h-36")}
                    value={draft.promptTemplate}
                    onChange={(e) => set("promptTemplate", e.target.value)}
                  />
                </div>
                {isLibrary && (
                  <label className="flex items-center gap-2 text-xs text-content">
                    <input type="checkbox" checked={draft.promptAttach} onChange={(e) => set("promptAttach", e.target.checked)} />
                    {t("customUi.editor.promptAttach")}
                  </label>
                )}
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
                    <div className={LABEL}>
                      <HintLabel hint={noRunTarget ? t("customUi.editor.automationHintToolbar") : t("customUi.editor.automationHint")}>
                        {t("customUi.editor.automation")}
                      </HintLabel>
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
                    </div>
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
                {/* skipWhen v1(通用原语):展开时跳过满足条件的条目 —— 手动转录选
                    「已有转录」即得"检测过再跑"。工具栏没有条目目标,不显示。 */}
                {!noRunTarget && (
                  <div className={LABEL}>
                    <HintLabel hint={t("customUi.editor.skipWhenHint")}>{t("customUi.editor.skipWhen")}</HintLabel>
                    <select
                      className={FIELD}
                      value={draft.skipRequires}
                      onChange={(e) => set("skipRequires", e.target.value as Draft["skipRequires"])}
                    >
                      <option value="">{t("customUi.editor.skipWhen.none")}</option>
                      <option value="markdown">{t("customUi.editor.skipWhen.markdown")}</option>
                      <option value="pdf">{t("customUi.editor.skipWhen.pdf")}</option>
                      <option value="file">{t("customUi.editor.skipWhen.file")}</option>
                    </select>
                  </div>
                )}
                {/* 目标怎么用:展开成一批,还是只当落点。空分类那条路全靠它(见 targetMode)。 */}
                {!noRunTarget && (
                  <label className="flex items-center gap-2 text-[0.8571em]">
                    <input
                      type="checkbox"
                      className=""
                      checked={draft.targetIsContext}
                      onChange={(e) => set("targetIsContext", e.target.checked)}
                    />
                    <HintLabel hint={t("customUi.editor.targetContextHint")}>{t("customUi.editor.targetContext")}</HintLabel>
                  </label>
                )}
                {/* 运行前输入(P2):工具栏走 runNow、没有 input 通道 ⟹ 只在有目标的挂载位开放 */}
                {!noRunTarget && (
                  <div className={LABEL}>
                    <HintLabel hint={t("customUi.editor.inputsHint")}>{t("customUi.editor.inputs")}</HintLabel>
                    {draft.inputs.map((row, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <select
                          className={cn(FIELD, "w-24 shrink-0")}
                          value={row.kind}
                          onChange={(e) =>
                            set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, kind: e.target.value as "text" | "files" } : r)))
                          }
                        >
                          <option value="text">{t("customUi.editor.inputs.kindText")}</option>
                          <option value="files">{t("customUi.editor.inputs.kindFiles")}</option>
                        </select>
                        <input
                          className={cn(FIELD, "w-28 shrink-0 font-mono")}
                          placeholder="key"
                          value={row.key}
                          onChange={(e) => set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, key: e.target.value } : r)))}
                          spellCheck={false}
                        />
                        <input
                          className={cn(FIELD, "min-w-0 flex-1")}
                          placeholder={t("customUi.editor.inputs.labelPh")}
                          value={row.labelZh}
                          onChange={(e) => set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, labelZh: e.target.value } : r)))}
                        />
                        <label className="flex shrink-0 items-center gap-1 text-xs text-content">
                          <input
                            type="checkbox"
                            checked={row.required}
                            onChange={(e) => set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, required: e.target.checked } : r)))}
                          />
                          {t("customUi.editor.inputs.required")}
                        </label>
                        <Button
                          size="icon"
                          variant="ghost"
                          title={t("customUi.entry.delete")}
                          onClick={() => set("inputs", draft.inputs.filter((_r, j) => j !== idx))}
                        >
                          <IconTrash size={13} />
                        </Button>
                      </div>
                    ))}
                    {draft.inputs.length < 4 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => set("inputs", [...draft.inputs, { key: "", kind: "text" as const, labelZh: "", required: false }])}
                      >
                        {t("customUi.editor.inputs.add")}
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
            {draft.actionType === "file" && (
              <>
                <div className={LABEL}>
                  <HintLabel hint={draft.slot === "rightPanel.tab" ? t("customUi.editor.fileHintTab") : t("customUi.editor.fileHintToolbar")}>
                    {t("customUi.editor.filePath")}
                  </HintLabel>
                  <input
                    className={cn(FIELD, "font-mono")}
                    value={draft.filePath}
                    onChange={(e) => set("filePath", e.target.value)}
                    placeholder="README.md"
                    spellCheck={false}
                  />
                </div>
                {varsHint}
              </>
            )}
            {draft.actionType === "openTab" && (
              <label className={LABEL}>
                <span>{t("customUi.editor.openTab")}</span>
                <select className={FIELD} value={draft.openTab} onChange={(e) => set("openTab", e.target.value)}>
                  <option value="">—</option>
                  {tabChoices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                  {draft.openTab && !tabChoices.some((c) => c.key === draft.openTab) && (
                    <option value={draft.openTab}>{draft.openTab}</option>
                  )}
                </select>
              </label>
            )}
            {draft.actionType === "url" && (
              <>
                <div className={LABEL}>
                  <HintLabel hint={t("customUi.editor.urlHint")}>{t("customUi.editor.url")}</HintLabel>
                  <input
                    className={cn(FIELD, "font-mono")}
                    value={draft.url}
                    onChange={(e) => set("url", e.target.value)}
                    placeholder="https://www.google.com/search?q={{selection.text}}"
                    spellCheck={false}
                  />
                </div>
                {varsHint}
              </>
            )}
            {draft.actionType === "shell" && (
              <>
                <div className={LABEL}>
                  <HintLabel hint={t("customUi.editor.shellHint")}>{t("customUi.editor.shellCommand")}</HintLabel>
                  <input
                    className={cn(FIELD, "font-mono")}
                    value={draft.shellCommand}
                    onChange={(e) => set("shellCommand", e.target.value)}
                    placeholder="git log --oneline -- {{file.path}}"
                    spellCheck={false}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-content">
                  <input type="checkbox" checked={draft.shellConfirm} onChange={(e) => set("shellConfirm", e.target.checked)} />
                  {t("customUi.editor.shellConfirm")}
                </label>
                {varsHint}
              </>
            )}
            {draft.actionType === "panel" && (
              <>
                {draft.slot !== "rightPanel.tab" && (
                  <label className={LABEL}>
                    <span>{t("customUi.editor.panelTitle")}</span>
                    <input
                      className={FIELD}
                      value={draft.panelTitle}
                      onChange={(e) => set("panelTitle", e.target.value)}
                      placeholder={t("customUi.editor.panelTitlePlaceholder")}
                    />
                  </label>
                )}
                <div className={LABEL}>
                  <div className="flex items-center gap-2">
                    <HintLabel hint={t("customUi.editor.panelSdkHint")}>{t("customUi.editor.panelHtml")}</HintLabel>
                    <span className="ml-auto text-[0.8571em] tabular-nums text-content-subtle">
                      {draft.panelHtml.length.toLocaleString()} / {PANEL_HTML_MAX.toLocaleString()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => set("panelHtml", panelExampleHtml(locale))}
                      data-testid="custom-ui-panel-example"
                    >
                      {t("customUi.editor.panelInsertExample")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={previewPanel} data-testid="custom-ui-panel-preview">
                      {t("customUi.editor.panelPreview")}
                    </Button>
                  </div>
                  <textarea
                    className={cn(FIELD, "h-[340px] resize-y whitespace-pre font-mono text-xs leading-relaxed")}
                    value={draft.panelHtml}
                    onChange={(e) => set("panelHtml", e.target.value)}
                    onKeyDown={(e) => {
                      // Tab 键插两个空格,而不是跳到下一个输入框(写代码的地方)。
                      if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: s, selectionEnd: en } = el;
                      const next = `${draft.panelHtml.slice(0, s)}  ${draft.panelHtml.slice(en)}`;
                      set("panelHtml", next);
                      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                    }}
                    placeholder={t("customUi.editor.panelHtmlPlaceholder")}
                    spellCheck={false}
                    maxLength={PANEL_HTML_MAX}
                    data-testid="custom-ui-panel-html"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                  <label className="flex items-center gap-2 text-xs text-content">
                    <input type="checkbox" checked={draft.panelConfirm} onChange={(e) => set("panelConfirm", e.target.checked)} />
                    {t("customUi.editor.panelConfirm")}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-content">
                    <input type="checkbox" checked={draft.panelNetwork} onChange={(e) => set("panelNetwork", e.target.checked)} />
                    {t("customUi.editor.panelNetwork")}
                  </label>
                </div>
                {draft.panelNetwork && (
                  <p className="text-[0.7857em] leading-relaxed text-warning">{t("customUi.editor.panelNetworkWarn")}</p>
                )}
                {preview !== null && (
                  <div className="overflow-hidden rounded-md border border-edge" data-testid="custom-ui-panel-preview-box">
                    <div className="flex h-7 items-center border-b border-edge bg-surface-muted px-2 text-[0.7857em] text-content-subtle">
                      <span className="flex-1">{t("customUi.editor.panelPreviewing")}</span>
                      <button type="button" className="hover:text-content" onClick={() => setPreview(null)}>
                        {t("customUi.editor.panelPreviewClose")}
                      </button>
                    </div>
                    <div className="h-[360px]">
                      <PanelFrame item={preview.item} target={workspaceTarget} reloadKey={preview.n} />
                    </div>
                  </div>
                )}
              </>
            )}
          </fieldset>

          {unknownVars.length > 0 && (
            <p className="text-[0.7857em] leading-relaxed text-warning" data-testid="custom-ui-unknown-vars">
              {t("customUi.editor.unknownVars", { vars: unknownVars.map((v) => `{{${v}}}`).join("  ") })}
            </p>
          )}

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
