"use strict";
/** Isolated AST test of the exact production writeJson function (NO real home IO). */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../../src/main/lib/mcpConfig.ts"), "utf8");
const file = ts.createSourceFile("mcpConfig.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "writeJson");
assert.ok(fn, "production writeJson must exist");
const code = ts.transpileModule(fn.getText(file) + "\nexports.handler = writeJson;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const target = path.join("fixture", "claude-config.json");
let checks = 0;
function setup({ blockRename = false } = {}) {
  const state = new Map([[target, "ORIGINAL_USER_CONFIG"]]);
  const temps = [];
  let direct = 0;
  const fake = {
    mkdir: async () => {},
    writeFile: async (file, data) => {
      if (file === target) direct++;
      else temps.push(file);
      state.set(file, data);
    },
    rename: async (from, to) => {
      if (blockRename) throw Object.assign(new Error("Windows config locked"), { code: "EACCES" });
      assert.ok(state.has(from), "rename missing temporary source");
      state.set(to, state.get(from));
      state.delete(from);
    },
    rm: async (file) => { state.delete(file); },
  };
  let index = 0;
  const handler = new Function("exports", "fs", "path", "randomUUID", code + "\nreturn exports.handler;")(
    {}, fake, path, () => "fixture-id-" + ++index,
  );
  return { handler, state, temps, get direct() { return direct; } };
}
async function test() {
  const blocked = setup({ blockRename: true });
  await assert.rejects(blocked.handler(target, { new: "value" }), /locked|EACCES|rename/i);
  assert.equal(blocked.state.get(target), "ORIGINAL_USER_CONFIG",
    "rename failure must never overwrite original user config directly");
  assert.equal(blocked.direct, 0);
  checks++;
  const ok = setup();
  await Promise.all([
    ok.handler(target, { value: "first" }),
    ok.handler(target, { value: "second" }),
  ]);
  assert.equal(ok.temps.length, 2);
  assert.equal(new Set(ok.temps).size, 2, "concurrent writers must stage to distinct temp paths");
  assert.equal(ok.direct, 0);
  assert.ok(["first", "second"].includes(JSON.parse(ok.state.get(target)).value));
  checks++;
  console.log("mcp-config-atomic-smoke: " + checks + "/" + checks + " PASS");
}
test().catch(err => { console.error(err); process.exitCode = 1; });
