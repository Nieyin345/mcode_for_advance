/**
 * 右栏的 **PPT 渲染** —— 把 `.pptx` / `.potx` / `.ppsx` 真排成一摞幻灯片。
 *
 * ## 和 `DocxPreview` / `XlsxPreview` 是同一件事的第三半
 *
 * 在那之前表格和文档都是这个理由,PPT 更是:它走的是 `main/lib/officeText.ts`,
 * 把幻灯片里的文字抠出来当纯文本显示。对一份**演示稿模版**那是最没用的一种呈现 ——
 * 要看的就是**版面**:标题在哪儿、配色是什么、一页里怎么切分、图占多大。一串文字
 * 一个都说不上来。
 *
 * ## 为什么这个库
 *
 * `pptx-preview`(ISC,作者和 `vue-office` 是同一个)把 OOXML 解成 **DOM**,
 * 不是画成图 —— 所以文字**能选中、能搜、能复制**,和 Word 那边一样。它认母版 / 版式 /
 * 主题(这几样才是"模版"的正文),图片转成 data URL,图表走 echarts 画成 SVG。
 *
 * ⚠️ **许可证和另外两个不一样,值得知道**:这个库的**源码是不公开的**(要打赏才给),
 * 只有发布出来的 npm 包可以用。作者的原话是「本项目发布的 npm 包可免费使用,自用商用
 * 均可」,所以**用它是允许的**;但它不是 `docx-preview`(Apache-2.0)那种意义上的开源。
 * 附带的一串依赖里 `echarts` 和 `lodash` 是重的,靠动态 `import()` 挡在包外。
 *
 * ## 四条落地的讲究
 *
 * 1. **动态 `import()`。** 连 echarts 一起不小,只在真的看 PPT 时才该下载。
 * 2. **`mode: "list"`,而且不给它 `height`。** 库有两种模式:`slide` 一次画一页、
 *    带上一页/下一页按钮;`list` 把整摞一次性铺出来。这里要的是后者 —— 模版是**拿去
 *    看全貌**的,一页一页点太慢。
 *
 *    而 `height` **不能传**:传了它就给外壳设一个固定高度 + `overflow-y: auto`
 *    (`_renderWrapper` 里那句 `this.options.height && …`),于是整摞片子被塞进一个
 *    几百像素高的框里**自己再滚一层**,外面还套着面板那一层,两条滚动条互相别着。
 *    不传,外壳就自然长高、滚动交给面板,一份演示稿从头到尾一条滚动条。
 * 3. **`zoom` 缩到面板宽度。** 库把每页的渲染尺寸定成 `options.width`(按 `sldSz`
 *    算好比例),**不会**跟着容器变 —— 所以这里和 Word 那份是同一套:量出外壳的
 *    layout 宽度、按比例缩。`zoom` 而不是 `transform` 的理由见 `DocxPreview.tsx`。
 * 4. **`destroy()` 必须调。** 它自己不做任何 DOM 清理(只发一个事件),但**图表那些
 *    echarts 实例是靠这个事件 dispose 的** —— 不调就每看一份带图的稿子漏一批实例。
 *    外壳的 DOM 我们自己清。
 *
 * ## ⚠️ 它会丢掉字体名,所以预览区的默认字体要对齐 Office(2026-09-16 修)
 *
 * 用户报「ppt 的排版有问题」,查了几轮图片裁剪之后,最后落到**字**上。两件事:
 *
 * **一、这个库不认 `a:latin`。** 源码里取字体名那行是
 * `e.typeface = c(t, ["a:ea", "attrs", "typeface"])` —— **只读 `a:ea`(东亚字体)**。
 * 于是同一页里:中文那行(字体名在 ea 槽)是对的,拉丁文那行(字体名在 `a:latin`)
 * 被整个丢掉,**只能继承容器的字体**。而容器的字体是应用的界面栈(Segoe UI)。
 *
 * **二、界面字体比 Office 换的那个宽。** 用户那份 `EMC.pptx` 的标题写的是 48pt
 * `Inter`,框宽 715px。实测(2026-09-16,Chromium 里真排):
 *
 * | 字体 | 那行字需要多宽 | |
 * |---|---|---|
 * | `Inter`(文件里写的) | 754.7px | ✗ |
 * | Segoe UI(改之前落到的) | 722.7px | ✗ 差 7.7px,就折在这 1% 上 |
 * | Arial | 697.9px | ✓ |
 * | Calibri | 652.8px | ✓ |
 *
 * 折成两行之后,那个文本框只有 65px 高,**第二行正好压到下面的副标题上** —— 这就是
 * 用户说的"排版乱了"。他在 PowerPoint 里看是好的,因为 PowerPoint 缺字体时会按自己的
 * 规则换,换到的是 Calibri(新版 Office 主题的默认字体)。
 *
 * 修法:根元素加 `mcode-pptx`,`styles.css` 里给这一类设一条 `Calibri, "Segoe UI"`。
 * 它只定义"没人指定字体时用什么",**不覆盖显式指定的** —— 库给中文写了行内
 * `font-family`,中文照样用它自己的字体。
 *
 * 教训:**"排版不对"未必是几何算错了。** 前后量过两页的形状坐标(第 3 页 11 个、第 6 页
 * 8 个),和文件里写的**分毫不差**;真正错的是那行字有多宽。下次先量字。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconExternalLink, IconLoader2 } from "@renderer/lib/icons.js";

/**
 * 页面两侧留的空。
 *
 * ⚠️ **用户明确要求过"不要间距"**(2026-09-16):原来这里是 16,片子两侧白让掉一截。
 * 现在只留 **1px**,那不是给人看的,是防浮点 —— 算出来的宽度差半个像素就会冒出横向
 * 滚动条。
 */
const GUTTER = 1;

/**
 * 要出来的画布宽度(逻辑像素)。
 *
 * 这只是"按多少像素去排",不是最终大小 —— 下面 `fit()` 会把它整体缩到面板宽。
 * 库会按 `sldSz` 算出比例,所以 4:3 的稿子排出来是 960×720,不会被拉成 16:9。
 */
const CANVAS_WIDTH = 960;

/** 库自己起的类名,不是我们的(没有第二个来源,所以直接写死在这里)。 */
const WRAPPER_CLASS = "pptx-preview-wrapper";

/** 库给我们的那一小撮接口(见它的 `dist/previewer/PPTXPreviewer.d.ts`)。只写用得到的。 */
interface PptxPreviewer {
  preview: (file: ArrayBuffer) => Promise<unknown>;
  destroy: () => void;
}

export function PptxPreview({
  data,
  relPath,
  onOpenExternal,
}: {
  /** 原始字节(见 `readTemplateFile`)。结构化克隆过来的,不是 data URL。 */
  data: Uint8Array;
  /** 只用来当 React 的依赖键:换成另一个文件要重新渲染一遍。 */
  relPath: string;
  /** 渲染不出来时的出口 —— 文案里要给他一条路,而不是只说"失败了"。 */
  onOpenExternal: () => void;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** 与另外两份同一个三态:失败也是一种"不加载了",两件事要分别画。 */
  const [phase, setPhase] = useState<"rendering" | "ready" | "failed">("rendering");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    host.innerHTML = "";
    setFailed(null);
    setPhase("rendering");

    let previewer: PptxPreviewer | null = null;
    let destroyed = false;
    const teardown = (): void => {
      if (destroyed) return;
      destroyed = true;
      try {
        previewer?.destroy();
      } catch {
        // 库内部已经拆过一半了。这里没有别的可做,也不该让它盖住真正的错误。
      }
      previewer = null;
    };

    /** 把整摞缩到面板宽度。量的是外壳的 layout 宽(`offsetWidth` 不随 zoom 变)。 */
    const fit = (): void => {
      const wrap = host.querySelector<HTMLElement>(`.${WRAPPER_CLASS}`);
      if (!wrap) return;
      const natural = wrap.offsetWidth;
      const avail = host.clientWidth - GUTTER;
      if (!(natural > 0) || !(avail > 0)) return;
      const zoom = String(avail / natural);
      if (wrap.style.zoom !== zoom) wrap.style.zoom = zoom;
    };

    /** 只在**宽**变了的时候重排(理由见 `DocxPreview.tsx`)。 */
    let lastWidth = -1;
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === lastWidth) return;
      lastWidth = host.clientWidth;
      fit();
    });
    observer.observe(host);

    void (async () => {
      try {
        const { init } = await import("pptx-preview");
        if (cancelled) return;

        // ⚠️ 只给 `width`,**不给 `height`** —— 见文件头第 2 条。
        const instance = init(host, { width: CANVAS_WIDTH, mode: "list" });
        previewer = instance;

        // ⚠️ 字节**必须是 offset 0、长度正好**的那一段:`preview()` 收的是裸
        // `ArrayBuffer`,多出几个字节头部它就直接解不开。主进程那边是
        // `new Uint8Array(buf)` 建的(offset 本来就是 0),但那是**另一头**的约定 ——
        // 这里判一下,该复制就复制,别让一个跨进程的约定悄悄失效。
        const file =
          data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
            ? (data.buffer as ArrayBuffer)
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        await instance.preview(file);
        if (cancelled) return;

        // 库给外壳铺的是黑底 —— 它是照"放映"那个场景配的。在浅色面板里,片子之间
        // 的 10px 缝会变成一道道黑条,看着像坏了。它自己那层高度我们没要(见上),
        // 只剩这一处要改。
        const wrap = host.querySelector<HTMLElement>(`.${WRAPPER_CLASS}`);
        if (wrap) wrap.style.background = "transparent";

        lastWidth = host.clientWidth;
        fit();
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        // 失败路径上库可能已经往外壳里铺了半摞,一起拆掉 —— 免得"渲染失败"的提示
        // 底下还留着半页幻灯片。
        teardown();
        setFailed(err instanceof Error ? err.message : String(err));
        setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
      observer.disconnect();
      teardown();
      host.innerHTML = "";
    };
  }, [data, relPath]);

  return (
    // 两个类名都是必要的,一个是给图片、一个是给字:
    //   `mcode-preview` —— styles.css 里那条 `.mcode-preview img { max-width:none }`
    //     靠它生效。少了它,Tailwind 的 preflight 会把库里"大图裁一角"的图片全压变形。
    //   `mcode-pptx` —— styles.css 里那条默认字体。这个库**只读 `a:ea`,不读
    //     `a:latin`**(见文件头),所以拉丁文一律继承容器的字体;不指定的话就是应用的
    //     界面字体(Segoe UI),比 Office 换的 Calibri 宽 4%,够把标题挤成两行。
    <div className="mcode-preview mcode-pptx relative h-full">
      <div
        ref={hostRef}
        // `[scrollbar-gutter:stable]` 的理由与 `DocxPreview.tsx` 里那段一样:留住
        // 纵向滚动条的位置,`clientWidth` 才是定的,缩放才不会来回横跳。
        className="h-full overflow-auto bg-neutral-200/60 dark:bg-neutral-800/60 [scrollbar-gutter:stable]"
      />

      {phase === "failed" && (
        // 见另外两份的同一条:解不开要说清楚,还要给出口。
        <div className="absolute inset-0 flex flex-col items-start gap-2 overflow-auto bg-surface p-3 text-content-muted [font-size:var(--rp-fs-md)]">
          <p>{t("templates.preview.pptxFailed")}</p>
          <p className="min-w-0 break-all text-content-subtle">{failed}</p>
          <button
            onClick={onOpenExternal}
            className="flex items-center gap-1 rounded border border-edge px-2 py-0.5 hover:bg-surface-hover hover:text-content"
          >
            <IconExternalLink size={12} />
            {t("templates.ctx.openExternal")}
          </button>
        </div>
      )}

      {phase === "rendering" && (
        // 一整摞片子铺成 DOM 比 Word 那边慢,而这个库还得把 echarts 一起下下来 ——
        // 这段时间里一片空白和"坏了"长得一模一样。
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-surface text-[11px] text-content-subtle">
          <IconLoader2 size={12} className="animate-spin" />
          {t("templates.preview.rendering")}
        </div>
      )}
    </div>
  );
}
