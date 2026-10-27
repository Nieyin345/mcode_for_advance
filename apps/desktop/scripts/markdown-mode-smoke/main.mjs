/**
 * Execute the production FileEditor and EditorToolbar at TypeScript AST boundaries.
 * Only hooks, child panes and unrelated services are stubbed. Mode decisions,
 * callbacks, labels and file classifiers come from the real source, NOT copies.
 * This is a headless component-routing test, not a browser/Milkdown typing test.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(desktop, "package.json"));
const ts = require("typescript");
const path = join(desktop, "src/renderer/components/ide/FileEditor.tsx");
const source = readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// ⚠️ 文件类型分类器已拆到 `fileEditorKinds.ts`（`FileEditor.tsx` 尾部那一组纯判定）。
// 这一套**要执行真的分类器**（不是抄一份正则），所以两个文件都要读进来再挑 ——
// 只读主文件会报 `Missing production AST boundary: isMarkdown`（真发生过）。
const kindsPath = join(desktop, "src/renderer/components/ide/fileEditorKinds.ts");
const kindsSource = readFileSync(kindsPath, "utf8");
const kindsAst = ts.createSourceFile(kindsPath, kindsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
// 【ARC-005】`FileEditor` 调用的分类器也要按 AST 边界执行 —— 漏一个就是
// `canPreviewHtml is not defined` 整片红（HTML 预览入口片引入后真发生过）。
// 【T101】`isGenofficeViewAvailableFor` 同理：`FileEditor` 现在调它来判断
// 「OnlyOffice 未配置时那个出口按钮该不该出现」。**漏在这里就是 6 条红**
// （2026-10-24 实测：MD 的 6 条 default/opens/toggle 断言全部 `is not defined`）。
// ⚠️ 加一个被 `FileEditor` 调用的新函数，**必须同步加到这个列表** ——
// 下面的 `Missing production AST boundary` 断言只保证「列了的名字在源码里」，
// 保证不了「源码里被调用的都在列表里」。
/* 【2026-10-28】`TheiaCustomEditorButton` 是 `FileEditor` **同文件里的局部组件**
 *（工具栏第 762 行渲染它）。它必须进抽取名单 —— 否则被抽取的 `EditorToolbar`
 * 调用它时 vm 里没有这个名字，整套 35 条一起抛 `is not defined`。 */
const functions = ["FileEditor", "EditorToolbar", "isMarkdown", "isPdfFile", "isImage", "isUnsupported", "canPreviewHtml", "htmlPreviewDecision", "isGenofficeViewAvailableFor", "TheiaCustomEditorButton"];
const selected = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && functions.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && /TOGGLE_(LABEL|TITLE)_KEY$/.test(d.name.text)));
const selectedKinds = kindsAst.statements.filter(node =>
  ts.isFunctionDeclaration(node) && functions.includes(node.name?.text));
for (const name of functions) {
  assert.ok(
    selected.some(n => n.name?.text === name) || selectedKinds.some(n => n.name?.text === name),
    `Missing production AST boundary: ${name}`,
  );
}
// 【ARC-007】文档种类判据已收口到 `@contracts/documentKind`（`fileEditorKinds.ts`
// 现在只调 `documentKindOf`）。这一套要执行**真分类器**，所以把那两个纯函数也按
// AST 边界读进来一起转译 —— 不读就会在沙箱里报 `documentKindOf is not defined`
// （2026-10-18 实测：32 条断言里 31 条红，全栽在这一句）。
const kindPath = join(desktop, "../../packages/contracts/src/documentKind.ts");
const kindSource = readFileSync(kindPath, "utf8");
const kindAst = ts.createSourceFile(kindPath, kindSource, ts.ScriptTarget.Latest, true);
const kindFnNames = ["documentExtension", "documentKindOf", "isOfficeDocumentKind"];
const kindSetNames = ["OFFICE_EDITABLE", "OFFICE_VIEW_ONLY", "IMAGE", "UNSUPPORTED", "HTML", "MARKDOWN"];
const kindNodes = kindAst.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && kindFnNames.includes(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && kindSetNames.includes(d.name.text))));
assert.equal(kindNodes.length, kindFnNames.length + kindSetNames.length,
  "Production documentKind boundaries (3 functions + 6 sets)");

// 【T57】`fileEditorKinds.ts` 现在也调 `@contracts/genofficeFileRoute` 的
// `genofficeAppForPath`。同样按 AST 边界读进来 —— 漏了就在沙箱里报
// `genofficeAppForPath is not defined`（2026-10-23 实测：32 条断言里 31 条红）。
const routePath = join(desktop, "../../packages/contracts/src/genofficeFileRoute.ts");
const routeAst = ts.createSourceFile(routePath, readFileSync(routePath, "utf8"), ts.ScriptTarget.Latest, true);
// `genofficeAppForPath` 依赖同文件的模块级正则常量（`DOCX_RE` 等），
// 只取函数会在沙箱里报 `DOCX_RE is not defined`。
const routeNodes = routeAst.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text === "genofficeAppForPath") ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && /^(DOCX|[A-Z]+)_RE$/.test(d.name.text))));
assert.ok(routeNodes.length >= 2, "Production genofficeFileRoute boundaries (function + regex constants)");

const code = ts.transpileModule([
  ...kindNodes.map(n => n.getText(kindAst)),
  ...routeNodes.map(n => n.getText(routeAst)),
  ...selected.map(n => n.getText(ast)),
  ...selectedKinds.map(n => n.getText(kindsAst)),
].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, jsxFactory: "h" },
}).outputText;

let state;
let before;
let gitPair;
let changes;
/** `document.capabilities()` 的返回值 —— 默认 null（CLI 未就绪，与真实首帧一致）。
 *  O5 批三起 office 的默认档要读它，所以夹具必须能摆出「能力就绪」的现场。 */
let capabilities = null;
const noOp = () => {};
const env = {
  exports: {},
  h: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useSessionStore: (select) => select(state),
  useTurnFileFor: () => before === undefined ? undefined : { before },
  useGitDiffPair: () => gitPair,
  useState: (value) => [value, noOp],
  /* 【EDIT-09】`FileEditor` 新增 `useEffect(() => setHistoryOpen(false), [filePath])`
   *（切文件收起历史抽屉）。沙箱只提供被提取那段真正用到的 hook，重构加了新的就得跟上，
   * 否则整段函数在 vm 里抛 `useEffect is not defined` —— 红的是套件不是被测代码。
   * 桩是空执行：这里没有 React，effect 本就不跑。 */
  useEffect: () => {},
  useCallback: fn => fn,
  useI18n: () => ({ t: key => key }),
  /* 【EDIT-06 修订左栏】`EditorWithRevisions` 是**外部导入**的组件（它自带修订栏逻辑，
   * 不在本套的可测面里 —— 本套验的是「FileEditor 把 office 文件路由到哪一档」，
   * 修订栏是包在外面的壳）。桩成全等渲染：`<X>{children}</X>` 直接透传子节点。 */
  EditorWithRevisions: ({ children }) => children,
  RevisionModeButton: () => null,
  /* 扩展贡献的工具栏按钮（`modules/TheiaActionToolbar.tsx`）。它读 `api.modules`
   * 拉已运行的扩展会话 —— 本套验的是**文件路由**，不验扩展工具栏，桩成不渲染。 */
  TheiaActionToolbar: () => null,
  extname: file => /\.[^./\\]+$/.exec(file)?.[0].toLowerCase() ?? "",
  monacoLanguageToLsp: () => null,
  languageForExt: () => "plaintext",
  LSP_LANGUAGE_DISPLAY: {},
  resolveShortcut: () => null,
  acceleratorToDisplayString: value => value,
  cn: (...args) => args.filter(x => typeof x === "string").join(" "),
  // 【ARC-007 → O5 批三】FileEditor 用 `useRpc` 读 document.capabilities 决定 office
  // 落哪一档。夹具经 `capabilities` 变量摆现场（默认 null = CLI 未就绪）。
  useRpc: () => ({ data: capabilities ?? undefined, loading: false, error: null, refetch: async () => {} }),
  api: new Proxy({}, { get: () => () => Promise.resolve(undefined) }),
  EMPTY_NAV: [],
};
env.useSessionStore.getState = () => state;
for (const name of ["DiffPane", "GenofficeDocumentPane", "GenofficeViewHostPane", "MarkdownEditorPane", "PdfPreviewPane",
  "OfficePreviewPane", "ImagePreviewPane", "UnsupportedPane", "MarkdownPreviewPane", "EditPane", "FileTypeIcon",
  ...new Set(source.match(/\bIcon\w+/g))]) env[name] = name;
const context = vm.createContext(env);
vm.runInContext(code + "\nglobalThis.component = FileEditor; globalThis.toolbar = EditorToolbar;", context);
function all(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...(node.props?.children ?? []).flatMap(all)];
}
function reset(file, mode, project = "project-a") {
  before = undefined; gitPair = undefined; changes = []; capabilities = null;
  state = {
    activeProjectId: project, ideFileViewModeByProject: { "project-a": {}, "project-b": {} },
    ideDiffBeforeByProject: {}, ideEditorMode: "tabs", projects: [], shortcutOverrides: {},
    navBackByProject: {}, navForwardByProject: {}, lspPhasesByWorkspace: {},
    setIdeFileViewMode(path, value) { changes.push([path, value]); state.ideFileViewModeByProject[state.activeProjectId][path] = value; },
    setIdeEditorMode: noOp, navigateBack: noOp, navigateForward: noOp,
  };
  if (project && mode !== undefined) state.ideFileViewModeByProject[project][file] = mode;
}
function render(file) {
  const tree = context.component({ filePath: file, projectPath: "/workspace" });
  const toolbarElement = all(tree).find(e => e.type === context.toolbar);
  assert.ok(toolbarElement, "Real toolbar must remain mounted");
  const toolbarTree = context.toolbar(toolbarElement.props);
  const toggle = all(toolbarTree).find(e => e.type === "button" && e.props.onClick === toolbarElement.props.onTogglePreview);
  const panes = all(tree).filter(e => typeof e.type === "string" && e.type.endsWith("Pane"));
  assert.equal(panes.length, 1, "Exactly one file pane");
  return { toolbar: toolbarElement.props, toggle, pane: panes[0] };
}
const checks = [];
function test(name, fn) {
  try { fn(); checks.push({ name, pass: true }); console.log("PASS " + name); }
  catch (e) { checks.push({ name, pass: false, error: e.message }); console.error("FAIL " + name + ": " + e.message); }
}
for (const extension of ["md", "markdown", "MD"]) {
  const file = "/workspace/readme." + extension;
  for (const mode of [undefined, "wysiwyg", "preview"]) {
    test(`${extension}: ${mode ?? "default"} opens Milkdown`, () => {
      reset(file, mode); const r = render(file);
      assert.equal(r.pane.type, "MarkdownEditorPane");
      assert.equal(r.toolbar.mode, "wysiwyg");
      assert.equal(r.toggle.props.title, "ide.editor.switchToSourceView");
      assert.ok(r.toggle.props.children.includes("ide.editor.toggleSource"));
      assert.equal(changes.length, 0, "Opening must not mutate the store or file");
    });
  }
  test(`${extension}: Milkdown/source toggle never enters preview`, () => {
    reset(file); const modes = [];
    for (let i = 0; i < 6; i++) {
      render(file).toggle.props.onClick();
      modes.push(state.ideFileViewModeByProject["project-a"][file]);
    }
    assert.deepEqual(modes, ["edit", "wysiwyg", "edit", "wysiwyg", "edit", "wysiwyg"]);
  });
  test(`${extension}: source stays source with editing label`, () => {
    reset(file, "edit"); const r = render(file);
    assert.equal(r.pane.type, "EditPane");
    assert.equal(r.toggle.props.title, "ide.editor.switchToMarkdownEdit");
    assert.ok(r.toggle.props.children.includes("ide.editor.toggleEdit"));
    assert.ok(!all(r.toggle).some(e => e.type === "IconEye"), "Not a preview button");
    r.toggle.props.onClick(); assert.equal(render(file).pane.type, "MarkdownEditorPane");
  });
}
test("legacy preview preference is adapted separately in each project", () => {
  const file = "/workspace/readme.md"; reset(file, "edit");
  state.ideFileViewModeByProject["project-b"][file] = "preview";
  assert.equal(render(file).pane.type, "EditPane");
  state.activeProjectId = "project-b";
  assert.equal(render(file).pane.type, "MarkdownEditorPane");
  render(file).toggle.props.onClick();
  assert.equal(state.ideFileViewModeByProject["project-a"][file], "edit");
  assert.equal(state.ideFileViewModeByProject["project-b"][file], "edit");
});
test("no active project still defaults to Milkdown", () => {
  const file = "/workspace/readme.md"; reset(file, undefined, null);
  assert.equal(render(file).pane.type, "MarkdownEditorPane");
});
test("explicit Markdown diff with snapshot remains available", () => {
  const file = "/workspace/readme.md"; reset(file, "diff"); before = "old";
  assert.equal(render(file).pane.type, "DiffPane");
  assert.equal(render(file).pane.props.before, "old");
});
test("history diff cannot be replaced by the live editor", () => {
  const file = "/workspace/readme.md"; reset(file, "preview"); gitPair = { before: "old", after: "historic" };
  assert.equal(render(file).pane.type, "DiffPane");
  assert.equal(render(file).pane.props.after, "historic");
  render(file).toggle.props.onClick();
  assert.equal(render(file).pane.type, "DiffPane");
});
/* ══════════════════════════════════════════════════════════════════════════
 * 【O5 批三】**office 的默认档**（用户原话：「默认啊」）
 *
 * 判据：打开一个 office 文件，**第一次就落在 GenOffice**，不需要用户切模式。
 * 三档按能力退化 —— 不能无条件写死（卡 §五之二：能力不齐时写死会开出一个降级面板）。
 *
 * ⚠️ **这一节是整张卡最关键的一条判据**。它验的是 `FileEditor.tsx` 的 `defaultMode`；
 * 变异：把那里改回恒 `"wysiwyg"` 或把 `office` 判定改成恒 false → 这里的断言必须红。
 * ══════════════════════════════════════════════════════════════════════════ */
const ALL_HOSTS = { pdf: true, markdown: true, html: true, sheets: true, slides: true, slidesNative: true };
function capsReady() {
  return { cli: { available: true, path: "/genoffice/cli.js" }, hosts: { ...ALL_HOSTS } };
}
const OFFICE_EXTS = ["docx", "xlsx", "pptx"];
for (const extension of OFFICE_EXTS) {
  test(`${extension}: ★ default (no stored preference) opens the GenOffice NATIVE view`, () => {
    const file = "/workspace/doc." + extension;
    reset(file, undefined); capabilities = capsReady();
    const r = render(file);
    assert.equal(r.pane.type, "GenofficeViewHostPane",
      `office 默认档必须直接落 GenOffice 原生视图（实际 ${r.pane.type}）；用户不该需要手动切模式`);
    assert.equal(r.toolbar.mode, "genoffice-view", "toolbar must report the native-view mode");
    assert.equal(changes.length, 0, "Opening must not write a preference — the default is a default, not a mutation");
  });
}
test("★ docx: stored legacy wysiwyg preference no longer traps the file outside GenOffice", () => {
  const file = "/workspace/doc.docx";
  reset(file, "wysiwyg"); capabilities = capsReady();
  assert.equal(render(file).pane.type, "GenofficeViewHostPane",
    "an old OnlyOffice-era preference must not keep office on a view that no longer exists");
});
// ⚠️ 挑 **xlsx** 而不是 docx：docs 家族按契约**恒可用**（hosts.docs 恒 true，
// 见 ipc/document.ts:453 与 isGenofficeViewAvailableFor 的 docs 分支），所以 docx
// 不会因能力位退化。sheets / slides 才查 hosts 位。
test("xlsx: GenOffice host capability missing falls back to the structured view", () => {
  const file = "/workspace/doc.xlsx";
  reset(file, undefined);
  capabilities = { cli: { available: true, path: "/genoffice/cli.js" }, hosts: { docs: true, pdf: true, markdown: true, html: true, sheets: false, slides: false, slidesNative: false } };
  assert.equal(render(file).pane.type, "GenofficeDocumentPane");
});
test("★ pptx: slides capability missing (both bits) also falls back, not a dead native pane", () => {
  const file = "/workspace/doc.pptx";
  reset(file, undefined);
  capabilities = { cli: { available: true, path: "/genoffice/cli.js" }, hosts: { docs: true, pdf: true, markdown: true, html: true, sheets: true, slides: false, slidesNative: false } };
  assert.equal(render(file).pane.type, "GenofficeDocumentPane");
});
test("docx: CLI missing still lands in GenOffice, which reports the reason", () => {
  const file = "/workspace/doc.docx";
  reset(file, undefined); capabilities = null;
  assert.equal(render(file).pane.type, "GenofficeDocumentPane",
    "no local Office renderer and no OnlyOffice to fall back to — the pane must say why");
});
test("office: a real user preference still wins over the default", () => {
  const file = "/workspace/doc.docx";
  reset(file, "edit"); capabilities = capsReady();
  assert.equal(render(file).pane.type, "EditPane", "explicit preferences are not overridden by the default");
});
// 只读老格式：**按 GenOffice 自己的路由表**决定落哪一档 —— 不按我们「觉得它该
// 不该支持」猜。`xls` 在 `XLSX_RE` 里（vendor 自己声称能开），所以走原生视图，
// 开不了时由 `unsupportedHost` 分支**显式报原因**；`doc` / `ppt` / `rtf` 不在任何
// 路由里 → 结构化视图。两者都**不是**死编辑器。
for (const [extension, expected] of [["xls", "GenofficeViewHostPane"], ["doc", "GenofficeDocumentPane"],
  ["ppt", "GenofficeDocumentPane"], ["rtf", "GenofficeDocumentPane"]]) {
  test(`${extension}: Office read-only format lands on ${expected} — never a dead editor`, () => {
    const file = "/workspace/doc." + extension;
    reset(file, undefined); capabilities = capsReady();
    assert.equal(render(file).pane.type, expected);
  });
}
test("PDF remains preview-only", () => {
  const file = "/workspace/doc.pdf"; reset(file);
  const r = render(file); assert.equal(r.pane.type, "PdfPreviewPane"); assert.equal(r.toggle, undefined);
});
for (const [extension, pane] of [["png", "ImagePreviewPane"], ["zip", "UnsupportedPane"]]) test(`${extension}: preview escape hatch unchanged`, () => {
  const file = "/workspace/file." + extension; reset(file, "preview");
  assert.equal(render(file).pane.type, pane);
  render(file).toggle.props.onClick(); assert.equal(render(file).pane.type, "EditPane");
  render(file).toggle.props.onClick(); assert.equal(render(file).pane.type, pane);
});
test("code defaults to source without a Markdown toggle", () => {
  const file = "/workspace/code.ts"; reset(file);
  assert.equal(render(file).pane.type, "EditPane"); assert.equal(render(file).toggle, undefined);
});
test("Markdown editor still imports and instantiates third-party Crepe", () => {
  const text = readFileSync(join(desktop, "src/renderer/components/ide/MarkdownEditorPane.tsx"), "utf8");
  const ast = ts.createSourceFile("editor.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.ok(ast.statements.some(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === "@milkdown/crepe"));
  let found = false;
  function visit(n) { if (ts.isNewExpression(n) && n.expression.getText(ast) === "Crepe") found = true; ts.forEachChild(n, visit); }
  visit(ast); assert.ok(found);
});
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const output = mkdtempSync(join(desktop, ".tmp/markdown-mode-"));
writeFileSync(join(output, "result.json"), JSON.stringify(checks, null, 2));
const passed = checks.filter(c => c.pass).length;
console.log(`Markdown mode smoke: ${passed}/${checks.length}; artifacts: ${output}`);
if (passed !== checks.length) process.exitCode = 1;
