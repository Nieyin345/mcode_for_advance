/**
 * 资料库条目 —— library_items 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { LibraryItem } from "@contracts/library";
import { getDb, persist } from "../db.js";
import { v, type BindValue } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

/* ──────────────────────────────── 文献库 ───────────────────────────────── */

/** 生成带前缀的本地 id。与 customModel 的 `cm_...` 同构,前缀区分实体类型,
 *  便于在日志与错误信息里一眼看出这是什么。 */
function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface LibraryItemRow {
  id: string;
  title: string;
  abstract: string | null;
  language: string | null;
  url: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  md_path: string | null;
  entry_mode: string | null;
  file_path: string | null;
  added_at: number;
  updated_at: number;
}

/**
 * 行 → 领域对象。
 *
 * 表里还留着一批**已退役的列**(kind / doi / arxiv_id / authors / year / venue /
 * volume / issue / page / publisher / type / source / license):学术那一套
 * (2026-09-27 起)整体搬出核心,交给外部 MCP 服务与自动化。sql.js 的 DROP COLUMN
 * 不可靠,沿用 kind 退役时的做法 —— 列留在库里、代码全面停止读写,`migrate()`
 * 里有一段注释记着这件事。
 */
function rowToLibraryItem(r: LibraryItemRow): LibraryItem {
  return {
    id: r.id,
    title: r.title,
    abstract: r.abstract ?? undefined,
    language: r.language ?? undefined,
    url: r.url ?? undefined,
    pdfPath: r.pdf_path ?? undefined,
    pdfSha256: r.pdf_sha256 ?? undefined,
    mdPath: r.md_path ?? undefined,
    // 老库 ALTER 出来的行全是 DEFAULT 'attached' —— 旧的文献流本来就是"文件在库里",
    // 语义正好对上。认不出(entry_mode 被手工改成别的)也按 attached:保守的那个方向。
    entryMode: r.entry_mode === "linked" ? "linked" : "attached",
    filePath: r.file_path ?? undefined,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  };
}

/** 列表筛选条件。`collectionId === undefined` 表示不限集合;`null` 保留给
 *  「不属于任何集合」这种未来可能的智能视图,当前与 undefined 同义。 */
export interface LibraryListFilter {
  collectionId?: string | null;
  query?: string;
  /** 只看有/没有文件的条目(pdf_path 或 file_path 任一有值算"有")。 */
  hasFile?: boolean;
  limit?: number;
  offset?: number;
}

export const LibraryRepo = {
  /** 按条件列出条目。`query` 在标题/作者/摘要/期刊上做大小写不敏感的子串匹配。
   *  注意:这是**元数据**检索;正文全文检索走 ripgrep(见 main/library/fulltext.ts),
   *  因为 sql.js 不含 FTS5。 */
  list(filter: LibraryListFilter = {}): { items: LibraryItem[]; total: number } {
    const db = getDb();
    const where: string[] = [];
    const params: BindValue[] = [];

    if (filter.collectionId) {
      where.push(
        "i.id IN (SELECT ci.item_id FROM library_collection_items ci WHERE ci.collection_id = ?)",
      );
      params.push(v(filter.collectionId));
    }
    if (filter.query?.trim()) {
      // LIKE 的转义:用户输入里的 % 和 _ 是通配符,必须转义才能当字面量搜
      const needle = `%${filter.query.trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      // ⚠️ 字段集合必须与 `operations.searchItems`(MCP `library_search` 的底)**一致**:
      // 那个搜 title / abstract / file_path / **url**,这里从前漏了 url —— 于是按 DOI/arXiv
      // 链接搜,AI 找得到、Ctrl+K 面板找不到。
      where.push(
        `(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(i.abstract,'')) LIKE ? ESCAPE '\\'
          OR LOWER(IFNULL(i.file_path,'')) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(i.url,'')) LIKE ? ESCAPE '\\')`,
      );
      params.push(v(needle), v(needle), v(needle), v(needle));
    }
    if (filter.hasFile === true) {
      where.push("(i.pdf_path IS NOT NULL OR i.file_path IS NOT NULL)");
    } else if (filter.hasFile === false) {
      where.push("(i.pdf_path IS NULL AND i.file_path IS NULL)");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM library_items i ${whereSql}`);
    const total = withStatement(countStmt, (query) => {
      query.bind(params);
      query.step();
      return Number((query.getAsObject() as { n: number }).n ?? 0);
    });

    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    // ⚠️ **带 `, id DESC` 兜底。** `added_at` 是 `Date.now()`(毫秒),一批导入会在同一
    // 毫秒里建很多行(SQLite 对并列行的顺序是未定义的,两次执行可能不同),而分页是
    // `LIMIT ? OFFSET ?` —— 并列组恰好跨在页边界时,条会被**静默跳过**(渲染端按 id 去重
    // 也发现不了)。这与会话分页(`listByProject`/`listAll`)是同一条,那边已补。
    const stmt = db.prepare(
      `SELECT i.* FROM library_items i ${whereSql} ORDER BY i.added_at DESC, i.id DESC LIMIT ? OFFSET ?`,
    );
    return withStatement(stmt, (query) => {
      query.bind([...params, v(limit), v(offset)]);
      const items: LibraryItem[] = [];
      while (query.step()) items.push(rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow));
      return { items, total };
    });
  },

  /**
   * 全部条目 —— **不分页**。
   *
   * 与 `list()` 只差一点:`list` 有 200 条的默认上限(左栏那棵树就是按页拉的),
   * 而**给 AI 的那份清单必须是全量**。少几条比慢一点糟得多:模型会以为库里就这些,
   * 用户也看不出少了什么,而两边都不会报错。
   * （原 `listByKind`：kind 退役后没有"按库"的口径，全量返回，调用方自行按分类过滤。）
   */
  listAllItems(): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items ORDER BY added_at DESC");
    return withStatement(stmt, (query) => {
      query.bind([]);
      const out: LibraryItem[] = [];
      while (query.step()) out.push(rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow));
      return out;
    });
  },

  /**
   * 每个库内路径被多少条记录引用着(pdf / md / 通用文件三列都算)。
   *
   * 「彻底删除」靠它判断一个文件还有没有别人在用,而**它不能由 `list()` 拼出来**:
   * `list` 有 200 条的默认上限,拿它当"全库"用,大库上就会漏判 —— 漏判的后果是
   * 删掉另一条记录的 PDF。
   *
   * 为什么真的会共用:PDF 按内容哈希寻址,**同一篇先用 DOI 导、又用 arXiv ID 导了
   * 一次**就是两条记录指向同一个路径。删掉其中一条时那个文件必须留下。
   *
   * ## ⚠️ `file_path` 这一列非数不可
   *
   * 通用条目(`entryMode` 那条流)的文件落在 `file_path` 上,不是 pdf/md。少了这一列,
   * 「彻底删除」在删 attached 副本时看到的是一张**不完整的引用表**:两条记录指着同一份
   * 副本时,删除方会以为自己是唯一的引用者,把文件端走 —— 而另一条记录还在库里,
   * 它从此指向一个不存在的文件(预览、打开、转录全部报"文件不在了")。
   *
   * **`linked` 的 `file_path` 是库外的绝对路径**,它也会被数进来。这是对的、且必须的:
   * 同一条库外路径被两条记录引用时,删掉其中一条同样不该动它(而且那份根本不是库管的,
   * 见 `ipc/library.ts` 的 `dropAbs`)。
   *
   * 数的是**记录的条数**而不是"有效引用数":一行 `file_path` 是 NULL 的行不该把计数
   * 抬起来(bump 里已经挡了空值),否则一条没有文件的记录会让别人以为"还有人在用"。
   */
  pathRefCounts(): Map<string, number> {
    const db = getDb();
    const stmt = db.prepare("SELECT pdf_path, md_path, file_path FROM library_items");
    const out = new Map<string, number>();
    const bump = (p: unknown) => {
      if (typeof p !== "string" || !p) return;
      out.set(p, (out.get(p) ?? 0) + 1);
    };
    return withStatement(stmt, (query) => {
      while (query.step()) {
        const row = query.getAsObject() as { pdf_path: unknown; md_path: unknown; file_path: unknown };
        bump(row.pdf_path);
        bump(row.md_path);
        bump(row.file_path);
      }
      return out;
    });
  },

  get(id: string): LibraryItem | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE id = ?");
    return withStatement(stmt, (query) => {
      query.bind([v(id)]);
      const found = query.step();
      return found ? rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow) : null;
    });
  },

  /** 按 DOI / arXiv ID 查已有条目 —— 入库前查重与下载前判重的唯一入口。 */
  findByPdfSha(sha256: string): LibraryItem | null {
    if (!sha256) return null;
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE pdf_sha256 = ? LIMIT 1");
    return withStatement(stmt, (query) => {
      query.bind([v(sha256)]);
      const found = query.step();
      return found ? rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow) : null;
    });
  },

  /**
   * 新建一条条目;给了 `id` 且已存在时**只补空字段**,不覆盖已有值(用户/AI 补过
   * 的内容不该被一次重复导入冲掉)。返回落库后的完整记录。
   *
   * 这里**没有任何按标识符去重**的逻辑:核心库不再认识 DOI / arXiv 那一套,
   * 文件的去重靠内容哈希(`findByPdfSha`)与路径(`findLinkedByPath`),由调用方先查。
   */
  upsert(input: {
    id?: string;
    title?: string;
    abstract?: string;
    language?: string;
    url?: string;
    /** 通用文件条目的落法。省略 = attached(旧的文献流就是这个语义)。 */
    entryMode?: "linked" | "attached";
    /** 通用文件路径:attached 相对库根 / linked 外部绝对路径(可为目录)。 */
    filePath?: string | null;
  }): LibraryItem {
    const db = getDb();
    const now = Date.now();
    const existing = input.id ? LibraryRepo.get(input.id) : null;

    if (existing) {
      db.run(
        `UPDATE library_items SET
           title = CASE WHEN (title IS NULL OR title = '') THEN ? ELSE title END,
           abstract = CASE WHEN (abstract IS NULL OR abstract = '') THEN ? ELSE abstract END,
           language = COALESCE(language, ?),
           url = COALESCE(url, ?),
           updated_at = ?
         WHERE id = ?`,
        [v(input.title ?? ""), v(input.abstract ?? ""), v(input.language), v(input.url), v(now), v(existing.id)],
      );
      persist();
      return LibraryRepo.get(existing.id)!;
    }

    const id = input.id ?? makeId("li");
    db.run(
      `INSERT INTO library_items
         (id, title, abstract, language, url, entry_mode, file_path, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v(id), v(input.title ?? "(无标题)"), v(input.abstract), v(input.language), v(input.url),
        v(input.entryMode ?? "attached"), v(input.filePath ?? null), v(now), v(now),
      ],
    );
    persist();
    return LibraryRepo.get(id)!;
  },

  /** 写入 PDF 落盘结果。`sha256` 一并存下,便于内容寻址与去重审计。 */
  setPdf(id: string, pdfRelPath: string, sha256: string): void {
    getDb().run("UPDATE library_items SET pdf_path = ?, pdf_sha256 = ?, updated_at = ? WHERE id = ?", [
      v(pdfRelPath), v(sha256), v(Date.now()), v(id),
    ]);
    persist();
  },

  /**
   * 按通用文件路径找一条 `linked` 条目(通用导入器的去重口)。
   *
   * 只服务 `linked`:它的 `file_path` 存的是**用户给的那个绝对路径原样**,所以有键可查。
   * `attached` 存的是 `<库根>/files/<条目 id>-<原名>` —— **id 是新建时才生成的**,
   * 落盘之前算不出来,而且库里不记来源路径,所以那一支没有可查的键(理由见
   * `fileImport.ts` 的 `findExisting`)。
   *
   * 直查而不是 `list()`:后者有 200 条上限(超了就翻不到,于是"重复导入"静默变成
   * "又建了一条"),而且要 `SELECT i.*` 拉回整表 —— 一次拖进 200 个文件就是 200 次
   * 全表读。这里按列查,走得上索引。
   */
  findLinkedByPath(absPath: string): LibraryItem | undefined {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM library_items WHERE entry_mode = 'linked' AND file_path = ? LIMIT 1",
    );
    return withStatement(stmt, (query) => {
      query.bind([v(absPath)]);
      return query.step()
        ? rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow)
        : undefined;
    });
  },

  /** 写通用文件路径(attached 的相对库根路径;linked 不走这里,建条目时就带上)。 */
  setFilePath(id: string, relPath: string): void {
    getDb().run("UPDATE library_items SET file_path = ?, updated_at = ? WHERE id = ?", [
      v(relPath), v(Date.now()), v(id),
    ]);
    persist();
  },

  /**
   * 转换情况统计:总数 / 已转 Markdown / 还没转。
   *
   * 给设置页的「批量检测」用。**在 SQL 里数**而不是把全库拉进渲染端再数 ——
   * 库上千篇时那是几 MB 的 IPC 流量换一个数字。
   */
  conversionStats(): { total: number; converted: number; pending: number } {
    const db = getDb();
    const countOf = (sql: string): number => {
      const stmt = db.prepare(sql);
      return withStatement(stmt, (query) => {
        query.step();
        return Number((query.getAsObject() as { n: number }).n ?? 0);
      });
    };
    const total = countOf("SELECT COUNT(*) AS n FROM library_items");
    const converted = countOf(
      "SELECT COUNT(*) AS n FROM library_items WHERE md_path IS NOT NULL AND md_path <> ''",
    );
    return { total, converted, pending: Math.max(0, total - converted) };
  },

  /** 写入 Markdown 转换产物(供 ripgrep 全文检索)。 */
  /** 改标题。目前只给笔记用:用户在应用内编辑正文、改了 `# 标题` 时同步列表行。 */
  setTitle(id: string, title: string): void {
    getDb().run("UPDATE library_items SET title = ?, updated_at = ? WHERE id = ?", [
      v(title), v(Date.now()), v(id),
    ]);
    persist();
  },

  /** 换掉这一条的来源地址(详情页上那个"打开原文"的链接)。 */
  setUrl(id: string, url: string): void {
    getDb().run("UPDATE library_items SET url = ?, updated_at = ? WHERE id = ?", [
      v(url), v(Date.now()), v(id),
    ]);
    persist();
  },

  setMarkdown(id: string, mdRelPath: string): void {
    getDb().run("UPDATE library_items SET md_path = ?, updated_at = ? WHERE id = ?", [
      v(mdRelPath), v(Date.now()), v(id),
    ]);
    persist();
  },

  clearMarkdown(id: string): void {
    getDb().run("UPDATE library_items SET md_path = NULL, updated_at = ? WHERE id = ?", [v(Date.now()), v(id)]);
    persist();
  },

  /** 从库中移除记录。磁盘文件由调用方决定是否删除 —— repo 不碰文件系统。 */
  delete(ids: string[]): void {
    if (ids.length === 0) return;
    const db = getDb();
    // Start the transaction BEFORE preparing a statement. If BEGIN throws,
    // allocating first would leak the already-prepared statement. Keep the
    // original atomic rollback for a failure at any item in the batch.
    db.run("BEGIN");
    try {
      const stmt = db.prepare("DELETE FROM library_items WHERE id = ?");
      withStatement(stmt, (query) => {
        for (const id of ids) query.run([v(id)]);
      });
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /** 按 id 批量取 —— 给「AI 读某个 collection」的上下文拼装用。 */
  getMany(ids: string[]): LibraryItem[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE id = ?");
    return withStatement(stmt, (query) => {
      const out: LibraryItem[] = [];
      for (const id of ids) {
        query.bind([v(id)]);
        if (query.step()) out.push(rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow));
        query.reset();
      }
      return out;
    });
  },

  /** 某个集合内的全部条目(按加入时间倒序)。
   *
   *  ⚠️ **只看这一层,不递归** —— 分类是树(`parent_id`),而"哪些条目会跟着这个分类
   *  一起消失"要连子分类一起算。那种要用 {@link listByCollectionTree}。 */
  listByCollection(collectionId: string): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT i.* FROM library_items i
       JOIN library_collection_items ci ON ci.item_id = i.id
       WHERE ci.collection_id = ?
       ORDER BY ci.added_at DESC`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(collectionId)]);
      const out: LibraryItem[] = [];
      while (query.step()) out.push(rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow));
      return out;
    });
  },

  /**
   * 某个集合**以及它整棵子树**里的全部条目。
   *
   * ## 为什么与 `listByCollection` 是两个方法,而不是给它加个 `recursive` 开关
   *
   * 两个调用方的语义是**真的不同**,不是同一个问题的两种答案:
   *
   *  - 「打开这个分类,看看里面有什么」→ `listByCollection`(这一层)。左栏点一下
   *    「方法」只该看到直接挂在「方法」上的那些;把子分类里的也摊进来,用户会以为
   *    这个分类里凭空多了一堆东西。
   *  - 「删掉这个分类,哪些条目会跟着没归属」→ 本方法。子分类是**跟着一起被 CASCADE
   *    删掉的**,它们里面的成员关系也一起没了 —— 只看这一层就会漏掉一整棵子树,
   *    那些条目从此既不在任何分类里、也没被收进回收站(见 `library/trash.ts` 文件头
   *    警告的那种"界面上找不回来的僵尸记录")。
   *
   * ## 实现
   *
   * 递归 CTE。**实测 sql.js 支持 `WITH RECURSIVE`**(它是 SQLite 的编译期特性,不是
   * 扩展),所以不需要在 JS 里一层层 BFS —— 那种写法要在应用层复刻一遍"树"的概念,
   * 而树的真相在 `parent_id` 那一列上。
   *
   * `UNION`(不是 `UNION ALL`)顺带挡掉数据被写坏时的环(`a → b → a`):那种情况下
   * `UNION ALL` 会一直递归下去把进程挂死。`parent_id` 上的外键不防环。
   */
  listByCollectionTree(collectionId: string): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM library_collections WHERE id = ?
         UNION
         SELECT c.id FROM library_collections c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT i.* FROM library_items i
       JOIN library_collection_items ci ON ci.item_id = i.id
       WHERE ci.collection_id IN (SELECT id FROM subtree)
       ORDER BY ci.added_at DESC`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(collectionId)]);
      const out: LibraryItem[] = [];
      while (query.step()) out.push(rowToLibraryItem(query.getAsObject() as unknown as LibraryItemRow));
      return out;
    });
  },

  /** 库内条目总数(界面概览用)。 */
  count(): number {
    const db = getDb();
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_items");
    return withStatement(stmt, (query) => {
      query.step();
      return Number((query.getAsObject() as { n: number }).n ?? 0);
    });
  },
};
