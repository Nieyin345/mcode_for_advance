import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Editor, { DiffEditor, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { api } from "@renderer/lib/api.js";
import { textFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { cn } from "@renderer/lib/cn.js";
import { basename, dirname, extname } from "@renderer/lib/path.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import { isOnlyOfficeEditablePath, type FileViewMode } from "@contracts/ipc";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { ideDirtyTracker } from "./OpenTabsBar.js";
import { IconEye, IconEdit, IconLoader2, IconAlertTriangle, IconSquare, IconColumns3, IconPhotoOff, IconArrowLeft, IconArrowRight } from "@renderer/lib/icons.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { ChunkedMarkdown } from "../chat/ChunkedMarkdown.js";
import { PdfPreview } from "../library/PdfPreview.js";
import { MarkdownEditorPane } from "./MarkdownEditorPane.js";
import { OnlyOfficeEditorPane } from "./OnlyOfficeEditorPane.js";
import { DocxPreview } from "@renderer/components/templates/DocxPreview.js";
import { XlsxPreview } from "@renderer/components/templates/XlsxPreview.js";
import { PptxPreview } from "@renderer/components/templates/PptxPreview.js";
import { SelectionToolbar, type SelectionToolbarState } from "@renderer/components/chat/SelectionToolbar.js";
import { SelectionQuoteMenu, type QuoteTarget } from "@renderer/components/chat/SelectionQuoteMenu.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
// LSP provider bridge: registers definition/references/hover providers, syncs
// documents, and applies diagnostics markers to the model.
import {
  ensureLspProviders,
  useLspDiagnostics,
  useLspGotoActivities,
  openLspDocument,
  closeLspDocument,
  notifyLspChange,
  notifyLspSave,
  bindModelToPath,
  unbindModel,
  filePathToUri,
  monacoLanguageToLsp,
  LSP_LANGUAGE_DISPLAY,
  type GotoKind,
} from "@renderer/lib/lspProviders.js";
// Side-effect import: configures Monaco's worker environment + local instance
// (no CDN). Must run before any <Editor> mounts. See monacoSetup.ts.
import "@renderer/lib/monacoSetup.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { setLastCursor, type NavEntry } from "@renderer/lib/editorNav.js";
import { useScrollMemory } from "@renderer/lib/scrollMemory.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
// Monaco model cache (keepCurrentModel ownership): hot tab switches reuse the
// cached TextModel — tokenization, undo history and unsaved edits survive.
import {
  getModelEntry,
  getBaseline,
  registerModel,
  updateBaseline,
  disposeModel,
  setDisplayedPath,
} from "@renderer/lib/editorModelCache.js";

/**
 * File editor — wraps Monaco for a single open file. Supports two modes:
 *
 *  - "edit": a normal editable Monaco instance. Ctrl+S saves via
 *    `file.writeFile`. Dirty state (content diverges from last save) is
 *    reported to OpenTabsBar via `ideDirtyTracker` so the tab shows a dot.
 *
 *  - "diff": a side-by-side Monaco DiffEditor comparing the file's
 *    pre-turn `before` snapshot (from turnFilesBySession) against its current
 *    on-disk content. Read-only. Used when the user clicks 审查 on a
 *    turn-files card, or when an agent-touched file is opened.
 *
 * Mode is per-file and lives in the store (ideFileViewMode); a toggle in the
 * toolbar lets the user flip between the two when a `before` snapshot exists.
 * Files without a snapshot can only be edited (no diff to show).
 *
 * Theme follows the app's `.dark` class on <html> via a MutationObserver —
 * Monaco doesn't react to CSS, so we explicitly call `setTheme` on change.
 */
export function FileEditor({
  filePath,
  projectPath,
}: {
  filePath: string;
  projectPath: string;
}) {
  // View mode is scoped to the active project's bucket.
  //
  // ## 默认档（2026-09-21 改）：md 进**所见即所得**
  //
  // 用户的原话是「点开就该能改」—— 所以 md 不再先落一屏只读渲染，而是直接进
  // 富文本编辑（`MarkdownEditorPane`，MDXEditor）。源码视图和只读预览都还在，
  // 工具栏上那个按钮三档轮转。
  //
  // PDF 仍然默认**预览**：它是二进制，Monaco 画出来就是一屏乱码（用户截图里
  // 那个坏状态）。其余文件（代码、json、日志）默认 `edit` —— 打开就是要改。
  //
  // 用户自己的选择仍然优先：`ideFileViewModeByProject` 里记着他在这个项目里为这个
  // 文件选过哪一档，改完照旧留着（`??` 只在**没有记录**时生效）。
  //
  // Office（docx / xlsx / pptx…）与 md 同理（2026-09-27）：默认进 **OnlyOffice 可视化
  // 编辑**（`wysiwyg`），「预览」那一档是 docx-preview / @js-preview/excel / pptx-preview
  // 的只读渲染 —— DS 没配 / 连不上时的退路。它们**没有**源码档（二进制）。
  const defaultMode: FileViewMode = isMarkdown(filePath) || isOnlyOfficeEditablePath(filePath)
    ? "wysiwyg"
    : isPdfFile(filePath)
      ? "preview"
      : "edit";
  const pid = useSessionStore((s) => s.activeProjectId);
  const viewMode = useSessionStore((s) =>
    pid ? s.ideFileViewModeByProject[pid]?.[filePath] ?? defaultMode : defaultMode,
  );
  const setViewMode = useSessionStore((s) => s.setIdeFileViewMode);
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const setEditorMode = useSessionStore((s) => s.setIdeEditorMode);

  // Resolve the before-snapshot for diff mode. Three sources, in priority:
  //  1. Turn-files card override - the card's frozen `before` (passed when
  //     the user clicks a file to review). Works for HISTORICAL turns whose
  //     snapshot is gone from turnFilesBySession.
  //  2. Git panel - the active project's gitDiffByProject bucket (working-tree
  //     or history click). History pairs also carry an explicit `after` blob.
  //  3. Turn-files - the active session's latest-turn snapshot (the agent
  //     edited the file, or the user clicked 审查 on the latest turn's card).
  const turnFile = useTurnFileFor(filePath);
  const gitPair = useGitDiffPair(filePath);
  const diffBeforeOverride = useSessionStore((s) =>
    pid ? s.ideDiffBeforeByProject[pid]?.[filePath] : undefined,
  );
  const diffBefore = diffBeforeOverride ?? gitPair?.before ?? turnFile?.before;
  const diffAfter = gitPair?.after;
  // History diffs are pure blobs — don't offer switching into the live editor,
  // which would show unrelated working-tree content.
  const historyOnly = diffAfter != null;

  // Effective mode:
  //  - diff: history pairs (forced) OR explicitly requested with a snapshot.
  //  - preview: explicitly requested (Markdown rendered read-only).
  //  - wysiwyg: Markdown 的所见即所得（MDXEditor）。
  //  - edit: the normal editable Monaco instance (default for non-md files).
  const effectiveMode: FileViewMode =
    historyOnly || (viewMode === "diff" && diffBefore != null)
      ? "diff"
      : viewMode === "preview"
        ? "preview"
        : viewMode === "wysiwyg"
          ? "wysiwyg"
          : "edit";

  const markdown = isMarkdown(filePath);
  const image = isImage(filePath);
  /** DS 能编辑的 Office 文档 —— 判据与主进程共用 `@contracts/ipc` 那一份。 */
  const office = isOnlyOfficeEditablePath(filePath);
  const unsupported = isUnsupported(filePath);
  /** PDF 走**同一个** `PdfPreview`（pdf.js 官方 viewer 组件）—— 见文件头那段
   *  "同一个 PDF 不该有两套画法"（那是 `FileViewer` 的取舍,这里沿用）。 */
  const pdf = isPdfFile(filePath);

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        filePath={filePath}
        projectPath={projectPath}
        mode={effectiveMode}
        canDiff={diffBefore != null && !historyOnly}
        onToggleMode={() => setViewMode(filePath, effectiveMode === "edit" ? "diff" : "edit")}
        isMarkdown={markdown}
        isImage={image}
        isOffice={office}
        isUnsupported={unsupported}
        onTogglePreview={() =>
          // md 三档轮转：所见即所得 → 预览 → 源码 → 回到所见即所得。
          // 为什么不是"两档对切"：md 的默认档是 wysiwyg，对切的话源码那一档
          // 就永远够不着了（用户要能看原始 markdown 改 frontmatter、调表格对齐）。
          //
          // ⚠️ 判据用 `markdown`（上面从 `isMarkdown(filePath)` 算出来的**布尔**），
          // 不能用 prop 同名那个 `isMarkdown` —— 那是**函数**，恒真。
          markdown
            ? setViewMode(
                filePath,
                effectiveMode === "wysiwyg"
                  ? "preview"
                  : effectiveMode === "preview"
                    ? "edit"
                    : "wysiwyg",
              )
            : office
              // Office 两档对切：可视化编辑 ↔ 只读预览（没有源码档，二进制进 Monaco 只是乱码）
              ? setViewMode(filePath, effectiveMode === "wysiwyg" ? "preview" : "wysiwyg")
              : setViewMode(filePath, effectiveMode === "preview" ? "edit" : "preview")
        }
        editorMode={editorMode}
        onToggleEditorMode={() => setEditorMode(editorMode === "tabs" ? "replace" : "tabs")}
      />
      <div className="min-h-0 flex-1">
        {effectiveMode === "diff" && diffBefore != null ? (
          <DiffPane filePath={filePath} before={diffBefore} after={diffAfter} />
        ) : effectiveMode === "wysiwyg" ? (
          office ? (
            <OnlyOfficeEditorPane
              key={filePath}
              filePath={filePath}
              onSwitchToPreview={() => setViewMode(filePath, "preview")}
            />
          ) : (
            <MarkdownEditorPane key={filePath} filePath={filePath} projectPath={projectPath} />
          )
        ) : effectiveMode === "preview" ? (
          pdf ? (
            <PdfPreviewPane filePath={filePath} />
          ) : office ? (
            <OfficePreviewPane filePath={filePath} />
          ) : image ? (
            <ImagePreviewPane filePath={filePath} />
          ) : unsupported ? (
            <UnsupportedPane filePath={filePath} />
          ) : (
            <MarkdownPreviewPane filePath={filePath} projectPath={projectPath} />
          )
        ) : (
          <EditPane filePath={filePath} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Toolbar ───────────────────────── */

/** Stable empty nav stack for zustand selectors (never return a fresh []). */
const EMPTY_NAV: NavEntry[] = [];

/**
 * 「源码 / 预览」那个按钮的四档文案。
 *
 * 为什么是四态而不是两态：md 现在有**三档**（源码 / 所见即所得 / 预览），
 * 非 md 还是两档（源码 / 预览）。按钮说的是"**点一下会切到哪儿**"，
 * 不是"现在在哪儿" —— 这和它原来的行为一致（`mode === "preview" ? Edit : Preview`）。
 */
const TOGGLE_LABEL_KEY = {
  edit: "ide.editor.togglePreview",
  diff: "ide.editor.togglePreview",
  preview: "ide.editor.toggleEdit",
  wysiwyg: "ide.editor.toggleSource",
} as const satisfies Record<FileViewMode, string>;

const TOGGLE_TITLE_KEY = {
  edit: "ide.editor.switchToPreview",
  diff: "ide.editor.switchToPreview",
  preview: "ide.editor.switchToSource",
  wysiwyg: "ide.editor.switchToSourceView",
} as const satisfies Record<FileViewMode, string>;

/** Office 两档（可视化编辑 ↔ 只读预览）的按钮文案：wysiwyg 那一档下一步是**预览**，
 *  不是 md 的"源码"。 */
const OFFICE_TOGGLE_LABEL_KEY = {
  ...TOGGLE_LABEL_KEY,
  wysiwyg: "ide.editor.togglePreview",
} as const satisfies Record<FileViewMode, string>;
const OFFICE_TOGGLE_TITLE_KEY = {
  ...TOGGLE_TITLE_KEY,
  preview: "ide.editor.switchToOfficeEdit",
  wysiwyg: "ide.editor.switchToPreview",
} as const satisfies Record<FileViewMode, string>;

function EditorToolbar({
  filePath,
  projectPath,
  mode,
  canDiff,
  onToggleMode,
  isMarkdown,
  isImage,
  isOffice,
  isUnsupported,
  onTogglePreview,
  editorMode,
  onToggleEditorMode,
}: {
  filePath: string;
  projectPath: string;
  mode: FileViewMode;
  canDiff: boolean;
  onToggleMode: () => void;
  isMarkdown: boolean;
  isImage: boolean;
  isOffice: boolean;
  isUnsupported: boolean;
  onTogglePreview: () => void;
  editorMode: "tabs" | "replace";
  onToggleEditorMode: () => void;
}) {
  const { t } = useI18n();
  // Navigation-history (Alt+←/→) back/forward state — enabled iff the active
  // project's stacks are non-empty. The buttons live here (not in a global
  // toolbar) because they act on the editor column.
  const navPid = useSessionStore((s) => s.activeProjectId);
  const canBack = useSessionStore((s) =>
    navPid ? (s.navBackByProject[navPid] ?? EMPTY_NAV).length > 0 : false,
  );
  const canForward = useSessionStore((s) =>
    navPid ? (s.navForwardByProject[navPid] ?? EMPTY_NAV).length > 0 : false,
  );
  const navigateBack = useSessionStore((s) => s.navigateBack);
  const navigateForward = useSessionStore((s) => s.navigateForward);
  // Language-server status for THIS file's language (active project's
  // workspace): "starting" shows a loading pill (jdtls can take minutes),
  // "stopped" with an error shows a failure notice that re-launches the
  // server on click (after the user fixes the environment, e.g. Java).
  // "running"/no-LSP-language show nothing.
  const lspStatus = useSessionStore((s) => {
    const lspLang = monacoLanguageToLsp(languageForExt(extname(filePath)));
    if (!lspLang) return null;
    const pid = s.activeProjectId;
    const projPath = pid ? s.projects.find((p) => p.id === pid)?.path : undefined;
    if (!projPath) return null;
    return s.lspPhasesByWorkspace[`${projPath}::${lspLang}`] ?? null;
  });
  const lspLanguageId = monacoLanguageToLsp(languageForExt(extname(filePath)));
  // Restarting guard: the `lsp:event` stateChanged stream drives the pill
  // through starting → running/stopped on its own; this flag only prevents
  // double-clicks during the brief pre-start window.
  const [restartingLsp, setRestartingLsp] = useState(false);
  const restartLsp = useCallback(async () => {
    if (!lspLanguageId || restartingLsp) return;
    const s = useSessionStore.getState();
    const pid = s.activeProjectId;
    const projPath = pid ? s.projects.find((p) => p.id === pid)?.path : undefined;
    if (!projPath) return;
    setRestartingLsp(true);
    let failure: string | undefined;
    try {
      const result = await api.lsp.restart({ workspacePath: projPath, language: lspLanguageId });
      if (!result.ok) failure = result.error;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      setRestartingLsp(false);
    }
    if (failure) {
      useToastStore.getState().push({
        kind: "error",
        title: t("ide.editor.lspRestartFailed", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] }),
        body: failure,
      });
    }
  }, [lspLanguageId, restartingLsp, t]);
  // Tooltip = label + the EFFECTIVE chord (user override or Alt+←/→ default),
  // so a rebind in settings is reflected here immediately.
  const shortcutOverrides = useSessionStore((s) => s.shortcutOverrides);
  const withChord = (commandId: string, label: string) => {
    const accel = resolveShortcut(commandId, shortcutOverrides);
    return accel ? `${label} (${acceleratorToDisplayString(accel)})` : label;
  };
  const navBackTitle = withChord("editor.nav-back", t("ide.editor.navBack"));
  const navForwardTitle = withChord("editor.nav-forward", t("ide.editor.navForward"));
  // Files that default to a read-only preview pane (markdown rendered, image
  // displayed, or an unsupported-type notice). These get a Preview/Edit toggle
  // so the user can still drop into the raw Monaco editor if they want.
  //
  // ⚠️ **PDF 故意不在这个列表里。** 它同样默认走预览（见上面 `defaultMode`），
  // 但**不该给"切到 Monaco 看看"那个按钮** —— pdf 是二进制，Monaco 画出来就是
  // 一屏乱码，那正是用户截图里那个坏状态。给它一个按下去只会看到乱码的按钮，
  // 比不给更坏（同 `FileViewer` 里"画一个按下去不动的按钮比不画更坏"那条取舍）。
  const hasPreviewToggle = isMarkdown || isImage || isUnsupported || isOffice;
  const labelKey = isOffice ? OFFICE_TOGGLE_LABEL_KEY : TOGGLE_LABEL_KEY;
  const titleKey = isOffice ? OFFICE_TOGGLE_TITLE_KEY : TOGGLE_TITLE_KEY;
  // Show the path relative to the project root when possible (cleaner in the
  // narrow toolbar); fall back to the full path. Case-insensitive on Windows/
  // macOS so a lowercased drive letter from LSP (`d:\foo`) still matches a
  // project root stored with uppercase (`D:\foo`).
  const lowerFile = filePath.toLowerCase();
  const lowerProj = projectPath.toLowerCase();
  const rel =
    lowerFile.startsWith(lowerProj) && filePath.length > projectPath.length
      ? filePath.slice(projectPath.length).replace(/^[/\\]/, "")
      : filePath;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-muted/40 px-2.5 py-1">
      {/* Back/forward (navigation history) — disabled when the stacks are
          empty. Mirrors the Alt+←/→ global shortcuts. */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={navigateBack}
          disabled={!canBack}
          className={cn(
            "flex items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
            "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-subtle",
          )}
          title={navBackTitle}
        >
          <IconArrowLeft size={13} />
        </button>
        <button
          type="button"
          onClick={navigateForward}
          disabled={!canForward}
          className={cn(
            "flex items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
            "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-subtle",
          )}
          title={navForwardTitle}
        >
          <IconArrowRight size={13} />
        </button>
      </div>
      <FileTypeIcon path={filePath} size={14} className="shrink-0 text-content-subtle" />
      <span className="truncate font-mono text-[11px] text-content-muted" title={filePath}>
        {rel}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {/* Language-server startup indicator: spinner while the server's
            initialize handshake is in flight, a failure notice (click →
            settings) when it couldn't start. Requests made while starting
            wait for the server, so this pill explains the perceived lag. */}
        {lspStatus?.phase === "starting" && lspLanguageId && (
          <span
            className="flex items-center gap-1 text-[11px] text-content-subtle"
            title={t("ide.editor.lspStartingHint")}
          >
            <IconLoader2 size={11} className="animate-spin" />
            {t("ide.editor.lspStarting", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
          </span>
        )}
        {lspStatus?.phase === "importing" && lspLanguageId && (
          <span
            className="flex items-center gap-1 text-[11px] text-content-subtle"
            title={t("ide.editor.lspImportingHint")}
          >
            <IconLoader2 size={11} className="animate-spin" />
            {t("ide.editor.lspImporting", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
            {lspStatus.detail ? ` ${lspStatus.detail}` : ""}
          </span>
        )}
        {lspStatus?.phase === "stopped" && lspStatus.error && lspLanguageId && (
          <button
            type="button"
            onClick={restartLsp}
            disabled={restartingLsp}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-danger hover:bg-surface-hover",
              restartingLsp && "opacity-60",
            )}
            title={`${lspStatus.error}\n${t("ide.editor.lspRestartHint")}`}
          >
            {restartingLsp ? (
              <IconLoader2 size={11} className="animate-spin" />
            ) : (
              <IconAlertTriangle size={11} />
            )}
            {t("ide.editor.lspFailed", { name: LSP_LANGUAGE_DISPLAY[lspLanguageId] })}
          </button>
        )}
        {canDiff && mode !== "preview" && (
          <button
            type="button"
            onClick={onToggleMode}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={mode === "edit" ? t("ide.editor.switchToDiff") : t("ide.editor.switchToEditView")}
          >
            {mode === "edit" ? <IconEye size={12} /> : <IconEdit size={12} />}
            {mode === "edit" ? "Diff" : "Edit"}
          </button>
        )}
        {/* Preview/Edit toggle - for files that default to a read-only preview
            pane (Markdown rendered, image displayed, or an unsupported-type
            notice). In preview mode the button switches to the source editor;
            in edit/diff mode it switches to the rendered preview. For binary
            files (image/unsupported) "Edit" shows raw content as Monaco sees
            it (garbled for non-utf-8) - kept as an escape hatch, not the norm.

            ⚠️ md 多一档：它默认就是**所见即所得**（`wysiwyg`），所以这里的
            三态是 源码(edit) ↔ 富文本(wysiwyg) ↔ 预览(preview)。 */}
        {hasPreviewToggle && (
          <button
            type="button"
            onClick={onTogglePreview}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={t(titleKey[mode])}
          >
            {mode === "edit" ? <IconEye size={12} /> : <IconEdit size={12} />}
            {t(labelKey[mode])}
          </button>
        )}
        {/* Editor open-mode toggle: tabs (multi-file) ↔ replace (single-file).
            Always visible so the user can switch back to tabs even when the
            OpenTabsBar is hidden (replace mode). */}
        <button
          type="button"
          onClick={onToggleEditorMode}
          className={cn(
            "flex items-center justify-center rounded px-1 py-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
          title={
            editorMode === "tabs"
              ? t("ide.editor.modeTabsHint")
              : t("ide.editor.modeReplaceHint")
          }
        >
          {editorMode === "tabs" ? <IconColumns3 size={13} /> : <IconSquare size={13} />}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Edit pane ───────────────────────── */

/** Per-file editor view states (scroll position + cursor selection), keyed by
 *  absolute file path. App.tsx mounts FileEditor with `key={filePath}`, so
 *  every file switch tears the Monaco instance down (the TextModel survives
 *  via the model cache — see editorModelCache.ts — but the editor widget and
 *  its view state do not). The @monaco-editor/react built-in view-state cache
 *  also stashes on `keepCurrentModel` unmount, but this eager-stashed cache
 *  is the primary: re-opening a file puts the user back where they left off. */
const viewStateCache = new Map<string, editor.ICodeEditorViewState>();

/** How long a mount-time view-state re-assert keeps trying (see EditPane's
 *  armMountReassert): the fallback for widgets whose post-mount layout change
 *  never arrives. Bounded so a later window resize can't jump the scroll. */
const MOUNT_RESTORE_REASSERT_MS = 400;

/** Per-file DIFF view states (scroll + cursor of BOTH panes), keyed by
 *  absolute file path. The diff pane reuses one anonymous model pair across
 *  file switches and the library resets scroll on every content swap / widget
 *  remount — this cache puts each file back where the user left it. Mirrors
 *  `viewStateCache` (edit pane) above. */
const diffViewStateCache = new Map<
  string,
  {
    original: editor.ICodeEditorViewState;
    modified: editor.ICodeEditorViewState;
  }
>();

/** Editable Monaco instance for one file. Loads content on mount; tracks
 *  dirty state; Ctrl+S saves. Wires LSP document sync + providers when the
 *  file's language has a server enabled. Re-opening a file restores its last
 *  scroll position / cursor from `viewStateCache`. */
/** Context of the file whose model the persistent editor is displaying.
 *  Everything acting on "the current file" (save, LSP notify, dirty tracking,
 *  model ownership) reads this ref so closures survive every model swap. */
interface ReadyCtx {
  path: string;
  projectPath: string;
  pid: string | null;
}

/** Ensure a cached model exists for `path` holding `content` — create it (the
 *  EditPane owns model creation; the lib never creates models because `value`
 *  stays undefined for the Editor's whole life) or adopt an orphan lib-side
 *  model. */
function adoptModel(
  monaco: typeof import("monaco-editor"),
  path: string,
  content: string,
): void {
  if (getModelEntry(path)) return;
  const uri = monaco.Uri.parse(filePathToUri(path));
  let model = monaco.editor.getModel(uri) ?? null;
  if (model) {
    // Orphan (created lib-side before the cache knew) — adopt and sync.
    try {
      model.setValue(content);
    } catch {
      model = null; // disposed — fall through to create
    }
  }
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(content, languageForExt(extname(path)), uri);
  }
  registerModel(path, model, content);
}

function EditPane({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const { t } = useI18n();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  /**
   * **在编辑器里选一段文字 → 引用给某条对话**（2026-09-21）。
   *
   * ★ 用户的要求：「消息，文献编辑，文献预览**都要有**，选中就能引用」。
   * 前两处早就有了（`ChatPane` / `FileViewer` 各挂了一份 `SelectionToolbar`），
   * 只有**这一处**没有 —— 而它恰恰是最需要的那处（用户在这里改文档）。
   *
   * ## 为什么不能照抄另外两处
   *
   * 它们读的是 `window.getSelection()`。**Monaco 是自绘的**：它的文字画在 canvas
   * 上，DOM 里那层只是辅助，`window.getSelection()` 在里面拿不到选区（或拿到的是
   * 错位的）。要从 Monaco 拿选区只能走它自己的 API：
   * `editor.getSelection()` + `model.getValueInRange(...)`。
   *
   * ## 触发时机也不能照抄
   *
   * 网页里选完一松手、选区就没了（所以那两处挂 `mouseup`）。而 **Monaco 的选区是
   * 常驻的** —— 点一下别处才取消。照抄 `mouseup` 的话，用户拖选到一半（还没松手）
   * 就会弹条；松手后再点一下，条还挂着但选区已经没了。
   *
   * 所以这里用 `onDidChangeCursorSelection`（Monaco 自己会在拖选结束时发），
   * 且**只在"非空选区 + 鼠标不在按着"**时才亮 —— 后者靠监听编辑器容器的鼠标状态，
   * 免得拖选过程中一直闪。
   */
  const [mdSel, setMdSel] = useState<SelectionToolbarState | null>(null);
  const [mdQuote, setMdQuote] = useState<SelectionToolbarState | null>(null);
  /** 鼠标是不是正按在编辑器里（拖选中）。见上面那段"触发时机"。 */
  const draggingRef = useRef(false);

  /**
   * 把 Monaco 的选区换算成 `SelectionToolbarState`（浮层要的那几个数）。
   *
   * ⚠️ 坐标要的是**视口坐标**（`position: fixed`），而 Monaco 给的
   * `getScrolledVisiblePosition` 是**相对编辑器容器**的 —— 必须加上容器的
   * `getBoundingClientRect()`，否则浮层会跑到编辑器外面去（编辑器不在页面左上角时）。
   */
  const readMonacoSelection = useCallback((): SelectionToolbarState | null => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel || sel.isEmpty()) return null;

    const text = model.getValueInRange(sel).trim();
    if (!text) return null;

    const node = ed.getDomNode();
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const start = ed.getScrolledVisiblePosition({ lineNumber: sel.startLineNumber, column: sel.startColumn });
    const end = ed.getScrolledVisiblePosition({ lineNumber: sel.endLineNumber, column: sel.endColumn });
    if (!start || !end) return null;

    const left = box.left + Math.min(start.left, end.left);
    const right = box.left + Math.max(start.left, end.left) + 1;
    const top = box.top + Math.min(start.top, end.top);
    const bottom = box.top + Math.max(start.top, end.top) + (start.height || 18);

    return {
      rect: { top, bottom, left, right },
      text,
      // 编辑器里没有"消息"这个概念 —— 空串。书签那个按钮因此不画
      // （它靠 messageId 定位，见 `SelectionToolbar` 的 props 说明）。
      messageId: "",
      role: "assistant",
    };
  }, []);

  /** 引用落到哪 —— **只落草稿，不替用户发**（与另外两处逐字同一个做法）。
   *
   *  落点走 store 的 `quoteIntoComposer`（共享实现只有一份，硬规矩 2）——
   *  它内部带 touch 计数，目标会话开着时那个输入框会当场重跑草稿还原、
   *  没开的下次挂载见。见 `deliverComposerDraft` 的说明。 */
  const quoteFromEditor = useCallback(
    (target: QuoteTarget, text: string) => {
      const quoted = text.trim();
      setMdQuote(null);
      setMdSel(null);
      if (!quoted) return;
      // 落成**绿色小标签**，不是一段纯文本 —— 用户 2026-09-21 明确要求
      // 「像引用文件一样在对话框里面加一个绿色的小标签」。
      //
      // `makeQuoteTag` 在正文外面套一层「user's quote（…）+ source」。编辑器这条
      // 手边就有绝对路径（`filePath`），直接给。
      const tag = makeQuoteTag({
        text: quoted,
        origin: { kind: "file", filePath, name: basename(filePath) },
      });
      useSessionStore.getState().quoteIntoComposer(target.id, tag);
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.quote.doneToast", { name: target.title }),
        sessionId: target.id,
      });
    },
    [t, filePath],
  );
  // Monaco namespace from the loader (local instance — see monacoSetup.ts).
  // Null until the loader resolves; the first model creation waits for it.
  const monacoInstance = useMonaco();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // PERSISTENT EDITOR: this component is NOT keyed by file. The single Monaco
  // instance below swaps models via the `path` prop (the lib does
  // saveViewState → setModel → restoreViewState on the live widget), so a
  // file switch no longer tears the editor down.
  //
  // readyPath — the file whose model is currently displayed. Warm start: when
  // a cached model already exists for the incoming file, display it on the
  // first render (no spinner frame).
  const [readyPath, setReadyPath] = useState<string | null>(() =>
    // A cached Markdown model can predate a rich-editor save; reconcile it
    // with disk before showing it, not after the user can already type.
    filePath && !isMarkdown(filePath) && !textFileWrites.hasPending(filePath) && getModelEntry(filePath)
      ? filePath : null,
  );
  // loadingPath — a file whose first-time content read is in flight (no
  // cached model). While it differs from readyPath, the editor keeps showing
  // the previous file (hold-last-ready) under a loading veil.
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  // Set when the freshness check finds the DISPLAYED file changed on disk
  // while its model holds unsaved edits — the user decides (reload or keep).
  const [externalChange, setExternalChange] = useState(false);
  // Context of the displayed file (see ReadyCtx).
  const readyCtxRef = useRef<ReadyCtx | null>(null);
  // Latest-ref mirror of the loader's monaco namespace — async callbacks
  // (a read's .then) must never act on a stale null from their own render.
  const monacoInstanceRef = useRef(monacoInstance);
  useEffect(() => {
    monacoInstanceRef.current = monacoInstance;
  }, [monacoInstance]);
  // Set false once the component unmounts; async callbacks check it before
  // touching state / the displayed-model marker.
  const disposedRef = useRef(false);
  /**
   * 挂载时注册的清理函数（编辑器事件监听 / Monaco 的 disposable）。
   *
   * ⚠️ **必须收在这里**：Monaco 的 `onDidChangeCursorSelection` 返回的 disposable
   * 不 dispose 的话会一直持有我们这个闭包（连带整个组件树），换文件几次就漏一批。
   * 而 `onMount` 每次挂载只跑一次，所以清理只能靠"存起来、卸载时统一跑"。
   */
  const unmountCleanupsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    disposedRef.current = false;
    const cleanups = unmountCleanupsRef.current;
    return () => {
      disposedRef.current = true;
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* 已经拆过了 */
        }
      }
    };
  }, []);
  // readSeq invalidates in-flight first reads when the target file changes
  // quickly; flipSeq invalidates in-flight freshness checks on every swap.
  const readSeqRef = useRef(0);
  const flipSeqRef = useRef(0);
  // A first read that completed before the loader had a monaco namespace.
  const pendingCreateRef = useRef<{ path: string; content: string; projectPath: string } | null>(
    null,
  );
  // The freshness check is pointless right after a model was created from a
  // fresh read — skip it once for that path.
  const skipVerifyPathRef = useRef<string | null>(null);
  // Cancel hook of a pending mount-time view-state re-assert (see
  // armMountReassert) — dropped by a reveal or by the teardown.
  const cancelMountReassertRef = useRef<(() => void) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeqRef = useRef(0);
  // LSP document-sync version counter (incremented on each didChange).
  const lspVersionRef = useRef(1);
  // Debounce timer for didChange notifications.
  const changeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Editor event-listener disposables (view-state stash, cursor tracking,
  // reveal re-centering retry) — disposed on unmount.
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  // Reveal nonce consumer - re-runs when the store requests a goto-def reveal.
  const ideRevealNonce = useSessionStore((s) => s.ideRevealNonce);
  const idePendingReveal = useSessionStore((s) => s.idePendingReveal);

  // Warm-start init (idempotent): adopt the display context for a cached
  // first file and mark it as the displayed model for the store's ownership
  // rule (store close/rename actions never dispose the displayed model).
  if (readyCtxRef.current === null && readyPath !== null) {
    readyCtxRef.current = {
      path: readyPath,
      projectPath,
      pid: useSessionStore.getState().activeProjectId,
    };
    setDisplayedPath(readyPath);
  }

  /** Scroll to + focus the pending reveal target if it targets the DISPLAYED
   *  file, and clear it. Shared by the nonce effect (reveal into the
   *  already-displayed file) and onMount / the post-swap effect.
   *
   *  The target is revealed at the CENTER of the viewport (VS Code behavior).
   *  On a fresh mount the editor may still carry a degenerate layout from
   *  creation time (viewport ≈ 0–1 lines tall) — revealLineInCenter would
   *  then compute a top-aligned offset and the target lands on the FIRST
   *  visible line once automaticLayout settles. Two guards: force a
   *  synchronous layout measure before revealing, and re-assert the
   *  centering on the first post-reveal layout change (bounded to ~1s so a
   *  later user resize never jumps the scroll back). */
  const applyReveal = () => {
    const reveal = useSessionStore.getState().idePendingReveal;
    if (!reveal || reveal.filePath !== readyCtxRef.current?.path) return;
    const ed = editorRef.current;
    if (!ed) return;
    // An explicit jump outranks the mount-time scroll restore.
    cancelMountReassertRef.current?.();
    const doReveal = () => {
      ed.revealLineInCenter(reveal.line);
      ed.setPosition({ lineNumber: reveal.line, column: reveal.column });
    };
    ed.layout(); // measure the container NOW so the centering math is real
    doReveal();
    ed.focus();
    useSessionStore.getState().clearIdePendingReveal();
    let retryListener: { dispose(): void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const stopRetry = () => {
      retryListener?.dispose();
      if (retryTimer) clearTimeout(retryTimer);
      retryListener = null;
      retryTimer = null;
    };
    retryListener = ed.onDidLayoutChange(() => {
      stopRetry();
      doReveal();
    });
    retryTimer = setTimeout(stopRetry, 1000);
    editorDisposablesRef.current.push({ dispose: stopRetry });
  };

  /** Re-apply a view state that was restored at MOUNT, once the editor has a
   *  real layout.
   *
   *  A mount-time restore is applied to a widget the library has just created
   *  while its container was still effectively un-laid-out (it is `display:
   *  none` until `create()` returns, and Monaco's first layout then runs on a
   *  0-height box). A restore clamped in that window — or a top-of-file
   *  position stashed over the cache by the widget's own init/scroll events —
   *  is exactly the corruption the diff pane already guards against (see
   *  DiffPane's render-time snapshot): the file re-opens at the top instead of
   *  where the user left it. Re-applying the state on the first real layout
   *  change (plus one bounded timeout as a fallback) closes it here too.
   *
   *  Re-applying is idempotent — until the user scrolls, the cache holds what
   *  is already on screen, so a restore that landed correctly costs nothing.
   *  Any wheel / pointer / key input in the editor cancels the retries: a late
   *  restore must never drag the view back out from under the user. */
  const armMountReassert = (
    ed: editor.IStandaloneCodeEditor,
    path: string,
    saved: editor.ICodeEditorViewState,
  ) => {
    cancelMountReassertRef.current?.();
    const maybeDom = ed.getDomNode();
    // Without the DOM node there is no way to tell a user scroll from our own,
    // and a retry that can't be cancelled is worse than no retry at all.
    if (!maybeDom) return;
    // Re-bound as a non-nullable const so the hoisted helpers below can use it.
    const dom: HTMLElement = maybeDom;
    let layoutListener: { dispose(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Function declarations so the two can reference each other.
    function stop() {
      dom.removeEventListener("wheel", onIntent);
      dom.removeEventListener("pointerdown", onIntent);
      dom.removeEventListener("keydown", onIntent);
      layoutListener?.dispose();
      layoutListener = null;
      if (timer) clearTimeout(timer);
      timer = null;
      if (cancelMountReassertRef.current === stop) cancelMountReassertRef.current = null;
    }
    function onIntent() {
      stop();
    }
    const attempt = () => {
      if (disposedRef.current) return stop();
      // A file switch may land inside the retry window; a stale re-assert must
      // not drag the file now on screen to the previous file's position.
      if (readyCtxRef.current?.path !== path) return stop();
      // Re-seed first: the widget may refuse to move (still unmeasured), and
      // the repair must survive that so the next switch isn't top-of-file too.
      viewStateCache.set(path, saved);
      ed.restoreViewState(saved);
    };
    dom.addEventListener("wheel", onIntent, { passive: true });
    dom.addEventListener("pointerdown", onIntent);
    dom.addEventListener("keydown", onIntent);
    layoutListener = ed.onDidLayoutChange(() => attempt());
    timer = setTimeout(() => {
      attempt();
      stop();
    }, MOUNT_RESTORE_REASSERT_MS);
    cancelMountReassertRef.current = stop;
  };

  /** Swap the displayed model to `path` (a cache entry must exist — either a
   *  warm hit or just created by createAndShow). Runs the leave-bookkeeping
   *  for the previously displayed file: dispose its model when it has left
   *  its project's open list (the store skips exactly this file — it may
   *  still be attached to the live editor at action time), close its LSP
   *  document, drop a pending didChange (the didOpen below resends the full
   *  text anyway). */
  const flipTo = (path: string, forProjectPath: string) => {
    const prev = readyCtxRef.current;
    if (prev?.path === path) return;
    flipSeqRef.current += 1;
    saveSeqRef.current += 1;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    setSaveState("idle");
    if (prev) {
      const open = prev.pid
        ? useSessionStore.getState().ideOpenFilesByProject[prev.pid]
        : undefined;
      if (!open || !open.includes(prev.path)) {
        disposeModel(prev.path);
        ideDirtyTracker.set(prev.path, false);
      }
      if (prev.projectPath) void closeLspDocument(prev.projectPath, prev.path);
      if (changeDebounceRef.current) {
        clearTimeout(changeDebounceRef.current);
        changeDebounceRef.current = null;
      }
    }
    readyCtxRef.current = {
      path,
      projectPath: forProjectPath,
      pid: useSessionStore.getState().activeProjectId,
    };
    setDisplayedPath(path);
    setExternalChange(false);
    setReadyPath(path);
  };

  /** First-time display of a file with no cached model: create the model
   *  from the freshly-read content, then swap. The loader may still be
   *  resolving — park the request and let the flush effect finish it. */
  const createAndShow = (path: string, content: string, forProjectPath: string) => {
    if (disposedRef.current) return;
    const monaco = monacoInstanceRef.current;
    if (!monaco) {
      pendingCreateRef.current = { path, content, projectPath: forProjectPath };
      return;
    }
    adoptModel(monaco, path, content);
    skipVerifyPathRef.current = path;
    setLoadingPath(null);
    flipTo(path, forProjectPath);
  };

  // Follow filePath (runs on every file switch): cached model → swap
  // immediately; otherwise read the file, create the model, then swap. Until
  // then the editor keeps displaying the previous file — no spinner, no
  // teardown.
  useEffect(() => {
    if (!filePath) return;
    if (readyCtxRef.current?.path === filePath) {
      // Same file, but its project may have changed underneath (rare) —
      // keep the LSP/workspace context in sync.
      if (readyCtxRef.current.projectPath !== projectPath) {
        readyCtxRef.current = { ...readyCtxRef.current, projectPath };
      }
      return;
    }
    const seq = ++readSeqRef.current;
    if (getModelEntry(filePath) && !isMarkdown(filePath) && !textFileWrites.hasPending(filePath)) {
      setLoadingPath(null);
      flipTo(filePath, projectPath);
      return;
    }
    setLoadingPath(filePath);
    textFileWrites.waitForPending(filePath)
      .then(() => api.file.readFile({ filePath }))
      .then(({ content }) => {
        if (seq !== readSeqRef.current || disposedRef.current) return;
        const cached = getModelEntry(filePath);
        if (cached && !cached.model.isDisposed()) {
          // Rich Markdown edits may have landed after this source model was
          // cached. Never expose stale clean text (or overwrite dirty text).
          if (content !== cached.baseline) {
            if (ideDirtyTracker.has(filePath)) {
              flipTo(filePath, projectPath);
              setExternalChange(true);
              setLoadingPath(null);
              return;
            }
            cached.model.setValue(content);
            updateBaseline(filePath, content);
            ideDirtyTracker.set(filePath, false);
          }
          flipTo(filePath, projectPath);
          setLoadingPath(null);
          return;
        }
        createAndShow(filePath, content, projectPath);
      })
      .catch(() => {
        if (seq !== readSeqRef.current || disposedRef.current) return;
        const cached = getModelEntry(filePath);
        if (cached && !cached.model.isDisposed()) {
          flipTo(filePath, projectPath); // keep cached edits if disk is unreadable
          setLoadingPath(null);
        } else {
          createAndShow(filePath, "", projectPath); // degrade to empty
        }
      });
  }, [filePath, projectPath]);

  // The loader resolved after a first-read completed — finish the parked
  // model creation + swap (only if the parked file is still the target; a
  // switch in the meantime just keeps the model cached).
  useEffect(() => {
    const p = pendingCreateRef.current;
    if (!monacoInstance || !p || disposedRef.current) return;
    pendingCreateRef.current = null;
    adoptModel(monacoInstance, p.path, p.content);
    if (p.path === filePath) {
      skipVerifyPathRef.current = p.path;
      setLoadingPath(null);
      flipTo(p.path, p.projectPath);
    }
  }, [monacoInstance, filePath]);

  // Post-swap bookkeeping for the newly displayed file: LSP provider
  // registration + didOpen, view-state restore, freshness verification,
  // pending reveal. Declared after the follow effect and running per
  // readyPath change, it executes AFTER the lib's child effects — i.e. after
  // the model swap has actually happened.
  useEffect(() => {
    if (!readyPath) return;
    const ctx = readyCtxRef.current;
    if (!ctx || ctx.path !== readyPath) return;
    const seq = flipSeqRef.current;
    const language = languageForExt(extname(readyPath));
    if (monacoRef.current) ensureLspProviders(monacoRef.current, language);
    // Open the document in the server (lazily starts the server if enabled).
    // If no server is enabled for this language, this is a silent no-op.
    if (ctx.projectPath) void openLspDocument(ctx.projectPath, readyPath, language);
    // Our eager-stashed view state wins over the lib's swap-time restore
    // (both hold the same data; ours is the more recent eager stash).
    const saved = viewStateCache.get(readyPath);
    if (saved) editorRef.current?.restoreViewState(saved);
    // Freshness verification (skipped when the model was just created from a
    // fresh read — its content IS the disk content).
    if (skipVerifyPathRef.current === readyPath) {
      skipVerifyPathRef.current = null;
    } else {
      api.file
        .readFile({ filePath: readyPath })
        .then(({ content: disk }) => {
          if (disposedRef.current || seq !== flipSeqRef.current) return;
          const entry = getModelEntry(readyPath);
          if (!entry || disk === entry.baseline) return;
          if (ideDirtyTracker.has(readyPath)) {
            setExternalChange(true);
          } else {
            try {
              entry.model.setValue(disk);
            } catch {
              return; // model disposed mid-flight
            }
            updateBaseline(readyPath, disk);
            ideDirtyTracker.set(readyPath, false);
          }
        })
        .catch(() => {
          // Unreadable — keep showing the current content.
        });
    }
    applyReveal();
  }, [readyPath]);

  // Goto-definition reveal: when the store has a pending reveal for the
  // DISPLAYED file, scroll to it and clear. Re-runs on the nonce bump (a
  // reveal into the already-displayed file); a reveal targeting a file that
  // is still loading is applied by the post-swap effect above once the swap
  // lands.
  useEffect(() => {
    applyReveal();
  }, [ideRevealNonce, idePendingReveal]);

  // Ctrl+S. Attached once for the editor's lifetime; the handler reads the
  // displayed-file context from a ref so it survives every model swap.
  const handleSave = useCallback(async () => {
    const ed = editorRef.current;
    const ctx = readyCtxRef.current;
    if (!ed || !ctx) return;
    const value = ed.getValue();
    const seq = ++saveSeqRef.current;
    setSaveState("saving");
    const ok = await useSessionStore.getState().saveFileContent(ctx.path, value);
    if (ok) {
      updateBaseline(ctx.path, value);
      // A user can keep typing while the IPC write is pending. The saved
      // snapshot becomes the baseline, but newer text must stay marked dirty.
      const model = getModelEntry(ctx.path)?.model;
      const stillDirty = model && !model.isDisposed() && model.getValue() !== value;
      if (model && !model.isDisposed()) ideDirtyTracker.set(ctx.path, Boolean(stillDirty));
      if (seq === saveSeqRef.current && !disposedRef.current && filePath === ctx.path && readyCtxRef.current?.path === ctx.path) {
        setSaveState(stillDirty ? "idle" : "saved");
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (!stillDirty) saveTimerRef.current = setTimeout(() => setSaveState("idle"), 1500);
      }
      // Tell the LSP server the file was saved (best-effort).
      if (ctx.projectPath) {
        void notifyLspSave(ctx.projectPath, ctx.path, languageForExt(extname(ctx.path)), value);
      }
    } else {
      if (seq === saveSeqRef.current && !disposedRef.current && filePath === ctx.path && readyCtxRef.current?.path === ctx.path) {
        setSaveState("error");
      } else if (disposedRef.current || filePath !== ctx.path || readyCtxRef.current?.path !== ctx.path) {
        useToastStore.getState().push({ kind: "error", title: t("ide.editor.saveFailed"), body: ctx.path });
      }
    }
  }, [filePath, t]);
  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  // Reload from disk after an external change was detected while the model
  // held unsaved edits — the user explicitly chose to discard them.
  const reloadFromDisk = useCallback(() => {
    setExternalChange(false);
    const ctx = readyCtxRef.current;
    if (!ctx) return;
    void api.file
      .readFile({ filePath: ctx.path })
      .then(({ content: disk }) => {
        try {
          getModelEntry(ctx.path)?.model.setValue(disk);
        } catch {
          return; // model disposed — nothing to refresh
        }
        updateBaseline(ctx.path, disk);
        ideDirtyTracker.set(ctx.path, false);
      })
      .catch(() => {
        // Unreadable — keep the current content.
      });
  }, []);

  // Theme: follow the .dark class on <html>.
  const theme = useMonacoTheme();

  // Monaco passes its monaco namespace into onMount, which is where we
  // register Ctrl+S (once for the editor's lifetime) and the LSP providers.
  const handleEditorMount = (editor_: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
    editorRef.current = editor_;
    monacoRef.current = monaco;
    editor_.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSaveRef.current();
    });

    // Register LSP providers for the first displayed language (idempotent —
    // once per language id globally). The post-swap effect re-runs this on
    // every model swap so a language change across files stays covered.
    const mountPath = readyCtxRef.current?.path;
    if (mountPath) ensureLspProviders(monaco, languageForExt(extname(mountPath)));

    /**
     * **选中文字 → 弹引用条**（见 `readMonacoSelection` 那段的长注释）。
     *
     * 为什么是「鼠标状态 + 选区变化」两件事合起来判：
     *  - `onDidChangeCursorSelection` 在**拖选的过程中**也会连发（每移一格一次），
     *    只看它会让浮层闪个不停；
     *  - 而 Monaco 的选区**松手后还留着**，只在别处点一下才没。
     *
     * 所以：拖选期间（`draggingRef`）不亮；松手后（`mouseup`）再读一次；
     * 之后每次选区变化（键盘选、双击选词、Ctrl+A）也读一次。
     */
    const domNode = editor_.getDomNode();
    const onDragStart = () => {
      draggingRef.current = true;
    };
    const onDragEnd = () => {
      draggingRef.current = false;
      setMdSel(readMonacoSelection());
    };
    domNode?.addEventListener("mousedown", onDragStart);
    // 松手可能落在编辑器外面（拖到别处松开）—— 挂到 window 上才收得到。
    window.addEventListener("mouseup", onDragEnd);

    const selSub = editor_.onDidChangeCursorSelection(() => {
      if (draggingRef.current) return; // 拖选中：等松手（见上）
      setMdSel(readMonacoSelection());
    });

    // 编辑器被点失焦 / 内容被替换时，旧选区就不该再挂着浮层了。
    const blurSub = editor_.onDidBlurEditorWidget(() => {
      setMdSel(null);
      setMdQuote(null);
    });

    // 组件卸载时拆干净（Monaco 的 listener 不拆会一直持有闭包）。
    unmountCleanupsRef.current.push(() => {
      domNode?.removeEventListener("mousedown", onDragStart);
      window.removeEventListener("mouseup", onDragEnd);
      selSub.dispose();
      blurSub.dispose();
    });

    // Restore the scroll position / cursor from a previous visit of this
    // file (stashed eagerly by the listeners below). A pending goto-def
    // reveal still wins — applyReveal() below runs after this and
    // re-positions. A restore that this brand-new widget clamps (its container
    // has not been laid out yet) is re-applied by armMountReassert once the
    // layout is real — otherwise a file re-opened after the editor column was
    // remounted lands back at the top.
    if (mountPath) {
      const saved = viewStateCache.get(mountPath);
      if (saved) {
        editor_.restoreViewState(saved);
        armMountReassert(editor_, mountPath, saved);
      }
    }

    // Stash the view state eagerly on every scroll / selection change. Paths
    // are resolved from readyCtxRef at event time, so these listeners
    // outlive individual file swaps for the editor's whole life.
    const stashViewState = () => {
      const p = readyCtxRef.current?.path;
      const vs = editor_.saveViewState();
      if (p && vs) viewStateCache.set(p, vs);
    };
    // Track the primary cursor alongside the view state (lib/editorNav): the
    // store's navigation-history actions read it to snapshot the OUTGOING
    // location when the user navigates away (Alt+← back target).
    const stashCursor = () => {
      const p = readyCtxRef.current?.path;
      const pos = editor_.getPosition();
      if (p && pos) setLastCursor(p, { line: pos.lineNumber, column: pos.column });
    };
    // Seed the cursor now (post view-state restore) so a file opened for
    // the first time this session still has a known location.
    stashCursor();
    editorDisposablesRef.current.push(
      editor_.onDidScrollChange(stashViewState),
      editor_.onDidChangeCursorSelection(() => {
        stashViewState();
        stashCursor();
      }),
    );

    // Apply a pending goto-def reveal now that the editor is ready. Needed
    // for cross-file jumps: the reveal effect runs with editorRef still null
    // (onMount hasn't fired), so we must re-check here.
    applyReveal();
  };

  // LSP diagnostics subscription: applies publishDiagnostics markers to the
  // DISPLAYED file's model; re-subscribes (and clears the old file's
  // markers) when the displayed file changes.
  useLspDiagnostics(
    readyPath ?? filePath,
    () => monacoRef.current,
    () => editorRef.current,
  );

  // Final teardown — the editor column went away (focus moved to chat / no
  // active file / mode switched to diff or preview). Model-cache ownership
  // for the last displayed file: dispose when it has left its project's open
  // list; keep it cached otherwise (with unsaved edits + token cache) for an
  // instant remount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
      cancelMountReassertRef.current?.();
      editorDisposablesRef.current.forEach((d) => d.dispose());
      editorDisposablesRef.current = [];
      const ctx = readyCtxRef.current;
      if (ctx) {
        const open = ctx.pid
          ? useSessionStore.getState().ideOpenFilesByProject[ctx.pid]
          : undefined;
        if (!open || !open.includes(ctx.path)) {
          disposeModel(ctx.path);
          ideDirtyTracker.set(ctx.path, false);
        }
        if (ctx.projectPath) void closeLspDocument(ctx.projectPath, ctx.path);
      }
      setDisplayedPath(null);
    };
  }, []);

  // Before the very first model is ready there is nothing to display.
  if (!readyPath) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingFile")}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <Editor
        height="100%"
        path={filePathToUri(readyPath)} // model URI = canonical file:// URI (matches LSP server)
        language={languageForExt(extname(readyPath))}
        theme={theme}
        // The lib never syncs content (no `value` prop) and never disposes
        // models on unmount — the model cache owns both jobs. File switches
        // land here as a model swap on the live widget.
        keepCurrentModel
        onChange={(value) => {
          const ctx = readyCtxRef.current;
          if (!ctx) return;
          const v = value ?? "";
          // Dirty if content diverges from the cached baseline (the content
          // the model was loaded/saved with).
          const baseline = getBaseline(ctx.path);
          ideDirtyTracker.set(ctx.path, baseline !== undefined ? v !== baseline : false);
          // Notify the LSP server of the change (debounced). The server needs
          // the full text (incremental sync isn't worth the complexity here).
          if (ctx.projectPath) {
            if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
            lspVersionRef.current += 1;
            const version = lspVersionRef.current;
            const { projectPath: pp, path: p } = ctx;
            changeDebounceRef.current = setTimeout(() => {
              void notifyLspChange(pp, p, languageForExt(extname(p)), v, version);
            }, 300);
          }
        }}
        onMount={handleEditorMount}
        loading={<div className="text-[11px] text-content-subtle">{t("ide.editor.loadingEditor")}</div>}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          automaticLayout: true,
          renderWhitespace: "selection",
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
      {/* Hold-last-ready veil: a first-time file is still being read — the
          previous file stays visible (and interactive) underneath. */}
      {loadingPath && loadingPath !== readyPath && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/70">
          <div className="flex items-center gap-1.5 text-[11px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            {t("ide.editor.readingFile")}
          </div>
        </div>
      )}
      {/* External-change banner (top-center): the file changed on disk while
          the cached model held unsaved edits. Reload discards them. */}
      {externalChange && (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1 text-[11px] shadow-sm">
          <IconAlertTriangle size={12} className="shrink-0 text-content-muted" />
          <span className="text-content-muted">{t("ide.editor.externalChanged")}</span>
          <button
            type="button"
            onClick={reloadFromDisk}
            className="rounded px-1.5 py-0.5 text-accent transition-colors hover:bg-surface-hover"
          >
            {t("ide.editor.reloadFromDisk")}
          </button>
        </div>
      )}
      {/* Save status toast — bottom-right, non-blocking. */}
      {saveState !== "idle" && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] shadow-sm",
            saveState === "saving" && "bg-surface text-content-muted",
            saveState === "saved" && "bg-accent/15 text-accent",
            saveState === "error" && "bg-danger/15 text-danger",
          )}
        >
          {saveState === "saving" && <IconLoader2 size={11} className="animate-spin" />}
          {saveState === "saved" && <span>{t("ide.editor.savedToast")}</span>}
          {saveState === "error" && (
            <>
              <IconAlertTriangle size={11} />
              {t("ide.editor.saveFailed")}
            </>
          )}
          {saveState === "saving" && t("ide.editor.saving")}
        </div>
      )}
      {/* LSP goto activity pill — bottom-center, non-blocking. */}
      <GotoActivityPill />

      {/* ── 选中文字 → 引用条（2026-09-21）─────────────────────────────
          与 `ChatPane` / `FileViewer` 里那两处**同一套组件**（`SelectionToolbar`
          + `SelectionQuoteMenu`），只是选区来源换成 Monaco 的 API。

          两个按钮都不给：书签靠 `messageId` 定位（编辑器里没有消息），
          "问侧边"与"引用给某条"在这里是同一件事（同 `FileViewer` 的取舍）。 */}
      {mdSel && !mdQuote && (
        <SelectionToolbar
          state={mdSel}
          onQuote={(s) => setMdQuote(s)}
          onClose={() => setMdSel(null)}
        />
      )}
      {mdQuote && (
        <SelectionQuoteMenu
          state={mdQuote}
          // 编辑器这里没有"当前会话"这个概念（用户可能还没开任何对话），
          // 所以给空串 —— `SelectionQuoteMenu` 明确支持这种用法，列出来的
          // 就是"打开着的对话 + 它的节点会话"（同 `FileViewer` 那一处）。
          sessionId=""
          currentTitle={t("ide.editor.thisFile")}
          onPick={quoteFromEditor}
          onClose={() => {
            setMdQuote(null);
            setMdSel(null);
          }}
        />
      )}
    </div>
  );
}

/* ──────────────────────── LSP goto activity pill ──────────────────────── */

/** Kind → label-key map for the goto pill (module-level for stable refs;
 *  `satisfies` keeps the values checkable against the i18n dictionaries). */
const GOTO_KIND_LABEL_KEY = {
  definition: "ide.editor.gotoKind.definition",
  implementation: "ide.editor.gotoKind.implementation",
  references: "ide.editor.gotoKind.references",
} as const satisfies Record<GotoKind, MessageId>;

/** Delay before a PENDING pill appears — warm sub-250ms responses shouldn't
 *  flash UI on every F12. Terminal states bypass the delay (they linger only
 *  ~1.8s, and "未找到实现" is worth showing even for fast queries). */
const GOTO_PILL_DELAY_MS = 250;
/** Show the elapsed-seconds counter once a query runs at least this long. */
const GOTO_ELAPSED_THRESHOLD_SEC = 3;

/** Floating goto-activity pill for the edit pane: a spinner + "正在查找实现…"
 *  while an LSP navigation query (F12 / Ctrl+F12 / Shift+F12) is in flight,
 *  then a brief "未找到实现" / failure notice when it lands. Cold servers
 *  (spawn + initialize + tsserver project load) can take seconds, and the
 *  cross-file path returns null to Monaco — without this pill the user has
 *  no idea whether anything is happening. */
function GotoActivityPill() {
  const { t } = useI18n();
  const activities = useLspGotoActivities();
  const latest = activities.length > 0 ? activities[activities.length - 1] : null;

  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!latest || latest.state !== "pending") {
      setVisible(!!latest);
      return;
    }
    setVisible(false);
    const timer = setTimeout(() => setVisible(true), GOTO_PILL_DELAY_MS);
    return () => clearTimeout(timer);
    // Re-run when the driving activity changes (new query / state flip / the
    // lingering terminal entry dropping out of the snapshot).
  }, [latest?.id, latest?.state]);

  // Tick once per second while a pending pill is visible so the
  // elapsed-seconds counter updates.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const pending = latest?.state === "pending";
  useEffect(() => {
    if (!pending || !visible) return;
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [pending, visible]);

  if (!visible || !latest || latest.state === "done") return null;
  const elapsedSec = Math.floor((Date.now() - latest.startedAt) / 1000);
  const kind = t(GOTO_KIND_LABEL_KEY[latest.kind]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11px] shadow-sm",
        latest.state === "pending" && "bg-surface text-content-muted",
        latest.state === "empty" && "bg-surface text-content-subtle",
        latest.state === "error" && "bg-danger/15 text-danger",
      )}
    >
      {latest.state === "pending" && (
        <>
          <IconLoader2 size={11} className="animate-spin" />
          {t("ide.editor.gotoSearching", { kind })}
          {elapsedSec >= GOTO_ELAPSED_THRESHOLD_SEC && (
            <span className="text-content-subtle">{elapsedSec}s</span>
          )}
        </>
      )}
      {latest.state === "empty" && <span>{t("ide.editor.gotoNoneFound", { kind })}</span>}
      {latest.state === "error" && (
        <span className="max-w-[420px] truncate" title={latest.message}>
          {t("ide.editor.gotoFailed", { kind })}
        </span>
      )}
    </div>
  );
}

/* ───────────────────────── Markdown preview ───────────────────────── */

/** Read-only rendered Markdown preview for `.md` files. Loads the file content
 *  via the same `file.readFile` API as EditPane, then renders it with the chat
 *  Markdown renderer (Shiki code highlighting, GFM, math). The outer container
 *  overrides `--chat-font-size` so the rendered text uses an editor-appropriate
 *  size instead of the chat bubble size. Read-only - no save / dirty tracking.
 *  Re-reads on filePath change.
 *
 *  ## 长文是**分段滚动加载**的（2026-09-22）
 *
 *  用户的原话：「现在的 md 是直接全部加载的，改成滚动加载，看到哪里就提前加载那
 *  附近的几页」。从前这里把正文整篇塞进一个 `<Markdown>`，一篇长 README 或转录
 *  打开的一瞬间全部解析 + 全部进 DOM。
 *
 *  现在交给 `ChunkedMarkdown`：按空行切段、滚到附近才渲染下一段。容器仍然**是
 *  这个 `scrollRef`**（滚动记忆挂它上面），所以给的是 `scroll="parent"` —— 让它
 *  在这儿挂哨兵，而不是自己再套一层（那层不滚，哨兵就永远不触发）。 */
function MarkdownPreviewPane({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null); // null = loading
  // The preview pane is a plain scroll container that unmounts on every file
  // switch (and re-mounts its body on every content read), so without this a
  // long README the user had scrolled re-opened at the top. Monaco's own
  // view-state cache doesn't cover this pane - it has no model.
  const scrollRef = useScrollMemory(`ide-preview:${filePath}`);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    textFileWrites.waitForPending(filePath)
      .then(() => api.file.readFile({ filePath }))
      .then(({ content }) => {
        if (!cancelled) setContent(content);
      })
      .catch(() => {
        if (!cancelled) setContent(""); // degrade to empty
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingFile")}
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto bg-surface px-6 py-4 [--chat-font-size:13px]"
    >
      <ChunkedMarkdown
        scroll="parent"
        text={content}
        projectPath={projectPath}
        baseDir={dirname(filePath) || projectPath}
      />
    </div>
  );
}

/* ───────────────────────── Image preview ───────────────────────── */

/** Read-only image preview. Fetches the file as a base64 `data:` URL via the
 *  `file.readBinary` IPC (the main process reads the bytes and enforces the
 *  project-root path guard), then renders it in an `<img>`. Centered, with a
 *  checkerboard backdrop so transparent PNGs read clearly. Zoom-to-fit by
 *  default; clicking toggles 1:1 (natural size) with scroll.
 *
 *  Uses a data URL (not a custom protocol or `file://`) so it works under the
 *  production CSP (`img-src 'self' data:`) with no extra privilege grants.
 *  No dirty tracking - images are read-only. */
/**
 * 中间栏里的 PDF —— 双击文件树里一个 `.pdf` 落到这里（单击走的是 `FileViewer`
 * 那条预览路）。
 *
 * ## 为什么自己也读一遍字节,而不是把 id 丢给 `PdfPreview`
 *
 * `PdfPreview` 有两条取数路：**调用方给了 `bytes` 就用它**；不给才回退
 * `library.readPdf({ id })` —— 而**那条只认文献库的条目 id**。项目文件没有条目 id,
 * 回退必然失败。用户报的「左边栏点击 pdf 文件不打开」正是这个形状（`FileViewer`
 * 那边 2026-09-21 修过同一处）。
 *
 * 所以这里**必须**自己读字节再传进去。读的是 `api.file.readBinary` —— 与
 * `ImagePreviewPane` 和 `FileViewer` 的项目文件那一支**同一个 IPC**,不新开通道。
 */
function PdfPreviewPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  // null = 还在读, 内存 = 拿到了(读失败给空数组,交给 PdfPreview 自己报)
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    api.file
      .readBinary({ filePath })
      .then(({ dataUrl }) => {
        if (cancelled) return;
        // data URL → 字节。大 PDF 十几 MB,这一步是一次 base64 解码,值得。
        const comma = dataUrl.indexOf(",");
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        // data URL → 字节。这几行与 `FileViewer` / `FilePreview` 里那两份私有实现
        // 是同一个算法（它们各自写了一份，见仓库硬规矩第 2 条的反面教材）—— 这里
        // 不再抄第三份，只用一次所以干脆内联。
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        setBytes(out);
      })
      .catch(() => {
        // 读不动就交一个空数组进去 —— `PdfPreview` 那边会报"加载失败",比这里
        // 自己画一块空白强(它有重试按钮)。
        if (!cancelled) setBytes(new Uint8Array());
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (bytes === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  // `item` 只要 `{ id }`。项目文件没有条目 id,给空串 —— `bytes` 在,那个字段
  // 根本不会被用到（见上面"为什么自己也读一遍字节"）。
  //
  // ⚠️ **外面这层 `h-full` 是必须的。** `PdfPreview` 最外层是
  // `relative flex h-full flex-col`,它按**容器的 clientWidth** 算"适应宽度"
  // （`currentScaleValue = "page-width"`）,并且 pdf.js 构造时直接断言那个滚动容器
  // 必须是 absolute。父级高度塌了 → 宽度算成 0 → 比例极小,表现就是"默认不适合宽度、
  // 点那个按钮也没反应"（2026-09-21 用户报的正是这个）。
  //
  // `FileViewer` 那边为此专门写了"**不多包任何一层 div**"（见它 render 那段注释）——
  // 而 `FileEditor` 的渲染分支外面本来就有一层 `min-h-0 flex-1`,所以这里**必须**
  // 自己补上 `h-full` 才能把高度传下去。
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <PdfPreview item={{ id: "" }} bytes={bytes} filePath={filePath} />
      </div>
    </div>
  );
}

/**
 * Office 文档的**只读预览**档：docx → `docx-preview`、xlsx → `@js-preview/excel`、
 * pptx → `pptx-preview`（三个都是已经在右栏 `FilePreview` 里用着的现成组件）。
 * 字节走 `file.readBinary`，与 `PdfPreviewPane` 同一条路、同一个 data URL → 字节的算法。
 */
function OfficePreviewPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setErr(null);
    api.file
      .readBinary({ filePath })
      .then(({ dataUrl }) => {
        if (cancelled) return;
        const comma = dataUrl.indexOf(",");
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        setBytes(out);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (err) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <span className="text-xs text-red-500">{err}</span>
      </div>
    );
  }
  if (bytes === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  const openExternal = () => void api.shell.openFile({ path: filePath });
  const ext = extname(filePath);
  const name = basename(filePath);
  const inner =
    ext === ".xlsx" || ext === ".xlsm" || ext === ".xltx" || ext === ".ods" || ext === ".csv" ? (
      <XlsxPreview data={bytes} relPath={filePath} onOpenExternal={openExternal} />
    ) : ext === ".pptx" || ext === ".pptm" || ext === ".potx" || ext === ".odp" ? (
      <PptxPreview data={bytes} relPath={filePath} onOpenExternal={openExternal} />
    ) : (
      <DocxPreview data={bytes} relPath={name} onOpenExternal={openExternal} />
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">{inner}</div>
    </div>
  );
}

function ImagePreviewPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [natural, setNatural] = useState(false);
  // null = loading, "" = error/empty, non-empty = valid data URL
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setNatural(false);
    api.file
      .readBinary({ filePath })
      .then(({ dataUrl: url }) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Loading state.
  if (dataUrl === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingImage")}
      </div>
    );
  }
  // Error / empty (refused or unreadable).
  if (!dataUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconPhotoOff size={32} className="text-content-subtle" />
        <p className="text-[12px] font-medium text-content-muted">{t("ide.editor.imageLoadFailed")}</p>
        <p className="max-w-[320px] text-[11px] leading-relaxed text-content-subtle">
          {t("ide.editor.imageLoadFailedDesc")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-auto bg-surface"
      style={{
        backgroundImage:
          "linear-gradient(45deg, var(--color-surface-muted) 25%, transparent 25%), linear-gradient(-45deg, var(--color-surface-muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-surface-muted) 75%), linear-gradient(-45deg, transparent 75%, var(--color-surface-muted) 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
      }}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center p-6"
        onClick={() => setNatural((n) => !n)}
        title={natural ? t("ide.editor.imageFitHint") : t("ide.editor.imageNaturalHint")}
      >
        <img
          src={dataUrl}
          alt={filePath}
          className={cn(
            "transition-shadow",
            natural ? "cursor-zoom-out" : "cursor-zoom-in",
            "max-h-full max-w-full object-contain shadow-lg",
          )}
          style={natural ? { maxHeight: "none", maxWidth: "none" } : undefined}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── Unsupported-file pane ───────────────────────── */

/** Friendly "can't preview" pane for binary file types the editor can't handle
 *  (Office docs, archives, binaries, audio/video, fonts, PDF). Shows the file
 *  type, a short explanation, and an "open externally" hint. Read-only, no
 *  Monaco - loading these as utf-8 would show garbled bytes. */
function UnsupportedPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const ext = extname(filePath).replace(/^\./, "").toUpperCase() || t("ide.editor.unknownExt");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconPhotoOff size={28} />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-content">
          {t("ide.editor.cannotPreview", { ext })}
        </p>
        <p className="max-w-[360px] text-[11px] leading-relaxed text-content-subtle">
          {t("ide.editor.unsupportedDesc")}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void api.shell.openFile({ path: filePath })}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface px-3 py-1.5 text-[12px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        title={t("ide.editor.openInSystemHint")}
      >
        {t("ide.editor.openInSystem")}
      </button>
    </div>
  );
}

/* ───────────────────────── Diff pane ───────────────────────── */

/** Side-by-side diff: `before` vs `after` (or current on-disk content when
 *  `after` is omitted). Read-only — the diff is for review, not editing.
 *
 *  Uses `keepCurrentOriginalModel` / `keepCurrentModifiedModel` and a manual
 *  onMount cleanup to avoid the "TextModel got disposed before
 *  DiffEditorWidget model got reset" error. The @monaco-editor/react library's
 *  default unmount disposes the TextModels BEFORE the DiffEditorWidget, which
 *  triggers the widget's model-change listener on an already-disposed model.
 *  By keeping the models alive past the widget's disposal, we break that race.
 *  We then dispose the models ourselves in the correct order (widget first,
 *  then models) via the onMount ref. */
export function DiffPane({
  filePath,
  before,
  after,
}: {
  filePath: string;
  before: string;
  /** Explicit modified-side content (history commits). When omitted the pane
   *  reads the working-tree file from disk. */
  after?: string;
}) {
  const { t } = useI18n();
  const [modified, setModified] = useState<string | null>(after ?? null);
  const theme = useMonacoTheme();
  const language = languageForExt(extname(filePath));
  // Stash the editor + monaco instances so we can dispose in the right order
  // on unmount (widget first, then models).
  const editorRef = useRef<import("monaco-editor").editor.IDiffEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  // The diff's two sides are ANONYMOUS Monaco models (inmemory://model/N) —
  // kept in state so the LSP binding effect re-runs once the DiffEditor has
  // actually mounted (onMount) and whenever a file switch recreates them.
  const [diffModels, setDiffModels] = useState<{
    original: import("monaco-editor").editor.ITextModel;
    modified: import("monaco-editor").editor.ITextModel;
  } | null>(null);

  // ── Scroll-position persistence (per file, mirrors EditPane's cache) ──
  // Latest-ref mirror of filePath: the stash/restore listeners below attach
  // to the widget's sub-editors in onMount and outlive file switches (the
  // widget only remounts when a working-tree read flashes the loading veil),
  // so they must resolve the file being VIEWED at event time.
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  // Snapshot of the INCOMING file's cached view state, taken at render time —
  // before the library's content-swap effects run (child effects precede the
  // parent's, and their setValue resets scroll, which would otherwise stash
  // the reset position over the cache entry). Every restore re-seeds the
  // cache from this snapshot first, so swap-time corruption is repaired; the
  // snapshot is replaced on the next switch/mount. Two corruption windows
  // exist: ① the library setValue's the two sides in DIFFERENT commits during
  // a live swap, and ② on a FRESH pane mount (the pane was unmounted while
  // another file was open in edit mode) the widget's init/layout events stash
  // a top-of-file position between onMount and the first restore. A "suppress
  // stash until settled" flag can't cover either (the windows span commits
  // with no stable edge); the snapshot sidesteps ordering entirely.
  const pendingRestoreRef = useRef<{
    original: editor.ICodeEditorViewState;
    modified: editor.ICodeEditorViewState;
  } | null>(null);
  // Null-initialized so the FIRST render of every pane instance also takes a
  // snapshot (a remount must repair ② — its cache entry is all it has).
  const prevFilePathRef = useRef<string | null>(null);
  if (prevFilePathRef.current !== filePath) {
    prevFilePathRef.current = filePath;
    pendingRestoreRef.current = diffViewStateCache.get(filePath) ?? null;
  }
  // Listener disposables of the CURRENT widget incarnation — replaced on
  // every onMount (remount) and disposed on unmount.
  const diffListenersRef = useRef<{ dispose(): void }[]>([]);
  // Set by the stash handler on every scroll, cleared on every successful
  // restore. The onDidUpdateDiff re-assertion only fires while this is false:
  // on a huge file the diff computation finishes long after the swap, and a
  // user scroll in that window must not be reverted by it.
  const dirtySinceRestoreRef = useRef(false);

  /** Re-apply the cached view state (both panes) for the file being viewed.
   *  Re-seeds the cache from the render-time snapshot first (repairing any
   *  reset-position stash the library's own setValue / the widget init
   *  produced during this switch or mount), then restores. Returns whether a
   *  restore actually landed on a live widget. Safe to call repeatedly —
   *  until the user scrolls again the cache holds exactly what's on screen,
   *  so re-restores are no-ops. */
  const restoreViewState = useCallback((): boolean => {
    const diffEditor = editorRef.current;
    const path = filePathRef.current;
    if (!diffEditor || !path) return false;
    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    // An incarnation mid-teardown (loading veil) still answers get*Editor()
    // but its models are gone — restoring into it is a no-op and must not
    // count as success (the caller would clear the pending snapshot).
    if (!originalEditor.getModel() || !modifiedEditor.getModel()) return false;
    const pending = pendingRestoreRef.current;
    if (pending) diffViewStateCache.set(path, pending);
    const cached = diffViewStateCache.get(path);
    if (!cached) return false;
    try {
      originalEditor.restoreViewState(cached.original);
      modifiedEditor.restoreViewState(cached.modified);
      dirtySinceRestoreRef.current = false;
      return true;
    } catch {
      // widget torn down mid-restore
      return false;
    }
  }, []);

  // Restore after every swap / mount / content change. Child effects (the
  // library's setValue) run first, so this always lands after any reset
  // stashes; onDidUpdateDiff re-asserts the position later — before the diff
  // is computed the widget's scroll sync is a flat 1:1 mapping, so the panes
  // can drift briefly until it lands. A run whose commit saw NO rendered
  // content change AND whose restore landed is a spurious re-run after the
  // swap fully settled (e.g. the diffModels state update right after a mount
  // or switch): the snapshot's job is done — clear it, or a later same-file
  // content change would restore the stale snapshot over the user's latest
  // scroll position. Mount-time runs (nothing swapped yet) and failed
  // restores (dead widget) keep it armed for the post-mount run.
  const prevSwapContentRef = useRef<{
    filePath: string;
    before: string;
    modified: string | null;
  } | null>(null);
  useEffect(() => {
    const prev = prevSwapContentRef.current;
    const swapped =
      prev === null ||
      prev.filePath !== filePath ||
      prev.before !== before ||
      prev.modified !== modified;
    prevSwapContentRef.current = { filePath, before, modified };
    const restored = restoreViewState();
    if (!swapped && restored) pendingRestoreRef.current = null;
  }, [filePath, before, modified, diffModels, restoreViewState]);

  useEffect(() => {
    // History pair: both sides are already known — don't touch the disk.
    if (after != null) {
      setModified(after);
      return;
    }
    let cancelled = false;
    setModified(null);
    textFileWrites.waitForPending(filePath)
      .then(() => api.file.readFile({ filePath }))
      .then(({ content }) => {
        if (!cancelled) setModified(content);
      })
      .catch(() => {
        if (!cancelled) setModified("");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, after]);

  // LSP navigation in the diff view (F12 / Ctrl+F12 / Shift+F12 / hover /
  // references peek): ① bind the anonymous models to the real file so
  // requests resolve to a file:// URI the server knows; ② didOpen the file
  // on the server (lazily starts it; the diff may be the FIRST editor
  // surface the user opens — e.g. 审查 on a turn-files card — before
  // EditPane has ever run). The workspace follows the providers' own routing
  // (selectActiveEnvPath, worktree-aware) so the doc and the queries land on
  // the same server. History diffs (`after != null`) query against the
  // on-disk file, so positions in heavily changed regions are approximate —
  // the same trade-off as any diff review surface; unchanged code navigates
  // exactly.
  useEffect(() => {
    if (!diffModels) return;
    bindModelToPath(diffModels.original, filePath);
    bindModelToPath(diffModels.modified, filePath);
    const envPath = selectActiveEnvPath(useSessionStore.getState());
    if (envPath) void openLspDocument(envPath, filePath, language);
    return () => {
      unbindModel(diffModels.original);
      unbindModel(diffModels.modified);
      if (envPath) void closeLspDocument(envPath, filePath);
    };
  }, [diffModels, filePath, language]);

  // On unmount: dispose this incarnation's listeners, then the widget FIRST,
  // then the models. This is the reverse of what the library does by default,
  // and avoids the listener race. (The view-state cache was already stashed
  // eagerly on every scroll — nothing to save here.)
  useEffect(() => {
    return () => {
      diffListenersRef.current.forEach((d) => d.dispose());
      diffListenersRef.current = [];
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (editor && monaco) {
        // Dispose the diff editor widget before touching its models so no
        // model-change listener fires on a disposed model.
        try {
          editor.dispose();
        } catch {
          // already disposed — ignore
        }
      }
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  if (modified === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingDiff")}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <DiffEditor
        height="100%"
        language={language}
        original={before}
        modified={modified}
        theme={theme}
        // Prevent the library from disposing models on unmount — we handle it
        // ourselves (widget first) to avoid the dispose-order race.
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        loading={<div className="text-[11px] text-content-subtle">{t("ide.editor.loadingDiff")}</div>}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          // Register the navigation providers for this language (idempotent)
          // and hand this mount's models to the LSP binding effect above.
          ensureLspProviders(monaco, language);
          const originalModel = editor.getOriginalEditor().getModel();
          const modifiedModel = editor.getModifiedEditor().getModel();
          if (originalModel && modifiedModel) {
            setDiffModels({ original: originalModel, modified: modifiedModel });
          }
          // Re-wire the scroll persistence listeners to THIS widget
          // incarnation (the previous incarnation's disposables are dead
          // after its unmount). Stashes are unconditional — the restore path
          // repairs any reset-position stash the widget init and the
          // library's own setValue produce during a switch or mount (see
          // pendingRestoreRef).
          diffListenersRef.current.forEach((d) => d.dispose());
          const stashViewState = () => {
            const path = filePathRef.current;
            const originalVs = editor.getOriginalEditor().saveViewState();
            const modifiedVs = editor.getModifiedEditor().saveViewState();
            dirtySinceRestoreRef.current = true;
            if (path && originalVs && modifiedVs) {
              diffViewStateCache.set(path, { original: originalVs, modified: modifiedVs });
            }
          };
          diffListenersRef.current = [
            editor.getOriginalEditor().onDidScrollChange(stashViewState),
            editor.getModifiedEditor().onDidScrollChange(stashViewState),
            // Re-assert the cached position once diffs are (re)computed: the
            // post-swap restore can land before the diff exists, while the
            // widget's two panes still scroll 1:1. Skipped when the user has
            // scrolled since the last restore — never revert their scroll.
            editor.onDidUpdateDiff(() => {
              if (!dirtySinceRestoreRef.current) restoreViewState();
            }),
          ];
        }}
        options={{
          readOnly: true,
          renderSideBySide: true,
          // Center column is often <900px (chat | editor split). Monaco's default
          // then collapses side-by-side into inline mode, which paints TWO line-
          // number gutters (original | modified) on a single pane — looks like a
          // duplicated 行号栏. Keep true side-by-side regardless of width.
          useInlineViewWhenSpaceIsLimited: false,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          // Slim gutters: no breakpoint glyph column, tighter line-number width.
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 3,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
      {/* LSP goto activity pill — bottom-center, non-blocking, same as the
          edit pane: a diff-pane F12 can take seconds on a cold server, and
          cross-file jumps hand off to the store, so the query needs visible
          feedback. */}
      <GotoActivityPill />
    </div>
  );
}

/* ───────────────────────── hooks & helpers ───────────────────────── */

/** Look up the active session's turn-files entry for `filePath`. Returns
 *  undefined if the file wasn't touched in the latest turn (no diff). */
function useTurnFileFor(filePath: string): TurnFileEntry | undefined {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? s.turnFilesBySession[activeSessionId] : undefined,
  );
  if (!turnFiles) return undefined;
  return turnFiles.find((f) => f.filePath === filePath);
}

/** Look up the active project's git-diff pair for `filePath`.
 *  Returns undefined if the Git panel hasn't stashed a diff for this file. */
function useGitDiffPair(
  filePath: string,
): { before: string; after?: string } | undefined {
  const pid = useSessionStore((s) => s.activeProjectId);
  const projMap = useSessionStore((s) =>
    pid ? s.gitDiffByProject[pid] : undefined,
  );
  return projMap?.[filePath];
}

/** Tracks the effective Monaco theme by watching the `.dark` class on <html>
 *  and layering the user's editor color-scheme choice (Settings → 外观) on
 *  top: dark mode renders the user's dark scheme, light mode their light one
 *  (defaults "mcode-dark" / "mcode-light"). Monaco can't react to CSS, so we
 *  explicitly switch its theme when the app theme flips.
 *
 *  The switch is deferred ~150ms after the class change so it lands as the
 *  CSS theme transition (styles.css .theme-transition, 180ms) finishes —
 *  flipping instantly would flash the old palette's editor while the chrome
 *  is still fading. The MutationObserver fires on every class change (the
 *  transition flag class too), so the timeout is re-armed each time; the
 *  final arm lands after the flip settles, which is exactly what we want. */
export function useMonacoTheme(): string {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      const isDark = el.classList.contains("dark");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDark(isDark), 150);
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);
  const darkScheme = useSessionStore((s) => s.editorTheme.dark);
  const lightScheme = useSessionStore((s) => s.editorTheme.light);
  return dark ? darkScheme : lightScheme;
}

/** True for `.pdf` —— 默认走预览、渲染分支走 `PdfPreviewPane`。
 *
 *  单独一个函数而不是在两处各写一遍 `extname(...) === ".pdf"`：默认档和渲染分支
 *  必须认**同一个**判据,不然会出现"默认进了预览、预览分支却不认它、掉进 markdown
 *  那一支"。 */
function isPdfFile(filePath: string): boolean {
  return extname(filePath) === ".pdf";
}

/** True for `.md` / `.markdown` files - gates the preview/edit toolbar toggle
 *  and the preview render branch. */
function isMarkdown(filePath: string): boolean {
  const ext = extname(filePath);
  return ext === ".md" || ext === ".markdown";
}

/** True for image files the editor can preview via the `app-resource://`
 *  protocol (binary files served from the main process). SVG is text but also
 *  renders as an image, so it's included. */
function isImage(filePath: string): boolean {
  switch (extname(filePath)) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".bmp":
    case ".ico":
    case ".webp":
    case ".svg":
    case ".tif":
    case ".tiff":
    case ".avif":
      return true;
    default:
      return false;
  }
}

/** True for binary file types the editor can neither edit (Monaco is text-only)
 *  nor meaningfully preview (no built-in renderer). These get a friendly
 *  "can't preview" pane instead of garbled Monaco content. Covers Office docs,
 *  archives, binaries, audio/video, and databases. */
function isUnsupported(filePath: string): boolean {
  switch (extname(filePath)) {
    // Office 老格式（DS 只能转换后查看，不能编辑；OOXML/ODF 的那些走 OnlyOffice，
    // 见 `isOnlyOfficeEditablePath`）
    case ".doc":
    case ".rtf":
    case ".xls":
    case ".ppt":
    // Archives
    case ".zip":
    case ".gz":
    case ".tar":
    case ".tgz":
    case ".rar":
    case ".7z":
    case ".bz2":
    case ".xz":
    // Binaries / compiled
    case ".exe":
    case ".dll":
    case ".so":
    case ".dylib":
    case ".bin":
    case ".class":
    case ".jar":
    case ".wasm":
    // Audio / video
    case ".mp3":
    case ".mp4":
    case ".webm":
    case ".avi":
    case ".mov":
    case ".ogg":
    case ".flac":
    case ".wav":
    case ".m4a":
    // Databases
    case ".db":
    case ".sqlite":
    case ".sqlite3":
    // Fonts
    case ".woff":
    case ".woff2":
    case ".ttf":
    case ".otf":
    case ".eot":
      return true;
    // ⚠️ **`.pdf` 从这条里拿掉了（2026-09-21）。** 这里从前写着
    // "PDF (no built-in viewer; could add one later)" 并 `return true` —— 而那句
    // 注释早就不成立了：`PdfPreview`（pdf.js 官方 viewer 组件）一直在，
    // `FileViewer` 也真的在用。于是**双击一个 pdf**（走 `openFileInIde` → 这个
    // 编辑器）会被当成"不支持的类型"退回纯文本,屏幕上是一屏 PDF 原始字节的乱码 ——
    // 用户的原话是「项目文件打开就是这个效果」。现在它归 `PdfPreviewPane` 管。
    default:
      return false;
  }
}

/** Map a file extension to a Monaco language id. Covers the common cases;
 *  unknown extensions fall back to plaintext (Monaco's default). */
export function languageForExt(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".html":
    case ".htm":
      return "html";
    case ".xml":
    case ".svg":
      return "xml";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "ini";
    case ".ini":
    case ".cfg":
    case ".conf":
      return "ini";
    case ".sql":
      return "sql";
    case ".dockerfile":
      return "dockerfile";
    case ".vue":
      return "html";
    default:
      return "plaintext";
  }
}
