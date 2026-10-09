/** Green-only handoff regression: ImportBar must show an IPC error to the user. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportBar } from "../../src/renderer/components/library/ImportPanel.js";
import { beginRender, reset, stateAt } from "./stubs/reactEffects/index.js";
import { calls, resetCalls } from "./stubs/importDeps.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const el = value as Element;
  return [el, ...elements(el.props.children)];
}

/* ── 1. IPC 报错必须留在界面上(现有回归) ── */
reset(); beginRender();
const tree = ImportBar({ onClose: () => {}, collectionId: "c", onImported: () => {} });
const button = elements(tree).find((el) => el.type === "button" &&
  elements(el.props.children).length === 0 && el.props.children === "library.import.pickFile");
assert.ok(button, "the import-files action is a native keyboard button");
(button.props.onClick as () => void)();
await new Promise((resolve) => setImmediate(resolve));
// hook slot 顺序(beginRender 后按调用序):0 = busy(state)、1 = busyRef(ref)、2 = message(state)。
assert.equal(stateAt<boolean>(0), false, "busy state clears after a rejected IPC");
assert.match(stateAt<string>(2), /library\.import\.operationFailed.*fixture IPC unavailable/);
console.log("PASS import IPC errors remain visible after handoff");

/* ── 2. ★ 连按两次「新建」(标题框上的 Enter)只能建一条笔记 ──
 *
 * 那颗「新建」按钮 `disabled={busy}`,但标题输入框没有 —— 它的 Enter 直接走
 * `createNoteNow`。两次按键之间 React 还没重渲染,只靠 `busy` state 挡不住;
 * 得靠同步的 `busyRef`。撤掉守卫 → `calls.createNote` 会是 2,这条必红。 */
resetCalls(); reset(); beginRender();
const tree2 = ImportBar({ onClose: () => {}, collectionId: "c", onImported: () => {} });
const titleInput = elements(tree2).find((el) => el.props &&
  typeof el.props.onKeyDown === "function" && el.props.placeholder === "library.note.placeholder");
assert.ok(titleInput, "标题输入框带着 Enter 提交的 onKeyDown");
const enter = { key: "Enter", nativeEvent: { isComposing: false, keyCode: 13 } } as unknown as KeyboardEvent;
(titleInput.props.onKeyDown as (e: KeyboardEvent) => void)(enter);
(titleInput.props.onKeyDown as (e: KeyboardEvent) => void)(enter); // 第二次连按,不 await
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.createNote, 1, "连按两次 Enter 只建一条笔记(重入守卫收口)");
console.log("PASS double Enter on the note title creates exactly one note");

/* ── 3. ★ 源码不变量 ── */
const here = process.cwd(); // run.sh 里 cd apps/desktop 再跑
const importSrc = readFileSync(join(here, "src/renderer/components/library/ImportPanel.tsx"), "utf8");
assert.ok(importSrc.includes("busyRef"), "ImportPanel 用同步 ref 做重入守卫");
const guardedEntrances = importSrc.match(/if \(busyRef\.current\) return;/g) ?? [];
assert.equal(guardedEntrances.length, 4, "四个入口(新建/导入文件/文件夹/批量)都带重入守卫");

const itemNotesSrc = readFileSync(join(here, "src/renderer/components/library/ItemNotes.tsx"), "utf8");
assert.ok(/const savingRef = useRef\(false\)/.test(itemNotesSrc), "ItemNotes 用 ref 做保存重入守卫");
assert.ok(/if \(savingRef\.current\) return;/.test(itemNotesSrc), "save() 开头挡住重入");

// DeleteItemsDialog:失败回报里印的是**人话**,不是 kind 哨兵。
const delSrc = readFileSync(join(here, "src/renderer/components/library/DeleteItemsDialog.tsx"), "utf8");
assert.ok(
  /t\(`library\.del\.kind\.\$\{failure\.kind\}`\)/.test(delSrc),
  "删除失败那行按 kind 走 i18n,不把 pdf/markdown/file 原样摊出来",
);
assert.ok(!/\$\{failure\.kind\}: \$\{failure\.path\}/.test(delSrc), "不再直接内插裸 kind 哨兵");
console.log("PASS source invariants for re-entry guards and delete-failure wording");
