/**
 * Project-file picker for composer @-mentions and the "add context" button.
 *
 * Anchored above the composer (fixed position from an anchor rect). Loads
 * candidates via `api.file.search` with a debounced query. Keyboard:
 * ↑↓ move, Enter/Tab confirm, Esc close.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openEscapeLayer, claimEscape, isTopEscapeLayer } from "@renderer/lib/escapeLayer.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { IconFile, IconLoader2, IconPaperclip, IconSearch, IconUpload } from "@renderer/lib/icons.js";
import type { FileSearchEntry } from "@contracts/ipc";
import { useComposerPickerPlacement } from "./useComposerPickerPlacement.js";
import { eligibleFileIndex } from "./filePickerKeyboard.js";

export type FileMentionPickerMode = "mention" | "attach";

export interface FileMentionPickerProps {
  open: boolean;
  /** Project root absolute path; null shows an empty-state tip. */
  projectPath: string | null;
  /** Filter query (without the leading @). Used in "mention" mode; ignored in
   *  "attach" mode, which owns its own search input. */
  query?: string;
  /** Anchor rect (composer box or textarea) for positioning. */
  anchorRect: DOMRect | null;
  mode: FileMentionPickerMode;
  /** Paths already attached — shown muted / skipped on pick when attach. */
  excludePaths?: ReadonlyArray<string>;
  onPick: (files: FileSearchEntry[]) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 120;
const LIMIT = 60;

export function FileMentionPicker({
  open,
  projectPath,
  query,
  anchorRect,
  mode,
  excludePaths = [],
  onPick,
  onClose,
}: FileMentionPickerProps) {
  const { t } = useI18n();
  const [files, setFiles] = useState<FileSearchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [pickError, setPickError] = useState(false);
  const [pickPending, setPickPending] = useState(false);
  const pickPendingRef = useRef(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  // Keep selected file identities, not only paths from the currently filtered
  // search page: multi-query attachment must not silently drop earlier picks.
  const [selectedEntries, setSelectedEntries] = useState<Map<string, FileSearchEntry>>(() => new Map());
  // attach mode owns a local search input (no textarea to drive it).
  const [localQuery, setLocalQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);
  // The native OS chooser may remain open after this picker closes/switches
  // projects. Its late result belongs only to the episode that opened it.
  const selectionGenerationRef = useRef(0);
  // Use stable content-based identity instead of constructing a new Set on
  // every keystroke, which used to tear down the global key listener each
  // render (while React was trying to process an IME completion).
  const excludedKey = JSON.stringify(excludePaths);
  const exclude = useMemo(() => new Set<string>(JSON.parse(excludedKey) as string[]), [excludedKey]);
  const eligibleSelectedCount = [...selectedEntries.keys()].filter((path) => !exclude.has(path)).length;

  const effectiveQuery = mode === "attach" ? localQuery : query ?? "";
  // Match results to BOTH the project and query in the same render. The
  // passive search effect runs after commit, so without this key a fast Enter
  // can still select rows from the previous query in the intervening frame.
  const searchKey = JSON.stringify([projectPath, effectiveQuery.trim()]);
  const [completedSearchKey, setCompletedSearchKey] = useState<string | null>(null);
  const visibleFiles = completedSearchKey === searchKey ? files : [];
  const selectableIdx = eligibleFileIndex(visibleFiles, exclude, activeIdx);
  const searchInFlight = !!projectPath && (loading || completedSearchKey !== searchKey);
  const currentSearchError = searchError && completedSearchKey === searchKey;

  // Reset transient state when reopened.
  useEffect(() => {
    selectionGenerationRef.current++;
    pickPendingRef.current = false;
    if (!open) return;
    setPickPending(false);
    setSelectedEntries(new Map());
    setLocalQuery("");
    setActiveIdx(0);
    setPickError(false);
    setSearchError(false);
    if (mode === "attach") {
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => {
        selectionGenerationRef.current++;
        pickPendingRef.current = false;
        cancelAnimationFrame(raf);
      };
    }
    return () => {
      selectionGenerationRef.current++;
      pickPendingRef.current = false;
    };
  }, [open, mode, projectPath]);

  // A file can become attached elsewhere while this menu stays open.
  // Reconcile that external exclusion with its pending local selection; the
  // Add N label must never promise files that cannot be added anymore.
  useEffect(() => {
    setSelectedEntries((prev) => {
      if ([...prev.keys()].every((path) => !exclude.has(path))) return prev;
      return new Map([...prev].filter(([path]) => !exclude.has(path)));
    });
    // The caller may provide a new exclusion array after each attachment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludePaths]);

  // Keep the selection on the first row while the user types, mirroring the
  // SlashCommandPicker. The debounced search also resets on result, but this
  // covers the gap between keystroke and result arrival so the highlight
  // doesn't linger on a now-stale row index.
  useEffect(() => {
    if (open) setActiveIdx(0);
  }, [open, effectiveQuery]);

  // Debounced search driven by the effective query.
  useEffect(() => {
    // Bump the epoch even on close or project loss. Clearing a timer alone
    // does not invalidate file.search promises already waiting for IPC.
    const myId = ++reqIdRef.current;
    if (!open || !projectPath) {
      setFiles([]);
      setCompletedSearchKey(null);
      setLoading(false);
      setSearchError(false);
      return;
    }
    // Do not allow Enter/Tab to pick a result from a previous query or root.
    setCompletedSearchKey(null);
    setFiles([]);
    setLoading(true);
    setSearchError(false);
    const t = window.setTimeout(() => {
      void api.file
        .search({
          projectPath,
          query: effectiveQuery.trim() || undefined,
          limit: LIMIT,
        })
        .then((res) => {
          if (reqIdRef.current !== myId) return;
          setFiles(res.files ?? []);
          setCompletedSearchKey(searchKey);
          setActiveIdx(0);
          setLoading(false);
        })
        .catch(() => {
          if (reqIdRef.current !== myId) return;
          setFiles([]);
          setCompletedSearchKey(searchKey);
          setLoading(false);
          setSearchError(true);
        });
    }, DEBOUNCE_MS);
    return () => {
      reqIdRef.current++;
      window.clearTimeout(t);
    };
  }, [open, projectPath, effectiveQuery, searchKey, searchRetry]);

  // Keep active row in view.
  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, visibleFiles]);

  const confirmMention = useCallback(
    (file: FileSearchEntry) => {
      if (!exclude.has(file.path)) onPick([file]);
    },
    [onPick, exclude],
  );

  const toggleAttach = useCallback((file: FileSearchEntry) => {
    if (exclude.has(file.path)) return;
    setSelectedEntries((prev) => {
      const next = new Map(prev);
      if (next.has(file.path)) next.delete(file.path);
      else next.set(file.path, file);
      return next;
    });
  }, [exclude]);

  const confirmAttach = useCallback(() => {
    const picked = Array.from(selectedEntries.values()).filter((f) => !exclude.has(f.path));
    if (selectedEntries.size > 0) {
      if (picked.length > 0) onPick(picked);
      // If the host excluded every selected path after selection, do not
      // silently attach an unrelated active row as a fallback.
      return;
    }
    if (searchInFlight || currentSearchError) return;
    const target = visibleFiles[selectableIdx];
    if (target && !exclude.has(target.path)) onPick([target]);
  }, [visibleFiles, selectedEntries, exclude, selectableIdx, onPick, searchInFlight, currentSearchError]);

  /** Open the native OS file picker so the user can attach files from OUTSIDE
   *  the project root (unlike `file.search`, which main scopes to known
   *  projects). Selected paths are mapped to `FileSearchEntry`-shaped objects
   *  and forwarded via `onPick` — the same callback the in-project attach flow
   *  uses — so downstream tag creation / dedup / chip rendering is unchanged.
   *  `relativePath` is set to the full path (there's no project root to relativize
   *  against); the chip only shows `name` anyway. */
  const handlePickExternal = useCallback(async () => {
    // Ref flips synchronously, before React rerenders the disabled button.
    // A double-click or two keyboard activations must not open two OS dialogs.
    if (pickPendingRef.current) return;
    pickPendingRef.current = true;
    const generation = selectionGenerationRef.current;
    setPickPending(true);
    setPickError(false);
    try {
      const { paths } = await api.pickFiles({});
      if (selectionGenerationRef.current !== generation) return;
      if (paths.length === 0) return; // user canceled
      const mapped: FileSearchEntry[] = paths.map((p) => {
        const segs = p.split(/[/\\]/);
        return { name: segs[segs.length - 1] || p, path: p, relativePath: p };
      });
      onPick(mapped);
    } catch {
      if (selectionGenerationRef.current !== generation) return;
      setPickError(true);
    } finally {
      // Late completion from a previous open must not unlock a new chooser.
      if (selectionGenerationRef.current === generation) {
        pickPendingRef.current = false;
        setPickPending(false);
      }
    }
  }, [onPick]);

  // Keyboard handling is owned by the parent textarea (so focus stays there),
  // but we expose an imperative-style handler via a window event is overkill —
  // parent calls nothing; instead parent wires keydown and we listen via
  // a custom callback ref pattern. For simplicity the parent passes key events
  // through `onKeyDownFromParent` by calling the exported helper… Actually we
  // attach a capturing keydown on window while open so arrows work even if
  // focus is on the attach button.
  // Opening, not result refresh, determines overlay order. A changing
  // search result must not promote this picker above another already opened.
  useEffect(() => {
    if (!open) return;
    const closeEscapeLayer = openEscapeLayer("chat.file-mention-picker");
    return () => closeEscapeLayer();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // IME composition keys (candidate confirm / pinyin Space) belong to the
      // input method, not the picker.
      if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
      // The window capture listener remains mounted beneath another picker.
      // Only the last-opened escape layer may own ANY navigation/selection key.
      if (!isTopEscapeLayer("chat.file-mention-picker")) return;
      // A native dialog or nested confirmation owns its focused input.
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]')) return;
      // Attach mode exposes actual buttons (including the native OS file
      // chooser): do not turn their Enter/Space into a row selection.
      if (mode === "attach" && e.key === "Tab") return;
      if (mode === "attach" && (e.key === "Enter" || e.key === " ") &&
          e.target instanceof Element && rootRef.current?.contains(e.target) &&
          e.target.closest("button")) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.repeat && (e.key === "Enter" || e.key === "Tab")) return;
      if (e.key === "Escape") {
        if (!claimEscape("chat.file-mention-picker")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Selected attachments survive across search queries. Confirming them
      // must work even while the new results are loading or show no matches.
      if (mode === "attach" && eligibleSelectedCount > 0 && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        confirmAttach();
        return;
      }
      if (searchInFlight || currentSearchError) return;
      if (e.key === "ArrowDown") {
        if (visibleFiles.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => eligibleFileIndex(visibleFiles, exclude, i, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        if (visibleFiles.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => eligibleFileIndex(visibleFiles, exclude, i, -1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const f = visibleFiles[selectableIdx];
        if (!f && mode === "mention") return;
        e.preventDefault();
        e.stopPropagation();
        if (mode === "mention") {
          if (f) confirmMention(f);
        } else {
          confirmAttach();
        }
      }
    };
    // Capture so we beat textarea Enter-to-send.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, visibleFiles, selectableIdx, exclude, eligibleSelectedCount, mode, confirmMention, confirmAttach, onClose, searchInFlight, currentSearchError]);

  // Click outside the picker to close. Mirrors the ModelDropdown / TagPopover
  // pattern (document mousedown + ref.contains). Escape is already handled by
  // the capturing keydown listener above, so this only covers pointer
  // dismissal. Runs while open; cleaned up on close/unmount.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  const placement = useComposerPickerPlacement(open, anchorRect, rootRef, 480);
  if (!open || !placement) return null;

  return (
    <div
      ref={rootRef}
      className={cn(
        "fixed z-[70] flex max-h-[calc(100vh-16px)] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-edge bg-surface shadow-[var(--shadow-popover)]",
      )}
      style={{
        left: placement.left,
        width: placement.width,
        top: placement.top,
        maxHeight: placement.maxHeight,
      }}
      // In mention mode, prevent mousedown from stealing focus from the
      // textarea (keyboard stays there). In attach mode we WANT focus in our
      // own search input, so let default through.
      onMouseDown={mode === "mention" ? (e) => e.preventDefault() : undefined}
    >
      {mode === "attach" ? (
        <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
          <IconSearch size={12} className="shrink-0 text-content-muted" />
          <input
            ref={inputRef}
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder={t("chat.mention.searchPlaceholder")}
            aria-label={t("chat.mention.searchPlaceholder")}
            className="min-h-8 min-w-0 flex-1 rounded-[var(--radius-btn-xs)] bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle focus-visible:ring-2 focus-visible:ring-accent"
          />
          {eligibleSelectedCount > 0 && (
            <button
              type="button"
              className="min-h-8 shrink-0 rounded-[var(--radius-btn-xs)] bg-accent px-1.5 py-0.5 text-[10px] font-medium text-surface hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={confirmAttach}
            >
              {t("chat.mention.addN", { n: eligibleSelectedCount })}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-b border-edge px-2.5 py-1.5 text-[11px] text-content-muted">
          <IconPaperclip size={12} className="shrink-0 opacity-70" />
          <span className="truncate">
            {t("chat.mention.header")}{effectiveQuery ? ` · ${effectiveQuery}` : ""}
          </span>
        </div>
      )}

      {mode === "attach" && (
        <button
          type="button"
          onClick={() => void handlePickExternal()}
          disabled={pickPending}
          className={cn(
            "mx-1.5 mt-1.5 flex min-h-9 items-center gap-1.5 rounded-[var(--radius-btn-xs)] border border-dashed border-edge px-2 py-1.5 text-left text-[12px] text-content-muted",
            "cds-hover-ghost transition-colors hover:border-edge hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
          title={t("chat.mention.externalTitle")}
        >
          <IconUpload size={14} className="shrink-0" />
          <span className="flex-1">{t("chat.mention.externalPick")}</span>
          <span className="text-[10px] text-content-subtle">{t("chat.mention.externalHint")}</span>
        </button>
      )}

      {pickError && mode === "attach" && (
        <div className="px-3 py-1 text-[11px] text-danger" role="alert">
          {t("common.error")} <button type="button" className="underline" disabled={pickPending} onClick={() => void handlePickExternal()}>{t("common.retry")}</button>
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {!projectPath ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            {t("chat.mention.openProjectFirst")}
          </div>
        ) : currentSearchError ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12px] text-danger" role="alert">
            {t("common.error")} <button type="button" className="underline" onClick={() => setSearchRetry((v) => v + 1)}>{t("common.retry")}</button>
          </div>
        ) : searchInFlight && visibleFiles.length === 0 ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12px] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("chat.mention.searching")}
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            {t("chat.mention.noMatch")}
          </div>
        ) : (
          visibleFiles.map((f, idx) => {
            const already = exclude.has(f.path);
            const isActive = idx === selectableIdx;
            const isSel = selectedEntries.has(f.path);
            return (
              <button
                key={f.path}
                type="button"
                data-idx={idx}
                disabled={already && mode === "mention"}
                aria-disabled={already}
                aria-pressed={mode === "attach" ? isSel || already : undefined}
                aria-current={isActive ? "true" : undefined}
                onMouseEnter={() => { if (!already) setActiveIdx(idx); }}
                onClick={() => {
                  if (mode === "mention") {
                    if (!already) confirmMention(f);
                  } else {
                    toggleAttach(f);
                  }
                }}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-btn-xs)] px-2 py-1.5 text-left text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  isActive
                    ? "bg-surface-hover text-content ring-1 ring-inset ring-edge-selected"
                    : "cds-hover-ghost text-content",
                  already && "opacity-50",
                )}
              >
                {mode === "attach" && (
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px]",
                      isSel || already
                        ? "border-accent bg-accent text-surface"
                        : "border-edge text-transparent",
                    )}
                  >
                    ✓
                  </span>
                )}
                <IconFile size={14} className="shrink-0 text-content-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{f.name}</span>
                  <span className="block truncate text-[10px] text-content-subtle">
                    {f.relativePath}
                  </span>
                </span>
                {already && (
                  <span className="shrink-0 text-[10px] text-content-subtle">{t("chat.mention.added")}</span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-edge px-2.5 py-1 text-[10px] text-content-subtle">
        <span>
          <kbd className="rounded border border-edge px-1">↑</kbd>
          <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>
          {" "}{t("chat.kbd.navigate")}{" "}
          <kbd className="ml-1 rounded border border-edge px-1">↵</kbd>
          {" "}
          {mode === "attach" ? t("chat.mention.confirm") : t("chat.mention.select")}
        </span>
        <span role="status" aria-live="polite">{t("chat.mention.count", { n: visibleFiles.length })}</span>
      </div>
    </div>
  );
}
