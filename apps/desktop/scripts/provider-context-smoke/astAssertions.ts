/**
 * 【T68/T74】`provider-context-smoke` 的 **判据层** finder 与反控夹具。
 *
 * ## 为什么这些不放进 `scripts/lib/ast.ts`
 *
 * 每个 finder 都编码了**一条具体判据的语义**：
 *   - `findPropertyAssignments` 只认 `PropertyAssignment`，**故意**不算 `PropertySignature`
 *     （类型注解 `pluginNames?: string[]` 不是赋值）；
 *   - `findSliceWithNegated` 要求 `slice` 的**唯一**参数文本恰好是 `-X`；
 *   - `findPropertyAccesses` 区分「属性访问」与「属性访问并调用」。
 *
 * 这些取舍只对 `provider-context-smoke` 成立。提前共享到 lib 等于**为想象中的
 * 第三个消费者设计**，会让下一套想验别的东西时被迫套用不合适的 finder。
 *
 * 机械层（解析、遍历、行号、`findCalls`）在 `../lib/ast.js`。
 */
import type * as TS from "typescript";
import { ts, parseSource, parseFile, walk, lineOf } from "../lib/ast.js";

// 机械层的常用入口在这里一并 re-export，消费方（main.ts）只需 import 一处。
export { walk, lineOf, parseSource, parseFile, ts };

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
 * 用它跑同一个 finder，断言**命中数为 0** —— 证明判据不是靠「文本里出现这个名字」。
 *
 * ## 为什么它留在这里，不进 `lib/ast.ts`
 *
 * 它是**判据夹具**不是机械层：它存在的唯一目的是给「反控」这类断言造输入。按
 * finder 层同一条理由（编码了具体判据的语义），留在消费方。
 *
 * 只有当**第二套**套件真的需要它时，才值得判断该不该提到 lib —— 现在提就是
 * 为想象中的消费者设计。
 */
export function fakeSourceWithTextOnly(kind: "string" | "comment", snippet: string): TS.SourceFile {
  const body = kind === "string"
    ? `const ignored = ${JSON.stringify(snippet)};\n`
    : `// ${snippet}\nconst ignored = 1;\n`;
  return parseSource("negative-control.ts", body);
}
