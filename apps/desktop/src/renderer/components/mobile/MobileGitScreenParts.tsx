/**
 * `MobileGitScreen` 的**浮层与底部弹层**（从 `MobileGitScreen.tsx` 拆出）。
 *
 * 分支切换底部弹层 `BranchSheet`、错误横幅 `ErrorBanner`、补丁全屏 `DiffOverlay`。
 * 只捕获 React / i18n / `api`，对主文件零引用（主文件反向调用它们）。
 * **纯搬迁，函数体逐字节一致。**
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { cn } from "@renderer/lib/cn.js";
import type { GitBranchInfo, GitBranchListResult } from "@contracts/ipc";
import {
  IconX,
  IconGitBranch,
  IconCopy,
  IconCheck,
  IconPlus,
  IconLoader2,
  IconTag,
} from "@renderer/lib/icons.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { parsePatch, PatchRows } from "./PatchView.js";

/**
 * BranchSheet — the bottom-sheet branch switcher, opened from the branch chip
 * in the status bar. Lists local branches / remote branches / tags with a
 * search filter and a "new branch" flow, reusing the desktop picker's ref
 * semantics: local → `git checkout <name>`; remote → switch to the same-named
 * local branch when one exists, otherwise create a tracking branch; tag →
 * detached-HEAD checkout. Chrome follows the mobile shell's muted surface
 * (the same layer as the top bar / drawer / settings sheet), with wells and
 * press states inverted one step (surface / hover).
 */
export function BranchSheet({
  repoPath,
  onClose,
  onChanged,
}: {
  repoPath: string;
  onClose: () => void;
  /** Called after a successful checkout so the parent refreshes its status. */
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // Display name of the ref with an in-flight checkout — drives the per-row
  // spinner and disables the rest of the list while a switch is running.
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // New-branch flow: collapsed "+" row ↔ expanded inline input (autofocus).
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.git
      .listBranches({ repoPath })
      .then((res) => {
        if (!cancelled) setBranches(res.branches);
      })
      .catch(() => {
        if (!cancelled) setBranches(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const checkout = async (
    branch: string,
    opts?: { newBranch?: string; busyKey?: string },
  ) => {
    if (checkingOut) return;
    setCheckingOut(opts?.busyKey ?? opts?.newBranch ?? branch);
    setError(null);
    try {
      const res = await api.git.checkout({ repoPath, branch, newBranch: opts?.newBranch });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.checkoutFailed"));
        return;
      }
      useToastStore.getState().push({
        kind: "info",
        title: t("ide.git.switchedTo", { branch: opts?.newBranch ?? branch }),
        duration: 3000,
      });
      await onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message ?? t("ide.git.checkoutFailed"));
    } finally {
      setCheckingOut(null);
    }
  };

  /** Same ref semantics as the desktop picker's BranchGroup. */
  const pick = (b: GitBranchInfo, localNames: Set<string>) => {
    if (b.current || checkingOut) return;
    if (b.type === "remote") {
      // `origin/foo` -> short name `foo`. Track if no local branch yet.
      const shortName = b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
      if (localNames.has(shortName)) {
        void checkout(shortName);
      } else {
        void checkout(b.name, { newBranch: shortName, busyKey: b.name });
      }
    } else {
      void checkout(b.name);
    }
  };

  const createNew = () => {
    const name = newName.trim();
    if (!name || checkingOut) return;
    setCreating(false);
    setNewName("");
    void checkout("HEAD", { newBranch: name });
  };

  // Search filter (name + commit subject), same fields as the desktop picker.
  const filtered = useMemo(() => {
    if (!branches) return null;
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    const match = (b: GitBranchInfo) =>
      b.name.toLowerCase().includes(q) || b.label.toLowerCase().includes(q);
    return {
      current: branches.current,
      detached: branches.detached,
      local: branches.local.filter(match),
      remote: branches.remote.filter(match),
      tags: branches.tags.filter(match),
    };
  }, [branches, query]);

  const localNames = useMemo(
    () => new Set(branches?.local.map((b) => b.name) ?? []),
    [branches],
  );

  const groups: { label: string; items: GitBranchInfo[] }[] | null = filtered
    ? [
        { label: t("ide.git.localBranches"), items: filtered.local },
        { label: t("ide.git.remoteBranches"), items: filtered.remote },
        { label: t("ide.git.tags"), items: filtered.tags },
      ]
    : null;
  const totalRefs = filtered
    ? filtered.local.length + filtered.remote.length + filtered.tags.length
    : 0;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("common.close")}
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[78vh] flex-col rounded-t-[var(--radius-dialog)] border-t border-edge bg-surface-muted pb-[var(--safe-bottom,0px)] shadow-[var(--shadow-popover)]">
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-8 rounded-full bg-edge" />
        </div>
        <div className="flex min-h-11 shrink-0 items-center justify-between px-4">
          <span className="text-body font-semibold text-content">{t("ide.git.switchBranch")}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-btn-md)] text-content-muted active:bg-surface-hover"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Search — filters by branch/tag name and commit subject. */}
        <div className="shrink-0 px-4 pb-2 pt-1">
          <div className="flex min-h-11 items-center gap-2 rounded-[var(--radius-card)] border border-edge bg-surface/60 px-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ide.git.searchBranches")}
              // text-base: iOS Safari zooms on focus below 16px (same as the
              // drawer's search box).
              className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-content outline-none placeholder:text-content-subtle"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("ide.search.clear")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-subtle active:bg-surface-hover"
              >
                <IconX size={13} />
              </button>
            )}
          </div>
        </div>

        {/* New branch — a collapsed "+" row keeps the sheet calm for the
            common switch flow; tapping expands an inline input. */}
        <div className="shrink-0 px-4 pb-2">
          {creating ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  // 中文输入法里敲拼音、按回车**确认候选词**时 keydown 带 isComposing ——
                  // 那不是"建分支",是输入法自己的按键。少了守卫,用户用拼音起分支名、
                  // 一确认候选词就把分支建了出来(名字还没打完)。与桌面 GitRepoCard 同款。
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") createNew();
                }}
                placeholder={t("ide.git.newBranchNamePlaceholder")}
                className="h-11 min-w-0 flex-1 rounded-[var(--radius-btn-md)] border border-input-edge bg-surface/60 px-3 text-base text-content outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={createNew}
                disabled={!newName.trim() || !!checkingOut}
                className="h-11 shrink-0 rounded-[var(--radius-btn-md)] border border-edge px-3 text-xs text-content active:bg-surface-hover disabled:opacity-50"
              >
                {t("ide.git.createBranchAction")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
                aria-label={t("mobile.git.cancelNewBranch")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-btn-md)] text-content-muted active:bg-surface-hover"
              >
                <IconX size={15} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={!!checkingOut}
              className="flex min-h-11 w-full items-center gap-1.5 rounded-[var(--radius-btn-md)] px-1 text-left text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
            >
              <IconPlus size={14} className="shrink-0" />
              {t("ide.git.newBranch")}
            </button>
          )}
        </div>

        {error && (
          <div className="mx-4 mb-2 shrink-0">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {/* Grouped ref list — 44px rows for touch targets, two-line rows so
            the commit subject survives narrow screens (the desktop picker
            truncates it to the right; that doesn't fit a phone). */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <IconLoader2 size={16} className="animate-spin text-content-subtle" />
            </div>
          ) : !filtered ? (
            <div className="py-8 text-center text-xs text-content-subtle">
              {t("ide.git.cannotReadBranches")}
            </div>
          ) : totalRefs === 0 ? (
            <div className="py-8 text-center text-xs text-content-subtle">{t("ide.git.noMatch")}</div>
          ) : (
            groups?.map(({ label, items }) =>
              items.length === 0 ? null : (
                <div key={label}>
                  <div className="px-4 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
                    {label}
                  </div>
                  {items.map((b) => {
                    const switching = checkingOut === b.name;
                    return (
                      <button
                        key={`${b.type}/${b.name}`}
                        type="button"
                        onClick={() => pick(b, localNames)}
                        disabled={!!checkingOut}
                        className={cn(
                          "flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left active:bg-surface-hover disabled:opacity-60",
                          b.current && "font-medium text-content",
                        )}
                      >
                        {switching ? (
                          <IconLoader2 size={14} className="shrink-0 animate-spin" />
                        ) : b.type === "tag" ? (
                          <IconTag size={14} className="shrink-0 text-content-subtle" />
                        ) : (
                          <IconGitBranch size={14} className="shrink-0 text-content-subtle" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate font-mono text-xs",
                              "text-content",
                            )}
                          >
                            {b.name}
                          </span>
                          {b.label && (
                            <span className="block truncate text-[10px] text-content-subtle">
                              {b.commit} {b.label}
                            </span>
                          )}
                        </span>
                        {b.current && <IconCheck size={14} className="shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Git-operation error banner: multi-line-friendly message with copy (for
 *  pasting the failure into a search / chat) and dismiss affordances. Copy
 *  uses the shared helper so it works over the mobile shell's plain-HTTP
 *  LAN transport, where navigator.clipboard is unavailable. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (await copyText(message)) setCopied(true);
  };

  return (
    <div className="mb-2 flex items-start gap-1 rounded-[var(--radius-card)] border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{message}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? t("common.copied") : t("mobile.git.copyError")}
        title={copied ? t("common.copied") : t("mobile.git.copyError")}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-btn-md)] text-danger/70 hover:bg-danger/10 hover:text-danger"
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("mobile.git.dismissError")}
        title={t("mobile.git.dismissError")}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-btn-md)] text-danger/70 hover:bg-danger/10 hover:text-danger"
      >
        <IconX size={13} />
      </button>
    </div>
  );
}

/** 单文件 diff 全屏浮层。导出是为了无头套件能直接挂载它(fakeReact 不调用子组件,
 *  从 `MobileGitScreen` 点进去跑不到这里的 effect)——见 `maint-m32-smoke` 第 3 节。 */
export function DiffOverlay({
  repoPath,
  file,
  onClose,
}: {
  repoPath: string;
  file: { path: string; staged: boolean };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void api.git
      .diff({ repoPath, filePath: file.path, staged: file.staged })
      .then((res) => {
        if (!cancelled) setPatch(res.patch);
      })
      // **失败要说出来,不能当成"没有差异"。** 读 diff 失败(仓库被移走 / 传输断)时
      // 从前只有 `.finally` —— 异常落进未处理的 rejection(手机壳没有全局监听),
      // 而下面 `rows.length === 0` 于是画成 `(无差异)`:用户以为这个文件没改动过,
      // 其实只是没读出来。
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, file.path, file.staged]);
  const rows = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-2">
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-btn-md)] text-content-muted hover:bg-surface-muted"
          aria-label={t("common.close")}
        >
          <IconX size={16} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center font-mono text-xs text-content">
          {file.path}
        </div>
        <span className="w-8" />
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">
          {t("common.loading")}
        </div>
      ) : loadFailed ? (
        <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">
          {t("mobile.git.diffLoadFailed")}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">
          {t("mobile.git.noDiff")}
        </div>
      ) : (
        <PatchRows rows={rows} />
      )}
    </div>
  );
}
