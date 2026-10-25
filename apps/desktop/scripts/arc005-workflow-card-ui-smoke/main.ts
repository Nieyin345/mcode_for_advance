import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workflowProgressPercent } from "../../src/renderer/components/chat/workflowProgressPercent.js";
import { sourceHas } from "../lib/sourceText.js";

const live = readFileSync(resolve("src/renderer/components/chat/WorkflowNodeProgressCard.tsx"),"utf8");
const done = readFileSync(resolve("src/renderer/components/chat/WorkflowStepCard.tsx"),"utf8");
let count=0,failed=0;
function ck(label:string,ok:boolean,actual?:unknown) {
 count++;if(!ok)failed++;
 console.log((ok?"PASS ":"FAIL ")+label+(ok?"":": "+JSON.stringify(actual)));
}
ck("Workflow progress: undefined is indeterminate",
 workflowProgressPercent(undefined)===undefined);
ck("Workflow progress: NaN never becomes invalid aria-valuenow",
 workflowProgressPercent(NaN)===undefined);
ck("Workflow progress: positive and negative infinities do not create CSS widths",
 workflowProgressPercent(Infinity)===undefined &&
 workflowProgressPercent(-Infinity)===undefined);
ck("Workflow progress: negative upstream values clamp to 0",
 workflowProgressPercent(-20)===0);
ck("Workflow progress: values beyond completion clamp to 100",
 workflowProgressPercent(250)===100);
ck("Workflow progress: valid fractions retain precision",
 workflowProgressPercent(33.4)===33.4);
ck("Workflow progress: zero and 100 are valid deterministic endpoints",
 workflowProgressPercent(0)===0 && workflowProgressPercent(100)===100);
ck("Workflow progress: live UI uses normalized values for bar, CSS width and text",
 sourceHas(live,"workflowProgressPercent(block.percent)") &&
 sourceHas(live,"aria-valuenow={percent}") &&
 sourceHas(live,"width: `${percent}%`") &&
 sourceHas(live,"Math.round(percent)"));
ck("Workflow progress: invalid numeric field omits bar instead of displaying NaN%",
 sourceHas(live,"{percent !== undefined && ("));
ck("Workflow progress: queued node does not animate as if actively running",
 sourceHas(live,'!queued && "animate-spin"') &&
 sourceHas(live,'t("chatStream.workflowStep.queued")'));
ck("Workflow progress: all labels and long node types fit the narrow side panel",
 sourceHas(live,"flex min-w-0 flex-wrap items-center") &&
 sourceHas(live,"min-w-0 flex-[1_1_9rem] truncate") &&
 sourceHas(live,"max-w-[min(12rem,60%)]"));
ck("Workflow progress: phase updates are announced, not every one-percent tick",
 sourceHas(live,'role="group" aria-label={block.title}') &&
 sourceHas(live,'<span role="status" aria-live="polite"') &&
 sourceHas(live, "block.phase?.trim()") &&
 !sourceHas(live,'role="status" aria-live="polite" aria-atomic="false"'));
ck("Workflow result: title disclosure announces open state and content id",
 sourceHas(done,"const summaryId = useId()") &&
 sourceHas(done,"aria-expanded={collapsible ? open : undefined}") &&
 sourceHas(done,"aria-controls={collapsible ? summaryId : undefined}") &&
 sourceHas(done,"id={summaryId}"));
ck("Workflow result: process disclosure announces open state and content id",
 sourceHas(done,"const processId = useId()") &&
 sourceHas(done,"aria-expanded={openProcess}") &&
 sourceHas(done,"aria-controls={openProcess ? processId : undefined}") &&
 sourceHas(done,"id={processId}"));
ck("Workflow result: statuses preserve separate failed/unselected/cancelled labels",
 sourceHas(done,'labelKey: "chatStream.workflowStep.failed"') &&
 sourceHas(done,'labelKey: "chatStream.workflowStep.unselected"') &&
 sourceHas(done,'labelKey: "chatStream.workflowStep.cancelled"'));
ck("Workflow result: retry still needs failed status and separate node session",
 sourceHas(done,'block.status === "failed" && block.nodeSessionId && sessionId') &&
 sourceHas(done,'<RetryNodeDialog'));
ck("Workflow result: multi-variable outputs remain parsed from dispatcher's source",
 sourceHas(done,"outputRowsOf(block.summary, block.outputKeys)") &&
 sourceHas(done,"outputs.some((v) => v.text.length > COLLAPSE_AT)"));
ck("Workflow result: long artifacts get independent accessible action names",
 sourceHas(done,'aria-label={`${t("chatStream.workflowStep.open")}: ${artifact.name ?? artifact.uri}`}') &&
 sourceHas(done,"min-h-8 shrink-0 items-center"));
ck("Workflow result: external artifacts still use explicit existing opener",
 sourceHas(done,"api.shell.openPath({ path: localPath })") &&
 sourceHas(done,"api.shell.openFile({ path: localPath })"));
ck("Workflow result: process snapshots use live transcription first, stored snapshot second",
 sourceHas(done,"rawProcess ?? block.nodeTranscript") &&
 sourceHas(done,"(source ?? []).map(mapTranscriptBlock)"));
ck("Workflow result: invalid readonly source never becomes editable chat",
 sourceHas(done,"<MessageBlocks blocks={process} />"));
ck("Workflow result: cards have visible keyboard outline and flexible narrow header",
 sourceHas(done,"min-h-9 min-w-0 w-full flex-wrap items-center") &&
 sourceHas(done,"focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Negative: removing sanitizer from live progress breaks new contract",
 !sourceHas(live.replace("workflowProgressPercent(block.percent)","block.percent"),"workflowProgressPercent(block.percent)"));
ck("Negative: removing output disclosure label is detectable",
 !sourceHas(done.replace("aria-expanded={collapsible ? open : undefined}",""),"aria-expanded={collapsible ? open : undefined}"));
console.log("arc005-workflow-card-ui-smoke: "+(count-failed)+"/"+count);
if(failed)process.exitCode=1;
