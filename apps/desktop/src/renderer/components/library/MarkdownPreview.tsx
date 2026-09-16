/**
 * 右栏:文献原文(Markdown)预览。
 *
 * ## 为什么要有它
 *
 * 用户的原话:「md 预览得把这个预览集成到软件里面,现在是直接跳转打开的 vscode」。
 * 跳出去看确实能看,但看文献是**在库里翻东西**的连续动作 —— 每看一篇就跳一次编辑器、
 * 还要自己找文件在哪、看完再切回来,这条路把动作打断了。所以预览必须在面板里。
 *
 * ## 图片为什么是「先内联再渲染」
 *
 * md 里写的是 `![](images/1.jpg)` 这种**相对路径**,渲染进程读不了本地文件,
 * `<img src="images/1.jpg">` 只会得到一张裂图。而渲染端偏偏**不能**把相对路径解析
 * 成绝对路径 —— 它不知道这份 md 在哪。
 *
 * 所以主进程把被引用到的图片一并读成 data URL 交出来(`library.readMarkdown`),
 * 这里在**渲染前**把正文里的引用替换掉。这样 `<Markdown>` 收到的就已经是自包含的
 * 文本,不需要它去碰文件系统,也就不用为"库目录不在项目根内"去放宽任何文件读取围栏。
 *
 * 没能内联的本地引用(不存在、太大、越界)**就地标出来**,而不是留个裂图或者悄悄
 * 少一张 —— 用户看到 `［图片未内联:images/7.jpg］` 才知道发生了什么。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { IconFolderOpen, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";

/**
 * 把正文里的相对图片引用换成人已经读好的 data URL;没内联成的换一句话说明。
 *
 * ## 必须**一遍扫过**(这里曾经把渲染进程卡死)
 *
 * 上一版是"对每一张图做一次全文字符串替换"(`out.split(ref).join(dataUrl)`)——
 * 那是 **O(图片数 × 正文长度)**。教材那种几千张图配一兆正文,就是几十亿次字符操作,
 * 打开预览直接卡死(用户报的正是这个)。现在改成:一遍正则扫出所有 `![]()` 的地址,
 * 查表决定换成什么 —— 与图片数量成线性,和正文长度也只是一遍。
 */
function inlineImages(markdown: string, images: Record<string, string>, skipped: string[]): string {
  if (Object.keys(images).length === 0 && skipped.length === 0) return markdown;
  const skippedSet = new Set(skipped);
  /**
   * 跳过的图**多到什么程度**,决定怎么标:
   *   - 少数几张:逐张就地标出「图片未内联:xxx」—— 用户想知道是哪几张;
   *   - 成百上千张(教材常见):逐张标会**把正文淹掉**(一个几百页的扫描版教材能有三四千
   *     张图)。这时整张丢掉,数量由上方那条提示统一交代 —— 反正也不会有人去读三千条
   *     "未内联"。
   */
  const quietSkip = skipped.length > 20;
  // 一次扫完 markdown 里所有图片的地址(`![alt](dest)` 与 `<img src="dest">` 两种写法)
  return markdown.replace(
    /(!\[[^\]]*\]\()([^)\s]+)(\))|(<img[^>]+src=["'])([^"']+)(["'])/gi,
    (whole, pre: string, dest: string, post: string, pre2?: string, dest2?: string, post2?: string) => {
      const ref = dest ?? dest2 ?? "";
      const url = images[ref];
      if (url) return `${pre ?? pre2 ?? ""}${url}${post ?? post2 ?? ""}`;
      if (skippedSet.has(ref)) {
        return quietSkip ? "" : `${pre ?? pre2 ?? ""}（图片未内联:${ref}）${post ?? post2 ?? ""}`;
      }
      // 远程图或本来就没内联的 —— 原样留着
      return whole;
    },
  );
}

/** 一段大约多少字符。6000 字 ≈ 一两屏 —— 首屏快,滚动时也感觉不到停顿。 */
const CHUNK_CHARS = 6000;
/** 首屏渲染几段;之后每次追加几段。 */
const INITIAL_CHUNKS = 2;
const CHUNKS_PER_STEP = 2;

/**
 * 把正文切成段 —— **只在顶层块边界(空行)切**,而且**不在围栏代码块里切**。
 *
 * 为什么必须绕开围栏:代码块里的空行是代码的一部分,在那儿切会把一段代码劈成两半,
 * 两半都会渲染错(甚至吃掉后面的内容)。所以走一遍行、记住是否在围栏内,只在
 * "不在围栏里 + 已经攒够长度 + 空行"三个条件同时满足时下刀。
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
  // 全空白的段没有渲染价值,顺手丢掉
  return out.filter((c) => c.trim().length > 0);
}

interface PreviewData {
  markdown: string;
  dir: string;
  fileName: string;
  images: Record<string, string>;
  skipped: string[];
}

export function MarkdownPreview({ item }: { item: LibraryItem }) {
  const { t } = useI18n();
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 重转完成后要能重新读一次 —— 否则用户看到的是转换前的旧正文。 */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    // async IIFE 而不是直接挂 .then:手机端的 web shim 对没有映射的命名空间是
    // **同步抛错**的,直接把异常甩出 effect 会让 React 19 整棵卸载(见 webApi.ts)
    void (async () => {
      try {
        const res = await api.library.readMarkdown({ id: item.id });
        if (cancelled) return;
        if (!res.ok) setError(res.error ?? t("library.preview.failed"));
        else {
          setData({
            markdown: res.markdown,
            dir: res.dir,
            fileName: res.fileName,
            images: res.images,
            skipped: res.skipped,
          });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.mdPath, nonce]);

  /** 图片已内联好的**完整**正文;分段在下面做。 */
  const body = useMemo(
    () => (data ? inlineImages(data.markdown, data.images, data.skipped) : ""),
    [data],
  );
  const chunks = useMemo(() => (body ? splitMarkdownChunks(body) : []), [body]);
  /** 已经渲染了几段。换文档 / 重转后回到首屏那几段。 */
  const [shown, setShown] = useState(INITIAL_CHUNKS);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(INITIAL_CHUNKS);
  }, [item.id, body]);

  // 触底前就开始加载(提前 600px)—— 等滚到了才加载,用户会看到一段空白
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

  const runConvert = async () => {
    setLoading(true);
    try {
      const res = await api.library.convert({ ids: [item.id], force: true });
      if (res.converted === 0 && res.failed[0]) setError(res.failed[0].error);
      else setNonce((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 还没有转换产物 —— 这是最常见的一种"空",要给出去哪儿转的明确指路
  if (!item.mdPath && !loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-xs text-content-muted">{t("library.preview.noMarkdown")}</span>
        <button
          onClick={() => void runConvert()}
          disabled={!item.pdfPath}
          className="inline-flex items-center gap-1 rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          <IconRefresh size={12} />
          {t("library.convert.run")}
        </button>
        {!item.pdfPath && (
          <span className="text-[0.7857em] text-content-subtle">
            {t("library.preview.needPdf")}
          </span>
        )}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-xs text-content-subtle">
        <IconLoader2 size={13} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-xs text-red-500">{error}</span>
        <button
          onClick={() => setNonce((n) => n + 1)}
          className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
        >
          {t("library.preview.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 这是哪份文件 —— 用户要能对得上磁盘上的东西 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-1.5">
        <span className="shrink-0 font-mono text-[0.7857em] text-content-muted">
          {data?.fileName}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[0.7143em] text-content-subtle"
          title={data?.dir}
        >
          {data?.dir}
        </span>
        {data && Object.keys(data.images).length > 0 && (
          <span className="shrink-0 text-[0.7143em] tabular-nums text-content-subtle">
            {t("library.preview.imageCount", { n: Object.keys(data.images).length })}
          </span>
        )}
        <button
          onClick={() => void api.library.revealFile({ id: item.id, which: "md" })}
          title={t("library.convert.revealMd")}
          className="shrink-0 rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconFolderOpen size={12} />
        </button>
      </div>

      {data && data.skipped.length > 0 && (
        <div className="shrink-0 border-b border-edge bg-amber-500/10 px-3 py-1 text-[0.7143em] text-amber-600 dark:text-amber-400">
          {data.skipped.length > 20
            ? t("library.preview.skippedMany", { n: data.skipped.length })
            : t("library.preview.skipped", { n: data.skipped.length })}
        </div>
      )}

      {/* 逐段渲染:只有滚到附近的段才会真的进 DOM(顺带省下未滚动图片的解码) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {chunks.slice(0, shown).map((chunk, i) => (
          <Markdown key={`${item.id}-${i}`}>{chunk}</Markdown>
        ))}
        {chunks.length > shown && (
          <div ref={sentinelRef} className="py-3 text-center text-[0.7857em] text-content-subtle">
            {t("library.preview.more", { shown, total: chunks.length })}
          </div>
        )}
      </div>
    </div>
  );
}
