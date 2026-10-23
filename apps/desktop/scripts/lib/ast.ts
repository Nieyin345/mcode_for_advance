/**
 * 【T74】无头 smoke 共用的 **AST 机械层**。
 *
 * ## 这里只放什么
 *
 * **与「验什么」无关的机械操作**：解析、遍历、取行号、按扩展名选 ScriptKind。
 * 这些重复出现只有漂移风险，没有语义差异。
 *
 * ## 这里**不放**什么（有意为之）
 *
 * **判据层的 finder 不在这里** —— `findPropertyAssignments` / `findPropertyAccesses` /
 * `findConstDeclarations` / `findSliceWithNegated` 每一个都编码了**具体判据的语义**
 * （例如「`PropertyAssignment` 不算 `PropertySignature` 类型注解」）。它们目前只有
 * `provider-context-smoke` 一套消费者，提前共享等于**为想象中的第三个消费者设计**。
 * 等第三套真的需要时再提。
 *
 * **例外是 `findCalls`**：它已经在两处各写了一遍（T64 的 `main.ts` 与 T68 的
 * `astAssertions.ts`），是**已经发生**的重复，不是想象出来的，所以提到这里。
 *
 * ## ScriptTarget 为什么钉 `ES2022` 而不是 `Latest`
 *
 * `ts.ScriptTarget.Latest` 在 TypeScript 里是**数值 99**，含义是「用编译器支持的最新
 * 目标」。它有一个隐蔽的后果：**升级 TypeScript 会改变解析行为**，而解析行为一变，
 * 建在 AST 上的判据就可能静默改变 —— 套件仍然全绿，但那个绿已经不是原来那个绿了。
 *
 * 测试判据的价值在于**可重复**：同一个输入、同一个结论，与依赖版本无关。所以钉死
 * `ES2022`（一个固定数值，不随 TS 升级变动）。
 *
 * 选 `ES2022` 而不是更早的版本，是因为仓库的 `apps/desktop/tsconfig.json` 目标就是
 * ES2022 —— 判据解析源码时用的目标应当与实际编译目标一致，否则可能解析出一个
 * 生产环境根本不会出现的语法形态。
 *
 * ⚠️ 注意：`ScriptTarget` 只影响**解析**（`createSourceFile` 如何理解语法），不影响
 * 我们读取 AST 节点。对 `parseFile` / `findCalls` 这类只读节点的工作，`ES2022` 与
 * `Latest` 在绝大多数代码上给出同一棵树；钉死版本是为了**排除将来变化的可能**。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as TS from "typescript";

/**
 * 运行时解析 typescript。
 *
 * **不能**用顶层 `import ts from "typescript"` —— 这些 smoke 被 esbuild 打进临时目录
 * 运行，那里没有 `node_modules`，静态 import 会在运行时抛 `ERR_MODULE_NOT_FOUND`。
 * 从**项目根**用 `createRequire` 解析，路径稳定。
 *
 * 消费方的 `run.sh` 还必须带 `--external:typescript`（typescript 内部用 CJS 的
 * `require("fs")`，打进 ESM bundle 会变成不支持的动态 require）。
 */
const requireFromHere = createRequire(resolve(process.cwd(), "package.json"));
export const ts = requireFromHere("typescript") as typeof TS;

/** 解析时使用的目标版本 —— 见文件头「为什么钉 ES2022」。 */
const SCRIPT_TARGET = ts.ScriptTarget.ES2022;

/** 按扩展名选 `ScriptKind`：`.tsx` → `TSX`，其余 → `TS`。 */
export function scriptKindOf(file: string): TS.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * 从**文本**解析出 `SourceFile`。
 *
 * 这个能力很关键：正控（「在已知含目标的合成源码上跑同一个 finder，必须命中」）与
 * 反控（「把目标塞进字符串字面量，必须不命中」）都靠它 —— 它们需要在不碰磁盘的前提下
 * 构造输入。只搬 `parseFile` 不够。
 */
export function parseSource(file: string, text: string): TS.SourceFile {
  return ts.createSourceFile(file, text, SCRIPT_TARGET, true, scriptKindOf(file));
}

/**
 * 从磁盘读并解析。
 *
 * `path` 可以是**相对当前工作目录**（smoke 的 cwd 恒为 `apps/desktop`），也可以是
 * **绝对路径** —— `resolve()` 对绝对路径是幂等的，所以两种都成立。
 * （`mobile-api-surface-smoke` 沿 import 图递归时拿到的是绝对路径，必须支持。）
 */
export function parseFile(path: string): TS.SourceFile {
  const abs = resolve(process.cwd(), path);
  return parseSource(abs, readFileSync(abs, "utf8"));
}

/** 遍历所有节点（含根）。 */
export function walk(sf: TS.SourceFile, visit: (node: TS.Node) => void): void {
  const go = (node: TS.Node): void => { visit(node); ts.forEachChild(node, go); };
  go(sf);
}

/** 节点的起始行号（1-based），用于把 AST 命中映射回源码位置做诊断输出。 */
export function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** 一次调用的形状。 */
export interface CallSite {
  /** 实参个数。 */
  argCount: number;
  /** 第一个实参的源码文本（无实参时为空串）。 */
  firstArg: string;
  /** 调用所在行（1-based），诊断用。 */
  line: number;
}

/**
 * 找出所有「被调用者叫 `<name>`」的 `CallExpression`。
 *
 * 「被调用者」的判定**两种都收**：
 *   - `name(...)` —— `Identifier`；
 *   - `obj.name(...)` —— `PropertyAccessExpression` 的 `name`。
 *
 * 只认 `CallExpression` 节点本身，所以：
 *   - 注释里的同名文本 → 不在 AST 里，找不到；
 *   - 字符串字面量里的同名文本 → 是 `StringLiteral`，不是 `CallExpression`，找不到。
 *
 * 这正是它相对 `src.includes("name(...)")` 的判别力来源。
 */
export function findCalls(sf: TS.SourceFile, name: string): CallSite[] {
  const out: CallSite[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (calleeName !== name) return;
    out.push({
      argCount: node.arguments.length,
      firstArg: node.arguments[0]?.getText(sf) ?? "",
      line: lineOf(sf, node),
    });
  });
  return out;
}
