import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "../../src/renderer/stores/sessionStore.js";
import { timelineBlocksPreview, truncateTimelineExcerpt, TIMELINE_EXCERPT_LIMIT } from "../../src/renderer/components/chat/timelineTextPreview.js";

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
check("Timeline preview formatter memoizes per message blocks and locale",
 timeline.includes("const text = useMemo(") &&
 timeline.includes("timelineBlocksPreview(message.blocks, t)") &&
 timeline.includes("[excerpt, message.blocks, t]"));
check("Timeline retains virtual-list jump and bookmark ownership behavior",
 timeline.includes("onJumpItem(d.message.id, d.index, d.excerpt)") &&
 timeline.includes("bookmarkGroups"));
check("Message action buttons remain accessible on no-hover devices",
 row.includes('group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'));
check("User bubbles use more available width in narrow chat side panes",
 row.includes('max-w-[min(92%,48rem)] sm:max-w-[min(85%,48rem)]'));
check("Side chat delete control is exposed on hover, keyboard focus and touch",
 side.includes("group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"));
check("Deletion remains unavailable during an active side-chat turn",
 side.includes('running\n            ? "pointer-events-none opacity-0"'));
console.log("arc005-chat-stream-perf-smoke: "+(n-failed)+"/"+n);
if(failed)process.exitCode=1;
