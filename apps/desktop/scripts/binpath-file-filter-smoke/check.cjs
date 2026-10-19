"use strict";
/** Exact production findExecutables function, with only process lookup faked.
 * All filesystem objects are disposable and never touch a real PATH. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ts = require("typescript");
const production = fs.readFileSync(path.join(__dirname, "../../src/main/lib/binPath.ts"), "utf8");
const program = ts.createSourceFile("binPath.ts", production, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = program.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "findExecutables");
assert.ok(fn, "source must contain shared findExecutables");
const code = ts.transpileModule(fn.getText(program), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-which-filter-"));
let checks = 0;
async function main() {
try {
  const folder = path.join(root, "python-folder");
  const executable = path.join(root, "python-file");
  fs.mkdirSync(folder);
  fs.writeFileSync(executable, "disposable test executable");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const nonExec = path.join(root, "python-not-executable");
  fs.writeFileSync(nonExec, "disposable fixture");
  if (process.platform !== "win32") fs.chmodSync(nonExec, 0o644);
  const stdout = [folder, nonExec, executable].join("\r\n") + "\r\n";
  const fakeRunProbe = async () => ({ ok: true, stdout });
  const fakeLookupSpec = () => ({ command: "where.exe", args: ["python"] });
  const exp = {};
  new Function("exports", "process", "lookupSpec", "runProbe", "existsSync", "lstatSync", "statSync", "accessSync", "constants", code)(
    exp, process, fakeLookupSpec, fakeRunProbe, fs.existsSync, fs.lstatSync, fs.statSync, fs.accessSync, fs.constants,
  );
  const found = await exp.findExecutables("python");
  assert.deepEqual(found, process.platform === "win32" ? [nonExec, executable] : [executable],
    "catalog must reject directories and non-executable POSIX files, retaining order");
  checks++;
  console.log("ok findExecutables rejects executable-named folders");
  const again = await exp.findExecutables("python");
  assert.deepEqual(found, again);
  checks++;
  console.log("ok results are stable and deterministic");
  console.log("binpath-file-filter-smoke: " + checks + "/" + checks + " PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
