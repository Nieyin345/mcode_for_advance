/**
 * 右栏的 **Excel 渲染** —— 把 `.xlsx` / `.xlsm` / `.xltx` 真排成一张表。
 *
 * ## 和 `DocxPreview` 是同一件事的两半
 *
 * 那边的理由这里逐条成立:在这之前表格走的是 `main/lib/officeText.ts`,把单元格里的
 * 字抠出来当纯文本显示。对**表格模版**那几乎等于没用 —— 模版里要看的就是**版式**:
 * 哪几列、列宽多少、表头怎么合并、数字怎么排、有几张工作表。一串用制表符隔开的字
 * 看不出这些,而用户拿它跟 Excel 里真正打开的样子一比,只会以为预览漏了一大半。
 *
 * ## 为什么这个库
 *
 * `@js-preview/excel`(MIT,**零运行时依赖**)是 `vue-office` 那一套里的 Excel 那一份,
 * 底下是 `x-data-spreadsheet`。选它是因为它**本来就是只读查看器**:库自己就用
 * `mode: "read"` + 隐藏工具栏来建这张表(`lib/index.js` 的 `initSpreadsheet`),
 * 不需要我们去关掉一堆编辑能力。
 *
 * 代价是**它是 canvas 画的**:文字选不中、搜不到(Word 那边是 DOM,所以那边能选)。
 * 换来的是滚动、单元格高亮、底部工作表标签这些交互都是现成的 —— 对一张有几百行的
 * 表来说,那比"能选中文字"更要紧。拖着选一片区域后 Ctrl+C 仍然拿得到值。
 *
 * ## 四条落地的讲究
 *
 * 1. **动态 `import()`。** 这个库 1.7MB,只在真的看表格时才该下载。它的 CSS 也一样 ——
 *    那份 17KB 的样式表只在表格面板里有用,静态 import 会让它永远躺在主样式表里。
 * 2. **自己建 blob URL,而不是把 `ArrayBuffer` 交给它。** 库收到 `ArrayBuffer` 时会
 *    `URL.createObjectURL` 出去,**而且从不 revoke** —— 每看一份表格就漏一份整个文件
 *    (上限 32MB)在内存里。传字符串它就直接用,于是回收的时机归我们:解析一结束就
 *    `revokeObjectURL`。
 * 3. **`destroy()` 必须排在清空容器之前。** 库的 `destroy` 做的是
 *    `container.removeChild(wrapper)` —— 先 `innerHTML = ""` 再 destroy,那个 wrapper
 *    已经不在树上了,`removeChild` 当场抛。
 * 4. **宽度一变,整个重建。** 见下面那一节 —— 这是用户报的那个 bug。
 *
 * ## ⚠️ 宽度一变就得整个重建(2026-09-16 修)
 *
 * 用户报的原话:「excel 的显示最右边的边框跟着左边的一起移动了,正常是右边不动的」。
 *
 * 查下来是这个库的真实行为:它在 `init` 时按**当时的**容器宽把画布尺寸定死
 * (`view.width = wrapper.clientWidth`),之后**再也不跟着变**。它内部那个自我刷新挂的是
 * `MutationObserver`(见 `lib/index.js` 里那个名字就叫 `hack` 的方法)—— 只在属性 /
 * 子节点变化时触发,**容器改尺寸它根本收不到通知**。
 *
 * 于是拖一下右栏就会出现两种症状,用户看到的是第二种:
 *
 * | 面板变 | 画布 | 症状 |
 * |---|---|---|
 * | 变宽 | 仍是旧的窄尺寸 | 右边空一截,纵向滚动条停在**半中间** |
 * | 变窄 | 仍是旧的宽尺寸 | 整张表横向溢出,**连右边框一起被推着走** |
 *
 * 试过"戳一下属性骗它自己重排"——**没用**:那条路只重画,不重新量宽度(实测画布尺寸
 * 一动不动)。所以只能拆了重建:destroy → 清空 → init → 重新喂字节。
 *
 * 代价是**重新解析一遍文件**,所以防抖 250ms(拖边框会连发几十次尺寸变化)。重建期间
 * **不改 `phase`** —— 一张表在那儿反复闪转圈比空白一下更难受。
 *
 * ## 尺寸
 *
 * 库把表格自己的高度设成 `wrapper.clientHeight`(`.vue-office-excel` 在它自己的 CSS
 * 里是 `height: 100%`),所以**这一格必须有确定的高度** —— 外层给的是 `h-full`。
 *
 * ## 开销实测(2026-09-16,一份 19KB / 26 行的表)
 *
 * | 干什么 | 多久 |
 * |---|---|
 * | 第一次打开(解析 + 首次排版) | **约 170ms** |
 * | 宽度变了重建一遍 | **约 85ms** ← 只在你拖完面板之后付一次 |
 * | 重画一帧(`xs.reRender()`) | **约 1.1ms**(最长 2.8) |
 *
 * 最后一行是**排除法用的**:用户报过"预览有点卡顿",很容易猜成"滚动时重画太慢",而它
 * 其实只有 1ms —— 滚动不掉帧。真正花时间的是**打开**和**重建**,所以下面那条防抖才值得
 * 调,而不是去给滚动加节流(那会是个没必要的、还容易改坏的补丁)。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconExternalLink, IconLoader2 } from "@renderer/lib/icons.js";

/** 交给 XHR 的类型标记。库只把它塞进 Blob,XHR 不看这个值,但别写错。 */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 容器宽度变了多少才值得重建。**重建要重新解析一遍文件(实测约 85ms)**,而几个像素
 * 的差别肉眼看不出来 —— 拿它换一次卡顿不划算。累计位移不会被吞掉:比的是"离上次重建
 * 过了多少",不是"和上一帧差多少"。
 */
const RESIZE_EPSILON = 4;

/** 库给我们的那一小撮接口(见它的 `lib/index.d.ts`)。只写用得到的。 */
interface ExcelPreview {
  preview: (src: string | ArrayBuffer | Blob) => Promise<unknown>;
  destroy: () => void;
}

export function XlsxPreview({
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
  /** 与 `DocxPreview` 同一个三态:失败也是一种"不加载了",两件事要分别画。 */
  const [phase, setPhase] = useState<"rendering" | "ready" | "failed">("rendering");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    host.innerHTML = "";
    setFailed(null);
    setPhase("rendering");

    // 这一份表格的实例。收尾时按它拆 —— 拆过一次就不再拆(失败路径和卸载路径都会
    // 走到这儿,而 `destroy()` 调两遍会在第二遍抛)。
    let preview: ExcelPreview | null = null;
    const teardown = (): void => {
      if (!preview) return;
      try {
        preview.destroy();
      } catch {
        // 库内部已经拆过一半了。这里没有别的可做,也不该让它盖住真正的错误。
      }
      preview = null;
    };

    /**
     * 建一遍。**拆旧的、清空、init、喂字节,全在一个函数里** —— 宽度变了要整个重来
     * (见下面那段注释),那条路上拆和建之间不能有别人插进来。
     */
    const build = async (): Promise<void> => {
      const { default: jsPreviewExcel } = await import("@js-preview/excel");
      if (cancelled) return;
      teardown();
      host.innerHTML = "";
      const instance = jsPreviewExcel.init(host, { showContextmenu: false });
      preview = instance;

      // ★ 见文件头第 2 条:自己建、自己销。`finally` 里 revoke 是安全的 ——
      // `preview()` 的 promise 要等 XHR 读完 + 排完版才 resolve,那时 blob 已经用完了。
      // `new Blob([uint8array])` 认的是**视图的字节**(byteOffset / byteLength 都算数),
      // 所以不需要先切片。
      const url = URL.createObjectURL(new Blob([data], { type: XLSX_MIME }));
      try {
        await instance.preview(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    /**
     * 头一遍排完了没有。**重建的判据是它** —— 还在排第一遍时不去插队,让它自己排完;
     * 库那边排到一半被拆会抛得很难看。
     */
    let built = false;
    /** 上一次量到的容器宽。只认宽,不认高。 */
    let lastWidth = -1;

    void (async () => {
      try {
        // 样式表也得先到 —— 没有它这张表画出来是一堆裸 div。
        await import("@js-preview/excel/lib/index.css");
        if (cancelled) return;
        await build();
        if (cancelled) return;
        lastWidth = host.clientWidth;
        built = true;
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        // 库在失败的路径上已经往表里 loadData 过一个空表了,那一份也一起拆掉,
        // 免得"渲染失败"的提示底下还留着一张空网格。
        teardown();
        setFailed(err instanceof Error ? err.message : String(err));
        setPhase("failed");
      }
    })();

    /**
     * ⚠️ **宽度一变就得整个重建。** 这不是讲究,是这个库的真实行为:
     *
     * 它在 `init` 时按当时的容器宽把画布尺寸定死(`view.width = wrapper.clientWidth`),
     * 之后**再也不会跟着变**。它内部那个自我刷新挂的是 `MutationObserver` —— 只在属性 /
     * 子节点变化时触发,**容器改尺寸它根本收不到通知**。
     *
     * 结果是拖一下右栏就会出现:画布比面板窄(右边空一截、纵向滚动条停在半中间)、或者
     * 比面板宽(整张表横向溢出、连右边框一起被推着走)。用户报的正是后者 ——
     * 「最右边的边框跟着左边的一起移动了,正常是右边不动的」。
     *
     * 试过"戳一下属性骗它自己重排",**没用**(那条路只重画不重新量宽度)。所以只能
     * 拆了重建。
     *
     * 代价是重新解析一遍文件(实测 19KB 的表约 **85ms**),所以:
     *
     * - **防抖 320ms**:拖边框会连发几十次尺寸变化,等它停稳再动。
     * - **变化小于 4px 直接忽略**:那么点差别肉眼看不出,而每次重建都要付 85ms。
     *   累计的位移不会被吞掉 —— 比较的是"离上次重建过了多少",不是"和上一帧差多少"。
     * - 重建期间**不改 `phase`**:一张表来回闪转圈比空白一下更难受。
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      // ⚠️ 用观察器给的 `contentRect.width`,**不要在这里读 `host.clientWidth`**:
      // 拖动面板时布局是脏的,读它等于每帧强制一次同步布局 —— 在一个装着 Monaco、
      // 画布、大 DOM 的应用里,那一帧的代价足够让拖动发涩(用户报的正是"拖左边栏也卡")。
      // `contentRect` 是观察器早就算好的,读它不触发任何计算。
      //
      // 真正要用的宽度在下面防抖之后的回调里读一次 —— 那时早就不在拖动了。
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth) < RESIZE_EPSILON) return; // 高度变化也走这条
      lastWidth = width;
      if (!built) return; // 头一遍还没排完,让它自己排完
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          try {
            await build();
            if (cancelled) return;
            lastWidth = host.clientWidth;
          } catch (err) {
            if (cancelled) return;
            teardown();
            setFailed(err instanceof Error ? err.message : String(err));
            setPhase("failed");
          }
        })();
      }, 250);
    });
    observer.observe(host);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      teardown();
      host.innerHTML = "";
    };
  }, [data, relPath]);

  return (
    // `mcode-preview` 见 `styles.css`。这一份是 canvas 画的、本身没有图片,但三个预览
    // 用同一个类名,哪天库里改用 `<img>` 也就自动被兜住了。
    <div className="mcode-preview relative h-full bg-white dark:bg-neutral-900">
      {/* `overflow-hidden` 而不是 `auto`:滚动是表格自己的事(它画的滚动条 + 冻结的
          行号列标),外面再套一层会把那一套错开。 */}
      <div ref={hostRef} className="h-full overflow-hidden" />

      {phase === "failed" && (
        // 与 Word 那边同一句话的两种写法:一份被密码保护、或者用了还没支持的表格特性
        // 真会解不开 —— 那时只说"预览失败"等于把用户堵在这儿。
        <div className="absolute inset-0 flex flex-col items-start gap-2 overflow-auto bg-surface p-3 text-content-muted [font-size:var(--rp-fs-md)]">
          <p>{t("templates.preview.xlsxFailed")}</p>
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
        // 库要下载 + 解析整份工作簿,比 Word 那边还慢一点 —— 这段时间里一片空白
        // 和"坏了"长得一模一样。
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-surface text-[11px] text-content-subtle">
          <IconLoader2 size={12} className="animate-spin" />
          {t("templates.preview.rendering")}
        </div>
      )}
    </div>
  );
}
