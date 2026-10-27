import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "../../src/renderer/stores/sessionStore.js";
import { timelineAccessibleSummary, timelineBlocksPreview, truncateTimelineExcerpt, TIMELINE_EXCERPT_LIMIT } from "../../src/renderer/components/chat/timelineTextPreview.js";

let n=0, failed=0;
function check(label:string,pass:boolean){n++;if(!pass)failed++;console.log((pass?"PASS ":"FAIL ")+label);}
const t=(_key:string, values?:{text:string})=>"Attachment: "+(values?.text??"");
const textBlock=(text:string)=>({kind:"text",text} as Block);
const long="A".repeat(4*1024*1024);
const longBlocks:Block[]=[textBlock(long), {kind:"attachment",preview:"should not evaluate"} as Block];
let translated=0;
const output=timelineBlocksPreview(longBlocks,(k,p)=>{translated++;return t(k,p);});
check("Timeline preview truncates multi-megabyte user paste to bounded DOM text",
 output.length<=TIMELINE_EXCERPT_LIMIT+1 && output.endsWith("…"));
check("Only prefix text is retained, not megabytes of paste data",
 output.startsWith("A".repeat(100)));
check("Preview stops scanning blocks after budget is exhausted",translated===0);
check("Short user prompt is displayed unchanged",
 timelineBlocksPreview([textBlock("hello")],t)==="hello");
check("Multiple text blocks keep their original paragraph separation",
 timelineBlocksPreview([textBlock("a"),textBlock("b")],t)==="a\n\nb");
check("Empty thought-only message does not synthesize fake tooltip text",
 timelineBlocksPreview([{kind:"thinking",text:"   "} as Block],t)==="");
check("Thinking previews retain quote markers without modifying original block",
 timelineBlocksPreview([{kind:"thinking",text:"one\ntwo"} as Block],t)==="> one\n> two");
const translatedAttachment=timelineBlocksPreview([{kind:"attachment",preview:"demo.md"} as Block],t);
check("Attachment preview keeps localized formatter",translatedAttachment.includes("Attachment: demo.md"));
check("Bookmark excerpt remains untouched if it fits",
 truncateTimelineExcerpt("bookmark text")==="bookmark text");
check("Long bookmark excerpt is bounded without changing saved content",
 truncateTimelineExcerpt(long).length<=TIMELINE_EXCERPT_LIMIT+1);
check("Accessible timeline summary reads at most the preview's tiny prefix",
 timelineAccessibleSummary(longBlocks,t)==="A".repeat(140));
check("Accessible summaries skip empty blocks and preserve localized attachment",
 timelineAccessibleSummary([textBlock("  "),{kind:"attachment",preview:"file.md"} as Block],t)==="Attachment: file.md");
check("Accessible summary is always available without hover portal",
 timelineAccessibleSummary([{kind:"thinking",text:"reasoning"} as Block],t)==="reasoning");
check("Original stored content remains unchanged",
 longBlocks[0]?.kind==="text" && longBlocks[0].text.length===4*1024*1024);

const read=(p:string)=>readFileSync(join(process.cwd(),"src/renderer/components/chat",p),"utf8");
const row=read("MessageRow.tsx"),timeline=read("MessageTimeline.tsx"),side=read("SideChatPanel.tsx");
check("Finished turns render frozen stat rows without mounting live clock",
 row.includes('if (meta.endedAt !== undefined)') &&
 row.includes('return <TurnStatContent meta={meta} end={meta.endedAt} live={false} />'));
check("Only LiveTurnStatRow subscribes to the shared global ticker",
 row.indexOf("function LiveTurnStatRow")<row.indexOf("const now = useNow()") &&
 row.indexOf("const now = useNow()")<row.indexOf("function TurnStatContent"));
check("Live turn still drives the existing animated operation ticker",
 row.includes("<CurrentOpTicker op={op} turnActive />") && row.includes('data-tempo={op ? undefined : "slow"}'));
check("Timeline only builds full hover preview when the dash is focused or hovered",
 timeline.includes('const text = useMemo(() => !hovered ? "" : excerpt') &&
 timeline.includes("timelineBlocksPreview(message.blocks, t)") &&
 timeline.includes("[hovered, excerpt, message.blocks, t]"));
check("Timeline keeps accessible names even before any tooltip is opened",
 timeline.includes("timelineAccessibleSummary(message.blocks, t)") &&
 timeline.includes("text: summary"));
check("Timeline retains virtual-list jump and bookmark ownership behavior",
 timeline.includes("onJumpItem(d.message.id, d.index, d.excerpt)") &&
 timeline.includes("bookmarkGroups"));
/* 【UI 重建 2026-10-27】两条断言的字面量变了，**守的语义没变**：
 *
 * 63：操作栏在无悬停设备上必须可见 —— 原来只查 `opacity-100`。现在同时带
 *     `pointer-events-auto`（可见之后还得**能点**），字面量对不上了。
 *     断言改成查「无悬停设备下两者都在」，这比原来更严。
 * 65：气泡宽度从写死的 `85%` 改成 `var(--m-bubble-max-w, 85%)` —— 兜底还是 85%，
 *     只是允许主题覆盖。断言认变量，兜底值一并钉住（否则变量写错成 40% 也是绿的）。 */
check("Message action buttons remain accessible on no-hover devices",
  row.includes("[@media(hover:none)]:pointer-events-auto") &&
  row.includes("[@media(hover:none)]:opacity-100"));
check("User bubbles use more available width in narrow chat side panes",
  row.includes("max-w-[min(92%,48rem)]") &&
  /sm:max-w-\[min\(var\(--m-bubble-max-w,\s*85%\),48rem\)\]/.test(row) &&
  // 兜底值必须仍是 85% —— 变量名对但兜底写错时，这条会红。
  row.includes("--m-bubble-max-w,85%") || row.includes("--m-bubble-max-w, 85%"));
check("Side chat delete control is exposed on hover, keyboard focus and touch",
 side.includes("group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"));
check("Deletion remains unavailable during an active side-chat turn",
 side.includes('running\n            ? "pointer-events-none opacity-0"'));
console.log("arc005-chat-stream-perf-smoke: "+(n-failed)+"/"+n);
if(failed)process.exitCode=1;
