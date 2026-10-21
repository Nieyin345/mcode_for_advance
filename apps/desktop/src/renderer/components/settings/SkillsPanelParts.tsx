/**
 * `SkillsPanel` 的**子组件与工具**（从 `SkillsPanel.tsx` 拆出）。
 *
 * ## 为什么拆
 *
 * `SkillsPanel.tsx` 原本 2369 行：主组件 `SkillsPanel`（1191 行）+ 一长串各自独立的
 * 子组件（源码编辑器 / 新建表单 / 导入对话框 / 徽标 …）。它们是独立渲染单元（AST 实测
 * 零闭包捕获），一起挂在一个文件末尾只是历史堆积。
 *
 * ## 判据
 *
 * 拆出去的东西**只依赖自己的 props 与模块级 import**。拆前已如此 —— 所以是**纯搬迁**，
 * 不改行为（函数体逐字节一致，见提交说明）。
 *
 * ## 网
 *
 * `scripts/skills-management-ui-smoke/` 在**真 Chromium** 里真渲染 `SkillsPanel`、真点真
 * 输入，断言编辑器文本框的 value/disabled/readOnly 等 —— 拆坏编辑器它就红。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import type { ExternalSkillInfo, SkillSource, SkillTool, SkillEngineState } from "@contracts/ipc";
import { Button, Dialog, EmptyState, ErrorNote, Field, InfoHint, LoadingNote, Spinner } from "@renderer/components/ui/index.js";
import { IconSparkles, IconFileText, IconFolder, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { moveTabFocus, isReadOnlySkill, type NewForm } from "@renderer/components/settings/SkillsPanel.js";
import { Textarea } from "@renderer/components/ui/textarea.js";
import { Input } from "@renderer/components/ui/input.js";
import { Checkbox } from "@renderer/components/ui/native-controls.js";

/** Source badge for a skill row / editor header. Single implementation so the
 *  list and the editor can never disagree about what a source is called —
 *  they each used to carry their own copy of the same ternary. */
export function SourceBadge({ source }: { source: SkillSource }) {
  const { t } = useI18n();
  const builtin = source === "builtin";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[9px] leading-tight",
        builtin ? "bg-info/12 text-info" : "bg-surface-hover text-content-subtle",
      )}
    >
      {builtin ? t("settings.skills.sourceBuiltin")
        : source === "project" ? t("settings.skills.sourceProject")
        : source === "plugin" ? t("settings.skills.groupPlugin") : t("settings.skills.sourceGlobal")}
    </span>
  );
}

/** Right-pane empty state — nothing selected. */
export function EmptyDetail() {
  const { t } = useI18n();
  return <EmptyState className="h-full" icon={IconSparkles} title={t("settings.skills.emptyDetail")} />;
}

/** Editor for an existing skill — engine matrix (universal skills) + raw
 *  SKILL.md source in a single textarea. */
export function SkillSourceEditor({
  skill,
  perEngine,
  pluginEngines,
  pluginName,
  onToggleEngine,
  engineBusy,
  content,
  loading,
  saving,
  mutationBusy,
  error,
  readError,
  onRetry,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  skill: { source: SkillSource; name: string };
  /** Resolved per-engine availability — present only for universal-library
   *  skills; absent (built-in) → the matrix is not rendered. */
  perEngine?: SkillEngineState;
  /** Plugin rows: the plugin-level switches; an engine off there greys the chip. */
  pluginEngines?: SkillEngineState;
  pluginName?: string;
  /** Toggle one engine's checkbox; the panel owns the RPC + state update. */
  onToggleEngine: (engine: keyof SkillEngineState) => void;
  engineBusy: boolean;
  content: string | null;
  loading: boolean;
  saving: boolean;
  mutationBusy: boolean;
  error: string | null;
  readError: string | null;
  onRetry: () => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  // Read-only skills (built-in, shipped in the app's resources) are shown but
  // not editable: the save/delete handlers reject them host-side, so offering
  // the buttons would only produce an error dialog. Computed from `skill`
  // rather than threaded in as a prop — there is exactly one reason to be
  // read-only and it's a property of the source.
  const readOnly = isReadOnlySkill(skill.source);
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <IconSparkles size={14} className="text-content-muted" />
          <span className="text-[0.8571em] font-medium text-content">/{skill.name}</span>
          <SourceBadge source={skill.source} />
        </div>
        <span className="text-[0.7143em] text-content-subtle">
          {readOnly ? t("settings.skills.builtinReadOnly") : t("settings.skills.rawSource")}
        </span>
      </div>
      {/* Per-engine matrix — universal-library AND plugin skills. Each toggle
          is an edit of .mcode-engines.json (files never move); all three
          enabled = 通用, exactly one = 引擎内部. Built-ins are app-shipped
          inventory and always offered, so they get no matrix. */}
      {perEngine && (
        <div className="mb-2 flex items-center gap-2 rounded border border-edge bg-surface/40 px-2.5 py-1.5">
          <span className="text-[0.7143em] font-medium text-content-muted">
            {t("settings.skills.engines")}
          </span>
          <div className="flex items-center gap-1" role="group" aria-label={t("settings.skills.engines")}>
            {(Object.keys(perEngine) as Array<keyof SkillEngineState>).map((engine) => {
              const on = perEngine[engine];
              const blocked = pluginEngines?.[engine] === false;
              const label = engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Pi";
              return (
                <Button variant="ghost" size={null}
                  key={engine}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={engineBusy}
                  onClick={() => onToggleEngine(engine)}
                  title={
                    blocked
                      ? t("settings.skills.pluginEngineOffNamed", { engine: label, plugin: pluginName ?? "" })
                      : on
                        ? t("settings.skills.engineOnHint", { engine })
                        : t("settings.skills.engineOffHint", { engine })
                  }
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
                    on && !blocked
                      ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70"
                      : "bg-surface-hover text-content-subtle line-through decoration-content-subtle/60",
                    blocked && "border border-dashed border-warning/60",
                  )}
                >
                  {engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Pi"}
                </Button>
              );
            })}
          </div>
          <span className="min-w-0 flex-1 truncate text-[10px] text-content-subtle">
            {t("settings.skills.enginesHint")}
          </span>
        </div>
      )}
      {readError ? (
        <ErrorNote action={<Button variant="ghost" onClick={onRetry}>{t("common.retry")}</Button>}>
          {readError}
        </ErrorNote>
      ) : loading ? (
        <LoadingNote label={t("common.loading")} />
      ) : (
        <Textarea
          data-testid="skill-source-input"
          aria-label={t("settings.skills.rawSource")}
          value={content ?? ""}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          readOnly={readOnly || mutationBusy}
          className={cn(
            "min-h-[300px] flex-1 resize-y rounded border border-edge px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
            readOnly ? "cursor-default bg-surface-muted/40" : "bg-surface",
          )}
          placeholder={t("settings.skills.sourcePlaceholder")}
        />
      )}
      {!loading && !readError && content === "" && (
        <ErrorNote tone="warning" className="mt-2">{t("settings.skills.emptySource")}</ErrorNote>
      )}
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      <div className="mt-2 flex items-center gap-2">
        {!readOnly && (
          <Button variant="danger" size="sm" onClick={onDelete} disabled={mutationBusy} title={t("settings.skills.deleteSkillTitle")}>
            <IconTrash size={12} />
            {t("common.delete")}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={mutationBusy}>
          {readOnly ? t("common.close") : t("common.cancel")}
        </Button>
        {!readOnly && (
          <Button variant="primary" size="sm" onClick={onSave} disabled={mutationBusy || loading || !!readError || content === null}>
            {saving ? t("settings.saving") : t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Structured form for creating a new skill (name / description / body).
 *  New skills always land in the universal library ~/.mcode/skills, enabled
 *  for every engine until the editor's matrix says otherwise. */
export function NewSkillForm({
  form,
  setForm,
  saving,
  error,
  onSave,
  onCancel,
}: {
  form: NewForm;
  setForm: React.Dispatch<React.SetStateAction<NewForm | null>>;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Functional updater - guards against null (the form is guaranteed non-null
  // while this component is mounted, but the setter type carries | null).
  const update = <K extends keyof NewForm>(key: K, value: NewForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const { t } = useI18n();
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <IconPlus size={14} className="text-accent" />
        <span className="text-[0.8571em] font-medium text-content">{t("settings.skills.newSkill")}</span>
        <InfoHint>
          {t("settings.skills.newSkillGlobalIntro1")}
          <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
          {t("settings.skills.newSkillGlobalIntro2")}
          <code className="rounded bg-surface-muted px-0.5">allowed-tools</code>
          {t("settings.skills.newSkillIntro3")}
        </InfoHint>
      </div>

      <Field
        className="mb-2"
        label={t("settings.skills.fieldName")}
        hint={
          <>
            {t("settings.skills.fieldNameHintPre")}
            <code className="rounded bg-surface-muted px-0.5">/name</code>
            {t("settings.skills.fieldNameHintPost")}
          </>
        }
      >
        <Input
          type="text"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="my-skill"
          className={inputCls}
          spellCheck={false}
          autoFocus
        />
      </Field>

      <Field className="mb-2" label={t("settings.skills.fieldDesc")}>
        <Input
          type="text"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder={t("settings.skills.descPlaceholder")}
          className={inputCls}
          spellCheck={false}
        />
      </Field>

      <Field className="mb-2" label={t("settings.skills.fieldBody")}>
        <Textarea
          value={form.body}
          onChange={(e) => update("body", e.target.value)}
          spellCheck={false}
          // w-full (not flex-1): Field wraps this in a block <label>, not a flex
          // container, so flex-1 was a no-op and the textarea fell back to its
          // default cols=20 width. w-full makes it fill the row like the other
          // inputs (which use inputCls with w-full).
          className={cn(
            "min-h-[200px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder={t("settings.skills.bodyPlaceholder")}
        />
      </Field>

      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
          {saving ? t("settings.saving") : t("settings.skills.createBtn")}
        </Button>
      </div>
    </div>
  );
}

const inputCls =
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";


/* ───────── Import Skills Dialog ───────── */

/** Human-readable labels for each external tool. */
const TOOL_LABELS: Record<SkillTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  zcode: "Zcode",
  local: "",
};

/** Tool badge color classes - each tool gets a distinct tint. */
const TOOL_BADGE_CLS: Record<SkillTool, string> = {
  "claude-code": "bg-accent/12 text-accent",
  codex: "bg-purple-500/15 text-purple-500",
  zcode: "bg-blue-500/15 text-blue-500",
  local: "bg-surface-hover text-content-muted",
};

/** Fixed tab order: the three external agents by install-base, then the local
 *  folder pseudo-source last (it's the "additional source" tab). */
const TOOL_ORDER: SkillTool[] = ["claude-code", "codex", "zcode", "local"];

/** Modal dialog for importing skills from external tools (Claude Code, Codex,
 *  Zcode) into Mcode's own ~/.mcode/skills directory. On open, scans all
 *  external sources; presents a TAB-PER-AGENT, checkbox-selectable list; and
 *  copies the selected skill directories on confirm. Skills already present
 *  at the destination are marked and excluded from selection.
 *
 *  The selection Set is GLOBAL across tabs (keyed by sourcePath), so picks
 *  accumulate as the user flips between agents; each tab badge shows its own
 *  selected count, and the footer shows the total. The "本地" tab always
 *  exists and hosts the folder picker (plus its scanned skills). */
export function ImportSkillsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<ExternalSkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);
  // User-picked local directory and/or single skill file (the "本地" tab's
  // "select folder" / "select file" flows). Both are independent scan sources
  // and may be combined; "清除" resets both.
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [localFile, setLocalFile] = useState<string | null>(null);
  // Which agent's tab is showing. Reset on open; falls back to the first tab
  // that actually has skills when the stored one has none (see `activeTool`).
  const [activeToolRaw, setActiveToolRaw] = useState<SkillTool>("claude-code");
  // GitHub package import ("贴链接进来,导出来就是一类"): the URL box sits above
  // the tab flow because it is an independent path — one repo, one bundle, no
  // per-skill picking. Result mirrors the local import's lists + bundle label.
  const [ghUrl, setGhUrl] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  // **同步**的提交闸 —— 这个导入由按钮点击**和** URL 框回车两条路进,而 `ghBusy`
  // 是异步生效的 React state:从 `setGhBusy(true)` 到重渲染之间有一小段窗口,回车键
  // 在这段里能再进一次 `doGithubImport`,发第二次 `importGithub`(会**再克隆一遍仓库**)。
  // 按钮的 `disabled` 挡不住回车,所以用 ref 同步拦一道(同 PluginsPanel 的 submittingRef)。
  const ghBusyRef = useRef(false);
  const [ghResult, setGhResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
    bundleLabel?: string;
    /** 【MC-053 同族】导入包清单损坏 → 导入成功但清单未被改写。 */
    corrupt?: string;
  } | null>(null);

  // Scan external sources whenever the dialog opens or the local folder changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setGhUrl("");
    setGhResult(null);
    if (localDir === null && localFile === null) setSelected(new Set());
    setExisting(new Set());
    setActiveToolRaw("claude-code");
    void (async () => {
      try {
        // Scan external tools (+ the picked local dir / file if any) and fetch
        // the current universal library to mark already-imported ones.
        const [scanRes, listRes] = await Promise.all([
          api.skills.scanSources({
            ...(localDir ? { localDir } : {}),
            ...(localFile ? { localFile } : {}),
          }),
          api.skills.list({}),
        ]);
        if (cancelled) return;
        setSources(scanRes.sources);
        const existingNames = new Set<string>();
        for (const s of listRes.skills) {
          if (s.source === "global") existingNames.add(s.name);
        }
        setExisting(existingNames);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // localDir/localFile are deps: picking a new folder/file re-scans with it.
  }, [open, localDir, localFile]);

  // Selection key is sourcePath (unique per skill per tool).
  const toggle = (sourcePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourcePath)) next.delete(sourcePath);
      else next.add(sourcePath);
      return next;
    });
  };

  // Group sources by tool for display.
  const grouped = sources.reduce<Record<SkillTool, ExternalSkillInfo[]>>(
    (acc, s) => {
      (acc[s.tool] ??= []).push(s);
      return acc;
    },
    {} as Record<SkillTool, ExternalSkillInfo[]>,
  );

  // Tabs: the three agents appear only when they have skills; "本地" is always
  // present (it hosts the folder picker). `activeTool` falls back to the first
  // non-empty tab when the stored one is empty, so the strip never lands on a
  // tab with nothing in it.
  const tabs = TOOL_ORDER.filter((tool) => tool === "local" || (grouped[tool]?.length ?? 0) > 0);
  const activeTool = tabs.includes(activeToolRaw) ? activeToolRaw : (tabs[0] ?? "local");
  const activeItems = grouped[activeTool] ?? [];

  // Select-all toggle for the active tab: adds every not-yet-present skill of
  // the tab, or clears them all when everything importable is already picked.
  const importableItems = activeItems.filter((s) => !existing.has(s.name));
  const allActiveSelected =
    importableItems.length > 0 && importableItems.every((s) => selected.has(s.sourcePath));
  const toggleSelectAllForActive = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allActiveSelected) {
        for (const s of importableItems) next.delete(s.sourcePath);
      } else {
        for (const s of importableItems) next.add(s.sourcePath);
      }
      return next;
    });
  };

  const selectedCount = selected.size;

  const doImport = async () => {
    if (selectedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = sources
        .filter((s) => selected.has(s.sourcePath))
        .map((s) => ({ sourcePath: s.sourcePath, name: s.name }));
      const res = await api.skills.import({ skills: items });
      setResult(res);
      setSelected(new Set());
      // Refresh the existing set so imported skills show as "already present".
      setExisting((prev) => {
        const next = new Set(prev);
        for (const name of res.imported) next.add(name);
        return next;
      });
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const close = () => {
    onOpenChange(false);
  };

  // Pick a local folder to scan for skills (in addition to the fixed external
  // tool dirs). Sets localDir → the open-effect re-scans with it, its skills
  // land in the "本地" tab, and we switch to that tab so the user immediately
  // sees what was found. Clearing selection first avoids stale picks pointing
  // at a folder that's no longer in the list.
  const pickLocalFolder = async () => {
    try {
      const { path: picked } = await api.pickFolder();
      if (!picked) return; // user cancelled
      setSelected(new Set());
      setLocalDir(picked);
      setActiveToolRaw("local");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Pick a single skill FILE (the "select file" flow): the markdown file IS
  // the SKILL.md body; importing materializes it as <name>/SKILL.md. Uses the
  // generic multi-file picker (first selection). Markdown-only is pre-checked
  // here so the user sees an error instead of a silent no-op from the scan
  // (main skips non-.md files defensively).
  const pickLocalFile = async () => {
    try {
      const { paths } = await api.pickFiles({ title: t("settings.skills.chooseFile") });
      const picked = paths[0];
      if (!picked) return; // user cancelled
      const dot = picked.lastIndexOf(".");
      const ext = dot >= 0 ? picked.slice(dot + 1).toLowerCase() : "";
      if (ext !== "md" && ext !== "markdown") {
        setError(t("settings.skills.fileTypeError"));
        return;
      }
      setSelected(new Set());
      setLocalFile(picked);
      setActiveToolRaw("local");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearLocalFolder = () => {
    setSelected(new Set());
    setLocalDir(null);
    setLocalFile(null);
  };

  // GitHub package import: one repo → one bundle. Success refreshes the
  // panel list via onImported (the parent reloads skills + bundles); the
  // result card stays visible until the dialog reopens.
  const doGithubImport = async () => {
    const url = ghUrl.trim();
    if (!url || ghBusyRef.current) return;
    ghBusyRef.current = true;
    setGhBusy(true);
    setError(null);
    setGhResult(null);
    try {
      const res = await api.skills.importGithub({ url });
      if (!res.ok) {
        setError(res.error ?? t("settings.skills.githubFailed"));
        return;
      }
      setGhResult({
        imported: res.imported,
        skipped: res.skipped,
        errors: res.errors,
        bundleLabel: res.bundleLabel,
        ...(res.corrupt !== undefined ? { corrupt: res.corrupt } : {}),
      });
      setGhUrl("");
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      ghBusyRef.current = false;
      setGhBusy(false);
    }
  };

  // The local-folder picker card — rendered inside the "本地" tab when tabs are
  // showing, and above the empty state when no external skills were found at
  // all (so the local-import path stays discoverable in either case).
  const hasLocalPick = localDir != null || localFile != null;
  const localPicker = (
    <div className="rounded border border-edge bg-surface/40 p-2">
      <div className="flex items-center gap-2">
        <IconFolder size={14} className="shrink-0 text-content-subtle" />
        <span className="text-[0.7143em] font-medium text-content-muted">
          {t("settings.skills.localFolder")}
        </span>
        <div className="flex-1" />
        {hasLocalPick ? (
          <Button variant="ghost" size={null}
            type="button"
            onClick={clearLocalFolder}
            className="text-[0.7143em] text-content-subtle hover:text-content"
          >
            {t("settings.skills.clear")}
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {hasLocalPick ? (
          <div className="min-w-0 flex-1 space-y-1">
            {localDir && (
              <span
                className="block truncate rounded bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-subtle"
                title={localDir}
              >
                {localDir}
              </span>
            )}
            {localFile && (
              <span
                className="block truncate rounded bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-subtle"
                title={localFile}
              >
                {localFile}
              </span>
            )}
          </div>
        ) : (
          <span className="min-w-0 flex-1 text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.skills.localFolderHint")}
          </span>
        )}
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void pickLocalFolder()}
            disabled={loading}
            className="gap-1"
          >
            <IconFolder size={12} />
            {t("settings.skills.chooseFolder")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void pickLocalFile()}
            disabled={loading}
            className="gap-1"
          >
            <IconFileText size={12} />
            {t("settings.skills.chooseFile")}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">{t("settings.skills.importTitle")}</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.skills.importDesc1")}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
          </Dialog.Description>
          <Dialog.Close />

          {/* Body: GitHub package import + tab strip + scrollable skill list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* ── GitHub package import — independent of the tab flow below:
                one repo URL, one bundle, no per-skill picking. ── */}
            <div className="mb-3 rounded border border-edge bg-surface/40 p-2">
              <div className="text-[0.7143em] font-medium text-content-muted">
                {t("settings.skills.githubTitle")}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Input
                  type="text"
                  value={ghUrl}
                  onChange={(e) => setGhUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) void doGithubImport();
                  }}
                  placeholder={t("settings.skills.githubPlaceholder")}
                  disabled={ghBusy}
                  className="h-7 min-w-0 flex-1 rounded border border-edge bg-surface px-2 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void doGithubImport()}
                  disabled={ghBusy || !ghUrl.trim()}
                  className="shrink-0 gap-1"
                >
                  {ghBusy && <Spinner size="xs" />}
                  {ghBusy ? t("settings.skills.githubImporting") : t("settings.skills.githubImportBtn")}
                </Button>
              </div>
              {ghResult && (
                <div className="mt-1.5 space-y-0.5 text-[0.7143em]">
                  {ghResult.imported.length > 0 && (
                    <p className="text-accent">
                      {t("settings.skills.githubDone", {
                        n: ghResult.imported.length,
                        bundle: ghResult.bundleLabel ?? "",
                      })}
                      {" "}
                      <span className="text-content-subtle">
                        ({ghResult.imported.join(", ")})
                      </span>
                    </p>
                  )}
                  {ghResult.skipped.length > 0 && (
                    <p className="text-content-subtle">
                      {t("settings.skills.githubSkip", { n: ghResult.skipped.length, list: ghResult.skipped.join(", ") })}
                    </p>
                  )}
                  {ghResult.errors.length > 0 && (
                    <p className="text-danger">
                      {t("settings.importResultFailed", {
                        n: ghResult.errors.length,
                        list: ghResult.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                      })}
                    </p>
                  )}
                  {ghResult.corrupt !== undefined && (
                    <p className="text-warning">
                      {t("settings.skills.bundlesCorrupt")}:{ghResult.corrupt}
                    </p>
                  )}
                </div>
              )}
            </div>
            {loading ? (
              <LoadingNote label={t("settings.scanning")} />
            ) : sources.length === 0 ? (
              <div className="space-y-3">
                {localPicker}
                <EmptyState
                  className="py-8"
                  title={t("settings.skills.importEmpty1")}
                  desc={
                    <>
                      {t("settings.skills.importEmpty2a")}
                      {t("settings.skills.importEmpty2b")}
                    </>
                  }
                />
              </div>
            ) : (
              <div className="space-y-2">
                {/* ── Tab strip: one tab per agent, 本地 always present ──
                    Selection is global across tabs; each tab shows its total
                    count and (in accent) how many of them are picked. */}
                <div
                  role="tablist"
                  aria-label={t("settings.skills.importTitle")}
                  className="flex items-center gap-0.5 border-b border-edge"
                >
                  {tabs.map((tool) => {
                    const items = grouped[tool] ?? [];
                    const picked = items.filter((s) => selected.has(s.sourcePath)).length;
                    const isActive = tool === activeTool;
                    return (
                      <Button variant="ghost" size={null}
                        key={tool}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        tabIndex={isActive ? 0 : -1}
                        onKeyDown={moveTabFocus}
                        onClick={() => setActiveToolRaw(tool)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 transition-colors",
                          isActive
                            ? "border-accent bg-surface text-content"
                            : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
                        )}
                      >
                        <span
                          className={cn(
                            "rounded px-1 text-[10px] font-medium leading-tight",
                            TOOL_BADGE_CLS[tool],
                          )}
                        >
                          {tool === "local" ? t("settings.skills.toolLocal") : TOOL_LABELS[tool]}
                        </span>
                        <span className="tabular-nums text-[0.7143em] text-content-subtle">
                          {items.length}
                        </span>
                        {picked > 0 && (
                          <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-medium leading-tight text-accent tabular-nums">
                            {picked}
                          </span>
                        )}
                      </Button>
                    );
                  })}
                </div>

                {/* The folder picker lives in the 本地 tab (it's that tab's
                    source selector), not above the whole list. */}
                {activeTool === "local" && localPicker}

                {activeItems.length > 0 ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-[0.7143em] text-content-subtle">
                        {t("settings.skills.skillCount", { n: activeItems.length })}
                      </span>
                      <div className="flex-1" />
                      <Button variant="ghost" size={null}
                        type="button"
                        onClick={toggleSelectAllForActive}
                        disabled={importableItems.length === 0}
                        className="text-[0.7143em] text-accent hover:underline disabled:text-content-subtle disabled:no-underline"
                      >
                        {allActiveSelected
                          ? t("settings.skills.deselectAll")
                          : t("settings.skills.selectAll")}
                      </Button>
                    </div>
                    <div className="space-y-0.5">
                      {activeItems.map((s) => {
                        const isExisting = existing.has(s.name);
                        const isChecked = selected.has(s.sourcePath);
                        return (
                          <label
                            key={s.sourcePath}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors",
                              isExisting
                                ? "opacity-50"
                                : isChecked
                                  ? "bg-accent/8"
                                  : "hover:bg-surface-hover/60",
                            )}
                          >
                            <Checkbox

                              checked={isChecked}
                              disabled={isExisting}
                              onChange={() => toggle(s.sourcePath)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-[0.7857em] font-medium text-content">
                                  {s.name}
                                </span>
                                {isExisting && (
                                  <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] text-content-subtle">
                                    {t("settings.importExisting")}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-[0.7143em] text-content-subtle">
                                {s.description || t("settings.skills.noDesc")}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  // Only reachable on the 本地 tab before a folder is picked.
                  <EmptyState className="py-6" title={t("settings.skills.localTabEmpty")} />
                )}
              </div>
            )}

            {/* Import result summary */}
            {result && (
              <div className="mt-3 rounded border border-edge bg-surface/40 p-2 text-[0.7143em]">
                {result.imported.length > 0 && (
                  <p className="text-accent">
                    {t("settings.importResultImported", { n: result.imported.length, list: result.imported.join(", ") })}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-content-subtle">
                    {t("settings.importResultSkipped", { n: result.skipped.length, list: result.skipped.join(", ") })}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="text-danger">
                    {t("settings.importResultFailed", {
                      n: result.errors.length,
                      list: result.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                    })}
                  </p>
                )}
              </div>
            )}

            {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
          </div>

          {/* Footer: selected count + actions */}
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <span className="text-[0.7143em] text-content-subtle">
              {selectedCount > 0 ? t("settings.importSelectedCount", { n: selectedCount }) : ""}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={close} disabled={importing}>
              {result ? t("common.close") : t("common.cancel")}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void doImport()}
                disabled={importing || selectedCount === 0}
              >
                {importing
                  ? t("settings.importing")
                  : `${t("settings.importBtn")}${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
