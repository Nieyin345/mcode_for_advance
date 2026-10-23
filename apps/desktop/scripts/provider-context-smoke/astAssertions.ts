/**
 * 【T68】provider-context-smoke 的 AST 判据工具。
 *
 * 由来：T61 证明 `readFileSync(源码).includes("某段代码")` 是**空过**的 —— 注释里的
 * 文本、字符串字面量都能让它为真。T64 用 TypeScript 编译器 API 修掉了第一条，本文件
 * 把那套判据抽出来供剩余 6 条共用（**不重写第二份解析器**）。
 *
 * 每条判据的固定结构：
 *   - **判据**：只看 AST 节点，不看文本；
 *   - **正控**：在**已知含目标**的输入上跑同一个 finder，必须命中 —— 证明 finder 没坏；
 *   - **反控**：把目标塞进**字符串字面量/注释**再跑，必须不命中 —— 证明它区分代码与文本。
 *
 * 没有正控的「没找到」= 无法区分「真的没有」和「finder 坏了」。
 * 没有反控的「找到了」= 可能只是撞上了注释里的同名文本。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as TS from "typescript";

// bundle 在临时目录跑，那里没有 node_modules —— 必须从项目根运行时解析。
const requireFromHere = createRequire(resolve(process.cwd(), "package.json"));
export const ts = requireFromHere("typescript") as typeof TS;

/** 解析一段源码（TS/TSX 按扩展名选 Kind）。 */
export function parseSource(rel: string, text: string): TS.SourceFile {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

/** 从磁盘读并解析。 */
export function parseFile(absRelToCwd: string): TS.SourceFile {
  return parseSource(absRelToCwd, readFileSync(resolve(process.cwd(), absRelToCwd), "utf8"));
}

/** 遍历所有节点（含根）。 */
export function walk(sf: TS.SourceFile, visit: (node: TS.Node) => void): void {
  const go = (node: TS.Node): void => { visit(node); ts.forEachChild(node, go); };
  go(sf);
}

/** 节点所在行的文本（1-based 行号），用于把 AST 命中映射回源码位置。 */
export function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/* ───────────────────── 几条具名查找器（6 条断言共用） ───────────────────── */

/** `name: <initializer>` 的**对象字面量属性赋值**（不是类型注解的 PropertySignature）。 */
export function findPropertyAssignments(sf: TS.SourceFile, name: string): Array<{ valueText: string; line: number }> {
  const out: Array<{ valueText: string; line: number }> = [];
  walk(sf, (node) => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name;
      const keyText = ts.isIdentifier(key) ? key.text
        : ts.isStringLiteral(key) ? key.text : "";
      if (keyText === name) out.push({ valueText: node.initializer.getText(sf), line: lineOf(sf, node) });
    }
  });
  return out;
}

/** `obj.prop` 形式的属性访问（含 `?.`），返回调用与否。 */
export function findPropertyAccesses(sf: TS.SourceFile, objName: string, propName: string): Array<{ called: boolean; optional: boolean; line: number }> {
  const out: Array<{ called: boolean; optional: boolean; line: number }> = [];
  walk(sf, (node) => {
    if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === objName &&
        node.name.text === propName) {
      out.push({
        called: ts.isCallExpression(node.parent),
        optional: node.questionDotToken !== undefined,
        line: lineOf(sf, node),
      });
    }
  });
  return out;
}

/** 任意位置出现的**标识符**（不是字符串、不是注释）。 */
export function findIdentifiers(sf: TS.SourceFile, name: string): Array<{ line: number }> {
  const out: Array<{ line: number }> = [];
  walk(sf, (node) => {
    if (ts.isIdentifier(node) && node.text === name) out.push({ line: lineOf(sf, node) });
  });
  return out;
}

/** `const <name> = <initializer>` 的变量声明。 */
export function findConstDeclarations(sf: TS.SourceFile, name: string): Array<{ initializerText: string; line: number }> {
  const out: Array<{ initializerText: string; line: number }> = [];
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      out.push({ initializerText: node.initializer?.getText(sf) ?? "", line: lineOf(sf, node) });
    }
  });
  return out;
}

/** 所有 `X.slice(arg)` 调用里，参数文本恰好是 `-<name>` 的（用于验"常量真的被用上了"）。 */
export function findSliceWithNegated(sf: TS.SourceFile, name: string): Array<{ line: number; argText: string }> {
  const out: Array<{ line: number; argText: string }> = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "slice" && node.arguments.length === 1) {
      const argText = node.arguments[0]!.getText(sf);
      if (argText === `-${name}`) out.push({ line: lineOf(sf, node), argText });
    }
  });
  return out;
}

/**
 * **反控夹具**：把一段代码包成同形源码，但让目标**只出现在字符串字面量/注释里**。
 *
 * 用它跑同一个 finder，断言**命中数为 0** —— 证明判据不是靠"文本里出现这个名字"。
 */
export function fakeSourceWithTextOnly(kind: "string" | "comment", snippet: string): TS.SourceFile {
  const body = kind === "string"
    ? `const ignored = ${JSON.stringify(snippet)};\n`
    : `// ${snippet}\nconst ignored = 1;\n`;
  return parseSource("negative-control.ts", body);
}
