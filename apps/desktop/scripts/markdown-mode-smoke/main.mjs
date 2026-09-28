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
const functions = ["FileEditor", "EditorToolbar", "isMarkdown", "isPdfFile", "isImage", "isUnsupported"];
const selected = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && functions.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && /TOGGLE_(LABEL|TITLE)_KEY$/.test(d.name.text)));
for (const name of functions) assert.ok(selected.some(n => n.name?.text === name), `Missing production AST boundary: ${name}`);
// Import the production contract classifiers at AST boundaries too. A copied
// extension regex goes stale when Office support changes independently.
const officePath = join(desktop, "../../packages/contracts/src/ipc/onlyoffice.ts");
const officeSource = readFileSync(officePath, "utf8");
const officeAst = ts.createSourceFile(officePath, officeSource, ts.ScriptTarget.Latest, true);
const officeNames = ["ONLYOFFICE_EDITABLE", "ONLYOFFICE_VIEW_ONLY",
  "isOnlyOfficeSupportedPath", "isOnlyOfficeViewOnlyPath"];
const officeNodes = officeAst.statements.filter(node =>
  ts.isFunctionDeclaration(node) && officeNames.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && officeNames.includes(d.name.text)));
assert.equal(officeNodes.length, officeNames.length, "Production Office classifier boundaries");
const code = ts.transpileModule([
  ...officeNodes.map(n => n.getText(officeAst)), ...selected.map(n => n.getText(ast)),
].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, jsxFactory: "h" },
}).outputText;

let state;
let before;
let gitPair;
let changes;
const noOp = () => {};
const env = {
  exports: {},
  h: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useSessionStore: (select) => select(state),
  useTurnFileFor: () => before === undefined ? undefined : { before },
  useGitDiffPair: () => gitPair,
  useState: (value) => [value, noOp],
  useCallback: fn => fn,
  useI18n: () => ({ t: key => key }),
  extname: file => /\.[^./\\]+$/.exec(file)?.[0].toLowerCase() ?? "",
  monacoLanguageToLsp: () => null,
  languageForExt: () => "plaintext",
  LSP_LANGUAGE_DISPLAY: {},
  resolveShortcut: () => null,
  acceleratorToDisplayString: value => value,
  cn: (...args) => args.filter(x => typeof x === "string").join(" "),
  EMPTY_NAV: [],
};
env.useSessionStore.getState = () => state;
for (const name of ["DiffPane", "OnlyOfficeEditorPane", "MarkdownEditorPane", "PdfPreviewPane",
  "OfficePreviewPane", "ImagePreviewPane", "UnsupportedPane", "MarkdownPreviewPane", "EditPane", "FileTypeIcon",
  ...new Set(source.match(/\bIcon\w+/g))]) env[name] = name;
const context = vm.createContext(env);
vm.runInContext(code + "\nglobalThis.component = FileEditor; globalThis.toolbar = EditorToolbar;", context);
function all(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...(node.props?.children ?? []).flatMap(all)];
}
function reset(file, mode, project = "project-a") {
  before = undefined; gitPair = undefined; changes = [];
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
// Office now has one OnlyOffice surface; old preferences cannot reopen the
// removed local preview/source route. This follows production, not a new UI change.
for (const extension of ["docx", "xlsx", "pptx", "odt", "doc", "xls", "ppt", "rtf"]) {
  test(`${extension}: Office remains on its supported surface`, () => {
    const file = "/workspace/doc." + extension;
    for (const mode of [undefined, "edit", "preview", "wysiwyg"]) {
      reset(file, mode); const r = render(file);
      assert.equal(r.pane.type, "OnlyOfficeEditorPane");
      assert.equal(r.toggle, undefined, "No obsolete Office preview/source toggle");
      assert.equal(r.pane.props.readOnly, ["doc", "xls", "ppt", "rtf"].includes(extension));
      assert.equal(changes.length, 0, "Opening must not rewrite stored preferences");
    }
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
