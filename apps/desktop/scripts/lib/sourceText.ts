/**
 * 【T120 / 判据】把源码里的**注释**剥掉，用于「源码文本断言」。
 *
 * ## 为什么需要它
 *
 * 2026-10-24 实测（两次，不同会话）：
 *
 * | 断言 | 注释掉真代码后 |
 * |---|---|
 * | `layout.includes("order: order.aside,")` | **仍绿**（28/28） |
 * | `layout.includes("style={{ order: order.center }}")` | **仍绿** |
 * | `src.includes("onWheel={onWheel}")` | **仍绿**（49/49） |
 *
 * **带不带花括号都一样** —— 注释里留着那段文字，`includes` 就命中。
 * 所以「源码文本断言」这个写法本身在**没有剥注释**时，**挡不住「把它注释掉」这个动作**，
 * 而那恰恰是最常见的「移除」方式（比删除更常见，因为更容易回滚）。
 *
 * ## 它不做什么
 *
 * **不是 JS 解析器**，不处理字符串字面量里的 `//`（例如 URL `"https://…"`）
 * —— 那会把后面的代码误当注释。所以这里按**行**判断，并显式排除字符串里的情况：
 * 只剥**以注释记号开头**的片段（行注释、星号开头的块注释正文行、块注释开头那行），
 * 以及行内**成对**的 JSX 注释与块注释（后者要求开头记号前不是英文冒号）。
 *
 * 这是**有意保守**：宁可能剥不掉一处（断言更严格，可能无辜变红），
 * 也不要误剥掉真代码（断言变弱且无人发现）。
 *
 * ## 已知边界（实测，2026-10-24）
 *
 * | 输入 | 结果 | 说明 |
 * |---|---|---|
 * | 模板字符串里的 `//` 之后 | **仍识别为真代码** | 不把它当行注释，所以同行的代码不会被剥 |
 * | 普通字符串里的 `//`（如 URL） | **仍识别** | 同上 |
 * | JSX 注释跨多行 | **正确剥掉** | |
 *
 * **第一、二行是保守的代价，不是缺陷**：想要精确，就得知道「此刻在不在字符串里」，
 * 那就是解析器。**用它验模板字符串内容的人会撞上这一点** —— 那种代码会被当成
 * 真代码，断言可能无辜变绿（如果 needle 只在字符串里）。**验字符串字面量请用别的方法。**
 *
 * ## ⚠️ 它解决不了「needle 选错了字符串」
 *
 * `sourceHas` 只解决「注释里的也算」。如果一个断言原本命中的就是**注释**（或某个
 * 恰好含有该文本的无关位置），剥注释会让它**变红** —— 那不是这个工具修好了它，
 * 而是它**原本就在看错的字符串**。
 *
 * 实测（2026-10-24）：`"上游滚轮用 Math.exp"` 的 needle 是 `Math.exp(-deltaY`，
 * 它命中的是上游 `:13` 的**文档注释**里引用的公式；真代码在 `:396` 且用的是常量。
 * **换任何剥注释的实现都会让它红。**
 *
 * **所以换成 `sourceHas` 之后必须重跑「注释掉真代码」的变异** ——
 * 逐条确认它会红。仍然绿 = 那条断言的 needle 本身就靠注释或别的位置通过。
 */

/** 剥掉行注释（`//` 开头的整行、以及 ` *` 开头的块注释正文行）。 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      // `//` 整行注释
      if (t.startsWith("//")) return false;
      // 块注释的正文行：`* xxx` 或 `*/`
      if (/^\*(?!\/)/.test(t) || t === "*/") return false;
      return true;
    })
    .join("\n");
}

/** 剥掉成对的块注释与 JSX 注释；开头记号前是英文冒号时跳过（防 URL 里的斜杠）。 */
function stripBlockComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    // JSX 注释
    if (ch === "{" && next === "/" && src[i + 2] === "*") {
      const end = src.indexOf("*/}", i);
      if (end !== -1) {
        out += " ".repeat(end + 3 - i);
        i = end + 3;
        continue;
      }
    }
    // 块注释（排除前面是英文冒号的情况）
    if (ch === "/" && next === "*" && src[i - 1] !== ":") {
      const end = src.indexOf("*/", i + 2);
      if (end !== -1) {
        out += " ".repeat(end + 2 - i);
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 去掉源码里的注释，保留其余字符（长度不变，便于定位）。
 *
 * **顺序很重要**：先剥块注释（含 JSX），再按行剥行注释 —— 反过来会把块注释
 * 内部的那些行当独立注释处理，无害但没必要；先剥块能正确处理 JSX 注释里
 * 再出现行注释记号的写法。
 */
export function stripComments(source: string): string {
  return stripLineComments(stripBlockComments(source));
}

/**
 * 源码里**真的**（非注释）包含某段文本吗？
 *
 * **这是替代 `src.includes("...")` 的正确写法。** 用法完全相同，但注释里的不算。
 *
 * 【UI 重建 2026-10-27】**换行统一成 LF 再比。**
 *
 * 这个仓库的源文件在工作区里是 **CRLF**（`core.autocrlf` 打开时的检出形态），
 * 而断言里写的跨行 needle 一律是 `"\n          KEY"` 这种 LF 形态。于是
 * `sourceHas(store, "A,\n          B")` **永远为假** —— 文件里是 `A,\r\n`。
 *
 * 症状特别有迷惑性：断言报「不包含」，但人打开文件一眼就看到那两行是相邻的。
 * 本轮至少三条断言（pane-first-paint / pane-free-grid / 若干跨行类名）栽在这上面。
 *
 * 归一化两边，让「换行风格」不再是判据的一部分 —— 它本来就不是。
 */
export function sourceHas(source: string, needle: string): boolean {
  return stripComments(source).replace(/\r\n/g, "\n").includes(needle.replace(/\r\n/g, "\n"));
}
