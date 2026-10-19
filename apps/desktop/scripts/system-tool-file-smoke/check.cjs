"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ts = require("typescript");
const p = path.join(__dirname, "../../src/main/env/systemToolPaths.ts");
const code = fs.readFileSync(p, "utf8");
const ast = ts.createSourceFile("systemToolPaths.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "systemToolBinDirs");
assert.ok(fn);
const compiled = ts.transpileModule(fn.getText(ast), {compilerOptions:{
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
}}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-system-tool-files-"));
try {
  const fake = path.join(temp, "first", "soffice.exe");
  const valid = path.join(temp, "second", "soffice.exe");
  fs.mkdirSync(fake, {recursive: true});
  fs.mkdirSync(path.dirname(valid), {recursive: true});
  fs.writeFileSync(valid, "not executed");
  if (process.platform !== "win32") fs.chmodSync(valid, 0o755);
  const exports = {};
  new Function("exports", "TOOLCHAIN_TOOL_IDS", "knownInstallPaths",
    "existsSync", "dirname", "statSync", "accessSync", "constants", compiled)(
    exports, ["soffice"], () => [fake, valid], fs.existsSync,
    path.dirname, fs.statSync, fs.accessSync, fs.constants);
  assert.deepEqual(exports.systemToolBinDirs(), [path.dirname(valid)],
    "a folder named soffice.exe must not be injected into the agent PATH");
  console.log("system-tool-file-smoke: 1/1 PASS");
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
