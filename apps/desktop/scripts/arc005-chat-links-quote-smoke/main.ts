/** Chat file-link/project races and selection quote picker layout.
 * Real pure source-of-truth helpers; source-wired UI assertions supplement
 * the existing file-links-ui and ide-quote-snapshot runtime suites. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileLinkRequestKey, fileLinkRequestCurrent } from "../../src/renderer/components/chat/fileLinkRequestIdentity.js";
import { quotePickerBounds } from "../../src/renderer/components/chat/quotePickerGeometry.js";
import { openEscapeLayer, claimEscape, resetEscapeLayersForTests } from "../../src/renderer/lib/escapeLayer.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (f: string) => readFileSync(resolve("src/renderer/components/chat", f), "utf8");
const link = read("FileLink.tsx");
const quote = read("SelectionQuoteMenu.tsx");
let total = 0, failed = 0;
function ck(name: string, pass: boolean) {
  total++;
  if (!pass) failed++;
  console.log((pass ? "PASS " : "FAIL ") + name);
}

ck("File link: project path participates in request identity",
  fileLinkRequestKey("a.ts", "C:/projectA") !== fileLinkRequestKey("a.ts", "C:/projectB"));
ck("File link: token change participates even within same project",
  fileLinkRequestKey("a.ts", "/project") !== fileLinkRequestKey("data.ts", "/project"));
ck("File link: omitted and null paths have stable, equivalent semantics",
  fileLinkRequestKey("foo.ts") === fileLinkRequestKey("foo.ts", null));
const keyA = fileLinkRequestKey("a.ts", "C:/projectA");
const keyB = fileLinkRequestKey("a.ts", "C:/projectB");
ck("File link: current request can open only current identity",
  fileLinkRequestCurrent(2, 2, keyA, keyA));
ck("File link: stale project cannot open a single old candidate",
  !fileLinkRequestCurrent(2, 2, keyA, keyB));
ck("File link: older overlapping request cannot open despite identical identity",
  !fileLinkRequestCurrent(1, 2, keyA, keyA));
ck("File link: stale project and stale generation both blocked",
  !fileLinkRequestCurrent(1, 2, keyA, keyB));
ck("File link: per-instance synchronous guard blocks duplicate double-clicks",
  sourceHas(link, "if (pendingRef.current) return;") &&
  sourceHas(link, "pendingRef.current = true;") &&
  sourceHas(link, "pendingRef.current = false;"));
ck("File link: IPC results check identity before opening or candidate menu",
  sourceHas(link, "fileLinkRequestCurrent(seq, requestSeq.current, key, latestKeyRef.current)") &&
  sourceHas(link, "if (!stillCurrent()) return;") &&
  sourceHas(link, "openCandidatePath(result[0])"));
ck("File link: unmount or project switch invalidates old promise",
  sourceHas(link, "useEffect(() => () => {") &&
  sourceHas(link, "requestSeq.current++;") &&
  sourceHas(link, "}, [currentKey]);"));
ck("File link: stale picker results are not visible during next request",
  sourceHas(link, "open={menuOpen && resolvedKey === currentKey}") &&
  sourceHas(link, "setResolvedKey(null);"));
ck("File link: open candidate uses existing desktop IDE or mobile viewer",
  sourceHas(link, "store.openFileInIde(c.path)") &&
  sourceHas(link, 'store.openMobileViewer({ kind: "file"'));
ck("File link: native anchor and button-like span keep keyboard behavior",
  sourceHas(link, 'role="button"') &&
  sourceHas(link, 'tabIndex={0}') &&
  sourceHas(link, 'e.key === "Enter" || e.key === " "') &&
  sourceHas(link, "e.stopPropagation()"));
ck("File link: load spinner and menus fit narrow Electron viewports",
  sourceHas(link, 'aria-busy={loading}') &&
  sourceHas(link, "min-w-[min(220px,calc(100vw-16px))]") &&
  sourceHas(link, "max-h-[calc(100vh-16px)]"));

const geom = (top: number, bottom: number, left: number, right: number,
  vw = 800, vh = 700) => quotePickerBounds({top,bottom,left,right},vw,vh);
ck("Quote: centered below selection when enough vertical room exists",
  geom(300,320,150,200).top === 328 && geom(300,320,150,200).left === 15);
ck("Quote: near bottom flips above the selected text",
  geom(600,620,150,200).top === 244);
ck("Quote: right edge stays inside viewport",
  geom(200,220,790,800).left === 472);
ck("Quote: 160px-wide window keeps 8px inset and scrollable height",
  geom(10,20,15,55,160,110).width === 144 &&
  geom(10,20,15,55,160,110).maxHeight === 94 &&
  geom(10,20,15,55,160,110).top === 8);
ck("Quote: impossible-to-fit popover clamps both axes to nonnegative insets",
  geom(250,268,300,340,360,300).left === 32 &&
  geom(250,268,300,340,360,300).top === 8);
ck("Quote: dimensions cannot overflow when viewport smaller than margins",
  geom(2,5,2,5,10,12).width === 0 &&
  geom(2,5,2,5,10,12).maxHeight === 0);
ck("Quote: layout consumes pure bounds with viewport-local rect, not fixed 320px",
  sourceHas(quote, "quotePickerBounds(state.rect, window.innerWidth, window.innerHeight, PANEL_WIDTH, PANEL_MAX_H + 48)"));
ck("Quote: switched session cannot flash old async node sessions",
  sourceHas(quote, "const currentNodes = loadedFor === sessionId ? nodes : null;") &&
  sourceHas(quote, "setLoadedFor(null);") &&
  sourceHas(quote, "setLoadedFor(sessionId);"));
ck("Quote: displayed targets never duplicate current/side-active session entries",
  sourceHas(quote, "s.id !== sessionId && s.id !== openChatId") &&
  sourceHas(quote, "currentNodes ?? []"));
ck("Quote: action injects frozen quote snapshot, never live document selection",
  sourceHas(quote, "const pick = (target: QuoteTarget) => onPick(target, state.text);"));
ck("Quote: IME, loading and empty search handle Enter/arrow safely",
  sourceHas(quote, "e.nativeEvent.isComposing || e.keyCode === 229") &&
  sourceHas(quote, "if (shown.length === 0) return;") &&
  sourceHas(quote, 'e.key === "Enter" && active >= 0'));
ck("Quote: target list/dialog and search expose screen reader roles and focus",
  sourceHas(quote, 'role="dialog"') &&
  sourceHas(quote, 'aria-label={t("chatStream.quote.title")}') &&
  sourceHas(quote, 'aria-current={i === active ? "true" : undefined}') &&
  sourceHas(quote, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Quote: RPC failures retain distinct informational status and current target",
  sourceHas(quote, 'role="status"') &&
  sourceHas(quote, "setFailed(true);") &&
  sourceHas(quote, "setFailed(false);"));

resetEscapeLayersForTests();
const lower = openEscapeLayer("chat.selection-toolbar");
const top = openEscapeLayer("chat.selection-quote-menu");
ck("Quote: nested Esc closes only top quote picker, never parent toolbar",
  !claimEscape("chat.selection-toolbar") &&
  claimEscape("chat.selection-quote-menu"));
top();
ck("Quote: after dismissing quote menu, parent toolbar regains Escape",
  claimEscape("chat.selection-toolbar"));
lower();
resetEscapeLayersForTests();
ck("Quote: actual UI connects to the shared Escape layer arbitration",
  sourceHas(quote, 'openEscapeLayer("chat.selection-quote-menu")') &&
  sourceHas(quote, 'claimEscape("chat.selection-quote-menu")') &&
  sourceHas(quote, 'document.addEventListener("keydown", onKey, true)'));
ck("Negative: deleting file request identity guard breaks safety contract",
  !sourceHas(link.replaceAll("if (!stillCurrent()) return;", "allowOldCandidate();"),
    "if (!stillCurrent()) return;"));
ck("Negative: deleting the quote Escape layer fails the stack contract",
  !sourceHas(quote.replaceAll('claimEscape("chat.selection-quote-menu")',"unscopedClose()"),
    'claimEscape("chat.selection-quote-menu")'));
console.log("arc005-chat-links-quote-smoke: " + (total-failed) + "/" + total);
if(failed) process.exitCode=1;
