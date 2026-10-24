#!/usr/bin/env node
/**
 * F019｜VS Code API 需求普查 —— 真 AST 扫描器
 *
 * 扫本机 `.vscode/extensions/` 里的真实扩展，用 TypeScript 的 parser 解析 JS，
 * 提取它们实际引用的 `vscode.*` 命名空间与成员，按「被多少个扩展使用」排序。
 *
 * 为什么必须 AST：
 *   - `const { window } = require("vscode")` → `window.showQuickPick(...)`（正则抓不到）
 *   - `const w = vscode.window; w.showInformationMessage(...)`（别名）
 *   - `import { commands as c } from "vscode"`（ESM 别名）
 *   - 打包产物里 `vscode` 常被 webpack 模块系统藏起来：
 *       `496:e=>{e.exports=require("vscode")}` + `var o=n(496)`（模块 id → 绑定）
 *   - **反向的陷阱**：`process.env.DEBUG` 文本上和 `vscode.env.DEBUG` 一模一样。
 *     正则分不清；AST 按绑定解析，只认从 `require("vscode")` 流出来的标识符。
 *
 * 扫描范围：入口（package.json 的 `main`，有 `browser` 时一并扫）+ 递归本地
 * require/import（排除 node_modules）+ webpack 拆分出的 chunk 文件（`n.e(<id>)`
 * 且同目录存在 `<id>.js`）。
 *
 * 用法：
 *   node main.mjs                                 # 扫默认目录，JSON 写到 result.json
 *   node main.mjs --extensions-dir <dir>          # 扫别的目录（变异探针用）
 *   node main.mjs --out <file>                    # 指定 JSON 输出
 *   node main.mjs --verbose                       # 打印每个扩展的扫描明细
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
// `typescript` 一定装了（apps/desktop/node_modules）；不从根 package.json 装任何东西。
const ts = requireFromHere("../../node_modules/typescript");

const DEFAULT_ROOT = "C:\\Users\\Nieyin\\.vscode\\extensions";
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * interop 包装器的已知名字（常见形态）。
 * 但 minified 产物的包装器名字是**短的任意标识符**（`J` / `Qe` / `n` …），
 * 所以真正的判据是「**标识符**被调用 + 单参数 + 参数解析为 vscode」——
 * 见 resolveExpr 里的规则。这里只额外放行少数**属性访问形式**的已知包装（Object.freeze 等）。
 */
const INTEROP_HELPERS = new Set([
  "__importStar", "__importDefault", "__toESM", "__toCommonJS",
  "_interopRequireDefault", "_interopRequireWildcard", "_mergeNamespaces",
]);
const INTEROP_OBJECT_METHODS = new Set(["freeze"]);

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { extensionsDir: DEFAULT_ROOT, out: join(HERE, "result.json"), verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extensions-dir") opts.extensionsDir = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log("node main.mjs [--extensions-dir <dir>] [--out <json>] [--verbose]");
      process.exit(0);
    } else {
      console.error("unknown arg: " + a);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 扩展枚举

/** 目录名 → {publisher,name,version,main,browser}；无 package.json 返回 null。 */
function readManifest(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return {
      publisher: typeof j.publisher === "string" ? j.publisher : null,
      name: typeof j.name === "string" ? j.name : null,
      version: typeof j.version === "string" ? j.version : null,
      main: typeof j.main === "string" ? j.main : null,
      browser: typeof j.browser === "string" ? j.browser : null,
      engines: j.engines && typeof j.engines.vscode === "string" ? j.engines.vscode : null,
    };
  } catch (e) {
    return { parseError: String(e), main: null, browser: null };
  }
}

/** 把 package.json 的 main 解析成真实文件（VS Code 会补 .js、找 index.js）。 */
function resolveEntry(dir, relPath) {
  const base = resolve(dir, relPath);
  const candidates = [base, base + ".js", base + ".cjs", base + ".mjs", base + ".jsx"];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  // 目录 + index
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const idx of ["index.js", "index.cjs", "index.mjs"]) {
      const c = join(base, idx);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

function listDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------- AST 基础

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function parseFile(absPath) {
  const text = readFileSync(absPath, "utf8");
  const kind = extname(absPath) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  // setParentNodes=true：`var` 判定要看 VariableDeclarationList 的 flags（node.parent）。
  // 10 MB 级的打包产物也能接受（实测见 docs/planning/vscode-api-census.md 的耗时）。
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);
  return { sf, text, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
}

function propName(node) {
  // PropertyAccess `a.b` / ElementAccess `a["b"]`
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function unwrap(node) {
  while (node) {
    if (ts.isParenthesizedExpression(node)) node = node.expression;
    else if (ts.isAsExpression(node)) node = node.expression;
    else if (ts.isTypeAssertionExpression(node)) node = node.expression;
    else if (ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isSatisfiesExpression(node)) node = node.expression;
    else break;
  }
  return node;
}

function isRequireVscodeCall(node) {
  const n = unwrap(node);
  if (!n || !ts.isCallExpression(n)) return false;
  if (!ts.isIdentifier(n.expression) || n.expression.text !== "require") return false;
  return n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "vscode";
}

/**
 * 预扫：找出 webpack 模块表里「这个数字 id 的模块就是 vscode」。
 * 形如 `{496:e=>{e.exports=require("vscode")}}` / `{91398(e){"use strict";e.exports=require("vscode")}}`。
 */
function collectVscodeModuleIds(sf) {
  const ids = new Set();
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        // 三种模块表写法：
        //   属性形态   `{496: e=>{e.exports=require("vscode")}}`
        //   方法形态   `{54980(e){e.exports=require("vscode")}}`     ← webpack 5 压缩产物
        //   字符串键   `{"496": ...}`
        const name = prop.name;
        if (!name) continue;
        let id = null;
        if (ts.isNumericLiteral(name)) id = name.text;
        else if (ts.isStringLiteral(name) && /^\d+$/.test(name.text)) id = name.text;
        if (id === null) continue;
        let body = null;
        if (ts.isPropertyAssignment(prop)) {
          const init = unwrap(prop.initializer);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) body = init.body;
        } else if (ts.isMethodDeclaration(prop)) {
          body = prop.body;
        }
        if (!body) continue;
        // 在函数体里找 `.exports = require("vscode")` / `module.exports = require("vscode")`
        let found = false;
        const inner = (n) => {
          if (found) return;
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = unwrap(n.left);
            const isExports =
              (ts.isPropertyAccessExpression(left) && left.name.text === "exports") ||
              (ts.isElementAccessExpression(left) && left.argumentExpression && ts.isStringLiteral(left.argumentExpression) && left.argumentExpression.text === "exports");
            if (isExports && isRequireVscodeCall(n.right)) {
              found = true;
              return;
            }
          }
          ts.forEachChild(n, inner);
        };
        inner(body);
        if (found) ids.add(id);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ids;
}

// ---------------------------------------------------------------- 绑定与使用

const WHOLE = Object.freeze({ k: "whole" });
const OPAQUE = Object.freeze({ k: "opaque" });
const nsBind = (ns) => ({ k: "ns", ns });
const memberBind = (full) => ({ k: "member", full });

class Scope {
  constructor(parent, fn) {
    this.parent = parent;
    // 最近一层函数作用域（root 自己就是函数作用域）—— `var` 绑到这里，而不是当前 block
    this.fn = fn || this;
    this.map = new Map();
  }
  bind(name, value) {
    this.map.set(name, value);
  }
  bindVar(name, value) {
    this.fn.map.set(name, value);
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.map.has(name)) return s.map.get(name);
    }
    return null;
  }
}

/**
 * 解析一个表达式是不是 vscode（整模块 / 某个命名空间 / 某个成员）。
 * 只做纯解析，不记账。
 */
function resolveExpr(node, scope, ctx) {
  node = unwrap(node);
  if (!node) return null;
  if (isRequireVscodeCall(node)) return WHOLE;
  if (ts.isIdentifier(node)) {
    const b = scope.lookup(node.text);
    return b || null;
  }
  if (ts.isCallExpression(node)) {
    if (isRequireVscodeCall(node)) return WHOLE;
    // webpack：n(496)，且 496 的模块导出就是 require("vscode")
    if (node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0]) && ts.isIdentifier(node.expression)) {
      if (ctx.vscodeModuleIds.has(node.arguments[0].text)) return WHOLE;
    }
    // interop 包装器：
    //   命名形态：__importStar(require("vscode"))
    //   minified 形态：J(require("vscode")) / Qe(n(496)) —— 标识符 callee + 单参数 + 参数解析为 **整模块**。
    // 只放行「参数是整模块」这一种：`f(vscode.window)` 的返回值不一定是 window，
    // 把成员/命名空间也穿透会产生 `workspace.getConfiguration.get` 这类假成员。
    // 属性访问 callee 不放行：`Object.keys(vscode)` 返回的是字符串数组。
    const callee = unwrap(node.expression);
    if (callee && ts.isIdentifier(callee) && node.arguments.length === 1) {
      const inner = resolveExpr(node.arguments[0], scope, ctx);
      if (inner && inner.k === "whole") return WHOLE;
      return null;
    }
    if (callee && ts.isPropertyAccessExpression(callee) && node.arguments.length === 1) {
      const objName = ts.isIdentifier(callee.expression) ? callee.expression.text : null;
      if (objName === "Object" && INTEROP_OBJECT_METHODS.has(callee.name.text)) {
        const inner = resolveExpr(node.arguments[0], scope, ctx);
        return inner && inner.k === "whole" ? WHOLE : null;
      }
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propName(node);
    if (name === null) return null;
    const base = resolveExpr(node.expression, scope, ctx);
    if (!base) return null;
    // ESM 互操作：`__importDefault(vscode).default` 还是 vscode 本身
    if (base.k === "whole" && name === "default") return WHOLE;
    if (base.k === "whole") return nsBind(name);
    if (base.k === "ns") return memberBind(base.ns + "." + name);
    return null;
  }
  return null;
}

/**
 * 把解析结果记进集合。
 *
 * 三种调用者，靠 `kind` 区分：
 *   - "use"   —— 真正的一次**使用**（属性访问 / 构造 / 解构取一项）。计入 uses。
 *   - "bind"  —— 建立别名（`const x = vscode.window`），是**绑定**不是使用。只记命名空间。
 *   - "import"—— ESM 命名导入；导入本身算一次依赖声明（计入 uses，与 vscode 官方 d.ts 的用法一致）。
 *
 * 为什么要分：`const { window } = require("vscode")` 之后 `window.showQuickPick(...)`
 * 是第二次记录（属性访问），如果解构也算 use，会重复计数。
 * 但解构**确实**表达了「我依赖 window 这个命名空间」—— 所以命名空间照记。
 */
function record(binding, ctx, kind) {
  if (!binding) return;
  const countUse = kind !== "bind";
  if (binding.k === "ns") {
    ctx.namespaces.add(binding.ns);
  } else if (binding.k === "member") {
    const i = binding.full.indexOf(".");
    if (i > 0) {
      const ns = binding.full.endsWith(".constructor") ? binding.full.slice(0, -".constructor".length) : binding.full.slice(0, i);
      ctx.namespaces.add(ns.split(".")[0]);
      ctx.members.add(binding.full);
      if (countUse) ctx.memberUses.set(binding.full, (ctx.memberUses.get(binding.full) || 0) + 1);
    }
  }
}

/**
 * 处理一个声明名（标识符 / 对象解构 / 数组解构）与解析出的值。
 */
function bindPattern(pattern, value, scope, ctx, varScoped) {
  pattern = unwrap(pattern);
  if (!pattern) return;
  const bindName = (name, v) => (varScoped ? scope.bindVar(name, v) : scope.bind(name, v));
  if (ts.isIdentifier(pattern)) {
    bindName(pattern.text, value || OPAQUE);
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken) {
        // rest：保留为 opaque（拿到的形状不明确）
        if (ts.isIdentifier(el.name)) bindName(el.name.text, OPAQUE);
        continue;
      }
      const key = el.propertyName
        ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
          ? el.propertyName.text
          : null
        : ts.isIdentifier(el.name)
          ? el.name.text
          : null;
      if (key === null) continue;
      let v = null;
      if (value && value.k === "whole") v = nsBind(key);
      else if (value && value.k === "ns") v = memberBind(value.ns + "." + key);
      else v = OPAQUE;
      // 解构是**绑定**不是使用：`const { window } = require("vscode")` 本身不调用任何东西。
      // 之后每一次 `window.showQuickPick(...)` 才是一次 use（由属性访问规则记）。
      if (value && value.k === "whole") record(nsBind(key), ctx, "bind");
      else if (value && value.k === "ns") record(memberBind(value.ns + "." + key), ctx, "bind");
      bindPattern(el.name, v, scope, ctx, varScoped);
    }
    return;
  }
  // 数组解构等：全部 opaque
  if (ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) bindPattern(el.name, OPAQUE, scope, ctx, varScoped);
    }
  }
}

function isVarDeclaration(node) {
  let p = node.parent;
  // VariableDeclaration → VariableDeclarationList
  if (!p || !p.declarations) return false;
  return (p.flags & ts.NodeFlags.BlockScoped) === 0;
}

/**
 * 函数作用域的 `var` 提升。
 *
 * 压缩产物里一条语句声明十几个别名（`var j=J(require("vscode")),pe=require("vscode")...`），
 * 而这些别名在**文本位置更靠前**的嵌套函数里被使用。单趟按源码顺序遍历时，
 * 那个函数体在别名声明之前就被访问了 —— 别名查不到，成员静默漏报。
 *
 * 所以进入一个函数作用域时先扫一遍它的全部 `var` 声明（不进入嵌套函数），
 * 把能解析为 vscode 的绑到函数作用域，再走主遍历。这是真实的 `var` 提升语义。
 */
function hoistVars(body, fnScope, ctx) {
  if (!body) return;
  const walk = (n) => {
    if (n !== body && ts.isFunctionLike(n)) return; // 不进嵌套函数（它们有各自的提升）
    if (ts.isVariableDeclaration(n) && isVarDeclaration(n) && n.initializer) {
      const value = resolveExpr(n.initializer, fnScope, ctx);
      if (value) {
        record(value, ctx, "bind");
        bindPattern(n.name, value, fnScope, ctx, true);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
}

/**
 * 模块（SourceFile）顶层的变量声明预绑定。
 *
 * 打包产物在 IIFE 里用 `var`，由 hoistVars 覆盖；但 tsc 编译的扩展在模块顶层用
 * `const vscode = __importStar(require("vscode"))`，而顶层函数体里对它的引用
 * 在**调用时**求值 —— 文本顺序上函数可以先出现。把顶层声明先绑一遍是安全的
 * 过近似（真实的函数体求值发生在模块初始化之后）。
 */
function hoistModuleVars(sf, root, ctx) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const value = resolveExpr(decl.initializer, root, ctx);
      if (value) {
        record(value, ctx, "bind");
        bindPattern(decl.name, value, root, ctx, true);
      }
    }
  }
}

/**
 * 单文件扫描。返回 { members, memberUses, namespaces, localRequires:Set<string>, chunkIds:Set<string> }。
 * `members` 是形如 "window.showQuickPick" 的全名集合；
 * `memberUses` 是同一批全名 → 使用次数（绑定/解构不计，见 record()）。
 */
function scanFile(absPath) {
  const { sf, text, bytes, lines } = parseFile(absPath);
  const ctx = {
    members: new Set(),
    memberUses: new Map(),
    namespaces: new Set(),
    localRequires: new Set(),
    chunkIds: new Set(),
    vscodeModuleIds: null,
  };
  ctx.vscodeModuleIds = collectVscodeModuleIds(sf);
  const root = new Scope(null);

  // require("vscode") 的绑定；也处理 `const x = require("vscode").window` 这类
  const visit = (node, scope) => {
    // --- 作用域
    if (ts.isFunctionLike(node)) {
      const inner = new Scope(scope, null); // fn 缺省 = 自己
      // 函数名本身对本文件可见（函数声明）
      if (ts.isFunctionDeclaration(node) && node.name) scope.bind(node.name.text, OPAQUE);
      for (const p of node.parameters) {
        // 参数名一律 opaque（遮蔽外层同名绑定）
        bindOpaquePattern(p.name, inner);
      }
      // `var` 提升：先绑一遍本函数里的 var 别名，再走主遍历
      hoistVars(node.body, inner, ctx);
      ts.forEachChild(node, (c) => visit(c, inner));
      return;
    }
    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node)) {
      const inner = new Scope(scope, scope.fn);
      if (ts.isCatchClause(node) && node.variableDeclaration) bindOpaquePattern(node.variableDeclaration.name, inner);
      ts.forEachChild(node, (c) => visit(c, inner));
      return;
    }
    if (ts.isSourceFile(node)) {
      hoistModuleVars(node, root, ctx);
      ts.forEachChild(node, (c) => visit(c, root));
      return;
    }

    // --- import 声明
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        if (spec.text === "vscode") {
          const clause = node.importClause;
          if (clause) {
            if (clause.name) scope.bind(clause.name.text, WHOLE); // default import
            if (clause.namedBindings) {
              if (ts.isNamespaceImport(clause.namedBindings)) {
                scope.bind(clause.namedBindings.name.text, WHOLE);
              } else if (ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) {
                  const imported = el.propertyName ? el.propertyName.text : el.name.text;
                  scope.bind(el.name.text, nsBind(imported));
                  record(nsBind(imported), ctx, "import"); // import 本身即声明了对该命名空间的依赖
                }
              }
            }
          }
        } else if (spec.text.startsWith("./") || spec.text.startsWith("../")) {
          ctx.localRequires.add(spec.text);
        }
      }
    }

    // --- import(...) 动态导入 / require("...") 本地路径
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const s = node.arguments[0].text;
        if (s.startsWith("./") || s.startsWith("../")) ctx.localRequires.add(s);
      }
      // 动态 import("./x")
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const s = node.arguments[0].text;
        if (s.startsWith("./") || s.startsWith("../")) ctx.localRequires.add(s);
      }
      // webpack chunk：n.e(<num>) / n.bind(n, <num>)
      const calleeName = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if ((calleeName === "e" || calleeName === "bind") && node.arguments.length >= 1) {
        const last = node.arguments[node.arguments.length - 1];
        if (ts.isNumericLiteral(last)) ctx.chunkIds.add(last.text);
      }
    }

    // --- 变量声明：绑定 vscode 别名 / 解构
    if (ts.isVariableDeclaration(node)) {
      let value = null;
      if (node.initializer) value = resolveExpr(node.initializer, scope, ctx);
      if (value) record(value, ctx, "bind");
      // `var` 绑到函数作用域（提升），let/const 绑到当前块
      if (value) {
        bindPattern(node.name, value, scope, ctx, isVarDeclaration(node));
      } else {
        bindPattern(node.name, value, scope, ctx);
      }
      // 继续访问 initializer 里的属性访问（会作为使用被记录）
    }

    // --- 赋值：x = require("vscode") / x = n(496)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) {
        const value = resolveExpr(node.right, scope, ctx);
        if (value) {
          record(value, ctx, "bind");
          scope.bind(left.text, value);
        }
      }
      // 表达式对右侧继续遍历
    }

    // --- new X(...) / new vscode.X(...)：构造式使用
    // `new vscode.Range(0,0,1,1)` 的属性链只到 `vscode.Range`，不是 `ns.member` 形状，
    // 主规则会把它记成**命名空间** `Range` —— 成员表里就永远不会出现 `Range`。
    // 而 `Range` / `EventEmitter` / `ThemeIcon` 这类**类**的真实用法就是构造。
    // 这里补一条 `Range.constructor`（`.constructor` 后缀表明这是类构造，不是静态成员）。
    if (ts.isNewExpression(node)) {
      const base = resolveExpr(node.expression, scope, ctx);
      if (base && base.k === "ns") record(memberBind(base.ns + ".constructor"), ctx);
      else if (base && base.k === "member") record(memberBind(base.full + ".constructor"), ctx);
      // base.k === "whole"（`new (require("vscode"))()`）不成立，不处理
    }

    // --- 属性 / 下标访问即使用
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propName(node);
      if (name !== null) {
        const base = resolveExpr(node.expression, scope, ctx);
        if (base) {
          // ESM 互操作：`mod.default` 还是模块本身（resolveExpr 里同一条规则）。
          // 不在这里记账，否则 `['default']` 会变成名为 `default` 的命名空间。
          if (base.k === "whole" && name === "default") {
            // 不是 API 使用
          } else if (base.k === "whole") record(nsBind(name), ctx);
          else if (base.k === "ns") record(memberBind(base.ns + "." + name), ctx);
        }
      }
    }

    ts.forEachChild(node, (c) => visit(c, scope));
  };

  visit(sf, root);
  return { members: ctx.members, memberUses: ctx.memberUses, namespaces: ctx.namespaces, localRequires: ctx.localRequires, chunkIds: ctx.chunkIds, bytes, lines, text };
}

function bindOpaquePattern(pattern, scope) {
  pattern = unwrap(pattern);
  if (!pattern) return;
  if (ts.isIdentifier(pattern)) {
    scope.bind(pattern.text, OPAQUE);
  } else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) bindOpaquePattern(el.name, scope);
    }
  }
}

// ---------------------------------------------------------------- 递归扫描一个扩展

function resolveLocal(importerAbs, spec) {
  const base = resolve(dirname(importerAbs), spec);
  for (const c of [base, base + ".js", base + ".cjs", base + ".mjs", base + ".json"]) {
    if (c.endsWith(".json")) continue;
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const idx of ["index.js", "index.cjs", "index.mjs"]) {
      const c = join(base, idx);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * 扫一个扩展。入口 + 递归本地 require + webpack chunk。
 * 同时返回 `entryOnlyMemberCount`：**只扫入口文件**能得到的成员数 ——
 * 用来证明「递归扫 require 的子文件」不是装饰（卡里的判据 1）。
 */
function scanExtension(dir, manifest) {
  const entries = [];
  if (manifest.main) {
    const e = resolveEntry(dir, manifest.main);
    if (e) entries.push(e);
    else entries.push({ missing: manifest.main });
  }
  const files = [];
  const errors = [];
  const members = new Set();
  const memberUses = new Map();
  const namespaces = new Set();
  const seen = new Set();
  const queue = [];
  const entrySet = new Set();
  for (const e of entries) {
    if (typeof e === "string") {
      if (!seen.has(e)) {
        seen.add(e);
        entrySet.add(e);
        queue.push(e);
      }
    } else {
      errors.push("main not found: " + e.missing);
    }
  }
  let entryOnlyMemberCount = 0;
  let entryScanned = false;
  while (queue.length) {
    const abs = queue.shift();
    if (abs.includes("node_modules") || abs.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue;
    let scanned;
    try {
      scanned = scanFile(abs);
    } catch (e) {
      errors.push("parse failed: " + basename(abs) + ": " + String(e && e.message ? e.message : e));
      files.push({ path: abs, bytes: 0, lines: 0, parseFailed: true });
      continue;
    }
    if (entrySet.has(abs) && !entryScanned) {
      entryOnlyMemberCount = scanned.members.size;
      entryScanned = true;
    }
    files.push({ path: abs, bytes: scanned.bytes, lines: scanned.lines });
    for (const m of scanned.members) members.add(m);
    for (const [m, c] of scanned.memberUses) memberUses.set(m, (memberUses.get(m) || 0) + c);
    for (const n of scanned.namespaces) namespaces.add(n);
    for (const spec of scanned.localRequires) {
      const r = resolveLocal(abs, spec);
      if (r && !seen.has(r) && !r.includes("node_modules")) {
        seen.add(r);
        queue.push(r);
      }
    }
    // webpack chunk：同目录 <id>.js
    for (const id of scanned.chunkIds) {
      const r = join(dirname(abs), id + ".js");
      if (existsSync(r) && !seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
  }
  return { files, members, memberUses, namespaces, errors, entryOnlyMemberCount };
}

// ---------------------------------------------------------------- 分类与去重

function classifyDir(root, dirName) {
  const dir = join(root, dirName);
  const manifest = readManifest(dir);
  if (!manifest) {
    return { dir: dirName, category: "not-extension", note: "no package.json", manifest: null };
  }
  if (manifest.parseError) {
    return { dir: dirName, category: "not-extension", note: "package.json parse error: " + manifest.parseError, manifest };
  }
  const id = manifest.publisher && manifest.name ? manifest.publisher + "." + manifest.name : null;
  const base = { dir: dirName, id, version: manifest.version, manifest };
  if (!manifest.main) {
    return { ...base, category: "no-code", note: manifest.browser ? "declares browser only" : "no main field" };
  }
  return { ...base, category: "code", note: null };
}

function compareVersionsDesc(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // 调试单文件（变异/对照用）：MCODE_CENSUS_DEBUG_FILE=<abs> node main.mjs
  if (process.env.MCODE_CENSUS_DEBUG_FILE) {
    const r = scanFile(process.env.MCODE_CENSUS_DEBUG_FILE);
    console.log("members:", [...r.members].sort().join("\n         "));
    console.log("namespaces:", [...r.namespaces].sort().join(", "));
    console.log("localRequires:", [...r.localRequires].join(", "));
    console.log("chunkIds:", [...r.chunkIds].join(", "));
    return;
  }
  const root = opts.extensionsDir;
  const dirs = listDirs(root);

  // 读 extensions.json 清单（决定重复版本的优先级）
  let manifestIds = new Set();
  const manifestPath = join(root, "extensions.json");
  if (existsSync(manifestPath)) {
    try {
      const j = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (Array.isArray(j)) for (const e of j) if (e && e.identifier && e.identifier.id) manifestIds.add(String(e.identifier.id).toLowerCase());
    } catch {
      /* ignore */
    }
  }

  const classified = dirs.map((d) => classifyDir(root, d));
  const codeDirs = classified.filter((c) => c.category === "code");

  // 去重：同一 publisher.name 保留一个（清单里的优先，其次版本高者）
  const byId = new Map();
  for (const c of codeDirs) {
    const key = c.id ? c.id.toLowerCase() : "dir:" + c.dir;
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(c);
  }
  const picked = [];
  const duplicates = [];
  for (const [key, list] of byId) {
    if (list.length === 1) {
      picked.push(list[0]);
      continue;
    }
    list.sort((a, b) => {
      const ma = manifestIds.has((a.id || "").toLowerCase()) ? 1 : 0;
      const mb = manifestIds.has((b.id || "").toLowerCase()) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return compareVersionsDesc(a.version, b.version);
    });
    picked.push(list[0]);
    for (const d of list.slice(1)) {
      duplicates.push({ kept: list[0].dir, dropped: d.dir, id: d.id, version: d.version, reason: "duplicate id; keeps " + list[0].dir + " (" + list[0].version + ")" });
    }
  }

  const perExtension = [];
  for (const c of picked) {
    const scan = scanExtension(join(root, c.dir), c.manifest);
    const totalBytes = scan.files.reduce((s, f) => s + f.bytes, 0);
    const totalLines = scan.files.reduce((s, f) => s + f.lines, 0);
    // 打包产物：单文件 >400 KB，或整体 >800 KB（webpack 拆包后单文件可能不大）
    const bunded = scan.files.some((f) => f.bytes > 400_000) || totalBytes > 800_000;
    perExtension.push({
      dir: c.dir,
      id: c.id,
      version: c.version,
      main: c.manifest.main,
      browser: c.manifest.browser,
      engines: c.manifest.engines,
      files: scan.files.map((f) => ({ path: relative(root, f.path), bytes: f.bytes, lines: f.lines, ...(f.parseFailed ? { parseFailed: true } : {}) })),
      fileCount: scan.files.length,
      totalBytes,
      totalLines,
      bunded,
      entryOnlyMemberCount: scan.entryOnlyMemberCount,
      members: [...scan.members].sort(),
      memberUseCounts: Object.fromEntries([...scan.memberUses.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      namespaces: [...scan.namespaces].sort(),
      errors: scan.errors,
    });
  }

  // 成员 → 扩展
  const memberToExts = new Map();
  for (const ext of perExtension) {
    for (const m of ext.members) {
      if (!memberToExts.has(m)) memberToExts.set(m, []);
      memberToExts.get(m).push(ext.id || ext.dir);
    }
  }
  const memberTable = [...memberToExts.entries()]
    .map(([member, exts]) => {
      // `X.constructor`（构造式用法）的命名空间是 X 本身，不是 "X" 之外的段
      const ns = member.endsWith(".constructor") ? member.slice(0, -".constructor".length) : member.split(".")[0];
      return { member, ns, extCount: exts.length, exts: exts.sort() };
    })
    .sort((a, b) => b.extCount - a.extCount || a.member.localeCompare(b.member));

  // 覆盖曲线：分母 = 扫出至少一个成员的扩展。
  //
  // 三个口径，回答的是**三个不同的问题**，不能混：
  //
  //   strictPct      —— 「实现了 Top K，有多少扩展能被**完全**支持？」（一个没实现的成员也算失败）
  //   avgMemberRatio —— 「实现了 Top K，平均每个扩展的成员需求覆盖了多少？」（按**种类**）
  //   avgUseRatio    —— 「实现了 Top K，平均每个扩展的**调用次数**覆盖了多少？」（按**次数**）
  //
  // 后两个差得远说明：没覆盖的那批成员是少见路径，不是高频路径。
  const scored = perExtension.filter((e) => e.members.length > 0);
  const denominator = scored.length;
  const ranked = memberTable.map((m) => m.member);
  const curve = [];
  for (const k of [...new Set([1, 3, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400].filter((x) => x < ranked.length)), ranked.length]) {
    const top = new Set(ranked.slice(0, k));
    let strict = 0;
    let anyUse = 0;
    let sumRatio = 0;
    let sumUseRatio = 0;
    let use90 = 0;
    let use80 = 0;
    for (const e of scored) {
      const set = new Set(e.members);
      let hit = 0;
      for (const m of set) if (top.has(m)) hit++;
      if (hit === set.size) strict++;
      if (hit > 0) anyUse++;
      sumRatio += set.size ? hit / set.size : 0;
      let totalUses = 0;
      let coveredUses = 0;
      for (const [m, c] of Object.entries(e.memberUseCounts || {})) {
        totalUses += c;
        if (top.has(m)) coveredUses += c;
      }
      const useRatio = totalUses ? coveredUses / totalUses : 0;
      sumUseRatio += useRatio;
      if (totalUses > 0 && useRatio >= 0.9) use90++;
      if (totalUses > 0 && useRatio >= 0.8) use80++;
    }
    curve.push({
      topK: k,
      strictCovered: strict,
      strictPct: +(100 * strict / denominator).toFixed(1),
      anyUse,
      anyUsePct: +(100 * anyUse / denominator).toFixed(1),
      avgMemberRatioPct: +(100 * sumRatio / denominator).toFixed(1),
      avgUseRatioPct: +(100 * sumUseRatio / denominator).toFixed(1),
      extsAt80UsePct: +(100 * use80 / denominator).toFixed(1),
      extsAt90UsePct: +(100 * use90 / denominator).toFixed(1),
    });
  }

  const zeroMember = perExtension.filter((e) => e.members.length === 0).map((e) => ({
    dir: e.dir,
    id: e.id,
    fileCount: e.fileCount,
    totalBytes: e.totalBytes,
    totalLines: e.totalLines,
    errors: e.errors,
    files: e.files.map((f) => f.path),
  }));

  // 只有 1 个扩展使用的成员占多少
  const singletonMembers = memberTable.filter((m) => m.extCount === 1).length;

  const result = {
    generatedAt: new Date().toISOString(),
    corpusRoot: root,
    classification: {
      totalDirs: dirs.length,
      code: codeDirs.length,
      noCode: classified.filter((c) => c.category === "no-code").map((c) => ({ dir: c.dir, id: c.id, version: c.version, note: c.note })),
      notExtension: classified.filter((c) => c.category === "not-extension").map((c) => ({ dir: c.dir, note: c.note })),
      duplicates,
    },
    totals: {
      scannedExtensions: perExtension.length,
      extensionsWithMembers: denominator,
      extensionsWithoutMembers: zeroMember.length,
      filesScanned: perExtension.reduce((s, e) => s + e.fileCount, 0),
      linesScanned: perExtension.reduce((s, e) => s + e.totalLines, 0),
      bytesScanned: perExtension.reduce((s, e) => s + e.totalBytes, 0),
      distinctMembers: memberTable.length,
      distinctNamespaces: new Set(memberTable.map((m) => m.ns)).size,
      membersUsedByOneExtension: singletonMembers,
      // 判据 1 的证据：只扫入口 vs 递归扫 require 的成员数差
      entryOnlyMembersSum: perExtension.reduce((s, e) => s + e.entryOnlyMemberCount, 0),
      recursiveMembersSum: perExtension.reduce((s, e) => s + e.members.length, 0),
    },
    curve,
    memberTable,
    perExtension,
    zeroMember,
  };

  writeFileSync(opts.out, JSON.stringify(result, null, 2), "utf8");

  if (opts.verbose) {
    for (const e of perExtension) {
      console.log(`[${e.members.length.toString().padStart(3)}] ${e.id || e.dir}  files=${e.fileCount} lines=${e.totalLines}`);
      for (const f of e.files) console.log(`        ${f.path}${f.parseFailed ? "  PARSE-FAILED" : ""}`);
      for (const m of e.members) console.log(`        - ${m}`);
    }
    for (const z of zeroMember) console.log(`[  0] ${z.id || z.dir}  files=${z.fileCount} lines=${z.totalLines}  ${z.errors.join("; ")}`);
  }

  console.log("scanned extensions:", perExtension.length, "| with members:", denominator, "| zero:", zeroMember.length);
  console.log("files:", result.totals.filesScanned, "lines:", result.totals.linesScanned, "members:", memberTable.length);
  console.log("top members:");
  for (const m of memberTable.slice(0, 15)) console.log(`  ${m.member}  ×${m.extCount}`);
  console.log("curve:");
  for (const c of curve) console.log(`  top ${c.topK}: strict ${c.strictPct}% | ≥90%-of-uses ${c.extsAt90UsePct}% | ≥80%-of-uses ${c.extsAt80UsePct}% | avg use coverage ${c.avgUseRatioPct}% | avg member coverage ${c.avgMemberRatioPct}%`);
  console.log("json:", opts.out);
}

main();
