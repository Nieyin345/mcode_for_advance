/**
 * `CustomUiPanel` 的**编辑器与高级区**（从 `CustomUiPanel.tsx` 拆出）。
 *
 * 自定义功能项的编辑器 `ItemEditor`（629 行）与「高级」折叠区 `AdvancedSection`。
 * 两个都是独立渲染单元；它们从主文件取 `FIELD` / `LABEL` / `Draft` / `itemOf` /
 * `isLibraryKind`（主 → Parts 单向）。**纯搬迁，函数体逐字节一致。**
 */
import { Suspense, useEffect, useMemo, useState, lazy } from "react";
import {
  ACTIONS_BY_SLOT,
  CUSTOM_UI_ICONS,
  TEMPLATE_VARS_BY_SLOT,
  CustomUiItemSchema,
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
import { Button, ErrorNote, HintLabel, Input, Switch } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { useWorkspaceTarget } from "../customUi/useWorkspaceTarget.js";
import { SettingsSection } from "./SettingsSection.js";
import {
  IconArrowDown,
  IconArrowUp,
  IconCode,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { BUILTINS, CUSTOM_ICONS, DEFAULT_ACTION_ICON, type IconComponent } from "../customUi/registry.js";
import { PanelFrame } from "../customUi/PanelFrame.js";
import { FIELD, LABEL, itemOf, isLibraryKind, type Draft } from "./CustomUiPanel.js";
import { Textarea } from "@renderer/components/ui/textarea.js";
import { NativeSelect, Checkbox } from "@renderer/components/ui/native-controls.js";

/** 面板 HTML 的大编辑器(Monaco)—— 懒加载,单独一个文件就是为了能切出独立 chunk
 *  (Monaco 不许进设置页的静态图,见 `settings-lazy-smoke`)。 */
const PanelHtmlDialog = lazy(async () => ({
  default: (await import("./PanelHtmlDialog.js")).PanelHtmlDialog,
}));

/* ────────────────────────── 编辑器 ────────────────────────── */

export function ItemEditor({
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
  // skipWhen / targetMode 各自只在说得通的挂载位上放出来(见契约的 `supportsSkipWhen` /
  // `supportsTargetContext`)。从前这两格跟着 `!noRunTarget` 一起显示,于是文件 / 条目 /
  // 大类上也能勾 —— 而运行时它们要么整段跳过、要么必报错,勾了等于骗用户。
  const canSkipWhen = supportsSkipWhen(draft.slot);
  const canTargetContext = supportsTargetContext(draft.slot);
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
  // E6:各槽位能用的 vars 键这里直接从契约的 TEMPLATE_VARS_BY_SLOT 列出 —— 从前作者只能
  // 去 grep 源码才知道。做成可折叠、默认收起的小块,不喧宾夺主。
  const varsHint = (
    <details
      className="rounded-md border border-edge px-2 py-1 text-[0.7857em] text-content-subtle"
      data-testid="custom-ui-vars"
    >
      <summary className="cursor-pointer select-none">
        {t("customUi.editor.vars")}
        <span className="ml-1 tabular-nums">({vars.length})</span>
      </summary>
      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 font-mono">
        {vars.map((v) => (
          <code key={v} className="rounded bg-surface-muted px-1 py-px">
            {`{{${v}}}`}
          </code>
        ))}
      </div>
    </details>
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
  // 最新的草稿重新加载。
  //
  // **目标**:从前预览一律喂当前工作区(`useWorkspaceTarget`,只有 project.*/session.*/today)
  // —— 于是任何依赖 `item.*` / `collection.*` / `file.*` 的面板在预览里必然读到空串,作者
  // 以为是自己代码写错了(其实预览喂错了目标,和右键打开时根本不是一回事)。
  // 现在:有目标种类的槽位(条目 / 分类 / 文件 / 消息 / 选中 / 对话 / 项目)喂一份
  // `sampleTargetOf` 造出来的**样例目标**(字段齐全、值带 (sample) 标记);只有工作区槽位
  // 才用真实工作区。用了样例的,气泡里显式标注「模拟上下文」。
  const workspaceTarget = useWorkspaceTarget();
  const usesSampleTarget = targetKindOfSlot(draft.slot) !== "workspace";
  const previewTarget = usesSampleTarget ? sampleTargetOf(draft.slot) : workspaceTarget;
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
  // 面板 HTML 的大编辑器(Monaco,懒加载)。写一段带样式的完整 HTML 才需要它 ——
  // 窄栏里那格 textarea 依然能直接敲短片段(见报告 E8)。
  const [htmlEditorOpen, setHtmlEditorOpen] = useState(false);

  return (
    <>
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
              <Input className={FIELD} value={draft.labelZh} onChange={(e) => set("labelZh", e.target.value)} maxLength={60} />
            </label>
            <label className={LABEL}>
              <span>{t("customUi.editor.labelEn")}</span>
              <Input className={FIELD} value={draft.labelEn} onChange={(e) => set("labelEn", e.target.value)} maxLength={60} />
            </label>
          </div>

          <div className={LABEL}>
            <span>{t("customUi.editor.icon")}</span>
            <div className="flex flex-wrap gap-1">
              {CUSTOM_UI_ICONS.map((name) => {
                const Icon = CUSTOM_ICONS[name];
                return (
                  <Button variant="ghost" size={null}
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => set("icon", draft.icon === name ? "" : name)}
                    className={cn(
                      "rounded border p-1.5",
                      draft.icon === name ? "border-edge/80 bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "border-edge text-content-muted hover:bg-surface-muted",
                    )}
                  >
                    <Icon size={14} />
                  </Button>
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
                <Input className={FIELD} value={draft.extensions} onChange={(e) => set("extensions", e.target.value)} placeholder=".pdf, .md" />
              </label>
            )}
            {kind === "item" && (
              <label className={LABEL}>
                <span>{t("customUi.editor.requires")}</span>
                <NativeSelect className={FIELD} value={draft.requires} onChange={(e) => set("requires", e.target.value as Draft["requires"])}>
                  <option value="">{t("customUi.editor.requires.none")}</option>
                  <option value="file">{t("customUi.editor.requires.file")}</option>
                  <option value="pdf">{t("customUi.editor.requires.pdf")}</option>
                  <option value="markdown">{t("customUi.editor.requires.markdown")}</option>
                </NativeSelect>
              </label>
            )}
            {isLibrary && kind !== "group" && (groups.data?.groups.length ?? 0) > 0 && (
              <div className={LABEL}>
                <span>
                  {t("customUi.editor.groups")} <span className="text-content-subtle">{t("customUi.editor.groupsAll")}</span>
                </span>
                <div className="flex flex-wrap gap-3">
                  {groups.data?.groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-1.5 text-code text-content">
                      <Checkbox

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
                <Button variant="ghost" size={null}
                  key={type}
                  type="button"
                  onClick={() => set("actionType", type)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-code",
                    draft.actionType === type ? "border-edge/80 bg-surface-hover text-content ring-1 ring-inset ring-edge/70" : "border-edge text-content-muted hover:bg-surface-muted",
                  )}
                >
                  {t(
                    (draft.slot === "rightPanel.tab" ? `customUi.editor.tabAction.${type}` : `customUi.editor.action.${type}`) as MessageId,
                  )}
                </Button>
              ))}
            </div>

            {draft.actionType === "view" && (
              <>
                {draft.slot !== "rightPanel.tab" && (
                  <label className={LABEL}>
                    <span>{t("customUi.editor.viewTitle")}</span>
                    <Input className={FIELD} value={draft.viewTitle} onChange={(e) => set("viewTitle", e.target.value)} />
                  </label>
                )}
                <label className={LABEL}>
                  <span>{t("customUi.editor.viewBody")}</span>
                  <Textarea
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
                  <Textarea
                    className={cn(FIELD, "h-36")}
                    value={draft.promptTemplate}
                    onChange={(e) => set("promptTemplate", e.target.value)}
                  />
                </div>
                {isLibrary && (
                  <label className="flex items-center gap-2 text-code text-content">
                    <Checkbox  checked={draft.promptAttach} onChange={(e) => set("promptAttach", e.target.checked)} />
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
                  <Textarea
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
                  <p className="text-code text-content-subtle">{t("customUi.editor.automationNone")}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div className={LABEL}>
                      <HintLabel hint={noRunTarget ? t("customUi.editor.automationHintToolbar") : t("customUi.editor.automationHint")}>
                        {t("customUi.editor.automation")}
                      </HintLabel>
                      <NativeSelect
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
                      </NativeSelect>
                    </div>
                    <label className={LABEL}>
                      <span>{t("customUi.editor.trigger")}</span>
                      <NativeSelect className={FIELD} value={draft.triggerNodeId} onChange={(e) => set("triggerNodeId", e.target.value)}>
                        <option value="">—</option>
                        {triggers.map((f) => (
                          <option key={f.nodeId} value={f.nodeId}>
                            {f.title} · {f.kind}
                          </option>
                        ))}
                        {draft.triggerNodeId && !triggers.some((f) => f.nodeId === draft.triggerNodeId) && (
                          <option value={draft.triggerNodeId}>{draft.triggerNodeId}</option>
                        )}
                      </NativeSelect>
                    </label>
                  </div>
                )}
                {/* skipWhen v1(通用原语):展开时跳过满足条件的条目 —— 手动转录选
                    「已有转录」即得"检测过再跑"。只在**会展开成条目**的挂载位上显示
                    (见契约的 `supportsSkipWhen`;文件目标不过滤、工作区不展开)。 */}
                {canSkipWhen && (
                  <div className={LABEL}>
                    <HintLabel hint={t("customUi.editor.skipWhenHint")}>{t("customUi.editor.skipWhen")}</HintLabel>
                    <NativeSelect
                      className={FIELD}
                      value={draft.skipRequires}
                      onChange={(e) => set("skipRequires", e.target.value as Draft["skipRequires"])}
                    >
                      <option value="">{t("customUi.editor.skipWhen.none")}</option>
                      <option value="markdown">{t("customUi.editor.skipWhen.markdown")}</option>
                      <option value="pdf">{t("customUi.editor.skipWhen.pdf")}</option>
                      <option value="file">{t("customUi.editor.skipWhen.file")}</option>
                    </NativeSelect>
                  </div>
                )}
                {/* 目标怎么用:展开成一批,还是只当落点。空分类那条路全靠它(见 targetMode)。
                    只在分类 / 小类上显示(见契约的 `supportsTargetContext`)—— 大类没有唯一
                    落点、条目 / 文件不是"地方",在别处勾了运行时必报错。 */}
                {canTargetContext && (
                  <label className="flex items-center gap-2 text-[0.8571em]">
                    <Checkbox

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
                        <NativeSelect
                          className={cn(FIELD, "w-24 shrink-0")}
                          value={row.kind}
                          onChange={(e) =>
                            set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, kind: e.target.value as "text" | "files" } : r)))
                          }
                        >
                          <option value="text">{t("customUi.editor.inputs.kindText")}</option>
                          <option value="files">{t("customUi.editor.inputs.kindFiles")}</option>
                        </NativeSelect>
                        <Input
                          className={cn(FIELD, "w-28 shrink-0 font-mono")}
                          placeholder="key"
                          value={row.key}
                          onChange={(e) => set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, key: e.target.value } : r)))}
                          spellCheck={false}
                        />
                        <Input
                          className={cn(FIELD, "min-w-0 flex-1")}
                          placeholder={t("customUi.editor.inputs.labelPh")}
                          value={row.labelZh}
                          onChange={(e) => set("inputs", draft.inputs.map((r, j) => (j === idx ? { ...r, labelZh: e.target.value } : r)))}
                        />
                        <label className="flex shrink-0 items-center gap-1 text-code text-content">
                          <Checkbox

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
                  <Input
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
                <NativeSelect className={FIELD} value={draft.openTab} onChange={(e) => set("openTab", e.target.value)}>
                  <option value="">—</option>
                  {tabChoices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                  {draft.openTab && !tabChoices.some((c) => c.key === draft.openTab) && (
                    <option value={draft.openTab}>{draft.openTab}</option>
                  )}
                </NativeSelect>
              </label>
            )}
            {draft.actionType === "url" && (
              <>
                <div className={LABEL}>
                  <HintLabel hint={t("customUi.editor.urlHint")}>{t("customUi.editor.url")}</HintLabel>
                  <Input
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
                  <Input
                    className={cn(FIELD, "font-mono")}
                    value={draft.shellCommand}
                    onChange={(e) => set("shellCommand", e.target.value)}
                    placeholder="git log --oneline"
                    spellCheck={false}
                  />
                </div>
                <label className="flex items-center gap-2 text-code text-content">
                  <Checkbox  checked={draft.shellConfirm} onChange={(e) => set("shellConfirm", e.target.checked)} />
                  {t("customUi.editor.shellConfirm")}
                </label>
              </>
            )}
            {draft.actionType === "panel" && (
              <>
                {draft.slot !== "rightPanel.tab" && (
                  <label className={LABEL}>
                    <span>{t("customUi.editor.panelTitle")}</span>
                    <Input
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
                    <Button size="sm" variant="ghost" onClick={() => set("panelHtml", panelExampleHtml(locale))} data-testid="custom-ui-panel-example">
                      {t("customUi.editor.panelInsertExample")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setHtmlEditorOpen(true)}
                      data-testid="custom-ui-panel-open-editor"
                    >
                      <IconCode size={13} />
                      {t("customUi.editor.panelOpenEditor")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={previewPanel} data-testid="custom-ui-panel-preview">
                      {t("customUi.editor.panelPreview")}
                    </Button>
                  </div>
                  <Textarea
                    className={cn(FIELD, "h-[340px] resize-y whitespace-pre font-mono text-code leading-relaxed")}
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
                  <label className="flex items-center gap-2 text-code text-content">
                    <Checkbox  checked={draft.panelConfirm} onChange={(e) => set("panelConfirm", e.target.checked)} />
                    {t("customUi.editor.panelConfirm")}
                  </label>
                  <label className="flex items-center gap-2 text-code text-content">
                    <Checkbox  checked={draft.panelNetwork} onChange={(e) => set("panelNetwork", e.target.checked)} />
                    {t("customUi.editor.panelNetwork")}
                  </label>
                </div>
                {draft.panelNetwork && (
                  <p className="text-[0.7857em] leading-relaxed text-warning">{t("customUi.editor.panelNetworkWarn")}</p>
                )}
                {preview !== null && (
                  <div className="overflow-hidden rounded-md border border-edge" data-testid="custom-ui-panel-preview-box">
                    <div className="flex h-7 items-center gap-2 border-b border-edge bg-surface-muted px-2 text-[0.7857em] text-content-subtle">
                      <span className="flex-1">{t("customUi.editor.panelPreviewing")}</span>
                      <Button variant="ghost" size={null} type="button" className="hover:text-content" onClick={() => setPreview(null)}>
                        {t("customUi.editor.panelPreviewClose")}
                      </Button>
                    </div>
                    {usesSampleTarget && (
                      <p
                        className="border-b border-edge bg-warning/10 px-2 py-1 text-[0.7857em] leading-relaxed text-warning"
                        data-testid="custom-ui-panel-preview-sample"
                      >
                        {t("customUi.editor.panelPreviewSample")}
                      </p>
                    )}
                    <div className="h-[360px]">
                      <PanelFrame item={preview.item} target={previewTarget} reloadKey={preview.n} probeMode="preview" />
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
    {/* 面板 HTML 的大编辑器 —— 叠在编辑框上面一层(仓库里浮层叠浮层是常态:
        CustomUiHost 的面板 + 确认框就是这么摞的)。关掉它不碰草稿。 */}
    {htmlEditorOpen && (
      <Suspense fallback={null}>
        <PanelHtmlDialog
          value={draft.panelHtml}
          onChange={(v) => set("panelHtml", v)}
          onClose={() => setHtmlEditorOpen(false)}
        />
      </Suspense>
    )}
    </>
  );
}

/* ────────────────────────── 高级 ────────────────────────── */

export function AdvancedSection() {
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

  const apply = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setNote(t("customUi.advanced.invalid"));
      return;
    }
    const next = coerceCustomUiConfig(parsed);
    // **等落盘结果再报「已应用」。** 从前 `void save(next)` 之后无条件写这句话 ——
    // 而 `save` 会返回 false(失败时它自己会 pushToast 报错)。于是两处提示互相矛盾,
    // 只看到 inline note 的用户会以为 JSON 已经生效了。
    const ok = await save(next);
    setDirty(false);
    setNote(
      ok
        ? t("customUi.advanced.applied", { n: next.items.length })
        : t("settings.saveFailed"),
    );
  };

  return (
    <div className="space-y-4">
      <SettingsSection title={t("customUi.advanced.json")} desc={t("customUi.advanced.jsonHint")}>
        <div className="space-y-2 p-3">
          <Textarea
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
            {/* 复制走共享的 `copyText`:它带非安全上下文的 textarea 兜底,并**返回成败**。
                从前这里 `void navigator.clipboard.writeText(...)` —— 手机端网页(HTTP,
                非安全上下文)根本没有 `navigator.clipboard`,点一下是同步抛错 + 一个没人接
                的 rejection(渲染端没有全局 `unhandledrejection`),按钮看起来毫无反应;
                桌面上写失败也是静默。与别处复制同一个出口。 */}
            <Button
              onClick={() => {
                void copyText(text).then((ok) => setNote(ok ? t("customUi.advanced.copied") : t("customUi.run.copyFailed")));
              }}
            >
              {t("customUi.advanced.copy")}
            </Button>
            <Button variant="primary" onClick={apply}>
              {t("customUi.advanced.apply")}
            </Button>
            {note && <span className="text-[0.8571em] text-content-subtle">{note}</span>}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={t("customUi.advanced.modules")} desc={t("customUi.advanced.modulesHint")}>
        <div className="p-3">
          <p className="text-code text-content-subtle">{t("customUi.advanced.modulesNoProject")}</p>
        </div>
      </SettingsSection>
    </div>
  );
}
