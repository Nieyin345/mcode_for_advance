/**
 * template-preview-smoke — `DocxPreview` 把 `docx-preview` 的内嵌图片/字体全部
 * **泄漏成不撤销的 blob URL**(MAINT 检修项:资源泄漏 / 对象 URL 从不释放)。
 *
 * ## 被判的缺陷
 *
 * `docx-preview` 的 `HtmlRenderer.blobToURL` 是这么写的(dist/docx-preview.js):
 *
 *   ```js
 *   if (this._options.useBase64URL) return blobToBase64(blob);
 *   return URL.createObjectURL(blob);
 *   ```
 *
 * `defaultOptions.useBase64URL = false`,而**整个 dist 里 `revokeObjectURL` 出现 0 次**。
 * 于是每遇到一张内嵌图片 / 一个内嵌字体,库就 `URL.createObjectURL(blob)` 一份,却
 * **从不撤销** —— 组件也撤不了,因为库不把那串 URL 交出来。`DocxPreview` 每次换文件
 * 只 `host.innerHTML = ""`(摘掉 DOM),浏览器那份 **blob URL 登记表**一直留着:
 * 一份带图的稿子 = N 个永不释放的 Blob,看一晚上慢慢涨。
 *
 * 同子系统的 `XlsxPreview` 文件头白纸黑字把**同一个库行为**当缺陷处理(自己建 URL、
 * 解析完立刻 `revokeObjectURL`)。`DocxPreview` 这一条没接。
 *
 * ## 修法(组件唯一拿得动的那根杆)
 *
 * 库不交出 URL ⇒ 组件撤不了。但它提供了 `useBase64URL`:为真时图片/字体走 `data:`
 * 内联,压根不创建 blob URL。CSP 已允许 `img-src data:` / `font-src data:`
 * (见 `main/lib/desktopCsp.ts`),所以这是安全且彻底的一条。本套钉住的就是"必须传它"。
 *
 * ## 怎么跑
 *
 * `run.sh` 用 esbuild `--alias:react=` 换掉调度器、`--alias:docx-preview=` 换成复刻
 * 了上面那一支的替身,`prelude.ts` 把 `URL.createObjectURL/revokeObjectURL` 换成记账器。
 * 断言 = 渲染一份"带内嵌图片"的文档后,**创建了几个 blob URL、还剩几个没撤**。
 *
 * Run: scripts/template-preview-smoke/run.sh
 */
import { blobLog } from "./prelude.js";
import { __mount, __flush } from "./fakeReact.js";
import { renderCalls } from "./stubs/docxPreview.js";
import { DocxPreview } from "@renderer/components/templates/DocxPreview.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function reset(): void {
  blobLog.reset();
  renderCalls.length = 0;
}

// ── 1. 一份带内嵌图片的 docx:不许留下没撤销的 blob URL ────────────────────
console.log("\n[1] DocxPreview 渲染后不留活着的 blob URL");
{
  reset();
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // 假的 docx 字节,替身不看内容
  const openExternal = (): void => {};
  __mount(() => DocxPreview({ data: bytes, relPath: "report.docx", onOpenExternal: openExternal }));
  // 让 effect 里的动态 import + renderAsync 都落地。
  await __flush();

  check("渲染确实走到了 docx-preview(renderAsync 被调用一次)", renderCalls.length === 1, renderCalls.length);
  const live = blobLog.live();
  check(
    "内嵌图片没有留下未撤销的 blob URL(组件应传 useBase64URL: true)",
    live.length === 0,
    live,
  );
}

// ── 2. 换文件重渲染:旧文件留下的 blob URL 也不许攒着 ─────────────────────
console.log("\n[2] 切换文件重渲染后同样不留活着的 blob URL");
{
  reset();
  const openExternal = (): void => {};
  // 字节提到外面 —— 每次渲染新建 `new Uint8Array(...)` 会让 effect 的依赖身份变新、
  // 触发无谓的重跑(那是夹具的错,不是被测代码的)。
  const bytesA = new Uint8Array([1]);
  const bytesB = new Uint8Array([2]);
  __mount(() => DocxPreview({ data: bytesA, relPath: "a.docx", onOpenExternal: openExternal }));
  await __flush();
  __mount(() => DocxPreview({ data: bytesB, relPath: "b.docx", onOpenExternal: openExternal }));
  await __flush();
  const live = blobLog.live();
  check("两次渲染后仍无未撤销的 blob URL", live.length === 0, live);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
