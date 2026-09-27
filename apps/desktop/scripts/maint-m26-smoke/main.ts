/** Real M26 component render logic under inert React hooks and view doubles.
 * Test both a parent re-render and actual store subscription for new overrides.
 * Fails if the target panels are not bundled or if their memo keeps the old rows.
 */
import { ShortcutsPanel } from "../../src/renderer/components/settings/ShortcutsPanel.js";
import { GesturesPanel } from "../../src/renderer/components/settings/GesturesPanel.js";

type Tree = { props?: Record<string, unknown> };
interface Lab {
  index: number;
  hooks: Array<{ deps: readonly unknown[]; value: unknown }>;
  selected: unknown[];
  t: (key: string) => string;
  state: {
    visible: Array<{ id: string; label: string; group: string; perform: () => void }>;
    shortcutOverrides: Record<string, string>;
    gestureSettings: { enabled: boolean; trigger: "right"; overrides: Record<string, string> };
    resetAllShortcuts: () => void;
    resetAllGestures: () => void;
    setGestureEnabled: () => void;
    setGestureTrigger: () => void;
  };
}
const lab: Lab = {
  index: 0, hooks: [], selected: [], t: (key) => key,
  state: {
    visible: [{ id: "base", label: "Base", group: "view", perform: () => {} }],
    shortcutOverrides: {},
    gestureSettings: { enabled: true, trigger: "right", overrides: {} },
    resetAllShortcuts: () => {}, resetAllGestures: () => {},
    setGestureEnabled: () => {}, setGestureTrigger: () => {},
  },
};
(globalThis as typeof globalThis & { __m26: Lab }).__m26 = lab;
let failures = 0;
let checks = 0;
function check(name: string, pass: boolean, detail?: unknown): void {
  checks++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!pass) failures++;
}
function ids(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(ids);
  if (!tree || typeof tree !== "object") return [];
  const node = tree as Tree;
  return [
    ...(typeof node.props?.commandId === "string" ? [node.props.commandId] : []),
    ...ids(node.props?.children),
  ];
}
function render(panel: () => unknown): string[] {
  lab.index = 0;
  lab.selected = [];
  return ids(panel());
}
// Shortcuts: the component must *subscribe* to overrides, not only peek at getState.
let first = render(ShortcutsPanel);
check("shortcuts initial real panel row", first.includes("base"), first);
check("shortcuts subscribes to overrides for reactive updates", lab.selected.includes(lab.state.shortcutOverrides));
lab.state = { ...lab.state, shortcutOverrides: { "gated.command": "Ctrl+G" } };
let second = render(ShortcutsPanel);
check("shortcuts new override appears without remount or locale flip", second.includes("gated.command"), second);
// Gestures: even though the panel subscribes to gestureSettings, its memo must invalidate.
lab.hooks = [];
first = render(GesturesPanel);
check("gestures initial real panel row", first.includes("base"), first);
lab.state = { ...lab.state, gestureSettings: { ...lab.state.gestureSettings, overrides: { "gated.command": "LR" } } };
second = render(GesturesPanel);
check("gestures new override appears without remount or locale flip", second.includes("gated.command"), second);
console.log(`M26: ${checks - failures}/${checks} checks pass`);
if (failures) process.exitCode = 1;
