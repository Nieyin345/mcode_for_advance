/**
 * 把正文里的 **HTML 表格**转成 GFM 管道表格。
 *
 * ## 为什么需要这一步
 *
 * 外部转录工具(把论文转成 Markdown 的那一类)输出表格时,给的常常是
 * HTML(`<table><tr><td>…`),不是管道表格。而
 * react-markdown 默认**不渲染 HTML**:remark-rehype 在没有 `allowDangerousHtml` 时
 * 会把 `html` 节点**整个丢掉** —— 于是表格凭空消失,看起来就像"表格显示不出来"。
 *
 * 三条路里选了这条:
 *   - 开 `rehype-raw` 直接渲染 HTML:等于让 PDF/模型产出的任意 HTML 进 DOM,得再引
 *     `rehype-sanitize`,而它的默认白名单**会连 KaTeX 的 style 一起删掉**(公式排版
 *     全靠那些 style,见 `rehypeStyleObjects` 的说明)—— 两处会打架。
 *   - 在 mdast 层拼表格节点:要自己造 `tableRow`/`tableCell`,单元格里的 `$x_1$`
 *     还得递归解析一次才认得出来。
 *   - **转成管道表格文本**(本文件):剩下的链路完全不用动 —— remark-gfm 本来就
 *     认管道表格,单元格里的行内公式也照常解析,因为那就只是普通的 markdown 文本。
 *
 * ## 只在正文里替换
 *
 * 按围栏代码块切分后再替换。否则一篇**讲 HTML 的笔记**里那段示例代码会被就地改写 ——
 * 那是最典型的"好心帮倒忙"。
 *
 * ## colspan 的处理
 *
 * 管道表格没有合并单元格。跨列的那一行会按**最大列数**补齐成空格子(论文里跨列的
 * 多半是"Scenario 1"这种小标题行),信息不丢,只是不再横跨整行。
 */

/** 围栏代码块切分:返回若干段,标出哪几段是代码(代码段不参与替换)。 */
function splitFences(markdown: string): Array<{ text: string; fence: boolean }> {
  const out: Array<{ text: string; fence: boolean }> = [];
  let buf: string[] = [];
  let inFence = false;
  // 起始围栏的**字符**与**长度**都要记住 —— 收尾围栏必须同字符且不短于起始
  // (CommonMark 规则)。只记字符、收尾时 `startsWith(字符×3)` 是不够的:一个用
  // ```` 开的外层块(里面演示 ``` 代码)会被内层那个 ``` **提前收尾**,于是夹在
  // 中间的 `<table>` 落到围栏外、被就地改写成管道表格 —— 正是本文件最想避免的
  // "把讲 HTML 的示例代码改掉"。
  let markerChar = "";
  let markerLen = 0;
  const flush = (): void => {
    if (buf.length > 0) out.push({ text: buf.join("\n"), fence: inFence });
    buf = [];
  };
  for (const line of markdown.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!inFence) {
        flush();
        inFence = true;
        markerChar = m[1]![0]!;
        markerLen = m[1]!.length;
      } else if (line.trimStart().startsWith(markerChar.repeat(markerLen))) {
        buf.push(line);
        flush();
        inFence = false;
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** 单元格文本:折叠空白、转义管道符(`|` 在表格里是分隔符)。 */
function cellText(el: Element): string {
  return (el.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

/** 一个 `<table>` 元素 → 管道表格文本;没有可用行时返回 null。 */
function tableToPipe(table: Element): string | null {
  const rows = [...table.querySelectorAll("tr")]
    .map((tr) => [...tr.querySelectorAll("th,td")].map(cellText))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return null;

  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => [...r, ...Array<string>(cols - r.length).fill("")];

  // GFM 必须有表头行。HTML 表格未必有 <th>,那就把第一行当表头 —— 这是通行做法,
  // 也保住了"第一行是列名"的常见排版。
  const header = pad(rows[0]!);
  const body = rows.slice(1).map(pad);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/**
 * 正文里的 `<table>…</table>` → 管道表格。解析用 **DOMParser**:它是原生实现,
 * 而且解析出来的文档是**惰性**的(不执行脚本、不加载图片),拿来做"读表格结构"很合适。
 * 解析不出表格的残片(比如被截断的 `<table` 开头)**整段丢掉** —— 总比把标签当正文
 * 显示出来强。
 */
export function convertHtmlTables(markdown: string): string {
  if (!/<table/i.test(markdown)) return markdown;

  const convert = (text: string): string =>
    text.replace(/<table[\s\S]*?<\/table>/gi, (block) => {
      try {
        const doc = new DOMParser().parseFromString(block, "text/html");
        const table = doc.querySelector("table");
        return table ? (tableToPipe(table) ?? "") : "";
      } catch {
        // 解析器都抛了:这段没法救,去掉而不是留一堆标签
        return "";
      }
    });

  return splitFences(markdown)
    .map((seg) => (seg.fence ? seg.text : convert(seg.text)))
    .join("\n");
}
