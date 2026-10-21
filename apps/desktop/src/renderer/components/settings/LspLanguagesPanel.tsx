/**
 * Language servers (LSP) settings panel — one compact ROW per language.
 *
 * Row: chevron (expand) + name + status badge + server hint + enable switch
 * + actions (install / reinstall / health-check / uninstall). Expanded
 * details hold the low-frequency surface: resolved server path (copy /
 * reveal), manual download-page + install-from-file escape hatches, the
 * custom path/args/javaHome overrides, the Java JDK note, and the install
 * log.
 *
 * State is driven by `lspLanguages` in the session store (hydrated at
 * startup from `api.lsp.list`). Every mutation calls the `api.lsp.*` RPC
 * then `reloadLspLanguages()` to refresh. Install progress is polled by
 * re-listing every second while `installing` is true on any language.
 */
import { useEffect, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Badge, Button, Field, Input, Switch, ErrorNote, LoadingNote, Spinner } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type { LspLanguageId, LspLanguageState } from "@contracts/ipc";
import {
  IconCheck,
  IconX,
  IconRefresh,
  IconAlertTriangle,
  IconStethoscope,
  IconChevronDown,
  IconChevronRight,
  IconTrash,
  IconDownload,
  IconFileImport,
  IconCode,
  IconCopy,
  IconFolderOpen,
} from "@renderer/lib/icons.js";

/** Display metadata per language id (icon + label + download fallback info).
 *  `downloadUrl` is opened in the browser when the package-manager install
 *  fails; `downloadHintKey` translates what the user should look for.
 *
 *  `label` is a proper noun and stays untranslated. `hint` is the
 *  "server · how it's installed" line; for every language but Java that line
 *  is technical text with no prose in it ("gopls · go install"), so it is a
 *  plain string. Java's carries actual prose ("auto-matched to your JDK
 *  version"), so it goes through `hintKey` instead — **and it must not also
 *  carry a `hint`**, or the two would be free to drift apart (the render site
 *  picks whichever branch the union resolves to, so a stale `hint` would never
 *  show up in testing and only surface if someone later removed the key). */
const LANG_META: Record<
  LspLanguageId,
  | { label: string; hint: string; downloadUrl: string; downloadHintKey: MessageId }
  | { label: string; hintKey: MessageId; downloadUrl: string; downloadHintKey: MessageId }
> = {
  typescript: {
    label: "TypeScript / JavaScript",
    hint: "typescript-language-server · npm",
    downloadUrl: "https://github.com/typescript-language-server/typescript-language-server/releases",
    downloadHintKey: "settings.lsp.dlHintTs",
  },
  python: {
    label: "Python",
    hint: "basedpyright · pip",
    downloadUrl: "https://github.com/DetachHead/basedpyright/releases",
    downloadHintKey: "settings.lsp.dlHintPy",
  },
  go: {
    label: "Go",
    hint: "gopls · go install",
    downloadUrl: "https://github.com/golang/tools/releases",
    downloadHintKey: "settings.lsp.dlHintGo",
  },
  java: {
    label: "Java",
    hintKey: "settings.lsp.hintJava",
    downloadUrl: "https://download.eclipse.org/jdtls/milestones/",
    downloadHintKey: "settings.lsp.dlHintJava",
  },
};

export function LspLanguagesPanel() {
  const { t } = useI18n();
  const lspLanguages = useSessionStore((s) => s.lspLanguages);
  const lspLoadError = useSessionStore((s) => s.lspLoadError);
  const reloadLspLanguages = useSessionStore((s) => s.reloadLspLanguages);

  // Poll for install progress while any language is installing.
  useEffect(() => {
    const anyInstalling = lspLanguages.some((l) => l.installing);
    if (!anyInstalling) return;
    const t = setInterval(() => void reloadLspLanguages(), 1000);
    return () => clearInterval(t);
  }, [lspLanguages, reloadLspLanguages]);

  // Subscribe to lsp:event stateChanged so the panel refreshes immediately when
  // a server crashes (lastError is set server-side). Without this the user
  // wouldn't see the error until they manually navigate away and back.
  useEffect(() => {
    const unsub = api.on.lspEvent((msg) => {
      if (msg.type === "stateChanged") void reloadLspLanguages();
    });
    return unsub;
  }, [reloadLspLanguages]);

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.lsp.title")} icon={IconCode} />

      <SettingsSection title={t("settings.lsp.section")}>
        {/* 读失败要说出来。从前 `api.lsp.list` 失败只 console.error,列表保持空,
            面板就永远转「加载 LSP 状态…」—— 用户分不清"在读"与"坏了"(硬规矩 3)。 */}
        {lspLoadError !== null && (
          <div className="px-4 py-3">
            <ErrorNote
              title={t("settings.lsp.loadFailed")}
              action={
                <Button size="sm" variant="ghost" onClick={() => void reloadLspLanguages()}>
                  {t("common.retry")}
                </Button>
              }
            >
              {lspLoadError}
            </ErrorNote>
          </div>
        )}
        {lspLanguages.length === 0 && lspLoadError === null ? (
          <LoadingNote label={t("settings.lsp.loading")} />
        ) : (
          lspLanguages.map((lang) => (
            <LanguageRow key={lang.language} state={lang} onReload={reloadLspLanguages} />
          ))
        )}
      </SettingsSection>
    </section>
  );
}

/* ───────────────────────── language row ───────────────────────── */

function LanguageRow({
  state,
  onReload,
}: {
  state: LspLanguageState;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const meta = LANG_META[state.language];
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  // Local edits for the custom path/args/javaHome fields (synced on expand).
  const [pathInput, setPathInput] = useState("");
  const [argsInput, setArgsInput] = useState("");
  const [javaHomeInput, setJavaHomeInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);

  const busy = installing || checking || state.installing;

  const toggleExpanded = () => {
    if (!expanded) {
      setPathInput(state.serverPath ?? "");
      setArgsInput("");
      setJavaHomeInput("");
    }
    setExpanded(!expanded);
  };

  const doInstall = async () => {
    setInstalling(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.install({ language: state.language });
      if (!res.ok)
        setHealthResult(
          t("settings.lsp.installFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doUninstall = async () => {
    if (!confirm(t("settings.lsp.uninstallConfirm", { name: meta.label }))) return;
    setInstalling(true);
    try {
      const res = await api.lsp.uninstall({ language: state.language });
      if (!res.ok)
        setHealthResult(
          t("settings.lsp.uninstallFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doHealthCheck = async () => {
    setChecking(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.healthCheck({ language: state.language });
      setHealthResult(res.ok ? t("settings.lsp.healthOk") : `✗ ${res.error ?? t("settings.lsp.checkFailed")}`);
    } finally {
      setChecking(false);
    }
  };

  const doToggle = async (enabled: boolean) => {
    // **失败要说出来。** 从前没有 catch:`api.lsp.toggle` 抛了的话,那个被 Switch
    // 丢弃的 promise 就静默 reject 了 —— 开关按 store 状态渲染,于是它纹丝不动,
    // 用户看到的是「点了没反应」。复用同一行的 `healthResult` 报错位。
    setHealthResult(null);
    try {
      await api.lsp.toggle({ language: state.language, enabled });
      await onReload();
    } catch (err) {
      setHealthResult(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Manual-download fallback: pick a user-downloaded binary/archive. */
  const doInstallFromFile = async () => {
    const { paths } = await api.pickFiles({
      title: t("settings.lsp.pickFileTitle", { name: meta.label }),
    });
    if (paths.length === 0) return;
    setInstalling(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.installFromFile({
        language: state.language,
        archivePath: paths[0],
      });
      if (!res.ok) {
        setHealthResult(
          t("settings.lsp.installFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      }
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doSavePath = async () => {
    setSavingPath(true);
    try {
      const args = argsInput
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await api.lsp.setPath({
        language: state.language,
        serverPath: pathInput.trim() || undefined,
        args: args.length > 0 ? args : undefined,
        javaHome: javaHomeInput.trim() || undefined,
      });
      await onReload();
    } finally {
      setSavingPath(false);
    }
  };

  const doCopyPath = async () => {
    if (!state.serverPath) return;
    try {
      await navigator.clipboard.writeText(state.serverPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-3">
        {/* Expand toggle */}
        <Button variant="ghost" size={null}
          type="button"
          onClick={toggleExpanded}
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 text-content-subtle transition-colors",
            "hover:bg-surface-hover hover:text-content",
          )}
          title={t("settings.lsp.toggleDetails")}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </Button>

        {/* Name column: icon + name + status badge */}
        <div className="flex w-44 shrink-0 items-center gap-2">
          <IconCode size={15} className="shrink-0 text-content-subtle" />
          <span className="min-w-0 truncate text-[13px] font-medium text-content">{meta.label}</span>
          <StatusBadge state={state} />
        </div>

        {/* Detail line: server · installer hint (click expands) */}
        <Button variant="ghost" size={null}
          type="button"
          onClick={toggleExpanded}
          className="min-w-0 flex-1 truncate text-left text-[0.7857em] text-content-subtle hover:text-content-muted"
          title={state.serverPath ?? undefined}
        >
          {"hintKey" in meta ? t(meta.hintKey) : meta.hint}
        </Button>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {!state.installed ? (
            <Button variant="primary" size="sm" onClick={doInstall} disabled={busy}>
              {busy ? <Spinner size="xs" /> : <IconDownload size={12} />}
              {t("settings.lsp.install")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={doInstall} disabled={busy} title={t("settings.lsp.reinstall")}>
                {busy ? <Spinner size="xs" /> : <IconRefresh size={12} />}
              </Button>
              <Button variant="ghost" size="sm" onClick={doHealthCheck} disabled={busy} title={t("settings.lsp.healthCheck")}>
                <IconStethoscope size={12} />
              </Button>
              <Button variant="outline" size="sm" onClick={doUninstall} disabled={busy}>
                <IconTrash size={12} />
                {t("settings.lsp.uninstall")}
              </Button>
            </>
          )}
          <Switch checked={state.enabled} onCheckedChange={doToggle} label={state.enabled ? t("settings.on") : t("settings.off")} />
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="ml-7 mt-1.5 space-y-2 rounded bg-surface-muted/30 px-3 py-2 text-[0.7857em]">
          {/* Resolved server path */}
          <DetailRow label={t("settings.lsp.fieldPath")}>
            <span
              className="block min-w-0 flex-1 truncate font-mono text-content-muted"
              title={state.serverPath ?? undefined}
            >
              {state.serverPath ?? "—"}
            </span>
            {state.serverPath && (
              <>
                <Button variant="ghost" size={null}
                  type="button"
                  onClick={doCopyPath}
                  className="ml-2 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[0.92em] text-content-subtle hover:bg-surface-hover hover:text-content"
                  title={t("settings.lsp.copy")}
                >
                  {copied ? <IconCheck size={11} className="text-accent" /> : <IconCopy size={11} />}
                  {copied ? t("settings.lsp.copied") : t("settings.lsp.copy")}
                </Button>
                <Button variant="ghost" size={null}
                  type="button"
                  onClick={() => void api.shell.showItemInFolder({ path: state.serverPath! })}
                  className="ml-1 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[0.92em] text-content-subtle hover:bg-surface-hover hover:text-content"
                  title={t("settings.lsp.reveal")}
                >
                  <IconFolderOpen size={11} />
                </Button>
              </>
            )}
          </DetailRow>

          {/* Escape hatches: manual download page + install from file */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(meta.downloadUrl, "_blank", "noopener,noreferrer")}
              title={t(meta.downloadHintKey)}
            >
              <IconDownload size={12} />
              {t("settings.lsp.openDownloadPage")}
            </Button>
            <Button variant="ghost" size="sm" onClick={doInstallFromFile} disabled={busy} title={t(meta.downloadHintKey)}>
              <IconFileImport size={12} />
              {t("settings.lsp.installFromFile")}
            </Button>
          </div>

          {/* Custom overrides: path / args / (java) JDK home */}
          <div className="space-y-1.5 border-t border-edge pt-2">
            <Field label={t("settings.lsp.serverPathLabel")} htmlFor={`lsp-server-path-${state.language}`}>
              <Input
                id={`lsp-server-path-${state.language}`}
                className="flex-1"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder={t("settings.lsp.serverPathPlaceholder")}
              />
            </Field>
            <Field label={t("settings.lsp.argsLabel")} htmlFor={`lsp-server-args-${state.language}`}>
              <Input
                id={`lsp-server-args-${state.language}`}
                className="flex-1"
                value={argsInput}
                onChange={(e) => setArgsInput(e.target.value)}
                placeholder={t("settings.lsp.argsPlaceholder")}
              />
            </Field>
            {state.language === "java" && (
              <Field label={t("settings.lsp.javaHomeLabel")} htmlFor={`lsp-java-home-${state.language}`}>
                <Input
                  id={`lsp-java-home-${state.language}`}
                  className="flex-1"
                  value={javaHomeInput}
                  onChange={(e) => setJavaHomeInput(e.target.value)}
                  placeholder={t("settings.lsp.javaHomePlaceholder")}
                />
              </Field>
            )}
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={doSavePath} disabled={savingPath}>
                {savingPath ? <Spinner size="xs" /> : t("common.save")}
              </Button>
            </div>
          </div>

          {/* Java-specific JDK/jdtls note */}
          {state.language === "java" && (
            <p className="leading-relaxed text-content-subtle">
              {t("settings.lsp.javaNoteDetect")}
              {t("settings.lsp.javaNoteRuntimePre")}
              <span className="text-content-muted">{t("settings.lsp.javaNoteNoImpact")}</span>。
              {t("settings.lsp.javaNoteJava8")}
            </p>
          )}

          {/* Install log */}
          {state.installLog && (
            <div className="border-t border-edge pt-1.5">
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => setShowLog(!showLog)}
                className="text-content-subtle hover:text-content-muted"
              >
                {showLog ? t("settings.lsp.hideLog") : t("settings.lsp.showLog")}
              </Button>
              {showLog && (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-muted/40 p-2 font-mono text-[0.92em] text-content-muted whitespace-pre-wrap">
                  {state.installLog}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Health check result */}
      {healthResult && (
        healthResult.startsWith("✓")
          ? <Badge variant="success" className="mt-1.5"><IconCheck size={12} />{healthResult}</Badge>
          : <ErrorNote icon={IconAlertTriangle} className="mt-1.5">{healthResult}</ErrorNote>
      )}

      {/* Server error (e.g. "jdtls requires at least Java 21") */}
      {state.lastError && !state.running && (
        <ErrorNote icon={IconAlertTriangle} className="mt-1.5">{state.lastError}</ErrorNote>
      )}
    </div>
  );
}

/* ───────────────────────── small components ───────────────────────── */

function StatusBadge({ state }: { state: LspLanguageState }) {
  const { t } = useI18n();
  if (state.installing) {
    return (
      <Badge variant="accent"><Spinner size="xs" />{t("settings.lsp.statusInstalling")}</Badge>
    );
  }
  if (state.running) {
    return (
      <Badge variant="success"><IconCheck size={9} />{t("settings.lsp.statusRunning")}</Badge>
    );
  }
  if (state.installed) {
    return (
      <Badge variant="neutral">{t("settings.lsp.statusInstalled")}</Badge>
    );
  }
  return (
    <Badge variant="neutral"><IconX size={9} />{t("settings.lsp.statusNotInstalled")}</Badge>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-content-subtle">{label}</span>
      <div className="flex min-w-0 flex-1 items-center text-content-muted">{children}</div>
    </div>
  );
}
