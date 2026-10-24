/**
 * O3 —— 六格式的**判据表**（纯数据 + 纯函数，无副作用）。
 *
 * ## 每个格式的判据分三层，缺一不可
 *
 *  1. **页面身份**：这个 target 的 URL 是不是该编辑器页（`file://…/docs/…` 或
 *     `genoffice-app://<kind>/index.html`）。同一进程里同时开着六个子视图，
 *     只按"有个新 target"判会把上一个格式当成这个。
 *  2. **该格式自己的特征 DOM**：`docs: .ProseMirror`、`sheets: #univer-container
 *     canvas`、`slides: .app + canvas`、`pdf: .textLayer`、`markdown: .doc-editor`、
 *     `html: .cm-content`。**空壳页面也「存在」** —— 壳元素齐全但编辑器没挂载是
 *     vendor 页面的正常启动态，光看 `.app` 会假绿。
 *  3. **内容**：夹具的唯一文本必须出现在该格式**自己的**承载面上（docs 的正文、
 *     pdf 的文本层、markdown 编辑区、html 源码、slides 渲染树、sheets 的
 *     状态栏行数回显）。「打开了」和「渲染出来了」是两件事。
 *
 * 第 3 层各格式的"承载面"不同，这是本表存在的理由 —— 不是所有格式都能从 DOM
 * 读到文字：sheets 是 canvas（DOM 里没有单元格值）、slides 是 Konva 画布（文字在
 * 渲染树里）。
 */
import { TOKENS } from "./fixtures.mjs";

/**
 * 判据措辞里出现的"预期文本"。
 *
 * `O3_MUTATE_TOKEN=1` 时全部换成一个**永远不会出现**的串 —— 这是本套件的
 * 「判据恒假」变异：如果内容断言真的挂在夹具内容上，六条 + 恢复那条必须红，
 * 而 A1–A4 这类"环境事实"必须保持绿。正常跑不设这个变量。
 *
 * 为什么变异放在这里而不是改产品：内容断言与被测产品之间只隔这一层常量；
 * 换掉它等价于问「这条断言有没有可能因为别的原因绿」。见 run.sh 的 `--mutate-token`。
 */
const MUTATED = process.env.O3_MUTATE_TOKEN === "1";
export function expected(kind, token) {
  return MUTATED ? `O3-MUTATED-TOKEN-${kind}-NEVER-PRESENT` : token;
}
export function isTokenMutated() {
  return MUTATED;
}

/** 主窗口里构造编辑器 URL 的两条权威形状（与 `genofficeViewFactories.nativeViewsRoot` 的判定同源）。 */
export const CLI_SUFFIXES = {
  packaged: "/genoffice/cli/genoffice.cjs",
  source: "/genoffice/packages/cli/dist/genoffice.cjs",
};

/** 从 capabilities.cli.path 推 docs 页的 file:// URL（与生产面板 `editorPageUrl` 同一算法）。 */
export function docsPageUrl(cliPath) {
  const normalized = cliPath.replace(/\\/g, "/");
  const suffix = normalized.endsWith(CLI_SUFFIXES.packaged) ? CLI_SUFFIXES.packaged
    : normalized.endsWith(CLI_SUFFIXES.source) ? CLI_SUFFIXES.source
    : null;
  if (suffix === null) throw new Error(`capabilities.cli.path 的形状不认识：${cliPath}`);
  const root = normalized.slice(0, -suffix.length);
  const pagePath = `${root}/genoffice/apps/docs/out/renderer/index.html`;
  const encoded = pagePath.split("/").map((part, index) =>
    index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
  return `file:///${encoded}?mode=tab`;
}

/** target URL 是否属于某格式的渲染页。 */
export function targetMatchesKind(url, kind) {
  if (kind === "docs") return /\/genoffice\/apps\/docs\/out\/renderer\/index\.html(\?|$)/.test(url);
  return url.startsWith(`genoffice-app://${kind}/index.html`);
}

/**
 * 各格式的页面在 DOM 里的"挂载完成"标记。docs 用它等**起始屏**（生产面板也是
 * 先看见起始屏再点文件），其余五家用各自的应用壳。
 */
export const READY = {
  docs: "!!document.querySelector('.ProseMirror')",
  sheets: "!!document.querySelector('#univer-container')",
  slides: "!!document.querySelector('.app')",
  pdf: "!!document.querySelector('.app')",
  markdown: "!!document.querySelector('.doc-editor')",
  html: "!!document.querySelector('.cm-editor, .app')",
};

/** 内容断言里该格式的特征 DOM + 夹具文本。`token` 允许传入带后缀的变体（负控/恢复）。 */
export function probeExpression(kind, token) {
  const want = expected(kind, token);
  const T = JSON.stringify(want);
  switch (kind) {
    case "docs":
      return `(() => {
        const pm = document.querySelector('.ProseMirror');
        const text = pm ? (pm.innerText ?? '') : '';
        return {
          ok: !!pm && text.includes(${T}),
          pm: !!pm,
          empty: !!document.querySelector('.doc-p-empty'),
          text: text.slice(0, 200),
        };
      })()`;
    case "sheets":
      // sheets 是 canvas：单元格值不在 DOM 里，**生产页面也没有任何 DOM/桥面能读到
      // 单元格**（实测 2026-10-24：Univer 的 `__univerAPI` 只在 `import.meta.env.DEV`
      // 下挂；公式栏不随选区显示值；名称框只有坐标；`.cm-content` 是 html 页的）。
      // 所以本卡对 sheets 的内容证据分两层，并如实声明边界：
      //   - 这里（DOM 层）：Univer 容器 + 网格 canvas + 名称框 + 状态栏「N 行可用」，
      //     N 必须等于夹具的 2 —— 空工作簿不会出现这一行；
      //   - E1（磁盘层）：产物 CLI `sheet read` 读出该工作的行数据与夹具文本。
      // **这一层不证明"画布上画的正是夹具"**（生产页面没有可读面）；它证明的是
      // 「一个已装入数据的 workbook 被渲染出来了」。见 mutations.mjs 的 M4 边界说明。
      return `(() => {
        const body = document.body?.innerText ?? '';
        const rowLine = body.match(/([0-9]+)\\s*行可用/);
        return {
          ok: !!document.getElementById('univer-container') &&
              !!document.querySelector('#univer-container canvas') &&
              !!document.querySelector('[data-u-comp="defined-name"] input') &&
              rowLine !== null && Number(rowLine[1]) === 2,
          univer: !!document.getElementById('univer-container'),
          canvas: !!document.querySelector('#univer-container canvas'),
          nameBox: document.querySelector('[data-u-comp="defined-name"] input')?.value ?? null,
          rowLine: rowLine ? rowLine[0] : null,
        };
      })()`;
    case "slides":
      // slides 的文字在 Konva 画布上，DOM 读不到。判据 = 应用壳 + 画布 + 缩略图栏
      // + **渲染树里的文本**（`slidesApi.consumePendingOpen()` 返回页面自己那份
      // 会话数据，幂等只读 —— 与 t7 旅程同一条用法）。
      //
      // ⚠️ 渲染树把一段文字拆成**多个 run**（实测 "O3-PPTX-6c0d3e" 被拆成
      // "O3-" / "PPTX-" / "6c0d3e" 三个 `text` 字段，各自带自己的 x 坐标）。
      // 直接对 JSON.stringify(tree) 找整串会**永远找不到** —— 必须按渲染顺序把
      // run 文本拼起来再比。这就是"判据差点写成恒假"的地方。
      return `(async () => {
        let treeJoined = ''; let treeError = null; let treeLength = 0;
        try {
          const tree = await window.slidesApi?.consumePendingOpen?.();
          const parts = [];
          const walk = (v) => {
            if (Array.isArray(v)) { for (const x of v) walk(x); return; }
            if (v && typeof v === 'object') {
              for (const [k, x] of Object.entries(v)) {
                if (k === 'text' && typeof x === 'string') parts.push(x);
                else walk(x);
              }
            }
          };
          walk(tree ?? null);
          treeJoined = parts.join('');
          treeLength = JSON.stringify(tree ?? null).length;
        } catch (e) { treeError = String(e); }
        const thumbs = document.querySelectorAll("[class*='thumb']").length;
        return {
          ok: !!document.querySelector('.app') && !!document.querySelector('canvas') && thumbs > 0 && treeJoined.includes(${T}),
          app: !!document.querySelector('.app'),
          canvas: !!document.querySelector('canvas'),
          thumbs,
          treeHasToken: treeJoined.includes(${T}),
          treeLength, treeText: treeJoined.slice(0, 200), treeError,
        };
      })()`;
    case "pdf":
      // pdf.js 的文本层是**可选择真文本**的证明：页面纹理画在 canvas 上，但
      // `.textLayer span` 只有真的解析出文本才会出现。只数 canvas 会把"渲染了
      // 一张白纸"当成成功。
      return `(() => {
        const spans = [...document.querySelectorAll('.textLayer span')];
        const layer = spans.map((s) => s.textContent ?? '').join('');
        return {
          ok: !!document.querySelector('.app') && spans.length > 0 && layer.includes(${T}),
          app: !!document.querySelector('.app'),
          spans: spans.length,
          pages: document.querySelectorAll('.pdf-page, .page').length,
          layer: layer.slice(0, 200),
        };
      })()`;
    case "markdown":
      return `(() => {
        const ed = document.querySelector('.doc-editor');
        const text = ed ? (ed.innerText ?? '') : '';
        return {
          ok: !!ed && text.includes(${T}),
          editor: !!ed,
          proseMirror: !!ed && ed.classList.contains('ProseMirror'),
          text: text.slice(0, 200),
        };
      })()`;
    case "html":
      // html 页默认可视化预览、源码面板隐藏；`.cm-content` 的 textContent 仍是
      // CodeMirror model 的真值（不依赖可见性）。
      return `(() => {
        const cm = document.querySelector('.cm-content');
        const text = cm ? (cm.textContent ?? '') : '';
        return {
          ok: !!cm && text.includes(${T}),
          cm: !!cm,
          app: !!document.querySelector('.app'),
          text: text.slice(0, 240),
        };
      })()`;
    default:
      throw new Error(`未知格式：${kind}`);
  }
}

/** 给人看的判据一句话（失败时拼进 FAIL 行）。 */
export const SIGNATURE = {
  docs: ".ProseMirror 正文里有夹具文本",
  sheets: "#univer-container 的网格 canvas + 名称框 + 「N 行可用」",
  slides: ".app + canvas + 缩略图 + 渲染树里的夹具文本",
  pdf: ".textLayer span 里有夹具文本",
  markdown: ".doc-editor（Tiptap）里有夹具文本",
  html: ".cm-content 源码里有夹具文本",
};

export const KIND_ORDER = ["docs", "sheets", "slides", "pdf", "markdown", "html"];

export { TOKENS };
