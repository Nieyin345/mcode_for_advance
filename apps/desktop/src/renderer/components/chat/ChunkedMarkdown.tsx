/**
 * 长 md 的**滚动加载**渲染器 —— 只渲染看到哪儿附近的那几段。
 *
 * ## 它替掉的是什么
 *
 * 三处 md 渲染点（中间栏预览、右栏扫一眼、资料库正文）从前都是**整篇**塞进一个
 * `<Markdown>`：一篇几百段的长文，打开的一瞬间全部解析 + 全部进 DOM。用户的原话：
 *
 *   「现在的 md 是直接全部加载的，改成滚动加载，看到哪里就提前加载那附近的几页」
 *
 * ## 这套逻辑仓库里**早就写过一份** —— 但它是个孤儿
 *
 * 原先 `library/MarkdownPreview.tsx` 里有一份完整的「按空行切段 + IntersectionObserver
 * 追加」实现，注释齐全、还专门处理了围栏代码块。**可是全仓没有任何地方 import 它**
 * （grep 只搜到它自己、一个同名的 `MarkdownPreviewPane`、和一句指向它的注释）——
 * 那份实现**从来没在界面上跑过**。
 *
 * 所以这里不是重写，是把它搬到真正在用的那三个点上（硬规矩 2：共享实现只有一份），
 * 搬完就把那份孤儿删了 —— 留着它，下一个人还会再写第三遍。
 *
 * ## 怎么切
 *
 * 只在**顶层块边界**（空行）切，而且**不在围栏代码块里切** —— 代码块里的空行是
 * 代码的一部分，在那儿下刀会把一段代码劈成两半，两半都会渲染错（甚至吃掉后面的
 * 内容）。所以先走一遍行、记住是否在围栏内。
 *
 * `Markdown` 是 `memo` 的，所以没进 DOM 的那些段连解析都不会发生 —— 省的不只是
 * DOM，还有 react-markdown + rehype-katex 那一遍。这正是分块的意义。
 *
 * ## 容器：两个档，按调用方有没有滚动区来选
 *
 *  - `scroll="self"`（默认）—— 调用方**只给尺寸**（`h-full` 或 `min-h-0 flex-1`，
 *    加在 `className` 里），滚动交给这一层。
 *  - `scroll="parent"` —— 调用方已有滚动区（比如右栏那个 `h-full overflow-y-auto`），
 *    这一层只出内容，不多包一层。
 *
 * ⚠️ **这一层的滚动容器不能套在别人的滚动容器里。**
 *
 * 三种接法各量过一遍（`self` 独立、`parent` 接外层滚动区、以及故意套错的
 * `self + h-full` 塞进滚动父级）：
 *
 *  - `self`（FileViewer 那条）：10/10，一路加载到第 400 段。
 *  - `parent`（右栏 `FilePreview`、中间栏预览那条）：10/10。
 *  - **`self + h-full` 塞进滚动父级：卡在首屏。** 父级 `scrollHeight === clientHeight`
 *    —— 它自己**没东西可滚了**（内容全被儿子那根条接管），于是"滚这个面板"什么都不会
 *    发生；真正能滚的是里面那根条。用户看到的现象是**滑不动**，而不是"文章就这么长"。
 *    实测：滚父级 20 次，停在 82 个标题（= 首屏那 2 段）。
 *
 * 所以：**调用方有滚动区就给 `parent`，没有就让这一层自己滚（`self`，且只给尺寸、
 * 不给它 `h-full` 之类的高度约束）**。两边都别想同时滚 —— 那正是上面第三种。
 *
 * （量的时候还会看到"两个可滚动的盒子"，那是**代码块自己**的 `max-height:360px`，
 * 每个代码块一根，与这里无关。）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { Markdown } from "./Markdown.js";

/** 一段大约多少字符。6000 字 ≈ 一两屏 —— 首屏快，滚动时也感觉不到停顿。 */
const CHUNK_CHARS = 6000;
/** 首屏渲染几段；之后每次追加几段。 */
const INITIAL_CHUNKS = 2;
const CHUNKS_PER_STEP = 2;

/**
 * 纯文本的段数上限。
 *
 * ## 为什么纯文本反而要封顶
 *
 * 按段落切，围栏代码块**内部**不切 —— 一篇 200KB 的源码或日志（没有空行分段）
 * 于是只有**一段**。那一段照样整篇解析，滚动加载对它一点用没有。
 *
 * 所以超过这个量且**切不出足够多段**时，改用"在离下一段尽量近的那个换行处硬切"
 * 兜底。切在换行上、不切在围栏内，所以对代码块是安全的（代码行的中间不会被劈开）。
 *
 * 只有这种极端文件会走到这一步 —— 普通论文的 md 段落多得很，用的是上面那条块边界。
 */
const PLAIN_TEXT_MAX = 40_000;

/** 一段大约多少字符（硬切兜底用）。 */
const PLAIN_TARGET = 8_000;

/**
 * 把正文切成段 —— **只在顶层块边界（空行）切**，而且**不在围栏代码块里切**。
 *
 * 为什么必须绕开围栏：代码块里的空行是代码的一部分，在那儿切会把一段代码劈成两半，
 * 两半都会渲染错（甚至吃掉后面的内容）。所以走一遍行、记住是否在围栏内，只在
 * 「不在围栏里 + 已经攒够长度 + 空行」三个条件同时满足时下刀。
 */
function splitMarkdownChunks(md: string, target = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let size = 0;
  let inFence = false;
  let marker = "";
  for (const line of md.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        marker = fence[1]![0]!;
      } else if (line.trimStart().startsWith(marker.repeat(3))) {
        inFence = false;
      }
    }
    buf.push(line);
    size += line.length + 1;
    if (!inFence && size >= target && line.trim() === "") {
      out.push(buf.join("\n"));
      buf = [];
      size = 0;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  // 全空白的段没有渲染价值，顺手丢掉
  return out.filter((c) => c.trim().length > 0);
}

/**
 * 长**纯文本**的兜底切法（见 `PLAIN_TEXT_MAX`）。
 *
 * 优先在空行切；没有空行可切就在**换行**上切；一行都没有（真·一整坨）才硬切。
 * 切点在换行处，所以围栏代码块的行不会被劈开。
 */
function splitPlainChunks(md: string, target = PLAIN_TARGET): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  let buf: string[] = [];
  let size = 0;
  /** 上一次见到的空行下标（相对 `buf`）；这一段攒够时优先退到那里下刀。 */
  let lastBlank = -1;
  for (const line of lines) {
    buf.push(line);
    size += line.length + 1;
    if (line.trim() === "") lastBlank = buf.length;
    if (size >= target) {
      const cut = lastBlank > 0 ? lastBlank : buf.length;
      out.push(buf.slice(0, cut).join("\n"));
      buf = buf.slice(cut);
      size = buf.reduce((n, l) => n + l.length + 1, 0);
      lastBlank = -1;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out.filter((c) => c.trim().length > 0);
}

export function ChunkedMarkdown({
  text,
  projectPath,
  baseDir,
  skillNames,
  scroll = "self",
  className,
  /** 换文档时回到首屏 —— 同一个文件重转之后也靠它（内容换了但组件不重建）。 */
  resetKey,
}: {
  text: string;
  projectPath?: string | null;
  baseDir?: string | null;
  skillNames?: string[];
  scroll?: "self" | "parent";
  className?: string;
  resetKey?: unknown;
}) {
  const { t } = useI18n();

  const chunks = useMemo(() => {
    const byBlock = splitMarkdownChunks(text);
    // 没切出几段、正文又长 —— 走硬切兜底，否则"滚动加载"对它形同虚设
    if (byBlock.length <= INITIAL_CHUNKS && text.length > PLAIN_TEXT_MAX) {
      const plain = splitPlainChunks(text);
      if (plain.length > byBlock.length) return plain;
    }
    return byBlock;
  }, [text]);

  /** 已经渲染了几段。换文档 / 重转后回到首屏那几段。 */
  const [shown, setShown] = useState(INITIAL_CHUNKS);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(INITIAL_CHUNKS);
  }, [resetKey, text]);

  // 触底前就开始加载（提前 600px）—— 等滚到了才加载，用户会看到一段空白
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= chunks.length) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown((n) => Math.min(n + CHUNKS_PER_STEP, chunks.length));
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [chunks, shown]);

  const body = (
    <>
      {chunks.slice(0, shown).map((chunk, i) => (
        <Markdown key={i} projectPath={projectPath} baseDir={baseDir} skillNames={skillNames}>
          {chunk}
        </Markdown>
      ))}
      {chunks.length > shown && (
        <div ref={sentinelRef} className="py-3 text-center text-[0.7857em] text-content-subtle">
          {t("library.preview.more", { shown, total: chunks.length })}
        </div>
      )}
    </>
  );

  // `self` 自己带滚动容器；`parent` 只出内容（见文件头那段"容器只有一个"）
  return scroll === "self" ? (
    <div className={cn("overflow-y-auto", className)}>{body}</div>
  ) : (
    <div className={className}>{body}</div>
  );
}
