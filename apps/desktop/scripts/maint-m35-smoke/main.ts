/** M35 executable regressions, using the real store/component/filesystem module. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { LibraryCollection, LibraryItem } from "@contracts/library";
import { useLibraryStore } from "../../src/renderer/stores/libraryStore.js";
import { ItemList } from "../../src/renderer/components/library/ItemList.js";
import { highlightsPathFor, readHighlights, writeHighlights } from "../../src/main/library/pdfHighlightsStore.js";
import { collectionCalls, listCalls, setCreationResult } from "./stubs/api.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown }; key?: string | null };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const el = value as Element;
  return [el, ...elements(el.props.children)];
}
function item(id: string): LibraryItem { return { id, title: id, pdfPath: "" } as LibraryItem; }
function col(id: string): LibraryCollection {
  return { id, name: id, groupId: "g", parentId: null, createdAt: 1 } as LibraryCollection;
}
function reset() {
  listCalls.length = 0;
  collectionCalls.length = 0;
  useLibraryStore.setState({ collections: [], loaded: false, activeCollectionId: null,
    chatCollectionId: null, itemsByCollection: {}, allItems: null });
}
let failures = 0;
async function scenario(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (err) { failures++; console.error(`FAIL ${name}:`, err); }
}

await scenario("late old collection listing cannot replace newer listing", async () => {
  reset();
  const first = useLibraryStore.getState().loadCollections();
  const second = useLibraryStore.getState().loadCollections();
  assert.equal(collectionCalls.length, 2);
  collectionCalls[1]!.resolve({ collections: [col("fresh")] }); await second;
  collectionCalls[0]!.resolve({ collections: [col("stale")] }); await first;
  assert.deepEqual(useLibraryStore.getState().collections.map((c) => c.id), ["fresh"]);
});
await scenario("old refresh cannot undo a newly created collection", async () => {
  reset();
  const oldRead = useLibraryStore.getState().loadCollections();
  setCreationResult([col("new")]);
  assert.equal(await useLibraryStore.getState().createCollection("new", "g"), "new");
  collectionCalls[0]!.resolve({ collections: [] }); await oldRead;
  assert.deepEqual(useLibraryStore.getState().collections.map((c) => c.id), ["new"]);
  assert.equal(useLibraryStore.getState().loaded, true, "successful creation must finish initial loading when its old listing is discarded");
});
await scenario("late old result cannot overwrite newer collection items", async () => {
  reset(); useLibraryStore.setState({ collections: [col("c")], loaded: true });
  const first = useLibraryStore.getState().loadCollectionItems("c");
  const second = useLibraryStore.getState().loadCollectionItems("c");
  assert.equal(listCalls.length, 2);
  listCalls[1]!.resolve({ items: [item("fresh")] }); await second;
  listCalls[0]!.resolve({ items: [item("stale")] }); await first;
  assert.deepEqual(useLibraryStore.getState().itemsByCollection.c?.map((i) => i.id), ["fresh"]);
});
await scenario("late old result cannot overwrite newer all-items view", async () => {
  reset();
  const first = useLibraryStore.getState().loadAllItems();
  const second = useLibraryStore.getState().loadAllItems();
  assert.equal(listCalls.length, 2);
  listCalls[1]!.resolve({ items: [item("fresh")] }); await second;
  listCalls[0]!.resolve({ items: [item("stale")] }); await first;
  assert.deepEqual(useLibraryStore.getState().allItems?.map((i) => i.id), ["fresh"]);
});
await scenario("deleting a collection cannot resurrect its in-flight item list", async () => {
  reset(); useLibraryStore.setState({ collections: [col("gone")], loaded: true,
    itemsByCollection: { gone: [item("old")] } });
  const itemsRead = useLibraryStore.getState().loadCollectionItems("gone");
  const deleteRead = useLibraryStore.getState().loadCollections();
  collectionCalls[0]!.resolve({ collections: [] }); await deleteRead;
  listCalls[0]!.resolve({ items: [item("zombie")] }); await itemsRead;
  assert.equal(useLibraryStore.getState().itemsByCollection.gone, undefined);
});
await scenario("item activation and selection are separately keyboard reachable and named", () => {
  let activated = "";
  const tree = ItemList({ items: [item("paper")], activeId: null,
    selectedIds: [], onActivate: (id) => { activated = id; }, onToggleSelect: () => {},
    onSelectAll: () => {}, onImport: () => {}, onSearch: () => {} });
  const rendered = elements(tree);
  const buttons = rendered.filter((el) => el.type === "button");
  assert.equal(buttons.length, 1, "each nonempty row needs a native, focusable activation button");
  assert.equal(buttons[0]!.props.type, "button");
  (buttons[0]!.props.onClick as () => void)();
  assert.equal(activated, "paper");
  const checkboxes = rendered.filter((el) => el.type === "input" && el.props.type === "checkbox");
  assert.equal(checkboxes.length, 2);
  assert.ok(checkboxes.every((el) => typeof el.props["aria-label"] === "string" &&
    (el.props["aria-label"] as string).length > 0));
});
await scenario("corrupt annotation index is recoverable after the next save", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcode-m35-annotations-"));
  try {
    const pdf = join(dir, "paper.pdf");
    const sidecar = highlightsPathFor(pdf);
    writeFileSync(pdf, "%PDF-1.7 test");
    writeHighlights(pdf, []);
    writeHighlights(pdf, []);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith(basename(sidecar) + ".corrupt-")).length, 0,
      "ordinary saves should not leave backup files");
    const damaged = '{ "half": [an important old annotation';
    writeFileSync(sidecar, damaged);
    assert.deepEqual(readHighlights(pdf), []);
    assert.equal(readFileSync(sidecar, "utf8"), damaged, "a read must never replace a broken sidecar");
    writeHighlights(pdf, []); // normal user save/recovery; old smoke expects this to work
    assert.deepEqual(readHighlights(pdf), []);
    const backups = readdirSync(dir).filter((name) => name.startsWith(basename(sidecar) + ".corrupt-"));
    assert.equal(backups.length, 1, "backup must be made before replacing an unreadable index");
    assert.equal(readFileSync(join(dir, backups[0]!), "utf8"), damaged);
    assert.equal(readFileSync(pdf, "utf8"), "%PDF-1.7 test");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// ★ 资料库的「在文件夹中显示 / 在文件夹中打开」失败必须报出来。
//   `library.revealFile` 会带原因回 `{ok:false}`(条目不在了 / 文件不在了 / 还没转换
//   产物),而三处调用方从前都是 `void api…` 一丢了事 —— 用户点了那颗按钮,屏幕上
//   一个字都没有(主进程 handler 的注释里点名了这一类)。判据钉在源码上(这几个组件
//   跑不进无头,本套没有渲染端 host)。
await scenario("revealFile / openFile 的 {ok:false} 在每个调用方都报出来", () => {
  const targets: Array<[string, string, RegExp]> = [
    ["ItemDetail", join(process.cwd(), "src/renderer/components/library/ItemDetail.tsx"), /api\.library\s*\.\s*revealFile/g],
    ["LibraryItemContextMenu", join(process.cwd(), "src/renderer/components/library/LibraryItemContextMenu.tsx"), /api\.library\s*\.\s*revealFile/g],
    ["PdfPreviewImpl", join(process.cwd(), "src/renderer/components/library/PdfPreviewImpl.tsx"), /api\.library\s*\.\s*openFile/g],
  ];
  // 去掉注释,免得注释里的示例调用把判据喂饱。
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [label, path, re] of targets) {
    const code = strip(readFileSync(path, "utf8"));
    // **每一个**调用点都要查 —— 只查第一处会让"三处里修了一处"假绿
    // (ItemDetail 自己就有两处:PDF 那颗与 md 那颗)。写成 `api.library.revealFile`
    // 会被换行拆开(`api.library\n  .revealFile(`),所以按正则容忍空白。
    let sites = 0;
    for (const m of code.matchAll(re)) {
      sites++;
      const body = code.slice(m.index!, m.index! + 500);
      assert.ok(/\.then\(/.test(body), `${label} 第 ${sites} 处: 没接回包(仍是 void 一丢了事)`);
      assert.ok(/!res\.ok/.test(body), `${label} 第 ${sites} 处: 不看 {ok:false}`);
      assert.ok(body.includes("useToastStore"), `${label} 第 ${sites} 处: 失败没报出来`);
    }
    assert.ok(sites >= 1, `${label}: 找不到调用(判据失效 —— 源码可能改了形状)`);
  }
});
console.log(`M35 store/accessibility/annotations: ${8 - failures}/8 passed`);
if (failures) process.exitCode = 1;
