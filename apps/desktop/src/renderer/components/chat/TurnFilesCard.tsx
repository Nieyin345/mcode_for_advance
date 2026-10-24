import { useId, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { basename } from "@renderer/lib/path.js";
import { api } from "@renderer/lib/api.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useGitStore } from "@renderer/stores/gitStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFile,
  IconFocus,
  IconPlus,
  IconEdit,
} from "@renderer/lib/icons.js";

/**
 * "本轮修改" card - rendered INLINE in the message stream as a per-turn
 * trailing `kind: "turn-files"` block. Each turn that touched files keeps its
 * own card frozen in history (new turns add new cards; old cards stay as
 * read-only snapshots and are never deleted). On session reopen every
 * historical card is restored from the persisted message snapshot.
 *
 * One expand level: card folded -> "本轮修改了 N 个文件 +总A -总D". Expand to
 * see the file rows. Clicking a row opens that file's diff for review - WHERE
 * it opens follows the Git setting "差异打开方式" (center editor column, or the
 * floating multi-tab diff dialog). The card's frozen `before` is passed
 * through so HISTORICAL turns - whose snapshot is gone from the live
 * turn-files bucket - still diff against the current on-disk content.
 *
 * Rewind: only the LATEST turn's card (`isLatestTurn === true`) renders the
 * 撤销本轮 button - it restores files via the in-memory FileSnapshot (cleared
 * per turn, so only the most recent turn is rewindable). Older cards are
 * display-only; their rewind button is hidden. The rewind action is pulled
 * from the store directly (the card is the sole consumer), keeping the block
 * rendering path prop-free.
 *
 * Theme: neutral surface/edge tokens (no accent) - these are *completed*
 * file ops, not pending approvals. The +/- tallies keep accent/danger for
 * semantic color (green=added, red=deleted).
 */
export function TurnFilesCard({
  files,
  isLatestTurn,
  rewound,
  rewindPartial,
}: {
  files: TurnFileEntry[];
  /** True only on the latest turn's card - the "live" rewind (clears the
   *  card on success). Older cards rewind individually via the historical
   *  path (confirmed, marks the card in place). */
  isLatestTurn?: boolean;
  /** True once this turn's files have been rewound. The card stays in the
   *  stream but renders dimmed with a "已撤销" badge; the rewind button is
   *  hidden. */
  rewound?: boolean;
  /** 【MC-002】撤销**部分**完成:有文件没还原(failed)或有冲突没动(conflicts)。
   *  与 `rewound` 互斥 —— 有它就不是"整轮已撤销",卡片要保留撤销入口(可重试)并
   *  如实说清哪些文件没回去。
   *
   *  【T125】`unrestorable` 是第三类：**从来就没法撤销**（原内容不是合法 UTF-8，
   *  读不出 `before`）。它既不是"还原失败"也不是"之后又改过"—— 混进前两者都会
   *  让用户得到错误的原因。与 `failed`/`conflicts` 并列而不是合并。 */
  rewindPartial?: { failed: string[]; conflicts: string[]; unrestorable?: string[] };
}) {
  // Default expand state by lifecycle: the latest turn expands so the user
  // sees the fresh changes + rewind affordance; historical cards collapse to
  // a one-line summary (keeps the scroll-back history calm).
  const [open, setOpen] = useState(!!isLatestTurn);
  // rewindTurn comes from the store - invoked for both the latest turn
  // (clears the card) and historical turns (marks the card in place).
  const rewindTurn = useSessionStore((s) => s.rewindTurn);
  const { t } = useI18n();
  // Local rewind-in-flight flag so the button is disabled while the
  // IPC call is in progress (main also clears the card on its
  // `turn.rewound` event, but that takes a tick after the IPC resolves).
  const [rewinding, setRewinding] = useState(false);
  // Toggle to "撤销成功" briefly after success, so the user gets
  // confirmation before the card disappears (latest-turn) or flips to
  // the 已撤销 state (historical).
  const [done, setDone] = useState(false);
  // Controls the in-app confirmation dialog. Replaces native confirm() —
  // every rewind (latest or historical) now goes through this gate so the
  // action is never a single mis-click.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 【MC-012】折叠按钮 aria-controls 指向展开区。useId 给出稳定且唯一的 id(同一流里多张卡互不冲突)。
  const panelId = useId();

  const handleRewind = async () => {
    if (rewinding || rewound) return { ok: true };
    setRewinding(true);
    try {
      // targetFiles is ALWAYS passed — the event handler matches the card
      // by path-set and marks it `rewound: true` in place (the card stays
      // in the stream as a trace that this turn was rolled back), whether
      // this is the latest turn or a historical one. Confirmation is now
      // handled by the ConfirmDialog before this runs.
      const { failed, conflicts, unrestorable } = await rewindTurn(files, files.map((f) => f.filePath));
      const skipped = unrestorable ?? [];
      const partial = failed.length > 0 || conflicts.length > 0 || skipped.length > 0;
      // 【MC-002】**只有整轮都还原成功**才画「已撤销 ✓」并收起来。部分撤销时保留入口
      // —— 用户还得知道哪些没回去、能不能重试。从前无条件 `setDone(true)`,于是画着
      // 「已撤销 ✓」而磁盘上还有没还原的文件(破坏性动作,他不会再去看)。
      if (!partial) setDone(true);
      // **部分失败要说出来。** 主进程可能还原了一半(某个文件写不进去、或路径越界
      // 被拒),它如实把失败列表交回来。
      if (failed.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("store.toast.rewindPartial", { n: failed.length, total: files.length }),
          body: failed.join("\n"),
        });
      }
      // 【MC-002】"之后又被改过、故意没动"的文件单独报一句。它们不是"还原失败",
      // 是"再写回去会把后来的改动一起毁掉,所以原样留着"。混进上面那句会让用户
      // 以为是自己运气不好还原失败,实际是我们为了保护他的改动不动手。
      if (conflicts.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("store.toast.rewindConflicts", { n: conflicts.length }),
          body: conflicts.join("\n"),
        });
      }
      // 【T125】第三类：**本来就没法撤销**。既不能说"之后又改过"（假的），
      // 也不能说"还原失败"（也不对 —— 我们本来就不该动它）。
      if (skipped.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("store.toast.rewindUnrestorable", { n: skipped.length }),
          body: skipped.join("\n"),
        });
      }
      // 只有整轮成功才收起卡片(那之后文件列表就是过期的了);部分撤销要**留着展开**,
      // 让用户看清哪些没回去。
      if (!partial) setOpen(false);
      // 部分撤销已经把真实状态(徽标 + toast)明明白白报出来了,确认框可以关闭;
      // 只有**整轮失败**(下面的 catch)才必须把确认框留着报错。
      return { ok: true };
    } catch (err) {
      // **撤销失败不能说成功。** store 的 `rewindTurn` 从前把错误吞了、照样 resolve,
      // 于是这张卡画出「已撤销 ✓」而文件一个字节没回滚 —— 这是个破坏性动作,用户
      // 不会再回头看。现在 store 把真错抛出来,这里如实报一句。
      useToastStore.getState().push({
        kind: "error",
        title: t("store.toast.rewindFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      // 把失败抛回给 ConfirmDialog:让它**保留弹窗**并把原因显示出来,不假装撤销成功(UI-001)。
      throw err;
    } finally {
      setRewinding(false);
    }
  };

  // Group by kind for a compact summary line: "本轮修改了 N 个文件
  // (创建 X · 修改 Y)".
  const created = files.filter((f) => f.kind === "created").length;
  const modified = files.length - created;
  // Aggregate tallies across all files for the folded badge.
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }), { adds: 0, dels: 0 }),
    [files],
  );

  return (
    <div className={cn("mb-[5px] rounded-lg border border-edge bg-surface-muted/60 shadow-sm text-xs text-content-muted", rewound && "opacity-60")}>
      {/* 【MC-012】表头从前是 `div[role="button"] tabIndex=0`,**里面又套了可聚焦的
          <button>**(撤销本轮)—— 父 role=button 包含子 button,读屏器与键盘遍历都拿不准
          "回车到底触发折叠还是撤销"。现在拆成**同级**两个真控件:折叠是个真 `<button>`
          (aria-expanded/aria-controls),撤销按钮是它的**兄弟**、不再被任何 role=button 包住。 */}
      <div className="flex w-full items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`tfc-panel-${panelId}`}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left transition-colors hover:opacity-80"
        >
          <IconFile size={14} className="shrink-0 text-content-subtle" />
          <span className="whitespace-nowrap font-semibold text-content">
            <span className="tfc-long">{t("chatStream.turnFiles.titleLong", { n: files.length })}</span>
            <span className="tfc-short">{t("chatStream.turnFiles.titleShort", { n: files.length })}</span>
          </span>
          <span className="tfc-sub text-content-subtle">
            ({created > 0 ? t("chatStream.turnFiles.created", { n: created }) : ""}
            {created > 0 && modified > 0 ? " · " : ""}
            {modified > 0 ? t("chatStream.turnFiles.modified", { n: modified }) : ""})
          </span>
          {/* Aggregate change tallies - the headline number reviewers care about. */}
          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
            <span className="text-success">+{totals.adds}</span>
            <span className="text-danger">-{totals.dels}</span>
          </span>
          <span className="ml-auto text-content-subtle">
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </span>
        </button>
        {/* 撤销本轮:与折叠按钮**同级**的兄弟控件。已经撤销的卡片换成一个 danger 徽标。 */}
        <div className="ml-2 flex shrink-0 items-center gap-2">
          {/* 【MC-002】部分撤销:显示一个"部分撤销"N/M 的徽标(与「已撤销」区分),
              按钮**保留**(用户可重试)。整轮成功才走下面的「已撤销」徽标、隐藏按钮。 */}
          {rewindPartial !== undefined && (
            <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              {t("chatStream.turnFiles.rewindPartialBadge", {
                n: rewindPartial.failed.length + rewindPartial.conflicts.length,
                total: files.length,
              })}
            </span>
          )}
          {!rewound ? (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={rewinding || done}
              className="rounded-md bg-surface-hover px-3 py-1 font-medium text-content transition-colors hover:bg-edge disabled:cursor-not-allowed disabled:text-content-subtle"
              title={isLatestTurn ? t("chatStream.turnFiles.rewindLatestTitle") : t("chatStream.turnFiles.rewindHistoryTitle")}
            >
              {done ? t("chatStream.turnFiles.rewoundCheck") : rewinding ? t("chatStream.turnFiles.rewinding") : (
                <>
                  <span className="tfc-long">{t("chatStream.turnFiles.rewindLong")}</span>
                  <span className="tfc-short">{t("chatStream.turnFiles.rewindShort")}</span>
                </>
              )}
            </button>
          ) : (
            <span className="rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
              {t("chatStream.turnFiles.rewoundBadge")}
            </span>
          )}
        </div>
      </div>
      {rewindPartial !== undefined && (
          (rewindPartial.failed.length > 0 || rewindPartial.conflicts.length > 0 ||
            (rewindPartial.unrestorable?.length ?? 0) > 0)
        ) && (
        <div className="border-t border-edge px-3 py-1.5 text-[11px] text-warning">
          {rewindPartial.failed.length > 0 && (
            <div>{t("chatStream.turnFiles.partialFailed", { n: rewindPartial.failed.length })}</div>
          )}
          {rewindPartial.conflicts.length > 0 && (
            <div>{t("chatStream.turnFiles.partialConflicts", { n: rewindPartial.conflicts.length })}</div>
          )}
          {(rewindPartial.unrestorable?.length ?? 0) > 0 && (
            <div>{t("chatStream.turnFiles.partialUnrestorable", { n: rewindPartial.unrestorable!.length })}</div>
          )}
        </div>
      )}
      {open && (
        <div id={`tfc-panel-${panelId}`} className="space-y-1 border-t border-edge px-2 py-2">
          {files.map((f) => (
            <FileRow key={f.filePath} entry={f} />
          ))}
        </div>
      )}
      {/* In-app confirmation for rewind - replaces native confirm(). Every
          rewind (latest or historical) goes through this gate so the action
          is never a single mis-click. Historical rewinds use the danger
          variant since they can clobber later turns' edits to the same
          files. */}
      <ConfirmDialog
        open={confirmOpen}
        title={t("chatStream.turnFiles.confirmTitle")}
        danger={!isLatestTurn}
        description={
          isLatestTurn
            ? t("chatStream.turnFiles.confirmDescLatest")
            : (
              <>
                {t("chatStream.turnFiles.confirmDescHistory1")}
                <br />
                {t("chatStream.turnFiles.confirmDescHistory2")}
              </>
            )
        }
        confirmText={t("chatStream.turnFiles.rewindShort")}
        onOpenChange={setConfirmOpen}
        onConfirm={handleRewind}
      />
    </div>
  );
}

/** One row in the file list. The whole row is clickable: it opens this file's
 *  diff for review. WHERE it opens follows the Git setting "差异打开方式":
 *   - center (default): the center editor column, side-by-side diff using the
 *     card's frozen `before` vs the current on-disk content.
 *   - dialog: a floating multi-tab diff dialog (same one the Git panel uses),
 *     so several files can be reviewed side by side. `after` is left undefined
 *     so DiffPane reads the live working-tree file from disk.
 *
 *  The row is a div[role=button] (not a native button) because it CONTAINS a
 *  real button: the trailing locate icon reveals this file in the right
 *  panel's file tree (desktop only - nested buttons are invalid HTML).
 *  An external-link glyph before it signals the row-click diff affordance. */
function FileRow({ entry }: { entry: TurnFileEntry }) {
  const { t } = useI18n();
  const isCreated = entry.kind === "created";

  const handleOpen = async () => {
    const store = useSessionStore.getState();
    // The mobile shell has no editor column / diff dialog — open the turn
    // diff in the fullscreen mobile viewer instead (frozen `before` vs the
    // current on-disk content, rendered by the shared DiffView).
    if (!isElectron) {
      store.openMobileViewer({
        kind: "diff",
        name: basename(entry.filePath),
        path: entry.filePath,
        before: entry.before,
      });
      return;
    }
    // Resolve the file's owning repo so the dialog's left sidebar can show
    // working-tree status. discoverRepos scans the active project; we pick the
    // repo whose root is a prefix of this file's absolute path. Falls back to
    // the project root when no repo matches (the sidebar then just reads empty).
    let repoPath = "";
    const pid = store.activeProjectId;
    const projectPath = pid ? store.projects.find((p) => p.id === pid)?.path : undefined;
    if (projectPath) {
      try {
        const { repos } = await api.git.discoverRepos({ projectPath });
        // Normalize separators for a cross-platform prefix match.
        const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
        const fp = norm(entry.filePath);
        const match = repos.find((r) => {
          const rp = norm(r.path);
          return fp === rp || fp.startsWith(rp + "/");
        });
        repoPath = match?.path ?? projectPath;
      } catch {
        repoPath = projectPath;
      }
    }

    // Wide-panel (3:7) mode has NO center editor column — a center-mode open
    // would write invisible store state. Route to the floating diff dialog
    // there too, so the click always surfaces a visible side-by-side diff.
    if (useGitStore.getState().gitDiffOpenMode === "dialog" || store.widePanelOpen) {
      // Dialog open-mode: open (or refresh) a diff tab in the floating dialog.
      // `after` is omitted on purpose - DiffPane reads the live working-tree
      // file from disk, which is exactly the post-turn content we want to diff
      // against the frozen `before` snapshot.
      useGitStore.getState().openGitDiffDialogTab({
        id: `${entry.filePath}::turn`,
        filePath: entry.filePath,
        before: entry.before,
        title: basename(entry.filePath),
        repoPath,
        source: "working",
      });
      return;
    }

    // Center open-mode: open in the editor column with a side-by-side diff.
    // Deliberately no right-panel interaction (no files-tab switch, no panel
    // yank-open, no tree reveal) — the diff lives in the center pane; the
    // trailing locate button is the explicit opt-in for the tree.
    store.openFileInIde(entry.filePath, { diff: true, before: entry.before });
  };

  return (
    // 【MC-012】从前这一行是 `div[role="button"] tabIndex=0`,**里面又套了一个可聚焦的
    // <button>**(定位按钮)—— 嵌套的交互控件对读屏器与键盘遍历是坏的语义(两个可聚焦
    // 目标叠在一起、焦点顺序与"谁响应 Enter"都不清)。现在改成:外层只是普通的行容器
    // (鼠标点击照样打开差异,但**不可聚焦**),行内放两个**同级**的真实 button ——
    // 「打开差异」与「在文件树中定位」各自独立可聚焦、各有 aria-label,读屏能区分。
    <div
      className="flex w-full items-center gap-2 rounded-md bg-surface-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
    >
      <button
        type="button"
        onClick={() => void handleOpen()}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        title={t("chatStream.turnFiles.reviewDiff")}
        aria-label={`${t("chatStream.turnFiles.reviewDiff")}: ${entry.filePath}`}
      >
        <span aria-hidden title={isCreated ? t("chatStream.turnFiles.createdThisTurn") : t("chatStream.turnFiles.modifiedThisTurn")} className="shrink-0 text-content-subtle">
          {isCreated ? <IconPlus size={12} /> : <IconEdit size={12} />}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-content" title={entry.filePath}>
          {entry.filePath}
        </span>
        {/* Per-file change tallies. */}
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
          {entry.adds > 0 && <span className="text-success">+{entry.adds}</span>}
          {entry.dels > 0 && <span className="text-danger">-{entry.dels}</span>}
          {entry.adds === 0 && entry.dels === 0 && (
            <span className="text-content-subtle">{t("chatStream.turnFiles.noChanges")}</span>
          )}
        </span>
        {/* 【T125】不可还原：原内容不是合法 UTF-8（docx / 二进制 / GBK），
            读不出 before，撤销**不会动它**。必须写在行上 —— 否则用户看着
            「本轮文件」里有它、点撤销、以为一起还原了，而磁盘上它还是改后的样子。 */}
        {entry.restorable === false && (
          <span
            className="shrink-0 rounded bg-warning/15 px-1 py-0.5 text-[10px] text-warning"
            title={t("chatStream.turnFiles.unrestorableHint")}
          >
            {t("chatStream.turnFiles.unrestorableBadge")}
          </span>
        )}
        <IconExternalLink
          size={11}
          className={cn("ml-auto shrink-0 text-content-subtle")}
        />
      </button>
      {/* Locate this file in the right panel's file tree (expand ancestors +
          scroll to it) — a **sibling** button (not nested). Desktop only.
          【MC-012】热区:28×28 h-7 w-7,不是从前 p-0.5 包 12px 图标的 ≈16×16。 */}
      {isElectron && (
        <button
          type="button"
          onClick={() => useSessionStore.getState().revealInFileTree(entry.filePath)}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          title={t("chatStream.turnFiles.locateTitle")}
          aria-label={t("chatStream.turnFiles.locateTitle")}
        >
          <IconFocus size={12} className="block" />
        </button>
      )}
    </div>
  );
}

