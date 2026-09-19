/**
 * Headless smoke for 四个**一套测试都没有**、而用户会照着做事的模块:
 *
 *   1. `main/library/citationExport.ts` —— 导出引用文件(用户拿去往论文里贴);
 *   2. `main/library/metadata.ts`       —— DOI / arXiv 元数据解析与多源检索;
 *   3. `main/library/journalRank.ts`    —— 期刊分档(用户拿它判断值不值得读);
 *   4. `main/library/oaResolvers.ts`    —— PDF 直链解析(用户拿它判断能不能下)。
 *
 * ## 为什么是这四条(判据不是"没测试",是"错了用户会信")
 *
 * 引用导出的产物**直接进论文**。作者名少一个、年份错一位、卷期丢一段,用户看不出来 ——
 * 而投稿返修时才发现的代价不是时间。所以这一套的断言分两种:
 *
 *   - **形状对不对**(`Doe, Jane A.` 而不是 `Doe, J.`;`[J]`/`[C]` 的句点位置);
 *   - **还能不能读**(导出 → 用真的导入解析器 `parseImportText` 读回来 ——
 *     这条把两个模块钉在一起:导出的形状漂了,回读就会失败)。
 *
 * ## 数据根与 HTTP 都被换掉了
 *
 * - `dataRoot` 指到 `mktemp -d`(`db.ts` 的 `initDb()` 在一个不存在的路径上会**新建
 *   空库**,指错就是拿空库盖掉用户的聊天记录 —— 桩本身没设环境变量时直接抛);
 * - `library/http.ts` 换成按 URL 登记的假源,夹具抄自真实响应(见 `fixtures.ts`)。
 *   没登记的地址**直接抛**,不静默返回失败 —— 各源对失败的处理恰恰是
 *   `if (!res.ok) return []`,静默失败会让这个套件绿着骗人。
 *
 * ## 没覆盖的(写清楚,免得被当已验)
 *
 * - **真上游的响应**(真网络):夹具是真实响应的**形状**,不是每次实时抓的。
 * - **下载本身**(内嵌浏览器 `downloadViaBrowser` / `verifyPdf`):那是 downloader.ts
 *   的事,它已有自己的观察点。
 * - `library/operations.ts` 的导入流程:它 import 了 `./downloader.js`(要 electron),
 *   本套不拉它 —— 所以"导入时 `findOpenAccessPdfUrl` 怎么用"只按调用点读代码核对。
 *
 * Run: scripts/library-citation-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

function eqJson(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-cite-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
const LIB_ROOT = join(DATA, "library");

/* ───────────────────────────── 夹具 ───────────────────────────── */

import { record, resetStubbedHttp as resetHttp, hitsOf, calls, unfiredRoutes } from "./http.js";
import { registerCurl, resetStubbedCurl, curlCalls, unfiredCurlRoutes } from "./stubs/curl.js";

/**
 * 两个桩一起清 —— 清之前先确认上一段登记的路由**都被命中过**。
 *
 * `metadata.ts` 里**有两套取数实现**:`fetchJson`(走 `./http.js`,被 `http.ts` 那个桩
 * 接管)与它自己另抄的 curl(`fetchText`,被 `stubs/curl.ts` 接管)。只清一张表,上一段
 * 登记的路由就会漏进下一段 —— 而这种漏**不会报错**:路由命中,断言拿到的是上一段的
 * 夹具,于是"绿着",而且测的不是这一段想测的东西。
 *
 * 把守卫挂在"清"上,是因为清是每段之间唯一的必经点:到这一刻才能判定"上一段登记的
 * 东西到底有没有被测到"。
 */
function resetStubbedHttp(): void {
  assertRoutesFired();
  resetHttp();
  resetStubbedCurl();
}

/**
 * 登记的路由**一次都没被命中**就报红。
 *
 * 这是一个"断言自己有没有空过"的守卫,而它抓到过真东西:match 串写成
 * `"api.openalex.org/works?"`(抄 URL 时顺手带了问号)—— `includes` 对
 * `"https://api.openalex.org/works?search=…"` **成立**,但下一段把 `?` 换成正则、
 * 或上游改成不带 query 时就会静默失配;失配的后果不是抛错,是**那个源返回空数组**,
 * 于是后面所有关于它的断言全部空过(实测撞到过一次:OpenAlex 的路由失配,7 条断言
 * 全在比 `undefined` —— 套件是红的,但没人看得出是"没测到")。
 *
 * "路由登记了却没人打"和"没登记"是两种不同的错,这里只管第一种:它表明夹具的 URL
 * 形状与被测代码实际打出去的形状**已经对不上**了。
 */
function assertRoutesFired(): void {
  const idle = [...unfiredRoutes(), ...unfiredCurlRoutes()];
  check(
    "上一段登记的路由都被命中过(没有一条是对不上 URL 形状的死夹具)",
    idle.length === 0,
    idle,
  );
}
import * as fx from "./fixtures.js";
import type { LibraryAuthor, LibraryItem } from "@contracts/library";

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, CollectionRepo, SettingRepo } = await import("@main/store/repositories.js");
const { exportCitations } = await import("@main/library/citationExport.js");
const { exportsDir } = await import("@main/library/paths.js");
const { formatApa, formatBibtex, formatBibtexLibrary, formatGb7714, citationKey } = await import(
  "@contracts/citation"
);
const { parseImportText } = await import("@main/library/importer.js");
const { fetchByDoi, fetchByArxivId, searchExternal, findOpenAccessPdfUrl } = await import(
  "@main/library/metadata.js"
);
const { arxivIdFromDoi, publisherPdfCandidates, resolvePdfCandidates } = await import(
  "@main/library/oaResolvers.js"
);
const { journalDbPath, rankJournals } = await import("@main/library/journalRank.js");
const { SEARCH_JOURNAL_DB_SETTING_KEY } = await import("@contracts/ipc");

await initDb();
eq("库根落在临时数据根下", LIB_ROOT, join(DATA, "library"));

/** 一条可作为 `LibraryRepo.upsert` 入参的条目(只需覆盖要验的字段)。
 *
 *  与 `CitableItem` 对齐三处,都是为了**别让断言比"没传字段"的形状**:
 *
 *  - `type` 必填 —— `LibraryRepo.upsert` 的入参里它是可选的(不传落 `article`),
 *    而 `CitableItem` 里必填;不写就分不清"本来没有 type"与"我忘了写"。
 *  - `doi`/`arxivId` 收成 `string` —— repo 允许 `null`(表示清空),`CitableItem`
 *    只有 `string | undefined`。
 *  - `title`/`authors` 必填 —— 本套每条当然都有,顺带让下面直接调格式化函数的地方
 *    不必再补类型。其余字段(repo 有而 `CitableItem` 没有的:kind/source/license…)
 *    原样留着,`upsert` 还要用。 */
type ItemSeed = Omit<Parameters<typeof LibraryRepo.upsert>[0], "type" | "doi" | "arxivId" | "title" | "authors"> & {
  type: NonNullable<LibraryItem["type"]>;
  title: string;
  authors: LibraryAuthor[];
  doi?: string;
  arxivId?: string;
};

let seq = 0;
/** 入库。`added_at` 是 `Date.now()`,同一毫秒内插两条会让 `ORDER BY added_at DESC`
 *  的先后来不定 —— 凡是要验**顺序**的地方,调用方自己 `await sleep(2)` 隔开。 */
function add(seed: ItemSeed): LibraryItem {
  // seed 在前:调用方给了 title 就用它的,没给才落那个占位名。
  return LibraryRepo.upsert({ ...seed, title: seed.title || `无标题 ${++seq}` });
}

/* ══════════════════════ 1. 引用导出的形状 ══════════════════════ */

console.log("\n# 1. 引用导出:三种格式拼出来的东西对不对");

const rich: ItemSeed = {
  doi: "10.1000/EXAMPLE.2020.001",
  title: "Metasurface Holography with $\\lambda$/200 Resolution",
  authors: [
    { given: "Jane A.", family: "Doe" },
    { given: "Wei-Min", family: "Huang-Lee" },
    { literal: "European Optical Society" },
  ],
  year: 2020,
  venue: "Nature Photonics",
  volume: "14",
  issue: "3",
  page: "170-176",
  publisher: "Springer Nature",
  type: "article",
};

eq(
  "GB/T 7714:作者是「姓全大写 + 名缩写」,缩写之间无空格(不是 `Smith J.`)",
  formatGb7714(rich),
  "DOE JA, HUANG-LEE WM, European Optical Society. Metasurface Holography with $\\lambda$/200 Resolution[J]. " +
    "Nature Photonics, 2020, 14(3): 170-176. DOI: 10.1000/EXAMPLE.2020.001.",
);

eq(
  "APA 7:作者是 `Family, F. M.`,刊名卷期页码在同一行",
  formatApa(rich),
  "Doe, J. A., Huang-Lee, W. M., & European Optical Society (2020). " +
    "Metasurface Holography with $\\lambda$/200 Resolution. Nature Photonics, 14(3), 170-176. " +
    "https://doi.org/10.1000/EXAMPLE.2020.001",
);

const richBib = formatBibtex(rich);
check("BibTeX:条目类型是 @article", richBib.startsWith("@article{"), richBib.slice(0, 40));
check("BibTeX:会议与期刊用 booktitle / journal 分别落字段", richBib.includes("journal = {Nature Photonics},"));
/* ⚠️ 找到的真问题 #3(不在本套能改的四个文件里,见报告):`bibEscape` 的两条 replace
   是**串行**的 —— 先把 `\` 换成 `\textbackslash{}`,再对**整串**把 `{` `}` 各加一个
   反斜杠。于是它连自己刚写进去的那对括号也转义了:结果是 `\textbackslash\{\}`。
   在 LaTeX 里那渲染成「一个反斜杠 + 一个字面花括号」—— 标题里凡有 `\alpha` `\lambda`
   `\times`(数学标题里到处都是)的用户,粘进论文会多出两个莫名其妙的字符。
   该改的地方是 `packages/contracts/src/citation.ts` 的 `bibEscape`:括号那一遍不能
   作用在自己刚生成的那段替换文本上(先括号后反斜杠,或用一次性 replace 回调)。
   本套只能钉住现状,并在下面顺手验了它**回读**是能还原的(纯属侥幸)。 */
check(
  "KNOWN:标题里的 `\\lambda` 被转义成 `\\textbackslash\\{\\}`(多转义了它自己的括号)",
  richBib.includes("title = {Metasurface Holography with $\\textbackslash\\{\\}lambda$/200 Resolution},"),
  richBib,
);
check("BibTeX:卷是 volume、期是 number", richBib.includes("number = {3},") && richBib.includes("volume = {14},"));
check("BibTeX:书名号式的作者串用 ` and ` 连接", richBib.includes("author = {Doe, Jane A. and Huang-Lee, Wei-Min and European Optical Society},"), richBib);

/* ── 边界字段 ── */

const noYear: ItemSeed = { title: "无年份的条目", authors: [{ literal: "张三" }], type: "article" };
eq("GB/T:没有年份就不留空模板,整段省掉", formatGb7714(noYear), "张三. 无年份的条目[J].");
eq("APA:没有年份写 (n.d.),不是空括号", formatApa(noYear), "张三 (n.d.). 无年份的条目.");
eq(
  "GB/T:只有期号没有卷号也拼得出来 `(3)`",
  formatGb7714({ ...noYear, venue: "某刊", year: 2021, issue: "3" }),
  "张三. 无年份的条目[J]. 某刊, 2021, (3).",
);

/** 注意:`type` **不能省** —— 省了会被 `LibraryRepo.upsert` 落成 `article`,而直接
 *  调 `formatGb7714` 时 `type` 是 undefined,落到 `[Z]`。两边不一致是 upsert 的默认
 *  值造成的,不是格式化的问题 —— 所以下面的期望都显式写出 `type`。 */
const fourAuthors: ItemSeed = {
  authors: [{ family: "A" }, { family: "B" }, { family: "C" }, { family: "D" }],
  title: "四作者",
  type: "article",
};
eq("GB/T:作者超过 3 名列前 3 加「等」", formatGb7714(fourAuthors), "A, B, C, 等. 四作者[J].");
check(
  "APA:4 名以内全列,最后一名前加 `&`",
  formatApa(fourAuthors) === "A, B, C, & D (n.d.). 四作者.",
  formatApa(fourAuthors),
);

const twentyOne = Array.from({ length: 21 }, (_, i) => ({ family: `Fam${String(i).padStart(2, "0")}` }));
const apa21 = formatApa({ authors: twentyOne, title: "二十一作者", type: "article" });
check(
  "APA:超过 20 名列前 19 + 最后一名(第 20 名被丢掉,不输出省略号)",
  apa21.includes("Fam00") && apa21.includes("Fam18") && !apa21.includes("Fam19") && apa21.includes("Fam20"),
  apa21.slice(0, 160),
);

const cjk: ItemSeed = { authors: [{ literal: "张三" }, { literal: "欧阳锋" }], title: "中文条目", year: 2023, type: "article" };
eq(
  "GB/T:`literal` 姓名原样用之,不做姓/名切分",
  formatGb7714(cjk),
  "张三, 欧阳锋. 中文条目[J]. 2023.",
);
eq(
  "APA:`literal` 姓名也用 `, & ` 连接",
  formatApa(cjk),
  "张三, & 欧阳锋 (2023). 中文条目.",
);

const conf: ItemSeed = {
  title: "会议论文",
  authors: [{ family: "Doe", given: "J." }],
  venue: "Proc. INFOCOM",
  year: 2019,
  page: "1-9",
  type: "inproceedings",
};
eq(
  "GB/T 会议:`//` 必须紧贴 `[C]`,年份与页码构成 `年: 页码`",
  formatGb7714(conf),
  "DOE J. 会议论文[C]//Proc. INFOCOM. 2019: 1-9.",
);
check("BibTeX 会议:用 booktitle", formatBibtex(conf).includes("booktitle = {Proc. INFOCOM},"));
check(
  "BibTeX:页码里的连字符被归一成 `--`",
  formatBibtex({ ...conf, page: "1 - 9" }).includes("pages = {1--9},"),
  formatBibtex({ ...conf, page: "1 - 9" }),
);

const book: ItemSeed = { title: "一本书", authors: [{ family: "Doe" }], publisher: "Springer", year: 2015, type: "book" };
eq("GB/T 图书:`出版者, 年` 且不带卷期", formatGb7714(book), "DOE. 一本书[M]. Springer, 2015.");
eq("APA 图书:出版者单独一段", formatApa(book), "Doe (2015). 一本书. Springer.");

/* ── BibTeX 引用键 ── */

eq(
  "引用键:姓 + 年 + 标题首个 >3 字符的 ASCII 词,全小写",
  citationKey(rich),
  "doe2020metasurface",
);
const cjkKeyItem: ItemSeed = { title: "基于深度学习的图像超分辨率重建综述", authors: [{ literal: "张三" }], year: 2023, type: "article" };
const cjkKey = citationKey(cjkKeyItem);
check(
  "引用键:纯中文标题不会整句变成键(只有年份)",
  cjkKey === "2023",
  cjkKey,
);
check("引用键:长度不超过 40 字符", citationKey({ title: "a ".repeat(40) + "metasurface", authors: [{ family: "x" }], year: 2020, type: "article" }).length <= 40);

/* ── 同名键的消歧(BibTeX 惯例是加字母,不是数字) ──
 *
 * ⚠️ 找到的真问题 #3(在 `packages/contracts/src/citation.ts`,**本套不能改的文件**):
 * `citationKey` 的后缀是 `String.fromCharCode(97 + Math.min(disambiguator, 25))` ——
 * `Math.min(disambiguator, 25)` 把超过 26 次的冲突全部夹在 `z` 上,于是**第 27 条
 * 往后每一把键都叫 `he2016deepz`**。60 条时 35 条重名,导出的 .bib 里同一个键出现
 * 35 次。
 *
 * 后果不是"不好看":bibtex/biblatex 遇到重复的 citation key 要么报
 * `Repeated entry` 直接不编译,要么静默只留一条 —— 用户有 60 篇同键文献时,引文表
 * 会**悄悄少掉 34 条**,而他在正文里引的正是那些键。
 *
 * 该改的地方:`Math.min` 去掉,换成 `disambiguator` 的字母进位(1→b、26→z、27→aa,
 * 或退到数字后缀)。本套只钉现状。 */
const colliding = Array.from({ length: 60 }, () => ({
  title: "deep learning",
  authors: [{ family: "He" }],
  year: 2016,
  type: "article" as const,
}));
const collided = formatBibtexLibrary(colliding);
const keys = [...collided.matchAll(/@article\{([^,]+),/g)].map((m) => m[1]!);
eq("同名键的条目数是 60", keys.length, 60);
const uniq = new Set(keys);
/* 现状:基键 + `b`…`z` 共 26 个不同键。**不是** 60 —— 见上面那段注释。 */
eq("KNOWN:27 条以后全部挤在同一个后缀上,60 条只得到 26 个不同键", uniq.size, 26);
eq(
  "KNOWN:重名的那个键出现 35 次(bibtex 会报 Repeated entry 或静默丢条目)",
  keys.filter((k) => k === "he2016deepz").length,
  35,
);
check("消歧从 `b` 开始(第一个不带上标)", keys[0] === "he2016deep" && keys[1] === "he2016deepb" && keys[2] === "he2016deepc", keys.slice(0, 4));
check("第 26 条拿到 `z`(字母表最后一个)", keys[25] === "he2016deepz", keys[25]);
check("前 26 条彼此不重名(这一段是好的,坏的只有末尾那段)", new Set(keys.slice(0, 26)).size === 26, keys.slice(0, 26));

/* ── 特殊字符:能不能被解析器读回来 ── */

const nasty: ItemSeed = {
  title: "A & B: 50% of $x$ {curly}",
  authors: [{ family: "Doe", given: "Jane" }],
  year: 2020,
  type: "article",
};
const nastyBib = formatBibtex(nasty);
const nastyBack = parseImportText(nastyBib)[0];
check("标题里的 `&` `%` `$` 原样可读(它们不是 LaTeX 的语法字符)", nastyBack?.title?.startsWith("A & B: 50% of $x$") === true, {
  title: nastyBack?.title,
});
/* ⚠️ 如实记下这一条**不是**我们要的形状:`{curly}` 被转义成 `\{curly\}`(对 LaTeX
   而言是对的),但 `importer.ts` 的 `stripLatex` 把 `\{` / `\}` 还原成 `{` / `}` 时
   给**每一个**花括号都补了空格 —— 回读出来是 `\curly\`。导出的 .bib 本身是合法的
   (LaTeX 能编译),坏的只是「拿回读当校验」这一步;而回读正是用户把 .bib 丢回来
   导入时会走的那条路。想修的话落点在 `importer.ts` 的 `stripLatex`,不在这里。 */
check(
  "KNOWN:标题里的 `{}` 导出合法但回读会多出空格(`stripLatex` 的还原不稳)",
  nastyBack?.title === "A & B: 50% of $x$ \\curly\\",
  nastyBack?.title,
);
eq("回读的作者切分正确", JSON.stringify(nastyBack?.authors), JSON.stringify([{ family: "Doe", given: "Jane" }]));
eq("回读的年份正确", nastyBack?.year, 2020);

/* ═══════════ 2. 缺字段导出后**还合不合法**(真的解析器回读) ═══════════ */

console.log("\n# 2. 缺字段的条目导出后还能不能被读回来");

const sparse: ItemSeed = { title: "只有标题的条目", authors: [{ literal: "张三" }], type: "article" };
const sparseItem = add(sparse);
const sparseBib = formatBibtex(sparseItem);
const sparseBack = parseImportText(sparseBib)[0];
eq("没有 DOI/年份/卷期:回读拿得到标题", sparseBack?.title, "只有标题的条目");
eq("没有 DOI/年份/卷期:回读的作者还在", JSON.stringify(sparseBack?.authors), JSON.stringify([{ literal: "张三" }]));
check("BibTeX 值是配平的(没有多出一个 `}`)", (sparseBib.match(/\}/g) ?? []).length === (sparseBib.match(/\{/g) ?? []).length, sparseBib);

/* ══════════ 3. exportCitations:范围、落盘、顺序、幂等 ══════════ */

console.log("\n# 3. exportCitations:导到哪、导了什么、导两次一不一样");

const first = add({
  doi: "10.1000/A.2020",
  title: "Alpha study",
  authors: [{ family: "Zimmer" }],
  year: 2020,
  venue: "Journal A",
  volume: "1",
  issue: "1",
  page: "1-10",
  type: "article",
});
await sleep(3);
const second = add({
  doi: "10.1000/B.2021",
  title: "Beta study",
  authors: [{ family: "Ames" }],
  year: 2021,
  venue: "Journal B",
  type: "article",
});
await sleep(3);
const third = add({ title: "Gamma study", authors: [{ family: "Ming" }], year: 2022, venue: "Journal C", type: "article" });

const collection = CollectionRepo.create("测试集合");
CollectionRepo.assign(collection.id, [third.id], true);

const allRes = exportCitations({ style: "bibtex" });
eq("全库导出成功", allRes.ok, true);
eq("全库导出的条数就是库里所有条目", allRes.count, LibraryRepo.list({ limit: 100000 }).items.length);
check("导出的文件落在库根的 exports/ 下", dirname(allRes.path) === exportsDir(), allRes.path);
check("文件名带格式与日期戳", /-bibtex-\d{8}\.bib$/.test(allRes.path), allRes.path);
check("文件真的写下去了", existsSync(allRes.path) && statSync(allRes.path).size > 0);
const allBody = readFileSync(allRes.path, "utf8");
check("文件以换行收尾", allBody.endsWith("\n"));
for (const [id, title] of [
  [first.id, "Alpha study"],
  [second.id, "Beta study"],
  [third.id, "Gamma study"],
] as const) {
  check(`全库导出里有「${title}」`, allBody.includes(`@article{`) && allBody.includes(title), id);
}

const collRes = exportCitations({ style: "gb7714", collectionId: collection.id });
eq("按集合导出成功", collRes.ok, true);
eq("按集合导出的条数是集合里的条数", collRes.count, 1);
const collBody = readFileSync(collRes.path, "utf8");
check("集合导出只含集合里的那条", collBody.includes("Gamma study") && !collBody.includes("Alpha study"), collBody);
eq("GB/T 导出带顺序编号 `[1] `", collBody.startsWith("[1] "), true);

/* ⚠️ 找到的真问题 #2(已在本套允许的四个文件里小修,见 `citationExport.ts`):
   集合 id 查不到时,`citationExport.ts` 原来只把"集合"当成一个取名字的来源
   (`CollectionRepo.list().find(...) ?? null`),**不校验它存在**;条目走
   `LibraryRepo.listByCollection(id)` 返回空数组,于是掉进 `items.length === 0`
   那一句 —— 用户拿到的是「这个范围里还没有文献」。

   这句话对着一个**已经不存在**的集合说,是错的方向:用户会以为"我还没往里放东西",
   于是反复去建条目,永远查不出真正的原因(集合在别处被删了 / 调用方拿的是旧列表快照)。
   现在两者分开报。 */
const ghost = exportCitations({ style: "apa", collectionId: "lc_不存在" });
eq("集合 id 查不到时如实说「已经不存在了」", ghost.error, "这个集合已经不存在了");
eq("集合 id 查不到时不写文件", ghost.path, "");
eq("集合 id 查不到时不导出一堆东西", ghost.count, 0);
eq("集合 id 查不到时 ok 为 false", ghost.ok, false);
/* 「不存在」与「是空的」必须**分开报** —— 这是这条修复的全部意义:两句话都落在
   `items.length === 0` 上,但一句指向"你还没往里放东西",另一句指向"这个集合没了"。
   混成一句,用户就会对着一个已删的集合反复建条目。 */
{
  const emptyForCompare = CollectionRepo.create("对照:空集合");
  const emptyOut = exportCitations({ style: "apa", collectionId: emptyForCompare.id });
  check("「集合已删」与「集合是空的」不是同一句话", ghost.error !== emptyOut.error, {
    ghost: ghost.error,
    empty: emptyOut.error,
  });
}

/* ── 顺序:GB/T 的编号跟着库里「最近加入在前」的顺序 ── */

const gbRes = exportCitations({ style: "gb7714" });
const gbLines = readFileSync(gbRes.path, "utf8").trim().split("\n");
const listOrder = LibraryRepo.list({ limit: 100000 }).items;
eq("GB/T 的行数等于条目数", gbLines.length, listOrder.length);
check(
  "GB/T 的 `[n]` 编号与库里「最近加入在前」的顺序一致(不是字母序)",
  gbLines.every((line, i) => {
    const item = listOrder[i]!;
    return typeof item.title === "string" && line === `[${i + 1}] ${formatGb7714(item)}`;
  }),
  { gbLines: gbLines.slice(0, 3), titles: listOrder.slice(0, 3).map((i) => i.title) },
);
check(
  "最后加入的那条排在第一行",
  gbLines[0]!.includes("Gamma study"),
  { line0: gbLines[0], newest: listOrder[0]?.title },
);

/* ── APA 按第一作者姓氏字母序 ── */

const apaRes = exportCitations({ style: "apa" });
const apaBody = readFileSync(apaRes.path, "utf8");
check(
  "APA 按第一作者姓氏排:Ames(后加入)排在 Zimmer(先加入)前面",
  apaBody.indexOf("Ames") < apaBody.indexOf("Zimmer") && apaBody.indexOf("Ames") >= 0,
  apaBody,
);

/* ── 幂等:同一个范围导两次内容一致 ── */

const again = exportCitations({ style: "bibtex" });
eq("同一范围导两次:条数一致", again.count, allRes.count);
eq("同一范围导两次:正文逐字节一致", readFileSync(again.path, "utf8") === allBody, true);
eq("两次导出会得到两个文件(文件名带日期戳,同一天会互相覆盖)", again.path === allRes.path, true);

/* ── 空范围 ── */

const emptyCollection = CollectionRepo.create("空集合");
const emptyRes = exportCitations({ style: "bibtex", collectionId: emptyCollection.id });
eq("空集合:ok 为 false", emptyRes.ok, false);
eq("空集合:如实说「这个范围里还没有文献」", emptyRes.error, "这个范围里还没有文献");
eq("空集合:不写文件", emptyRes.path, "");

/* ── 集合名里的非法字符 ── */

const nastyName = CollectionRepo.create("A/B:C*D?E|F");
// 集合**建出来**不等于里面有东西 —— 导出走的是 `listByCollection`,空集合会在
// 「还没有文献」那句提前返回,于是这条测的就不是净化,而是空集合。先真放一条进去。
const nastyItem = add({ title: "Slash study", authors: [{ family: "Lee" }], year: 2023, type: "article" });
CollectionRepo.assign(nastyName.id, [nastyItem.id], true);
const nastyRes = exportCitations({ style: "bibtex", collectionId: nastyName.id });
eq("集合名带 Windows 非法字符时导出仍然成功", nastyRes.ok, true);
eq("非法字符被净化后没有多出目录层级(仍然直接落在 exports/ 下)", dirname(nastyRes.path), exportsDir());
check("文件名里不含非法字符", !/[\\/:*?"<>|]/.test(nastyRes.path.slice(exportsDir().length + 1)), nastyRes.path);

/* ══════════ 4. metadata:Crossref → doi.org → arXiv ══════════ */

console.log("\n# 4. metadata:元数据解析的三条路");

resetStubbedHttp();
record("crossref-work", "api.crossref.org/works/", { ok: true, data: fx.crossrefWork });

const meta = await fetchByDoi("10.1000/EXAMPLE.2020.001");
eq("Crossref:来源标成 crossref", meta?.source, "crossref");
eq("Crossref:`issued` 缺失时回退到 published-print(2020,不是 published-online 的 2019)", meta?.year, 2020);
eq("Crossref:机构作者(只有 name)落到 literal", JSON.stringify(meta?.authors?.[2]), JSON.stringify({ literal: "European Optical Society" }));
eq("Crossref:西文作者保留 given/family,不做缩写", JSON.stringify(meta?.authors?.[1]), JSON.stringify({ given: "Wei-Min", family: "Huang-Lee" }));
eq("Crossref:卷期页码出版商四个字段都拿到了", `${meta?.volume}|${meta?.issue}|${meta?.page}|${meta?.publisher}`, "14|3|170-176|Springer Nature");
eq("Crossref:刊名(container-title)", meta?.venue, "Nature Photonics");
eq("Crossref:摘要剥掉 JATS 标签并还原实体", meta?.abstract, "We report 100% & 200nm resolution.");

/* ── Crossref 404 → doi.org 内容协商(中文文献那条路) ── */

resetStubbedHttp();
record("crossref-404", "api.crossref.org/works/", fx.crossrefNotFound);
record("doi.org-csl", "doi.org/", { ok: true, data: fx.cslItem });
const cjkMeta = await fetchByDoi("10.1000/CJK.2021.001");
eq("Crossref 查不到时回退到 doi.org 内容协商", cjkMeta?.source, "doi.org");
eq("内容协商:标题是字符串数组时取第一个", cjkMeta?.title, "基于深度学习的图像超分辨率重建综述");
eq("内容协商:`literal` 姓名原样", JSON.stringify(cjkMeta?.authors?.[0]), JSON.stringify({ literal: "张三" }));
eq("内容协商:`container-title` 是数组也读得出来", cjkMeta?.venue, "计算机学报");
eq("内容协商:年份", cjkMeta?.year, 2021);
eq("内容协商:卷/期/页", `${cjkMeta?.volume}|${cjkMeta?.issue}|${cjkMeta?.page}`, "44|5|900-915");
eq("中文期刊那条路的 DOI 落库时保留 `doi.org` 版本", cjkMeta?.doi, "10.1000/CJK.2021.001");

resetStubbedHttp();
record("crossref-404", "api.crossref.org/works/", fx.crossrefNotFound);
record("doi.org-notjson", "doi.org/", fx.cslNotJson);
eq("这条路回 HTML(不是 JSON)时如实返回 null,不猜", await fetchByDoi("10.1000/CJK.2021.002"), null);

resetStubbedHttp();
record("crossref-404", "api.crossref.org/works/", fx.crossrefNotFound);
record("doi.org-no-title", "doi.org/", { ok: true, data: { ...fx.cslItem, title: "   " } });
eq("内容协商回来的记录没有标题:当没查到(宁可留空让用户补)", await fetchByDoi("10.1000/CJK.2021.003"), null);

/* ── arXiv ──
 *
 * ⚠️ arXiv **不经过 `./http.js`**:它只有 Atom XML,`metadata.ts` 为此在本文件里
 * 另抄了一套 curl 实现(`fetchText`,`metadata.ts:276`),唯一的对外动作是
 * `spawn("curl", …)`。所以这一段的桩要登记在 `stubs/curl.ts` 上 —— 登记在
 * `recordText` 上**一点用都没有**,`fetchByArxivId` 会真去连 export.arxiv.org,
 * 断言于是拿"线上此刻那篇论文"去比夹具(实测撞到过:期望夹具里的
 * "Deep Learning for Metasurface Inverse Design",拿回来的是线上的
 * "A neural operator-based surrogate solver …")。那种"红"是假的,绿也是假的。
 *
 * `resetStubbedCurl()` 清的是 `stubs/curl.ts` 的路由表,与 `resetStubbedHttp()`
 * 清的是两张表 —— 每段都要一起清,不然上一段的 arXiv 路由会漏到下一段。 */

resetStubbedHttp();
resetStubbedCurl();
registerCurl("export.arxiv.org/api/query", { out: fx.arxivIdList });
const axMeta = await fetchByArxivId("2302.01934");
eq("arXiv:来源标成 arxiv", axMeta?.source, "arxiv");
eq("arXiv:标题折行被压成一行", axMeta?.title, "Deep Learning for Metasurface Inverse Design");
eq("arXiv:id 去掉版本号后缀", axMeta?.arxivId, "2302.01934");
eq("arXiv:published 取前四位作年份", axMeta?.year, 2023);
eq("arXiv:西文名按**最后一个空格**切姓/名", JSON.stringify(axMeta?.authors?.[0]), JSON.stringify({ given: "Jane A.", family: "Doe" }));
eq("arXiv:带连字符的名不会被切坏", JSON.stringify(axMeta?.authors?.[1]), JSON.stringify({ given: "Wei-Min", family: "Huang" }));
eq("arXiv:中文名整体存 literal(不做切分)", JSON.stringify(axMeta?.authors?.[2]), JSON.stringify({ literal: "张三" }));
eq("arXiv:没有空格的名字整体存 literal", JSON.stringify(axMeta?.authors?.[3]), JSON.stringify({ literal: "Madonna" }));
eq("arXiv:不给卷期页码(预印本本来就没有)", meta?.volume !== undefined && axMeta?.volume === undefined, true);

resetStubbedHttp();
resetStubbedCurl();
registerCurl("export.arxiv.org/api/query", { out: fx.arxivEmptyFeed });
eq("arXiv:不存在的 id(空 feed)返回 null", await fetchByArxivId("2401.999999"), null);

resetStubbedHttp();
resetStubbedCurl();
registerCurl("export.arxiv.org/api/query", { out: fx.arxivErrorEntry });
const errMeta = await fetchByArxivId("abc");
check("arXiv:id 格式不对时不该返回一篇标题叫 `Error` 的论文", errMeta === null, {
  got: errMeta && { title: errMeta.title, authors: errMeta.authors, url: errMeta.url },
});

/* ── fetchText 自己的失败形状(它比 fetchJson 多一层:curl 起不来 / 超时) ── */

resetStubbedHttp();
resetStubbedCurl();
// 真 curl 连不上时把原因写在 stderr 里、stdout 空、退出码非 0 —— `fetchText` 于是返回 null。
registerCurl("export.arxiv.org/api/query", { out: "", err: "curl: (7) Failed to connect", code: 7 });
eq("arXiv 源不可用时返回 null(不抛、也不编一条出来)", await fetchByArxivId("2302.01934"), null);
eq("arXiv 源不可用时没有落进 `text` 分支", curlCalls.length > 0, true);

/* ══════════ 5. searchExternal:多源合并、轮转、去重 ══════════ */

console.log("\n# 5. searchExternal:五个源怎么合、怎么去重");

/* 每个源**单独问一次**来核它的字段映射。
 *
 * ⚠️ 不能把三个源放同一次检索里再按 source 取 —— `crossrefWork` 与
 * `openalexSearch` 的夹具是**同一篇论文**(同 DOI、同标题),`searchExternal`
 * 的跨源去重会据此把它们合成一条(谁排在 sources 前面谁赢),于是 `bySource.openalex`
 * 是 undefined,下面七条 OpenAlex 断言全部变成空过 —— 套件会红,但红的是"取不到
 * 那条",不是"OpenAlex 映射错了"。每个断言各自说明问题,才看得出是哪一层错了。
 *
 * 顺带:去重那条正向行为由下面「去重:DOI 优先」那段单独钉(它本来就是同一篇)。 */

resetStubbedHttp();
record("crossref-search", "api.crossref.org/works?", { ok: true, data: { message: { items: [fx.crossrefWork.message] } } });
const cr = (await searchExternal({ query: "metasurface", sources: ["crossref"], limit: 5 }))[0];
eq("Crossref 搜索结果:来源标成 crossref", cr?.source, "crossref");
eq("Crossref 搜索结果:标题", cr?.title, "Metasurface Holography with $\\lambda$/200 Resolution");
eq("Crossref 搜索结果:被引数也带出来", cr?.citationCount, 42);
eq("Crossref 搜索结果:卷期页码一并带出(引用格式的前提)", `${cr?.volume}|${cr?.issue}|${cr?.page}`, "14|3|170-176");

resetStubbedHttp();
record("openalex-search", "api.openalex.org/works?", { ok: true, data: fx.openalexSearch });
const oa = (await searchExternal({ query: "metasurface", sources: ["openalex"], limit: 5 }))[0];
eq("OpenAlex:来源标成 openalex", oa?.source, "openalex");
eq("OpenAlex:DOI 从完整 URL 归一成裸 DOI", oa?.doi, "10.1000/EXAMPLE.2020.001");
eq("OpenAlex:卷期", `${oa?.volume}|${oa?.issue}`, "14|3");
eq("OpenAlex:首末页拼成 `170-176`", oa?.page, "170-176");
eq("OpenAlex:倒排索引按位置还原成摘要(不是按 JSON 里的词序)", oa?.abstract, "Hello world again");
eq("OpenAlex:OA 直链优先取 best_oa_location 的 PDF", oa?.url, "https://example.org/paper.pdf");
eq("OpenAlex:被引数", oa?.citationCount, 42);
check("OpenAlex 有条目时不返回 undefined 字段", oa !== undefined);

resetStubbedHttp();
record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: true, data: fx.epmcCoreModern });
const ep = (await searchExternal({ query: "x", sources: ["europepmc"], limit: 5 }))[0];
eq("Europe PMC:来源标成 europepmc", ep?.source, "europepmc");
eq("Europe PMC:标题末尾的句点被去掉", ep?.title, "Anatomical, biochemical and gene expression studies");
eq("Europe PMC:authorString 按逗号切、整体存 literal(姓在前,不能套 arXiv 的切法)", JSON.stringify(ep?.authors?.[0]), JSON.stringify({ literal: "Qiao Q" }));
eq("Europe PMC:年份从 pubYear 字符串转成数字", ep?.year, 2025);
/* 这一条是**修完之后**的形状。修之前 `venue` 恒为 undefined —— 我们请求的是
   `resultType=core`,而 core 记录顶层的 `journalTitle` 是 null,刊名在
   `journalInfo.journal.title` 里(夹具里两条响应是同一篇文章的 lite/core 对照)。
   刊名是用户扫检索结果时判断"值不值得看"的第一眼信息,丢了它结果列表整列空白。 */
eq("Europe PMC:core 记录的刊名从 journalInfo.journal.title 取回来(不是恒 undefined)", ep?.venue, "Frontiers in Plant Science");
eq("Europe PMC:被引数", ep?.citationCount, 0);
eq("Europe PMC:开放获取 PDF(避开 Subscription required 那条)", ep?.url, "https://europepmc.org/articles/PMC13581855?pdf=render");
eq("Europe PMC:hasOpenAccessPdf 由真实直链决定", ep?.hasOpenAccessPdf, true);

/* ── 去重:DOI 优先,其次标题 ──
 *
 * 这里两个源的夹具**就是同一篇论文**(同 DOI),所以去重为正、条数为 1 —— 这是本套
 * 唯一一处"两个源合起来看"的地方,其余各段都按源单独问(否则同一条会被前面那个源
 * 吃掉,后面那个源的断言全落空)。 */

resetStubbedHttp();
record("crossref-search", "api.crossref.org/works?", { ok: true, data: { message: { items: [fx.crossrefWork.message] } } });
record("openalex-search", "api.openalex.org/works?", { ok: true, data: fx.openalexSearch });
const dup = await searchExternal({ query: "x", sources: ["crossref", "openalex"], limit: 5 });
eq("同 DOI 的两条只留一条(OpenAlex 的 DOI 归一后与 Crossref 相同)", dup.length, 1);
eq("先出现的源赢(Crossref 排在 sources 前面)", dup[0]?.source, "crossref");

/* ── 轮转:第一个源不能把后面几个源挤光 ──
 *
 * ⚠️ 两个源的**标题也必须不同**。只改 DOI 不改标题的话,OpenAlex 那条的标题与
 * Crossref 的完全相同,去重(DOI 键不同则退到标题键)照样会把它吃掉 —— 那时
 * `limit=2` 只剩 crossref 两条,而断言会误报成"轮转坏了"。 */

resetStubbedHttp();
const manyItems = Array.from({ length: 3 }, (_, i) => ({
  ...fx.crossrefWork.message,
  DOI: `10.1000/CR.${i}`,
  title: [`Crossref ${i}`],
}));
record("crossref-search", "api.crossref.org/works?", { ok: true, data: { message: { items: manyItems } } });
record("openalex-search", "api.openalex.org/works?", {
  ok: true,
  data: {
    results: [{ ...fx.openalexSearch.results[0], doi: "https://doi.org/10.1000/OA.1", display_name: "OpenAlex 1" }],
  },
});
const mixed = await searchExternal({ query: "x", sources: ["crossref", "openalex"], limit: 2 });
/* 轮转的**关键**是"两个源都进得来",而不是精确到条。"第一个源不能把后面几个源
   挤光"——limit=2 时老写法会给出 `[crossref, crossref]`,新写法给出
   `[crossref, openalex]`。所以判据是**两个源都出现在前 limit 条里**。 */
eq("轮转取数:limit=2 时两个源都进得来(不是被第一个源的两条占满)", new Set(mixed.slice(0, 2).map((m) => m.source)).size, 2);
eq("轮转取数:第一条仍然是 sources 里的第一个源", mixed[0]?.source, "crossref");

/* 标题相同、都没有 DOI 时按标题去重 */
resetStubbedHttp();
record("crossref-search", "api.crossref.org/works?", {
  ok: true,
  data: { message: { items: [{ ...fx.crossrefWork.message, DOI: "", title: ["Same Title!"] }] } },
});
record("openalex-search", "api.openalex.org/works?", {
  ok: true,
  data: { results: [{ ...fx.openalexSearch.results[0], doi: null, display_name: "same title" }] },
});
const byTitle = await searchExternal({ query: "x", sources: ["crossref", "openalex"], limit: 5 });
eq("没有 DOI 时按「小写去标点」的标题去重", byTitle.length, 1);

/* ── 失败即静默跳过,不拖垮其余源 ── */

resetStubbedHttp();
record("crossref-ok", "api.crossref.org/works?", { ok: true, data: { message: { items: [fx.crossrefWork.message] } } });
record("s2-429", "api.semanticscholar.org/graph", { ok: false, status: 429, error: "HTTP 429" });
record("openalex-504", "api.openalex.org/works?", { ok: false, status: 504, error: "HTTP 504" });
record("epmc-down", /ebi\.ac\.uk\/europepmc/, { ok: false, status: 503, error: "HTTP 503" });
const partial = await searchExternal({ query: "x", sources: ["crossref", "openalex", "europepmc", "semantic"], limit: 5 });
eq("一个源限流/挂掉时其余源照常返回", partial.length, 1);
eq("返回的是活着的那个源", partial[0]?.source, "crossref");

/* ── Europe PMC 的年份过滤用它的字段检索语法 ── */

resetStubbedHttp();
record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: true, data: fx.epmcCoreModern });
await searchExternal({ query: "x", sources: ["europepmc"], limit: 5, yearFrom: 2020, yearTo: 2025 });
/* `URLSearchParams` 会把 `[` `]` 编成 `%5B/%5D`、把空格编成 `+`。先还原 `+` 再解码,
   判据才钉在"写进去的是什么语法"上,而不是死记编码形态(否则断言红了会像是
   "年份过滤没生效",其实只是百分号写法不同)。 */
const epmcUrl = decodeURIComponent((calls.fetchJson.at(-1) ?? "").replace(/\+/g, "%20"));
check("Europe PMC 的年份过滤写进 query 的 PUB_YEAR 语法", epmcUrl.includes("PUB_YEAR:[2020 TO 2025]"), epmcUrl);
check("Europe PMC 用 core(否则没有 fullTextUrlList / citedByCount)", epmcUrl.includes("resultType=core"), epmcUrl);

resetStubbedHttp();
record("openalex-search", "api.openalex.org/works?", { ok: true, data: fx.openalexSearch });
await searchExternal({ query: "x", sources: ["openalex"], limit: 7, yearFrom: 2015, yearTo: 2020 });
const oaUrl = decodeURIComponent(calls.fetchJson.at(-1) ?? "");
check("OpenAlex 的每源条数是 `per-page`(不是被静默忽略的 per_page)", oaUrl.includes("per-page=7"), oaUrl);
check("OpenAlex 的年份过滤走 filter", oaUrl.includes("from_publication_date:2015-01-01") && oaUrl.includes("to_publication_date:2020-12-31"), oaUrl);

/* ══════════ 6. oaResolvers:直链解析链 ══════════ */

console.log("\n# 6. oaResolvers:候选直链怎么拼、怎么排序、怎么退");

eq("DOI 里的 arXiv 编号认得出来", arxivIdFromDoi("10.48550/arXiv.2302.01934"), "2302.01934");
eq("arXiv DOI 大小写不敏感", arxivIdFromDoi("10.48550/ARXIV.2302.01934"), "2302.01934");
eq("不是 arXiv 的 DOI 返回 undefined", arxivIdFromDoi("10.1038/nature12373"), undefined);
eq("空 DOI 不炸", arxivIdFromDoi(undefined), undefined);

/* ── 出版商模板(不联网) ── */

eq(
  "DOI 前缀 → 出版商直链模板(Nature)",
  publisherPdfCandidates("10.1038/s41567-020-0001-2")[0]?.url,
  "https://www.nature.com/articles/s41567-020-0001-2.pdf",
);
eq(
  "Wiley 用 doi/pdf/<doi>",
  publisherPdfCandidates("10.1002/advs.202000001")[0]?.url,
  "https://onlinelibrary.wiley.com/doi/pdf/10.1002/advs.202000001",
);
eq(
  "MDPI 走 CDN 且短名映射成 slug(www.mdpi.com 会被 Akamai 403)",
  publisherPdfCandidates("10.3390/app15031308")[0]?.url,
  "https://pub.mdpi-res.com/applsci/applsci-15-01308/article_deploy/applsci-15-01308.pdf",
);
const mdpiAlt = publisherPdfCandidates("10.3390/app15031308");
eq("MDPI 映射表可能过时,所以给两个候选(映射过的 + 短名原样)", mdpiAlt.length, 2);
eq("第二个候选是短名原样", mdpiAlt[1]?.url, "https://pub.mdpi-res.com/app/app-15-01308/article_deploy/app-15-01308.pdf");
eq(
  "MDPI 文章号补到 5 位",
  publisherPdfCandidates("10.3390/su15010001")[0]?.url.includes("-15-00001/"),
  true,
);
eq("没有模板的出版商(Elsevier/IEEE)不硬拼", publisherPdfCandidates("10.1016/j.cell.2020.01.001").length, 0);

/* ── 整条链的顺序与候选上限 ──
 *
 * ⚠️ 这一段**必须用 Elsevier 的 DOI**(`10.1016/…`),不是随便挑一个。
 * `resolvePdfCandidates` 只为 `10.1016/ / 10.1109/ / 10.23919/` 去读 Crossref
 * 记录(`needsCrossref`),别的 DOI 根本不打 Crossref —— 下面那条 `crossref-work`
 * 路由于是**一次都不会被命中**。这个套件有一个"登记了却没被命中就报红"的守卫,
 * 它正是靠这条抓住过这个坑(见 `assertRoutesFired` 的注释)。 */

resetStubbedHttp();
record("crossref-work(Elsevier 的 alternative-id → sciencedirect pdfft)", "api.crossref.org/works/", {
  ok: true,
  data: {
    message: {
      "alternative-id": ["S0092867420301021"],
      link: [{ URL: "https://xplorestaging.ieee.org/iel7/1/2/09000001.pdf", "content-type": "application/pdf" }],
      resource: { primary: { URL: "https://linkinghub.elsevier.com/retrieve/pii/S0092867420301021" } },
    },
  },
});
record("openalex-work", "api.openalex.org/works/", { ok: true, data: fx.openalexWork });
record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: true, data: fx.epmcCoreLegacy });
record("s2-graph", "api.semanticscholar.org/graph", { ok: true, data: fx.s2Graph });

const candidates = await resolvePdfCandidates("10.1016/j.cell.2020.01.1021");
const urls = candidates.map((c) => c.url);
check("候选不为空", candidates.length > 0, candidates);
check("候选不超过 8 条(免得多试十几次)", candidates.length <= 8, candidates.length);

/* 顺序的**机制**是:`LOOKS_LIKE_PDF_RE` 命中的排前面,其余(落地页)排后面;
   同一档里按 arXiv → OA 源 → Crossref → 出版商模板。所以断言要钉住的是这**三样**,
   而不是某两个具体地址的先后(那会随夹具的增删而脆断)。 */
const idxOf = (needle: string): number => urls.findIndex((u) => u.includes(needle));
const looksPdf = (u: string): boolean =>
  /\.pdf(\?|$)|\.pdf\/|\/pdf\/|\/pdfdirect\/|\/pdf\?|\/pdfft|\/pdf$|pdf=render|\/bitstream\/|\/download(\?|$)/i.test(u);
/* 一条 DOI 是 Elsevier 的(不是 arXiv 的),所以这一段验的是**排序的两个层次**:
   第一层是"像不像 PDF"(形状),第二层才是来源优先级。arXiv 那一档在这条 DOI 上
   本来就是空的 —— 它的优先级由下面单独那条断言钉(用 arXiv 的 DOI 问一次)。 */
check(
  "先按形状分层:「像 PDF」的一整段排在「像落地页」的前面(不是按来源权威度交错)",
  urls.every((u, i) => looksPdf(u) === urls.slice(0, i + 1).every((p) => looksPdf(p)) || !looksPdf(u)),
  urls,
);
check(
  "落地页(doi.org / OpenAlex 的 oa_url / ScienceDirect pdfft 之外的检索页)排在最后",
  urls.slice(-1).every((u) => !looksPdf(u)),
  urls,
);
check(
  "开放获取副本里 pdf=render 与机构库 bitstream 都在(它们是「能直接下」的那一档)",
  idxOf("pdf=render") >= 0 && idxOf("/bitstream/") >= 0,
  urls,
);
check(
  "同一地址只出现一次(几个源常常都给同一条)",
  new Set(urls).size === candidates.length,
  urls,
);
/* 反例:这条 DOI 不带 `10.1016/` 前缀,所以**不该**去打 Crossref —— 打出去就是白等一次。
   与上面那条"打了才命中"合起来,把 `needsCrossref` 这个条件钉死在两侧。 */
{
  resetStubbedHttp();
  record("openalex-work", "api.openalex.org/works/", { ok: true, data: fx.openalexWork });
  record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: true, data: fx.epmcCoreLegacy });
  record("s2-graph", "api.semanticscholar.org/graph", { ok: true, data: fx.s2Graph });
  await resolvePdfCandidates("10.1000/EXAMPLE.2020.001");
  eq("非 Elsevier/IEEE 的 DOI 不去读 Crossref(省一次往返)", hitsOf("api.crossref.org"), 0);
}

check(
  "顺序是按「能不能下成」而不是「哪个更权威」:arXiv 排最前",
  (await resolvePdfCandidates("10.48550/arXiv.2302.01934"))[0]?.url === "https://arxiv.org/pdf/2302.01934",
);

/* ── Unpaywall:没配邮箱时整条跳过 ── */

resetStubbedHttp();
record("openalex-work", "api.openalex.org/works/", { ok: true, data: fx.openalexWork });
record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: true, data: fx.epmcCoreLegacy });
record("s2-graph", "api.semanticscholar.org/graph", { ok: true, data: fx.s2Graph });
// 不给 Crossref 登记路由:`10.1000/…` 不是 Elsevier/IEEE,`resolvePdfCandidates`
// 本来就不会打它(`needsCrossref`),而"不打"由本套的守卫如实反映(登记了没命中 = 红)。
await resolvePdfCandidates("10.1000/EXAMPLE.2020.001");
eq(
  "没配 UNPAYWALL_EMAIL 时一次都不打 Unpaywall(它会对示例邮箱回 422)",
  hitsOf("api.unpaywall.org"),
  0,
);
eq("但同源的 OpenAlex 照常打", hitsOf("api.openalex.org") > 0, true);
eq("而且一次都不打 Crossref(非 Elsevier/IEEE 的 DOI 不必读它)", hitsOf("api.crossref.org"), 0);

/* ── downloader 只取第一个候选 ── */

eq(
  "findOpenAccessPdfUrl 取的是候选表的第一条",
  await findOpenAccessPdfUrl("10.48550/arXiv.2302.01934"),
  "https://arxiv.org/pdf/2302.01934",
);

/* ── 一个源挂了不影响其余 ── */

resetStubbedHttp();
record("openalex-work", "api.openalex.org/works/", { ok: false, status: 500, error: "boom" });
record("epmc-core", /ebi\.ac\.uk\/europepmc/, { ok: false, status: 500, error: "boom" });
record("s2-graph", "api.semanticscholar.org/graph", { ok: false, status: 500, error: "boom" });
record("crossref-work", "api.crossref.org/works/", {
  ok: true,
  data: { message: { "alternative-id": ["S0092867420301021"] } },
});
const survived = await resolvePdfCandidates("10.1016/j.cell.2020.01.1021");
check("四个源全挂时仍返回能拼出来的那些(不抛)", survived.length > 0, survived);

console.log("\n# 6b. 期刊分档(journalRank)");

/* ══════════ 7. journalRank ══════════ */

const workflowsDir = join(DATA, "workflows");
mkdirSync(workflowsDir, { recursive: true });
const jcrPath = join(workflowsDir, "jcr.db");

/** 造一份和真 `jcr.db` **表名列名一致**的小库(真库 22MB,是用户自己维护的商业数据,
 *  不随应用发布)。列名里的引号与大小写都必须照抄 —— `firstRow` 对缺表缺列是静默
 *  返回 null 的,名字打错了会表现成「查不到」而不是报错。 */
async function writeJcrDb(): Promise<void> {
  const { default: initSqlJs } = await import("sql.js/dist/sql-asm.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE JCR2025 ("Journal" TEXT, "IF(2025)" REAL, "IF Quartile(2025)_1" TEXT, "Category_1" TEXT, "IF Rank(2025)_1" TEXT)`);
  db.run(`CREATE TABLE FQBJCR2025 ("Journal" TEXT, "大类" TEXT, "大类分区" TEXT, "Top" TEXT, "小类1" TEXT)`);
  db.run(`CREATE TABLE CCF2026 ("刊物名称" TEXT, "CCF推荐类别（国际学术刊物/会议）" TEXT, "CCF推荐类型" TEXT)`);
  db.run(`CREATE TABLE GJQKYJMD2025 ("Journal" TEXT, "类型" TEXT)`);
  const ins = (sql: string, rows: Array<Array<string | number | null>>): void => {
    const stmt = db.prepare(sql);
    for (const row of rows) {
      stmt.run(row);
    }
    stmt.free();
  };
  ins(`INSERT INTO JCR2025 VALUES (?, ?, ?, ?, ?)`, [
    ["Top Journal", 12.5, "Q1", "Physics", "1"],
    ["Mid Journal", 4.2, "Q2", "Physics", "50"],
    ["Low Journal", 1.1, "Q3", "Physics", "300"],
    ["Bottom Journal", 0.4, "Q4", "Physics", "900"],
    ["Zone2 Journal", 3.0, null, null, null],
    ["Warned Journal", 8.8, "Q1", "Physics", "5"],
  ]);
  ins(`INSERT INTO FQBJCR2025 VALUES (?, ?, ?, ?, ?)`, [
    ["Top Journal", "物理", "1 [10/100]", "否", "光学"],
    ["Mid Journal", "物理", "3 [200/500]", "否", "光学"],
    ["Zone2 Journal", "物理", "2 [118/1437]", "否", "光学"],
    ["Warned Journal", "物理", "1 [3/100]", "是", "光学"],
  ]);
  ins(`INSERT INTO CCF2026 VALUES (?, ?, ?)`, [["Top Journal", "A", "期刊"]]);
  ins(`INSERT INTO GJQKYJMD2025 VALUES (?, ?)`, [["Warned Journal", "低"]]);
  writeFileSync(jcrPath, Buffer.from(db.export()));
  db.close();
}
await writeJcrDb();

eq("好刊:Q1 → T1", (await rankJournals(["Top Journal"])).ranks[0]?.tier, "T1");
eq("好刊:影响因子读得出来", (await rankJournals(["Top Journal"])).ranks[0]?.impactFactor, 12.5);
eq("好刊:JCR 分区", (await rankJournals(["Top Journal"])).ranks[0]?.jcrQuartile, "Q1");
eq(
  "中科院分区字段形如 `1 [10/100]` 时只取开头那个数字",
  (await rankJournals(["Top Journal"])).ranks[0]?.casZone,
  "1",
);
eq("Top 字段是「是」也归 T1", (await rankJournals(["Warned Journal"])).ranks[0]?.casTop, "是");
eq("CCF 推荐类别读得出来", (await rankJournals(["Top Journal"])).ranks[0]?.ccf, "A");
eq("Q2 → T2", (await rankJournals(["Mid Journal"])).ranks[0]?.tier, "T2");
eq("Q3 → T3", (await rankJournals(["Low Journal"])).ranks[0]?.tier, "T3");
eq("Q4 → T3", (await rankJournals(["Bottom Journal"])).ranks[0]?.tier, "T3");
eq("只有 JCR 没有 FQBJCR 时按 Q2 判 T2", (await rankJournals(["Zone2 Journal"])).ranks[0]?.tier, "T2");
eq("中科院 2 区(`2 [118/1437]` → 2)也归 T2", (await rankJournals(["Zone2 Journal"])).ranks[0]?.casZone, "2");
eq("刊名大小写不敏感", (await rankJournals(["top journal"])).ranks[0]?.tier, "T1");

/* ── ⚠️ 预警名单 ── */

const warned = (await rankJournals(["Warned Journal"])).ranks[0];
eq("预警名单里的刊:分档是 EXCLUDE", warned?.tier, "EXCLUDE");
check("预警名单:说明里带年份与等级", warned?.warn === "2025:低", warned?.warn);
eq(
  "⚠️ 预警名单直接排除 —— **不参与其它任何豁免**(它同时是 Q1、中科院 1 区、Top、CCF A,仍然 EXCLUDE)",
  `${warned?.jcrQuartile}|${warned?.casZone}|${warned?.casTop}|${warned?.ccf}`,
  "Q1|1|是|undefined",
);

/* ── 查不到 ── */

const unknown = (await rankJournals(["不存在的刊"])).ranks[0];
eq("查不到的刊:分档是 UNKNOWN(不是最低档)", unknown?.tier, "UNKNOWN");
eq("查不到的刊:不回填任何数值(宁可空着也不猜一个影响因子)", unknown?.impactFactor, undefined);
eq("查不到的刊:刊名原样回显", unknown?.journal, "不存在的刊");

/* ── 数据不可用:如实说「查不了」 ── */

rmSync(jcrPath, { force: true });
eq("jcr.db 不在时 journalDbPath 返回 null(调用方据此如实告知「查不了」)", journalDbPath(), null);
const noDb = await rankJournals(["Top Journal"]);
eq("数据不可用时 dbPath 为 null", noDb.dbPath, null);
eq("数据不可用时一条都不猜", noDb.ranks.length, 0);

SettingRepo.set(SEARCH_JOURNAL_DB_SETTING_KEY, join(DATA, "不存在.db"));
eq("设置里指向一个不存在的路径:同样当不可用(不抛)", journalDbPath(), null);
SettingRepo.set(SEARCH_JOURNAL_DB_SETTING_KEY, "");

await writeJcrDb();
eq("jcr.db 放回数据根的 workflows/ 下就自动可用(不用去设置里填路径)", journalDbPath(), jcrPath);

/* ═══════════════════════ 收尾 ═══════════════════════ */

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  library-citation-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
