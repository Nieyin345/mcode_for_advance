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
const readSettingFn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getOutputStyleSetting");
assert.ok(fn && selectionFn && readSettingFn, "production style discovery, selection and persistence must exist");
const transpiled = ts.transpileModule(fn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiledSelect = ts.transpileModule(selectionFn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiledSetting = ts.transpileModule(readSettingFn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-style-collision-"));
async function main() {
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
  fs.writeFileSync(path.join(root, "08-control.md"), "---\nname: break\tline\n---\n");
  fs.writeFileSync(path.join(root, "09-oversized-name.md"), "---\nname: " + "X".repeat(750) + "\n---\n");
  fs.writeFileSync(path.join(root, "10-oversized-desc.md"), "---\nname: Normal Description\ndescription: " + "Y".repeat(3000) + "\n---\n");
  const parser = (md) => {
    const name = /^name: (.*)$/m.exec(md)?.[1];
    return { name };
  };
  let flood = false;
  const files = (dir) => flood ? [...fs.readdirSync(dir), ...Array.from({length: 1300}, (_, n) => `large-dir-${n}.md`)] : fs.readdirSync(dir);
  const list = new Function("exports", "USER_STYLE_DIR", "lstatSync", "readFileSync", "readdirSync", "join", "parseStyleFrontmatter",
    transpiled + "\nreturn listUserStyles;")(
      {}, root, fs.lstatSync, fs.readFileSync, files, path.join, parser,
    );
  const selection = new Function("exports", "listUserStyles", "bundledCliVersion", "BUILTIN_STYLES", "versionAtLeast",
    compiledSelect + "\nreturn listOutputStyles;")({}, list, () => "2.1.240",
      [{id: "default"}, {id: "Explanatory"}], () => true);
  const before = list();
  assert.ok(!before.some((s) => s.id === "Duplicate"),
    "two files with same CLI style name must be hidden as ambiguous, not both exposed in settings");
  assert.deepEqual(before.map(s => s.id), ["05-no-name", "default", "Normal", "Normal Description"]);
  assert.deepEqual(selection().filter(s => s.id === "default").map(s => s.source), ["user"],
    "single custom default shadows a built-in without two dropdown items");
  fs.writeFileSync(path.join(root, "07-second-default.md"), "---\nname: default\n---\n");
  assert.deepEqual(selection().filter(s => s.id === "default"), [],
    "two ambiguous custom defaults must not reveal misleading builtin default");
  assert.deepEqual(list().filter(s => s.id === "default"), [],
    "ambiguous custom defaults remain hidden from filtered user list");
  assert.ok(!selection().some(s => s.id.includes("\t") || s.id.length > 256),
    "control characters and oversized frontmatter style IDs must not enter CLI settings");
  assert.ok(selection().filter(s => s.id === "Normal Description").every(s => !s.description || s.description.length <= 2048),
    "enormous style descriptions must not enter UI dropdown metadata");
  let selected = "style-no-longer-installed";
  const readSetting = new Function("exports", "awaitDb", "SettingRepo", "AGENT_OUTPUT_STYLE_SETTING_KEY", "listOutputStyles",
    compiledSetting + "\nreturn getOutputStyleSetting;")({}, async () => undefined, {get: () => selected}, "outputStyle", selection);
  assert.equal(await readSetting(), null, "deleted style must not silently persist as an active SDK setting");
  selected = "Normal";
  assert.equal(await readSetting(), "Normal", "valid stored user style still applies");
  flood = true;
  assert.equal(list(), null, "huge style directories must refuse a synchronous scan instead of walking thousands of files");
  assert.deepEqual(selection(), [], "scanner overflow cannot resurrect a misleading builtin style");
  assert.equal(await readSetting(), null, "oversized scanner must not inject stale style into an SDK turn");
  console.log("output-style-dedup-smoke: 13/13 PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
