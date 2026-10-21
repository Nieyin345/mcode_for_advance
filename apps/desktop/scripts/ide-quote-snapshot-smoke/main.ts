/**
 * ide-quote-snapshot-smoke —— 【MC-098】「引用正文与行号必须同出一份**冻结快照**」的真实入口 E1。
 *
 * ## 缺陷(修前)
 *
 * `FileEditor.tsx` 的 `EditPane`:`readMonacoSelection` 在**选中那一刻**把选中文字冻结进
 * `mdSel.text`,但用户在 `SelectionQuoteMenu` 选定目标后,`quoteFromEditor` 又从
 * `editorRef.current.getSelection()` **现读此刻**的范围作为行号。用户在「选中 A → 打开引用
 * 菜单 → 改/撤选区成 B → 选定目标」之间动了选区时,引用的正文是 A(旧)、行号却是 B(新)——
 * 一层里混了两份快照。
 *
 * ## 判据
 *
 * 驱动**真** `EditPane` 走那条精确序列,断言落到草稿里的 tag:
 *   - 正文与行号**都**对应 A(正文含 A 的句子、source 行号写 `(line 1)`),
 *   - **绝不**出现 B 的行号(`(line 3)`),
 *   - 外加一个「什么都没变」的正控,证这条断言能绿(不是恒红)。
 *
 * ## 它怎么跑
 *
 * esbuild 换 `react` 为极小 hooks 运行时(组件源码原样跑);`@monaco-editor/react` 换成
 * 直通 stub —— `Editor` 的 `onMount` 由本文件从树里取出来**手动调用**,也就是跑**真**
 * `handleEditorMount`(注册真 `onDidChangeCursorSelection` 等监听)。用一台可编程的
 * **假 Monaco**(选区可变、`getValueInRange` 真按行切)喂给真组件。其余重量级子件全部
 * 空壳。不起浏览器、不连 LSP、不写盘。
 *
 * ⚠️ 仍留在真实浏览器/Monaco 的最后一里:真 Monaco 的 `getSelection()` 返回、真文档
 * 选区拖拽、`@monaco-editor/react` 的 `onMount` 触发 —— 这里用假 Monaco 顶替,
 * 验的是**引用组合这一层的快照一致性**,不是 Monaco 本体。
 *
 * Run: scripts/ide-quote-snapshot-smoke/run.sh
 */
import { __fireDocumentEvent, __resetDocumentListeners } from "./prelude.js";
import { __mount, __flush, __nodes, __text } from "./fakeReact.js";
import { readFileSync } from "node:fs";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { registerModel } from "@renderer/lib/editorModelCache.js";
import { EditPane } from "@renderer/components/ide/FileEditor.js";
import { SelectionToolbar } from "@renderer/components/chat/SelectionToolbar.js";
import { SelectionQuoteMenu } from "@renderer/components/chat/SelectionQuoteMenu.js";
import { Editor } from "@monaco-editor/react";
import { captureMonacoCitationSelection, MAX_MONACO_QUOTE_CHARS, MAX_MONACO_QUOTE_LINES } from "@renderer/components/ide/monacoCitationSelection.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

type El = { type: unknown; props: Record<string, unknown> };

const FILE = "/workspace/a.ts";
const CONTENT =
  "AAAA first line of selection\n" +   // line 1
  "BBBB second line of selection\n" +  // line 2
  "CCCC third line of selection\n";    // line 3

/** 一台可编程的**假 Monaco model**:`getValueInRange` 真按行/列切出子串 —— 这样
 *  「正文是哪一段」由真实选区算出来,而不是我们手填。 */
function makeModel(content: string) {
  const lines = content.split("\n");
  return {
    getValueInRange(sel: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string {
      const out: string[] = [];
      for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
        const lineText = lines[ln - 1] ?? "";
        const startCol = ln === sel.startLineNumber ? sel.startColumn : 1;
        const endCol = ln === sel.endLineNumber ? sel.endColumn : lineText.length + 1;
        out.push(lineText.slice(startCol - 1, endCol - 1));
      }
      return out.join("\n");
    },
    getValue: () => content,
    getValueLength: () => content.length,
    isDisposed: () => false,
    getEOL: () => "\n",
    pushStackElement: () => {},
    pushEditOperations: () => {},
    setValue: () => {},
    getLineContent: (n: number) => lines[n - 1] ?? "",
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: 1 }),
    uri: { toString: () => "inmemory://model/0" },
  };
}

type Sel = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
const EMPTY = (sel: Sel) =>
  sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;

/** 假 Monaco 编辑器:选区**可变**(这就是"用户在选中与切目标之间改了选区"的载体),
 *  并记录监听器以便手动触发。 */
function makeEditor(model: ReturnType<typeof makeModel>) {
  let sel: Sel = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const selListeners: Array<() => void> = [];
  const blurListeners: Array<() => void> = [];
  const scrollListeners: Array<() => void> = [];
  let multiCursor = false;
  const domNode = {
    getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const editor = {
    getModel: () => model,
    getSelection: () => ({
      ...sel, isEmpty: () => EMPTY(sel),
      getStartPosition: () => ({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
      getEndPosition: () => ({ lineNumber: sel.endLineNumber, column: sel.endColumn }),
    }),
    getSelections: () => multiCursor ? [sel, sel] : [sel],
    __setMultiCursor: (v: boolean) => { multiCursor = v; },
    /** 测试用:把"当前选区"改成另一处(模拟用户在引用菜单开着时又选了一段)。 */
    __setSelection: (s: Sel) => {
      sel = s;
    },
    getDomNode: () => domNode,
    getScrolledVisiblePosition: (p: { lineNumber: number; column: number }) => ({
      left: (p.column - 1) * 8,
      top: (p.lineNumber - 1) * 18,
      height: 18,
    }),
    addCommand: () => {},
    getPosition: () => ({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
    saveViewState: () => ({}),
    restoreViewState: () => {},
    revealLineInCenter: () => {},
    setPosition: () => {},
    layout: () => {},
    focus: () => {},
    getValue: () => model.getValue(),
    onDidChangeCursorSelection: (cb: () => void) => {
      selListeners.push(cb);
      return { dispose: () => {} };
    },
    onDidBlurEditorWidget: (cb: () => void) => {
      blurListeners.push(cb);
      return { dispose: () => {} };
    },
    onDidScrollChange: (cb: () => void) => {
      scrollListeners.push(cb);
      return { dispose: () => {} };
    },
    onDidLayoutChange: () => ({ dispose: () => {} }),
    __emitSelectionChange: () => {
      for (const cb of selListeners) cb();
    },
    __emitScroll: () => { for (const cb of scrollListeners) cb(); },
    __emitBlur: () => { for (const cb of blurListeners) cb(); },
  };
  return editor;
}

const fakeMonaco = {
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  Uri: { parse: () => ({ toString: () => "inmemory://model/0" }) },
  editor: {},
  languages: { registerDefinitionProvider: () => ({ dispose: () => {} }) },
};

/** 选区 A 那一行(整行选):line 1 第 1 列 → 第 1 行行尾。 */
function lineSel(lineNumber: number, text: string): Sel {
  return { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: text.length + 1 };
}

function nodesOfType(t: unknown): El[] {
  return __nodes().filter((n) => n.type === t) as El[];
}

async function run() {
  // 清掉可能的上次状态,注册一个缓存 model(warm-start 需要 getModelEntry 非空)。
  const model = makeModel(CONTENT);
  registerModel(FILE, model as never, CONTENT);
  useSessionStore.setState({
    locale: "zh",
    activeProjectId: "proj-1",
    activeSessionId: "main-1",
    activeSideChatId: null,
    composerDraftBySession: {},
  });

  __mount(() => EditPane({ filePath: FILE, projectPath: "/workspace" }));
  await __flush();

  // 取出真 <Editor> 元素,跑**真** handleEditorMount(注入假 Monaco + 假编辑器)。
  const editorEl = nodesOfType(Editor)[0];
  check("EditPane 渲染出 <Editor> 且带 onMount", !!editorEl && typeof editorEl.props.onMount === "function");
  if (!editorEl) return;
  const editor = makeEditor(model);
  (editorEl.props.onMount as (e: unknown, m: unknown) => void)(editor, fakeMonaco);
  await __flush();

  const target = { id: "session-B", title: "Session B", kind: "chat" as const };

  /* ── 正控:什么都没变 —— 正文与行号都应是 A ── */
  {
    useSessionStore.getState().clearComposerDraft(target.id);
    editor.__setSelection(lineSel(1, "AAAA first line of selection"));
    editor.__emitSelectionChange(); // 真 onDidChangeCursorSelection → 真 readMonacoSelection
    await __flush();

    const toolbar = nodesOfType(SelectionToolbar)[0];
    check("选中后弹出引用工具条", !!toolbar);
    check("Monaco 用独立选区来源，DOM selectionchange 不得关掉引用条", toolbar?.props.selectionSource === "monaco");
    // 点「引用」→ setMdQuote(state):把这份快照交给目标选择浮层。
    (toolbar.props.onQuote as (s: unknown) => void)(toolbar.props.state);
    await __flush();

    const menu = nodesOfType(SelectionQuoteMenu)[0];
    check("打开引用目标浮层", !!menu);
    editor.__emitBlur(); // SelectionQuoteMenu autofocus 必须允许失焦而不关闭菜单
    await __flush();
    check("引用菜单输入框聚焦导致 Monaco 失焦时，目标菜单仍在", nodesOfType(SelectionQuoteMenu).length === 1);
    const menuState = menu.props.state as { text: string };
    check("冻结快照的正文 == A 那一行", menuState.text === "AAAA first line of selection", menuState.text);
    // 正控:不改选区,直接选定目标。
    (menu.props.onPick as (t: unknown, s: string) => void)(target, menuState.text);
    await __flush();

    const draft = useSessionStore.getState().composerDraftBySession[target.id];
    const tag = draft?.tags?.[0] as { content: string } | undefined;
    check("正控:引用落进目标草稿", !!tag);
    check(
      "正控:正文与行号都对 A(source 写 line 1,不含 line 3)",
      !!tag && tag.content.includes("AAAA first line of selection") &&
        tag.content.includes("(line 1)") && !tag.content.includes("(line 3)"),
      tag?.content,
    );
  }

  /* ── 承重:选中 A → 切目标前选区变 B → 落草稿必须仍是 A(正文与行号一致) ── */
  {
    useSessionStore.getState().clearComposerDraft(target.id);
    editor.__setSelection(lineSel(1, "AAAA first line of selection"));
    editor.__emitSelectionChange();
    await __flush();

    const toolbar = nodesOfType(SelectionToolbar)[0];
    (toolbar.props.onQuote as (s: unknown) => void)(toolbar.props.state);
    await __flush();

    const menu = nodesOfType(SelectionQuoteMenu)[0];
    const menuState = menu.props.state as { text: string };
    check("承重:冻结快照仍是 A 那一行(还没切目标)", menuState.text === "AAAA first line of selection", menuState.text);

    // ★ 用户在"打开引用菜单"之后、"选定目标"之前,把编辑器选区改成了 B(第 3 行)。
    //   真 `quoteFromEditor` 若现读 editorRef.getSelection() 取行号,就会取到这一处。
    editor.__setSelection(lineSel(3, "CCCC third line of selection"));

    (menu.props.onPick as (t: unknown, s: string) => void)(target, menuState.text);
    await __flush();

    const draft = useSessionStore.getState().composerDraftBySession[target.id];
    const tag = draft?.tags?.[0] as { content: string } | undefined;
    check("承重:引用仍落进目标草稿", !!tag);
    check(
      "★ 承重:正文与行号都对应 A(不是 A 正文 + B 行号的混装)",
      !!tag && tag.content.includes("AAAA first line of selection") && tag.content.includes("(line 1)"),
      tag?.content,
    );
    check(
      "★ 承重:引用的行号绝不取自漂移后的 B((line 3) 不得出现)",
      !!tag && !tag.content.includes("(line 3)") && !tag.content.includes("CCCC third line"),
      tag?.content,
    );
  }

  /* ── T65：Monaco viewport/scroll/multi-cursor/selection cap ── */
  {
    editor.__setSelection(lineSel(2, "BBBB second line of selection"));
    editor.__emitSelectionChange();
    await __flush();
    check("滚动之前工具栏存在", nodesOfType(SelectionToolbar).length === 1);
    editor.__emitScroll();
    await __flush();
    check("Monaco 内部滚动后工具栏隐藏，不停在旧屏幕位置", nodesOfType(SelectionToolbar).length === 0);

    editor.__setMultiCursor(true);
    editor.__emitSelectionChange();
    await __flush();
    check("多光标不生成含糊的引用工具栏", nodesOfType(SelectionToolbar).length === 0);
    editor.__setMultiCursor(false);

    editor.__setSelection(lineSel(2, "BBBB second line of selection"));
    const snap = captureMonacoCitationSelection(editor as never);
    check("编辑器相对位置换算为视口坐标", snap?.rect.left === 100 + 29 * 8 && snap?.rect.top === 50 + 18, snap?.rect);
    check("选段快照固定来源行号", snap?.lines?.start === 2 && snap.lines.end === 2, snap?.lines);
  }
  {
    const many = Array.from({ length: 250 }, (_, i) => `line-${i + 1}-value`).join("\n");
    const huge = makeModel(many);
    const longEd = makeEditor(huge);
    longEd.__setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 250, endColumn: 11 });
    const snap = captureMonacoCitationSelection(longEd as never);
    check("超长 250 行仅截前 200 行", snap?.lines?.end === MAX_MONACO_QUOTE_LINES && !snap.text.includes("line-201-value"), snap?.lines);
    check("超大选区携带可展示的截断提示", snap?.truncated?.maxLines === 200 && snap.truncated.maxChars === 12000, snap?.truncated);
    // Mount the REAL shared toolbar: Monaco bypasses DOM selectionchange while
    // chat/file preview continue to use that event for collapse dismissal.
    __resetDocumentListeners();
    let monacoClosed = 0;
    __mount(() => SelectionToolbar({
      state: snap!, selectionSource: "monaco",
      onQuote: () => {}, onClose: () => { monacoClosed++; },
    }));
    await __flush();
    check("超大选区工具栏实际显示截断提示", __text().includes("选区过长") && __text().includes("200"), __text());
    (window as unknown as { getSelection: () => unknown }).getSelection = () => ({
      isCollapsed: true, toString: () => "",
    });
    __fireDocumentEvent("selectionchange");
    check("Monaco 非 DOM 选区不因 document.selectionchange 误关闭", monacoClosed === 0, monacoClosed);
    __fireDocumentEvent("scroll");
    check("Monaco 工具栏滚动仍会关闭", monacoClosed === 1, monacoClosed);

    __resetDocumentListeners();
    let domClosed = 0;
    __mount(() => SelectionToolbar({
      state: { ...snap!, truncated: undefined },
      onQuote: () => {}, onClose: () => { domClosed++; },
    }));
    await __flush();
    __fireDocumentEvent("selectionchange");
    check("消息/文献预览复用的 DOM 工具栏仍在选区折叠时关闭", domClosed === 1, domClosed);
    check("普通消息/预览工具栏没有 Monaco 截断提示", !__text().includes("选区过长"), __text());
    const chat = readFileSync("src/renderer/components/chat/ChatPane.tsx", "utf8");
    const viewer = readFileSync("src/renderer/components/library/FileViewer.tsx", "utf8");
    check("消息与文献预览仍调用同一个 SelectionToolbar", chat.includes("<SelectionToolbar") && viewer.includes("<SelectionToolbar"));
    const single = makeModel("X".repeat(MAX_MONACO_QUOTE_CHARS + 400));
    const charsEd = makeEditor(single);
    charsEd.__setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: MAX_MONACO_QUOTE_CHARS + 401 });
    const clipped = captureMonacoCitationSelection(charsEd as never);
    check("单行巨量文字也被硬字符上限截断", clipped?.text.length === MAX_MONACO_QUOTE_CHARS && !!clipped.truncated, clipped?.text.length);
  }

  console.log(`\nide-quote-snapshot-smoke:${checks - failures}/${checks} 通过`);
  if (failures > 0) process.exitCode = 1;
  // ⚠️ **必须显式退出。** 真 `EditPane` 的挂载会留下假 DOM 的定时器句柄(夹具把
  // `requestAnimationFrame` / `window.setTimeout` 映到真 `setTimeout`),事件循环因此不空。
  // 只设 `process.exitCode` 的话,进程会一直活着到 `build.mjs` 的 60s `spawnSync` 超时 ——
  // 那时 `status` 是 `null`,`if (unit.status !== 0)` 把**成功当失败**,而且日志里明明印着
  // 「10/10 通过」。这正是本仓点名过的「看着绿、其实坏」,所以这里显式 `process.exit`。
  process.exit(failures > 0 ? 1 : 0);
}

await run();
