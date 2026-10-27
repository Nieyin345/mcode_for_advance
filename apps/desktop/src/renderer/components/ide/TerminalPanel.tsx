import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { StatusDot } from "@renderer/components/ui/cds/StatusDot.js";
import { api } from "@renderer/lib/api.js";
import {
  IconPlus,
  IconX,
  IconTerminal2,
  IconRefresh,
  IconPlayerStop,
  IconEraser,
} from "@renderer/lib/icons.js";
import type { TerminalSessionStatus, TerminalViewHandle } from "./TerminalView.js";
import { subscribeTerminalRunRequests } from "@renderer/lib/terminalRunBus.js";
import { TerminalCommandsMenu } from "./TerminalCommandsMenu.js";
import { terminalTabTarget } from "./terminalTabNavigation.js";
import { revealRailItemWithin } from "../layout/panelRailScroll.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

// xterm (+ its CSS) is only needed once a terminal tab actually exists; the
// panel itself is part of the always-mounted layout, so load the view lazily.
const TerminalView = lazy(() =>
  import("./TerminalView.js").then((m) => ({ default: m.TerminalView })),
);

/** One UI terminal tab. `key` is stable; the underlying PTY id lives in the view.
 *  The tab title is derived at render time from the owning project's name plus
 *  `seq` ("{name} {n}") so it follows the UI locale (and later project renames)
 *  instead of being frozen at creation. `seq` is per-project (see
 *  `ProjectTermState.nextSeq`), so tabs of different projects never make each
 *  other's numbers jump. */
interface TermSession {
  key: string;
  /** Per-project ordinal shown in the tab title. */
  seq: number;
  status: TerminalSessionStatus;
  detail?: string;
}

/** Stable empty array for the no-project read-only view (avoids a fresh `[]`
 *  each render that would churn downstream selectors). */
const EMPTY_SESSIONS: TermSession[] = [];

/** Globally-unique tab-key generator. Only guarantees key uniqueness — the
 *  displayed ordinal comes from the owning project bucket's `nextSeq`. The
 *  timestamp suffix keeps keys unique across module re-evaluation (HMR) while
 *  the component tree persists. */
let keyGen = 0;
function makeSession(seq: number): TermSession {
  return { key: `term-${keyGen++}-${Date.now().toString(36)}`, seq, status: "starting" };
}

/** Per-project terminal state. `sessions` are the open tabs; `activeKey` is the
 *  visible one. Kept out of React state on purpose - see `termsRef` below. */
interface ProjectTermState {
  sessions: TermSession[];
  activeKey: string | null;
  /** Next per-project ordinal handed out for the tab title ("终端 {n}"). */
  nextSeq: number;
}

/**
 * Bottom-bar Terminal panel body.
 *
 * - Scoped to the active project's path (cwd = project root).
 * - Supports multiple local sessions (tabs) per project; each mounts a
 *   TerminalView. Tab ordinals ("终端 {n}") are per-project, starting at 1
 *   for each project's first terminal.
 * - The first terminal of a project is created lazily — the first time the
 *   panel is actually OPENED with that project active, not when the project
 *   merely becomes active — so switching projects never spawns hidden PTYs.
 * - Parent BottomTerminalBar keep-alives this component (collapses to height 0
 *   instead of unmounting) so PTYs and scrollback survive the bar toggling.
 * - Cross-project keep-alive: every project that has ever opened a terminal
 *   keeps its TerminalViews mounted while the user switches projects. Only the
 *   current project's active tab is visible; the rest are CSS-hidden with
 *   active=false. Switching back to a project restores its tabs, active tab and
 *   running PTYs exactly as they were. Terminals are torn down only when a
 *   project is deleted/archived (see the projects effect below).
 */
export function TerminalPanel({ active }: { active: boolean }) {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  // Follows the active session's environment — a worktree session's
  // terminals open IN the isolated checkout (its own bucket, separate from
  // the project-root terminals).
  const projectPath = useSessionStore(selectActiveEnvPath);

  // Terminal state is keyed by project path and kept in refs (NOT React state).
  // The reason: when the user switches projects we must NOT unmount the other
  // projects' TerminalViews - unmounting kills the PTY (cleanup calls
  // api.terminal.kill) and destroys scrollback. Instead every project's
  // TerminalViews stay mounted; only the visible one (current project + active
  // tab) is shown, the rest are hidden via CSS. refs are the single source of
  // truth and `forceRender` re-renders after a mutation so the UI reflects it.
  const termsRef = useRef<Map<string, ProjectTermState>>(new Map()); // projectPath -> state
  const handlesRef = useRef<Map<string, TerminalViewHandle>>(new Map()); // sessionKey -> handle (sessionKey is globally unique)
  const keyToPathRef = useRef<Map<string, string>>(new Map()); // sessionKey -> projectPath (routes status callbacks back to the right bucket)
  // Per-session commands waiting to be typed into the PTY once it reaches
  // "running" (the new PTY is spawned async by TerminalView, so we can't write
  // immediately). Keyed by sessionKey so concurrent "run in new terminal"
  // invocations across multiple tabs never overwrite each other (matches the
  // per-session bucketing convention documented in AGENTS.md).
  const pendingCommandBySession = useRef<Map<string, string>>(new Map());
  const tabListRef = useRef<HTMLDivElement>(null);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusFrame = useRef<number | null>(null);
  // Only the terminal panel owns this focus transfer. Never query the entire
  // workspace for a matching tab (another project/pane may have one).
  useEffect(() => () => {
    if (pendingFocusFrame.current !== null) cancelAnimationFrame(pendingFocusFrame.current);
  }, []);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // Create a session in the given project's bucket (creating the bucket if
  // needed) and make it the active tab. Single choke point for every terminal
  // spawn, so the per-project ordinal stays dense — a shared global counter
  // made numbers jump whenever another project silently consumed one.
  const appendSession = useCallback((path: string): TermSession => {
    let st = termsRef.current.get(path);
    if (!st) {
      st = { sessions: [], activeKey: null, nextSeq: 1 };
      termsRef.current.set(path, st);
    }
    const s = makeSession(st.nextSeq++);
    st.sessions = [...st.sessions, s];
    st.activeKey = s.key;
    keyToPathRef.current.set(s.key, path);
    return s;
  }, []);

  // Read-only view of the CURRENT project's state (empty when no project).
  const current = projectPath ? termsRef.current.get(projectPath) : undefined;
  const sessions = current?.sessions ?? EMPTY_SESSIONS;
  const activeKey = current?.activeKey ?? null;

  // Ensure the current project has a terminal bucket — lazily: only once the
  // panel has actually been OPENED with that project active. Creating on bare
  // project activation would silently spawn (and keep alive) a hidden PTY for
  // every project the user merely switched through. Existing buckets are left
  // untouched so re-opening restores tabs + active tab + live PTYs.
  useEffect(() => {
    if (!projectPath || !active) return; // not open (or no project) -> don't touch the map
    if (termsRef.current.has(projectPath)) return; // already has terminals -> restore as-is
    appendSession(projectPath);
    forceRender();
  }, [projectPath, active, appendSession]);

  // Clean up terminals for projects that no longer exist (deleted/archived out).
  // The store has already switched activeProjectId away by the time this runs,
  // so dropping the bucket is safe. Unmounting the TerminalViews re-kills the
  // PTYs (cleanup), which is harmless.
  useEffect(() => {
    const livePaths = new Set(projects.map((p) => p.path));
    // ⚠️ **桶是按「环境路径」存的,不是项目根。** 工作树会话的终端开在
    // `session.worktreePath`(`userData/worktrees/…` 下),那个路径**不在任何
    // 项目根里** —— 只拿项目根判活的话,任何一次 `projects` 数组换身份(改名 /
    // 分组 / 排序 / 别端碰项目触发的 refreshProjects)都会把工作树终端的桶当成
    // 「项目没了」清掉,用户正开着的终端连同回滚缓冲**无声消失**。把仍被引用的
    // 工作树路径一并算作活的;只有引用它的会话也没了(项目被删)才轮到清理。
    // 读当前快照即可 —— 这个 effect 只该在 `projects` 变化时跑,不必为会话再加订阅。
    const snapshot = useSessionStore.getState();
    const lists = [
      ...Object.values(snapshot.sessionsByProject),
      ...Object.values(snapshot.archivedSessionsByProject),
      snapshot.sessions,
      snapshot.pinnedSessions,
    ];
    for (const list of lists) {
      for (const sess of list ?? []) if (sess.worktreePath) livePaths.add(sess.worktreePath);
    }
    let changed = false;
    for (const [p, st] of termsRef.current) {
      if (livePaths.has(p)) continue;
      for (const s of st.sessions) {
        handlesRef.current.get(s.key)?.kill();
        handlesRef.current.delete(s.key);
        keyToPathRef.current.delete(s.key);
      }
      termsRef.current.delete(p);
      changed = true;
    }
    if (changed) forceRender();
  }, [projects]);

  const addSession = useCallback(() => {
    if (!projectPath) return;
    appendSession(projectPath);
    forceRender();
  }, [projectPath, appendSession]);

  const closeSession = useCallback(
    (key: string) => {
      const path = keyToPathRef.current.get(key);
      // Kill + deregister the handle regardless of whether we find its bucket.
      handlesRef.current.get(key)?.kill();
      handlesRef.current.delete(key);
      keyToPathRef.current.delete(key);

      if (!path) {
        forceRender();
        return;
      }
      const st = termsRef.current.get(path);
      if (st) {
        const next = st.sessions.filter((s) => s.key !== key);
        // **最后一个也该关得掉**（用户 2026-09-20 报的「终端关不掉，关掉又会新开一个」）。
        //
        // 这里原先有一句 `if (next.length === 0 && path === projectPath) appendSession(path)`
        // ——作者的理由是「当前项目不该空着」。但那让用户**永远关不掉最后一个终端**：
        // 点 × 之后立刻又冒一个出来，看起来像"关不掉"。
        //
        // ⚠️ **空 bucket 要留着，不能删。** 下面那个自动建终端的 effect 判的是
        // `termsRef.current.has(projectPath)` —— 删了 bucket 它会立刻补一个，就成了
        // 换个花样的"关不掉"。留一个 `sessions: []` 的壳，那句 `has` 仍然为真，
        // 于是它不会自动补；用户再点「+」才建新的。
        st.sessions = next;
        if (st.activeKey === key) {
          st.activeKey = next[next.length - 1]?.key ?? null;
        }
        // 非当前项目的 bucket 仍然收掉：没有"关光就不补"的问题（那个 effect
        // 只管当前项目），留着只是白占内存。
        if (next.length === 0 && path !== projectPath) {
          termsRef.current.delete(path);
        }
      }
      forceRender();
    },
    [projectPath, appendSession],
  );

  const closeSessionAndRestoreFocus = useCallback((key: string, closeButton: HTMLButtonElement) => {
    const wasFocused = document.activeElement === closeButton;
    closeSession(key);
    if (!wasFocused || !active) return;
    if (pendingFocusFrame.current !== null) cancelAnimationFrame(pendingFocusFrame.current);
    pendingFocusFrame.current = requestAnimationFrame(() => {
      pendingFocusFrame.current = null;
      const list = tabListRef.current;
      if (!list?.isConnected) return;
      const tab = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-terminal-tab]"))
        .find(button => button.getAttribute("aria-selected") === "true");
      (tab ?? newTabButtonRef.current)?.focus({ preventScroll: true });
    });
  }, [closeSession, active]);

  const updateStatus = useCallback(
    (key: string, status: TerminalSessionStatus, detail?: string) => {
      const path = keyToPathRef.current.get(key);
      if (!path) return;
      const st = termsRef.current.get(path);
      if (!st) return;
      st.sessions = st.sessions.map((s) =>
        s.key === key ? { ...s, status, detail } : s,
      );
      // Only re-render if the changed tab belongs to the visible project - a
      // hidden project's status dot isn't on screen, so a render would be
      // wasted work.
      if (path === projectPath) forceRender();
    },
    [projectPath],
  );

  // NOTE: all hooks must be declared before any early return (Rules of Hooks).
  // activeSession/activeHandle resolve to null/undefined when there is no
  // project, which is harmless - the runCommand body and the toolbar buttons
  // all guard on activeHandle themselves.
  const activeSession = sessions.find((s) => s.key === activeKey) ?? sessions[0] ?? null;
  const activeHandle = activeSession ? handlesRef.current.get(activeSession.key) : undefined;

  // Run a saved quick-command: write the command to the active PTY so the
  // shell executes it immediately. Silently no-ops when no terminal is running
  // (no session yet, or the shell has exited) - matches the kill button's guard.
  //
  // Line endings: shell line editors (PowerShell PSReadLine, cmd cooked mode,
  // readline) commit the current line on a carriage return ("\r"), NOT on a
  // line feed ("\n"). xterm sends Enter as "\r" for normal typing, so we mirror
  // that. A bare "\n" is not a submit signal - feeding a multi-line command
  // like "cd ./dir\nnpm run dev\r" (only the final "\r") confuses the line
  // editor: it treats the whole block as one unsubmitted line, scrambles its
  // buffer, and ends up executing the lines OUT OF ORDER (repro: on PowerShell
  // the second line ran before the first). Normalizing every newline to "\r"
  // makes each line its own submit, preserving the user's intended order. Safe
  // for single-line commands too (no newlines -> unchanged).
  const runCommand = useCallback(
    (command: string) => {
      const id = activeHandle?.getTerminalId();
      if (id && activeHandle?.getStatus() === "running") {
        void api.terminal.write({ terminalId: id, data: `${command.replace(/\r\n|\n|\r/g, "\r")}\r` });
      }
    },
    [activeHandle],
  );

  // Open a NEW terminal tab, switch to it, and run the command there once its
  // PTY is ready. The actual write is deferred until the new TerminalView
  // reports status "running" (PTY spawn is async) — see the onStatusChange
  // handler in the render list below. This keeps the user's current terminal
  // untouched (e.g. a long-running dev server) while still showing the command
  // output immediately in a fresh tab.
  const runCommandInNewTerminal = useCallback(
    (command: string) => {
      if (!projectPath) return;
      const s = appendSession(projectPath);
      pendingCommandBySession.current.set(s.key, command);
      forceRender();
    },
    [projectPath, appendSession],
  );

  // 自定义 UI「运行终端命令」:新开一个页签跑(见 lib/terminalRunBus.ts)。
  useEffect(() => subscribeTerminalRunRequests(runCommandInNewTerminal), [runCommandInNewTerminal]);

  if (!projectPath) {
    return (
      <div data-cds="TerminalEmptyState" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-content-subtle">
          <IconTerminal2 size={20} />
        </div>
        <p className="text-code font-medium text-content-muted">{t("ide.files.noProjectTitle")}</p>
        <p className="text-[11px] leading-relaxed text-content-subtle">
          {t("ide.term.noProjectDesc")}
        </p>
      </div>
    );
  }

  // Tab titles read "<project name> <ordinal>" (e.g. "my-app 2"). The visible
  // strip only ever shows the current project's sessions, so resolving the
  // current project's name covers every tab; the path's basename is a fallback
  // for when the project row is (transiently) absent from the store.
  const projectName =
    projects.find((p) => p.path === projectPath)?.name ||
    projectPath.split(/[\\/]/).filter(Boolean).pop() ||
    projectPath;

  // Flatten every project's terminals into a single render list. All of them
  // stay mounted (cross-project keep-alive); visibility is decided per-entry
  // below. Computed from the ref source-of-truth each render.
  const allTermEntries: Array<{ s: TermSession; path: string }> = [];
  for (const [p, st] of termsRef.current) {
    for (const s of st.sessions) allTermEntries.push({ s, path: p });
  }

  return (
    <div data-cds="TerminalPanel" className="flex h-full min-h-0 flex-col">
      {/* Session tab strip + actions */}
      <div data-cds="TerminalToolbar" className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-edge px-1">
        <div ref={tabListRef} data-cds="TerminalTabList" role="tablist" aria-label={t("ide.term.tabs")}
          onKeyDown={(e) => {
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (!(e.target instanceof Element)) return;
            const currentTab = e.target.closest<HTMLButtonElement>("button[data-terminal-tab]");
            if (!currentTab) return;
            const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-terminal-tab]"));
            const next = terminalTabTarget(e.key, tabs.indexOf(currentTab), tabs.length);
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            const tab = tabs[next];
            tab?.focus({ preventScroll: true });
            tab?.click();
            if (tab) revealRailItemWithin(e.currentTarget, tab);
          }}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5">
          {sessions.map((s) => {
            const isActive = s.key === activeKey;
            // Derive the tab title at render so it re-localizes on locale switch.
            const sessionTitle = t("ide.term.tabTitle", { name: projectName, n: s.seq });
            return (
              <div
                key={s.key}
                data-cds="TerminalTab"
                data-active={isActive ? "true" : "false"}
                className={cn(
                  "group flex max-w-[11rem] shrink-0 items-center gap-0.5 rounded-[var(--radius-btn-xs)] px-1.5 py-0.5 text-[11px] transition-colors",
                  isActive
                    ? "bg-surface-hover font-medium text-content"
                    : "text-content-subtle hover:bg-surface-muted/50 hover:text-content-muted",
                )}
              >
                <button
                  type="button"
                  id={`terminal-tab-${s.key}`}
                  data-terminal-tab=""
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`terminal-panel-${s.key}`}
                  tabIndex={isActive ? 0 : -1}
                  className="min-h-8 min-w-0 truncate rounded-[var(--radius-btn-xs)] px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  onClick={() => {
                    if (!projectPath) return;
                    const st = termsRef.current.get(projectPath);
                    if (st && st.activeKey !== s.key) {
                      st.activeKey = s.key;
                      forceRender();
                    }
                  }}
                  title={s.detail ? `${sessionTitle} - ${s.detail}` : sessionTitle}
                >
                  {/* 【ARC-005 V2】终端标签状态点改用 CDS StatusDot：
                      运行/启动中 = 呼吸点，出错 = 红点，已退出 = 静态灰点
                      （与侧栏会话行、首屏自动化卡片同一套 6px 几何）。 */}
                  {(s.status === "running" || s.status === "starting") && (
                    <StatusDot kind="running" className="mr-1" />
                  )}
                  {s.status === "error" && <StatusDot kind="error" className="mr-1" />}
                  {s.status === "exited" && (
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-content-subtle" aria-hidden />
                  )}
                  {sessionTitle}
                </button>
                <button
                  type="button"
                  className={cn(
                    "cds-hover-ghost flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-btn-xs)] text-content-subtle transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    !isActive && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                  )}
                  title={t("ide.term.closeTerminal")}
                  aria-label={`${t("ide.term.closeTerminal")}: ${sessionTitle}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSessionAndRestoreFocus(s.key, e.currentTarget);
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            );
          })}
        </div>
        {/* Creating a tab is a toolbar action, not an existing role=tab.
            Keep it outside tablist for correct screen-reader roving focus. */}
        <button
          type="button"
          className="cds-hover-ghost flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-btn-xs)] text-content-subtle hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          ref={newTabButtonRef}
          title={t("ide.term.newTerminal")}
          aria-label={t("ide.term.newTerminal")}
          onClick={addSession}
        >
          <IconPlus size={13} />
        </button>

        <div data-cds="TerminalActions" className="flex shrink-0 items-center gap-0.5 border-l border-edge pl-1">
          <TerminalCommandsMenu onRun={runCommand} onRunInNewTerminal={runCommandInNewTerminal} />
          <IconBtn
            title={t("ide.term.clearScreen")}
            onClick={() => activeHandle?.clear()}
            disabled={!activeHandle}
          >
            <IconEraser size={13} />
          </IconBtn>
          <IconBtn
            title={t("ide.term.killProcess")}
            onClick={() => activeHandle?.kill()}
            disabled={!activeHandle || activeSession?.status !== "running"}
          >
            <IconPlayerStop size={13} />
          </IconBtn>
          <IconBtn
            title={t("ide.term.restart")}
            onClick={() => {
              // Clear scrollback then spawn a fresh PTY into the same view.
              activeHandle?.clear();
              activeHandle?.restart();
            }}
            disabled={!activeHandle}
          >
            <IconRefresh size={13} />
          </IconBtn>
        </div>
      </div>

      {/* Status line for exited/error */}
      {activeSession &&
        (activeSession.status === "exited" || activeSession.status === "error") && (
          <div data-cds="TerminalStatusLine" className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface px-2 py-1 text-[11px] text-content-muted">
            <span className="truncate">
              {activeSession.detail ??
                (activeSession.status === "error" ? t("ide.term.startFailed") : t("ide.term.exited"))}
            </span>
            <button
              type="button"
              className="cds-hover-ghost flex min-h-8 shrink-0 items-center rounded-[var(--radius-btn-xs)] px-2 text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => activeHandle?.restart()}
            >
              {t("ide.term.restart")}
            </button>
          </div>
        )}

      {/* Terminal hosts — keep ALL terminals across ALL projects mounted so
          PTYs + scrollback survive both intra-project tab switches and
          inter-project switches. Only the current project's active tab is
          visible; everything else is hidden via CSS (invisible) and its
          TerminalView is fed active=false so it skips fit/focus. */}
      <div data-cds="TerminalViewport" className="relative min-h-0 flex-1 bg-surface">
        {allTermEntries.map(({ s, path: p }) => {
          const st = termsRef.current.get(p);
          const isActive = p === projectPath && s.key === st?.activeKey;
          return (
            <div
              key={s.key}
              id={`terminal-panel-${s.key}`}
              role="tabpanel"
              aria-labelledby={`terminal-tab-${s.key}`}
              className={cn(
                "absolute inset-0",
                isActive ? "z-10" : "pointer-events-none invisible z-0",
              )}
              aria-hidden={!isActive}
              inert={!isActive}
            >
              <Suspense fallback={null}>
                <TerminalView
                  sessionKey={s.key}
                  projectPath={p}
                  active={active && isActive}
                  onStatusChange={(status, detail) => {
                    updateStatus(s.key, status, detail);
                    // Drain any command queued by runCommandInNewTerminal once the
                    // freshly spawned PTY is ready. Same newline normalization as
                    // runCommand (shell commits on "\r", not "\n").
                    if (status === "running") {
                      const cmd = pendingCommandBySession.current.get(s.key);
                      if (cmd) {
                        pendingCommandBySession.current.delete(s.key);
                        const id = handlesRef.current.get(s.key)?.getTerminalId();
                        if (id) {
                          void api.terminal.write({
                            terminalId: id,
                            data: `${cmd.replace(/\r\n|\n|\r/g, "\r")}\r`,
                          });
                        }
                      }
                    }
                  }}
                  onReady={(handle) => {
                    handlesRef.current.set(s.key, handle);
                  }}
                />
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "cds-hover-ghost flex size-8 items-center justify-center rounded-[var(--radius-btn-xs)] text-content-subtle hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
