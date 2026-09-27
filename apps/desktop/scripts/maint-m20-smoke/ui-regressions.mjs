/** Execute the real MicButton closures via the installed TypeScript AST.
 * No Electron/browser/mic: only a fake editor and repeated permission error.
 * AST extraction keeps test and production function bodies identical. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../../../node_modules/typescript/lib/typescript.js";
const file = "src/renderer/components/chat/MicButton.tsx";
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function walk(node) {
    if (!found && predicate(node)) found = node;
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.ok(found, "the actual MicButton closure was located in TypeScript AST");
  return found;
}
function realClosure(name, arrow, bindings) {
  const src = `const ${name} = ${arrow.getText(ast)};`;
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}\nreturn ${name};`)(...Object.values(bindings));
}
let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.error(`FAIL ${name}:`, e); }
}
const live = find((node) => ts.isVariableDeclaration(node)
  && ts.isIdentifier(node.name) && node.name.text === "applyLiveText"
  && ts.isArrowFunction(node.initializer));
function editorFixture() {
  let draft = "prefix hello";
  const lastWrittenRef = { current: "hello" };
  const editorRef = { current: {
    getTextWithSkills: () => draft,
    replaceTextRange: (from, to, text) => {
      draft = draft.slice(0, from) + text + draft.slice(to);
    },
  } };
  return {
    apply: realClosure("applyLiveText", live.initializer, { editorRef, lastWrittenRef }),
    draft: () => draft,
    setDraft: (text) => { draft = text; },
    lastWrittenRef,
  };
}
test("unmodified dictation tail accepts cumulative partial delta", () => {
  const f = editorFixture();
  f.apply("hello world");
  assert.equal(f.draft(), "prefix hello world");
});
test("user-edited dictation tail is not overwritten by later partials", () => {
  const f = editorFixture();
  f.setDraft("prefix "); // user removed the ASR tail while capture continues
  f.apply("hello world");
  assert.equal(f.draft(), "prefix ", "must not append a delta to unrelated user text");
  assert.equal(f.lastWrittenRef.current, "hello world");
});

const errorEffect = find((node) => ts.isCallExpression(node)
  && node.expression.getText(ast) === "useEffect"
  && node.arguments[0] && ts.isArrowFunction(node.arguments[0])
  && node.arguments[0].getText(ast).includes("lastToastRef.current"));
test("a second identical mic permission denial clears armed capture state", () => {
  let armed = true;
  let cleared = 0;
  let toasts = 0;
  const lastToastRef = { current: "" };
  const micError = "NotAllowedError: permission denied";
  const effect = realClosure("handleMicError", errorEffect.arguments[0], {
    micError, lastToastRef, armedRef: { get current() { return armed; } },
    arm: (on) => { armed = on; },
    clearMicError: () => { cleared++; },
    NO_MODEL_ERROR_RE: /no model selected/,
    useToastStore: { getState: () => ({ push: () => { toasts++; } }) },
    setVoiceMicPermission: () => Promise.resolve(),
    setSettingsOpen: () => {}, t: (key) => key,
  });
  effect();
  assert.equal(armed, false, "first denial disarms");
  assert.equal(cleared, 1);
  assert.equal(toasts, 1);
  armed = true; // user retries, OS returns the exact same denial
  effect();
  assert.equal(armed, false, "retry denial must not leave a false listening indicator");
  assert.equal(cleared, 2, "retry denial should be cleared so another retry works");
  assert.equal(toasts, 1, "identical warning still de-duplicates");
});
console.log(`M20 UI closures: ${3 - failures}/3 pass`);
if (failures) process.exitCode = 1;
