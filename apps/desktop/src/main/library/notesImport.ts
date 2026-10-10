/**
 * 笔记库的导入:**直接把 Markdown 文件收进来**。
 *
 * ## 与 PDF 导入的根本差别
 *
 * PDF 导入是一条长流水线(抓元数据 → 落盘 → 转 Markdown → 可能排队下载);笔记
 * **本身就是 Markdown**,入库即完成 —— 没有元数据可抓,也没有东西要转录。所以这里
 * 只做三件事:读文本、从正文里取个标题、把文件复制进库。
 *
 * ## 文件名按条目 id,不按内容哈希
 *
 * 理由写在 `paths.ts` 的 `notePathForId`:笔记是用户会继续编辑的东西,内容一改哈希
 * 就变,路径跟着变会连累引用与缓存。按 id 命名,改多少次都还是那个文件。
 *
 * ## 去重按标题
 *
 * 笔记没有 DOI 这种天然主键。按内容哈希去重的话,**改一个字的同一篇笔记就会被当成
 * 两篇**;不去重的话,手滑导入两次就出现两份一模一样的。所以按「同一个库里标题相同」
 * 判重 —— 这条规则用户一眼能懂,也能自己绕开(改个标题再导)。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { atomicWrite } from "@main/lib/appContext.js";
import { emitItemImported } from "./broadcast.js";
import { assignImportedToCollections } from "./operations.js";
import { ensureLibraryDirs, fromLibraryRelative, isInsideLibrary, notePathForId, noteRelPathForId, toLibraryRelative } from "./paths.js";

export interface NoteImportSummary {
  items: LibraryItem[];
  added: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/** 认得的笔记扩展名。`.markdown` 少见但确实是合法的。
 *
 * **只有这一份** —— 分派器(`importDispatch.ts`)按它决定一个文件走不走笔记管线,
 * 导入器(`importNoteFiles`)按它决定收不收;两份字面量迟早漂移(从前就是两份,
 * 分派器那份的注释已经漏写了 `.mdown`)。谁要认新扩展名,改这里。 */
export const NOTE_EXTS = new Set([".md", ".markdown", ".mdown", ".txt"]);

/**
 * 从正文里取标题:第一个 `# 一级标题`;没有就用第一行有内容的文字(截断)。
 *
 * 为什么读正文而不是直接用文件名:笔记的文件名经常是 `untitled.md`、`新建文档.md`,
 * 而正文第一行几乎总是真正的标题。取不到才退回文件名。
 */
export function deriveNoteTitle(text: string, filePath: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading?.[1]) return heading[1].trim().slice(0, 120);
    // 第一行有内容但不是标题:当标题用(去开头的 markdown 记号)
    const plain = line.replace(/^[>*\-+\s]+/, "").trim();
    if (plain) return plain.slice(0, 120);
    break;
  }
  return basename(filePath, extname(filePath));
}

/**
 * 导入一批 Markdown 笔记。源文件**复制**进库(与 PDF 一致:库是一个自洽的位置,
 * 用户原来的文件留在原处)。
 */
export function importNoteFiles(paths: string[], collectionIds?: string[]): NoteImportSummary {
  ensureLibraryDirs();
  const out: NoteImportSummary = { items: [], added: 0, skipped: 0, errors: [] };

  for (const path of paths) {
    try {
      const ext = extname(path).toLowerCase();
      if (!NOTE_EXTS.has(ext)) {
        out.errors.push({ path, error: `不是 Markdown 文件(${ext || "无扩展名"})` });
        continue;
      }
      if (!existsSync(path)) {
        out.errors.push({ path, error: "文件不存在" });
        continue;
      }
      const text = readFileSync(path, "utf8");
      const title = deriveNoteTitle(text, path);

      // 同一个库里标题相同 = 认为已经收过了。
      //
      // 只认**有 md 文件**的行:半截行(建了记录、文件没落成 —— 见下面失败清理那
      // 一段的理由)不许把重试判成"已存在",否则这篇笔记就永远进不来了。
      //
      // ⚠️ **查重必须扫全库,不能用 `list({ query, limit })`。** 那个 `query` 是
      // title/abstract/file_path/url 的**子串**匹配且默认按 added_at 倒序,`limit` 又是
      // **在精确匹配之前**把结果切掉 —— 库里只要有一批子串撞上、但比这篇新的条目,真正的
      // 那篇就被挤出窗口,`find` 找不到,于是同一个标题**静默又建一条**(而不是 skipped)。
      // `findLinkedByPath` 的注释点名的正是这一类(`list` 的上限让"重复导入静默变成又建
      // 一条")。用 `listAllItems`(全量,专给这种判据用),在内存里做精确匹配。
      const needle = title.trim().toLowerCase();
      const dup = LibraryRepo.listAllItems().find(
        (i) => Boolean(i.mdPath) && i.title.trim().toLowerCase() === needle,
      );
      if (dup) {
        // 「这一份已经收过了」不改变「用户要它出现在这个分类里」—— 与 PDF 管线
        // `alreadyPresent` 那条路同一口径。条目也要给回来:调用方(和用户)得知道
        // 这次重复对应的是库里哪一条,不能第二次就空手而归。
        assignImportedToCollections(dup.id, collectionIds);
        out.items.push(dup);
        out.skipped += 1;
        continue;
      }

      const item = LibraryRepo.upsert({ title });
      try {
        const dest = notePathForId(item.id);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(path, dest);
        LibraryRepo.setMarkdown(item.id, noteRelPathForId(item.id));
      } catch (err) {
        // 半截行必须收拾掉:文件没落成的记录留在库里,按标题查重会把下一次重试
        // 判成"已存在" —— 用户看到一次报错、之后怎么导都"跳过",笔记永远进不来。
        LibraryRepo.delete([item.id]);
        throw err;
      }

      // 归属走导入统一的那道门(`assignImportedToCollections`):失效的分类 id
      // **跳过**而不是抛 —— 裸调 `CollectionRepo.assign` 会撞外键直接炸,而此刻
      // 条目已经入库,调用方收到的却是"导入失败"。
      assignImportedToCollections(item.id, collectionIds);

      const saved = LibraryRepo.get(item.id);
      if (saved) out.items.push(saved);
      out.added += 1;
      // **入库信号**,与另外两条导入管线(`fileImport` 的通用文件 / `pdfImport` 的
      // PDF)同一条:自动化的「事件发生时」触发器与钩子靠 `library.item.imported` 认出
      // "有条目进库了"。从前这一支漏了 —— `.md`/`.txt`/`.markdown`/`.mdown` 从
      // 「导入文件」进来时**永远不发事件**,而同一批里的 PDF/其余文件都发:用户看到
      // 的是"东西进库了、自动化就是不响",而且只有这一种扩展名不响(最难看出来的那种)。
      // 归属在事件**之前**做完(同 `pdfImport`):事件起来的自动化立刻去查这一条时,
      // 看到的状态该是已经归好类的。
      emitItemImported(saved ?? item);
      log.info(`library: imported note ${basename(path)} as ${item.id}`);
    } catch (err) {
      out.errors.push({ path, error: (err as Error).message });
    }
  }

  return out;
}

/**
 * 新建一篇空笔记(在应用内写)。
 *
 * 文件先落一份带标题的骨架,用户打开就有一行 `# 标题` 可改。**文件是先决条件**:
 * 渲染端的编辑器读写的始终是磁盘上那份 md,不搞"只在数据库里存在"的笔记 ——
 * 那样用户一关软件就分不清东西到底在不在。
 */
export function createNote(title: string, collectionIds?: string[]): LibraryItem | null {
  ensureLibraryDirs();
  const clean = title.trim() || "未命名笔记";
  const item = LibraryRepo.upsert({ title: clean });
  // ⚠️ **落文件失败要把刚建的那行删掉** —— 与 `importNoteFiles` 里那条清理同一条规矩。
  // 顺序是"先 upsert 拿 id,再往 `notes/<id>.md` 落文件"(文件按 id 命名,不先建行就没有
  // id)。落文件一抛,那一行就留在库里变成**无文件的半截条目**:界面上是一行点开就报错的
  // 空记录,而它不属于任何分类、也没有任何入口够得着。从前这里没有 `catch` 清理,注释还
  // 写着"不让它在文件落盘之后整个抛掉" —— 抛掉是对的,但**留下半截行没人收拾**才是问题。
  try {
    const dest = notePathForId(item.id);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `# ${clean}

`, "utf8");
    LibraryRepo.setMarkdown(item.id, noteRelPathForId(item.id));
  } catch (err) {
    LibraryRepo.delete([item.id]);
    throw err;
  }
  // 同上:失效的分类 id 跳过,不让"新建笔记"在文件已落盘之后整个抛掉。
  assignImportedToCollections(item.id, collectionIds);
  const created = LibraryRepo.get(item.id);
  // **入库信号**:新建一篇笔记 = 库里多了一条,与 `library.addItems`(另一条应用内
  // "先记一条"的路)同一条 —— 都发 `library.item.imported`。少了它,用户新建笔记
  // 时挂在"有条目入库"上的自动化永远不响,而新建 PDF / 拖入文件都会响。
  if (created) emitItemImported(created);
  return created;
}

/**
 * 把编辑器的内容写回磁盘。
 *
 * 两道守卫:① **只允许改笔记** —— 论文/教材的 md 是转录产物,应用内的编辑器覆盖它
 * 会让"转录结果"和"用户改动"再也分不清;② 目标路径必须落在库内,防记录被写坏之后
 * 顺着越界路径覆盖到用户别处的文件。
 *
 * ②那一道用 {@link isInsideLibrary},**不是** `toLibraryRelative(abs).startsWith("..")`
 * —— 后者恒假(见 `paths.ts` 里那个函数的注释)。
 */
export function writeNote(id: string, text: string): { ok: boolean; error?: string } {
  const item = LibraryRepo.get(id);
  if (!item) return { ok: false, error: "找不到这篇笔记" };
  if (!item.mdPath) return { ok: false, error: "这篇还没有 Markdown 文件" };
  /**
   * ⚠️ **越界这一道必须排在编辑权那一道前面。**
   *
   * 两道守卫管的是两件事:越界是**安全**(记录被写坏/脏数据时不许顺着路径写到库外),
   * 编辑权是**语义**(论文/教材的转录产物不该被应用内的编辑器覆盖掉)。次序反过来的话,
   * 一条指向库外的记录会先被编辑权那道挡下 —— 报的是"不是 Markdown 文件",而它真正
   * 危险的地方(它要写到库外去)被这句话盖住了。报错说错了原因,排查的人就找不到真问题。
   */
  const abs = fromLibraryRelative(item.mdPath);
  if (!isInsideLibrary(abs)) return { ok: false, error: "路径越界,拒绝写入" };
  // 编辑权按**扩展名**判（kind 退役）：条目的 md 文件才能在应用内编辑。
  if (!item.mdPath.endsWith(".md")) {
    return { ok: false, error: "只有 Markdown 文件能在应用内编辑" };
  }
  try {
    // 原子写:这是用户自己写的正文,写到一半崩溃不能留下半截文件。
    atomicWrite(abs, text);
    // 正文里的第一个标题变了 → 列表行也跟着变,不然两处显示对不上
    const nextTitle = deriveNoteTitle(text, abs);
    if (nextTitle && nextTitle !== item.title) LibraryRepo.setTitle(id, nextTitle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入失败:${(err as Error).message}` };
  }
}
