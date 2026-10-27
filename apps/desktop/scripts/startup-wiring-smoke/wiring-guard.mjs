// @smoke-covers src/main/index.ts
//
// **`index.ts` 的启动装配接线回归网。**
//
// ## 为什么单靠 `main.ts` 不够
//
// `main.ts` 测的是从 index.ts 抽出来的纯函数 `assembleStartup(deps)` —— 它证明那个函数
// **自己**装得对。但如果 index.ts **不再调它**(或改回了原来那段内联装配),被测的纯函数
// 照样全绿,**生产装配却整个消失**。这正是本仓记过的两类假绿之一(「测试绿着而问题还在」)。
//
// 所以这里用 TS AST 读 index.ts 源码,断言两件事:
//   1. index.ts **真的还在调 `assembleStartup({...})`**(装配没被拔掉);
//   2. 原来那几条内联装配(`assembleGrantStore(...)` / `setOperationLedger(...)` /
//      `assembleSceneRuntime()` …)**不再出现在 index.ts** —— 它们搬进了纯函数。
//      哪条重新冒出来,就说明有人把装配复制回了 index.ts(共享实现分家)。
//
// 另加一条:传进 assembleStartup 的 deps **带齐必需字段**(少一个 = 装配漏一步)。
//
// 纯 AST,不起 Electron,不 open 数据库。**故意写成无类型标注的 .mjs**:`@smoke-covers`
// 只扫 `.mjs`(见 smokes-for.py),而 node 直接跑 .mjs 不需要转译。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const source = readFileSync(resolve("src/main/index.ts"), "utf8");
const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

/** 收集所有「被调用标识符名」的调用表达式。`foo(...)` 记 `"foo"`;`a.b(...)` 记 `"a.b"`。 */
function calledNames(root) {
  const out = new Map();
  const push = (name, node) => {
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(node);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) push(e.text, node);
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) push(`${e.expression.text}.${e.name.text}`, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

let failures = 0;
let total = 0;
function check(name, cond, detail) {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const calls = calledNames(tree);

// 1. index.ts 仍真的在调 assembleStartup。
const starts = calls.get("assembleStartup") ?? [];
check("index.ts 真的在调 assembleStartup()(装配没被拔掉)", starts.length === 1, { count: starts.length });

// 2. 原来那几条内联装配不应再出现在 index.ts(它们搬进了纯函数)。
const mustBeGone = [
  "assembleGrantStore",
  "assembleUnattendedPlanStore",
  "assembleHostHookGrantPersist",
  "assembleSceneRuntime",
  "setOperationLedger",
  "setVisionRelayImpl",
];
for (const name of mustBeGone) {
  const remaining = (calls.get(name) ?? []).length;
  check(`内联装配 ${name}() 已从 index.ts 移除(搬进了 assembleStartup)`, remaining === 0, { remaining });
}

// 3. 传进 assembleStartup 的 deps 带齐必需字段 —— 少一个 = 生产装配漏一步。
const call = starts[0];
if (!call || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
  check("assembleStartup 收到的是一个对象字面量 deps", false, { args: call ? call.arguments.length : "n/a" });
} else {
  const provided = new Set(
    call.arguments[0].properties
      .map((p) => {
        // `key: value`(PropertyAssignment)与 `key`(ShorthandPropertyAssignment,即
        // `assembleModuleApprovalPort` 这种直接传入的同名标识符)都要收。
        if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
        if (ts.isPropertyAssignment(p)) return ts.isIdentifier(p.name) ? p.name.text : p.name.getText(tree);
        return null;
      })
      .filter((name) => name !== null),
  );
  const required = [
    "dataRoot",
    "operationLedger",
    "visionRelay",
    /* 【2026-10-28】**`assembleModuleApprovalPort` 已从必填项删掉。**
     *
     * 那个注入点随 ModuleHost 于 2026-10-27 整体删除（`modules/moduleApproval.ts`
     * 已不存在）。它从前是 shorthand property（`assembleStartup({ …, assembleModuleApprovalPort })`），
     * 上面那段注释还拿它当例子 —— 一并更新，别让下一个人照着找一个删掉的函数。
     *
     * 现在 `StartupAssemblyDeps` 的必需项是这四个 + 可选 `reportCorruption`。 */
    "configureExtensionBridgeTokenStore",
    "bridgeTokenStore",
  ];
  for (const field of required) {
    check(`deps 带上了 ${field}`, provided.has(field), { provided: [...provided] });
  }
}

console.log(`\nstartup-wiring(wiring-guard): ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
