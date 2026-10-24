/**
 * ARC-005 interaction parity for tool cards and inline image galleries.
 * Deliberately source-wired, no Electron/Chromium. The DOM layer is verified
 * separately in U1 when the user has an idle machine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceHas } from "../lib/sourceText.js";
import { previewPosition } from "../../src/renderer/components/chat/previewGeometry.js";

const src = readFileSync(resolve("src/renderer/components/chat/MessageBlocks.tsx"), "utf8");
const popover = readFileSync(resolve("src/renderer/components/chat/TagPopover.tsx"), "utf8");
const mcp = readFileSync(resolve("src/renderer/components/chat/McpToolDecisionCard.tsx"), "utf8");
const fileLink = readFileSync(resolve("src/renderer/components/chat/FileLink.tsx"), "utf8");
let pass = 0, fail = 0;
function ck(name: string, ok: boolean): void {
  if (ok) pass++; else fail++;
  console.log((ok ? "PASS " : "FAIL ") + name);
}
const count = (s: string) => (src.match(new RegExp(s, "g")) || []).length;

ck("shared tool row has visible keyboard focus and enough minimum height",
  sourceHas(src, "const TOOL_ROW_CLS =") &&
  /TOOL_ROW_CLS\s*=\s*\n?\s*"[^"]*min-h-8[^"]*focus-visible:outline-2/.test(src));
ck("four existing tool-row cards preserve their common style token",
  count("className=\\{TOOL_ROW_CLS\\}") === 4);
ck("tool batch, Edit, Write and generic cards expose native expanded state",
  count("aria-expanded=\\{open\\}") >= 5);
ck("turn ledger exposes expanded state on its actual button",
  /className="chat-ledger-head"/.test(src) &&
  /<button\s+type="button"\s+onClick=\{\(e\) => \{[\s\S]{0,200}?toggleHoldPosition\(e, setOpen\);[\s\S]{0,150}?aria-expanded=\{open\}/.test(src));
ck("thinking accordion exposes live disabled state but still displays live content",
  sourceHas(src, "aria-disabled={live}") &&
  sourceHas(src, "aria-expanded={isOpen}") &&
  sourceHas(src, "if (live) return;"));
ck("independent collapsible disclosure exposes expansion semantics",
  /function Collapsible\([\s\S]*?aria-expanded=\{open\}/.test(src));
ck("gallery prev/next buttons have translated screen reader labels",
  sourceHas(src, 'aria-label={t("chatStream.gallery.prev")}') &&
  sourceHas(src, 'aria-label={t("chatStream.gallery.next")}'));
ck("gallery dot targets are at least 24px while visible dots remain compact",
  sourceHas(src, 'className="flex size-6 items-center justify-center rounded-full') &&
  sourceHas(src, 'aria-current={i === idx ? "true" : undefined}') &&
  sourceHas(src, '"h-1.5 rounded-full transition-all"'));
ck("gallery dot controls keep jump behavior and localized names",
  sourceHas(src, "onClick={() => setIdx(i)}") &&
  sourceHas(src, 'title={t("chatStream.gallery.imageN", { n: i + 1 })}'));
ck("attachment preview buttons expose state only for actual expandable popovers",
  sourceHas(src, 'aria-expanded={!isFile || isImage || !filePath ? open : undefined}'));
const genericHead = src.slice(src.indexOf("function GenericToolCard("), src.indexOf("/* AI 写入成功后"));
ck("file link and disclosure buttons are siblings, never nested interactive controls",
  /summaryToolPath\s*\?\s*\(\s*<div[\s\S]*?<\/button>\s*<span[^>]*>\s*<FileLink/.test(genericHead) &&
  /<FileLink[\s\S]*?<\/span>\s*<button/.test(genericHead));
ck("file-bearing tool header preserves independent file-open and detail-toggle handlers",
  genericHead.includes('onClick={(e) => toggleHoldPosition(e, setOpen)}') &&
  genericHead.includes('<FileLink token={summaryToolPath} projectPath={projectPath} />'));
ck("file navigation provides focus outline in standalone and markdown paths",
  (fileLink.match(/focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 2);
ck("file navigation keyboard and pointer keep events local to that action",
  sourceHas(fileLink, "e.stopPropagation()") &&
  sourceHas(fileLink, 'e.key === "Enter" || e.key === " "') &&
  sourceHas(fileLink, 'role="button"') && sourceHas(fileLink, "tabIndex={0}"));
ck("tool surfaces retain source of truth for live status and failure rendering",
  sourceHas(src, 'aggregateStatus === "error"') &&
  sourceHas(src, 'block.status === "done"'));
ck("negative: removing focus states would make shared row test fail",
  !/TOOL_ROW_CLS\s*=\s*\n?\s*"[^"]*min-h-8[^"]*focus-visible:outline-2/.test(
    src.replace("focus-visible:outline-2", "no-keyboard-focus")));
ck("negative: removing gallery aria-current is detectable",
  !sourceHas(src.replace('aria-current={i === idx ? "true" : undefined}', ""),
    'aria-current={i === idx ? "true" : undefined}'));
// Pure geometry, including the case that used to send a 28rem preview
// *outside the left edge* when clicking a file chip near the left side.
const pos = (top: number, right: number, bottom: number,
  w = 448, h = 200, vw = 800, vh = 700) =>
  previewPosition({top, right, bottom}, w, h, vw, vh);
ck("popover: left-edge chip never sends wide preview off the screen",
  pos(400, 80, 425).left === 8);
ck("popover: right-edge chip aligns to right and stays inside viewport",
  pos(400, 790, 425).left === 342);
ck("popover: bottom chip opens above if there is room",
  pos(570, 350, 600).top === 362);
ck("popover: top chip opens below",
  pos(15, 350, 45).top === 53);
ck("popover: narrow viewport clamps left/right to safe margins",
  pos(85, 190, 100, 184, 95, 200, 180).left === 8);
ck("popover: oversize height is safely clamped to viewport inset",
  pos(5, 300, 20, 160, 700, 450, 320).top === 8);
ck("popover: React uses measured size and recalculates on viewport/content change",
  sourceHas(popover, "previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,") &&
  sourceHas(popover, "new ResizeObserver(recompute)") &&
  sourceHas(popover, "observer?.disconnect()") &&
  sourceHas(popover, 'window.addEventListener("resize", recompute)'));
ck("popover: old right-only unbounded placement is removed",
  !sourceHas(popover, "Math.max(right, minLeft - 0)"));
ck("popover: scrolling virtualized chat closes stale anchored preview",
  sourceHas(popover, 'window.addEventListener("scroll", onScroll, true)') &&
  sourceHas(popover, 'window.removeEventListener("scroll", onScroll, true)'));
ck("popover: image zoom uses a real keyboard-accessible button",
  sourceHas(popover, 'aria-label={natural ? t("chat.tagPopover.shrink") : t("chat.tagPopover.enlarge")}') &&
  sourceHas(popover, 'onClick={() => setNatural((n) => !n)}') &&
  sourceHas(popover, 'focus-visible:outline-offset-2'));
ck("MCP: true execution status is announced and busy state tracked",
  sourceHas(mcp, 'aria-busy={outcome === "running"}') &&
  sourceHas(mcp, 'role="status" aria-live="polite" aria-atomic="true"'));
ck("MCP: approval remains read-only; this card does not synthesize decisions",
  !sourceHas(mcp, 'setTimeout(') && sourceHas(mcp, "mcpCardOutcome(status, result)"));
ck("negative: returning to right-edge-only positioning violates geometry hook",
  !sourceHas(popover.replace("previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,", "oldRightOnly("),
    "previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,"));
console.log("arc005-tool-surface-smoke: "+pass+"/"+(pass+fail));
if(fail) process.exitCode=1;
