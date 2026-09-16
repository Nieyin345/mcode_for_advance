/**
 * 文献库的磁盘布局。
 *
 * ## 目录结构
 *
 * ```
 * <库根>/
 *   papers/<ab>/<cd>/<sha256>.pdf      ← 内容寻址
 *   markdown/<ab>/<cd>/<sha256>.md     ← 转换产物(供 ripgrep 全文检索)
 *   tmp/                                ← 下载中转,成功后才移入 papers/
 * ```
 *
 * ## 为什么内容寻址(按 sha256 命名)而不是按标题
 *
 * 三个理由:① 同一篇从 arXiv 和出版商各下一份,内容相同则自然合并,天然去重;
 * ② 标题含中文、空格、标点、超长,做文件名在各平台都会踩坑;③ 文件被外部改名/
 * 移动时,哈希仍能证明它是同一份内容。
 *
 * 两级 hex 前缀(`ab/cd/`)是为了避免单目录下堆几万个文件 —— 与 Git 对象库同构。
 *
 * ## 为什么一律存相对路径
 *
 * 用户可以在设置里改库位置(需求明确要求)。存绝对路径的话,一改库位置全库失效;
 * 存相对路径只需要换一个根。
 */
import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SettingRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { LIBRARY_ROOT_SETTING_KEY, LIBRARY_DOWNLOAD_CONCURRENCY_SETTING_KEY } from "@contracts/ipc";

/**
 * 库根目录 —— **统一数据根下的 `library/`**(`<数据根>/library`)。
 *
 * 早先这里读 `LIBRARY_ROOT_SETTING_KEY` 单独配、默认在 `<userData>/library`;现在
 * 统一到数据根下(用户要求「文献库、模版库、聊天记录放在一起,改路径时整体迁移」)。
 * 位置上仍然**一律存相对路径** —— 换根只换指向,不会让已有记录失效,理由见文件头。
 */
export function libraryRoot(): string {
  return join(dataRoot(), "library");
}

/** 确保库的骨架目录都在。幂等 —— 每次写入前调用即可。 */
export function ensureLibraryDirs(): string {
  const root = libraryRoot();
  for (const sub of ["papers", "markdown", "tmp", "exports", "notes"]) {
    try {
      mkdirSync(join(root, sub), { recursive: true });
    } catch {
      /* 已存在或权限不足 —— 交给后续写入报错,这里不吞掉为致命错误 */
    }
  }
  return root;
}

/** 笔记的落点 —— 按**条目 id** 命名,不按内容哈希。
 *
 *  与 PDF 的内容寻址刻意不同:笔记是用户会继续改的东西,按哈希命名的话每存一次
 *  路径就变一次,引用、缓存、md 预览全都要跟着重算。按 id 命名则"这篇笔记就是
 *  这个文件",改多少次都还在那儿。 */
export function notePathForId(id: string): string {
  return join(libraryRoot(), "notes", `${id}.md`);
}

/** 笔记的库内相对路径(存库用)。 */
export function noteRelPathForId(id: string): string {
  return `notes/${id}.md`;
}

/** 导出产物的落点(引用格式导出的 `.bib` / `.txt` 放这儿)。
 *  和 PDF、Markdown 同处库根下 —— 用户备份或搬库时它跟着一起走。 */
export function exportsDir(): string {
  return join(libraryRoot(), "exports");
}

/** 库根下的绝对路径 → 库内相对路径(存库时用)。 */
export function toLibraryRelative(absPath: string): string {
  return resolve(absPath).slice(resolve(libraryRoot()).length).replace(/^[/\\]/, "").split(sep).join("/");
}

/** 库内相对路径 → 绝对路径(读文件时用)。 */
export function fromLibraryRelative(relPath: string): string {
  return join(libraryRoot(), ...relPath.split("/"));
}

/** 两级 hash 前缀的落点。`ext` 不带点。 */
function hashedPath(kind: "papers" | "markdown", sha256: string, ext: string): string {
  const a = sha256.slice(0, 2);
  const b = sha256.slice(2, 4);
  return join(libraryRoot(), kind, a, b, `${sha256}.${ext}`);
}

export function pdfPathForHash(sha256: string): string {
  return hashedPath("papers", sha256, "pdf");
}

export function markdownPathForHash(sha256: string): string {
  return hashedPath("markdown", sha256, "md");
}

/**
 * MinerU 那次转换的**整包落点**(目录)。
 *
 * 为什么需要它:本地 pdf.js 抽出来的是纯文本,一个 `.md` 文件就够了;但 MinerU 给出
 * 的是 `full.md` **加上 `images/`** —— 正文里几十处 `![](images/xxx.jpg)`。只把
 * `full.md` 捞走、把图丢了的话,md 里全是断链。所以 MinerU 的产物必须按**目录**
 * 落地,让相对路径 `images/…` 自然成立。
 *
 * 两种形态并存没问题:`mdPath` 指向各自真正的那份 `.md`(平的或目录里的),
 * 全文检索扫的是 `markdown/**\/*.md`,两种都能扫到。
 */
export function markdownDirForHash(sha256: string): string {
  const a = sha256.slice(0, 2);
  const b = sha256.slice(2, 4);
  return join(libraryRoot(), "markdown", a, b, sha256);
}

/** 下载中转文件。用任务 id 命名,避免并发下载互相覆盖。 */
export function tempDownloadPath(jobId: string): string {
  return join(libraryRoot(), "tmp", `${jobId}.part`);
}

/** 下载并发上限。默认 2 —— 并发过高会与用户手动浏览抢同一个会话的带宽,反而更慢。 */
export function downloadConcurrency(): number {
  const raw = Number(SettingRepo.get(LIBRARY_DOWNLOAD_CONCURRENCY_SETTING_KEY));
  return Number.isFinite(raw) && raw >= 1 && raw <= 8 ? Math.floor(raw) : 2;
}

/** 库内文件是否存在。 */
export function libraryFileExists(relPath: string | undefined): boolean {
  return Boolean(relPath) && existsSync(fromLibraryRelative(relPath!));
}
