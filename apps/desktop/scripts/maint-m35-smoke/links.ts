/** Reorder real ItemLinks IPC completion; assert stale details never reappear. */
import assert from "node:assert/strict";
import type { LibraryItem, LibraryLinkView } from "@contracts/library";
import { ItemLinks } from "@renderer/components/library/ItemDetail.js";
import { linkCalls } from "./stubs/linksDeps.js";
import { beginRender, cleanupEffects, commitEffects, reset, stateAt } from "./stubs/reactEffects/index.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const el = value as Element;
  return [el, ...elements(el.props.children)];
}
const item = (id: string): LibraryItem => ({ id, title: id } as LibraryItem);
const link = (id: string): LibraryLinkView =>
  ({ id, direction: "out", title: id, otherItemId: "another" } as LibraryLinkView);
reset(); linkCalls.length = 0;
beginRender(); ItemLinks({ item: item("A") }); commitEffects();
cleanupEffects();
beginRender(); ItemLinks({ item: item("B") }); commitEffects();
assert.deepEqual(linkCalls.map((c) => c.itemId), ["A", "B"]);
linkCalls[1]!.resolve({ links: [link("B-link")] }); await Promise.resolve();
assert.deepEqual(stateAt<LibraryLinkView[]>(0).map((l) => l.id), ["B-link"]);
linkCalls[0]!.resolve({ links: [link("A-link")] }); await Promise.resolve();
let fails = 0;
try {
  assert.deepEqual(stateAt<LibraryLinkView[]>(0).map((l) => l.id), ["B-link"]);
  console.log("PASS late A links cannot replace B's detail view");
} catch (err) { fails++; console.error("FAIL stale link detail:", err); }
// Render current links; keyboard focus must make the icon-only remove button visible.
beginRender();
const tree = ItemLinks({ item: item("B") });
const remove = elements(tree).find((el) => el.type === "button" && el.props.title === "library.links.remove");
try {
  assert.ok(remove, "loaded links should have a remove button");
  assert.ok((remove.props.className as string).includes("focus-visible:opacity-100") ||
    (remove.props.className as string).includes("group-focus-within:opacity-100"),
    "Tab focus must reveal the hover-only remove action");
  assert.equal(remove.props["aria-label"], "library.links.remove");
  console.log("PASS link removal is visible and named on keyboard focus");
} catch (err) { fails++; console.error("FAIL link remove keyboard focus:", err); }
if (fails) process.exitCode = 1;
