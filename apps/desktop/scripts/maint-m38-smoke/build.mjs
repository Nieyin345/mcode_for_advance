// MAINT M38:**SQL 字符串里的 ESCAPE 子句必须是单字符** —— 拿真 sql.js 逐处 prepare。
//
// ## 起因
//
// `SettingRepo.keysWithPrefix` 写的是 `ESCAPE '\\\\'`(双引号字符串里四个反斜杠),运行时
// 落成两个字符,SQLite 当场拒绝:`ESCAPE expression must be a single character`。而唯一的
// 调用方 `sweepEventChains` 把异常 catch 成一行 warn —— 于是那个清理**一次都没跑成过**,
// `automation.eventChain.*` 只增不减,而 settings 表每写一次要重写整个库文件。
//
// 这一类错误**三道网都漏**:类型系统只看到 string;编译器不解析 SQL;调用方还把异常吞了。
// 唯一能拦住它的地方就是这里 —— 把字符串真的交给 SQLite 看一眼。
//
// ## 判据
//
// 量的是**运行时那个字符串**(经 TS AST 取 cooked 值),不是源码字面量。这一条是全部要害:
// 源码里 `'\\'`(双引号串)和 `'\\'`(模板串)长得一模一样却只有一个对,而 `'\\\\'` 和
// `'\\'` 只差一个字符、肉眼几乎分不开。只有 cooked 值才是 SQLite 真正收到的东西。
//
// 覆盖面是 `src/main` 下**所有** .ts —— 不是只盯 repositories.ts。这条规则跟文件无关,
// 哪天别处再写一句 LIKE ... ESCAPE,它一样得过这一关。
//
// @smoke-covers src/main/store/repositories.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");

const tsPkg = readdirSync(pnpm).filter((n) => n.startsWith("typescript@")).sort().at(-1);
if (!tsPkg) throw new Error("Already installed TypeScript is required; no network fallback");
const tsMod = await import(pathToFileURL(join(pnpm, tsPkg, "node_modules/typescript/lib/typescript.js")).href);
const ts = tsMod.default ?? tsMod;

let total = 0;
let failed = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** 一个字符串字面量**运行时**的值。带 `${}` 的模板串把占位符换成 `?`(它们在 SQL 里
 *  本来也只能是绑定参数的位置)。 */
function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += "?" + span.literal.text;
    return out;
  }
  return null;
}

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield full;
  }
}

// `ESCAPE` 后面那个 SQL 字符串字面量(`''` 是 SQL 里的转义单引号)。
const ESCAPE_RE = /\bESCAPE\s+('(?:[^']|'')*')/gi;

const found = [];
for (const file of walkFiles(join(desktop, "src/main"))) {
  const src = readFileSync(file, "utf8");
  if (!/\bESCAPE\b/i.test(src)) continue;
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const seen = (node) => {
    const value = literalValue(node);
    if (value !== null && /\bESCAPE\b/i.test(value)) {
      for (const m of value.matchAll(ESCAPE_RE)) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        found.push({ file: file.slice(desktop.length + 1).replace(/\\/g, "/"), line, expr: m[1] });
      }
    }
    ts.forEachChild(node, seen);
  };
  seen(ast);
}

console.log("\nmaint-m38 · SQL ESCAPE 子句必须是单字符");

// **一处都找不到本身就是失败。** 这套网是为一个真出过的 bug 架的;哪天那几句 SQL 被改没了
// (或者 AST 这段不再认得它们),这里静悄悄地"全过"才是最坏的结果 —— 它会一直绿着,
// 而它守的东西早就不在了。
check(`扫到了 ESCAPE 子句(${found.length} 处)`, found.length > 0, "src/main 下一处都没找到");

const initSqlJs = require("sql.js/dist/sql-asm.js");
const SQL = await initSqlJs();
const db = new SQL.Database();

for (const hit of found) {
  // 不需要真表:`SELECT 'a' LIKE 'b' ESCAPE <expr>` 已经足够让 SQLite 校验那个子句,
  // 而且不必把整个 schema 搬过来。
  let err;
  try {
    db.exec(`SELECT 'a' LIKE 'b' ESCAPE ${hit.expr}`);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check(`${hit.file}:${hit.line}  ESCAPE ${hit.expr}`, err === undefined, err);
}

// 反面对照:这套网真的拦得住那个原始 bug 吗。一条永远绿的断言等于没有断言。
let twoCharRejected = false;
try {
  db.exec("SELECT 'a' LIKE 'b' ESCAPE '\\\\'");
} catch {
  twoCharRejected = true;
}
check("两个字符的 ESCAPE 确实会被 SQLite 拒绝(这张网有效)", twoCharRejected);

db.close();
console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
