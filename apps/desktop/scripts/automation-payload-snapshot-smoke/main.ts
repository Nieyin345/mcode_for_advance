import { mergeEventPayload, payloadFactsOf } from "@main/orchestration/automationPayload.js";
let total = 0, fails = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else { fails++; console.log("  FAIL " + name + " " + JSON.stringify(detail)); }
}
const item = { itemId: "item-1", itemTitle: "Unchanged original", pdfPath: "one.pdf" };
const subjects = ["one.pdf"];
const first = mergeEventPayload(undefined, "library.item.downloaded", { subjects }, item);
check("fresh event carries first item", first.kind === "event" && first.items?.[0]?.itemId === "item-1");
item.itemTitle = "MUTATED_AFTER_QUEUE";
item.pdfPath = "evil.pdf";
subjects[0] = "tampered-after-queue";
check("★ queued item title keeps immutable snapshot",
  first.kind === "event" && first.items?.[0]?.itemTitle === "Unchanged original", first);
check("★ queued item PDF path keeps immutable snapshot",
  first.kind === "event" && first.items?.[0]?.pdfPath === "one.pdf", first);
check("★ queued subjects keep snapshot after upstream modification",
  first.kind === "event" && first.subjects?.[0] === "one.pdf", first);
const oldItem = { itemId: "historical", itemTitle: "History" };
const previous = mergeEventPayload(undefined, "library.item.downloaded", {}, oldItem);
const next = mergeEventPayload(previous, "library.item.downloaded", {}, { itemId: "second", itemTitle: "Next" });
oldItem.itemTitle = "HISTORY_MUTATED";
check("★ second batch preserves prior item's factual title",
  next.kind === "event" && next.items?.[0]?.itemTitle === "History", next);
check("★ successful merge carries all different item ids",
  next.kind === "event" && next.items?.length === 2 && next.items[1]?.itemId === "second");
const duplicate = mergeEventPayload(next, "library.item.downloaded", {}, { itemId: "second", itemTitle: "Duplicate" });
check("duplicate id is still de-duplicated",
  duplicate.kind === "event" && duplicate.items?.length === 2);
const facts = payloadFactsOf(next);
check("event facts copy items", Array.isArray(facts.items) && facts.items.length === 2);
check("first result unchanged after merging successor",
  previous.kind === "event" && previous.items?.length === 1);
check("empty event remains valid",
  mergeEventPayload(undefined, "turn.done", {}, undefined).kind === "event");
const { describeTriggerPayload } = await import("@main/orchestration/automationPayload.js");
const manualInputWithoutFiles = describeTriggerPayload({
  kind: "file", files: [], input: { doi: "10.1234/example", paths: ["one.pdf"] },
});
check("★ file input with no file change still includes submitted DOI",
  manualInputWithoutFiles.includes("doi = 10.1234/example"), manualInputWithoutFiles);
check("★ file input with no file change retains submitted file paths",
  manualInputWithoutFiles.includes("one.pdf"), manualInputWithoutFiles);
check("file with no changes and no input keeps historical wording",
  describeTriggerPayload({ kind: "file", files: [] }) === "监听的文件有变化。");
const injected = JSON.parse('{"itemId":"good","itemTitle":"Original","event":"turn.done","kind":"schedule","toolName":"forged","pdfPath":123,"__proto__":{"polluted":"yes"}}') as never;
const direct = payloadFactsOf({
  kind: "event", event: "library.item.downloaded", toolName: "actual", items: [injected],
});
check("★ item payload cannot override event kind", direct.kind === "event", direct);
check("★ item payload cannot override authoritative hook event",
  direct.event === "library.item.downloaded", direct);
check("★ item payload cannot override authoritative tool name", direct.toolName === "actual", direct);
check("★ item payload removes invalid pdfPath number", direct.pdfPath === undefined, direct);
check("★ nested item facts cannot carry injected reserved fields",
  Array.isArray(direct.items) && !Object.hasOwn(direct.items[0]!, "kind") && !Object.hasOwn(direct.items[0]!, "event"), direct.items);
const mergedInjected = mergeEventPayload(undefined, "library.item.downloaded", {}, injected);
check("★ event accumulator drops item reserved fields at ingress",
  mergedInjected.kind === "event" && mergedInjected.items?.[0] !== undefined
    && !Object.hasOwn(mergedInjected.items[0], "kind"), mergedInjected);
console.log("automation-payload-snapshot-smoke:" + (total - fails) + "/" + total + " 通过");
if (fails > 0) process.exitCode = 1;
