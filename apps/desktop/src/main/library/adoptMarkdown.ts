/**
 * 用户手上已经有转录好的 Markdown 时,直接**采纳**它,不再跑一遍转录。
 *
 * ## 为什么需要这条路
 *
 * 转录(MinerU / 本地 pdf.js)是要花额度的,而且**同一份 PDF 的结果可能不如用户
 * 自己手上那份**:他可能早就用 MinerU 网页版转过、或者拿别人的高质量转录。这时候
 * 唯一的诉求是"把我这份挂上去" —— 重转一遍既浪费额度,还会**覆盖掉他更满意的那份**。
 *
 * ## 图片会一起搬
 *
 * MinerU 的产物是 `full.md` **加一个 `images/` 目录**,正文里全是 `![](images/x.jpg)`。
 * 只搬那个 md 的话,预览里全是断图 —— 用户会以为"导入坏了"。所以这里连**同级的
 * `images/` 目录**一起复制,相对路径自然成立。
 *
 * ## 落点按条目 id,不按内容哈希
 *
 * 与笔记同一个理由(见 `paths.ts` 的 `notePathForId`):用户手上的 md 可能还会再改、
 * 再替换一次。按 id 命名,替换就是覆盖同一个位置,引用和缓存都不用重算。
 */
import { basename, dirname, extname, join } from "node:path";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { ensureLibraryDirs, libraryRoot, toLibraryRelative } from "./paths.js";

export interface AdoptResult {
  ok: boolean;
  error?: string;
  /** 落盘后的库内相对路径(与 `LibraryRepo.setMarkdown` 收到的一致)。 */
  relPath: string;
  /** 一起搬过来的图片张数(0 = 这份 md 里没有配图,是正常的)。 */
  imageCount: number;
}

/** 采纳的产物落点:`<库根>/markdown/imported/<条目 id>/`。 */
function importedDirForId(id: string): string {
  return join(libraryRoot(), "markdown", "imported", id);
}

/** 数一数目录里的图片文件(只用于回报,不做筛选逻辑)。 */
function countImages(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name));
      else if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(entry.name)) n += 1;
    }
  };
  try {
    walk(dir);
  } catch {
    /* 读不动就算了 —— 图片计数只是回报 */
  }
  return n;
}

export function adoptMarkdownFile(itemId: string, sourcePath: string): AdoptResult {
  const fail = (error: string): AdoptResult => ({ ok: false, error, relPath: "", imageCount: 0 });

  const item = LibraryRepo.get(itemId);
  if (!item) return fail("找不到这篇文献");
  if (item.kind === "note") return fail("笔记本身就是 Markdown,不需要再挂转录产物");

  const ext = extname(sourcePath).toLowerCase();
  if (![".md", ".markdown"].includes(ext)) return fail(`不是 Markdown 文件(${ext || "无扩展名"})`);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) return fail("文件不存在");

  const destDir = importedDirForId(itemId);
  try {
    ensureLibraryDirs();
    // 整目录替换:上一次采纳的文件不该和这一次混在一起(否则旧的 images/ 会留下,
    // md 里若引用了同名图就会取到旧图 —— 那比报错更难查)
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });

    const fileName = basename(sourcePath);
    cpSync(sourcePath, join(destDir, fileName));

    // 同级的 images/ 一起搬 —— MinerU 的正文靠它
    let imageCount = 0;
    const sourceImages = join(dirname(sourcePath), "images");
    if (existsSync(sourceImages)) {
      cpSync(sourceImages, join(destDir, "images"), { recursive: true });
      imageCount = countImages(join(destDir, "images"));
    }

    const relPath = toLibraryRelative(join(destDir, fileName));
    LibraryRepo.setMarkdown(itemId, relPath);
    log.info(`library: adopted markdown for ${itemId} from ${sourcePath} (${imageCount} images)`);
    return { ok: true, relPath, imageCount };
  } catch (err) {
    return fail(`复制失败:${(err as Error).message}`);
  }
}
