/**
 * 资料库领域类型。
 *
 * 与 `ipc.ts` 的分工:这里放**不做运行期校验的领域类型**(可以被主进程、渲染进程、
 * MCP server 共同引用);跨 IPC 的入参校验 schema 放 `ipc.ts` 的
 * `library` 分区,两者保持同名对应。
 *
 * ## 学术字段退役(2026-09-27)
 *
 * 资料库从"文献库"改成**通用**资料库:条目不再带 DOI / arXiv / 作者 / 年份 /
 * 期刊 / 卷期页 / 出版商 / 文献类型这些学术元数据,外部检索、PDF 自动下载、
 * 引用导出、期刊分区也一并搬出核心 —— 这些由外部 MCP 服务 + 自动化/工作流承担,
 * 核心只提供"文件条目 + 分类 + 笔记 + 关联 + 全文检索"这层通用地基。
 */

/**
 * 一条资料库条目。
 *
 * `pdfPath` / `mdPath` 一律是**相对库根目录**的路径 —— 库可以在设置里搬迁,
 * 存绝对路径会在搬迁后全部失效。
 */
export interface LibraryItem {
  id: string;
  title: string;
  /** 简介 / 摘要:用户或 AI 写的一段说明,可空。 */
  abstract?: string;
  /** BCP-47 语言标签,如 `zh` / `en`。 */
  language?: string;
  /** 来源地址(网页 / 落地页)。 */
  url?: string;
  /** 相对库根的 PDF 路径。没有时为 undefined。 */
  pdfPath?: string;
  /** PDF 内容的 sha256。内容寻址,天然去重。 */
  pdfSha256?: string;
  /** 相对库根的 Markdown 路径(PDF 转换产物),供 ripgrep 全文检索。 */
  mdPath?: string;
  /**
   * 通用文件条目的落法:`attached` = 文件复制进了库(相对库根),`linked` = 只记
   * 原路径、文件不动(可以是文件**或目录**)。统一资料库给 ppt/word/照片等开的口子
   * —— 旧的文献流(pdfPath/mdPath)不受它影响,老数据缺省按 attached 读。
   */
  entryMode: "linked" | "attached";
  /**
   * 通用文件路径:attached 时相对库根(随库搬迁),linked 时外部绝对路径(可为
   * 目录 —— 模版那种"目录即条目"的形状)。文献流用 pdfPath/mdPath,不填这里。
   */
  filePath?: string;
  addedAt: number;
  updatedAt: number;
}

/**
 * **条目之间的一条关联。**
 *
 * ## 形状是一对多，不是两两配对
 *
 * 一条条目可以关联**任意多个**目标（用户原话:「不是两两之间关联，可以一个关联多个文件」），
 * 所以这是从 `itemId` 出发的一批出边，而不是"两个条目配对"。反向查询
 * （`targetItemId = ?`）同样便宜，界面可以双向展示，但**存储只存一次** ——
 * 不产生"两边都要维护同步"的一致性问题。
 *
 * ## 目标可以是库内条目，也可以是库外文件
 *
 * `targetItemId` 与 `targetPath` **恰好有一个**（数据库层有 CHECK 约束）。
 *
 *  - `targetItemId`：库里的另一条条目。用户要的"PDF 和它的 MD 关联"就是这种
 *    （两份都在库里）。
 *  - `targetPath`：库外的绝对路径。用户明确要「可以一个关联多个文件」—— 桌面上的
 *    一份参考资料也该能挂上来。**UI 那条路会先把它导入成 `linked` 条目**
 *    （见 `entryMode`），所以这一支主要留给绕过 UI 的调用（将来的 AI 工具）。
 */
export interface LibraryItemLink {
  id: string;
  /** 从哪条条目出发。 */
  itemId: string;
  /** 关联到库里的哪条条目。与 `targetPath` 恰好有一个。 */
  targetItemId?: string;
  /** 关联到库外的哪个绝对路径。与 `targetItemId` 恰好有一个。 */
  targetPath?: string;
  createdAt: number;
}

/* ─────────────────────────── PDF 批注 ─────────────────────────── */

/**
 * 一条归一化矩形，坐标是 **0~1、左上原点** —— 就是高亮库（pdf.js 那一套）划一下
 * 得到的东西，**原样存**，不在这里换算。
 *
 * ## 为什么不做成"PDF 点值"
 *
 * 换算是**写回那一刻**才该做的事（见 `apps/desktop/src/main/library/pdfAnnotations.ts`）：
 * 页面尺寸可能变（不同版本的文件、裁剪框不同），存归一化的值永远对得上。
 *
 * `pageNumber` 从 **1** 数起（和用户看到的页码一致，不是 pdf.js 内部的 0 基）。
 */
export interface PdfHighlightRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  pageNumber: number;
}

/**
 * 一条用户在 PDF 上做的标注。
 *
 * ## 2026-09-22：从"只有高亮"扩成"库支持的全部标注类型"
 *
 * 用户的原话：「**你引入的库有什么功能我要什么**」「编辑之后不保存呀，也没有撤销」。
 * 库里 `PdfHighlighter` 支持六种，这里全接上 —— `type` 就是判别字段：
 *
 *  - `text` —— 划文字（默认）。跨行是**一个**记录、多个 rect。
 *  - `area` —— 框一块区域（图、公式、表格 —— 那些选不中文字的）。
 *  - `freetext` —— 在页面上直接打字写批注，不是弹窗里写。
 *  - `drawing` —— 手绘。
 *  - `shape` —— 矩形 / 圆 / 箭头。
 *  - `image` —— 贴一张图上去。
 *
 * ## 坐标
 *
 * 这些字段是 `react-pdf-highlighter-plus` 的 `ScaledPosition` 能用上的那部分 ——
 * 那个库还有个 `usePdfCoordinates` 开关，为真时坐标**不是归一化的**（是 PDF 点值），
 * 换算时必须区别对待，所以带上。
 */
export interface PdfHighlight {
  id: string;
  /**
   * 哪一种标注。
   *
   * ⚠️ **`type` 是可选的，缺席按 `text` 读** —— 这个字段是 2026-09-22 才加的，
   * 而用户手上已有的索引文件里没有它。那些全是文字高亮，所以缺席即 `text`
   * 是安全的重解释，**不需要迁移**。
   */
  type?: "text" | "area" | "freetext" | "drawing" | "shape" | "image";
  position: {
    boundingRect: PdfHighlightRect;
    rects: PdfHighlightRect[];
    /** 见上：为真时坐标是 PDF 点值、左下原点，**不能再翻 y / 不能乘页面尺寸**。 */
    usePdfCoordinates?: boolean;
  };
  /** 划中的文字（`text` 那一种才有）。也用来在列表里显示。 */
  text?: string;
  /**
   * 用户写的批注正文。
   *
   * ⚠️ **2026-09-22 起它只在 Mcode 内部用** —— 用户明确说了不要写回文件
   * （「我也不要在其他的软件上打开能修改编辑了」），所以它**不再进 PDF 的
   * `/Contents`**。`freetext` 那一种的正文也存这儿。
   */
  comment?: string;
  /** `#rrggbb`。不给就用默认那支黄。 */
  color?: string;
  /** `image` / `drawing` 那两种的位图（data URL PNG）。 */
  image?: string;
  /** `shape` 那一种的形状信息。 */
  shape?: {
    shapeType: "rectangle" | "circle" | "arrow";
    strokeColor: string;
    strokeWidth: number;
  };
  /** `freetext` 的字号（点）。 */
  fontSize?: string;
  createdAt: number;
}

/**
 * 界面上「关联」区的一行 —— 关联本身**加上它指向的那一头的摘要**。
 *
 * ## 为什么把摘要一起给,而不是让渲染端逐条去拉
 *
 * 一行关联要显示的是"另一头是谁":库内条目显示标题,库外路径显示文件名。若让渲染端
 * 自己拉,十个关联就是十次往返,而且其中一半的条目可能已经被删了(要去处理每个
 * 分页/缺失分支)。主进程一次查完,渲染端只管画。
 *
 * ## `direction` 决定"另一头"是哪一头
 *
 * 关联表**只存一行**、但界面双向展示:
 *
 *   - `out`:本条目指向别人 → 另一头是 `targetItemId` / `targetPath`;
 *   - `in`:别人指向本条目 → 另一头是 `itemId`(来源那条)。
 *
 * `other` 已经按这个规则算好了 —— 渲染端不必自己判方向。
 */
export interface LibraryLinkView {
  id: string;
  /** 从本条目看过去的方向。 */
  direction: "out" | "in";
  /** **另一头**。库内条目给 id,库外路径给绝对路径,恰好一种。 */
  otherItemId?: string;
  otherPath?: string;
  /** 另一头的显示名:库内是标题,库外是文件名。查不到(条目已删)时是空串。 */
  title: string;
  /**
   * 另一头的链接目标。库内条目是 `i:<id>`(可以挂进对话),库外路径是原始路径
   * —— 界面据此决定那一行能不能点。
   */
  attachKey?: string;
  /** 被屏蔽规则挡住时的原因(没被挡是 undefined)。界面显示成灰态 + 说明。 */
  suppressedReason?: string;
  createdAt: number;
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
  /**
   * 这个分类的**给 AI 的说明**(「这个合集是精读队列,总结用中文」这类)。
   * 拼进该分类的清单里,类型说明之后 —— 用户自己写的、关于"这一组东西怎么处理"的
   * 话,只有它自己知道。空 = 不注入。
   */
  prompt?: string;
  /** 这个分类挂在哪个大类下（kind 退役后的归属 —— 三级树：大类 → 分类 → 条目）。 */
  groupId?: string;
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
 * 就没有插图,转录工具也就不会产出 `images/`。所以判据是:
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
  /**
   * 转换产物的形态 —— **按落点分,不按谁转的**。
   *
   * | 值 | 落点 | 谁产的 |
   * |---|---|---|
   * | `local` | `markdown/<ab>/<cd>/<sha>.md`(平铺一个文件) | 本地 pdf.js 抽取 |
   * | `imported` | `markdown/imported/<条目 id>/xxx.md`(目录,同级有 `images/`) | 外部工具转好之后挂进来的 |
   * | `none` | 还没有 md | — |
   *
   * ⚠️ **不记"是哪个外部工具转的"**:Mcode 不再内置任何转录服务,谁转的是用户自己的事,
   * 软件看不见也不该猜。它只需要知道"这份 md 是不是一整包"—— 那决定了删条目时
   * 该删文件还是删目录(见 `main/library/paths.ts` 的 `markdownArtifact`)。
   */
  source: "local" | "imported" | "none";
}

