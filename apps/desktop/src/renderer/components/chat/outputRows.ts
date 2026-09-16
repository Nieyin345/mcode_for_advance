/**
 * 一步的产出**该怎么摆** —— 按变量逐项摆,还是按一段文本摆。
 *
 * ## 为什么单独一个文件
 *
 * 判断本身只有十来行,但它是**用户报过的那件事**的落点:「我规定了主代理的输出形式,
 * 但是他还是在输出形式之外多加了一段说明」。声明过产出变量的那一步,产出是一个对象、
 * 内容全在变量里(见 `@contracts/outputConstraint` 的 `describeOutputVars`),把那段
 * 原文摊在卡片上,摊出来的正好是他说过不要看的那一坨 —— 多一个字都藏不住。
 *
 * 抽出来是为了**能被无头断言**(见 `scripts/session-store-smoke` 第 10 节):留在
 * `WorkflowStepCard.tsx` 里的话,要测它就得把 Markdown / shiki / katex 一整条链拖进
 * node 里跑。同一层里 `transcriptBlocks.ts` 也是为这个理由抽出来的。
 */
import { checkOutput } from "@contracts/outputConstraint";

/** 卡片上要摆的一行:变量名 + 它的值(已经是文本)。 */
export interface OutputRow {
  name: string;
  text: string;
}

/** 变量的值**不一定**是字符串(表里填的示例是字符串,但模型可以交数组)。
 *  非字符串原样铺开比 `[object Object]` 有用。 */
function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * 返回 `null` = **按一段文本摆**。
 *
 * 提不出来就退回原文,**这是刻意的**:产出没按规矩交(那时这一步本来就失败了),或者
 * 根本没声明过变量 —— 两种情况用户都更需要看见它到底交了什么。
 *
 * 提取用的是 `checkOutput` —— 和调度器校验产出**同一个解析器**,所以卡片上显示的就是
 * 下游拿到的那一份,不会出现"界面说交齐了、下游说少一样"这种两套说法。
 */
export function outputRowsOf(
  summary: string,
  keys: readonly string[] | undefined,
): OutputRow[] | null {
  if (!keys || keys.length === 0) return null;
  const checked = checkOutput(summary, keys.map((name) => ({ name, example: "" })));
  if (!checked.ok) return null;
  const obj = checked.value;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  return keys.map((name) => ({ name, text: asText((obj as Record<string, unknown>)[name]) }));
}
