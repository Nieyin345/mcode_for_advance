/** Green-only handoff regression: ImportBar must show an IPC error to the user. */
import assert from "node:assert/strict";
import { ImportBar } from "../../src/renderer/components/library/ImportPanel.js";
import { beginRender, reset, stateAt } from "./stubs/reactEffects/index.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const el = value as Element;
  return [el, ...elements(el.props.children)];
}
reset(); beginRender();
const tree = ImportBar({ onClose: () => {}, collectionId: "c", onImported: () => {} });
const button = elements(tree).find((el) => el.type === "button" &&
  elements(el.props.children).length === 0 && el.props.children === "library.import.pickFile");
assert.ok(button, "the import-files action is a native keyboard button");
(button.props.onClick as () => void)();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(stateAt<boolean>(0), false, "busy state clears after a rejected IPC");
assert.match(stateAt<string>(1), /library\.import\.operationFailed.*fixture IPC unavailable/);
console.log("PASS import IPC errors remain visible after handoff");
