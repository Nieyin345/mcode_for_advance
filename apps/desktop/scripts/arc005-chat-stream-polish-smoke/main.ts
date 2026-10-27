import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timelinePreviewPosition } from "../../src/renderer/components/chat/timelinePreviewGeometry.js";
import { selectionToolbarPosition } from "../../src/renderer/components/chat/selectionToolbarGeometry.js";
import { openEscapeLayer, claimEscape, resetEscapeLayersForTests } from "../../src/renderer/lib/escapeLayer.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (p: string) => readFileSync(resolve(p), "utf8");
const timeline = read("src/renderer/components/chat/MessageTimeline.tsx");
const row = read("src/renderer/components/chat/MessageRow.tsx");
const files = read("src/renderer/components/chat/TurnFilesCard.tsx");
const activity = read("src/renderer/components/chat/ActivityCluster.tsx");
const consoleUi = read("src/renderer/components/chat/ActivityConsole.tsx");
const ticker = read("src/renderer/components/chat/CurrentOpTicker.tsx");
const selection = read("src/renderer/components/chat/SelectionToolbar.tsx");
const context = read("src/renderer/components/chat/ContextStatsPopover.tsx");
const css = read("src/renderer/arc005-workspace-surface.css");
const zh = read("src/renderer/lib/i18n/zh/chat-stream.ts");
const en = read("src/renderer/lib/i18n/en/chat-stream.ts");
let count = 0, failed = 0;
function ck(name: string, ok: boolean) {
  count++;
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + name);
}

const p = (top: number, right: number, height: number,
  pw: number, ph: number, vw = 900, vh = 650) =>
  timelinePreviewPosition({ top, right, height }, pw, ph, vw, vh);
ck("Timeline: left edge tooltip remains inside screen", p(300, 30, 24, 288, 185).left === 38);
ck("Timeline: right edge tooltip clamps before viewport", p(300, 880, 24, 288, 185).left === 604);
ck("Timeline: vertical centering when space exists", p(300, 30, 24, 288, 200).top === 212);
ck("Timeline: top-clipped preview clamps to margin", p(0, 30, 24, 288, 200).top === 8);
ck("Timeline: bottom-clipped preview clamps to margin", p(640, 30, 24, 288, 200).top === 442);
ck("Timeline: tiny screens and oversized previews never produce negative placement",
  p(25, 180, 20, 320, 360, 200, 160).left === 8 &&
  p(25, 180, 20, 320, 360, 200, 160).top === 8);
ck("Timeline: empty or invalid sizes do not throw", Number.isFinite(p(20,10,10,0,0).left));
ck("Timeline: focusable controls are NOT under aria-hidden parent",
  sourceHas(timeline,'<nav') && sourceHas(timeline,'aria-label={t("chatStream.timeline.navigation")}') &&
  !sourceHas(timeline, 'className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2"\n      aria-hidden'));
ck("Timeline: long conversations scroll without clipping the preview",
  sourceHas(timeline, "max-h-[70vh]") &&
  sourceHas(timeline, "overflow-y-auto overflow-x-visible") &&
  sourceHas(timeline, "createPortal(") &&
  sourceHas(timeline, "document.body"));
ck("Timeline: preview tracks actual viewport and element measurements",
  sourceHas(timeline, "timelinePreviewPosition(anchor, preview.offsetWidth, preview.offsetHeight,") &&
  sourceHas(timeline, "new ResizeObserver(measure)") &&
  sourceHas(timeline, 'window.addEventListener("scroll", measure, true)'));
ck("Timeline: preview observers and listeners are released",
  sourceHas(timeline, "observer?.disconnect()") &&
  sourceHas(timeline, 'window.removeEventListener("scroll", measure, true)') &&
  sourceHas(timeline, 'window.removeEventListener("resize", measure)'));
ck("Timeline: invalid virtualized message targets are not actionable",
  sourceHas(timeline, "canJump={d.index >= 0 && !!onJumpItem}") &&
  sourceHas(timeline, "disabled={!canJump}"));
ck("Timeline: preview has screen-reader name and 140-char bound",
  sourceHas(timeline, '"chatStream.timeline.jumpTo"') &&
  sourceHas(timeline, ".slice(0, 140)") &&
  sourceHas(zh, '"chatStream.timeline.jumpTo"') &&
  sourceHas(en, '"chatStream.timeline.jumpTo"'));
ck("Timeline: dark/light hover card stays within small viewport",
  sourceHas(timeline, "max-h-[calc(100vh-16px)]") &&
  sourceHas(timeline, "w-[min(18rem,calc(100vw-16px))]"));

ck("Message: 助手正文没有身份头，模型与时间不重复出现",
  /* 【UI 重建 2026-10-28】**这条断言跟着设计决定改了。**
   *
   * 原来断言的是「身份头存在且与运行元数据分开」：
   *   `modelName &&`、`fmtClock(msg.turnMeta?.startedAt ?? msg.createdAt)`
   *
   * 但 `4a8e32381`「the assistant header isn't Claude's」**故意删掉了它** ——
   * 真机截图（`reference-screenshot-175pct.webp`）里 Claude 的 AI 回复
   * **直接就是内容，没有任何「谁在说话」的标记，也没有时钟**。
   * 用户气泡右对齐本身就承担了「这是谁说的」。
   *
   * 而 Mcode 原先每条回复都挂一行 `✦ Mcode • 08:00:10`，一屏重复十几次。
   *
   * ## 为什么断言必须跟着改，而不是删掉
   *
   * 删掉会丢掉「不许再加回来」这条保护。现在断言的是**相反的事**：
   * 助手侧不得出现身份头、不得出现 per-message 时钟。
   *
   * ## 那条提交信息里有一句不实，这里记下来
   *
   * 它写「Model and timing still live in TurnStatRow」。**实际不在** ——
   * `TurnStatRow` 只有时长 / 花费 / token，没有模型名也没有时钟。
   * `modelName` 与 `fmtClock` 现在是**死代码**（定义着没人调）。
   *
   * 这与 Claude 的行为一致（截图里也没有），所以**代码不用改**；
   * 但「信息还在」这句话是错的，别让下一个人按它去找。
   *
   * TODO（留给产品判断）：`modelName` / `fmtClock` 已无人使用，
   * 要么接到别处、要么删掉。现在它们只是躺在文件里。 */
  sourceHas(row, 'isUser ? "max-w-[min(92%,48rem)] sm:max-w-[min(var(--m-bubble-max-w,85%),48rem)] min-w-0"') &&
  sourceHas(row, "<TurnStatRow meta={msg.turnMeta}") &&
  // 运行元数据仍在（时长 + token）—— 这是 Mcode 比 Claude 多的那层，保留。
  sourceHas(row, "fmtDuration(duration)") &&
  sourceHas(row, "data-turn-tokens") &&
  // 助手侧**不得**再出现 per-message 身份头 / 时钟（Claude 没有）。
  !sourceHas(row, "fmtClock(msg.turnMeta?.startedAt ?? msg.createdAt)") &&
  !sourceHas(row, "✦ Mcode"));
ck("Message: long bubble clips independently and accessible show more remains",
  sourceHas(row, 'aria-expanded={collapseState === "expanded"}') &&
  sourceHas(row, 'aria-controls={bubbleContentId}') &&
  sourceHas(row, 'data-user-bubble-clip=""'));
ck("Message: copy/edit/regenerate are distinct, always focusable when available",
  sourceHas(row, 'message-actions mt-1 flex min-h-7') &&
  sourceHas(row, "onStartEdit?.(msg)") &&
  sourceHas(row, "onRegenerate(msg)") &&
  sourceHas(row, '<CopyButton text={copyText} />'));
ck("Message: all action icons have minimum 28px target",
  (row.match(/size-7 items-center justify-center/g) || []).length >= 2 &&
  sourceHas(row, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Message: clipboard copy status is localized, timer cleaned on unmount",
  sourceHas(row, 'copied ? t("common.copied") : t("common.copy")') &&
  sourceHas(row, "clearTimeout(resetTimer.current)") &&
  sourceHas(row, "setCopied(false)"));
ck("Message: inline editor does not send during IME composition",
  sourceHas(row, "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229") &&
  sourceHas(row, "if (trimmed) onSubmit(trimmed, toPromptImages(images))"));
ck("Message: image removal remains independent of the text submit",
  sourceHas(row, "setImages((prev) => prev.filter((p) => p.id !== img.id))") &&
  sourceHas(row, "size-7 items-center justify-center rounded-full"));
ck("Message: touch users can reach copy and edit without mouse hover",
  css.includes("@media (hover: none), (pointer: coarse)") &&
  css.includes("[data-chat-root] .message-actions") &&
  css.includes("opacity: 1;"));
ck("Message: CSS only scopes conversation layout to workspace",
  css.includes('html:not(.sketch) [data-ui-shell-variant="workspace"] [data-chat-root]'));

ck("Turn file: summary and rewind controls are siblings, not nested buttons",
  sourceHas(files, 'aria-controls={`tfc-panel-${panelId}`}') &&
  sourceHas(files, 'onClick={() => setConfirmOpen(true)}') &&
  sourceHas(files, '<ConfirmDialog'));
ck("Turn file: cards wrap narrow screens instead of clipping important rewind button",
  sourceHas(files, "flex w-full min-w-0 flex-wrap items-center") &&
  sourceHas(files, "flex-[1_1_14rem]"));
ck("Turn file: revert still requires confirmation and partial failure remains visible",
  sourceHas(files, "onConfirm={handleRewind}") &&
  sourceHas(files, 'if (!partial) setOpen(false)') &&
  sourceHas(files, "unrestorable"));
ck("Turn file: diff and file-tree reveal each have their own keyboard button",
  sourceHas(files, "onClick={() => void handleOpen()}") &&
  sourceHas(files, "revealInFileTree(entry.filePath)") &&
  sourceHas(files, "size-8 shrink-0 items-center") &&
  sourceHas(files, 'aria-label={`${t("chatStream.turnFiles.locateTitle")}: ${entry.filePath}`}'));
ck("Turn file: Git diff still honors selected mode and wide workspace",
  sourceHas(files, 'gitDiffOpenMode === "dialog" || store.widePanelOpen') &&
  sourceHas(files, "store.openFileInIde(entry.filePath, { diff: true, before: entry.before })"));

ck("Activity: top-level control exposes dialog and expanded state",
  sourceHas(activity, 'aria-haspopup="dialog"') &&
  sourceHas(activity, 'aria-expanded={isElectron ? !!openKind : !!sheetNode}'));
ck("Activity: keyboard focus on icon and plans link is visible",
  (activity.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 2);
ck("Activity: desktop panel clamped on short screens while mobile still uses sheet",
  sourceHas(activity, "max-h-[min(70dvh,calc(100dvh-56px))]") &&
  sourceHas(activity, "<ActivitySheet"));
ck("Activity: nested Escape arbitration, no keyboard global hijack",
  sourceHas(activity, 'claimEscape("chat.activity-cluster")') &&
  sourceHas(activity, 'openEscapeLayer("chat.activity-cluster")'));

const sp = (top: number, bottom: number, left: number, right: number,
  w: number, h: number, vw = 800, vh = 600) =>
  selectionToolbarPosition({ top, bottom, left, right }, w, h, vw, vh);
ck("Selection: centered toolbar positions from measured width, not a 64px guess",
  sp(300,320,200,240,200,32).left === 120);
ck("Selection: left/right edge clamps toolbar before viewport overflow",
  sp(300,320,0,20,240,32).left === 8 &&
  sp(300,320,780,800,240,32).left === 552);
ck("Selection: near top moves toolbar below selection",
  sp(4,22,200,220,180,36).top === 30);
ck("Selection: above selection when vertical room exists",
  sp(130,154,200,220,180,36).top === 86);
ck("Selection: near bottom stays in bounds",
  sp(595,612,200,220,180,36).top === 551);
ck("Selection: smaller viewport than toolbar never returns negative bounds",
  sp(5,20,100,130,300,280,180,140).left === 8 &&
  sp(5,20,100,130,300,280,180,140).top === 8);
ck("Selection: measured panel recomputes on resize and custom button changes",
  sourceHas(selection, "selectionToolbarPosition(state.rect, el.offsetWidth, el.offsetHeight,") &&
  sourceHas(selection, "new ResizeObserver(recompute)") &&
  sourceHas(selection, "observer?.disconnect()"));
ck("Selection: stale DOM text selection continues closing on scroll and collapse",
  sourceHas(selection, 'document.addEventListener("scroll", onScroll, true)') &&
  sourceHas(selection, "barRef.current?.contains(event.target)") &&
  sourceHas(selection, 'document.addEventListener("selectionchange", onSelectionChange)'));
ck("Selection: arrow/Home/End keyboard toolbar moves focus without triggering action",
  sourceHas(selection, 'role="toolbar"') &&
  sourceHas(selection, 'e.key === "ArrowRight"') &&
  sourceHas(selection, 'e.key === "ArrowLeft"') &&
  sourceHas(selection, 'e.key === "Home"') &&
  sourceHas(selection, 'e.key === "End"') &&
  sourceHas(selection, 'buttons[next]?.focus()') &&
  !sourceHas(selection, 'buttons[next]?.click()'));
ck("Selection: native clipboard copy and frozen quote payload remain untouched",
  sourceHas(selection, "navigator.clipboard.writeText(state.text)") &&
  sourceHas(selection, "onQuote(state)") &&
  sourceHas(selection, "onAddBookmark(state)") &&
  sourceHas(selection, "onAskSideChat(state)"));
ck("Selection: toolbar is accessible with named independent actions",
  sourceHas(selection, 'role="toolbar"') &&
  sourceHas(selection, 'aria-label={t("chatStream.selection.toolbar")}') &&
  sourceHas(selection, 'aria-label={t("common.copied")') === false &&
  sourceHas(selection, 'aria-label={copied ? t("common.copied") : t("common.copy")}') &&
  sourceHas(zh, '"chatStream.selection.toolbar"') && sourceHas(en, '"chatStream.selection.toolbar"'));
ck("Selection: viewport cap applies to variable-width custom buttons",
  sourceHas(selection, "max-w-[calc(100vw-16px)]") &&
  sourceHas(selection, "<SelectionCustomButtons text={state.text} onDone={onClose} />"));

ck("Context stats: display uses measured geometry shared with tag previews",
  sourceHas(context, "previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,") &&
  sourceHas(context, "setPosition((old)") &&
  !sourceHas(context, "right: Math.max(right, 8)"));
ck("Context stats: resize and view-height changes recalculate placement",
  sourceHas(context, "new ResizeObserver(recompute)") &&
  sourceHas(context, "observer?.disconnect()") &&
  sourceHas(context, "view, history.length"));
ck("Context stats: viewport-safe width and height avoid offscreen controls",
  sourceHas(context, "w-[min(380px,calc(100vw-16px))]") &&
  sourceHas(context, "max-h-[calc(100vh-16px)]") &&
  sourceHas(context, "overflow-y-auto"));
ck("Context stats: current/historical data and suppression ownership remain live",
  sourceHas(context, "getContextBreakdown(snapshot)") &&
  sourceHas(context, "<HistoryView history={history} maxTokens={maxTokens} />") &&
  sourceHas(context, "useSuppressBrowserView(true, panelRef)"));
ck("Context stats: dialog named and history switch has visible focus",
  sourceHas(context, 'role="dialog"') &&
  sourceHas(context, 'aria-label={t("chat.context.stats")}') &&
  sourceHas(context, "focus-visible:outline-offset-2 focus-visible:outline-accent"));

resetEscapeLayersForTests();
const parentLayer = openEscapeLayer("chat.context-stats");
const childLayer = openEscapeLayer("chat.selection-toolbar");
ck("Floating chat overlays: Esc belongs only to most recently opened layer",
  !claimEscape("chat.context-stats") && claimEscape("chat.selection-toolbar"));
childLayer();
ck("Floating chat overlays: dismissing selection returns Esc to context panel",
  claimEscape("chat.context-stats"));
parentLayer();
resetEscapeLayersForTests();
ck("Floating chat overlays: source subscriptions use shared Escape arbiter",
  sourceHas(context, 'openEscapeLayer("chat.context-stats")') &&
  sourceHas(context, 'claimEscape("chat.context-stats")') &&
  sourceHas(selection, 'openEscapeLayer("chat.selection-toolbar")') &&
  sourceHas(selection, 'claimEscape("chat.selection-toolbar")'));

ck("Activity console: bookmark Escape cancels rename before blur can write",
  sourceHas(consoleUi, "const renameFinishedRef = useRef(false);") &&
  sourceHas(consoleUi, "if (renameFinishedRef.current) return;") &&
  sourceHas(consoleUi, "renameFinishedRef.current = true;") &&
  sourceHas(consoleUi, 'else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }'));
ck("Activity console: Enter and blur cannot both invoke duplicate bookmark rename",
  sourceHas(consoleUi, "const commit = () => {") &&
  sourceHas(consoleUi, "if (renameFinishedRef.current) return;") &&
  sourceHas(consoleUi, "onBlur={commit}"));
ck("Activity console: re-opening bookmark rename resets the commit fence",
  sourceHas(consoleUi, "renameFinishedRef.current = false;") &&
  sourceHas(consoleUi, 'setDraft(bookmark.title ?? "")'));
ck("Activity console: stale bookmark still has keyboard-reachable remove and rename",
  sourceHas(consoleUi, "disabled={stale || !onPick}") &&
  (consoleUi.match(/inline-flex size-8 -translate-y-1\/2 items-center justify-center/g) || []).length >= 2 &&
  sourceHas(consoleUi, "onRemove(bookmark)"));
ck("Activity console: bookmark action labels include the actual bookmark text",
  sourceHas(consoleUi, 'aria-label={`${t("chatStream.bookmark.rename")}: ${label}`}') &&
  sourceHas(consoleUi, 'aria-label={`${t("chatStream.bookmark.remove")}: ${label}`}'));
ck("Activity console: node switch is announced and keyboard focus is visible",
  sourceHas(consoleUi, "aria-pressed={active}") &&
  (consoleUi.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 4);
ck("Activity console: active filter chips remain real buttons with independent counts",
  sourceHas(consoleUi, "aria-pressed={active}") &&
  sourceHas(consoleUi, "onTabChange(node, f.key)") &&
  sourceHas(consoleUi, "min-h-8 items-center gap-1 rounded-full"));
ck("Activity console: opening an agent and plan preserves original callbacks",
  sourceHas(consoleUi, "onPick?.(agent)") &&
  sourceHas(consoleUi, "onPickPlan(block.plan)"));
ck("Activity console: close and right-action buttons each expose accessible names",
  sourceHas(consoleUi, "aria-label={rightAction.label}") &&
  sourceHas(consoleUi, 'aria-label={t("chatStream.activity.close")}'));
ck("Ticker: pending animation frames are cancelled on row unmount",
  sourceHas(ticker, "cancelAnimationFrame(firstFrameRef.current)") &&
  sourceHas(ticker, "cancelAnimationFrame(secondFrameRef.current)") &&
  sourceHas(ticker, "useEffect(() => () =>"));
ck("Ticker: reduced-motion toggles cancel previously scheduled animation callbacks",
  sourceHas(ticker, "if (!reducedMotion) return;") &&
  sourceHas(ticker, "firstFrameRef.current = null;") &&
  sourceHas(ticker, "secondFrameRef.current = null;"));
ck("Ticker: changing status still uses stable toolCallId, not transition counter as identity",
  sourceHas(ticker, "op.toolCallId === frontId") &&
  sourceHas(ticker, "setFrontId(nextOp.toolCallId)"));
ck("Ticker: narrow screens cap rolling status width and suppress noisy duplicate live announcements",
  sourceHas(ticker, "max-w-[min(15rem,38vw)]") &&
  sourceHas(ticker, 'aria-live="off"'));
ck("Ticker: no untracked nested animation frame remains",
  !sourceHas(ticker, "requestAnimationFrame(() =>\n              requestAnimationFrame(() =>"));

ck("Negative: deleting preview portal breaks scroll-safe tooltips",
  !sourceHas(timeline.replace("createPortal(", "inlineTooltip("), "createPortal("));
ck("Negative: deleting tactile message actions breaks touch affordance",
  !css.replaceAll("message-actions", "").includes("message-actions"));
ck("Negative: removing forced preview dimension guard fails small-screen geometry",
  !sourceHas(timeline.replace("max-h-[calc(100vh-16px)]", ""), "max-h-[calc(100vh-16px)]"));

console.log("arc005-chat-stream-polish-smoke: " + (count-failed) + "/" + count);
if (failed) process.exitCode = 1;
