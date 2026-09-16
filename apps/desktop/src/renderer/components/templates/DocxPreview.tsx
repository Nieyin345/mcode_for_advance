/**
 * 右栏的 **Word 渲染** —— 把 `.docx` / `.dotx` 真排出来给人看。
 *
 * ## 为什么不能只抽文字(以及为什么是 2026-09-16 才改)
 *
 * 在这之前 Word 走的是 `main/lib/officeText.ts` 那条路:把 ZIP 里的 XML 文字抠出来,
 * 当纯文本显示。那是**能用**的,但对 Word 模版几乎等于没用 —— 模版里要看的就是
 * **版式**:页边距、标题层级、表格、页眉页脚、分节。一串没有格式的文字看不出这些,
 * 而用户拿它跟 Word 里真正打开的样子一比,只会以为预览漏了一大半。
 *
 * ## 为什么这个库

 * `docx-preview`(Apache-2.0)把 OOXML 解成 DOM,不是画成图 —— 所以文字**能选中、
 * 能搜、能复制**,而这正是读一份稿子最需要的。它认 `.dotx` 是白拿的:那和 `.docx`
 * 是同一个格式(`document.xml` + `styles.xml` + 关系表),只是 content-type 标成模版。
 *
 * ## 三条落地的讲究
 *
 * 1. **动态 `import()`。** 这个库连它带的 jszip 一起,gzip 之后两百来 KB —— 只在真的
 *    看 Word 时才该下载。静态 import 会把它塞进主 bundle,而那一份已经 3.4MB 了。
 * 2. **缩放而不是 `ignoreWidth`。** 右栏只有两三百像素,而一页 A4 是八百多。库有个
 *    `ignoreWidth` 选项能让内容铺满容器宽度 —— **不用它**:那样页边距、表格列宽全都
 *    变成了相对值,而"这一页排得对不对"恰恰是这个预览唯一要说的事。所以按比例缩,
 *    看起来小,但版式是真的。
 * 3. **`zoom` 而不是 `transform`。** `transform: scale` 不改变布局尺寸,缩放之后容器
 *    的滚动高度还是按原始大小算的,底下会空出一大截。`zoom` 在 Chromium 里是**参与
 *    布局**的(Blink 一直这么实现),滚到哪算到哪。
 *
 * ## 量宽度时为什么要用 `getBoundingClientRect`
 *
 * ⚠️ **这一段已经不成立了 —— 见下面「2026-09-16 修的那个 bug」。** 保留下来说明
 * 当初的顾虑:那个 ResizeObserver 盯着容器,而缩放本身会影响"要不要出滚动条",
 * 滚动条一出一没又会改变 `clientWidth` —— 担心那会成一个自己咬自己的环。
 *
 * ## 2026-09-16 修的那个 bug:缩放**一次都没生效过**
 *
 * 用户报的原话是「word 可以看到,但是不能缩放,要跟随预览框的大小缩放」。查下来是
 * 一行选择器:
 *
 * ```ts
 * host.querySelector(".docx-wrapper")   // ← 永远选不中
 * ```
 *
 * 而库给 wrapper 的类名是 **`${className}-wrapper`**,我们传的是
 * `className: "mcode-docx"`,于是真正的类名是 `.mcode-docx-wrapper`。`.docx-wrapper`
 * 只在**不传 className** 时才对(库的默认值是 `"docx"`)—— 两处各写各的字符串,
 * 没有任何东西把它们拴在一起,改一处另一处就静默失效。`fit()` 于是每次都在第一行
 * `return` 掉,页面按 794px 原样画在三百来像素的栏里,只能横向滚。
 *
 * 修法不是把那行字符串改对就完事,而是**只留一个常量**(`DOCX_CLASS`):传进库的那份
 * 和下面选择器用的那份是同一个值,走散在物理上不可能。`scheduler-smoke` 那种"钉子
 * 测试"在这里没用 —— 这要真 DOM 才看得出来,所以只能靠把两处合并成一个来源。
 *
 * ## 量哪两个数(实测过,见下)
 *
 * 「缩到容器宽度」= `zoom = 可用宽 / 页面自然宽`,而**两个量都必须与 zoom 无关**,
 * 否则量的是上一次缩放的结果,会越缩越小:
 *
 * | 量 | 用什么 | 为什么 |
 * |---|---|---|
 * | 页面自然宽 | `section.offsetWidth` | **不随 zoom 变**(实测:zoom 0 → 0.357,它一直报 794) |
 * | wrapper 的左右内边距 | `getComputedStyle(wrap).paddingLeft/Right` | 同样不随 zoom 变(一直报 30px) |
 *
 * 所以**量的时候不要把 `zoom` 清掉**。清掉会让页面先溢出一次:横向滚动条冒出来、
 * `clientWidth` 少 15px,量完再缩回去滚动条又消失 —— 同一个尺寸要来回好几趟才收敛。
 * 不清则一趟到位(容器宽度有变时顶多多跑一次,因为滚动条消失会让 `clientWidth` 变大)。
 *
 * `padding` 那一项不能省:wrapper 是 `display:flex; align-items:center` 加 30px 内边距,
 * 只按页面宽算的话缩完仍然会差 60px,横向滚动条还在。
 *
 * ⚠️ 2026-09-16 之后那 30px 内边距**被我们抹成 0 了**(用户要"纸贴着面板边")。公式
 * 里照样减一次 padding,是因为它得**对库改版免疫** —— 哪天它把内边距换个值、或者又从
 * 别处加回来,量到的就是新的真值,不用再改一遍代码。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconExternalLink, IconLoader2 } from "@renderer/lib/icons.js";

/**
 * 页面两侧留的空。
 *
 * ⚠️ **用户明确要求过"不要间距"**(2026-09-16):原来这里是 16,加上库自己给外壳的
 * 30px 内边距,一页纸两侧白白让掉一截,窄栏里看着尤其明显。现在只留 **1px** ——
 * 那不是给人看的,是防浮点:算出来的宽度差半个像素就会冒出一条横向滚动条。
 * 外壳那 30px 内边距在 `fit()` 里直接抹掉(见下)。
 */
const GUTTER = 1;

/**
 * 给库用的类名。**这是唯一的一份** —— 库拿它拼出 `.mcode-docx-wrapper`(整个灰底
 * 容器)和 `section.mcode-docx`(一张纸),下面 `fit()` 里那两个选择器用的也是它。
 *
 * ⚠️ 别在任何地方再写一遍这几种类名。上面那个 bug 就是这么来的:选择器里写死
 * `.docx-wrapper`、option 里写 `mcode-docx`,两处都"看着对",合起来是空转。
 */
const DOCX_CLASS = "mcode-docx";

export function DocxPreview({
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
  /** 库把生成的 `<style>` 塞进这里。**自己的一个 div 而不是 `document.head`** ——
   *  组件卸载时连样式一起清掉,不然每看一份 Word 就在 head 里攒一段。 */
  const styleHostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * 渲染完了没有。**不叫 `loading`**:失败也是一种"不加载了",而两件事要分别画 ——
   * 一个转圈、一个给出口。三态写全,省得靠 `failed === null` 去反推。
   */
  const [phase, setPhase] = useState<"rendering" | "ready" | "failed">("rendering");

  useEffect(() => {
    const host = hostRef.current;
    const styleHost = styleHostRef.current;
    if (!host || !styleHost) return undefined;

    let cancelled = false;
    host.innerHTML = "";
    styleHost.innerHTML = "";
    setFailed(null);
    setPhase("rendering");

    /**
     * 把纸缩到容器宽度(**两个方向都缩**:栏窄了就变小,栏拉宽了就变大 —— 用户要的
     * 是"跟随预览框的大小")。量哪两个数、为什么不先清 zoom,见文件头。
     */
    const fit = (): void => {
      const wrap = host.querySelector<HTMLElement>(`.${DOCX_CLASS}-wrapper`);
      const page = host.querySelector<HTMLElement>(`section.${DOCX_CLASS}`);
      if (!wrap || !page) return;
      // 文档没声明页面尺寸时(没有 sectPr 的那种),纸宽本来就是"容器有多宽就多宽",
      // 不需要缩 —— 硬套下面的公式反而会把它按 wrapper 内边距缩小一圈。
      if (!page.style.width) return;

      // 库给外壳铺的是 30px 内边距(它那个灰色的"桌面")。用户要的是纸贴着面板边,
      // 所以抹掉 —— 留着的话缩完两侧还是各让掉 30×zoom 一截。
      if (wrap.style.padding !== "0px") wrap.style.padding = "0px";

      const style = getComputedStyle(wrap);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const natural = page.offsetWidth + padX;
      const avail = host.clientWidth - GUTTER;
      if (!(natural > 0) || !(avail > 0)) return;

      const zoom = String(avail / natural);
      if (wrap.style.zoom !== zoom) wrap.style.zoom = zoom;
    };

    /**
     * 只在**宽**变了的时候重排。高度变化(内容变长、滚动条出没)不该触发 —— 而重排
     * 自己会改高度,那就是一个自己咬自己的环。
     */
    let lastWidth = -1;
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === lastWidth) return;
      lastWidth = host.clientWidth;
      fit();
    });
    observer.observe(host);

    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(data, host, styleHost, {
          className: DOCX_CLASS,
          // 一页一页分开摆(而不是连成一长条)—— 分页线本身是版式的一部分。
          inWrapper: true,
          breakPages: true,
          // Word 存的是"上次渲染到这儿断的页",那是**编辑时**的缓存。认它会在缩放 /
          // 换机之后断在奇怪的地方,所以交给库按页面设置自己算。
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          // 页边距 / 页面尺寸要真的按文档里写的来 —— 见文件头第 2 条。
          ignoreWidth: false,
          ignoreHeight: false,
        });
        if (cancelled) return;
        // 先记下当前的宽再排:不然下面 `fit()` 里那次 `clientWidth` 读到的会是
        // 排完之后的值,而 observer 那边又会把它当成"没变"而跳过第一次重排。
        lastWidth = host.clientWidth;
        fit();
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setFailed(err instanceof Error ? err.message : String(err));
        setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
      observer.disconnect();
      // 两份都要清:正文那份不摘掉的话,下一个文件是在旧内容上**接着追加**。
      host.innerHTML = "";
      styleHost.innerHTML = "";
    };
  }, [data, relPath]);

  return (
    // `mcode-preview` 见 `styles.css`:Word 文档里的图片同样是按**原始尺寸**摆的,
    // 不能让全局那条 `img { max-width:100% }` 压它。
    <div className="mcode-preview relative h-full">
      {/* 生成样式的落脚处。`hidden` 只是不占地方 —— `<style>` 本来就是全局生效的, */
      /* 挂在哪儿不影响它管不管用,只影响它什么时候跟着卸载一起消失。 */}
      <div ref={styleHostRef} className="hidden" />

      <div
        ref={hostRef}
        // `[scrollbar-gutter:stable]`:纵向滚动条的位置**永远留着**。不留的话,
        // `clientWidth` 会随"这一版的缩放有没有高到需要滚动条"而变,而缩放本身又决定
        // 高度 —— 文档高度恰好落在视口边上时会来回横跳(量宽 → 缩小 → 不再需要滚动条
        // → 变宽 → 放大 → 又需要滚动条 …)。留住了宽就是定的,一趟到位。
        // 代价是右边多一条 8px 的空隙(全应用的滚动条宽度见 styles.css),看不出来。
        className="h-full overflow-auto bg-neutral-200/60 dark:bg-neutral-800/60 [scrollbar-gutter:stable]"
      />

      {phase === "failed" && (
        // **渲染不了要说清楚,还要给出口。** 一份用新版 Word 存的、或者带宏的文档
        // 真会解不开 —— 那时只说"预览失败"等于把用户堵在这儿,而他要的只是看一眼。
        <div className="absolute inset-0 flex flex-col items-start gap-2 overflow-auto bg-surface p-3 text-content-muted [font-size:var(--rp-fs-md)]">
          <p>{t("templates.preview.docxFailed")}</p>
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
        // 首帧占位。库要下载 + 解析,一份几页的稿子大约几百毫秒 —— 这段时间里一片
        // 空白和"坏了"长得一模一样。
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[11px] text-content-subtle">
          <IconLoader2 size={12} className="animate-spin" />
          {t("templates.preview.rendering")}
        </div>
      )}
    </div>
  );
}
