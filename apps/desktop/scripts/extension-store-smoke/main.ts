/**
 * 扩展专用数据区(报告 E12)的回归网 —— 2026-10-11 立。
 *
 * ## 它守的规矩
 *
 * 1. **按扩展隔离**:A 扩展写的,B 扩展读不到;同一个键名在不同扩展下不串号。
 * 2. **换个项目不丢**:存储坐落在数据根下(`<数据根>/extensions/<id>/store.json`),
 *    与任何项目目录无关 —— 存储路径里不含项目。
 * 3. **配额**:一份超过 `EXTENSION_STORE_MAX` 的写**整次拒绝、不落盘**(不是写一半)。
 * 4. **坏文件宽容**:文件不存在 / 不是 JSON / 形状不对 → 当空存储,不抛(用户数据
 *    可能被手改坏,不能因此让扩展崩)。
 * 5. **保留键 / 非法 id**:`__proto__` / `constructor` / `prototype` 拒;`..` 开头的 id
 *    拒(路径穿越)。
 *
 * 纯模块 + 一个临时数据根,直接 bundle 就能跑(dataRoot 走桩)。
 *
 * Run: scripts/extension-store-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcMain } from "electron";
import {
  emptyStore,
  ExtensionIdSchema,
  ExtensionStoreKeySchema,
  ExtensionStoreGetSchema,
  ExtensionStoreSetSchema,
  ExtensionStoreRemoveSchema,
  EXTENSION_STORE_GET_CHANNEL,
  EXTENSION_STORE_SET_CHANNEL,
  EXTENSION_STORE_REMOVE_CHANNEL,
  EXTENSION_STORE_MAX,
  isValidExtensionId,
  getStoreValue,
  parseStoreFile,
  serializeStore,
  storeBytes,
  withStoreValue,
  withoutStoreValue,
} from "@contracts/extensionStore";
import {
  extensionsDir,
  extensionDir,
  extensionStorePath,
  readStore,
  readValue,
  writeValue,
  removeValue,
  usedBytes,
} from "../../src/main/lib/extensionStore.js";
import { registerExtensionStoreHandlers } from "../../src/main/ipc/extensions.js";

let checks = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
/** 结构化相等(`Object.is` 比不了对象 / 数组;IPC 返回值都是普通对象)。 */
function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 数据根 = 脚本自己的临时目录(通过 MCODE_SMOKE_DATA_ROOT 注入 dataRoot 桩)。 */
const ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!ROOT) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这套脚本必须指向临时目录");
const CWD_TMP = mkdtempSync(join(tmpdir(), "mcode-extstore-scratch-"));
/** `apps/desktop/src`(源级检查 §5 用)。run.sh 已 cd 到 apps/desktop。 */
const SRC_DIR = join(process.cwd(), "src");

/* ─────────────────── §1 契约:纯函数 ─────────────────── */
console.log("\n§1 契约:解析 / 配额 / 保留键");

eq("扩展 id 校验:正常 id 过", isValidExtensionId("u-abc123"), true);
eq("扩展 id 校验:模块 id 过", isValidExtensionId("user.file-report"), true);
eq("扩展 id 校验:. 开头拒", isValidExtensionId(".hidden"), false);
eq("扩展 id 校验:.. 拒", isValidExtensionId(".."), false);
eq("扩展 id 校验:含斜杠拒", isValidExtensionId("a/b"), false);
eq("扩展 id 校验:空串拒", isValidExtensionId(""), false);

eq("保留键 __proto__ 被拒", ExtensionStoreKeySchema.safeParse("__proto__").success, false);
eq("保留键 constructor 被拒", ExtensionStoreKeySchema.safeParse("constructor").success, false);
eq("保留键 prototype 被拒", ExtensionStoreKeySchema.safeParse("prototype").success, false);
eq("普通键放行", ExtensionStoreKeySchema.safeParse("notes").success, true);

eq("空串解析成空存储", Object.keys(parseStoreFile("").values).length, 0);
eq("坏 JSON 解析成空存储", Object.keys(parseStoreFile("{not json").values).length, 0);
eq("数组顶层解析成空存储", Object.keys(parseStoreFile("[1,2]").values).length, 0);
eq("values 缺失解析成空存储", Object.keys(parseStoreFile('{"version":1}').values).length, 0);
eq("正常文件解析出值", getStoreValue(parseStoreFile('{"version":1,"values":{"a":1}}'), "a"), 1);

{
  // 配额:一份刚好超上限的值被拒(返回 null),小值放行。
  const big = "x".repeat(EXTENSION_STORE_MAX);
  const file = emptyStore();
  eq("超配额写返回 null", withStoreValue(file, "k", big), null);
  const okFile = withStoreValue(file, "k", "small");
  check("小值写成功", okFile !== null && getStoreValue(okFile, "k") === "small");
  // withStoreValue 不改入参。
  eq("withStoreValue 不改原文件", Object.keys(file.values).length, 0);
}

{
  // UTF-8 字节数:非 ASCII 不能按 String.length 数。
  const zh = serializeStore({ version: 1, values: { k: "中文中文" } });
  check("storeBytes 按字节算(中文每字 3 字节)", storeBytes({ version: 1, values: { k: "中文中文" } }) > zh.length, {
    bytes: storeBytes({ version: 1, values: { k: "中文中文" } }),
    chars: zh.length,
  });
}

eq("withoutStoreValue 删掉键", Object.keys(withoutStoreValue({ version: 1, values: { a: 1 } }, "a").values).length, 0);
{
  const file = { version: 1 as const, values: { a: 1 } };
  check("withoutStoreValue 删不存在的键原样返回同一个对象(不无谓重排)", withoutStoreValue(file, "x") === file);
}

/* ─────────────────── §2 磁盘侧:按扩展隔离 ─────────────────── */
console.log("\n§2 磁盘侧:按扩展隔离 + 路径");

eq("extensions 目录 = <root>/extensions", extensionsDir(ROOT), join(ROOT, "extensions"));
eq("单扩展目录 = <root>/extensions/<id>", extensionDir(ROOT, "ext-a"), join(ROOT, "extensions", "ext-a"));
eq("存储文件 = <root>/extensions/<id>/store.json", extensionStorePath(ROOT, "ext-a"), join(ROOT, "extensions", "ext-a", "store.json"));

// ★ 核心:按扩展隔离。
writeValue(ROOT, "ext-a", "notes", "A 的笔记");
writeValue(ROOT, "ext-b", "notes", "B 的笔记");
eq("A 扩展读到自己的值", readValue(ROOT, "ext-a", "notes"), "A 的笔记");
eq("B 扩展读到自己的值", readValue(ROOT, "ext-b", "notes"), "B 的笔记");
check("同一个键名不同扩展不串号", readValue(ROOT, "ext-a", "notes") !== readValue(ROOT, "ext-b", "notes"));
eq("A 扩展读不存在的键 = null", readValue(ROOT, "ext-a", "nope"), null);
eq("C 扩展(从没写过)读同键 = null", readValue(ROOT, "ext-c", "notes"), null);

// 文件真的落在按扩展分的路径下。
check("A 的存储文件已落盘", existsSync(extensionStorePath(ROOT, "ext-a")));
check(
  "存储路径里不含项目目录(与项目解耦)",
  !extensionStorePath(ROOT, "ext-a").includes(CWD_TMP),
  { path: extensionStorePath(ROOT, "ext-a") },
);

// 删只动自己那份。
removeValue(ROOT, "ext-a", "notes");
eq("删掉 A 的键后 A 读不到", readValue(ROOT, "ext-a", "notes"), null);
eq("删 A 不影响 B", readValue(ROOT, "ext-b", "notes"), "B 的笔记");

/* ─────────────────── §3 磁盘侧:坏文件 / 非法 id / 配额 ─────────────────── */
console.log("\n§3 磁盘侧:坏文件 / 非法 id / 配额");

mkdirSync(extensionDir(ROOT, "ext-broken"), { recursive: true });
writeFileSync(extensionStorePath(ROOT, "ext-broken"), "{ not json", "utf8");
eq("坏文件当空存储(不抛)", Object.keys(readStore(ROOT, "ext-broken").values).length, 0);
check("坏文件之后仍能正常写", writeValue(ROOT, "ext-broken", "k", "v") && readValue(ROOT, "ext-broken", "k") === "v");

// 非法 id:读写都拒。
eq("非法 id(.. )读 = 空", Object.keys(readStore(ROOT, "..").values).length, 0);
eq("非法 id(.. )写返回 false", writeValue(ROOT, "..", "k", "v"), false);
check("非法 id 没有在数据根外层建文件", !existsSync(join(ROOT, "..", "store.json")));
removeValue(ROOT, "ext-a/../x", "k"); // 只该静默不动
check("非法 id 的 removeValue 不建任何东西", !existsSync(join(ROOT, "x")));

// 配额:一次超上限的写整次拒、不落盘。
writeValue(ROOT, "ext-quota", "keep", "small");
const before = readFileSync(extensionStorePath(ROOT, "ext-quota"), "utf8");
eq("超配额写返回 false", writeValue(ROOT, "ext-quota", "big", "x".repeat(EXTENSION_STORE_MAX)), false);
const after = readFileSync(extensionStorePath(ROOT, "ext-quota"), "utf8");
check("超配额写没落盘(文件字节不变)", before === after);
eq("超配额写没挤掉已有的值", readValue(ROOT, "ext-quota", "keep"), "small");
check("usedBytes 反映实际用量", usedBytes(ROOT, "ext-quota") > 0);

/* ─────────────────── §4 IPC handler(全部三层接线的行为面)── */
console.log("\n§4 IPC handler:三层接线 + 行为");

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as unknown as IpcMain;
registerExtensionStoreHandlers(fakeIpc);
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(null, ...args);

check("三条通道都注册了", handlers.has(EXTENSION_STORE_GET_CHANNEL) && handlers.has(EXTENSION_STORE_SET_CHANNEL) && handlers.has(EXTENSION_STORE_REMOVE_CHANNEL));

(async () => {
  deepEq("IPC set 成功", await call(EXTENSION_STORE_SET_CHANNEL, { extensionId: "ipc-ext", key: "k", value: { n: 1 } }), { ok: true });
  deepEq("IPC get 读回写入的值", ((await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: "ipc-ext", key: "k" })) as { value: unknown }).value, { n: 1 });
  eq("IPC get 读不存在的键 = null", ((await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: "ipc-ext", key: "nope" })) as { value: unknown }).value, null);
  eq("IPC set 走数据根下的 extensions/(确认写到临时根里)", existsSync(extensionStorePath(ROOT, "ipc-ext")), true);

  // 按扩展隔离也经 IPC 成立。
  await call(EXTENSION_STORE_SET_CHANNEL, { extensionId: "ipc-other", key: "k", value: "other" });
  deepEq("IPC 下同键不同扩展不串", ((await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: "ipc-ext", key: "k" })) as { value: unknown }).value, { n: 1 });

  // remove 经 IPC。
  await call(EXTENSION_STORE_REMOVE_CHANNEL, { extensionId: "ipc-ext", key: "k" });
  eq("IPC remove 之后读不到", ((await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: "ipc-ext", key: "k" })) as { value: unknown }).value, null);

  // 配额经 IPC:回 tooLarge。
  deepEq("IPC set 超配额回 tooLarge", await call(EXTENSION_STORE_SET_CHANNEL, { extensionId: "ipc-quota", key: "big", value: "x".repeat(EXTENSION_STORE_MAX) }), {
    ok: false,
    reason: "tooLarge",
    limit: EXTENSION_STORE_MAX,
  });

  // 非法 id:zod 拦截(handler 抛)。
  let rejected = false;
  try {
    await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: "..", key: "k" });
  } catch {
    rejected = true;
  }
  check("IPC 非法扩展 id 被 zod 拦下", rejected);

  let keyRejected = false;
  try {
    await call(EXTENSION_STORE_SET_CHANNEL, { extensionId: "ipc-ext", key: "__proto__", value: 1 });
  } catch {
    keyRejected = true;
  }
  check("IPC 保留键 __proto__ 被 zod 拦下", keyRejected);

  // schema 直接过一遍(形状契约)。
  eq("GetSchema 接受合法输入", ExtensionStoreGetSchema.safeParse({ extensionId: "a", key: "k" }).success, true);
  eq("SetSchema 接受合法输入", ExtensionStoreSetSchema.safeParse({ extensionId: "a", key: "k", value: null }).success, true);
  eq("RemoveSchema 接受合法输入", ExtensionStoreRemoveSchema.safeParse({ extensionId: "a", key: "k" }).success, true);
  eq("IdSchema 拒非法 id", ExtensionIdSchema.safeParse("a/b").success, false);

  rmSync(CWD_TMP, { recursive: true, force: true });

  /* ─────────────────── §5 面板存储已接到这条 IPC(源级) ─────────────────── */
  console.log("\n§5 面板存储已接到扩展数据区(源级)");
  {
    // 面板存储从前是 renderer 的 localStorage(按面板项 id 分、全局 1MB)。报告 E12 把它
    // 接到主进程这条口。这里做**源级**检查,防止哪天回退:panelBridge 必须经
    // api.extensionStore.{get,set,remove},且**不再**碰 localStorage。
    const bridge = readFileSync(join(SRC_DIR, "renderer", "components", "customUi", "panelBridge.ts"), "utf8");
    // 只在**去掉注释**的正文里找 localStorage —— 解释这段历史的注释里会提到它。
    const bridgeCode = bridge.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check("panelBridge 走 api.extensionStore.get", bridgeCode.includes("api.extensionStore.get("));
    check("panelBridge 走 api.extensionStore.set", bridgeCode.includes("api.extensionStore.set("));
    check("panelBridge 走 api.extensionStore.remove", bridgeCode.includes("api.extensionStore.remove("));
    check("panelBridge 不再用 localStorage(已接到数据区)", !bridgeCode.includes("localStorage"));
    check("panelBridge 按扩展 id 隔离(不再按面板项 storageKey)", !bridgeCode.includes("mcode.panel.v1."));
  }

  console.log(`\nextension-store-smoke:${checks - failed}/${checks} 通过`);
  if (failed > 0) process.exit(1);
})();
