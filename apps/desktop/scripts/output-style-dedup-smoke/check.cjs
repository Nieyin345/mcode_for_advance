"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../../src/main/lib/outputStyleConfig.ts"), "utf8");
const ast = ts.createSourceFile("outputStyleConfig.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "listUserStyles");
const selectionFn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "listOutputStyles");
assert.ok(fn && selectionFn, "production style discovery and selection must exist");
const transpiled = ts.transpileModule(fn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiledSelect = ts.transpileModule(selectionFn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-style-collision-"));
try {
  for (const [filename, name] of [
    ["01-first.md", "Duplicate"],
    ["02-second.md", "Duplicate"],
    ["03-normal.md", "Normal"],
    ["04-default.md", "default"],
    ["05-no-name.md", ""],
  ]) {
    fs.writeFileSync(path.join(root, filename), name ? "---\nname: " + name + "\n---\n" : "a style without frontmatter");
  }
  // A custom style is a prompt, not a binary payload. Scanning an enormous
  // markdown file synchronously on the Electron main thread must not block
  // settings discovery or allocate its entire body.
  fs.writeFileSync(path.join(root, "06-huge.md"), "---\nname: Huge\n---\n" + "x".repeat(600 * 1024));
  const parser = (md) => {
    const name = /^name: (.*)$/m.exec(md)?.[1];
    return { name };
  };
  const list = new Function("exports", "USER_STYLE_DIR", "lstatSync", "readFileSync", "readdirSync", "join", "parseStyleFrontmatter",
    transpiled + "\nreturn listUserStyles;")(
      {}, root, fs.lstatSync, fs.readFileSync, fs.readdirSync, path.join, parser,
    );
  const selection = new Function("exports", "listUserStyles", "bundledCliVersion", "BUILTIN_STYLES", "versionAtLeast",
    compiledSelect + "\nreturn listOutputStyles;")({}, list, () => "2.1.240",
      [{id: "default"}, {id: "Explanatory"}], () => true);
  const before = list();
  assert.ok(!before.some((s) => s.id === "Duplicate"),
    "two files with same CLI style name must be hidden as ambiguous, not both exposed in settings");
  assert.deepEqual(before.map(s => s.id), ["05-no-name", "default", "Normal"]);
  assert.deepEqual(selection().filter(s => s.id === "default").map(s => s.source), ["user"],
    "single custom default shadows a built-in without two dropdown items");
  fs.writeFileSync(path.join(root, "07-second-default.md"), "---\nname: default\n---\n");
  assert.deepEqual(selection().filter(s => s.id === "default"), [],
    "two ambiguous custom defaults must not reveal misleading builtin default");
  assert.deepEqual(list().filter(s => s.id === "default"), [],
    "ambiguous custom defaults remain hidden from filtered user list");
  console.log("output-style-dedup-smoke: 6/6 PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
