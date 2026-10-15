/**
 * 资料库链接 —— library_item_links 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { LibraryItemLink, LibraryLinkView } from "@contracts/library";
import { basename } from "node:path";
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { makeId } from "./makeId.js";

/* ─────────────────────────────── 条目关联 ─────────────────────────────── */
/* 见 contracts/src/library.ts 的 `LibraryItemLink`,以及 db.ts 里那张表的注释。
   形状是「一条条目 → 一批目标」,不是两两配对。 */

interface LinkRow {
  id: string;
  item_id: string;
  target_item_id: string | null;
  target_path: string | null;
  created_at: number;
}

function rowToLink(r: LinkRow): LibraryItemLink {
  return {
    id: r.id,
    itemId: r.item_id,
    // 两列恰好有一列非空(表上有 CHECK)。读的时候按同一个规则还原成可选字段。
    ...(r.target_item_id !== null ? { targetItemId: r.target_item_id } : {}),
    ...(r.target_path !== null ? { targetPath: r.target_path } : {}),
    createdAt: r.created_at,
  };
}

export const LibraryLinkRepo = {
  /**
   * 这条条目关联出去的全部目标,**以及指向它的那些**(反向)。
   *
   * 两个方向一起给,是因为界面上「关联」区要能双向看见:用户给 A 挂了 B,
   * 打开 B 的时候也该看到"它被 A 关联着" —— 否则他会在 B 上再挂一次 A,
   * 而那是同一条关系的两个方向。
   *
   * 返回里 `direction` 说明每一条是从哪边看过去的。
   */
  linksOf(itemId: string): Array<LibraryItemLink & { direction: "out" | "in" }> {
    const db = getDb();
    const out: Array<LibraryItemLink & { direction: "out" | "in" }> = [];
    const stmt = db.prepare(
      "SELECT * FROM library_item_links WHERE item_id = ? OR target_item_id = ?",
    );
    stmt.bind([v(itemId), v(itemId)]);
    while (stmt.step()) {
      const link = rowToLink(stmt.getAsObject() as unknown as LinkRow);
      out.push({ ...link, direction: link.itemId === itemId ? "out" : "in" });
    }
    stmt.free();
    return out;
  },

  /**
   * 加一条关联。**幂等** —— 已经存在就返回那一条,不报错、不产生第二行
   * (唯一索引也挡着;这里先查一次是为了拿到既有行的 id 给调用方)。
   *
   * `target` 两选一:给 `targetItemId` 就是关联库内条目,给 `targetPath` 就是关联
   * 库外文件。两个都给或都不给都抛 —— 表上的 CHECK 也会拦,但在这里抛能给出
   * 说得清的话(而不是一句 SQLite 约束错误)。
   */
  add(
    itemId: string,
    target: { targetItemId: string } | { targetPath: string },
  ): LibraryItemLink {
    const hasItem = "targetItemId" in target;
    const hasPath = "targetPath" in target;
    if (hasItem === hasPath) {
      throw new Error("关联的目标要么是库内条目、要么是库外路径,不能两个都给或都不给");
    }
    const db = getDb();
    const existing = db.prepare(
      hasItem
        ? "SELECT * FROM library_item_links WHERE item_id = ? AND target_item_id = ?"
        : "SELECT * FROM library_item_links WHERE item_id = ? AND target_path = ?",
    );
    existing.bind([v(itemId), v(hasItem ? target.targetItemId : target.targetPath)]);
    if (existing.step()) {
      const found = rowToLink(existing.getAsObject() as unknown as LinkRow);
      existing.free();
      return found;
    }
    existing.free();

    const link: LibraryItemLink = {
      id: makeId("ll"),
      itemId,
      ...(hasItem ? { targetItemId: target.targetItemId } : { targetPath: target.targetPath }),
      createdAt: Date.now(),
    };
    db.run(
      "INSERT INTO library_item_links (id, item_id, target_item_id, target_path, created_at) VALUES (?, ?, ?, ?, ?)",
      [v(link.id), v(link.itemId), v(link.targetItemId ?? null), v(link.targetPath ?? null), v(link.createdAt)],
    );
    persist();
    return link;
  },

  /** 解除一条关联(按关联行自己的 id)。返回是否真的删掉了。 */
  remove(linkId: string): boolean {
    const db = getDb();
    const before = db.prepare("SELECT id FROM library_item_links WHERE id = ?");
    before.bind([v(linkId)]);
    const exists = before.step();
    before.free();
    if (!exists) return false;
    db.run("DELETE FROM library_item_links WHERE id = ?", [v(linkId)]);
    persist();
    return true;
  },

  /**
   * 一批条目**各自**有几条关联 —— 左栏行尾那个徽标要的数字。
   *
   * ## 为什么必须是一条批量 RPC,而不是渲染端逐条调 `linksOf`
   *
   * 左栏一屏能挂几十上百条,逐条发的话就是几十次 IPC,而且每次都要把整张
   * `library_item_links` 扫一遍(`linksOf` 的 WHERE 是 `item_id = ? OR
   * target_item_id = ?`,两列都带索引但仍是两次查)。这一条**一次查完**整批。
   *
   * 计数口径与 `linksOf` **逐字一致**:进/出两个方向都算(用户给 A 挂了 B,
   * 那么在 A 和 B 的左边栏都该看到一个 1)—— 否则徽标说 0、点进去有 1 条,
   * 那种"数字对不上"是最容易被当成 bug 的一类。
   *
   * ⚠️ **自关联(A→A)只算一条。** `linksOf` 的 `item_id = ? OR target_item_id = ?`
   * 对 A→A 只匹配到**一行**,`viewsOf` 也只画一条;而下面这句 UNION ALL 会把两端
   * 各数一次 → 同一行被算成 2,徽标说 2、点进去 1 条。自关联渲染端会跳过,但
   * `library:linkAdd` / `library_link_add`(MCP)这两条**绕过 UI 的入口没有那道守卫**,
   * 所以库里真的会出现 A→A —— 出口计数必须自己按"一行 = 一条关系"对账。
   *
   * 没关联的条目**不出现在返回里**(不是 0),调用方用 `?? 0` 兜 —— 返回一整份
   * 全是 0 的对象在库大起来时纯属浪费。
   */
  countsOf(itemIds: readonly string[]): Record<string, number> {
    const ids = [...new Set(itemIds.filter((id) => id.length > 0))];
    const counts: Record<string, number> = {};
    if (ids.length === 0) return counts;
    const db = getDb();
    const marks = ids.map(() => "?").join(",");
    // 一条 SQL 两个方向各数一次:UNION ALL 之后按 id 分组。
    // 不写成两条查询再在 JS 里合并 —— 同一条关联的两头都要 +1,合并逻辑放在
    // SQL 里更不容易写错(而且走的是同一次扫描)。
    //
    // `target_item_id <> item_id` 排掉自关联的**入边**那一份:出边已经数过它了,
    // 再数一次就与 `linksOf`(`OR` 只匹配一行)差一。NULL 的路径边不走这一支
    // (`target_item_id IN (…)` 对 NULL 恒假),所以这句只影响自关联。
    const stmt = db.prepare(
      `SELECT owner, COUNT(*) AS n FROM (
         SELECT item_id AS owner FROM library_item_links WHERE item_id IN (${marks})
         UNION ALL
         SELECT target_item_id AS owner FROM library_item_links
           WHERE target_item_id IN (${marks}) AND target_item_id <> item_id
       ) GROUP BY owner`,
    );
    stmt.bind([...ids.map((x) => v(x)), ...ids.map((x) => v(x))]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as { owner: unknown; n: unknown };
      const owner = r.owner === null || r.owner === undefined ? "" : String(r.owner);
      if (owner) counts[owner] = Number(r.n);
    }
    stmt.free();
    return counts;
  },

  /**
   * 界面上「关联」区的那些行 —— 关联本身 + **另一头**的摘要,一次查好。
   *
   * 为什么不在渲染端逐条拉:`linksOf` 的行有方向,另一头可能是条目、可能是路径,
   * 而条目还可能已经被删了(关联会级联走,但反向那一侧的历史行未必)。主进程一次
   * 查完,渲染端只管画。
   *
   * `suppressedReason` 由主进程填(它才拿得到屏蔽规则)——
   * 这里留空,由 `ipc/library.ts` 补上。
   */
  viewsOf(itemId: string): LibraryLinkView[] {
    const db = getDb();
    const out: LibraryLinkView[] = [];
    // 一次拿全部关联行,再按方向挑"另一头"。条目标题**批量**查(一次 IN),
    // 免得十个关联发十条 SQL。
    const rows = LibraryLinkRepo.linksOf(itemId);
    const otherIds = rows
      .map((l) => (l.itemId === itemId ? l.targetItemId : l.itemId))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    const titles = new Map<string, string>();
    if (otherIds.length > 0) {
      const stmt = db.prepare(
        `SELECT id, title FROM library_items WHERE id IN (${otherIds.map(() => "?").join(",")})`,
      );
      stmt.bind(otherIds.map((x) => v(x)));
      while (stmt.step()) {
        const r = stmt.getAsObject() as { id: string; title: string };
        titles.set(String(r.id), String(r.title));
      }
      stmt.free();
    }

    for (const link of rows) {
      const isOut = link.direction === "out";
      const otherItemId = isOut ? link.targetItemId : link.itemId;
      const otherPath = isOut ? link.targetPath : undefined;
      const title = otherItemId
        ? (titles.get(otherItemId) ?? "")
        : otherPath
          ? basename(otherPath)
          : "";
      out.push({
        id: link.id,
        direction: link.direction,
        ...(otherItemId ? { otherItemId } : {}),
        ...(otherPath ? { otherPath } : {}),
        title,
        // 库内条目能挂进对话(与手动挂同一种键);库外路径没有可挂的东西 ——
        // 它是"用户桌面上的一个文件",要挂得先导入,那是另一条路。
        ...(otherItemId ? { attachKey: `i:${otherItemId}` } : {}),
        createdAt: link.createdAt,
      });
    }
    return out;
  },
  /**
   * 一批条目各自的关联视图 —— `viewsOf` 的批量版,**一次查完**。
   *
   * 给「删除前预览」用:那个弹窗要画的是"每个文档一组勾选",而它可能一次带几十条
   * (用户原话「可以批量删除」)。逐条 `viewsOf` 的话每次都要把整张
   * `library_item_links` 扫两遍(`linksOf` 的 WHERE 是 `item_id = ? OR
   * target_item_id = ?`),几十条就是上百次查询。
   *
   * 口径与 `viewsOf` **逐字一致**(方向、另一头的标题、`attachKey`)—— 两处不一致
   * 会表现成"预览里说有 3 条,删的时候按 2 条处理"这种对不上的数。所以这一支的
   * 行整形直接复用同一段代码,不是照着重写一遍。
   *
   * 返回**以 id 为键的字典**(不是数组):调用方按条目查,而不在的条目自然落到
   * 空数组(调用方 `?? []`),省得两边都做一次对齐。
   */
  viewsOfMany(itemIds: readonly string[]): Record<string, LibraryLinkView[]> {
    const out: Record<string, LibraryLinkView[]> = {};
    for (const id of itemIds) out[id] = [];
    const db = getDb();
    const ids = [
      ...new Set(itemIds.filter((id) => id.length > 0)),
    ];
    if (ids.length === 0) return out;
    const marks = ids.map(() => "?").join(",");
    // 一条 SQL 把两个方向的行都捞出来:出边(`item_id IN`)与入边(`target_item_id IN`)。
    // 两个方向都要,理由与 `linksOf` 一样 —— 用户给 A 挂了 B,打开 B 也该看见。
    const stmt = db.prepare(
      `SELECT * FROM library_item_links WHERE item_id IN (${marks}) OR target_item_id IN (${marks})`,
    );
    stmt.bind([...ids.map((x) => v(x)), ...ids.map((x) => v(x))]);
    const rows: LinkRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as LinkRow);
    stmt.free();

    // 另一头的标题批量查(一次 IN)—— 与 `viewsOf` 同一条理由:几十条关联发几十条
    // SQL 是这一条 RPC 存在的意义所在。要查的 id 是**行里出现过的全部**,不只是被问
    // 的那一批:入边的"另一头"就是 `item_id`,它可能不在被问的名单里。
    const wanted = [
      ...new Set(
        rows
          .flatMap((r) => [r.item_id, r.target_item_id])
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      ),
    ];
    const titles = new Map<string, string>();
    if (wanted.length > 0) {
      const t = db.prepare(
        `SELECT id, title FROM library_items WHERE id IN (${wanted.map(() => "?").join(",")})`,
      );
      t.bind(wanted.map((x) => v(x)));
      while (t.step()) {
        const r = t.getAsObject() as { id: string; title: string };
        titles.set(String(r.id), String(r.title));
      }
      t.free();
    }

    const idSet = new Set(ids);
    for (const link of rows) {
      // 这一行属于**哪个**被问的条目:出边归 `item_id`,入边归 `target_item_id`。
      // 两侧都在问的那一批里时(用户一次删 A 和 B,而 A→B 有一条关联)**两边的
      // 列表里都该有它** —— 各自看过去都确实有这一条。
      //
      // ⚠️ **自关联(A→A)只画一条**,与 `viewsOf` / `linksOf` 一致(`linksOf` 的
      // `link.itemId === itemId ? "out" : "in"` 对 A→A 恒判 out,只出一行)。
      // 不加这一道,出边与入边的 owner 都是 A,同一行被 push 两次:删除预览里
      // A 显示 2 条关联,而详情面板(`viewsOf`)只显示 1 条 —— 两处数字对不上。
      const owners: Array<{ owner: string; isOut: boolean }> = [];
      if (idSet.has(link.item_id)) owners.push({ owner: link.item_id, isOut: true });
      if (
        link.target_item_id &&
        link.target_item_id !== link.item_id &&
        idSet.has(link.target_item_id)
      ) {
        owners.push({ owner: link.target_item_id, isOut: false });
      }
      for (const { owner, isOut } of owners) {
        const otherItemId = isOut ? link.target_item_id : link.item_id;
        const otherPath = isOut ? link.target_path : undefined;
        // ⚠️ 入边时"另一头"是 `item_id`,而那一行可能同时有 `target_path` 吗?
        // 不会:表上的 CHECK 保证两列恰好一列非空,而这一行既然入边成立,它就是
        // "那个人 → 我",我必然是**条目**那一侧。所以 `otherPath` 只在出边出现。
        const title = otherItemId ? (titles.get(otherItemId) ?? "") : otherPath ? basename(otherPath) : "";
        out[owner]!.push({
          id: link.id,
          direction: isOut ? "out" : "in",
          ...(otherItemId ? { otherItemId } : {}),
          ...(otherPath ? { otherPath } : {}),
          title,
          ...(otherItemId ? { attachKey: `i:${otherItemId}` } : {}),
          createdAt: link.created_at,
        });
      }
    }
    return out;
  },
};
