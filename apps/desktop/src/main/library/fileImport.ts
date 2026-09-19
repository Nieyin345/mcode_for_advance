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
import type { LibraryItem, LibraryKind } from "@contracts/library";
import { LibraryRepo } from "@main/store/repositories.js";
import { emitItemImported } from "./broadcast.js";
import { libraryRoot, ensureLibraryDirs } from "./paths.js";
import { log } from "@main/lib/logger.js";

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
  /** 归到哪个类型(注册表里的 kind)。省略 = 从扩展名猜,猜不出进 document。 */
  kind?: LibraryKind;
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
      if (seen.has(abs)) {
        skipped += 1;
        const first = seen.get(abs);
        if (first) items.push(first);
        continue;
      }
      // 查库只对 `linked` 有意义(理由见 `findExisting`)。`attached` 的重复只靠
      // 上面那张本趟的表挡。
      const dup = mode === "linked" ? findExisting(abs) : undefined;
      if (dup) {
        seen.set(abs, dup);
        skipped += 1;
        items.push(dup);
        continue;
      }

      let filePath: string;
      if (mode === "linked") {
        filePath = abs;
      } else {
        // attached:复制进 `<库根>/files/<id 前缀>-<原名>`。先建条目拿 id,再复制,
        // 再把路径写上 —— 反过来(先复制)的话,失败会留下没主的无文件条目。
        const item = LibraryRepo.upsert({
          kind: input.kind ?? "document",
          title: titleFor(abs),
          entryMode: "attached",
        });
        const dest = join(filesDir(), `${item.id}-${basename(abs)}`);
        if (!isDir) copyFileSync(abs, dest);
        LibraryRepo.setFilePath(item.id, toRel(dest));
        const fresh = LibraryRepo.get(item.id)!;
        seen.set(abs, fresh);
        items.push(fresh);
        added += 1;
        emitItemImported(fresh);
        continue;
      }

      const item = LibraryRepo.upsert({
        kind: input.kind ?? "document",
        title: titleFor(abs),
        entryMode: "linked",
        filePath: abs,
      });
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
 * 读一个条目(或目录条目内的某个文件)。**linked 与 attached 同一条路**:
 * `entryFileAbsPath` 已经把两种模式折成绝对路径,这里只管分型。
 */
export function readEntryFile(
  itemId: string,
  relPath?: string,
): import("@contracts/ipc/library.js").LibraryFileContent {
  const item = LibraryRepo.get(itemId);
  if (!item) return { type: "unsupported", error: "找不到这条资料" };
  const root = entryFileAbsPath(item);
  if (!root) return { type: "unsupported", error: "这条资料没有关联文件" };

  let target = root;
  if (relPath) {
    // relPath 只用于**目录条目内**寻址;拼完后必须在目录里(`..` 逃逸直接拒),
    // 否则任意路径读文件就是个洞。
    target = path.resolve(root, relPath);
    if (!target.startsWith(path.resolve(root) + path.sep)) {
      return { type: "unsupported", error: "路径越出了这条资料的目录" };
    }
  }
  if (!existsSync(target)) return { type: "unsupported", error: "文件不存在(被移走了?)" };

  if (statSync(target).isDirectory()) {
    const names = readdirSync(target).sort();
    return {
      type: "dir",
      files: names.map((name) => ({ name, isDir: statSync(join(target, name)).isDirectory() })),
    };
  }

  const ext = extOf(target);
  if (TEXT_EXTS.has(ext)) {
    const text = readFileSync(target, "utf8");
    return { type: "text", text };
  }
  const mime = IMAGE_MIME[ext] ?? BINARY_MIME[ext];
  if (!mime) {
    return { type: "unsupported", error: `不认识的文件类型:${ext || "(无扩展名)"}` };
  }
  const buf = readFileSync(target);
  if (buf.byteLength > MAX_BINARY_BYTES) {
    return { type: "unsupported", error: "文件太大(超过 20MB),请在系统里打开" };
  }
  return { type: "binary", mime, base64: buf.toString("base64") };
}
