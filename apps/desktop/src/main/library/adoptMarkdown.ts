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
 *
 * ## ⚠️ 替换是**换上去**,不是"先删掉再拷"
 *
 * 这一条是 2026-09-20 修的一个**不可逆的数据丢失**。原来这里是:
 *
 * ```ts
 * rmSync(destDir, { recursive: true, force: true });   // ← 老包在这一刻就没了
 * mkdirSync(destDir, { recursive: true });
 * cpSync(sourcePath, destMd);                           // ← 失败点
 * ```
 *
 * 中间任何一步失败(源文件读不了、源被独占、磁盘满、权限、路径太长),老包**已经删了**,
 * 新的也没进来,报的还是"复制失败:EPERM"这种看不出前因的话。用户点一下「改用这个
 * Markdown」,原有产物**静默消失** —— 而这份产物可能是他花额度转出来的唯一一份。
 *
 * 现在是**先拷到旁边、成功了再换**:
 *
 * ```
 * mkdir   <imported>/.adopt-<条目 id>-<随机>     ← 暂存(没有源文件读不出来这一说)
 * cp/copy 正文 + 引用的配图 到暂存             ← 失败点**在动老包之前**
 * rename 老包 → <imported>/.old-<条目 id>-<随机>   ← 退路
 * rename 暂存 → 老包的位置                       ← 换上去
 * rm     退路                                   ← 只有走到这里才真删
 * ```
 *
 * 失败路径上有两件事要守住,顺序不能反:
 *
 *   - **换上去之前失败** → 只删暂存,老包**一个字节都没动**(而且它还在原地,不叫"恢复",
 *     是"从来没动过")。这就是"拷到一半失败时原来那份包还在"的实现。
 *   - **换上去之后失败**(退路删不掉)→ 新包已经生效,退路那一下失败**不该把成功报成失败**
 *     —— 那是把一个已经完成的结果说成没完成。所以只记一行日志,照常 ok。
 *
 * ## 换不动时(Windows 的文件占用)
 *
 * `rename` 在 Windows 上会因目标被占用 / 被杀软扫到而失败(EPERM)。那时**整体放弃**:
 * 老包原样不动、暂存清掉、如实报错 —— 不做"先删再用拷贝顶上"那种就地重试,因为那一步
 * 又把"已经删了"的窗口打开了。用户关掉占用的程序再点一次即可。
 */
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { ensureLibraryDirs, libraryRoot, toLibraryRelative, countImageFiles } from "./paths.js";

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

/** 采纳那包东西的父目录 —— 暂存目录和退路目录都放在它下面,和落点同盘才能 rename。 */
function importedParent(): string {
  return join(libraryRoot(), "markdown", "imported");
}

/**
 * 在**同一个文件系统**上临时占一个位置(`<父目录>/.adopt-<id>-<随机>`)。
 *
 * 为什么不用系统的临时目录:`rename` 跨盘会退化成"复制 + 删除",那就不是原子的了 ——
 * 而"换上去"这一步的全部价值就是它要么整个成了、要么老包原样。
 */
function stagedDirFor(id: string, tag: string): string {
  return mkdtempSync(join(importedParent(), `.${tag}-${id}-`));
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
        imageCount += countImageFiles(dest);
      } else {
        imageCount += 1;
      }
    } catch (err) {
      missing.push(`${ref}(${(err as Error).message})`);
    }
  }
  return { imageCount, missing };
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

  // ⚠️ **源文件落在这个条目的落点里时要拦下来。** 下面整包替换的第一步就是
  // 把老包挪开(见文件头)—— 而源文件就在那个老包里面时,挪完之后它**已经被搬走了**,
  // 再去复制一个不在原处的路径,报的是"复制失败:ENOENT",看不出是路径的问题。
  //
  // 这条不是假想的:条目详情页开着的时候,`mdPath` 指的就在这个目录里,用户很容易把
  // "库里那份"当成源文件再挂一次;模型也会 —— 它手上正好有那个路径。
  // 那种情况**什么都不用做**(它已经在库里了),所以说清楚,而不是报一句复制失败。
  {
    const from = resolve(sourcePath);
    const to = resolve(destDir);
    const inside = relative(to, from);
    if (inside === "" || (!inside.startsWith("..") && !/^[A-Za-z]:/.test(inside) && !inside.startsWith(sep))) {
      return fail("这份文件已经在这个条目的库里了,不用再挂一次");
    }
  }

  // 暂存与退路的位置。放这儿是为了 catch 里也能引用到(失败时要清掉暂存)。
  let stageDir: string | null = null;
  let backupDir: string | null = null;

  try {
    ensureLibraryDirs();
    // 落点那一层父目录可能还不存在(第一次采纳这条)。上面那两件必须在**动 rename 之前**
    // 备好,否则 rename 会因为父目录不存在而失败 —— 那报出来的话会像是"换不上去"。
    mkdirSync(importedParent(), { recursive: true });

    // ── ① 先把新的一整包拷进暂存。**这一步失败时老包一个字节都没动。** ──
    stageDir = stagedDirFor(itemId, "adopt");
    const stagedMd = join(stageDir, basename(sourcePath));
    cpSync(sourcePath, stagedMd);

    // 配图**按 md 里真实的引用**搬 —— 目录名不参与判断(见文件头)。
    const mdText = readFileSync(sourcePath, "utf8");
    const { imageCount, missing } = copyReferencedAssets(sourcePath, mdText, stageDir);

    // ── ② 把老包挪到退路,再把暂存换到它的位置。两步都是 rename(同盘、原子)。 ──
    const hadOld = existsSync(destDir);
    if (hadOld) {
      backupDir = stagedDirFor(itemId, "old");
      // mkdtemp 建的是一个空目录,而 rename 要求目标不存在 —— 用完就删掉。
      rmSync(backupDir, { recursive: true, force: true });
      try {
        renameSync(destDir, backupDir);
      } catch (err) {
        // 老包挪不动(Windows 上常见的是被别的程序占用)→ **整体放弃**。不做"就地删了再拷"
        // 那种重试:那一步会把"已经删了"的窗口重新打开,正是这个文件要修的东西。
        backupDir = null;
        return fail(
          `替换失败(老的那一份挪不动,可能正被别的程序占用;关掉它再试一次):${(err as Error).message}`,
        );
      }
    }
    try {
      renameSync(stageDir, destDir);
    } catch (err) {
      // 换不上去(Windows 上多半是落点被占用 / 杀软扫到)。把老包**挪回原位**,再清掉暂存。
      // 暂存里那份新内容是源文件的副本(源还在用户那儿),删掉不会丢东西 —— 但这一步
      // 失败也照样记一行,别静默。
      const stage = stageDir;
      stageDir = null;
      if (backupDir) {
        try {
          renameSync(backupDir, destDir);
          backupDir = null;
        } catch (restoreErr) {
          // 挪不回去了。**退路目录是那份老包唯一的所在** —— 把路径如实报出来,那是它
          // 仅剩的线索;静默丢掉它是最坏的结果。
          const stranded = backupDir;
          backupDir = null;
          return fail(
            `替换失败,而且老的那一份没能挪回原位(它还在 ${stranded}):${(restoreErr as Error).message}`,
          );
        }
      }
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch (cleanupErr) {
        log.warn(`library: 换不上去,暂存目录也没清掉(${stage}):${(cleanupErr as Error).message}`);
      }
      return fail(`替换失败(新的一份没能换上去):${(err as Error).message}`);
    }
    stageDir = null; // 暂存已经变成落点本身

    // ── ③ 到这里替换已经成了。清掉退路 —— 这一步失败**不能把成功报成失败**。 ──
    if (backupDir) {
      const doomed = backupDir;
      backupDir = null;
      try {
        rmSync(doomed, { recursive: true, force: true });
      } catch (err) {
        log.warn(`library: 替换完成,但旧的采纳产物没删掉(${doomed}):${(err as Error).message}`);
      }
    }

    const relPath = toLibraryRelative(join(destDir, basename(sourcePath)));
    LibraryRepo.setMarkdown(itemId, relPath);
    log.info(
      `library: adopted markdown for ${itemId} from ${sourcePath} (${imageCount} images` +
        `${missing.length > 0 ? `, ${missing.length} missing` : ""})`,
    );
    return { ok: true, relPath, imageCount, missing };
  } catch (err) {
    // 走到这里时**替换还没发生**(上面那两步的失败都在更内层处理掉了)—— 所以只需要
    // 把暂存清干净,老包原样不动。
    if (stageDir) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        log.warn(`library: 采纳失败,暂存目录也没清掉(${stageDir}):${(cleanupErr as Error).message}`);
      }
    }
    return fail(`复制失败:${(err as Error).message}`);
  }
}
