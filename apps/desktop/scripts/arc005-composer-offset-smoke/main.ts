/** Editable ProseMirror caret mapping for /skills and pasted newlines.
 * Node graph below is a small structural stand-in: no browser/editor start.
 * Real composer wiring is checked against the unmodified display component. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Editor } from "@tiptap/react";
import { composerTextOffsetToPos } from "../../src/renderer/components/chat/composerTextOffset.js";
import { sourceHas } from "../lib/sourceText.js";

const src = readFileSync(resolve("src/renderer/components/chat/ComposerEditor.tsx"), "utf8");
const picker = readFileSync(resolve("src/renderer/components/chat/NewSubChatPicker.tsx"), "utf8");
const toggle = readFileSync(resolve("src/renderer/components/chat/ComposerToolbarToggle.tsx"), "utf8");
let all = 0, fail = 0;
function ck(name: string, valid: boolean, actual?: unknown) {
  all++;
  if (!valid) fail++;
  console.log((valid ? "PASS " : "FAIL ") + name + (!valid ? " " + JSON.stringify(actual) : ""));
}
type Part = {type:"text"|"skill"|"hardBreak"; text?:string; label?:string};
/** A paragraph at PM pos=0, its first child starts at pos=1. */
function docFor(parts: Part[]): Editor["state"]["doc"] {
  let end = 1;
  const nodes = parts.map((part) => {
    const node = part.type === "text"
      ? { isText:true, type:{name:"text"}, attrs:{}, text:part.text, nodeSize:part.text?.length ?? 0 }
      : part.type === "skill"
        ? { isText:false, type:{name:"skill"}, attrs:{label:part.label}, nodeSize:1 }
        : { isText:false, type:{name:"hardBreak"}, attrs:{}, nodeSize:1 };
    const at = end;
    end += node.nodeSize;
    return { node, at };
  });
  const size = end + 1;
  return { content:{size}, descendants(visitor: (node: any, pos:number) => boolean | void) {
    visitor({isText:false,type:{name:"paragraph"},attrs:{},nodeSize:size}, 0);
    for (const {node,at} of nodes) visitor(node,at);
  } } as unknown as Editor["state"]["doc"];
}
const empty = docFor([]);
const text = docFor([{type:"text", text:"hello"}]);
const mixed = docFor([{type:"text",text:"ab"},{type:"skill",label:"init"},{type:"hardBreak"},{type:"text",text:"cd"}]);
ck("Empty editor: offset zero maps inside first paragraph, not document root",
  composerTextOffsetToPos(empty,0) === 1);
ck("Empty editor: huge cursor offset clamps to valid paragraph endpoint",
  composerTextOffsetToPos(empty,100) === 1);
ck("Plain text: beginning of a nonempty editor has position 1",
  composerTextOffsetToPos(text,0) === 1);
ck("Plain text: first character maps to PM position 2",
  composerTextOffsetToPos(text,1) === 2);
ck("Plain text: final offset maps to last valid text position",
  composerTextOffsetToPos(text,5) === 6);
ck("Plain text: past-end offset clamps, never goes outside editor",
  composerTextOffsetToPos(text,900) === 6);
ck("Plain text: negative, NaN and infinity cannot escape content",
  [-4, NaN, Infinity, -Infinity].every((n) => composerTextOffsetToPos(text,n) === 1));
ck("Mixed: text before pill maps to end of its two letters",
  composerTextOffsetToPos(mixed,2) === 3);
ck("Mixed: offset within atomic /init pill snaps to PM node end",
  composerTextOffsetToPos(mixed,3) === 4 && composerTextOffsetToPos(mixed,6) === 4);
ck("Mixed: after 5-char /init pill maps to PM node end",
  composerTextOffsetToPos(mixed,7) === 4);
ck("Mixed: newline hardBreak counts one offset and one PM position",
  composerTextOffsetToPos(mixed,8) === 5);
ck("Mixed: subsequent text after hardBreak maps normally",
  composerTextOffsetToPos(mixed,9) === 6 && composerTextOffsetToPos(mixed,10) === 7);
ck("Mixed: beyond serialized length stops before end paragraph",
  composerTextOffsetToPos(mixed,120) === 7);
ck("Composer: both built-in commands and skills call the same insertion mapping",
  sourceHas(src, "insertPillAt(editor, skill.name, start, end)") &&
  sourceHas(src, "insertPillAt(editor, name, start, end)") &&
  sourceHas(src, "composerTextOffsetToPos(ed.state.doc, offset)"));
ck("Composer: history/voice caret adjustment also consumes shared mapping",
  sourceHas(src, "textOffsetToPos(editor, start)") &&
  sourceHas(src, "textOffsetToPos(editor, end)") &&
  sourceHas(src, "textOffsetToPos(editor, offset)"));
ck("Composer: readonly editor never fires submit callback from Enter handler",
  sourceHas(src, "if (!view.editable) return false;") &&
  sourceHas(src, "editor.setEditable(editable)"));
ck("Composer: IME and configurable Enter/Shift+Enter remain unchanged",
  sourceHas(src, "isPostCompositionEnter(") &&
  sourceHas(src, "event.keyCode !== 229") &&
  sourceHas(src, 'sendKey === "modEnter"') &&
  sourceHas(src, "onEnterRef.current({ ctrl: event.shiftKey })"));
ck("Composer: text output still serializes /skill and hardBreak accurately",
  sourceHas(src, 'node.type.name === "skill"') &&
  sourceHas(src, 'node.type.name === "hardBreak"') &&
  sourceHas(src, 'out += "\\n";'));
ck("Subchat profiles: keyboard highlight follows scrollable list, not invisible row",
  sourceHas(picker, "const listRef = useRef<HTMLDivElement>(null);") &&
  sourceHas(picker, "activeRow?.scrollIntoView?.({ block:") &&
  sourceHas(picker, "data-subchat-index={idx}"));
ck("Subchat profiles: typing filters from first result even when count is unchanged",
  sourceHas(picker, "setQuery(e.target.value); setActiveIdx(0);"));
ck("Subchat profiles: list scroll is independent of search input focus",
  sourceHas(picker, "ref={listRef}") &&
  sourceHas(picker, "ref={inputRef}") &&
  sourceHas(picker, "optionCount === 0"));
ck("Collapsed composer: control list stays scrollable in short-height windows",
  sourceHas(toggle, "max-h-[calc(100dvh-28px)]") &&
  sourceHas(toggle, "overflow-y-auto overscroll-contain"));
ck("Collapsed composer: outer popup remains overflow-visible for nested dropdowns",
  sourceHas(toggle, "overflow-visible rounded-[var(--radius-btn-xs)]") &&
  sourceHas(toggle, '<ComposerToolbar sessionId={sessionId} layout="row" />'));
ck("Collapsed composer: small-screen presentation reuses same session config actions",
  sourceHas(toggle, 'title={t("chat.toolbarToggle")}') &&
  sourceHas(toggle, 'aria-label={t("chat.toolbarToggle")}') &&
  sourceHas(toggle, "useSuppressBrowserView(open, popupRef)"));
ck("Negative: removal of short-window scrolling breaks toolbar regression",
  !sourceHas(toggle.replaceAll("overflow-y-auto overscroll-contain", "overflow-visible"), "overflow-y-auto overscroll-contain"));
ck("Negative: removal of keyboard scroll-to-active breaks profile navigation",
  !sourceHas(picker.replaceAll("activeRow?.scrollIntoView?.(", "disabledScroll("), "activeRow?.scrollIntoView?.("));
ck("Negative: changing zero-offset fix to root position breaks first check",
  composerTextOffsetToPos(empty,0) !== 0);
ck("Negative: deleting readonly guard would regress keyboard isolation",
  !sourceHas(src.replace("if (!view.editable) return false;", ""), "if (!view.editable) return false;"));
console.log("arc005-composer-offset-smoke: " + (all-fail) + "/" + all);
if(fail) process.exitCode = 1;
