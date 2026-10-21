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
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
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
  sampleTargetOf,
  sanitizeWhen,
  supportsSkipWhen,
  supportsTargetContext,
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
import { copyText } from "@renderer/lib/clipboard.js";
import { cn } from "@renderer/lib/cn.js";
import { translate, useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNote, HintLabel, LoadingNote, Switch } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { ModuleSurface, ModuleToolsButton } from "@renderer/components/modules/ModuleSurface.js";
import {
  IconAdjustmentsHorizontal,
  IconArrowDown,
  IconArrowUp,
  IconCode,
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
import { ItemEditor, AdvancedSection } from "./CustomUiPanelParts.js";

/** 面板 HTML 的大编辑器(Monaco)—— 懒加载,单独一个文件就是为了能切出独立 chunk
 *  (Monaco 不许进设置页的静态图,见 `settings-lazy-smoke`)。 */

export const FIELD =
  "w-full rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs text-content outline-none focus:border-accent";
export const LABEL = "block space-y-1 text-[0.8571em] text-content-muted";

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

export interface Draft {
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
export function isLibraryKind(kind: ReturnType<typeof targetKindOfSlot>): boolean {
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
export function itemOf(d: Draft): { ok: true; item: CustomUiItem } | { ok: false; error: MessageId } {
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
                  // 用同一把尺(见契约的 `supportsTargetContext` / `supportsSkipWhen`):
                  // 编辑器已按挂载位隐藏这两格,这里再兜一道,免得旧草稿里的残留值被写回去。
                  ...(d.targetIsContext && supportsTargetContext(d.slot) ? { targetMode: "context" as const } : {}),
                  ...(d.skipRequires && supportsSkipWhen(d.slot) ? { skipWhen: { requires: d.skipRequires } } : {}),
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
  // 「发给对话」「复制文本」必须有正文:空模板运行时是**静默 no-op**(`text.length > 0`
  // 那一支不成立,点一下什么都不发生、连提示都没有)。其余动作早都各自校验了必填项,
  // 这两条从前漏了 —— 与它们是同一类"允许配、点了没反应"。
  if (action.type === "prompt" && !action.template.trim()) return { ok: false, error: "customUi.editor.errorPrompt" };
  if (action.type === "copy" && !action.template.trim()) return { ok: false, error: "customUi.editor.errorCopy" };
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
              <Button variant="ghost" size={null}
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
              </Button>
            );
          })}
        </nav>

        {/* 这个挂载位上的功能项 */}
        <div className="min-w-0 flex-1 space-y-3">
          <SettingsSection title={t("customUi.entries.title")} desc={t(`customUi.slotHint.${slot}` as MessageId)}>
            {!loaded ? (
              <LoadingNote label={t("common.loading")} className="px-3 py-3" />
            ) : rows.length === 0 ? (
              <EmptyState title={t("customUi.entries.empty")} className="py-4" />
            ) : (
              rows.map((r, i) => {
                const Icon = r.icon;
                return (
                  <div key={r.key} className="flex items-center gap-2 px-3 py-2" data-testid="custom-ui-row">
                    <Icon size={14} className={cn("shrink-0", r.hidden ? "text-content-subtle" : "text-content-muted")} />
                    <span className={cn("min-w-0 flex-1 truncate text-xs", r.hidden ? "text-content-subtle line-through" : "text-content")}>
                      {r.label}
                    </span>
                    <Badge variant="neutral" className="shrink-0">{t(`customUi.source.${r.source}` as MessageId)}</Badge>
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
                    <Button variant="ghost" size={null}
                      key={tpl.id}
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-xs text-content-muted hover:bg-surface-muted hover:text-content"
                      onClick={() => {
                        setTemplateOpen(false);
                        setDraft(templateDraft(tpl.id, slot, config.items, locale));
                      }}
                    >
                      {t(tpl.labelKey)}
                    </Button>
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
