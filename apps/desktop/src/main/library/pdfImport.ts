/**
 * 从本地 PDF 文件导入。
 *
 * ## 顺序是有讲究的
 *
 *   1. **校验**(PDF 魔数 + 大小)—— 最快,也最该先挡掉
 *   2. **按 sha256 查重** —— 同内容已经在库里就不重复入库
 *   3. **复制进库** —— 复制不是移动:源文件是用户的,不能动
 *   4. **入库** —— 标题取文件名;学术元数据(DOI / 作者 / 期刊…)不再由核心去猜,
 *      外部 MCP / 自动化可以在 `library:itemImported` 事件之后补
 *
 * 一份失败不影响其他:整个函数逐份处理,把每份的结果(成功/已在库/失败原因)都
 * 带回去,而不是遇到第一个问题就整体抛错 —— 用户一次拖三十篇进来,"有两篇认不出"
 * 不该让另外二十八篇也不入库。
 *
 * ## 去重靠内容
 *
 * 同一份文件导两次完全可能。内容寻址让它们落进同一个 `papers/<ab>/<cd>/<sha>.pdf`,
 * 再加一道 `findByPdfSha`,就不会多出重复条目。
 *
 * ## `collectionIds` 从前是**声明了但没用**
 *
 * 界面那两颗「导入文件 / 导入文件夹」按钮会传它(`LIBRARY_IMPORT_FILES` →
 * `importAnyFiles` → 这里),而 `importOne` 里一个归属动作都没有 —— 于是**用户选了分类,
 * 东西却掉进回收站**:导入的条目不属于任何集合 = 孤儿,`sweepToTrash` 会把它收走。
 *
 * 这条 bug 能活这么久,是因为**没有任何套件覆盖这条路**(在 scripts 目录下搜
 * `importPdfFiles` 一个都搜不到)。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { hashFile, verifyPdf } from "@main/library/pdfFile.js";
import { pdfPathForHash, toLibraryRelative } from "@main/library/paths.js";
import { CollectionRepo, LibraryRepo } from "@main/store/repositories.js";
import { emitItemDownloaded, emitItemImported } from "./broadcast.js";
import { log } from "@main/lib/logger.js";

export interface ImportedFile {
  /** 原始路径(回报给用户看)。 */
  path: string;
  item?: LibraryItem;
  /** 同一份内容已经在库里了 —— 不算失败。 */
  alreadyPresent?: boolean;
  error?: string;
}

export async function importPdfFiles(input: {
  paths: string[];
  collectionIds?: string[];
}): Promise<ImportedFile[]> {
  const out: ImportedFile[] = [];
  for (const rawPath of input.paths) {
    out.push(await importOne(rawPath, input.collectionIds));
  }
  return out;
}

/**
 * 把刚入库的条目归到调用方选定的分类下。
 *
 * **`alreadyPresent` 那条路也要走** —— 用户选了分类导入,落点就该在那个分类里;
 * 而"这一份内容库里已经有了"并不改变这个诉求(而且它正是用户最需要它出现在分类里的
 * 场合:他刚在别处导入过,现在要把它放进这次的分类)。
 *
 * 分类 id 不存在时**跳过而不是抛** —— 与 `importIdentifiers` 那边的口径一致:一次导入
 * 批量着几十份,一个过期的分类 id 不该让整批都不入库。真正的报错留给调用方按
 * `errors` 回报。
 */
function assignToCollections(itemId: string, collectionIds: string[] | undefined): void {
  if (!collectionIds || collectionIds.length === 0) return;
  const known = new Set(CollectionRepo.list().map((c) => c.id));
  for (const cid of collectionIds) {
    if (!known.has(cid)) {
      log.warn(`library: 导入时指定的分类 ${cid} 不存在,跳过归属(${itemId})`);
      continue;
    }
    CollectionRepo.assign(cid, [itemId], true);
  }
}

async function importOne(rawPath: string, collectionIds?: string[]): Promise<ImportedFile> {
  try {
    if (!existsSync(rawPath)) return { path: rawPath, error: "文件不存在" };

    // 1. 校验
    const bad = verifyPdf(rawPath);
    if (bad) return { path: rawPath, error: bad };

    // 2 + 3. 按内容查重,并把字节收进库
    const sha = hashFile(rawPath);
    const dest = pdfPathForHash(sha);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) copyFileSync(rawPath, dest);
    const rel = toLibraryRelative(dest);

    const dup = LibraryRepo.findByPdfSha(sha);
    if (dup) {
      // 条目在、文件没记上(理论上不该发生)—— 补上,不然它会被当成"没 PDF"
      if (!dup.pdfPath) LibraryRepo.setPdf(dup.id, rel, sha);
      // **这条也要归属。** 用户选了分类导入,落点就该在那个分类里 —— 而"这一份内容
      // 库里已经有了"不改变这个诉求(反而更常见:他刚在别处导过,现在要把它放进这次的分类)。
      assignToCollections(dup.id, collectionIds);
      return { path: rawPath, item: { ...dup, pdfPath: dup.pdfPath ?? rel }, alreadyPresent: true };
    }

    // 4. 入库。标题取文件名 —— 核心不再从 PDF 里猜学术元数据(那是外部 MCP /
    //    自动化的事:它们可以在 `library:itemImported` 之后把标题改成正经的)。
    const item = LibraryRepo.upsert({ title: basename(rawPath, extname(rawPath)) });
    LibraryRepo.setPdf(item.id, rel, sha);
    // 归属要在**入库之后**(条目 id 才有),而在**事件之前** —— 事件起来的自动化
    // 会立刻去查这一条,它看到的状态该是已经归好类的。
    assignToCollections(item.id, collectionIds);
    log.info(`library: imported PDF ${basename(rawPath)} as ${item.id}`);
    // 成功点在这里:条目建好、PDF 也记上了。alreadyPresent 的不算 —— 那条本来就在库里,
    // 之前入库时已经发过事件,再发一次会让挂在事件上的自动化重复跑。
    const imported = { ...item, pdfPath: rel, pdfSha256: sha };
    emitItemImported(imported);
    return { path: rawPath, item: imported };
  } catch (err) {
    return { path: rawPath, error: (err as Error).message };
  }
}

/**
 * 把一份**本地 PDF 挂到已有条目**上 —— 外部下载器(外部 MCP 服务 / 自动化里的脚本)
 * 把文件弄到本地之后,靠这条把它交给库。
 *
 * 学术那套内置下载队列退役(2026-09-27)之后,"条目先有、文件后到"这条路就靠它:
 * 校验 → 按内容哈希落进 `papers/<ab>/<cd>/<sha>.pdf` → 写回条目 → 发
 * `library.item.downloaded`(自动化「下载完转 Markdown」听的正是这一条,见
 * `broadcast.ts`)。已经有 PDF 的条目要显式 `force` 才换。
 */
export function attachPdfToItem(
  itemId: string,
  rawPath: string,
  opts: { force?: boolean } = {},
): { ok: true; item: LibraryItem; replaced: boolean } | { ok: false; error: string } {
  const item = LibraryRepo.get(itemId);
  if (!item) return { ok: false, error: `库里没有这个 id:${itemId}` };
  if (item.pdfPath && !opts.force) return { ok: false, error: "这一条已经有 PDF 了(要换掉就把 force 打开)" };
  const bad = verifyPdf(rawPath);
  if (bad) return { ok: false, error: bad };
  const sha = hashFile(rawPath);
  const dest = pdfPathForHash(sha);
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) copyFileSync(rawPath, dest);
  const rel = toLibraryRelative(dest);
  LibraryRepo.setPdf(itemId, rel, sha);
  const updated = LibraryRepo.get(itemId)!;
  log.info(`library: attached PDF ${basename(rawPath)} to ${itemId}`);
  emitItemDownloaded(updated);
  return { ok: true, item: updated, replaced: Boolean(item.pdfPath) };
}
