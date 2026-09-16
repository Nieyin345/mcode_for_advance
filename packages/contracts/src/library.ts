/**
 * 文献库领域类型。
 *
 * 与 `ipc.ts` 的分工:这里放**不做运行期校验的领域类型**(可以被主进程、渲染进程、
 * 未来可能的 MCP server 共同引用);跨 IPC 的入参校验 schema 放 `ipc.ts` 的
 * `library` 分区,两者保持同名对应。
 *
 * ## 为什么作者用 CSL 风格的对象而不是 `firstName`/`lastName` 两个字段
 *
 * 中文姓名没有可靠的「名/姓」切分,拆成两列会把「张三」「欧阳锋」这类姓名存错。
 * 所以作者统一用 CSL 的三种写法:`family`+`given`(西文)、`literal`(中日韩等
 * 不便切分的名字)。展示时由渲染层按语言决定顺序,存储层不做假设。
 */

/** 单条作者。三选一:西文给 `family`/`given`,中日韩等给 `literal`。 */
export interface LibraryAuthor {
  family?: string;
  given?: string;
  /** 整体姓名,不做姓/名切分(中文、机构作者、集体署名等)。 */
  literal?: string;
}

/**
 * 三个**平级**的库:论文库 / 教材库 / 笔记库。
 *
 * ## 为什么是一个字段而不是三张表
 *
 * 用户要的是「同级」—— 指左栏里三个并列的入口、各自有自己的一套分类,而不是三套
 * 完全独立的数据结构。这三者在数据上**几乎完全同构**:都要标题/作者/年份、都要能挂
 * 到分类里、都要能被对话引用。差别只有两点:
 *   - 笔记是 **Markdown 源文件**(用户自己的东西),论文与教材是 **PDF**(要抓元数据、
 *     要转 Markdown 才能被 AI 读);
 *   - 教材的元数据来源更依赖文件名(ISBN 那条路没接)。
 *
 * 做成三张表的话,查重、集合归属、对话引用、md 预览、全文检索全都要写三遍 —— 而它们
 * 的差别用两个 `if` 就能表达。所以一个 `kind` 字段,配三个界面入口。
 */
export const LIBRARY_KINDS = ["paper", "textbook", "note"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/**
 * 这个字符串是不是一个库类目。
 *
 * 收 `unknown` 而不是 `string`:它多半是拿**外面的**值来问的(附件键、清单文件名的
 * 一段、参数里的自由数据),那些地方的值什么类型都可能是。先收窄再判,调用方就不用
 * 各写一遍 `typeof x === "string" &&`。
 *
 * 放在 contracts 是因为它曾经在**两个地方各写了一遍**(主进程的清单生成、渲染端的
 * 标签映射)—— 再加一处就是第三份,而三份判据迟早对不上。
 */
export function isLibraryKind(value: unknown): value is LibraryKind {
  return typeof value === "string" && (LIBRARY_KINDS as readonly string[]).includes(value);
}

/** 文献类型。取值贴近 BibTeX/CSL,便于导出时不丢信息。 */
export type LibraryItemType =
  | "article"
  | "inproceedings"
  | "book"
  | "thesis"
  | "preprint"
  | "report"
  | "other";

/**
 * 一条文献记录。
 *
 * `pdfPath` / `mdPath` 一律是**相对库根目录**的路径 —— 库可以在设置里搬迁,
 * 存绝对路径会在搬迁后全部失效。
 */
export interface LibraryItem {
  id: string;
  /** 属于哪个库。老数据默认 `paper`(见 `LibraryKind`)。 */
  kind: LibraryKind;
  /** 小写化的 DOI(不含 `https://doi.org/` 前缀)。去重主键之一。 */
  doi?: string;
  /** arXiv ID(不含 `arXiv:` 前缀)。去重主键之一。 */
  arxivId?: string;
  title: string;
  authors: LibraryAuthor[];
  year?: number;
  /** 期刊/会议名。 */
  venue?: string;
  /** 卷(期刊)。GB/T 7714 与 APA 都要用,缺了就只能省略。 */
  volume?: string;
  /** 期 / 期号(BibTeX 里是 `number`)。 */
  issue?: string;
  /** 起止页码。存字符串而不是数字区间 —— 期刊页码有 `1234-1240`、
   *  `e0123456`、`S1-S8` 等多种形态,切片成数字必然丢信息。 */
  page?: string;
  /** 出版商(图书 / 学位论文常用)。 */
  publisher?: string;
  abstract?: string;
  type: LibraryItemType;
  /** BCP-47 语言标签,如 `zh` / `en`。用于决定作者名的展示顺序。 */
  language?: string;
  /** 出版商/落地页地址。 */
  url?: string;
  /** 相对库根的 PDF 路径。未下载时为 undefined。 */
  pdfPath?: string;
  /** PDF 内容的 sha256。内容寻址,天然去重。 */
  pdfSha256?: string;
  /** 相对库根的 Markdown 路径(PDF 转换产物),供 ripgrep 全文检索。 */
  mdPath?: string;
  /** 元数据来源渠道,如 `crossref` / `arxiv` / `manual`。 */
  source?: string;
  /** PDF 的许可标识(如 `CC-BY-4.0`)。合规追溯用。 */
  license?: string;
  addedAt: number;
  updatedAt: number;
}

/**
 * 集合 —— Zotero 式的分组。
 *
 * 支持嵌套(`parentId`),一篇文献可同时属于多个集合(多对多),这是刻意的:
 * 「按方法分」和「按项目分」是两个正交的维度,强制单归属会逼用户二选一。
 */
export interface LibraryCollection {
  id: string;
  name: string;
  /** 这个分类属于哪个库 —— 三个库各有各的分类树,互不串味。 */
  kind: LibraryKind;
  /** 顶层集合为 null。 */
  parentId: string | null;
  sortOrder: number;
  createdAt: number;
  /**
   * 这个分类是不是它那个库的**回收站**。
   *
   * 界面靠它把语义分开:**在回收站里删东西是真正的删除**(数据库行 + 磁盘上的
   * PDF / Markdown),在其他任何地方删都只是把它移出这个分组(沦为孤儿后自动落进
   * 回收站)。少了这个标记,回收站里的右键菜单只能给出「从当前文献库移除」——
   * 那句话在那儿的意思恰好相反:它会把条目摘出回收站,于是条目既不在回收站里、
   * 也没被删掉,变成一个界面上找不回来的僵尸记录。
   *
   * 识别规则(名字、设置键、老数据的回退)全在 `main/library/trash.ts`,由主进程
   * 在返回分类列表时标上 —— **它不由数据库列决定**,因为用户自己也能建一个叫
   * 「回收站」的分类,而那个同样是回收站。
   */
  isTrash: boolean;
}

/**
 * 机构认证档案。
 *
 * ⚠️ **它不是凭据容器。** 真正的登录态存在于内嵌浏览器的共享分区里
 * (见 `main/browser/BrowserManager.ts` 的 cookie 保管库),与本表无关。
 * 本表只是让用户记下「我常用哪几个入口、它们的域名是什么」的组织性便利记录,
 * 删除它不会登出任何站点。
 *
 * 之所以这样设计:用户要求认证「偏通用、不限制具体机构」,而共用分区正好满足
 * ——在哪里登录都算数,无需先声明机构。若做成每机构独立凭据空间,反而要求用户
 * 先声明才能登录。
 */
export interface InstitutionProfile {
  id: string;
  name: string;
  /** 点击「登录」时在内嵌浏览器打开的地址。 */
  loginUrl?: string;
  /** 该入口覆盖的域名,用于在界面上提示凭据覆盖范围。 */
  domains: string[];
  /** 可选的 EZproxy 前缀,如 `https://ezproxy.example.edu/login?url=`。 */
  proxyPrefix?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 下载任务状态。
 *
 * `needs_login` 是一等状态而非错误 —— 认证过期是**预期的正常情况**,
 * 必须让用户看到「去登录」的明确指引,而不是一条含糊的失败。
 */
export type DownloadStatus =
  | "pending"
  | "running"
  | "done"
  /** 认证失效:需要用户去内嵌浏览器重新登录。不自动重试。 */
  | "needs_login"
  /** 所有来源都找不到可下载的 PDF。 */
  | "not_found"
  /** 网络/代理问题。可指数退避重试。 */
  | "rate_limited"
  | "failed";

/** 一条下载任务。同一文献重试会累加 `attempts` 而不是新建行。 */
export interface DownloadJob {
  id: string;
  itemId: string;
  status: DownloadStatus;
  attempts: number;
  /** 最近一次失败的原因,给用户看的简短说明。 */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 界面上展示的 PDF 可用性。
 *
 * 由 `LibraryItem.pdfPath` 与最新一条 `DownloadJob` 共同推导 —— 单独看任何一个
 * 都不够:有任务不代表有文件(可能还在跑或已失败),有文件也不代表任务已完成
 * (可能是手动导入的)。
 */
export type PdfState = "none" | "queued" | "downloading" | "ready" | "needs_login" | "failed";

/** 由文献记录与最新下载任务推导 PDF 状态。 */export function derivePdfState(
  item: Pick<LibraryItem, "pdfPath">,
  job: Pick<DownloadJob, "status"> | null,
): PdfState {
  if (item.pdfPath) return "ready";
  if (!job) return "none";
  switch (job.status) {
    case "done":
      // 任务说完成了但没有文件 —— 文件被外部删掉了,当作没有,让用户重下
      return "none";
    case "pending":
      return "queued";
    case "running":
      return "downloading";
    case "needs_login":
      return "needs_login";
    case "not_found":
    case "rate_limited":
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

/** 文献的展示用作者串(如「张三, 李四, et al.」)。渲染层与主进程共用,避免两处规则漂移。 */
export function formatAuthorList(authors: LibraryAuthor[], max = 3): string {
  const names = authors.map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(" "));
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, et al.`;
}

/**
 * 这条记录**缺哪些**关键字段(界面上出「待补全」标记,并说明缺的是什么)。
 *
 * ## 为什么**只对论文**有意义
 *
 * 这个标记存在的唯一理由是:**引用格式会因为它而不完整**(作者、年份、期刊是引用
 * 必须的)。而引用只对论文有意义 —— 教材不写进参考文献,笔记根本不是文献。所以另外
 * 两个库一律返回空:它们没有"元数据待补全"这回事,挂着这个标只是消不掉的黄条。
 *
 * 用户的原话:「这些什么引用之类的,教材还有笔记不需要」。
 *
 * ## 论文内部的两条例外
 *
 *   - **预印本不要求 venue**:arXiv 上的预印本本来就没有期刊名,拿"venue 为空"去判
 *     会永远报假警 —— 一个总在响的告警等于没有告警。
 *   - 其余情况下作者与年份必填。
 *
 * 返回**字段名而不是布尔值**:界面要能说清"缺的是年份还是作者" —— 只说"待补全",
 * 用户还得自己去比对哪一项是空的。
 */
export type MissingMetadataField = "authors" | "year" | "venue";

export function missingMetadataFields(
  item: Pick<LibraryItem, "authors" | "year" | "venue" | "type" | "kind">,
): MissingMetadataField[] {
  if (item.kind !== "paper") return [];
  const missing: MissingMetadataField[] = [];
  if (item.authors.length === 0) missing.push("authors");
  if (!item.year) missing.push("year");
  if ((item.type === "article" || item.type === "inproceedings") && !item.venue) {
    missing.push("venue");
  }
  return missing;
}

/** 是否缺关键字段。列表标记用它,详情面板用 `missingMetadataFields` 说缺什么。 */
export function needsMetadata(
  item: Pick<LibraryItem, "authors" | "year" | "venue" | "type" | "kind">,
): boolean {
  return missingMetadataFields(item).length > 0;
}

/** 外部检索的一条命中。尚未入库 —— 是给 AI/用户挑选的候选。 */
export interface ExternalSearchResult {
  /** 命中的来源渠道。`semantic` = Semantic Scholar(会议论文与被引数的补充源)。 */
  source: "arxiv" | "crossref" | "openalex" | "europepmc" | "semantic" | "unknown";
  doi?: string;
  arxivId?: string;
  title: string;
  authors: LibraryAuthor[];
  year?: number;
  venue?: string;
  /** 卷 / 期 / 页码 / 出版商 —— 引用格式要用。Crossref 会给,arXiv 没有。 */
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  abstract?: string;
  /** 被引数。判断一篇重不重要最直接的信号 —— Crossref / OpenAlex / Semantic
   *  Scholar / Europe PMC 都会给,arXiv 没有(预印本没有引用统计)。 */
  citationCount?: number;
  /** 是否已知存在可下载的开放获取 PDF。用于让用户优先挑能下的。 */
  hasOpenAccessPdf?: boolean;
  url?: string;
}

/**
 * 一条**读文献时记的笔记**(挂在某个条目下)。
 *
 * 与「笔记库」(kind === "note")是两件不同的事,不要混:
 *   - 笔记库:用户自己写的一篇篇 Markdown,**本身就是条目的全部内容**;
 *   - 这里:读某篇论文/教材时随手记的一两段,**依附于那个条目**。
 *
 * Zotero 也是这么分的(child notes vs standalone notes)。表在建库时就备好了,
 * 只是一直没接 UI。
 */
export interface LibraryNote {
  id: string;
  /** 挂在哪个条目上。条目删了它跟着删(外键 ON DELETE CASCADE)。 */
  itemId: string;
  content: string;
  /** 谁写的:`user` 是用户自己,`ai` 留给以后让模型写笔记时用。 */
  origin: "user" | "ai";
  createdAt: number;
  updatedAt: number;
}

/** 全文检索(ripgrep)的一条命中。 */
export interface FullTextMatch {
  itemId: string;
  title: string;
  /** 命中所在文件的库内相对路径。 */
  relativePath: string;
  lineNumber: number;
  lineText: string;
}

/**
 * 某个域名的登录态概览。
 *
 * 从浏览器分区的 cookie 反推 —— 这是「已登录哪些站点」唯一可靠的判据。
 * `expiresAt` 取该域名下 cookie 的最晚过期时间(会话 cookie 记 undefined)。
 */
export interface AuthSiteStatus {
  domain: string;
  cookieCount: number;
  /** 最晚过期时间(秒级 Unix 时间戳)。全部为会话 cookie 时为 undefined。 */
  expiresAt?: number;
  /** 是否命中用户配置的机构档案 —— 命中则界面上归到该机构名下展示。 */
  matchedProfileIds: string[];
}

/**
 * 一篇文献的转换完整度。
 *
 * ## 什么叫「完整」
 *
 * 用户的要求是「**md 和图床都有**才算完整」—— 但"有图"不能一概而论:很多论文本来
 * 就没有插图,MinerU 也就不会产出 `images/`。所以判据是:
 *
 *   **有 md,且 md 里引用到的图片在磁盘上都在。**
 *
 * 没有图片引用的 md(pdf.js 抽的纯文本、或者本来无图的论文)一样算完整 —— 否则
 * 那些文献永远显示"未完成",而这个标志就没意义了。
 */
export interface LibraryConversionRow {
  id: string;
  title: string;
  hasPdf: boolean;
  hasMd: boolean;
  /** md 里引用的图是否都落盘了。没有引用也算 true。 */
  assetsOk: boolean;
  /** md 里 `![](…)` 的引用数。0 = 这篇本来就没有图。 */
  imageRefs: number;
  /** md 与图床都齐 —— 这才算「完整」。 */
  complete: boolean;
  /** 转换产物的形态:mineru 出的是目录(full.md + images/),pdfjs 是平铺的 .md。 */
  source: "mineru" | "pdfjs" | "none";
}

