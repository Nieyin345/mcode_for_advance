/**
 * pickers.ts — 渲染端选择器/对话框的行为回归,对应本轮修的四处:
 *
 *   ① `LibraryPicker(autoExpandItems)` 只把分类标成"展开着"却**从不拉条目** ——
 *      用户点开关联选择器看到的还是空的(正是那个 prop 想解决的"看着是空的")。
 *   ② `LibraryPicker` 勾选后再改搜索词,被滤掉的那条被**静默丢掉**(`confirm` 注释承诺
 *      "不能悄悄丢掉",但它当时是从 `query` 过滤过的 `rows` 里找名字)。
 *   ③ `ItemNotes` 的"改/删"那一对是 `hidden group-hover:flex`(`display:none` 的按钮
 *      进不了 Tab 序列),兄弟 `ItemLinks` / `Sidebar` 行都带 `group-focus-within:flex`;
 *      而且借了分类的标签(悬停读到「删除分类」),实际删的是**笔记**。
 *   ④ `DeleteItemsDialog` 的可勾 checkbox 缺 `aria-label`(兄弟 `ItemList` 的每只都带)。
 *
 * 跑法见 run.sh;不起浏览器、不写盘。
 */
import "./pickers-prelude.js";
import { __mount, __flush, __nodes } from "./fakeReact.js";
import type { LibraryItem, LibraryNote } from "@contracts/library";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
};

/* ───────────────── ① LibraryPicker: autoExpandItems 必须真把条目拉回来 ───────────────── */
{
  const { LibraryPicker } = await import("@renderer/components/chat/LibraryPicker.js");
  const { __setState } = await import("./stubs/pickerStore.js");
  const { listCalls } = await import("./stubs/pickerApi.js");
  const col = (id: string) => ({ id, name: `集合${id}`, groupId: "g", parentId: null, createdAt: 1 });
  const item = (id: string) => ({ id, title: `条目${id}` } as LibraryItem);
  __setState({ collections: [col("c1"), col("c2")] });
  listCalls.length = 0;
  __mount(() => LibraryPicker({
    open: true,
    anchorRect: { top: 400, left: 40, width: 400, height: 30 } as DOMRect,
    autoExpandItems: true,
    onPick: () => {},
    onClose: () => {},
  }));
  await __flush();
  check("★ autoExpandItems 打开后为每个分类发一次 library.list(不是只标展开)",
    listCalls.length === 2, { openedCalls: listCalls.length });
  for (const c of listCalls) {
    c.resolve({ items: [item((c.opts as { collectionId: string }).collectionId)] });
  }
  await __flush();
  const itemRows = __nodes().filter((n) => n.type === "button" &&
    typeof n.props.title === "string" && (n.props.title as string).startsWith("条目"));
  check("★ 条目 resolve 后列出来(不再“看着是空的”)",
    itemRows.length === 2, { rows: itemRows.map((n) => n.props.title) });
}

/* ───────────────── ② ItemNotes: 改/删按钮在键盘聚焦时也要露出来 ───────────────── */
{
  const { ItemNotes } = await import("@renderer/components/library/ItemNotes.js");
  const { setNotesFixture } = await import("./stubs/pickerApi.js");
  const note = { id: "n1", itemId: "it1", content: "记一句", origin: "user", createdAt: 1, updatedAt: 1 } as LibraryNote;
  setNotesFixture([note]);
  __mount(() => ItemNotes({ item: { id: "it1", title: "一篇" } as LibraryItem }));
  await __flush();
  const span = __nodes().find((n) => n.type === "span" &&
    typeof n.props.className === "string" && (n.props.className as string).includes("group-hover:flex"));
  check("★ 悬停操作 span 同时带 group-focus-within:flex(键盘够得着)", !!span &&
    (span!.props.className as string).includes("group-focus-within:flex"),
    { className: span?.props.className ?? null });

  // 行内那对按钮的 tip/可访问名必须说清是**笔记**的操作,不能借分类的标签
  // (`library.collection.delete` = "删除分类")—— 用户在一条笔记上读到「删除分类」对不上。
  const titles = __nodes().filter((n) => n.type === "button" && typeof n.props.title === "string")
    .map((n) => n.props.title as string);
  check("★ 笔记的编辑按钮说的是“编辑这条笔记”,不是分类的“重命名”",
    titles.includes("library.itemNote.edit") && !titles.includes("library.collection.rename"), { titles });
  check("★ 笔记的删除按钮说的是“删除这条笔记”,不是分类的“删除分类”",
    titles.includes("library.itemNote.delete") && !titles.includes("library.collection.delete"), { titles });
}

/* ───────────────── ③ DeleteItemsDialog: 可勾的 checkbox 要有可访问名 ───────────────── */
{
  const { DeleteItemsDialog } = await import("@renderer/components/library/DeleteItemsDialog.js");
  const { setPreviewFixture } = await import("./stubs/pickerApi.js");
  setPreviewFixture([
    {
      id: "e1",
      title: "一篇论文",
      links: [
        { form: "item", targetItemId: "t1", title: "关联的另一篇" },
        { form: "transcript", title: "转录.md", imageCount: 3 },
        { form: "path", targetPath: "/x.pdf", title: "库外.pdf" },
      ],
    },
  ]);
  __mount(() => DeleteItemsDialog({
    open: true,
    ids: ["e1"],
    onOpenChange: () => {},
    onConfirmed: () => {},
  }));
  await __flush();
  const boxes = __nodes().filter((n) => n.type === "input" && n.props.type === "checkbox");
  check("★ 删除确认框渲染出可勾的 checkbox(item + transcript 两档)",
    boxes.length === 2, { boxes: boxes.length });
  check("★ 每个可勾 checkbox 都有 aria-label(不是只会念“复选框”)",
    boxes.length > 0 && boxes.every((b) => typeof b.props["aria-label"] === "string" && (b.props["aria-label"] as string).length > 0),
    { labels: boxes.map((b) => b.props["aria-label"] ?? null) });
}

/* ───────────────── ④ LibraryPicker: 勾选后再搜索,被滤掉的那条不能被静默丢掉 ───────────────── */
{
  const { LibraryPicker } = await import("@renderer/components/chat/LibraryPicker.js");
  const { __setState } = await import("./stubs/pickerStore.js");
  const { listCalls } = await import("./stubs/pickerApi.js");
  const col = { id: "cA", name: "Alpha", groupId: "g", parentId: null, createdAt: 1 };
  const item = (id: string, title: string) => ({ id, title } as LibraryItem);
  __setState({ collections: [col] });
  listCalls.length = 0;
  let picked: Array<{ key: string; name: string }> = [];
  __mount(() => LibraryPicker({
    open: true,
    anchorRect: { top: 400, left: 40, width: 400, height: 30 } as DOMRect,
    autoExpandItems: true,
    onPick: (p) => { picked = p; },
    onClose: () => {},
  }));
  await __flush();
  for (const c of listCalls) c.resolve({ items: [item("i1", "Apple"), item("i2", "Banana")] });
  await __flush();
  // 勾 "Apple"。
  const appleRow = __nodes().find((n) => n.type === "button" && n.props.title === "Apple");
  (appleRow!.props.onClick as () => void)();
  await __flush();
  // 再把搜索词改成 "Banana" —— "Apple" 被滤出可见列表,但它仍是勾选态。
  const input = __nodes().find((n) => n.type === "input" && "value" in n.props && !!n.props.placeholder);
  (input!.props.onChange as (e: unknown) => void)({ target: { value: "Banana" } });
  await __flush();
  // 确认:「Apple」必须仍在 onPick 里(注释承诺"不能悄悄丢掉")。
  const confirmBtn = __nodes().find((n) => n.type === "button" &&
    typeof n.props.children === "string" && (n.props.children as string).startsWith("library.chat.addN"));
  (confirmBtn!.props.onClick as () => void)();
  check("★ 勾选后被搜索滤掉的条目仍进 onPick(带名字,不静默丢)",
    picked.length === 1 && picked[0].key === "i:i1" && picked[0].name === "Apple", { picked });
}

console.log(`\npickers:${failures === 0 ? "all passed" : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
