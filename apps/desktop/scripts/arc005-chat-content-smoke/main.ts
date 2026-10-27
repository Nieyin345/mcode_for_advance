/** ARC-005 chat content regressions: real path resolution and component
 * wiring, no Electron/PTY or long-running browser processes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writePreviewBefore } from "../../src/renderer/components/chat/writePreviewSource.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (p: string) => readFileSync(resolve("src/renderer/components/chat", p), "utf8");
const blocks = read("MessageBlocks.tsx");
const markdown = read("Markdown.tsx");
const branch = read("BranchChoiceCard.tsx");
const plan = read("PlanStreamBlock.tsx");
const mail = read("AgentMailCard.tsx");
const mcp = read("McpToolDecisionCard.tsx");
const thinkingStart = blocks.indexOf("function ThinkingAccordion({");
const thinkingEnd = blocks.indexOf("/** A collapsible section", thinkingStart);
const thinkingAccordion = thinkingStart >= 0 && thinkingEnd > thinkingStart
  ? blocks.slice(thinkingStart, thinkingEnd)
  : "";
// 【UI 重建 2026-10-27】思考块的几何在 CSS 里（JSX 只留 data-cds 挂点）。
const thinkingCss = read("ClaudeThinkingAccordion.css");
let total = 0, failed = 0;
function ck(msg: string, ok: boolean) {
  total++;
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + msg);
}
const map = new Map([["/workspace/src/data.ts", "wrong"], ["/workspace/src/a.ts", "actual"]]);
ck("Write: exact source path returns correct pre-turn snapshot",
  writePreviewBefore(map, "/workspace/src/a.ts") === "actual");
ck("Write: short basename is segment matched, not accidental end-of-string match",
  writePreviewBefore(new Map([["/workspace/src/data.ts","wrong"]]), "a.ts") === undefined);
ck("Write: project-qualified relative path resolves against the proper segment",
  writePreviewBefore(map, "src/a.ts") === "actual");
ck("Write: distinct same-name files never silently pick one from arbitrary Map order",
  writePreviewBefore(new Map([["/src/one/index.ts","one"],["/src/two/index.ts","two"]]), "index.ts") === undefined);
ck("Write: explicit absolute target does not fall back to unrelated suffix",
  writePreviewBefore(new Map([["/project/tmp/src/a.ts","wrong"]]), "/src/a.ts") === undefined);
ck("Write: empty content snapshot stays a valid pre-turn value",
  writePreviewBefore(new Map([["/project/empty.ts",""]]), "empty.ts") === "");
ck("Write: Windows backslashes and case-insensitive drive paths preserve exact identity",
  writePreviewBefore(new Map([[String.raw`D:\\App\\SRC\\ReadMe.TS`, "snapshot"]]), "d:/app/src/readme.ts") === "snapshot");
ck("Write: Windows relative suffix handles slash and case normalization",
  writePreviewBefore(new Map([[String.raw`C:\\work\\APP\\SRC\\main.ts`, "snapshot"]]), "src/MAIN.ts") === "snapshot");
ck("Write: dot-relative paths are resolved on a complete segment boundary",
  writePreviewBefore(map, "./src/a.ts") === "actual");
ck("Write: UNC network share names are not mistaken for local project paths",
  writePreviewBefore(new Map([[String.raw`\\\\server\\share\\repo\\test.ts`, "network"]]), "//server/share/repo/test.ts") === "network");
ck("Write: unrelated windows sibling file is not treated as target",
  writePreviewBefore(new Map([[String.raw`C:\\work\\app-old\\src\\a.ts`, "wrong"]]), "C:/work/app/src/a.ts") === undefined);
ck("Write: no snapshots, invalid input and absent files return no fabricated before",
  writePreviewBefore(undefined, "foo.ts") === undefined &&
  writePreviewBefore(new Map(), "foo.ts") === undefined &&
  writePreviewBefore(map, "") === undefined &&
  writePreviewBefore(map, "missing.ts") === undefined);
ck("Write: runtime card consumes source guard instead of unsafe suffix match",
  sourceHas(blocks, "writePreviewBefore(beforeMap, filePath)") &&
  !sourceHas(blocks, "abs.endsWith(filePath)"));
ck("Write: existing before/new diff still uses actual lineDiff and safe raw fallback",
  sourceHas(blocks, "before !== undefined ? lineDiff(before, content) : null") &&
  sourceHas(blocks, "content || t(\"chatStream.emptyPlaceholder\")"));

ck("Tool batch: actual disclosure controls linked to uniquely identified details",
  sourceHas(blocks, "const panelId = useId();") &&
  sourceHas(blocks, "aria-controls={panelId}") &&
  sourceHas(blocks, 'id={panelId} className={cn("max-h-80'));
ck("Turn ledger: hidden but mounted body cannot receive keyboard focus",
  sourceHas(blocks, "aria-controls={blocks.length > 0 ? bodyId : undefined}") &&
  sourceHas(blocks, "inert={!open} aria-hidden={!open}") &&
  sourceHas(blocks, "chat-fold"));
ck("Thinking: live-state card keeps its real body expanded while running",
  sourceHas(blocks, "const isOpen = live || open;") &&
  sourceHas(blocks, "aria-controls={bodyId}") &&
  sourceHas(blocks, 'id={bodyId}') &&
  sourceHas(blocks, 'aria-disabled={live}'));
/* 【UI 重建 2026-10-27】思考块的**形态变了**，断言跟着改。
 *
 * 旧断言测的是「卡片框」：`rounded-[var(--radius-card)] border bg-surface`
 * + `px-3.5 py-2` 的标题行 + `p-3.5 font-mono` 的正文。
 *
 * 现在（与 Claude 一致）是**克制型**：整体透明无边框无阴影，标题行 28px，
 * 正文用左侧发丝边 + 内缩表示「从属关系」，而不是再套一张卡片。
 * 样式落在 `ClaudeThinkingAccordion.css`（JSX 里不再有那串 Tailwind）。
 *
 * 断言因此分两处：JSX 里有稳定的 `data-cds` 挂点，CSS 里有真实几何。 */
ck("Thinking: 克制型思考块（透明无框 + 28px 标题行 + 左侧发丝边内容区）",
  sourceHas(thinkingAccordion, 'data-cds="ThinkingAccordion"') &&
  sourceHas(thinkingAccordion, 'data-cds="ThinkingAccordionHeader"') &&
  sourceHas(thinkingAccordion, "flex items-center gap-2 select-none") &&
  sourceHas(thinkingAccordion, "text-left text-content-muted") &&
  // CSS 那侧的几何：透明底、28px 行高、内容区左发丝边。
  sourceHas(thinkingCss, "background: transparent") &&
  sourceHas(thinkingCss, "min-height: 28px") &&
  sourceHas(thinkingCss, "border-left: 1px solid rgb(") &&
  // 负控：不许退回「每块都套一张卡片」的旧形态。
  !sourceHas(thinkingAccordion, "rounded-[var(--radius-card)] border border-edge bg-surface"));
ck("Thinking: Copy as quote is a separate localized control with guarded clipboard feedback",
  sourceHas(thinkingAccordion, "navigator.clipboard.writeText") &&
  sourceHas(thinkingAccordion, "text.split(") &&
  sourceHas(thinkingAccordion, ".join(") &&
  sourceHas(thinkingAccordion, 't("chatStream.copyQuote")') &&
  sourceHas(thinkingAccordion, "copiedTimer.current") &&
  sourceHas(thinkingAccordion, "clearTimeout(copiedTimer.current)") &&
  sourceHas(thinkingAccordion, "catch {") &&
  sourceHas(thinkingAccordion, 'aria-label={copied ? t("common.copied") : t("chatStream.copyQuote")}'));
ck("Shared collapsible: details use ID linked to header with meaningful aria state",
  sourceHas(blocks, "function Collapsible") &&
  sourceHas(blocks, "const bodyId = useId();") &&
  sourceHas(blocks, "aria-expanded={open}"));
ck("Edit, Write and generic tools all associate disclosure with their own details",
  (blocks.match(/aria-controls=\{bodyId\}/g) || []).length >= 7 &&
  (blocks.match(/<div id=\{bodyId\} className=\{cn\("space-y-2 py-2 pl-2"/g) || []).length === 3);
ck("File-bearing generic cards associate both action buttons with one detail region",
  sourceHas(blocks, 'aria-label={`${block.toolName}: ${open ? t("chatStream.showLess") : t("chatStream.showMore")}`}') &&
  (blocks.match(/aria-controls=\{bodyId\}/g) || []).length >= 7);
ck("Recycled virtual rows no longer attempt after-paint scroll on disconnected header",
  sourceHas(blocks, "if (!btn.isConnected) return;"));
ck("Image gallery: full-screen gallery navigation stays wired to original images",
  sourceHas(blocks, 'gallery={allSrcs}') &&
  sourceHas(blocks, "onNavigate={setIdx}") &&
  sourceHas(blocks, "onClick={() => go(-1)}") &&
  sourceHas(blocks, "onClick={() => go(1)}"));
ck("Image gallery: prev and next arrows have 36px focusable pointer target",
  (blocks.match(/size-9 -translate-y-1\/2 items-center justify-center/g) || []).length === 2 &&
  sourceHas(blocks, 'aria-label={t("chatStream.gallery.prev")}') &&
  sourceHas(blocks, 'aria-label={t("chatStream.gallery.next")}'));

ck("Markdown: highlighter loads in committed effect, never sets state in useMemo render",
  sourceHas(markdown, "void ensureHighlighter().then(") &&
  sourceHas(markdown, "return () => { active = false; };") &&
  !sourceHas(markdown, "useMemo(() => {\n      if (!highlighterInstance)"));
ck("Markdown: failing clipboard does not claim success or produce unhandled rejection",
  sourceHas(markdown, "try {\n      await navigator.clipboard.writeText(text);") &&
  sourceHas(markdown, "if (!mounted.current) return;") &&
  sourceHas(markdown, "catch {"));
ck("Markdown: clipboard feedback timer cancelled on unmount and repeat copy",
  sourceHas(markdown, "clearTimeout(timer.current)") &&
  sourceHas(markdown, "setCopied(false); timer.current = null;"));
ck("Markdown: copy button announces current localized state and can be keyboard-focused",
  sourceHas(markdown, 'aria-label={copied ? t("common.copied") : t("chatStream.copyCode")}') &&
  sourceHas(markdown, "min-h-8 items-center gap-1"));
/* 【UI 重建 2026-10-27】代码块的**几何已迁到 CSS**，JSX 只剩挂点与交互。
 *
 * 旧断言测的是 JSX 里的 Tailwind 串（`px-3.5 py-0` / `p-3.5 font-mono`）。
 * 现在样式住在 `ClaudeCodeBlock.css`，断言因此分两处：
 * JSX 侧要「有稳定的挂点 + 复制动作仍是文字优先」，CSS 侧要「有真实几何」。 */
const codeBlockCss = read("ClaudeCodeBlock.css");
ck("Markdown: fenced code block uses Claude-like header/body spacing and text-first copy action",
  // CSS 侧：容器有发丝边 + 圆角；标题行有下边框 + 内边距；正文有内边距。
  sourceHas(codeBlockCss, "border: 1px solid rgb(var(--edge)") &&
  sourceHas(codeBlockCss, "border-radius: var(--radius-code") &&
  sourceHas(codeBlockCss, "padding-inline: 12px") &&
  sourceHas(codeBlockCss, "border-bottom: 1px solid rgb(var(--edge)") &&
  // JSX 侧：复制动作是**文字优先**（复制 → 已复制），两态都带图标。
  sourceHas(markdown, 'copied ? t("common.copied") : t("chatStream.copyCode")') &&
  sourceHas(markdown, 'IconCheck size={12}') &&
  sourceHas(markdown, '{t("chatStream.copyCode")}'));
ck("Markdown: long code preview remeasures after resize and syntax highlighting",
  sourceHas(markdown, "new ResizeObserver(remeasure)") &&
  sourceHas(markdown, 'window.addEventListener("resize", remeasure)') &&
  sourceHas(markdown, "observer?.disconnect()"));
ck("Markdown: expand and collapse retain native buttons and explicit content relationship",
  sourceHas(markdown, "aria-controls={bodyId}") &&
  sourceHas(markdown, "aria-expanded={expanded}") &&
  sourceHas(markdown, "id={bodyId}"));
ck("Markdown: local links and images still use project-scoped file resolution",
  sourceHas(markdown, "isLocalFileHref(raw)") &&
  sourceHas(markdown, "resolveMarkdownImageRoute(filePath, library)") &&
  sourceHas(markdown, "fileHrefToPath(raw)"));
ck("Workflow branch: synchronous in-flight guard prevents duplicate choice submission",
  sourceHas(branch, "const sendingRef = useRef(false)") &&
  sourceHas(branch, "busy || sendingRef.current") &&
  sourceHas(branch, "sendingRef.current = true;") &&
  sourceHas(branch, "sendingRef.current = false;"));
ck("Workflow branch: still posts authoritative run and node identity, not invented choice",
  sourceHas(branch, "api.workflow.choose({") &&
  sourceHas(branch, "runId: block.runId") &&
  sourceHas(branch, "nodeId: block.nodeId") &&
  sourceHas(branch, "edgeId,"));
ck("Workflow branch: option state and comment are keyboard accessible",
  sourceHas(branch, "aria-pressed={picked === o.id}") &&
  sourceHas(branch, 'aria-label={t("chatStream.workflowChoice.comment")}') &&
  sourceHas(branch, "min-h-9 items-center") &&
  sourceHas(branch, 'role="status" aria-live="polite"'));
ck("Workflow branch: stop remains a separate explicit user choice",
  sourceHas(branch, "send(BRANCH_STOP_CHOICE)") &&
  sourceHas(branch, "disabled={picked.length === 0 || busy}"));
ck("Plan: no dead link if full viewer unavailable",
  sourceHas(plan, "disabled={!onOpenPlan}") &&
  sourceHas(plan, "onOpenPlan?.(plan)") &&
  sourceHas(plan, 'aria-label={`${t("chat.plan.viewFullTitle")}: ${title}`}'));
ck("Plan: phase and pending-approval indicator use original state",
  sourceHas(plan, 'phase === "drafting"') &&
  sourceHas(plan, "hasApproval ? t(") &&
  sourceHas(plan, "extractPlanTitle(plan)"));
ck("Plan: title and preview wrap inside narrow viewport",
  sourceHas(plan, "min-w-0 flex-1 truncate") &&
  sourceHas(plan, "min-w-0 overflow-hidden break-words"));
ck("Agent mail: sending/failed/incoming content still uses shared parser",
  sourceHas(mail, "readOutgoingMail(block.toolName, block.input)") &&
  sourceHas(mail, "parseIncomingMail(raw)") &&
  sourceHas(mail, 'block.status === "error"'));
ck("Agent mail: long source agent and message body cannot expand workspace",
  sourceHas(mail, "my-1 min-w-0 max-w-full overflow-hidden") &&
  sourceHas(mail, "min-w-0 break-words font-medium") &&
  sourceHas(mail, "min-w-0 max-w-full break-words"));
ck("MCP: remains read-only with true status semantics",
  sourceHas(mcp, "mcpCardOutcome(status, result)") &&
  sourceHas(mcp, 'aria-busy={outcome === "running"}') &&
  sourceHas(mcp, 'role="status" aria-live="polite" aria-atomic="true"'));
ck("MCP: long provider labels and statuses fit narrow chat panes",
  sourceHas(mcp, "flex min-w-0 flex-wrap items-center justify-between") &&
  sourceHas(mcp, "min-w-0 flex-1 truncate font-mono") &&
  sourceHas(mcp, "min-h-6 shrink-0 items-center"));
ck("Tool rows: all disclosure headers share a padded hit area and align with nested details",
  // 【UI 重建 2026-10-27】工具行高度从写死 `min-h-8`（32px）改成
  // `--m-h-control`（26px，Claude 的真实控件档）。断言跟着认变量，
  // 这样密度档切换时行高自动跟随，而断言不必再改。
  sourceHas(blocks, 'const TOOL_ROW_CLS =\n  "flex min-h-[var(--m-h-control,26px)] w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1') &&
  sourceHas(blocks, 'const TOOL_BODY_RULE_CLS = "ml-2 border-l-[length:var(--hairline)] border-edge"'));
ck("Tool details: Edit, Write and generic payloads use one readable, bounded code surface",
  sourceHas(blocks, 'function ToolDetailSection({ label, children, maxHeightClass = "max-h-60" }') &&
  sourceHas(blocks, 'data-cds="ToolDetailSection"') &&
  sourceHas(blocks, "border border-edge/60 bg-surface-muted/40 p-3 font-mono leading-relaxed") &&
  (blocks.match(/<ToolDetailSection label={t\("chatStream\.tool\.result"\)}/g) || []).length === 3 &&
  sourceHas(blocks, '<ToolDetailSection label={t("chatStream.tool.input")}>') &&
  sourceHas(blocks, '<ToolDetailSection label={t("chatStream.diff.newFileContent")} maxHeightClass="max-h-80">'));

ck("Negative: reverting the Write path lookup contract is detectable",
  !sourceHas(blocks.replace("writePreviewBefore(beforeMap, filePath)", "unsafePrefixMatch(filePath)"), "writePreviewBefore(beforeMap, filePath)"));
ck("Negative: removal of the ledger inert guard is detectable",
  !sourceHas(blocks.replace("inert={!open} aria-hidden={!open}", ""), "inert={!open} aria-hidden={!open}"));
console.log("arc005-chat-content-smoke: " + (total-failed) + "/" + total);
if (failed) process.exitCode = 1;
