import type { WorkflowDoc } from "@contracts/workflow";
import { migrateWorkflowDoc, flowToWorkflowDoc, roundTripMismatchPaths } from "@main/workflowEngines/flowMigration.js";

let total = 0;
let failures = 0;
function check(name: string, passed: boolean, detail?: unknown): void {
  total++;
  console.log((passed ? "  ok   " : "  FAIL ") + name + (passed ? "" : " " + JSON.stringify(detail)));
  if (!passed) failures++;
}
const original = {
  id: "isolation-fixture", name: "Original flow", builtin: false, updatedAt: 1,
  inputSchema: { type: "object", properties: { original: { type: "string" } } },
  nodes: [{ id: "a", type: "mcode.agent", title: "Agent", params: {
    instruction: "Original instruction", nested: { items: ["first"] },
  }, position: { x: 1, y: 2 }, "x-extra-node": { details: ["original"] } }],
  edges: [],
  "x-extra-doc": { label: "original" },
};
const { flow } = migrateWorkflowDoc(original as unknown as WorkflowDoc);
const node = flow.nodes.find((x) => x["x-mcode"]?.nodeId === "a")!;
const tab = flow.nodes.find((x) => x.type === "tab")!;
const nested = (node["x-mcode"]!.params!.nested as {items:string[]});
const schema = (tab["x-mcode"] as unknown as {inputSchema: { properties:{original:{type:string}}}}).inputSchema;
const extra = ((node["x-mcode"] as unknown as {unknown:{"x-extra-node":{details:string[]}}}).unknown)["x-extra-node"];
const documentExtra = ((tab["x-mcode"] as unknown as {unknown:{"x-extra-doc":{label:string}}}).unknown)["x-extra-doc"];

(original.nodes[0]!.params.nested.items as string[])[0] = "tampered after migration";
original.inputSchema.properties.original.type = "integer";
original.nodes[0]!["x-extra-node"].details[0] = "tampered after migration";
original["x-extra-doc"].label = "tampered after migration";
check("★ input params are snapshotted independently of source document",nested.items[0] === "first",nested);
check("★ input schema is snapshotted independently of source document",schema.properties.original.type === "string",schema);
check("★ unknown nested node fields do not alias source document",extra.details[0] === "original",extra);
check("★ unknown document fields do not alias source document",documentExtra.label === "original",documentExtra);

const restored = flowToWorkflowDoc(flow);
const restoredNode = restored.nodes.find((x) => x.id === "a")!;
((restoredNode.params.nested as {items:string[]}).items)[0] = "tampered after restore";
((restored.inputSchema as {properties: {original:{type:string}}}).properties.original).type = "number";
((restoredNode as unknown as {"x-extra-node":{details:string[]}})["x-extra-node"].details)[0] = "tampered after restore";
((restored as unknown as {"x-extra-doc":{label:string}})["x-extra-doc"]).label = "tampered after restore";
check("★ reverse-migrated params never mutate the stored Node-RED source",nested.items[0] === "first",nested);
check("★ reverse-migrated schema never mutates the stored Node-RED source",schema.properties.original.type === "string",schema);
check("★ reverse-migrated unknown node fields never mutate the flow",extra.details[0] === "original",extra);
check("★ reverse-migrated unknown document fields never mutate the flow",documentExtra.label === "original",documentExtra);

// A migration publishes metadata both as an internal sidecar and as the
// actual Node-RED tab metadata. Editing a summary must not silently rewrite
// the persisted tab's document identity/schema through shared references.
const metadataFlow = migrateWorkflowDoc({...original, name: "Tab is source of truth"} as unknown as WorkflowDoc).flow;
const summaryMetadata = metadataFlow["x-mcode"]!;
const actualTabMetadata = metadataFlow.nodes.find((n) => n.type === "tab")!["x-mcode"]! as typeof summaryMetadata;
const tabInput = actualTabMetadata.inputSchema as {properties:{original:{type:string}}};
summaryMetadata.name = "tampered summary";
((summaryMetadata.inputSchema as {properties:{original:{type:string}}}).properties.original).type = "boolean";
check("★ editing Node-RED summary must not silently rename the persisted tab",
  actualTabMetadata.name === "Tab is source of truth", actualTabMetadata);
check("★ editing summary schema must not silently alter persisted tab schema",
  tabInput.properties.original.type === "integer", tabInput);

// Sanitization used to make IDs depend on document order: both "node.a" and
// "node_a" normalized to n_node_a and the first one silently won that ID.
// A pure reorder of nodes/edges must not change the referent of a Node-RED ID.
const collisionDoc = {
  id: "same-flow", name: "Collision fixture", builtin: false, updatedAt: 1,
  nodes: [
    { id: "node.a", title: "A", type: "mcode.agent", params: {}, position: { x: 0, y: 0 } },
    { id: "node_a", title: "B", type: "mcode.agent", params: {}, position: { x: 1, y: 1 } },
  ],
  edges: [
    { id: "edge.a", from: "node.a", to: "node_a" },
    { id: "edge_a", from: "node_a", to: "node.a" },
  ],
};
const firstFlow = migrateWorkflowDoc(collisionDoc as unknown as WorkflowDoc).flow;
const reorderedFlow = migrateWorkflowDoc({ ...collisionDoc,
  nodes: [...collisionDoc.nodes].reverse(),
  edges: [...collisionDoc.edges].reverse(),
} as unknown as WorkflowDoc).flow;
function nodeIdsByOriginal(f: typeof firstFlow): Record<string, string> {
  return Object.fromEntries(f.nodes.filter((n) => n["x-mcode"]?.nodeId)
    .map((n) => [n["x-mcode"]!.nodeId, n.id]));
}
function linkIdsByOriginal(f: typeof firstFlow): Record<string, string> {
  return Object.fromEntries((f.links ?? []).map((n) => [n["x-mcode-edge"]!.edgeId, n.id]));
}
const sameBindings = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
check("★ sanitized-collision node IDs stay bound to the same node after reordering",
  sameBindings(nodeIdsByOriginal(firstFlow), nodeIdsByOriginal(reorderedFlow)),
  { before: nodeIdsByOriginal(firstFlow), after: nodeIdsByOriginal(reorderedFlow) });
check("★ sanitized-collision edge IDs stay bound to the same edge after reordering",
  sameBindings(linkIdsByOriginal(firstFlow), linkIdsByOriginal(reorderedFlow)),
  { before: linkIdsByOriginal(firstFlow), after: linkIdsByOriginal(reorderedFlow) });

// JSON objects with reordered keys have identical schema and execution
// meaning. Migration equality checks must not report false data-loss paths.
const compareBase = {
  id: "compare-fixture", name: "Unchanged", builtin: false, updatedAt: 1,
  inputSchema: { type: "object", properties: { alpha: {type:"string"}, beta:{type:"number"} } },
  nodes: [{id:"a",title:"A",type:"mcode.agent",position:{x:1,y:2},params:{alpha:1,beta:2}}],
  edges: [],
};
const compareReordered = {
  ...compareBase,
  inputSchema: { type: "object", properties: { beta:{type:"number"}, alpha:{type:"string"} } },
  nodes: [{...compareBase.nodes[0]!, params: {beta:2,alpha:1}}],
};
const equivalentPaths = roundTripMismatchPaths(
  compareBase as unknown as WorkflowDoc, compareReordered as unknown as WorkflowDoc);
check("★ reordering input schema object keys is not reported as migration data loss",
  !equivalentPaths.includes("inputSchema"), equivalentPaths);
check("★ reordering nested node parameter keys is not reported as migration data loss",
  !equivalentPaths.includes("nodes[a].params"), equivalentPaths);

console.log(`flow-snapshot-isolation-smoke:${total-failures}/${total} 通过`);
if (failures) process.exitCode = 1;
