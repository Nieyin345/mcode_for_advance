/**
 * 用户手上已经有转录好的 Markdown 时,直接**采纳**它,不再跑一遍转录。
 *
 * ## 为什么需要这条路
 *
 * 转录是要花额度的(时间、钱、或者你自己那套工具的次数),而且**同一份 PDF 的结果
 * 可能不如用户自己手上那份**:他可能早就用网页版转过、或者拿别人的高质量转录。这时候
 * 唯一的诉求是"把我这份挂上去" —— 重转一遍既浪费,还会**覆盖掉他更满意的那份**。
 *
 * ## 配图**按引用搬**,不按目录名认
 *
 * 转录产物一般是 `full.md` 加一个装图的目录,正文里全是 `![](images/x.jpg)`。
 * 只搬那个 md 的话预览里全是断图 —— 用户会以为"导入坏了"。
 *
 * ⚠️ **早先这里写死了同级的 `images/`。** 那是个形状假设:只有从前内置的那套转录
 * 产物的目录恰好叫 `images`。用户换成自己的工具(图放 `figures/`、`assets/`、或者按章节分在
 * `ch1/`、`ch2/` 里)时,图**静默丢掉** —— 界面不报错,只是预览全裂。而"软件认不出
 * 我的目录名"是用户完全没法自救的一类问题。
 *
 * 现在改成**从 md 正文里读出它实际引用了哪些相对路径**,逐个把源文件搬过来:
 *
 *  - 目录名不再有意义(`images` / `figures` / `ch1/fig` 一视同仁);
 *  - **只搬真的被引用的** —— 源目录里那些没被引用的草稿、`.DS_Store`、原始大图不再跟着进来;
 *  - 引用指向别的盘、`..` 往上爬、或者 http(s) 的,一律不动(那些不是"这份产物的配图")。
 *
 * ## 落点按条目 id,不按内容哈希
 *
 * 与笔记同一个理由(见 `paths.ts` 的 `notePathForId`):用户手上的 md 可能还会再改、
 * 再替换一次。按 id 命名,替换就是覆盖同一个位置,引用和缓存都不用重算。
 */
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
  /** md 里引用了、但源文件边上找不到的图(按引用原样列出)。**如实报出来,不静默丢。** */
  missing: string[];
}

/** 采纳的产物落点:`<库根>/markdown/imported/<条目 id>/`。 */
function importedDirForId(id: string): string {
  return join(libraryRoot(), "markdown", "imported", id);
}

/**
 * 从 md 正文里挑出**它实际引用的相对资源路径**。
 *
 * 只认 `![](…)` 这一种写法:`![]()` 是 Markdown 里引图的唯一标准语法,而转录工具的
 * 产物就是标准 Markdown。`http(s):` / `data:` / 协议相对(`//`)一律跳过 —— 那些不是
 * "这份产物带的图",去下载它们既慢又可能失败,而且库外的东西不该被拷进来。
 *
 * 返回的是**去重后的、原样的引用串**(不在这里解码、不在这里拼绝对路径)—— 解码与
 * 越界判断在 {@link copyReferencedAssets} 里做,那边才知道源目录是谁。
 */
function assetRefsOf(mdText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mdText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = (m[1] ?? "").trim();
    if (raw.length === 0) continue;
    // 去掉 `"标题"` 那种可选的 title 部分:`![](a.png "说明")`
    const ref = raw.split(/\s+/)[0] ?? "";
    if (ref.length === 0) continue;
    if (/^(https?:|data:|blob:|\/\/)/i.test(ref)) continue;
    // 纯锚点(`#fig1`)不是文件
    if (ref.startsWith("#")) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * 把 md 引用到的配图**逐个**从源目录搬到目标目录,保持相对结构。
 *
 * 越界判断用 `relative()` + `isAbsolute()`(与仓库里其它几处越界判断同一条):解析之后
 * 落在**源 md 所在目录之外**的引用一律不搬 —— 那多半是 `../shared/logo.png` 那种跨目录
 * 引用,或者是被人写坏成 `../../../etc/passwd` 的路径。两种都不该跟着进来。
 *
 * 找不到的记进 `missing` 并**如实报给调用方**:静默丢掉的话,用户看到的是一份断图的
 * md,而软件什么也没说 —— 那比报错难查得多。
 */
function copyReferencedAssets(
  mdPath: string,
  mdText: string,
  destDir: string,
): { imageCount: number; missing: string[] } {
  const sourceDir = resolve(dirname(mdPath));
  const missing: string[] = [];
  let imageCount = 0;

  for (const ref of assetRefsOf(mdText)) {
    // 引用可能带 `#片段` 或 `?查询`,查文件时要去掉
    const clean = decodeURIComponent(ref.split(/[?#]/)[0] ?? "");
    if (clean.length === 0) continue;
    const abs = resolve(sourceDir, ...clean.split("/"));

    // 越界(爬到源目录外面 / 变成另一个盘的绝对路径)→ 不搬。这不是"配图没了",
    // 而是这条引用本来就不属于这份产物。
    const rel = relative(sourceDir, abs);
    if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel) || rel.startsWith(sep)) {
      continue;
    }
    if (!existsSync(abs)) {
      missing.push(ref);
      continue;
    }
    try {
      const dest = join(destDir, ...rel.split(/[/\\]/));
      mkdirSync(dirname(dest), { recursive: true });
      // 目录也搬(少数工具会把图放成 `figures/` 而引用写成 `figures/`)
      cpSync(abs, dest, { recursive: true });
      if (statSync(dest).isDirectory()) {
        imageCount += countImages(dest);
      } else {
        imageCount += 1;
      }
    } catch (err) {
      missing.push(`${ref}(${(err as Error).message})`);
    }
  }
  return { imageCount, missing };
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
  const fail = (error: string): AdoptResult => ({
    ok: false,
    error,
    relPath: "",
    imageCount: 0,
    missing: [],
  });

  const item = LibraryRepo.get(itemId);
  if (!item) return fail("找不到这篇文献");
  if (item.kind === "note") return fail("笔记本身就是 Markdown,不需要再挂转录产物");

  const ext = extname(sourcePath).toLowerCase();
  if (![".md", ".markdown"].includes(ext)) return fail(`不是 Markdown 文件(${ext || "无扩展名"})`);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) return fail("文件不存在");

  const destDir = importedDirForId(itemId);

  // ⚠️ **源文件落在这个条目的落点里时要拦下来。** 下面第一件事就是 `rmSync(destDir)`
  // (整目录替换,见那里的理由)—— 而那样会**先删掉用户刚交上来的那份 md**,再去复制一个
  // 已经不存在的文件,报的是"复制失败:ENOENT",看不出是路径的问题。
  //
  // 这条不是假想的:条目详情页开着的时候,`mdPath` 指的就在这个目录里,用户很容易把
  // "库里那份"当成源文件再挂一次;模型也会 —— 它手上正好有那个路径。
  // 那种情况**什么都不用做**(它已经在库里了),所以说清楚,而不是删了再报错。
  {
    const from = resolve(sourcePath);
    const to = resolve(destDir);
    const inside = relative(to, from);
    if (inside === "" || (!inside.startsWith("..") && !/^[A-Za-z]:/.test(inside) && !inside.startsWith(sep))) {
      return fail("这份文件已经在这个条目的库里了,不用再挂一次");
    }
  }

  try {
    ensureLibraryDirs();
    // 整目录替换:上一次采纳的文件不该和这一次混在一起(否则旧的 images/ 会留下,
    // md 里若引用了同名图就会取到旧图 —— 那比报错更难查)
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });

    const fileName = basename(sourcePath);
    const destMd = join(destDir, fileName);
    cpSync(sourcePath, destMd);

    // 配图**按 md 里真实的引用**搬 —— 目录名不参与判断(见文件头)。
    const mdText = readFileSync(sourcePath, "utf8");
    const { imageCount, missing } = copyReferencedAssets(sourcePath, mdText, destDir);

    const relPath = toLibraryRelative(destMd);
    LibraryRepo.setMarkdown(itemId, relPath);
    log.info(
      `library: adopted markdown for ${itemId} from ${sourcePath} (${imageCount} images` +
        `${missing.length > 0 ? `, ${missing.length} missing` : ""})`,
    );
    return { ok: true, relPath, imageCount, missing };
  } catch (err) {
    return fail(`复制失败:${(err as Error).message}`);
  }
}
