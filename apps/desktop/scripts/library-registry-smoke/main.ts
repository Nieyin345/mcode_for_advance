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
  parseLibraryTypesJson,
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
  bad("缺内置类型(删 paper)", BUILTIN_LIBRARY_TYPES.filter((t) => t.id !== "paper"));
  bad(
    "缺全部内置类型",
    [{ id: "custom-only", name: "自建", purpose: "material" }],
  );
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
  // 校验失败:拒绝落库,缓存保持上一次成功的那份 —— 半保存状态不存在。
  const broken = BUILTIN_LIBRARY_TYPES.filter((t) => t.id !== "note");
  const res = saveLibraryTypes(JSON.parse(JSON.stringify(broken)));
  check("删内置被拒", !res.ok, res);
  check("错误话说的是 note", !res.ok && res.error.includes("note"), res);
  check("缓存还是上次那份(9 类)", loadLibraryTypes().length === 9);
  check("note 还在", isRegisteredKind("note") === true);
}

{
  // 存坏数据(手工改库):退回出厂表,不炸 —— 但**不覆写**用户那份坏 JSON。
  getDb().run("UPDATE settings SET value = ? WHERE key = ?", ["{oops", LIBRARY_TYPES_SETTING_KEY]);
  resetLibraryTypesCacheForTest();
  const types = loadLibraryTypes();
  eq("坏 JSON → 出厂 8 类", types.length, 8);
  eq("出厂名恢复", kindDisplayName("paper"), "论文");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
