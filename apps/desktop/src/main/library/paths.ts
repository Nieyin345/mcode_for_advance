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
 * 用户可以改**数据根**的位置(改的时候整体迁移)。存绝对路径的话,一改根全库失效;
 * 存相对路径只需要换一个根。
 *
 * ⚠️ "存相对路径"只解决**挪库**,不解决**越界** —— 记录里那个相对路径仍可能被人为
 * 写坏(`../../…`),读写前一律用 {@link isInsideLibrary} 判一道。
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SettingRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { LIBRARY_DOWNLOAD_CONCURRENCY_SETTING_KEY } from "@contracts/ipc";

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

/**
 * 这条库内相对路径是**一篇笔记**(用户继续改的那份),不是转录产物。
 *
 * ⚠️ **判据是落点,不是"有没有 mdPath"。** 早先这里按 `kind === "note"` 认,
 * kind 退役后一度改成"有 mdPath 且没有 pdfPath"—— 那是错的:转录产物挂上之后
 * `mdPath` 也为真,于是**再挂/换一份转录产物**这条路整条被堵死(报"笔记本身就是
 * Markdown,不需要再挂转录产物"),而这恰好是采纳那条路最主要的用法(重转一次、
 * 换成用户手上更好的一份)。
 *
 * 落点是这两类东西在磁盘上**唯一**的区别:笔记恒在 `notes/<id>.md`,转录产物在
 * `markdown/imported/<id>/`(或内容寻址的 `markdown/<sha>/`)。
 */
export function isNoteRelPath(relPath: string | undefined | null): boolean {
  if (!relPath) return false;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^notes\/[^/]+\.md$/i.test(normalized);
}

/** 导出产物的落点(引用格式导出的 `.bib` / `.txt` 放这儿)。
 *  和 PDF、Markdown 同处库根下 —— 用户备份或搬库时它跟着一起走。 */
export function exportsDir(): string {
  return join(libraryRoot(), "exports");
}

/**
 * 库根下的绝对路径 → 库内相对路径(**存库时**用)。
 *
 * ⚠️ **这是"切",不是"查"** —— 传进来一个库外的路径,它不会告诉你"越界了",只会
 * 从第 N 个字符开始切一段出来给你。判断"在不在库里"要用 {@link isInsideLibrary}。
 *
 * 早先两处删除/写入的守卫是拿这个函数的返回值来判的:
 *
 * ```ts
 * if (toLibraryRelative(abs).startsWith("..")) return;   // ← 拦不住
 * ```
 *
 * 传进去的是绝对路径,而 `slice` 永远切不出以 `..` 开头的结果 —— 所以那个条件恒假,
 * 守卫一次都没生效过(库外路径比库根**长**时切出来的是字符串中段,比如 `""` 或
 * `"x"`;比库根短时才是空串)。挡住的只是"路径比库根短"那一批,纯属巧合。
 * 那个写法仓库里只此一家,别的地方(`lib/fileSnapshot`、`plugins/pluginManager`)
 * 一律是 `relative()` + `isAbsolute()`。
 */
export function toLibraryRelative(absPath: string): string {
  return resolve(absPath).slice(resolve(libraryRoot()).length).replace(/^[/\\]/, "").split(sep).join("/");
}

/**
 * 这个绝对路径是不是落在**库根里面**。
 *
 * 判据和仓库里其它几处越界判断同一条:`relative()` 之后看有没有往上爬、有没有变成
 * 另一个盘的绝对路径。三档都要挡住:
 *
 * - 库外且比库根长(`C:/Windows/...`)—— 老写法放过去的那一批;
 * - 库外且比库根短(上一级目录、盘根)—— 老写法靠"切出来是空串"碰巧挡住;
 * - **前缀撞上但不是同一个目录**(库根是 `…/library`,兄弟目录 `…/library-old`)——
 *   `startsWith(库根)` 那种写法会把它当成库内,这是收口时必须一并挡掉的一档。
 *
 * 库根本身算库内(`relative` 给回空串)。
 */
export function isInsideLibrary(absPath: string): boolean {
  const rel = relative(libraryRoot(), resolve(absPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 库内相对路径 → 绝对路径(读文件时用)。 */
export function fromLibraryRelative(relPath: string): string {
  return join(libraryRoot(), ...relPath.split("/"));
}

/**
 * 一份 Markdown 产物**实际占的那一块** —— 删条目时该删的东西。
 *
 * ## 三种落点,两种是"整包"
 *
 * | 落点 | 是什么样的 |
 * |---|---|
 * | `markdown/<2>/<2>/<sha>.md` | 平的,本地 pdf.js 兜底转出来的 |
 * | `markdown/<2>/<2>/<sha>/full.md` | 整包(遗留),同级还有 `images/` |
 * | `markdown/imported/<条目 id>/xxx.md` | 「采纳 Markdown」收进来的,同级还有 `images/` |
 *
 * 后两种里,正文靠 `![](images:…)` 相对引用配图 —— 只删那个 `.md` 的话,几十张图会
 * 整包留在磁盘上,而且再也认不出是谁的。所以那两种要删**整个目录**。
 *
 * ## 为什么按结构认,不按名字认
 *
 * 早先这段判断写在 `ipc/library.ts`,判据是"父目录名像不像一个 sha256"
 * (`/^[0-9a-f]{64}$/.test(basename(dirname(md)))`)。它对「整包」那种成立,对**采纳的那包
 * 不成立**(目录名是 `li_…`)—— 于是采纳的 md 一删,`images/` 就永远留下。名字是猜;
 * 下面按**落点结构**认,三种形态各归各位,加第四种时也一眼看得出该往哪一档放。
 *
 * ## ⚠️ 认不出来时**只删文件**,默认不能是"删目录"
 *
 * 这一条是 2026-09-19 修的一个**数据丢失**:`mdPath` 是笔记时是 `<根>/notes/<id>.md`,
 * 而它**不在 `markdown/` 下面** —— 于是早期这版从 `markdown/` 数层数,数出来是 0 层,
 * 落进"整个目录"那一支,算出 `<根>/notes` 加递归。删一篇笔记会把**用户其它所有笔记**
 * 一起删掉。库根正下方、`exports/` 里那几种同样能一路算到库根本身。
 *
 * 根子上的错不是"少判了一种形状",而是**默认选错了一边**。两种猜错的后果不对称:
 * 猜成文件而其实是目录 → 那一包 `images/` 留下(看得见的垃圾,还能再删一次);
 * 猜成目录而其实是文件 → 不可恢复。所以判据反过来了:**只有明确认得出是那两种目录
 * 形状时才递归,其余一律只删传递进来的那个文件。**
 */
export function markdownArtifact(absMdPath: string): { path: string; recursive: boolean } {
  const abs = resolve(absMdPath);
  const root = resolve(libraryRoot());
  const parent = dirname(abs);
  // 从 `markdown/` 往下数 —— 但**先确认它真在 `markdown/` 下面**。不在的话下面数出来的
  // 层数是没有意义的(短路成 0 层后会被读成"整个目录"),而那种路径只可能是笔记那一类。
  const relFromMarkdown = relative(join(root, "markdown"), parent);
  const inside =
    relFromMarkdown === "" ||
    (!relFromMarkdown.startsWith("..") && !isAbsolute(relFromMarkdown));
  if (!inside) return flat(abs);
  const rel = relFromMarkdown.split(/[/\\]/).filter(Boolean);
  // 平的那种:正好两层,且两层都是两位的哈希前缀目录。
  // ⚠️ 两个条件**都要**判 —— 只看层数的话 `imported/<条目 id>` 也是两层,会被误判成
  // 平的那种,于是那一包的 `images/` 又漏掉了。
  if (rel.length === 2 && (rel[0] ?? "").length === 2 && (rel[1] ?? "").length === 2) {
    return flat(abs);
  }
  // 整包(遗留):`markdown/<2>/<2>/<sha>/full.md` —— 父目录是那条 sha 的目录,**三层**。
  // 前两层是哈希前缀(与 `hashedPath` 一致),第三层是完整 sha。
  if (rel.length === 3 && isPrefix(rel[0]) && isPrefix(rel[1]) && SHA256.test(rel[2] ?? "")) {
    return { path: parent, recursive: true };
  }
  // 采纳的:`markdown/imported/<条目 id>/xxx.md` —— 两层,头一层是字面量 `imported`。
  if (rel.length === 2 && rel[0] === "imported" && (rel[1] ?? "").length > 0) {
    return { path: parent, recursive: true };
  }
  // 认不出来 —— **不猜**。只删这个文件,不碰它周围的东西。
  return flat(abs);
}

/** 两位的哈希前缀目录(与 `hashedPath` 的分段一致)。 */
function isPrefix(s: string | undefined): boolean {
  return s !== undefined && /^[0-9a-f]{2}$/.test(s);
}

/** 完整的 sha256 小写十六进制。认不出形状时是**拒**,所以这里宁可窄一点。 */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * 一条文献的 PDF 对应的**全部可能 Markdown 落点** —— 不止 `mdPath` 指的那一份。
 *
 * ## 为什么需要它:有些产物不在 `mdPath` 上
 *
 * `md_path` 那一列**只有一个值**。一份 PDF 先被本地抽成一版(`markdown/<2>/<2>/<sha>.md`),
 * 后来用户拿外部工具(OCR / MinerU)重转一份并「采纳」进来 —— 列的指向换了,而**前
 * 一版仍然躺在盘上**。转录就是同一份文献的另一种形态,删的时候要一起收(用户的原话:
 * 「这个链接是 md 和图床一起的,要删都一起删掉」)。
 *
 * 所以这里按 PDF 的 sha 把两处都算出来,由调用方去重、去重后再删:
 *
 *   1. 内容寻址那一份(以及它那一种的整包目录形态)—— 由 `pdfSha256` 算;
 *   2. `mdPath` 自己指的落点。
 *
 * ⚠️ **同 sha 的 PDF 只有一份**(内容寻址),所以由 ① 算出来的路径天然是"这份 PDF 的
 * 档案,不管哪条记录指着它"。第二条按记录来 —— 采纳的那一包是按**条目 id** 落地的,
 * 别的记录不会有它。
 *
 * 返回值可能为空(既没有 sha 也没有 mdPath),调用方按空处理。
 */
export function markdownArtifactsOfItem(item: {
  pdfSha256?: string;
  mdPath?: string;
}): Array<{ path: string; recursive: boolean }> {
  const out: Array<{ path: string; recursive: boolean }> = [];
  const sha = item.pdfSha256;
  if (sha && SHA256.test(sha)) {
    // ① 平的:内容寻址那一份 `.md`
    out.push(flat(markdownPathForHash(sha)));
    // ② 整包(遗留):同 sha 的目录 `<2>/<2>/<sha>/full.md`
    out.push({ path: join(markdownDirForHash(sha), "full.md"), recursive: true });
  }
  if (item.mdPath) {
    const artifact = markdownArtifact(fromLibraryRelative(item.mdPath));
    out.push(artifact);
  }
  return out;
}

function flat(abs: string): { path: string; recursive: boolean } {
  return { path: abs, recursive: false };
}

/**
 * 数一数一个目录里有多少张图片(**只用于回报,不做筛选逻辑**)。
 *
 * 两个调用方,要的是同一个数:
 *   - `adoptMarkdown` 采纳完回报"收进来几张";
 *   - 删除前的预览回报"这一包图床有多大" —— 用户点「彻底删除」时要知道那一个勾
 *     带走的是几十张图还是空目录。
 *
 * 所以它住在这一层而不是各自一份:两处口径必须一致,否则"采纳时说 12 张、
 * 删除预览说 13 张"这种事迟早发生(而它们说的其实是同一个目录)。
 *
 * 读不动就返回已数到的那些 —— 它只是回报,不该让调用方失败。
 */
export function countImageFiles(dir: string): number {
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
 * 「整包产物」的**目录**落点 —— 正文 `.md` 与它同级的 `images/`。
 *
 * 为什么需要它:本地 pdf.js 抽出来的是纯文本,一个 `.md` 文件就够了;但带图的产物
 * 是 `full.md` **加上 `images/`** —— 正文里几十处 `![](images/xxx.jpg)`。只把
 * `full.md` 捞走、把图丢了的话,md 里全是断链。所以这类产物必须按**目录**落地,
 * 让相对路径 `images/…` 自然成立。
 *
 * ⚠️ **软件自己不再产出这种形态了**(从前产出它的是写死的 MinerU,已删)。
 * 现在唯一的来路是外部工具(用户的 `mineru` CLI、别的什么都行)转完之后
 * `library_adopt_markdown` 挂回来,而那条路落在 `markdown/imported/<条目 id>/`
 * —— 按条目 id 而不是 sha,因为外部工具跑的哪份 PDF 未必等于库里存的那份。
 * 这个函数现在只作为**遗留目录形态**存在:老库里已有的 `<sha>/full.md` 还要能被
 * 认出来、被删干净(`markdownArtifact` 那一档),冒烟也拿它当夹具。
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
