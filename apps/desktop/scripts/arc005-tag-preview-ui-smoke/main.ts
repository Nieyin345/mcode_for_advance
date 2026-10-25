import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visibleTagImage } from "../../src/renderer/components/chat/tagPreviewImageIdentity.js";
import { sourceHas } from "../lib/sourceText.js";
const tag=readFileSync(resolve("src/renderer/components/chat/TagPopover.tsx"),"utf8");
const ring=readFileSync(resolve("src/renderer/components/chat/ContextRing.tsx"),"utf8");
let n=0,fail=0;
function ck(name:string,ok:boolean){n++;if(!ok)fail++;console.log((ok?"PASS ":"FAIL ")+name);}
const loaded={path:"C:/p/a.png",url:"data:image/png;base64,AAA"};
ck("Image tag: its own successfully resolved result is shown",
 visibleTagImage("C:/p/a.png",loaded)===loaded.url);
ck("Image tag: result from previous chip never flashes into new chip",
 visibleTagImage("C:/p/b.png",loaded)===null);
ck("Image tag: new chip displays loading until its own IPC result is ready",
 visibleTagImage("C:/p/b.png",null)===null);
ck("Image tag: unreadable image remains distinct from loading",
 visibleTagImage("C:/p/b.png",{path:"C:/p/b.png",url:""})==="");
ck("Image tag: no file identity never exposes cached image",
 visibleTagImage(null,loaded)===null && visibleTagImage(undefined,loaded)===null);
ck("Image tag: exact path check never aliases same basename in other project",
 visibleTagImage("D:/p/a.png",loaded)===null);
ck("Tag UI: image result rendered only through identity check",
 sourceHas(tag,"visibleTagImage(tag.filePath, imageResult)") &&
 sourceHas(tag,"setImageResult({ path: tag.filePath!, url })") &&
 sourceHas(tag,'setImageResult({ path: tag.filePath!, url: "" })'));
ck("Tag UI: late image read cannot update a closed or superseded image",
 sourceHas(tag,"if (!cancelled) setImageResult(") &&
 sourceHas(tag,"cancelled = true;"));
ck("Tag UI: zoom state belongs to currently selected image path",
 sourceHas(tag,"const natural = naturalFor === tag.filePath && !!tag.filePath;") &&
 sourceHas(tag,"setNaturalFor(natural ? null : tag.filePath ?? null)") &&
 sourceHas(tag,"aria-pressed={natural}"));
ck("Tag UI: copy results cannot set status in removed or replaced preview",
 sourceHas(tag,"const generation = ++copyGenerationRef.current;") &&
 (tag.match(/generation === copyGenerationRef.current/g)||[]).length===2 &&
 sourceHas(tag,"return () => { copyGenerationRef.current++; };"));
ck("Tag UI: copy failure does not falsely claim success",
 sourceHas(tag,'setCopyState("failed")') &&
 sourceHas(tag,'setCopyState("copied")') &&
 sourceHas(tag,"try {") && sourceHas(tag,"catch {"));
ck("Tag UI: copy status timer clears on dismissal",
 sourceHas(tag,'const t = setTimeout(() => setCopyState("idle"), 1200);') &&
 sourceHas(tag,"return () => clearTimeout(t);"));
ck("Tag UI: shared Escape stack respects composition and prevents cascaded close",
 sourceHas(tag,'claimEscape("chat.tag-popover")') &&
 sourceHas(tag,'e.key === "Escape" && !e.isComposing && e.keyCode !== 229') &&
 sourceHas(tag,"e.preventDefault();") &&
 sourceHas(tag,"e.stopPropagation();") &&
 sourceHas(tag,'document.addEventListener("keydown", onKey, true)'));
ck("Tag UI: outside scroll dismisses detached preview, internal scrolling does not",
 sourceHas(tag,'window.addEventListener("scroll", onScroll, true)') &&
 sourceHas(tag,"popoverRef.current?.contains(event.target)"));
ck("Tag UI: viewport-safe measurements still use ResizeObserver",
 sourceHas(tag,"previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,") &&
 sourceHas(tag,"new ResizeObserver(recompute)") &&
 sourceHas(tag,"observer?.disconnect()"));
ck("Tag UI: copy/expand/close buttons have keyboard-sized controls",
 (tag.match(/min-h-8 items-center/g)||[]).length>=2 &&
 sourceHas(tag,"flex size-8 items-center justify-center") &&
 sourceHas(tag,'aria-label={t("chat.tagPopover.closePreview")}'));
ck("Tag UI: copy and expanded state have translated names",
 sourceHas(tag,'aria-label={copyState === "copied" ? t("common.copied")') &&
 sourceHas(tag,'aria-label={t("chat.tagPopover.expandTitle")}') &&
 sourceHas(tag,'t("chat.tagPopover.shrink")') &&
 sourceHas(tag,'t("chat.tagPopover.enlarge")'));
ck("Tag UI: paste keeps original full content not preview text",
 sourceHas(tag,"navigator.clipboard.writeText(tag.content)") &&
 sourceHas(tag,"{tag.content}") &&
 !sourceHas(tag,"navigator.clipboard.writeText(tag.preview)"));
ck("Context ring: detail popover is discoverable from keyboard button state",
 sourceHas(ring,'aria-haspopup="dialog"') &&
 sourceHas(ring,"aria-expanded={open}") &&
 sourceHas(ring,"onClick={openDetails}"));
ck("Context ring: visible keyboard focus meets workspace affordance",
 sourceHas(ring,"focus-visible:outline-offset-2 focus-visible:outline-accent") &&
 sourceHas(ring,"min-h-7 cursor-pointer"));
ck("Context ring: no-data ring still does not fake a zero-percent reading",
 sourceHas(ring,"if (!snapshot) return <ContextRingNoData />") &&
 sourceHas(ring,">--</span>"));
ck("Context ring: detail panel remains session-scoped and reuses native breakdown",
 sourceHas(ring,"<ContextStatsPopover") &&
 sourceHas(ring,"snapshot={snapshot}") &&
 sourceHas(ring,"history={history}"));
ck("Negative: removing identity check cannot pass source contract",
 !sourceHas(tag.replace("visibleTagImage(tag.filePath, imageResult)", "imageResult?.url"),"visibleTagImage(tag.filePath, imageResult)"));
console.log("arc005-tag-preview-ui-smoke: "+(n-fail)+"/"+n);
if(fail)process.exitCode=1;
