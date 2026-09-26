// Isolation boundary for workflow settings tests. An unrelated rich-text editor
// may be developed independently; it must never be mounted by these scenarios.
export function MarkdownEditorPane(): never {
  throw new Error("Workflow settings test unexpectedly mounted MarkdownEditorPane");
}
