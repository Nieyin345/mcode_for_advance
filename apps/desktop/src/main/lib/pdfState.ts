/**
 * `PdfState` 的对齐清单 —— **现在只是个转发**,真名单在
 * `@contracts/library` 的 `PDF_STATES`。
 *
 * ## 为什么名单必须只有一份
 *
 * 「这条文献的 PDF 怎么样」原来有**四份**名单,而它们全都漏了 `not_found`:
 *
 *   1. `derivePdfState`(contracts,渲染端算)     —— 把 not_found 折进了 failed
 *   2. `pdfStateClause`(desktop,主进程拼 SQL)   —— switch 里没有这一档,落进
 *      `default: return "1=1"`,也就是**按「找不到来源」筛会返回整个库**
 *   3. `LibraryListFilter.pdfState`(desktop)     —— 手抄的联合类型,漏了
 *   4. `LibraryListSchema.pdfState`(contracts)   —— 手抄的 zod 枚举,漏了
 *
 * 四处漏一处就是一条静默走不通的路。现在 1/3/4 都引用 `PdfState` 或 `PDF_STATES`
 * (zod 那个直接由数组生成),2 的 switch 改成显式列举 + `default` 抛出。
 *
 * 本文件留在 desktop 侧,是因为 `pdf-state-smoke` 要拿它逐档比对 TS 与 SQL 两套
 * 判据;那边不方便直接 import contracts 的实现细节。**别再往这里加第二份名单**。
 */
export { PDF_STATES as PDF_STATE_ORDER } from "@contracts/library";
