/**
 * 应用内 Markdown 预览:把一篇文献的 md 正文 + 它引用的图片一起交给渲染端。
 *
 * ## 为什么必须由主进程读
 *
 * 渲染进程在沙箱里**没有 fs**。而 MinerU 产出的正文里写的是 `![](images/1.jpg)`
 * 这种**相对路径** —— 渲染端连它相对于哪个目录都不知道,更别说读字节了。所以这里
 * 一次把正文与图片(base64 data URL)一起交出去,渲染端不需要二次往返。
 *
 * ## 图片只认 md 同目录子树里的
 *
 * `![]()` 里的路径是从**文件内容**里解析出来的,不是我们拼的。虽然目前的 md 都由
 * MinerU/pdf.js 生成,但把它当**不可信输入**处理是应有的姿态:解析出的绝对路径必须
 * 落在 md 所在目录的内部,越界的一律跳过并计入 `skippedImages`。否则一段构造过的
 * md 就能把机器上任意文件读成 data URL。
 *
 * ## 为什么要报「跳过了几张图」
 *
 * 体积上限会真的筛掉东西(单张 >8MB、合计 >24MB)。**默默少几张图**比明说更糟 ——
 * 用户会以为是转换漏了,跑去重转一遍。所以跳过的张数如实返回,界面上要显示出来。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { LibraryRepo } from "@main/store/repositories.js";
import { fromLibraryRelative } from "./paths.js";
import { log } from "@main/lib/logger.js";

/** 单张图片的上限。超过就不内联 —— base64 之后还要再涨三分之一。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * 全部内联图片的合计上限。
 *
 * 从 24MB 收到 12MB:教材动辄几千张插图,全塞进一次 IPC + 内存里,光是解码就能把渲染
 * 进程拖住(用户报过"点开就卡住")。超出的如实报「未内联」,用户知道少了什么。
 */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** 内联的图片张数上限。4000 张图配一兆正文时,张数才是真正的瓶颈。 */
const MAX_IMAGES = 300;

/** 只把这些扩展名当图片读。`![](paper.pdf)` 这种引用不该被读成图片。 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export interface MarkdownPreview {
  ok: boolean;
  error?: string;
  markdown: string;
  /** md 所在目录(绝对路径)。界面上显示,让用户知道看的是哪份文件。 */
  dir: string;
  fileName: string;
  /** md 里的相对引用 → data URL。键与正文里的写法**逐字一致**,渲染端直接替换。 */
  images: Record<string, string>;
  /** 没能内联的本地引用(不存在 / 过大 / 越界 / 不是图片扩展名)。 */
  skipped: string[];
}

/** 正文明文里出现的所有图片引用(两种写法:`![]()` 和 `<img src>`)。 */
function extractImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) refs.add(m[1]!);
  for (const m of markdown.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) refs.add(m[1]!);
  return [...refs];
}

/** 读一张图并转成 data URL;不该内联就返回 null。 */
function inlineImage(absMdDir: string, ref: string): string | null {
  // 远程图与已经是 data URL 的不用管 —— 渲染端自己就能加载
  if (/^(https?:|data:)/i.test(ref)) return null;
  const mime = IMAGE_MIME[extname(ref).toLowerCase()];
  if (!mime) return null;

  // 百分号编码的路径(MinerU 偶尔给中文文件名做转义)
  let rel = ref;
  try {
    rel = decodeURIComponent(ref);
  } catch {
    /* 不是合法编码就按原文用 */
  }
  // md 里一律是 `/` 分隔,落盘要按平台分隔符拼
  const abs = join(absMdDir, ...rel.split("/"));

  // 越界就跳过 —— md 的内容是数据,不是可信指令
  const root = resolve(absMdDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    log.warn(`library: md image outside its own directory, skipped: ${ref}`);
    return null;
  }
  try {
    if (!existsSync(abs)) return null;
    const size = statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) return null;
    const buf = readFileSync(abs);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 读一篇文献的 Markdown,连同它引用的图片。 */
export function readMarkdownForPreview(itemId: string): MarkdownPreview {
  const empty = (error: string): MarkdownPreview => ({
    ok: false,
    error,
    markdown: "",
    dir: "",
    fileName: "",
    images: {},
    skipped: [],
  });

  const item = LibraryRepo.get(itemId);
  if (!item) return empty("找不到这篇文献");
  if (!item.mdPath) return empty("这篇还没有 Markdown 转换产物");

  const abs = fromLibraryRelative(item.mdPath);
  if (!existsSync(abs)) return empty(`文件不在了:${item.mdPath}`);

  let markdown: string;
  try {
    markdown = readFileSync(abs, "utf8");
  } catch (err) {
    return empty(`读取失败:${(err as Error).message}`);
  }

  const dir = dirname(abs);
  const images: Record<string, string> = {};
  const skipped: string[] = [];
  let total = 0;
  for (const ref of extractImageRefs(markdown)) {
    // 远程图不用内联 —— 渲染端自己加载得动
    if (/^(https?:|data:)/i.test(ref)) continue;
    if (Object.keys(images).length >= MAX_IMAGES || total >= MAX_TOTAL_BYTES) {
      skipped.push(ref);
      continue;
    }
    const dataUrl = inlineImage(dir, ref);
    if (!dataUrl) {
      skipped.push(ref);
      continue;
    }
    images[ref] = dataUrl;
    total += dataUrl.length;
  }

  return {
    ok: true,
    markdown,
    dir,
    fileName: abs.split(/[\\/]/).pop() ?? "full.md",
    images,
    skipped,
  };
}
