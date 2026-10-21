/** T58: mirror a successful, authenticated native POST /flows into existing Mcode docs.
 * Do not fabricate library records for standalone Node-RED tabs or let the
 * editor bypass the shared workflow validation / review / CAS save boundary.
 */
import { flowToWorkflowDoc, type NodeRedNode, type NodeRedFlow } from "./flowMigration.js";
import type { WorkflowDoc } from "@contracts/workflow";

export interface NativeLibrarySyncPorts {
  get(id: string): WorkflowDoc | null;
  save(doc: WorkflowDoc, expectedRevision: string): Promise<{ ok: boolean; error?: string }>;
  revision(doc: WorkflowDoc): string;
  changed(id: string): void;
}

/** A native deploy is a whole graph: each tagged tab must be isolated by z.
 * Reject missing/ambiguous membership rather than folding unrelated tabs or
 * global config nodes into a WorkflowDoc. Caller already owns POST /flows.
 */
export function nativeLibraryDocsOf(nodes: unknown): WorkflowDoc[] {
  if (!Array.isArray(nodes)) throw new Error("Node-RED deploy payload is not a node list");
  const parsed = nodes as NodeRedNode[];
  const docs: WorkflowDoc[] = [];
  const ids = new Set<string>();
  for (const tab of parsed) {
    if (tab?.type !== "tab" || tab["x-mcode"] === undefined) continue;
    const meta = tab["x-mcode"] as Record<string, unknown>;
    const docId = meta?.docId;
    if (typeof docId !== "string" || !docId || ids.has(docId)) {
      throw new Error("Node-RED deploy has an invalid/duplicate Mcode doc identity");
    }
    ids.add(docId);
    const members = parsed.filter(n => n.type !== "tab" && n.z === tab.id);
    // Mcode-owned nodes must stay in their original tab. Moving a node to an
    // unrelated tab loses that association and cannot be silently re-imported.
    const flow: NodeRedFlow = {
      id: tab.id,
      label: typeof tab.label === "string" ? tab.label : "",
      nodes: [tab, ...members],
    };
    const doc = flowToWorkflowDoc(flow);
    if (doc.id !== docId) throw new Error("Node-RED document identity mismatch");
    docs.push(doc);
  }
  return docs;
}

export async function syncNativeLibraryDocs(nodes: unknown, ports: NativeLibrarySyncPorts): Promise<string[]> {
  const updated: string[] = [];
  for (const doc of nativeLibraryDocsOf(nodes)) {
    const existing = ports.get(doc.id);
    if (!existing) continue; // native-only and deleted documents MUST NOT be upserted
    const saved = await ports.save(doc, ports.revision(existing));
    if (!saved.ok) throw new Error(`Node-RED deploy library sync failed for ${doc.id}: ${saved.error ?? "rejected"}`);
    ports.changed(doc.id);
    updated.push(doc.id);
  }
  return updated;
}

/** Production ports import lazily: owner-only unit tests never touch a user DB. */
export async function syncDeployedNativeWorkflows(nodes: unknown): Promise<string[]> {
  if (!Array.isArray(nodes) || !nodes.some(
    (n: unknown) => n !== null && typeof n === "object"
      && (n as NodeRedNode).type === "tab" && (n as NodeRedNode)["x-mcode"] !== undefined,
  )) return [];
  const [{ getWorkflow, saveWorkflow }, { workflowSaveVersion }, { notifyWorkflowsChanged }] = await Promise.all([
    import("@main/orchestration/library.js"),
    import("@main/orchestration/workflowSaveVersion.js"),
    import("@main/orchestration/broadcast.js"),
  ]);
  return syncNativeLibraryDocs(nodes, {
    get: getWorkflow,
    revision: workflowSaveVersion,
    // Native edits are an untrusted external source: always require review
    // again, even if the old Mcode graph was previously approved.
    save: (doc, expectedRevision) => saveWorkflow(doc, { expectedRevision, untrustedOrigin: "import" }),
    changed: id => notifyWorkflowsChanged(`node-red:deploy:${id}`),
  });
}
