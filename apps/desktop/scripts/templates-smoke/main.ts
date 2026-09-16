/**
 * Headless smoke for **模版文件的读取**(`main/templates/read.ts`)。
 *
 * ## 它盯的是哪一件事
 *
 * `.docx` / `.dotx`、`.xlsx` / `.xlsm` / `.xltx`、`.pptx` / `.potx` / `.ppsx`
 * 2026-09-16 起分别走 `kind: "docx"` / `"xlsx"` / `"pptx"` —— 把**原始字节**交给
 * 渲染端,由 `docx-preview` / `@js-preview/excel` / `pptx-preview` 真排出版式。
 *
 * 这条分支有个**很容易被改回去的形状**:它必须排在 `looksBinary(buf)` **之前** ——
 * 这三种都是 ZIP,开头就有 NUL,必然被判成二进制。谁把顺序动一下,它们就悄悄退回
 * 那条"看不了"的路,而**界面上不会有任何报错**(用户只看到一句"这个文件看不了")。
 * 所以这里钉住"读回来的是哪一档,而且真的是那个 ZIP 的字节"。
 *
 * 另一半同样重要:**这三个 kind 不能互相串**。串了不会报错,只会在渲染端换一个库去开
 * 一份它看不懂的文件,症状是一句莫名其妙的报错。
 *
 * ## 夹具为什么要真的
 *
 * 三个夹具都是**真的 OOXML 包**(`[Content_Types].xml` + 关系表 + 各自的正文部件)。
 * 随便拼一段字节同样能过这里的断言,但那样测的就更少了 —— 至少"开头是 PK"这一条
 * 随便什么字节都过。夹具由 `make-fixtures.py` 生成(只用标准库),重造是一条命令。
 *
 * ## 它不验的
 *
 * **渲染本身**(三个库排出来对不对、缩放对不对)不在这里 —— 那要一个真 DOM,
 * 只能手动看。这一层只保证"字节正确地从磁盘到了渲染端",而那正是主进程这一侧的全部
 * 职责。要看渲染,用 `make-deck.py` 造一份真演示稿 —— 那份脚本的文件头写了怎么在
 * 真 Chromium 里把它开出来看一眼(不用装驱动:一个静态页 + 浏览器就够了)。
 *
 * Run: scripts/templates-smoke/run.sh
 */
import { copyFileSync, mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTemplateFile } from "@main/templates/read.js";
import { ensureTemplateDirs, templatesRoot } from "@main/templates/store.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/**
 * 夹具在哪。**由 run.sh 给**,不从 `import.meta.url` 推 —— 这个文件会被 esbuild 打
 * 到临时目录里跑,`import.meta.url` 指的是**那份产物**,不是这份源码,顺着它找只会
 * 在 temp 里翻一个不存在的 `fixtures/`。
 */
const FIXTURES = process.env.MCODE_SMOKE_FIXTURES;
if (!FIXTURES) throw new Error("MCODE_SMOKE_FIXTURES 没设 —— 见 run.sh");
const WORD_ENTRY = "冒烟用的 Word 模版";
const PPT_ENTRY = "冒烟用的 PPT 模版";

ensureTemplateDirs();
const wordDir = join(templatesRoot(), "word", WORD_ENTRY);
const pptDir = join(templatesRoot(), "ppt", PPT_ENTRY);
mkdirSync(wordDir, { recursive: true });
mkdirSync(pptDir, { recursive: true });

copyFileSync(join(FIXTURES, "minimal.docx"), join(wordDir, "minimal.docx"));
copyFileSync(join(FIXTURES, "minimal.docx"), join(wordDir, "minimal.dotx"));
// 表格放进 word 这一档,因为**模版库那五个类目里没有表格** —— 用户手上要留一份
// xlsx 模版,能放的就是文档类这一格。`readTemplateFile` 本身不按类目判扩展名,
// 但夹具应该照着用户真实会摆出来的样子放。
copyFileSync(join(FIXTURES, "minimal.xlsx"), join(wordDir, "minimal.xlsx"));
copyFileSync(join(FIXTURES, "minimal.xlsx"), join(wordDir, "minimal.xlsm"));
copyFileSync(join(FIXTURES, "minimal.pptx"), join(pptDir, "minimal.pptx"));
copyFileSync(join(FIXTURES, "minimal.pptx"), join(pptDir, "minimal.potx"));
copyFileSync(join(FIXTURES, "minimal.pptx"), join(pptDir, "minimal.ppsx"));

/**
 * 一个超过上限的 docx。**不用真的写 33MB** —— `truncate` 出来的是稀疏文件,OS 不会
 * 真的分配那些块,而 `statSync` 报出来的 size 是真的,这正是被测代码看的东西。
 */
const BIG = "huge.docx";
writeFileSync(join(wordDir, BIG), "");
truncateSync(join(wordDir, BIG), 33 * 1024 * 1024);
/** 同一个上限也要在别的格式那一侧生效 —— 它现在是**共用的一句**,但哪天有人把
 *  这三个分支拆开写,这条会立刻红。 */
const BIG_XLSX = "huge.xlsx";
writeFileSync(join(wordDir, BIG_XLSX), "");
truncateSync(join(wordDir, BIG_XLSX), 33 * 1024 * 1024);

console.log("\nWord:给的是原始字节,不是抽出来的文字");
{
  const got = readTemplateFile("word", WORD_ENTRY, "minimal.docx");
  check("★ 走的是 docx 那条分支", got.kind === "docx", got);
  if (got.kind === "docx") {
    // ★ 这条是"顺序"的钉子:docx 是 ZIP,开头就是 `PK`。抽文字那条路给不出这个。
    const head = String.fromCharCode(got.data[0] as number, got.data[1] as number);
    check("★ 拿到的是那个 ZIP 文件的字节(开头是 PK)", head === "PK", {
      head,
      length: got.data.length,
    });
    check("字节数与磁盘上的文件一致", got.data.length === statSync(join(wordDir, "minimal.docx")).size);
    check("大小也报上来了(界面要拿它显示)", got.size > 0, got.size);
  }
}

console.log("\n.dotx 同一条路(Word 模版常存成这个)");
{
  const got = readTemplateFile("word", WORD_ENTRY, "minimal.dotx");
  check("★ 模版后缀也认", got.kind === "docx", got);
}

console.log("\nExcel:同一条路,只是换成表格那一份");
{
  const got = readTemplateFile("word", WORD_ENTRY, "minimal.xlsx");
  check("★ 走的是 xlsx 那条分支", got.kind === "xlsx", got);
  if (got.kind === "xlsx") {
    // ★ 与 docx 同一个钉子:xlsx 也是 ZIP。抽文字那条路给不出这个。
    const head = String.fromCharCode(got.data[0] as number, got.data[1] as number);
    check("★ 拿到的是那个 ZIP 文件的字节(开头是 PK)", head === "PK", {
      head,
      length: got.data.length,
    });
    check("字节数与磁盘上的文件一致", got.data.length === statSync(join(wordDir, "minimal.xlsx")).size);
    check("大小也报上来了(界面要拿它显示)", got.size > 0, got.size);
  }
  // 带宏的那份是**同一个 OOXML 布局**,只是 content-type 不同 —— 它该和 .xlsx 走
  // 同一条路,而不是被打成"看不了"。
  const macro = readTemplateFile("word", WORD_ENTRY, "minimal.xlsm");
  check("★ 带宏的表格(同一个格式)也认", macro.kind === "xlsx", macro);
  // 反过来:两个 kind 不能串。表格读成 docx 的话,渲染端会拿 docx-preview 去开它,
  // 而那个库对着一份工作簿只会报一句看不懂的错。
  check("★ 没有串到 docx 那一档", got.kind !== ("docx" as string), got.kind);
}

console.log("\n超过上限:如实说太大,不硬读");
{
  const got = readTemplateFile("word", WORD_ENTRY, BIG);
  check("★ 走 unsupported 而不是硬塞给渲染端", got.kind === "unsupported", got);
  if (got.kind === "unsupported") {
    check("原因是 tooLarge(不是'看不了')", got.reason === "tooLarge", got.reason);
    check("大小报出来了(那句提示要显示它)", got.size > 32 * 1024 * 1024, got.size);
  }
  // 上限是两种格式**共用**的那一句。分开写的话迟早有一边被漏掉,而漏掉的那一边
  // 会真把 33MB 塞过 IPC。
  const bigXlsx = readTemplateFile("word", WORD_ENTRY, BIG_XLSX);
  check("★ 表格那一侧同样拦得住", bigXlsx.kind === "unsupported", bigXlsx);
  if (bigXlsx.kind === "unsupported") {
    check("原因也是 tooLarge", bigXlsx.reason === "tooLarge", bigXlsx.reason);
  }
}

console.log("\nPPT:第三种,同一条路");
{
  const got = readTemplateFile("ppt", PPT_ENTRY, "minimal.pptx");
  check("★ 走的是 pptx 那条分支", got.kind === "pptx", got);
  if (got.kind === "pptx") {
    // ★ 同一个钉子:pptx 也是 ZIP。
    const head = String.fromCharCode(got.data[0] as number, got.data[1] as number);
    check("★ 拿到的是那个 ZIP 文件的字节(开头是 PK)", head === "PK", {
      head,
      length: got.data.length,
    });
    check("字节数与磁盘上的文件一致", got.data.length === statSync(join(pptDir, "minimal.pptx")).size);
  }
  // 模版 / 放映和普通演示稿是**同一个 OOXML 布局**,只是 content-type 不同 ——
  // 那两个后缀该走同一条路,而不是被打成"看不了"。
  check("★ 模版后缀(.potx)也认", readTemplateFile("ppt", PPT_ENTRY, "minimal.potx").kind === "pptx");
  check("★ 放映后缀(.ppsx)也认", readTemplateFile("ppt", PPT_ENTRY, "minimal.ppsx").kind === "pptx");
}

console.log("\n三种 kind 不许互相串(串了只会在渲染端换一个库去开看不懂的文件)");
{
  const kinds = [
    readTemplateFile("word", WORD_ENTRY, "minimal.docx").kind,
    readTemplateFile("word", WORD_ENTRY, "minimal.xlsx").kind,
    readTemplateFile("ppt", PPT_ENTRY, "minimal.pptx").kind,
  ];
  check("★ 三个各是各的", JSON.stringify(kinds) === JSON.stringify(["docx", "xlsx", "pptx"]), kinds);
}

console.log("\n路径围栏还在(relPath 是不受信输入)");
{
  const threw = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check("模版里没有这个文件 → 拒绝", threw(() => readTemplateFile("word", WORD_ENTRY, "../../../etc/passwd")));
  check("模版本身不存在 → 拒绝", threw(() => readTemplateFile("word", "不存在的模版", "minimal.docx")));
}

// 夹具是我们建出来的,收干净 —— 下一趟跑不该在旧状态上做判断。
rmSync(wordDir, { recursive: true, force: true });
rmSync(pptDir, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);

/* 夹具改哪儿、加哪一种,都在 `make-fixtures.py` 里 —— 跑一遍就重造三个包:
 *
 *   python scripts/templates-smoke/make-fixtures.py
 *
 * 那边的文件头写了每个包为什么是那个形状、以及哪个部件是**判据**不是摆设。 */
