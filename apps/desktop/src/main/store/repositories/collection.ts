/**
 * 资料库集合 —— library_collections 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { LibraryCollection } from "@contracts/library";
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { makeId } from "./makeId.js";

/* ──────────────────────────────── 集合 ─────────────────────────────────── */

interface CollectionRow {
  id: string;
  name: string;
  kind: string | null; // 退役列：仍在库里，不再读写
  group_id: string | null;
  prompt: string | null;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
}

function rowToCollection(r: CollectionRow): LibraryCollection {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt ?? undefined,
    groupId: r.group_id ?? undefined,
    parentId: r.parent_id ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    // 「是不是回收站」不是一列,而是由设置键 + 名字推出来的(见 trash.ts)。这里
    // 没有那个信息,而且也不该有 —— trash.ts 依赖本模块,反过来 import 会成环。
    // 真正标上它的是主进程返回分类列表那一层(`ipc/library.ts`)。
    isTrash: false,
  };
}

export const CollectionRepo = {
  /** 列全部分类（kind 退役后没有"按库列"的口径；归属经 `groupId`，渲染端自行过滤）。 */
  list(): LibraryCollection[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_collections ORDER BY sort_order ASC, created_at ASC");
    stmt.bind([]);
    const out: LibraryCollection[] = [];
    while (stmt.step()) out.push(rowToCollection(stmt.getAsObject() as unknown as CollectionRow));
    stmt.free();
    return out;
  },

  /**
   * 名字是否已被占用。
   *
   * **同一个库内唯一** —— 用户可能在论文库里有个「方法」分类,在笔记库里也想有一个;
   * 那是两棵互不相干的树,重名不会让人分不清。但同一个库内的重名要挡掉:库名会出现在
   * 上下文 chip、右侧面板标题、「+」菜单的选择器里,那些地方只显示名字。
   *
   * 比较用「去首尾空白 + 忽略大小写」:用户眼里 "ANN" 和 "ann" 是同一个名字。
   */
  isNameTaken(name: string, exceptId?: string): boolean {
    const norm = name.trim().toLowerCase();
    if (!norm) return false;
    return CollectionRepo.list().some(
      (c) => c.id !== exceptId && c.name.trim().toLowerCase() === norm,
    );
  },

  create(
    name: string,
    parentId: string | null = null,
    groupId?: string,
    prompt?: string,
  ): LibraryCollection {
    // 兜底守卫。渲染端已做即时校验,这里防的是绕过 UI 的调用(如将来的 AI 工具)。
    if (CollectionRepo.isNameTaken(name)) {
      throw new Error(`已经有叫「${name.trim()}」的分类了`);
    }
    const db = getDb();
    const id = makeId("lc");
    /**
     * 追加到末尾：取同级当前最大 `sort_order` + 1（**同库内**同级）。
     *
     * ⚠️ **2026-09-21 曾改成 `MIN - 1`（插到最前），当天就回退了。**
     * 当时我把用户的「新建的应该在 collection 最上面」理解成"插到最前"，但那个
     * `MIN - 1` 会让**已有分类的相对顺序也倒过来**（后建的排前面）——
     * `library-move-smoke` 的「落在新那一层的末尾」当场抓到：原来"一、二"，
     * 变成了"二、一"。用户澄清他没说过要改这个。
     *
     * 教训：让"新建的排最前"若要做，得是"新的插到 0，旧的依次后移"，
     * 而不是"取当前最小值减一"——后者颠覆了既有顺序。
     */
    const maxStmt = db.prepare(
      parentId
        ? "SELECT IFNULL(MAX(sort_order), -1) AS m FROM library_collections WHERE parent_id = ?"
        : "SELECT IFNULL(MAX(sort_order), -1) AS m FROM library_collections WHERE parent_id IS NULL",
    );
    maxStmt.bind(parentId ? [v(parentId)] : []);
    maxStmt.step();
    const nextOrder = Number((maxStmt.getAsObject() as { m: number }).m ?? -1) + 1;
    maxStmt.free();

    db.run(
      "INSERT INTO library_collections (id, name, kind, group_id, prompt, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [v(id), v(name.trim()), v("retired"), v(groupId ?? null), v(prompt ?? null), v(parentId), v(nextOrder), v(Date.now())],
    );
    persist();
    return {
      id,
      name: name.trim(),
      ...(prompt ? { prompt } : {}),
      ...(groupId ? { groupId } : {}),
      parentId,
      sortOrder: nextOrder,
      createdAt: Date.now(),
      // 同上:回收站标记由主进程返回分类列表时统一标,这里没有那个信息
      isTrash: false,
    };
  },

  /** 改名。返回是否成功 —— 重名时返回 false,调用方负责提示用户。 */
  rename(id: string, name: string): boolean {
    const current = CollectionRepo.list().find((c) => c.id === id);
    if (!current) return false;
    if (CollectionRepo.isNameTaken(name, id)) return false;
    getDb().run("UPDATE library_collections SET name = ? WHERE id = ?", [v(name.trim()), v(id)]);
    persist();
    return true;
  },

  /** 写「给 AI 的说明」。空串 = 清空(清单里就不再注入这一层)。 */
  setPrompt(id: string, prompt: string | null): void {
    getDb().run("UPDATE library_collections SET prompt = ? WHERE id = ?", [
      v(prompt && prompt.trim().length > 0 ? prompt.trim() : null), v(id),
    ]);
    persist();
  },

  /** 删除集合。子集合与成员关系由外键 CASCADE 一并清理;**文献本身不受影响**
   *  —— 集合只是分组,删组不该删文献。 */
  delete(id: string): void {
    getDb().run("DELETE FROM library_collections WHERE id = ?", [v(id)]);
    persist();
  },

  /**
   * 把一个集合移到别处 —— 改父级,和/或调同级的次序。左栏拖拽 / 右键「移动到…」的落点。
   *
   * 失败时把原因**原文**返回,调用方直接摆给用户看 —— 不另造一套说法。
   * 四种移不动:找不到它自己 / 找不到新父级 / 会成环 / 目标位置重名。
   *
   * ## 为什么环必须显式判
   *
   * `parent_id` 上的外键**不防环**(见 `listByCollectionTree` 那段说明 —— 那边用
   * `UNION` 而不是 `UNION ALL` 才没被挂死)。于是"把 A 移到自己下面"在 SQL 层是
   * 完全合法的写,而后患是那一棵子树从库里所有遍历里消失:界面上它整块不见了,
   * 用户以为东西没了。
   *
   * 判法两种:查目标的**祖先链**里有没有自己(向上),或查自己的**后代集**里有没有
   * 目标(向下)。**向上走更省** —— 祖先链通常只有几层,后代集要遍历整棵子树。
   * 所以这里从目标出发往上走,走到 `null` 到头。`guard` 是坏数据兜底:真有环时
   * 不许这个循环把主进程挂死(宁可拒绝这次移动)。
   *
   * ## 重名判据:这里**只判同一层**,比 create/rename 宽松(刻意)
   *
   * `create` / `rename` 走 `isNameTaken`,那是**同库内全局唯一**。这里用同层唯一。
   * 差别只在"移动"这条路上宽松,理由是用户视角的:把「方法」从根目录拖进「第一章」
   * 下面时,若根目录另有一个「方法」,按全局判重会被拒;但两个「方法」现在处在**不同
   * 的父级下**,左栏上是两棵互不相干的分支,用户完全分得清。硬拒的话他唯一的出路是
   * 改名,而那个名字本来就是他想要的。
   *
   * ⚠️ 这确实是**两套口径**。真要统一得连 `create` 一起放宽,而那会改掉"同库内不许
   * 重名"这条既有约束(库名会出现在上下文 chip、右栏标题、选择器里,那些地方只看得到
   * 名字)—— 不在这次改动的范围内,所以这里如实写出这个不一致,而不是假装没有。
   *
   * ## 次序怎么排
   *
   * 挪过去之后**追加到新那一层的末尾**:先把目标层的兄弟按 `sort_order` 排好,再把
   * 自己插到最末,然后**整层重写** `sort_order` 为 0..n-1。
   *
   * 整层重写而不是"搬动别人腾位置":结果与顺序一一对应,也不会在中间态留下两个同号的
   * 兄弟。代价是这一层有 k 个兄弟就写 k 行 —— 分类是几十条的量级,不值得为它优化。
   *
   * ## 为什么签名里**没有**"落到第几位"
   *
   * 契约 `CollectionMoveSchema` 上原本有个 `index`(同级落点),已经砍掉,这里也跟着
   * 砍了 —— 留着形参而没人传,下一个人会以为"拖动排序"已经有了。
   *
   * 砍它的原因是它**算不对**:`index` 数的是"除自己之外"的兄弟,而同层内挪动时
   * 用户心里的位置是含自己的 —— 往右拖一位要传 `index+1`。这种差一位的坑,少一个
   * 入口就少一处;而现在界面没有任何一条路需要它(候选落点里自己与自己的子树都被
   * 挑掉了,没有"原地调序"这个动作)。挪过去一律**追加到新那一层的末尾**。
   */
  move(
    id: string,
    parentId: string | null | undefined,
  ): { ok: true } | { ok: false; error: string } {
    const all = CollectionRepo.list();
    const current = all.find((c) => c.id === id);
    if (!current) return { ok: false, error: "这个分类已经不在了" };

    // 只调次序时父级不变;传了值就用新值(显式的 null = 移到最外层)
    const nextParent = parentId === undefined ? current.parentId : parentId;

    if (nextParent !== null) {
      const target = all.find((c) => c.id === nextParent);
      if (!target) return { ok: false, error: "目标分类已经不在了" };
      if (target.id === id) {
        return { ok: false, error: "不能把一个分类移到它自己下面" };
      }
      let cursor: string | null = target.parentId;
      let guard = 0;
      while (cursor !== null && guard < 10_000) {
        if (cursor === id) {
          return { ok: false, error: "不能把一个分类移到它自己的子分类下面" };
        }
        cursor = all.find((c) => c.id === cursor)?.parentId ?? null;
        guard += 1;
      }
    }

    // 同层重名(见上面的说明:这里刻意只判同一层)
    const norm = current.name.trim().toLowerCase();
    const clash = all.some(
      (c) =>
        c.id !== id &&
        (c.parentId ?? null) === nextParent &&
        c.name.trim().toLowerCase() === norm,
    );
    if (clash) return { ok: false, error: "目标位置已经有同名的分类了" };

    const siblings = CollectionRepo.list()
      .filter((c) => (c.parentId ?? null) === nextParent && c.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    // 追加到末尾(见上面"为什么签名里没有落到第几位")
    siblings.push({ ...current, parentId: nextParent } as LibraryCollection);

    const db = getDb();
    db.run("BEGIN");
    try {
      db.run("UPDATE library_collections SET parent_id = ? WHERE id = ?", [v(nextParent), v(id)]);
      const stmt = db.prepare("UPDATE library_collections SET sort_order = ? WHERE id = ?");
      for (let i = 0; i < siblings.length; i++) stmt.run([v(i), v(siblings[i]!.id)]);
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
    return { ok: true };
  },

  /** 把一批文献加入/移出某集合。已存在时重复加入是幂等的。 */
  assign(collectionId: string, itemIds: string[], add: boolean): void {
    if (itemIds.length === 0) return;
    const db = getDb();
    const now = Date.now();
    db.run("BEGIN");
    try {
      if (add) {
        const stmt = db.prepare(
          `INSERT INTO library_collection_items (collection_id, item_id, added_at) VALUES (?, ?, ?)
           ON CONFLICT(collection_id, item_id) DO NOTHING`,
        );
        for (const itemId of itemIds) stmt.run([v(collectionId), v(itemId), v(now)]);
        stmt.free();
      } else {
        const stmt = db.prepare(
          "DELETE FROM library_collection_items WHERE collection_id = ? AND item_id = ?",
        );
        for (const itemId of itemIds) stmt.run([v(collectionId), v(itemId)]);
        stmt.free();
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /** 每条文献所属的集合 id 列表 —— 详情面板展示与「批量归组」用。 */
  collectionsOfItem(itemId: string): string[] {
    const db = getDb();
    const stmt = db.prepare("SELECT collection_id FROM library_collection_items WHERE item_id = ?");
    stmt.bind([v(itemId)]);
    const out: string[] = [];
    while (stmt.step()) {
      out.push(String((stmt.getAsObject() as { collection_id: string }).collection_id));
    }
    stmt.free();
    return out;
  },
};
