import type { WorkflowDoc } from "@contracts/workflow";

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Only reconcile fields that have not changed since this save was submitted. */
export function mergeSavedWorkflow(current: WorkflowDoc, submitted: WorkflowDoc, saved: WorkflowDoc): WorkflowDoc {
  if (current.id !== saved.id || submitted.id !== saved.id) throw new Error("Workflow save identity mismatch");
  return {
    ...saved,
    name: current.name === submitted.name ? saved.name : current.name,
    description: current.description === submitted.description ? saved.description : current.description,
    icon: current.icon === submitted.icon ? saved.icon : current.icon,
    prompt: current.prompt === submitted.prompt ? saved.prompt : current.prompt,
    frameworkNote: current.frameworkNote === submitted.frameworkNote ? saved.frameworkNote : current.frameworkNote,
    nodes: same(current.nodes, submitted.nodes) ? saved.nodes : current.nodes,
    edges: same(current.edges, submitted.edges) ? saved.edges : current.edges,
  };
}

/** Restore the baseline's structural references after undo/no-op edits. */
export function normalizeDraft(doc: WorkflowDoc, baseline: WorkflowDoc): WorkflowDoc {
  return { ...doc,
    nodes: same(doc.nodes, baseline.nodes) ? baseline.nodes : doc.nodes,
    edges: same(doc.edges, baseline.edges) ? baseline.edges : doc.edges,
  };
}

export function sameEditableWorkflow(a: WorkflowDoc, b: WorkflowDoc): boolean {
  return a.id === b.id && a.prompt === b.prompt && a.frameworkNote === b.frameworkNote &&
    (a.builtin || (a.name === b.name && a.description === b.description)) &&
    same(a.nodes, b.nodes) && same(a.edges, b.edges);
}

/** Bounded immutable snapshots; a drag is recorded once on mouse-up. */
export class WorkflowEditHistory {
  private past: WorkflowDoc[] = [];
  private future: WorkflowDoc[] = [];
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.past = []; this.future = []; }
  record(previous: WorkflowDoc, next: WorkflowDoc): boolean {
    if (sameEditableWorkflow(previous, next)) return false;
    this.past = [...this.past.slice(-79), previous];
    this.future = [];
    return true;
  }
  undo(current: WorkflowDoc): WorkflowDoc | undefined {
    const previous = this.past.pop();
    if (previous) this.future.push(current);
    return previous;
  }
  redo(current: WorkflowDoc): WorkflowDoc | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }
}
