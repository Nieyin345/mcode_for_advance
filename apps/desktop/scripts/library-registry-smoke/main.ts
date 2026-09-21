/**
 * Headless smoke for **资料库类型注册表**(`main/library/kindRegistry.ts` +
 * `@contracts/libraryTypes` 的纯校验)。
 *
 * 统一资料库把 kind 从三个写死的值放宽成"注册表说了算"。这里验三件事:
 *
 *  1. **纯校验**(`parseLibraryTypesJson`):id 规则、唯一性、purpose 合法、
 *     **内置类不可删** —— 最后这条是老数据的命脉,删了的话指着 `paper` 的行全线失语;
 *  2. **运行时**(`kindRegistry`):没存过 → 出厂 8 类(老用户行为逐字不变);
 *     存过 → 读到自定义;存坏 → 退出厂表**不炸**;校验失败 → 落库被拒、缓存不动;
 *  3. **缓存一致性**:save 之后同一进程里的下一次 load 立刻是新表(不等 DB 重开)。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 db-migrate-smoke 的 stubs/,这里
 * 直接复用同一批),run.sh 用 `mktemp -d` 建目录,跑完就删。
 *
 * Run: scripts/library-registry-smoke/run.sh
 */
import { initDb, getDb } from "@main/store/db.js";
import { LibraryRepo, LibraryLinkRepo } from "@main/store/repositories.js";
import {
  loadLibraryTypes,
  saveLibraryTypes,
  isRegisteredKind,
  kindDisplayName,
  kindMeta,
  resetLibraryTypesCacheForTest,
} from "@main/library/kindRegistry.js";
import {
  BUILTIN_LIBRARY_TYPES,
  LIBRARY_TYPES_SETTING_KEY,
  normalizeSuppressExt,
  parseLibraryTypesJson,
  parseSuppressJson,
  parseSuppressNodeKey,
  suppressNodeKey,
} from "@contracts/libraryTypes";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组比较 —— `Object.is` 对两个内容相同的数组也是 false(不是同一个引用)。 */
function eqList(name: string, actual: string[], expected: string[]): void {
  check(name, actual.join("|") === expected.join("|"), { actual, expected });
}

console.log("\n纯校验 parseLibraryTypesJson");

{
  // 合法表:内置 8 类原样 + 一个自定义类型
  const good = [
    ...BUILTIN_LIBRARY_TYPES.map((t) => ({ ...t })),
    { id: "slide-deck", name: "我的课件", purpose: "format" as const, prompt: "照着这个排版写" },
  ];
  const okRes = parseLibraryTypesJson(JSON.parse(JSON.stringify(good)));
  check("合法表通过", okRes.ok, okRes);
  if (okRes.ok) eq("条目数 = 9", okRes.types.length, 9);

  const bad = (label: string, table: unknown): void => {
    const res = parseLibraryTypesJson(table);
    check(`${label} 被拒`, !res.ok, res);
  };

  bad("不是数组", { id: "paper" });
  bad("条目不是对象", ["paper"]);
  bad("id 大写", [{ id: "Paper", name: "x", purpose: "material" }]);
  bad("id 带空格", [{ id: "my kind", name: "x", purpose: "material" }]);
  bad("id 数字开头", [{ id: "9kind", name: "x", purpose: "material" }]);
  bad("缺显示名", [{ id: "kind-a", purpose: "material" }]);
  bad("空显示名", [{ id: "kind-a", name: "   ", purpose: "material" }]);
  bad("purpose 不合法", [{ id: "kind-a", name: "x", purpose: "both" }]);
  bad("id 重复", [
    { id: "kind-a", name: "x", purpose: "material" },
    { id: "kind-a", name: "y", purpose: "material" },
  ]);
  // ⚠️ **这两条 2026-09-21 反过来了。** 原来断的是"缺内置类型 → 拒"，
  // 而那道闸被去掉了（用户：「这里显示内置类型不能删除，没有内置类型呀，
  // 全部都是自定义的」，要求"都能删"、"全删光也行"）。
  // 现在它们该**通过** —— 断言跟着行为一起改，不是删掉。
  const noPaper = parseLibraryTypesJson(
    JSON.parse(JSON.stringify(BUILTIN_LIBRARY_TYPES.filter((t) => t.id !== "paper"))),
  );
  check("★ 删掉内置的 paper 现在能过", noPaper.ok, noPaper);
  const noneBuiltin = parseLibraryTypesJson(
    JSON.parse(JSON.stringify([{ id: "custom-only", name: "自建", purpose: "material" }])),
  );
  check("★ 一个内置都不留也能过", noneBuiltin.ok, noneBuiltin);
  const empty = parseLibraryTypesJson([]);
  check("★ 空表也能过（全删光）", empty.ok, empty);
}

console.log("\n运行时 kindRegistry(全新空库)");

await initDb();

{
  const types = loadLibraryTypes();
  eq("没存过 → 出厂 8 类", types.length, 8);
  eq("第一类是 paper", types[0]?.id, "paper");
  check("isRegisteredKind(paper)", isRegisteredKind("paper") === true);
  check("isRegisteredKind(latex)", isRegisteredKind("latex") === true);
  check("isRegisteredKind(没注册的) = false", isRegisteredKind("my-kind") === false);
  check("isRegisteredKind(非字符串) = false", isRegisteredKind(42) === false);
  eq("出厂名", kindDisplayName("paper"), "论文");
  eq("没注册的显示 id 本身", kindDisplayName("ghost"), "ghost");
}

{
  // 整表替换:改一个内置名 + 加一个自定义类。保存后**同一进程**里立刻读得到。
  const next = [
    ...BUILTIN_LIBRARY_TYPES.map((t) => (t.id === "paper" ? { ...t, name: "学术论文" } : { ...t })),
    { id: "my-deck", name: "我的幻灯", purpose: "format" as const },
  ];
  const res = saveLibraryTypes(JSON.parse(JSON.stringify(next)));
  check("合法保存通过", res.ok, res);

  const types = loadLibraryTypes();
  eq("缓存立即更新(9 类)", types.length, 9);
  eq("改过的内置名生效", kindDisplayName("paper"), "学术论文");
  eq("自定义类可查", kindMeta("my-deck")?.name, "我的幻灯");
  check("isRegisteredKind(my-deck)", isRegisteredKind("my-deck") === true);
  // **DB 里真的落了**(不信任只改了缓存):直接查 settings 表
  const raw = getDb().prepare("SELECT value FROM settings WHERE key = ?") as unknown as {
    bind(p: unknown[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free(): void;
  };
  raw.bind([LIBRARY_TYPES_SETTING_KEY]);
  check("settings 表里有那行", raw.step());
  const stored = String(raw.getAsObject().value);
  raw.free();
  check("落库内容含自定义 id", stored.includes("my-deck"), stored.slice(0, 120));
}

{
  // ⚠️ **这一段 2026-09-21 反过来了。** 原来断的是"删 note → 被拒、缓存不动"。
  // 那道闸去掉之后，删 note 是**正常操作**，所以改成钉"删成功之后的状态"。
  const withoutNote = BUILTIN_LIBRARY_TYPES.filter((t) => t.id !== "note")
    .map((t) => ({ ...t }));
  const res = saveLibraryTypes(JSON.parse(JSON.stringify(withoutNote)));
  check("★ 删内置的 note 现在能落库", res.ok, res);
  check("★ note 真的没了", isRegisteredKind("note") === false);
  check("★ 其余 7 类还在", loadLibraryTypes().length === 7, loadLibraryTypes().length);
}

{
  // 存坏数据(手工改库):退回出厂表,不炸 —— 但**不覆写**用户那份坏 JSON。
  getDb().run("UPDATE settings SET value = ? WHERE key = ?", ["{oops", LIBRARY_TYPES_SETTING_KEY]);
  resetLibraryTypesCacheForTest();
  const types = loadLibraryTypes();
  eq("坏 JSON → 出厂 8 类", types.length, 8);
  eq("出厂名恢复", kindDisplayName("paper"), "论文");
}

console.log("\n条目关联 LibraryLinkRepo");

{
  const db = getDb();
  const itemCount = (): number => {
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_items");
    stmt.step();
    const n = Number(stmt.getAsObject().n);
    stmt.free();
    return n;
  };
  const linkCount = (): number => {
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_item_links");
    stmt.step();
    const n = Number(stmt.getAsObject().n);
    stmt.free();
    return n;
  };

  eq("起点:没有条目", itemCount(), 0);

  const a = LibraryRepo.upsert({ title: "论持久战", kind: "note" });
  const b = LibraryRepo.upsert({ title: "附件转录", kind: "note" });
  eq("两条条目已建", itemCount(), 2);

  // 库内关联:加一条、读回来
  const link = LibraryLinkRepo.add(a.id, { targetItemId: b.id });
  eq("加一条后表里一行", linkCount(), 1);
  eq("关联的起点对", link.itemId, a.id);
  eq("关联的目标对", link.targetItemId, b.id);
  check("库外路径字段是空的", link.targetPath === undefined);
  check("带创建时间", typeof link.createdAt === "number" && link.createdAt > 0);

  const ofA = LibraryLinkRepo.linksOf(a.id);
  eq("A 看到一条", ofA.length, 1);
  eq("A 那条是 out", ofA[0]?.direction, "out");

  // 反向查询同样便宜 —— **存储只存一次**。B 那边看到的是同一条关联的 in 向。
  const ofB = LibraryLinkRepo.linksOf(b.id);
  eq("B 也看到一条(反向)", ofB.length, 1);
  eq("B 那条是 in", ofB[0]?.direction, "in");
  eq("两个方向是同一行", ofB[0]?.id, link.id);
  eq("底层只有一行", linkCount(), 1);

  // 幂等:同一对再挂一次不该产生第二行
  const again = LibraryLinkRepo.add(a.id, { targetItemId: b.id });
  eq("重复添加返回既有行", again.id, link.id);
  eq("重复添加没多出行", linkCount(), 1);

  // 一对多:A 还能再挂别人 —— 这正是「不是两两配对」的形状
  const c = LibraryRepo.upsert({ title: "第三份", kind: "note" });
  LibraryLinkRepo.add(a.id, { targetItemId: c.id });
  LibraryLinkRepo.add(a.id, { targetPath: "D:/外面的一份参考.pdf" });
  eq("A 一共三条出边", LibraryLinkRepo.linksOf(a.id).filter((l) => l.direction === "out").length, 3);
  eq("表里一共三行", linkCount(), 3);

  const pathLink = LibraryLinkRepo.linksOf(a.id).find((l) => l.direction === "out" && l.targetPath);
  check("库外路径那条存下来了", pathLink?.targetPath === "D:/外面的一份参考.pdf", pathLink);
  check("库外那条没有 targetItemId", pathLink?.targetItemId === undefined);
  const pathAgain = LibraryLinkRepo.add(a.id, { targetPath: "D:/外面的一份参考.pdf" });
  eq("库外路径的幂等", pathAgain.id, pathLink?.id);
  eq("库外重复添加也没多行", linkCount(), 3);

  // 两种指向二选一 —— 都给 / 都不给都要在进 DB 之前就被挡下
  let threw = "";
  try {
    LibraryLinkRepo.add(a.id, { targetItemId: b.id, targetPath: "D:/x.pdf" } as never);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("两种指向都给 → 抛", threw.includes("不能两个都给"), threw);
  threw = "";
  try {
    LibraryLinkRepo.add(a.id, {} as never);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("两种指向都不给 → 抛", threw.includes("不能两个都给"), threw);
  eq("两次非法调用都没落库", linkCount(), 3);

  // 解除
  check("解除存在的关联返回 true", LibraryLinkRepo.remove(pathLink!.id) === true);
  eq("解除后少一行", linkCount(), 2);
  check("解除不存在的返回 false", LibraryLinkRepo.remove(pathLink!.id) === false);
  eq("没再少行", linkCount(), 2);

  // 级联:删掉 b,B 那一侧的关联行跟着走(来源侧)
  LibraryRepo.delete([b.id]);
  eq("删了 b 之后", itemCount(), 2);
  eq("来源侧的关联级联删除", linkCount(), 1);
  eq("A 只剩指向 c 的一条", LibraryLinkRepo.linksOf(a.id).length, 1);

  // 级联:删掉 c —— 这一侧是**目标**,同样要级联
  LibraryRepo.delete([c.id]);
  eq("删了 c 之后表空", linkCount(), 0);
  check("A 不再有关联", LibraryLinkRepo.linksOf(a.id).length === 0);

  // 没有条目也能建关联表(空跑不炸)
  eq("剩下的条目还在", itemCount(), 1);
}

console.log("\n持久化之后外键约束还在");

{
  // ⚠️ 这条测的是一个**踩过的坑**,不是新功能。
  //
  // sql.js 的 `db.export()` 会把连接状态整个重置,其中包含 `PRAGMA foreign_keys`,
  // 而它是**连接级**的开关 —— 建库时开过的那一次不会在导出后自动回来。而 `persist()`
  // 每次写盘都导出一次,于是"应用写过一次盘之后,所有 ON DELETE CASCADE 都不再生效",
  // 且完全不报错:删了条目、挂在它下面的行静静地留着。
  //
  // 修法是把导出收进 `exportBytes()` 一处(导出后立刻把 pragma 开回去)。这条断言就是
  // 那道防线的信号 —— 谁绕过 `exportBytes()` 直接 `db.export()`,这里会红。
  const db = getDb();
  const fkOn = (): boolean => {
    const stmt = db.prepare("PRAGMA foreign_keys");
    stmt.step();
    const n = Number(stmt.getAsObject().foreign_keys);
    stmt.free();
    return n === 1;
  };
  const a = LibraryRepo.upsert({ title: "写盘之后 A", kind: "note" });
  const b = LibraryRepo.upsert({ title: "写盘之后 B", kind: "note" });
  check("刚 upsert 完外键还开着", fkOn());

  await new Promise<void>((r) => setTimeout(r, 20));
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });
  check("加关联之后外键还开着", fkOn());

  const before = ((): number => {
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_item_links");
    stmt.step();
    const n = Number(stmt.getAsObject().n);
    stmt.free();
    return n;
  })();
  eq("前置:有一行关联", before, 1);

  LibraryRepo.delete([b.id]);
  const after = ((): number => {
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_item_links");
    stmt.step();
    const n = Number(stmt.getAsObject().n);
    stmt.free();
    return n;
  })();
  eq("写盘之后级联依然生效", after, 0);
  check("外键仍然开着", fkOn());
}

console.log("\n屏蔽规则 parseSuppressJson");

{
  const parse = parseSuppressJson;

  // ── 形状 ──
  check("不是对象被拒", !parse([]).ok && !parse(null).ok && !parse("x").ok);
  check("nodes 不是数组被拒", !parse({ nodes: "group:docs" }).ok);
  check("extensions 不是数组被拒", !parse({ extensions: ".pdf" }).ok);

  // ── 节点键:认不出的**丢掉这一条**,不废掉整份 ──
  // 这是这个模块的口径与注册表/大类表刻意不同的地方:那两份是结构(少一条老数据
  // 全线失语),所以宁可整个拒绝;屏蔽是一串独立勾选,某一条失效不该把用户其余的
  // 屏蔽一起作废 —— 那等于偷偷放开一批他明确要挡的东西。
  {
    const res = parse({
      nodes: ["group:docs", "bogus:whatever", "no-colon", "type:", "collection:c1"],
      extensions: [],
    });
    check("认不出的前缀不废掉整份", res.ok, res);
    if (res.ok) {
      eqList("只剩两条合法的", res.rule.nodes, ["group:docs", "collection:c1"]);
    }
  }

  // ── 扩展名规范化:补点、转小写 ──
  {
    const res = parse({ nodes: [], extensions: ["PDF", ".Zip", "  .md  ", "", "   "] });
    check("扩展名过校验", res.ok, res);
    if (res.ok) {
      eqList("规范化 + 去空 + 去重", res.rule.extensions, [".pdf", ".zip", ".md"]);
    }
  }

  // ── 去重但保持顺序(界面上的勾选顺序大体是用户的操作顺序,不重排)──
  {
    const res = parse({
      nodes: ["type:note", "group:docs", "type:note"],
      extensions: [".pdf", ".PDF"],
    });
    if (res.ok) {
      eqList("节点去重保序", res.rule.nodes, ["type:note", "group:docs"]);
      eqList("扩展名去重", res.rule.extensions, [".pdf"]);
    } else {
      check("去重那一份应该通过", false, res);
    }
  }

  // ── 缺字段 = 空,不是错(用户从没配过时读到的是 `{}` 之类)──
  {
    const res = parse({});
    check("空对象通过", res.ok, res);
    if (res.ok) {
      eq("空 nodes", res.rule.nodes.length, 0);
      eq("空 extensions", res.rule.extensions.length, 0);
    }
  }

  // ── 两个纯函数本身 ──
  eq("拼键", suppressNodeKey("collection", "abc"), "collection:abc");
  eq("拆键", JSON.stringify(parseSuppressNodeKey("group:docs")), '{"level":"group","id":"docs"}');
  eq("认不出的前缀拆出 null", parseSuppressNodeKey("bogus:x"), null);
  eq("没有冒号拆出 null", parseSuppressNodeKey("docs"), null);
  eq("空 id 拆出 null", parseSuppressNodeKey("group:"), null);
  eq("规范化:补点", normalizeSuppressExt("pdf"), ".pdf");
  eq("规范化:转小写", normalizeSuppressExt("PDF"), ".pdf");
  eq("规范化:去空白", normalizeSuppressExt("  .MD  "), ".md");
  eq("规范化:空串 → 空串", normalizeSuppressExt("   "), "");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
