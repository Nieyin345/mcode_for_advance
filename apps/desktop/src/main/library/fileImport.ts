/**
 * 通用文件条目的导入(统一资料库)—— 把**任何**文件/目录变成一条库条目。
 *
 * 与 `pdfImport.ts`(文献流:抓元数据、排队下载、转 md)分工:这里是"东西进库"的
 * 那一半 —— ppt、word、照片、用户手上的任意文件。它不做文献才做的事,只解决两件事:
 * **文件从哪来**(复制进库 / 引用原路径)和**条目长什么样**。
 *
 * ## 两种模式(见 `LibraryItem.entryMode`)
 *
 * - `attached`:文件**复制**进库(`<库根>/files/`),路径相对库根 —— 随库搬迁、
 *   可进备份,是"下载的 PDF"那条流的既有语义;
 * - `linked`:只记**绝对路径**,文件原地不动 —— 用户手放的模版/资料是活的,搬进
 *   数据库目录反而打断他已有的引用(M4 的模版迁移走的就是这条)。
 *
 * linked **可以是目录**:模版"目录即条目"的形状在这里原样保留,`filePath` 存目录
 * 绝对路径,读的时候按目录列文件(见 `library:readFile`)。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { basename, extname, join } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { LibraryRepo } from "@main/store/repositories.js";
import { emitItemImported } from "./broadcast.js";
import { assignImportedToCollections } from "./operations.js";
import { libraryRoot, ensureLibraryDirs, fromLibraryRelative } from "./paths.js";
import { log } from "@main/lib/logger.js";
import { pathWithin } from "@main/lib/pathGuard.js";
import { isFileSuppressed } from "./suppress.js";

/** attached 文件的落点:`<库根>/files/`。**扁平 + 条目 id 前缀** —— 不按扩展名分子
 *  目录:文件类型是界面上可改的属性,按它落盘的话改个类型文件就得搬家,没人做得到。 */
function filesDir(): string {
  const dir = join(libraryRoot(), "files");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 一个路径的显示标题:文件名 / 目录名,去掉扩展名(ppt 模版 →「毕设答辩」不带走 .pptx)。 */
function titleFor(p: string): string {
  return basename(p).replace(/\.[^.]+$/, "");
}

/** 一批文件/目录导入为通用条目。
 *
 * 返回逐条结果(成功 + 失败原因),与 `importPdfFiles` 同一形状的精神:批量导入时
 * 调用方需要知道哪几个没成、为什么,只给一句"完成"等于把排查留给用户。 */
export function importGenericFiles(input: {
  paths: string[];
  /** 落法。默认 attached(复制进库)。 */
  mode?: "linked" | "attached";
  collectionIds?: string[];
}): { items: LibraryItem[]; added: number; skipped: number; errors: Array<{ path: string; error: string }> } {
  ensureLibraryDirs();
  const mode = input.mode ?? "attached";
  const items: LibraryItem[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let added = 0;
  let skipped = 0;
  /**
   * 这一趟里**已经处理过的来源路径** → 它对应的条目(`null` = 处理过但没入库)。
   *
   * 一次导入**同一个路径两遍**是用户的常态(拖进来一个文件夹,里面两个快捷方式指
   * 同一个文件;或者手滑点两次)。光靠 `findExisting` 挡不住:它是查库的,而库里
   * 要到这一条**处理完**才有记录 —— 同一批里的第二次走到那儿时,第一次那条还没写进去。
   *
   * 存条目而不是存 `true`,是因为**给回来的东西要和上一次一致**:用户重复导入同一个
   * 文件,拿到的那一条该是同一条,不能第二次给回 `undefined`。
   */
  const seen = new Map<string, LibraryItem | null>();

  for (const p of input.paths) {
    const abs = path.resolve(p);
    try {
      if (!existsSync(abs)) {
        errors.push({ path: p, error: "文件不存在" });
        continue;
      }
      const isDir = statSync(abs).isDirectory();
      // attached 的语义是"把**文件**复制进库"。目录条目的唯一合法形态是 linked
      // (见文件头「linked **可以是目录**」;`importAnyFiles` 也是这么分派的)。
      // 从前这里对目录照走 attached:复制那一步被 `if (!isDir)` 静默跳过,
      // `file_path` 却写上了一个**从未创建过**的 `files/<id>-<名>` —— 条目点开
      // 永远是「文件不存在(被移走了?)」。`library.importGeneric` 那条 IPC 允许
      // attached + 任意路径,所以这一档在真实入口上够得到。目录一律按 linked 落。
      const effectiveMode = isDir ? "linked" : mode;
      if (seen.has(abs)) {
        skipped += 1;
        const first = seen.get(abs);
        if (first) {
          assignImportedToCollections(first.id, input.collectionIds);
          items.push(first);
        }
        continue;
      }
      // 查库只对 `linked` 有意义(理由见 `findExisting`)。`attached` 的重复只靠
      // 上面那张本趟的表挡。
      const dup = effectiveMode === "linked" ? findExisting(abs) : undefined;
      if (dup) {
        assignImportedToCollections(dup.id, input.collectionIds);
        seen.set(abs, dup);
        skipped += 1;
        items.push(dup);
        continue;
      }

      let filePath: string;
      if (effectiveMode === "linked") {
        filePath = abs;
      } else {
        // attached:复制进 `<库根>/files/<id 前缀>-<原名>`。先建条目拿 id,再复制,
        // 再把路径写上(id 是路径的一部分,先复制做不到)。
        //
        // ⚠️ 失败要**收拾干净**:复制/写路径任何一步抛,刚建的那行必须删掉 ——
        // 留下来就是一条无文件、无归属、界面上任何入口都够不着的半截条目;而且
        // 用户重试时它还躺在库里。落点目录(`filesDir()`)也挪到 upsert **之前**
        // 拿:它自己就可能建不出来,那种失败不该先留一行记录。
        // (捕到就删、再原样往外抛,由下面统一的 per-file catch 记进 errors。)
        const destDir = filesDir();
        const item = LibraryRepo.upsert({
          title: titleFor(abs),
          entryMode: "attached",
        });
        let fresh: LibraryItem;
        try {
          const dest = join(destDir, `${item.id}-${basename(abs)}`);
          copyFileSync(abs, dest);
          LibraryRepo.setFilePath(item.id, toRel(dest));
          fresh = LibraryRepo.get(item.id)!;
        } catch (err) {
          LibraryRepo.delete([item.id]);
          throw err;
        }
        assignImportedToCollections(fresh.id, input.collectionIds);
        seen.set(abs, fresh);
        items.push(fresh);
        added += 1;
        emitItemImported(fresh);
        continue;
      }

      const item = LibraryRepo.upsert({
        title: titleFor(abs),
        entryMode: "linked",
        filePath: abs,
      });
      assignImportedToCollections(item.id, input.collectionIds);
      items.push(item);
      added += 1;
      seen.set(abs, item);
      // 与 attached 分支同一条事件 —— automation 的「文献自动下载」与钩子都以
      // "有条目入库"为准,不区分落法。
      emitItemImported(item);
    } catch (err) {
      log.warn(`[library] 通用导入失败 ${p}:${(err as Error).message}`);
      errors.push({ path: p, error: (err as Error).message });
      continue;
    }
  }

  return { items, added, skipped, errors };
}

/** 绝对路径 → 相对库根。给 attached 用;linked 不走它(存的就是绝对路径)。 */
function toRel(abs: string): string {
  const root = libraryRoot();
  return abs.startsWith(root) ? abs.slice(root.length + 1).split(path.sep).join("/") : abs;
}

/**
 * 这个来源路径有没有**已经以 `linked` 落过库**。
 *
 * ## 只查 `linked`,而且只在这一趟内查得到
 *
 * `linked` 的 `file_path` 存的是用户给的**绝对路径原样**,所以有键可查 —— 用户对
 * 同一个文件点两次「导入」是常态,不挡的话会出现两个标题一样的条目。
 *
 * ## `attached` 那一支为什么没有这个键(所以去重只能靠这一趟自己)
 *
 * 它的 `file_path` 是 `<库根>/files/<条目 id>-<原名>`,而 **id 是新建时才生成的**
 * —— 落盘之前根本算不出来。库里也不记来源路径,所以"这个文件是不是已经复制进库过"
 * 事后问不出答案。早先这里两种模式都拿 `filePath === abs` 去比,于是 attached 那一支
 * **恒假**(存的是相对路径,拿绝对路径比,永远是 undefined),同一个文件拖两次就进
 * 两条、各自复制一份 —— 而入口那几处都是 `linked`,所以一直没人撞见。
 *
 * 修法不是硬造一个键,而是**把去重挪到这一趟自己的表上**(见 `seen`):一次导入里
 * 同一个路径出现两次,第二条挡掉。跨调用的那份重复仍认不出来 —— 那是这个存储形态的
 * 真实代价(改成按内容哈希命名才能根治,那是另一个量级的改动),不假装它被修好了。
 */
function findExisting(abs: string): LibraryItem | undefined {
  return LibraryRepo.findLinkedByPath(abs);
}

/** linked/attached 共用的"这条条目该读什么":文件本身,或目录下的文件列表。 */
export function entryFileAbsPath(item: LibraryItem): string | null {
  if (!item.filePath) return null;
  return item.entryMode === "linked" ? item.filePath : join(libraryRoot(), item.filePath);
}

/** 扩展名(小写,带点)。目录返回空串。 */
export function extOf(p: string): string {
  return extname(p).toLowerCase();
}

/* ── 读取:`library:readFile` 的实现 ── */

const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".tex", ".bib", ".csv", ".tsv", ".json", ".yaml", ".yml",
  ".xml", ".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".r",
  ".sh", ".bat", ".ps1", ".ipynb", ".log", ".ini", ".toml", ".cfg", ".srt",
]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};
const BINARY_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".epub": "application/epub+zip",
};

/** base64 的体积上限。预览用 —— 超了的文件让用户去系统里开,不要把 IPC 当网盘。 */
const MAX_BINARY_BYTES = 20 * 1024 * 1024;

/**
 * 一条记录该读哪个文件。
 *
 * ## ⚠️ 从前这里**只认 `file_path`** —— 于是论文全都读不出东西（2026-09-21 修）
 *
 * 老判据是 `entryFileAbsPath(item)`,而它只看 `file_path`。而论文那条流
 * (`pdfImport` / 下载器)落的记录是 **`entry_mode: "attached"` + `file_path: NULL`**,
 * 文件在 `pdf_path` / `md_path` 两列上 —— 于是点开任何一篇论文,预览都报
 * 「**这条资料没有关联文件**」。
 *
 * ★ 用户截图里那个「这条资料没有关联文件，一直显示这个」,和「我点击的是 pdf、
 * 一直展示的是关联的 md 转录」是**同一个根因的两头**:
 *
 *   - 右栏(走这里)只认 `file_path` → 论文翻不出来 → 那句错话;
 *   - 中间栏(走 `FileViewer`)从前也只认 `file_path`,后来给它接上了 `md_path`,
 *     于是**能翻出来**,但翻出来的是**转录** —— 用户点的明明是 PDF。
 *
 * 修法是把三条来源都认下来,并**把 PDF 排在前面**:论文天然有 PDF,用户要的
 * 「点击和双击都显示这个 PDF 本身」就是这一条默认。转录(若要看)由调用方指名
 * `which: "md"` —— 见左栏右键那个「查看转录文本」。
 *
 * ## 未指名时的顺序,以及为什么最后还退到转录
 *
 * `file_path` → `pdf_path` → `md_path`。
 *
 * 前两条是"这是这一条的本体"。**最后那条是回退,不是默认** —— 一篇还没下 PDF 的论文
 * 只剩转录可看,那时摆出转录总比甩一句错误好。真正要防的是**反过来**:指名要 PDF 时
 * 悄悄拿转录顶上(那正是中间栏那条 bug 的形态),所以 `which` 一给了就**只认那一样**,
 * 缺了如实报缺 —— 见下面两个分支。
 *
 * ## 为什么优先 `file_path`
 *
 * 通用条目(模版 / 用户拖进来的任意文件)只有 `file_path`,它**就是**本体;论文只有
 * `pdf_path`。两者不会同时有,顺序只决定"万一都写了谁说话"——真出现那种记录时,
 * `file_path` 是更近的那一层(条目创建时就带着的那份)。
 */
export function entryRootAbsPath(item: LibraryItem, which?: "pdf" | "md"): string | null {
  // 指名的那一份:**只认它**,没有就是没有(不拿另一样顶上)
  if (which === "md") return item.mdPath ? fromLibraryRelative(item.mdPath) : null;
  if (which === "pdf") {
    return entryFileAbsPath(item) ?? (item.pdfPath ? fromLibraryRelative(item.pdfPath) : null);
  }
  // 未指名:本体 → PDF → 转录
  return (
    entryFileAbsPath(item) ??
    (item.pdfPath ? fromLibraryRelative(item.pdfPath) : null) ??
    (item.mdPath ? fromLibraryRelative(item.mdPath) : null)
  );
}

/**
 * 一条条目**交给 AI 的**两份文件:Markdown 转录(若有)与原件。
 *
 * 挂进对话的清单(`manifest.ts`)和 `library.py` 的 `file_of` 都按这一口径:有转录就先给
 * 转录(便宜,公式、表格都在里头),**后面一起给原件** —— 转录和原件是同一条条目的两份
 * 文件(`convert.ts` 把转录写回原条目的 `md_path`),转录里拿不准的图表、版式要回原件核对。
 *
 * 原件 = 本体(`file_path`)→ PDF,与 `entryRootAbsPath(item, "pdf")` 同一顺序。
 * 从前清单只认 md / pdf 两列,只有 `file_path` 的通用条目(Word、PPT、关联进来的库外
 * 文件)在清单里被说成「还没有文件」。
 */
export function readableFilesOf(item: LibraryItem): { markdown: string | null; original: string | null } {
  return {
    markdown: item.mdPath ? fromLibraryRelative(item.mdPath) : null,
    original: entryRootAbsPath(item, "pdf"),
  };
}

/**
 * **给 AI 的**那几份文件 = `readableFilesOf` 去掉按文件类型屏蔽的(见 `suppress.ts`)。
 *
 * 屏蔽 pdf → 只剩转录;屏蔽 md → 只剩原件。条目整条挡不挡由调用方先用
 * `suppressionReasonOfItem` 判;这里只管按份去掉。用户自己预览不走这里。
 * `hasTranscript` 说的是**有没有转录**(不管给不给)—— 只剩原件时,清单据此决定要不要
 * 说「尚未转 Markdown」:转录是有的、只是不给,就不该那样说。
 */
export function aiVisibleFilesOf(item: LibraryItem): { markdown: string | null; original: string | null; hasTranscript: boolean } {
  const f = readableFilesOf(item);
  return {
    markdown: f.markdown && !isFileSuppressed(f.markdown) ? f.markdown : null,
    original: f.original && !isFileSuppressed(f.original) ? f.original : null,
    hasTranscript: Boolean(item.mdPath),
  };
}

/**
 * 读一个条目(或目录条目内的某个文件)。**linked 与 attached 同一条路**:
 * `entryRootAbsPath` 已经把几种来源折成绝对路径,这里只管分型。
 *
 * `which` 是**看不看转录**那件事的唯一开关(默认不含甲基:见 `entryRootAbsPath`)。
 */
export function readEntryFile(
  itemId: string,
  relPath?: string,
  which?: "pdf" | "md",
): import("@contracts/ipc/library.js").LibraryFileContent {
  const item = LibraryRepo.get(itemId);
  if (!item) return { type: "unsupported", error: "找不到这条资料" };
  const root = entryRootAbsPath(item, which);
  if (!root) {
    if (which === "md") return { type: "unsupported", error: "这条资料还没有转成文本" };
    if (which === "pdf") return { type: "unsupported", error: "这条资料还没有 PDF" };
    return { type: "unsupported", error: "这条资料没有关联文件" };
  }

  let target = root;
  if (relPath) {
    // relPath 只用于**目录条目内**寻址;拼完后必须在目录里(`..` 逃逸与符号链接都拒),
    // 否则任意路径读文件就是个洞。用共享的 pathWithin(解析 realpath/junction、按平台
    // 归一大小写),而不是裸 startsWith —— 后者既漏符号链接越界、又在 Windows 上被大小写骗过。
    target = path.resolve(root, relPath);
    if (!pathWithin(root, target)) {
      return { type: "unsupported", error: "路径越出了这条资料的目录" };
    }
  }
  if (!existsSync(target)) return { type: "unsupported", error: "文件不存在(被移走了?)" };

  const st = statSync(target);
  if (st.isDirectory()) {
    const names = readdirSync(target).sort();
    return {
      type: "dir",
      files: names.map((name) => ({ name, isDir: statSync(join(target, name)).isDirectory() })),
    };
  }

  const ext = extOf(target);
  // ⚠️ **先看大小再读**(OBS-M35-01)。原来是 `readFileSync` 之后再比 `byteLength`,
  // 一个几百 MB 的文件在返回"太大"之前已经整个进了主进程内存;文本分支更是没有上限。
  // 两支共用同一条上限:预览走 IPC 送到渲染端,超过它的都该让用户去系统里开。
  if (st.size > MAX_BINARY_BYTES) {
    return { type: "unsupported", error: "文件太大(超过 20MB),请在系统里打开" };
  }
  if (TEXT_EXTS.has(ext)) {
    const text = readFileSync(target, "utf8");
    return { type: "text", text };
  }
  const mime = IMAGE_MIME[ext] ?? BINARY_MIME[ext];
  if (!mime) {
    return { type: "unsupported", error: `不认识的文件类型:${ext || "(无扩展名)"}` };
  }
  const buf = readFileSync(target);
  return { type: "binary", mime, base64: buf.toString("base64") };
}
