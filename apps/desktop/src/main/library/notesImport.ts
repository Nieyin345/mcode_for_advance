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
import { CollectionRepo, LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { ensureLibraryDirs, fromLibraryRelative, notePathForId, noteRelPathForId, toLibraryRelative } from "./paths.js";

export interface NoteImportSummary {
  items: LibraryItem[];
  added: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/** 认得的笔记扩展名。`.markdown` 少见但确实是合法的。 */
const NOTE_EXTS = new Set([".md", ".markdown", ".mdown", ".txt"]);

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

      // 同一个库里标题相同 = 认为已经收过了
      const dup = LibraryRepo.list({ kind: "note", query: title, limit: 50 }).items.some(
        (i) => i.title.trim().toLowerCase() === title.trim().toLowerCase(),
      );
      if (dup) {
        out.skipped += 1;
        continue;
      }

      const item = LibraryRepo.upsert({ kind: "note", title, source: "note" });
      const dest = notePathForId(item.id);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(path, dest);
      LibraryRepo.setMarkdown(item.id, noteRelPathForId(item.id));

      for (const cid of collectionIds ?? []) {
        CollectionRepo.assign(cid, [item.id], true);
      }

      const saved = LibraryRepo.get(item.id);
      if (saved) out.items.push(saved);
      out.added += 1;
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
  const item = LibraryRepo.upsert({ kind: "note", title: clean, source: "note" });
  const dest = notePathForId(item.id);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `# ${clean}

`, "utf8");
  LibraryRepo.setMarkdown(item.id, noteRelPathForId(item.id));
  for (const cid of collectionIds ?? []) CollectionRepo.assign(cid, [item.id], true);
  return LibraryRepo.get(item.id);
}

/**
 * 把编辑器的内容写回磁盘。
 *
 * 两道守卫:① **只允许改笔记** —— 论文/教材的 md 是转录产物,应用内的编辑器覆盖它
 * 会让"转录结果"和"用户改动"再也分不清;② 目标路径必须落在库内,防记录被写坏之后
 * 顺着越界路径覆盖到用户别处的文件。
 */
export function writeNote(id: string, text: string): { ok: boolean; error?: string } {
  const item = LibraryRepo.get(id);
  if (!item) return { ok: false, error: "找不到这篇笔记" };
  if (item.kind !== "note") return { ok: false, error: "只有笔记能在应用内编辑" };
  if (!item.mdPath) return { ok: false, error: "这篇笔记还没有对应的文件" };
  const abs = fromLibraryRelative(item.mdPath);
  if (toLibraryRelative(abs).startsWith("..")) return { ok: false, error: "路径越界,拒绝写入" };
  try {
    writeFileSync(abs, text, "utf8");
    // 正文里的第一个标题变了 → 列表行也跟着变,不然两处显示对不上
    const nextTitle = deriveNoteTitle(text, abs);
    if (nextTitle && nextTitle !== item.title) LibraryRepo.setTitle(id, nextTitle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入失败:${(err as Error).message}` };
  }
}
