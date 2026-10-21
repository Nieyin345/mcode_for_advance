import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import {
  migrateWorkflowDoc,
  type NodeRedNode,
} from "@main/workflowEngines/flowMigration.js";
import {
  runWorkflowMigrationPreflight,
  WORKFLOW_PREFLIGHT_ISOLATION_MARKER,
  WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT,
  type WorkflowMigrationPreflightSource,
  type WorkflowPreflightRuntimeFacts,
} from "@main/workflowEngines/workflowMigrationPreflight.js";

let checks = 0;
let failures = 0;
function check(name: string, passed: boolean, detail?: unknown): void {
  checks++;
  if (passed) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}
function manifest(id: string, runner: NodeTypeManifest["runner"]): NodeTypeManifest {
  return { id, manifestVersion: 1, name: id, runner, capability: "read", params: [] };
}
const TYPES: ReadonlyMap<string, NodeTypeManifest> = new Map([
  ["mcode.agent", manifest("mcode.agent", { kind: "prompt" })],
  ["mcode.branch", manifest("mcode.branch", { kind: "branch" })],
  ["mcode.trigger", manifest("mcode.trigger", { kind: "trigger" })],
]);
const SAFE_FACTS: WorkflowPreflightRuntimeFacts = {
  review: { state: "not-required" },
  inFlight: { state: "none" },
  runboardHistory: "not-applicable",
};
function node(
  id: string,
  type = "mcode.agent",
  params: Record<string, unknown> = {},
  x = 10,
  y = 20,
): WorkflowDoc["nodes"][number] {
  const effectiveParams = Object.keys(params).length > 0
    ? params
    : type === "mcode.agent" ? { instruction: "fixture instruction" } : params;
  return { id, type, title: id, params: effectiveParams, position: { x, y } };
}
function doc(
  id: string,
  options: Partial<WorkflowDoc> & Record<string, unknown> = {},
): WorkflowDoc {
  return {
    id,
    engine: "mcode",
    name: id,
    builtin: false,
    updatedAt: 1,
    nodes: [node("a"), node("b", "mcode.agent", {}, 30, 40)],
    edges: [{ id: "edge-a-b", from: "a", to: "b" }],
    ...options,
  } as WorkflowDoc;
}
function writeJson(root: string, relativePath: string, value: unknown): string {
  const path = join(root, relativePath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  return path;
}
function hashBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function generatedNativeNodes(sourceDoc: WorkflowDoc): NodeRedNode[] {
  return clone(migrateWorkflowDoc(sourceDoc, { types: TYPES }).flow.nodes);
}
function nativeSource(
  sourceId: string,
  relativePath: string,
  direction: "node-red-to-mcode" | "inventory-only",
  factsByDocId: Record<string, WorkflowPreflightRuntimeFacts> = {},
): WorkflowMigrationPreflightSource {
  return {
    sourceId,
    kind: "flows-json",
    direction,
    relativePath,
    runtimeFactsByDocId: factsByDocId,
  };
}
function findRow(
  report: ReturnType<typeof runWorkflowMigrationPreflight>,
  sourceId: string,
  docId?: string | null,
) {
  return report.rows.find((row) => row.sourceId === sourceId && (docId === undefined || row.docId === docId));
}
function snapshotFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else result[rel] = hashBytes(readFileSync(full));
    }
  };
  walk(root);
  return result;
}

const tmpBase = resolve(process.cwd(), "../../.tmp");
mkdirSync(tmpBase, { recursive: true });
const outsideFile = join(tmpBase, "t85-outside-" + process.pid + ".json");
const root = mkdtempSync(join(tmpBase, "t85-preflight-"));
try {
  writeFileSync(join(root, WORKFLOW_PREFLIGHT_ISOLATION_MARKER), WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT, "utf8");

  const fA = doc("F-A", {
    nodes: [node("agent-a"), node("agent-b", "mcode.agent", {}, 30, 40)],
    edges: [{ id: "edge-a-b", from: "agent-a", to: "agent-b" }],
  });
  const fB = doc("F-B", {
    nodes: [node("unknown", "vendor.unknown-node", { fixture: "unknown type" })],
    edges: [],
  });
  const fF = doc("F-F", {
    trigger: "file",
    nodes: [
      node("agent", "mcode.agent"),
      node("watch", "mcode.trigger", {
        triggerKind: "file",
        paths: "C:\\Users\\private\\watched",
        excludePaths: "C:\\Users\\private\\secret",
        debounceMs: 2000,
        task: "private task text",
      }, 20, 40),
    ],
    edges: [{ id: "edge-watch-agent", from: "watch", to: "agent" }],
  });
  const fG = doc("F-G", {
    nodes: [
      node("agent"),
      node("human-branch", "mcode.branch", { decider: "user" }, 30, 40),
    ],
    edges: [{ id: "edge-agent-branch", from: "agent", to: "human-branch" }],
  });
  const fUnknownFields = {
    ...doc("N-unknown-fields"),
    "x-legacy-extra": { retained: true },
  };
  const fSensitiveUnknownFields = {
    ...doc("N-sensitive-field-path"),
    "api_key=TOPSECRET": { retained: true },
  };
  const fConcurrent = doc("N-stale-revision");
  const fCorruptApproval = doc("N-corrupt-approval");
  const fHashMismatch = doc("N-content-hash");
  const fDuplicateA = doc("N-duplicate-doc");
  const fDuplicateB = doc("N-duplicate-doc");
  const fTriggerGate = doc("N-trigger-gate", { trigger: "schedule" });
  const fPostManifestTamper = doc("N-post-manifest-tamper");

  writeJson(root, "F-A.json", fA);
  writeJson(root, "F-B.json", fB);
  writeJson(root, "F-F.json", fF);
  writeJson(root, "F-G.json", fG);
  writeJson(root, "N-unknown-fields.json", fUnknownFields);
  writeJson(root, "N-sensitive-field-path.json", fSensitiveUnknownFields);
  writeJson(root, "N-stale-revision.json", fConcurrent);
  writeJson(root, "N-corrupt-approval.json", fCorruptApproval);
  writeJson(root, "N-content-hash.json", fHashMismatch);
  writeJson(root, "N-duplicate-a.json", fDuplicateA);
  writeJson(root, "N-duplicate-b.json", fDuplicateB);
  writeJson(root, "N-trigger-gate.json", fTriggerGate);
  writeJson(root, "N-post-manifest-tamper.json", fPostManifestTamper);
  writeJson(root, "N-hardlink-original.json", doc("N-hardlink"));
  linkSync(join(root, "N-hardlink-original.json"), join(root, "N-hardlink-source.json"));
  writeFileSync(join(root, "N-unsafe-json-key.json"),
    "{\"id\":\"api_key=TOPSECRET\",\"__proto__\":{\"polluted\":true}}", "utf8");
  writeJson(root, "N-inventory-only.json", doc("N-inventory-only"));

  const fCNodes: Record<string, unknown>[] = [
    { id: "tab-c", type: "tab", label: "F-C", "x-mcode": { docId: "F-C", name: "F-C", engine: "node-red" } },
    { id: "tab-c2", type: "tab", label: "F-C secondary", "x-mcode": { docId: "F-C-secondary", name: "F-C secondary", engine: "node-red" } },
    { id: "mcode-c", type: "mcode-agent", z: "tab-c", name: "Agent", wires: [["mcode-c2"]], "x-mcode": {
      nodeId: "agent", nativeId: "mcode-c", nativeType: "mcode-agent", type: "mcode.agent",
      title: "Agent", position: { x: 10, y: 20 }, params: { instruction: "fixture instruction" },
    } },
    { id: "vendor-c", type: "vendor.unknown-node", z: "tab-c", name: "Foreign", wires: [[]] },
    { id: "mcode-c2", type: "mcode-agent", z: "tab-c2", name: "Secondary", wires: [[]], "x-mcode": {
      nodeId: "secondary", nativeId: "mcode-c2", nativeType: "mcode-agent", type: "mcode.agent",
      title: "Secondary", position: { x: 30, y: 40 }, params: { instruction: "fixture instruction" },
    } },
    { id: "global-c", type: "vendor.config", name: "Global config" },
  ];
  writeJson(root, "F-C-flows.json", fCNodes);

  const fDNodes = generatedNativeNodes(doc("F-D", { nodes: [node("agent")], edges: [] })) as unknown as Record<string, unknown>[];
  const fDNode = fDNodes.find((item) => item.type !== "tab")!;
  fDNode.type = "exec"; // Stale x-mcode.nativeType must not revive the old Mcode type.
  writeJson(root, "F-D-flows.json", fDNodes);

  const fHDoc = doc("F-H", {
    nodes: [node("agent-a"), node("agent-b", "mcode.agent", {}, 30, 40)],
    edges: [{ id: "edge-a-b", from: "agent-a", to: "agent-b" }],
  });
  const fHNodes = generatedNativeNodes(fHDoc) as unknown as Record<string, unknown>[];
  const fHNode = fHNodes.find((item) => {
    const meta = item["x-mcode"] as Record<string, unknown> | undefined;
    return meta?.nodeId === "agent-a";
  })!;
  fHNode.name = "Edited in native editor";
  fHNode.x = 91;
  fHNode.y = 93;
  writeJson(root, "F-H-flows.json", fHNodes);

  const fINodes: Record<string, unknown>[] = [
    { id: "tab-i", type: "tab", label: "F-I", "x-mcode": { docId: "F-I", name: "F-I", engine: "node-red" } },
    { id: "inject-i", type: "inject", z: "tab-i", name: "inject", wires: [["agent-i"]] },
    { id: "agent-i", type: "mcode-agent", z: "tab-i", name: "Agent", wires: [["debug-i"]], "x-mcode": {
      nodeId: "agent", nativeId: "agent-i", nativeType: "mcode-agent", type: "mcode.agent",
      title: "Agent", position: { x: 10, y: 20 }, params: {},
    } },
    { id: "debug-i", type: "debug", z: "tab-i", name: "debug", wires: [[]] },
  ];
  writeJson(root, "F-I-flows.json", fINodes);

  // Truncated/corrupt JSON is unreadable and must remain byte-for-byte intact.
  writeFileSync(join(root, "F-E-flows.json"), "[{\"id\":\"tab-e\",\"type\":\"tab\"}", "utf8");
  writeFileSync(outsideFile, JSON.stringify(doc("outside")), "utf8");

  const sources: WorkflowMigrationPreflightSource[] = [
    { sourceId: "F-A", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "F-A.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "F-B", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "F-B.json", runtimeFacts: SAFE_FACTS },
    nativeSource("F-C", "F-C-flows.json", "node-red-to-mcode", { "F-C": SAFE_FACTS, "F-C-secondary": SAFE_FACTS }),
    nativeSource("F-D", "F-D-flows.json", "node-red-to-mcode", { "F-D": SAFE_FACTS }),
    nativeSource("F-E", "F-E-flows.json", "inventory-only"),
    { sourceId: "F-F", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "F-F.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "F-G", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "F-G.json", runtimeFacts: {
      review: { state: "pending" },
      inFlight: { state: "active", activeCount: 1 },
      runboardHistory: "available",
    } },
    nativeSource("F-H", "F-H-flows.json", "node-red-to-mcode", { "F-H": SAFE_FACTS }),
    nativeSource("F-I", "F-I-flows.json", "inventory-only", { "F-I": {
      review: { state: "not-required" },
      inFlight: { state: "none" },
      runboardHistory: "missing",
    } }),
    { sourceId: "N-unknown-fields", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-unknown-fields.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-sensitive-field-path", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-sensitive-field-path.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-stale-revision", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-stale-revision.json", expectedRevision: "0".repeat(64), runtimeFacts: SAFE_FACTS },
    { sourceId: "N-corrupt-approval", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-corrupt-approval.json", runtimeFacts: {
      review: { state: "corrupt" },
      inFlight: { state: "none" },
      runboardHistory: "not-applicable",
    } },
    { sourceId: "N-content-hash", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-content-hash.json", expectedContentHash: "0".repeat(64), runtimeFacts: SAFE_FACTS },
    { sourceId: "N-duplicate-a", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-duplicate-a.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-duplicate-b", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-duplicate-b.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-trigger-gate", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-trigger-gate.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-post-manifest-tamper", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-post-manifest-tamper.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-hardlink-source", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-hardlink-source.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-unsafe-json-key", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "N-unsafe-json-key.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-inventory-only", kind: "workflow-doc", direction: "inventory-only", relativePath: "N-inventory-only.json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-path-escape", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "../t85-outside-" + process.pid + ".json", runtimeFacts: SAFE_FACTS },
    { sourceId: "N-missing-source", kind: "workflow-doc", direction: "mcode-to-node-red", relativePath: "missing-source.json", runtimeFacts: SAFE_FACTS },
  ];

  const beforeFiles = snapshotFiles(root);
  const report1 = runWorkflowMigrationPreflight({
    isolationRoot: root,
    authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
    sources,
    types: TYPES,
  });
  const report2 = runWorkflowMigrationPreflight({
    isolationRoot: root,
    authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
    sources,
    types: TYPES,
  });
  const afterFiles = snapshotFiles(root);

  const fArow = findRow(report1, "F-A");
  const fBrow = findRow(report1, "F-B");
  const fCrow = findRow(report1, "F-C", "F-C");
  const fDrow = findRow(report1, "F-D", "F-D");
  const fErow = findRow(report1, "F-E");
  const fFrow = findRow(report1, "F-F");
  const fGrow = findRow(report1, "F-G");
  const fHrow = findRow(report1, "F-H", "F-H");
  const fIrow = findRow(report1, "F-I", "F-I");

  check("F-A known Host-backed plain graph is SAFE only as a dry-run candidate",
    fArow?.decision === "SAFE" && fArow.migration.mappedNodeCount === 2
      && fArow.migration.unmappedNodeTypes.length === 0 && fArow.fieldDiffPaths.length === 0
      && fArow.triggerSources.length === 0 && fA.nodes.length === 2 && fA.edges.length === 1
      && fA.nodes.every((item) => Number.isInteger(item.position.x) && Number.isInteger(item.position.y)),
    fArow);
  check("F-A content hash matches the byte-exact export file",
    fArow?.contentHash === hashBytes(readFileSync(join(root, "F-A.json"))),
    fArow?.contentHash);
  check("F-B unknown Mcode node type is REJECT and never SAFE",
    fBrow?.decision === "REJECT" && fBrow.unknownDependencies.unknownMcodeNodeTypes.includes("vendor.unknown-node"),
    fBrow);
  check("F-C global config, cross-tab wire, and foreign node are explicitly REJECT",
    fCrow?.decision === "REJECT" && fCrow.unknownDependencies.globalConfigNodeCount === 1
      && fCrow.unknownDependencies.crossTabReferenceCount > 0
      && fCrow.unknownDependencies.unknownNativeNodeTypes.includes("vendor.unknown-node")
      && fCrow.unknownDependencies.nativeOnlyNodeTypes.includes("vendor.unknown-node"),
    fCrow);
  check("F-D stale native type metadata is explicitly REJECT",
    fDrow?.decision === "REJECT" && fDrow.reasons.some((reason) => reason.code === "native-flow-conversion-rejected"),
    fDrow);
  check("F-E truncated flows.json is UNREADABLE, counted, and not auto-repaired",
    fErow?.decision === "UNREADABLE" && report1.unreadableCount >= 2,
    { row: fErow, unreadableCount: report1.unreadableCount });
  check("F-F old file-watch debounce/exclusion semantics require HUMAN review",
    fFrow?.decision === "HUMAN" && fFrow.triggerSources.some((trigger) => trigger.kind === "file")
      && fFrow.reasons.some((reason) => reason.code === "trigger-semantics-unverified")
      && !JSON.stringify(fFrow).includes("C:\\\\Users\\\\private"),
    fFrow);
  check("F-G pending approval and in-flight run require HUMAN review",
    fGrow?.decision === "HUMAN" && fGrow.approval.state === "pending" && fGrow.inFlight.state === "active",
    fGrow);
  check("F-H native editor rename/position is HUMAN until real Deploy/read-back/restart U1",
    fHrow?.decision === "HUMAN" && fHrow.reasons.some((reason) => reason.code === "native-editor-changes-unverified"),
    fHrow);
  check("F-I native inject/debug without durable runboard history is HUMAN",
    fIrow?.decision === "HUMAN" && fIrow.runboardHistory === "missing"
      && fIrow.triggerSources.some((trigger) => trigger.kind === "inject"),
    fIrow);

  check("Unknown extra workflow fields are visible and force HUMAN review",
    Boolean(findRow(report1, "N-unknown-fields")?.decision === "HUMAN"
      && findRow(report1, "N-unknown-fields")?.unknownDependencies.unknownFieldPaths.includes("x-legacy-extra")),
    findRow(report1, "N-unknown-fields"));
  check("Credential-like unknown field names are redacted from the report",
    Boolean(!JSON.stringify(findRow(report1, "N-sensitive-field-path")).includes("TOPSECRET")
      && findRow(report1, "N-sensitive-field-path")?.unknownDependencies.unknownFieldPaths.includes("api_key=[redacted]")),
    findRow(report1, "N-sensitive-field-path"));
  check("Concurrent/stale revision is REJECT",
    Boolean(findRow(report1, "N-stale-revision")?.decision === "REJECT"
      && findRow(report1, "N-stale-revision")?.reasons.some((reason) => reason.code === "source-revision-mismatch")),
    findRow(report1, "N-stale-revision"));
  check("Corrupt approval ledger is REJECT, never treated as absent",
    findRow(report1, "N-corrupt-approval")?.decision === "REJECT"
      && findRow(report1, "N-corrupt-approval")?.approval.state === "corrupt",
    findRow(report1, "N-corrupt-approval"));
  check("Changed source bytes do not match the expected manifest hash",
    Boolean(findRow(report1, "N-content-hash")?.decision === "REJECT"
      && findRow(report1, "N-content-hash")?.reasons.some((reason) => reason.code === "source-content-hash-mismatch")),
    findRow(report1, "N-content-hash"));
  check("Duplicate same-engine doc IDs are not silently counted twice as SAFE",
    findRow(report1, "N-duplicate-a")?.decision === "REJECT"
      && findRow(report1, "N-duplicate-b")?.decision === "REJECT",
    { a: findRow(report1, "N-duplicate-a")?.decision, b: findRow(report1, "N-duplicate-b")?.decision });
  check("A top-level legacy trigger is HUMAN even when known fields round-trip",
    Boolean(findRow(report1, "N-trigger-gate")?.decision === "HUMAN"
      && findRow(report1, "N-trigger-gate")?.reasons.some((reason) => reason.code === "trigger-semantics-unverified")),
    findRow(report1, "N-trigger-gate"));
  check("Hard-linked source files are REJECT rather than treated as private snapshots",
    Boolean(findRow(report1, "N-hardlink-source")?.decision === "REJECT"
      && findRow(report1, "N-hardlink-source")?.reasons.some((reason) => reason.code === "source-not-private-regular-file")),
    findRow(report1, "N-hardlink-source"));
  check("Prototype-pollution JSON keys are REJECT before schema/migration",
    Boolean(findRow(report1, "N-unsafe-json-key")?.decision === "REJECT"
      && findRow(report1, "N-unsafe-json-key")?.reasons.some((reason) => reason.code === "unsafe-json-key")
      && !JSON.stringify(findRow(report1, "N-unsafe-json-key")).includes("TOPSECRET")
      && findRow(report1, "N-unsafe-json-key")?.docId === "api_key=[redacted]"),
    findRow(report1, "N-unsafe-json-key"));
  check("WorkflowDoc inventory-only source is HUMAN, not migration approval",
    Boolean(findRow(report1, "N-inventory-only")?.decision === "HUMAN"
      && findRow(report1, "N-inventory-only")?.reasons.some((reason) => reason.code === "inventory-only-not-migration-approval")),
    findRow(report1, "N-inventory-only"));
  check("Cross-project path traversal is REJECT without reading outside bytes",
    Boolean(findRow(report1, "N-path-escape")?.decision === "REJECT"
      && findRow(report1, "N-path-escape")?.reasons.some((reason) => reason.code === "path-outside-isolation-root")),
    findRow(report1, "N-path-escape"));
  check("Missing source is explicitly UNREADABLE",
    findRow(report1, "N-missing-source")?.decision === "UNREADABLE",
    findRow(report1, "N-missing-source"));

  check("SAFE + HUMAN + REJECT + UNREADABLE equals the scanned row count",
    report1.counts.safe + report1.counts.human + report1.counts.reject + report1.counts.unreadable === report1.scannedCount
      && report1.scannedCount === report1.rows.length,
    { counts: report1.counts, scannedCount: report1.scannedCount, rows: report1.rows.length });
  check("Two unchanged runs produce the same manifest hash",
    report1.manifestHash === report2.manifestHash,
    { first: report1.manifestHash, second: report2.manifestHash });
  check("The preflight report contains no absolute isolation/source path",
    !JSON.stringify(report1).includes(root),
    "absolute path leaked");
  check("Every source file remains byte-for-byte unchanged and no files were added",
    JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
    { before: Object.keys(beforeFiles).length, after: Object.keys(afterFiles).length });
  check("F-C third-party native node remains in the original source bytes",
    JSON.parse(readFileSync(join(root, "F-C-flows.json"), "utf8")).some((item: Record<string, unknown>) => item.type === "vendor.unknown-node"),
    "native node was lost");
  check("A path traversal cannot make an outside document appear in the manifest",
    !report1.rows.some((row) => row.docId === "outside"),
    "outside document appeared");

  const originalTamperRow = findRow(report1, "N-post-manifest-tamper");
  const tamperPath = join(root, "N-post-manifest-tamper.json");
  const tamperedDoc = { ...fPostManifestTamper, name: "N-post-manifest-tamper edited", updatedAt: 2 };
  writeJson(root, "N-post-manifest-tamper.json", tamperedDoc);
  const bytesAfterExternalEdit = readFileSync(tamperPath);
  const tamperSources = sources.map((source) => source.sourceId === "N-post-manifest-tamper"
    && source.kind === "workflow-doc" ? {
      ...source,
      expectedContentHash: originalTamperRow?.contentHash ?? "0".repeat(64),
      expectedRevision: originalTamperRow?.revision ?? "0".repeat(64),
    } : source);
  const tamperReport = runWorkflowMigrationPreflight({
    isolationRoot: root,
    authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
    sources: tamperSources,
    types: TYPES,
  });
  const bytesAfterTamperPreflight = readFileSync(tamperPath);
  check("Post-manifest source edit is REJECTed against the recorded content hash/revision",
    Boolean(findRow(tamperReport, "N-post-manifest-tamper")?.decision === "REJECT"
      && findRow(tamperReport, "N-post-manifest-tamper")?.reasons.some((reason) =>
        reason.code === "source-content-hash-mismatch" || reason.code === "source-revision-mismatch")),
    findRow(tamperReport, "N-post-manifest-tamper"));
  check("Tamper detection itself does not modify the changed source bytes",
    hashBytes(bytesAfterExternalEdit) === hashBytes(bytesAfterTamperPreflight),
    "source bytes changed during preflight");

  const inlineDoc = doc("N-inline");
  const inlineBefore = JSON.stringify(inlineDoc);
  const inlineReport = runWorkflowMigrationPreflight({
    isolationRoot: root,
    authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
    sources: [{
      sourceId: "N-inline",
      kind: "workflow-doc",
      direction: "mcode-to-node-red",
      content: inlineDoc,
      runtimeFacts: SAFE_FACTS,
    }],
    types: TYPES,
  });
  check("Inline fictional WorkflowDoc is cloned rather than mutated",
    JSON.stringify(inlineDoc) === inlineBefore && findRow(inlineReport, "N-inline")?.decision === "SAFE",
    findRow(inlineReport, "N-inline"));

  let markerRejected = false;
  const noMarkerRoot = mkdtempSync(join(tmpBase, "t85-no-marker-"));
  try {
    markerRejected = (() => {
      try {
        runWorkflowMigrationPreflight({
          isolationRoot: noMarkerRoot,
          authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
          sources: [{ sourceId: "no-marker", kind: "workflow-doc", direction: "mcode-to-node-red", content: doc("no-marker"), runtimeFacts: SAFE_FACTS }],
          types: TYPES,
        });
        return false;
      } catch {
        return true;
      }
    })();
  } finally {
    rmSync(noMarkerRoot, { recursive: true, force: true });
  }
  check("No implicit dataRoot or unmarked directory is accepted", markerRejected);

  let badMarkerRejected = false;
  const badMarkerRoot = mkdtempSync(join(tmpBase, "t85-bad-marker-"));
  try {
    writeFileSync(join(badMarkerRoot, WORKFLOW_PREFLIGHT_ISOLATION_MARKER), "untrusted marker\\n", "utf8");
    try {
      runWorkflowMigrationPreflight({
        isolationRoot: badMarkerRoot,
        authorization: { kind: "fictional-fixture", isolatedReadOnlyCopy: true },
        sources: [{ sourceId: "bad-marker", kind: "workflow-doc", direction: "mcode-to-node-red", content: doc("bad-marker"), runtimeFacts: SAFE_FACTS }],
        types: TYPES,
      });
    } catch {
      badMarkerRejected = true;
    }
  } finally {
    rmSync(badMarkerRoot, { recursive: true, force: true });
  }
  check("Tampered/untrusted isolation marker is explicitly rejected", badMarkerRejected);

  check("G0-G5 release table keeps G2-G5 blocked and never authorizes activation",
    report1.gate === "G0-G1" && report1.activationAllowed === false
      && report1.gateReleaseTable.length === 6
      && report1.gateReleaseTable.filter((gate) => ["G2", "G3", "G4", "G5"].includes(gate.gate)).every((gate) => gate.status === "blocked" && gate.activationAllowed === false),
    report1.gateReleaseTable);

  console.log("t85-workflow-migration-preflight-smoke: " + (checks - failures) + "/" + checks + " passed");
  if (failures > 0) process.exitCode = 1;

  // Keep a stable, concise JSON summary in stdout; no source paths or credentials.
  console.log(JSON.stringify({
    manifestHash: report1.manifestHash,
    counts: report1.counts,
    unreadableCount: report1.unreadableCount,
    fA: fArow?.decision,
    fB: fBrow?.decision,
    fC: fCrow?.decision,
    fD: fDrow?.decision,
    fE: fErow?.decision,
    fF: fFrow?.decision,
    fG: fGrow?.decision,
    fH: fHrow?.decision,
    fI: fIrow?.decision,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
}
