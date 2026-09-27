// Test the actual WorkflowLibraryView list-refresh callback without mounting the app.
// AST extraction keeps the assertion bound to production code, not a rewritten copy.
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).filter((name) => name.startsWith("typescript@")).sort().at(-1);
if (!pkg) throw new Error("Already installed TypeScript is required; no network fallback");
const mod = await import(pathToFileURL(join(pnpm, pkg, "node_modules/typescript/lib/typescript.js")).href);
const ts = mod.default ?? mod;
const src = readFileSync(join(desktop, "src/renderer/components/settings/workflows/WorkflowLibraryView.tsx"), "utf8");
const ast = ts.createSourceFile("WorkflowLibraryView.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
if (ast.parseDiagnostics.length) throw new Error("WorkflowLibraryView parse failed");
const matches = [];
function walk(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "loadList") matches.push(node);
  ts.forEachChild(node, walk);
}
walk(ast);
if (matches.length !== 1 || !matches[0].initializer || !ts.isCallExpression(matches[0].initializer)) {
  throw new Error("Expected one real loadList useCallback in WorkflowLibraryView");
}
const source = matches[0].initializer.getText(ast);
const compiled = ts.transpileModule(`const test = ${source};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const makeCallback = new Function("useCallback", "api", "setEntries", "setListError", "listReadVersion", "mounted", `${compiled} return test;`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function fixture() {
  const pending = [];
  let entries = null;
  let error = null;
  const api = { workflow: { list: () => {
    const task = deferred();
    pending.push(task);
    return task.promise;
  } } };
  const mounted = { current: true };
  const listReadVersion = { current: 0 };
  const load = makeCallback((fn) => fn, api, (value) => { entries = value; }, (value) => { error = value; }, listReadVersion, mounted);
  return { load, pending, mounted, get entries() { return entries; }, get error() { return error; } };
}
let total = 0, failed = 0;
function check(name, actual, expected) {
  total += 1;
  const ok = Object.is(actual, expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failed += 1;
}
{
  const s = fixture();
  const older = s.load();
  const latest = s.load();
  s.pending[1].resolve({ workflows: [{ id: "new", name: "New" }] });
  await latest;
  s.pending[0].resolve({ workflows: [{ id: "old", name: "Old" }] });
  await older;
  check("late old response must not replace newer workflow list", s.entries?.[0]?.id, "new");
  check("late old response leaves newest successful read error-free", s.error, null);
}
{
  const s = fixture();
  const older = s.load();
  const latest = s.load();
  s.pending[1].resolve({ workflows: [{ id: "new" }] });
  await latest;
  s.pending[0].reject(new Error("obsolete offline error"));
  await older;
  check("late obsolete error must not hide latest list", s.entries?.[0]?.id, "new");
  check("late obsolete error must not replace latest clean status", s.error, null);
}
{
  const s = fixture();
  const task = s.load();
  s.pending[0].reject(new Error("current offline error"));
  await task;
  check("latest list failure is still shown", s.error, "current offline error");
}
{
  const s = fixture();
  const task = s.load();
  s.mounted.current = false;
  s.pending[0].resolve({ workflows: [{ id: "after-unmount" }] });
  await task;
  check("unmounted editor ignores late list response", s.entries, null);
}
{
  const s = fixture();
  const task = s.load();
  s.mounted.current = false;
  s.pending[0].reject(new Error("after-unmount error"));
  await task;
  check("unmounted editor ignores late list error", s.error, null);
}
console.log(`M30: ${total - failed}/${total} checks pass`);
if (failed) process.exitCode = 1;
