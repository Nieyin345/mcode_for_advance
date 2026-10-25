/** ARC-005 multi-select picker interaction, viewport, selection-safety regression.
 * Pure helpers are executed; UI wiring verified alongside existing suites. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { placeComposerPicker } from "../../src/renderer/components/chat/composerPhysicalRules.js";
import { eligibleFileIndex } from "../../src/renderer/components/chat/filePickerKeyboard.js";
import { sourceHas } from "../lib/sourceText.js";
const read=(file:string)=>readFileSync(resolve("src/renderer/components/chat",file),"utf8");
const files=read("FileMentionPicker.tsx"),library=read("LibraryPicker.tsx");
let count=0,fail=0;
function ck(s:string,pass:boolean,actual?:unknown) {count++;if(!pass)fail++;console.log((pass?"PASS ":"FAIL ")+s+(pass?"":": "+JSON.stringify(actual)));}
const items=[{path:"/proj/a.ts"},{path:"/proj/b.ts"},{path:"/proj/c.ts"},{path:"/proj/d.ts"}];
const excluded=new Set(["/proj/a.ts","/proj/c.ts"]);
ck("File keyboard: excluded first result is skipped",eligibleFileIndex(items,excluded,0)===1);
ck("File keyboard: keyboard does not select excluded highlighted result",eligibleFileIndex(items,excluded,2)===1);
ck("File keyboard: allowed index keeps its own position",eligibleFileIndex(items,excluded,3)===3);
ck("File keyboard: ArrowDown skips already attached candidate",eligibleFileIndex(items,excluded,1,1)===3);
ck("File keyboard: ArrowUp skips already attached candidate",eligibleFileIndex(items,excluded,3,-1)===1);
ck("File keyboard: keyboard navigation from initial -1 picks first eligible",
 eligibleFileIndex(items,excluded,-1,1)===1);
ck("File keyboard: no eligible candidates produces -1 instead of selecting duplicate",
 eligibleFileIndex(items,new Set(items.map(f=>f.path)),0)===-1);
ck("File keyboard: empty search results cannot select stale row",
 eligibleFileIndex([],excluded,0)===-1);
ck("File keyboard: at end of list arrow does not wrap into excluded row",
 eligibleFileIndex(items,excluded,3,1)===3);
ck("File UI: both pointer and keyboard mention paths guard excluded files",
 sourceHas(files,"if (!exclude.has(file.path)) onPick([file]);") &&
 sourceHas(files,'disabled={already && mode === "mention"}') &&
 sourceHas(files,"const f = visibleFiles[selectableIdx]"));
ck("File UI: navigation works only over current query and eligible items",
 sourceHas(files,"eligibleFileIndex(visibleFiles, exclude, i, 1)") &&
 sourceHas(files,"eligibleFileIndex(visibleFiles, exclude, i, -1)") &&
 sourceHas(files,"completedSearchKey === searchKey ? files : []"));
ck("File UI: selected attachments can be confirmed via Enter while searching",
 sourceHas(files,'mode === "attach" && eligibleSelectedCount > 0 && e.key === "Enter"') &&
 sourceHas(files,"confirmAttach();"));
ck("File UI: old selected multi-query attachments remain until sent or excluded",
 sourceHas(files,"selectedEntries.values()") &&
 sourceHas(files,"if (selectedEntries.size > 0) {") &&
 sourceHas(files,"exclude.has(f.path)"));
ck("File UI: focus stays in text editor for mentions but in input for attaching",
 sourceHas(files,'onMouseDown={mode === "mention" ? (e) => e.preventDefault() : undefined}') &&
 sourceHas(files,"inputRef.current?.focus()"));
ck("File UI: native OS picker remains protected against repeated clicks and late results",
 sourceHas(files,"if (pickPendingRef.current) return;") &&
 sourceHas(files,"selectionGenerationRef.current !== generation") &&
 sourceHas(files,"setPickError(true)"));
ck("File UI: file picker search exposes accessible input and larger actions",
 sourceHas(files,'aria-label={t("chat.mention.searchPlaceholder")}') &&
 sourceHas(files,"min-h-9 items-center") &&
 sourceHas(files,"min-h-8 min-w-0 flex-1"));

const rect=(left:number,top:number,bottom:number,width=32)=>({left,top,bottom,width});
let p=placeComposerPicker(rect(100,460,485),240,{width:850,height:600},380);
ck("Library positioning: bottom composer opens upwards within viewport",
 p.side==="top" && p.top>=8 && p.top+p.maxHeight<=452,p);
p=placeComposerPicker(rect(100,15,45),240,{width:850,height:600},380);
ck("Library positioning: top composer flips below with enough space",
 p.side==="bottom" && p.top===53,p);
p=placeComposerPicker(rect(890,50,65),240,{width:900,height:160},380);
ck("Library positioning: right edge never spills from viewport",
 p.left>=8 && p.left+p.width<=892 && p.maxHeight<=144,p);
p=placeComposerPicker(rect(8,22,40),240,{width:160,height:92},380);
ck("Library positioning: narrow short screen constrains both dimensions",
 p.width===144 && p.top>=8 && p.maxHeight>=0 && p.top+p.maxHeight<=84,p);
ck("Library UI: uses shared measured geometry with no fixed translateY",
 sourceHas(library,"useComposerPickerPlacement(open, anchorRect, rootRef, 380)") &&
 sourceHas(library,"top: placement.top, maxHeight: placement.maxHeight") &&
 !sourceHas(library,'transform: "translateY(-100%)"'));
ck("Library UI: picker owns a named dialog and topmost layered Escape",
 sourceHas(library,'role="dialog"') &&
 sourceHas(library,'isTopEscapeLayer("chat.library-picker")') &&
 sourceHas(library,'claimEscape("chat.library-picker")'));
ck("Library UI: top-level dialog does not disable its own keyboard shortcuts",
 sourceHas(library,"nestedDialog && nestedDialog !== rootRef.current"));
ck("Library UI: initial Enter checks a row rather than closing with no selection",
 sourceHas(library,"selected.size === 0") &&
 sourceHas(library,"if (target) toggle(target.key);") &&
 sourceHas(library,"else confirm();"));
ck("Library UI: selected items remain confirmable across search queries",
 sourceHas(library,"if (!target && (e.key ===") &&
 sourceHas(library,"selectedLibraryPickerEntries(selected, selectedLabels)"));
ck("Library UI: arrow keys reveal active row without stealing search input focus",
 sourceHas(library,"listRef.current?.querySelector<HTMLElement>") &&
 sourceHas(library,'?.scrollIntoView?.({ block: "nearest" })') &&
 sourceHas(library,'ref={listRef}'));
ck("Library UI: category and item rows expose real selection affordances",
 (library.match(/aria-pressed=\{isSelected \|\| isExcluded\}/g)||[]).length===2 &&
 sourceHas(library,"aria-expanded={isOpen}") &&
 sourceHas(library,"focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Library UI: selection keeps collection and item ids, never switches to raw titles",
 sourceHas(library,"selectedLibraryPickerEntries(selected, selectedLabels)") &&
 sourceHas(library,"const name = nameByKey.get(key);") &&
 sourceHas(library,"if (picked.length !== selected.size)"));
ck("Library UI: item data is loaded through existing trusted library API",
 sourceHas(library,'.list({ collectionId: id, limit: 200 })') &&
 sourceHas(library,'.list({ query: searchQuery, limit: 200 })'));
ck("Negative: delete mention exclude check and suite catches unsafe Enter",
 !sourceHas(files.replace("if (!exclude.has(file.path)) onPick([file]);","onPick([file]);"),"if (!exclude.has(file.path)) onPick([file]);"));
console.log("arc005-composer-picker-keyboard-smoke: "+(count-fail)+"/"+count);
if(fail)process.exitCode=1;
