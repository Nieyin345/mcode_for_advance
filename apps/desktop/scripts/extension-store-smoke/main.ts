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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { IpcMain } from "electron";
import {
  emptyStore,
  ExtensionIdSchema,
  ExtensionStoreKeySchema,
  ExtensionStoreGetSchema,
  ExtensionStoreSetSchema,
  ExtensionStoreRemoveSchema,
  ExtensionStoreReadFileSchema,
  ExtensionStoreWriteFileSchema,
  ExtensionStoreListFilesSchema,
  EXTENSION_STORE_GET_CHANNEL,
  EXTENSION_STORE_SET_CHANNEL,
  EXTENSION_STORE_REMOVE_CHANNEL,
  EXTENSION_STORE_READ_FILE_CHANNEL,
  EXTENSION_STORE_WRITE_FILE_CHANNEL,
  EXTENSION_STORE_LIST_FILES_CHANNEL,
  EXTENSION_STORE_MAX,
  EXTENSION_STORE_FILE,
  isValidExtensionId,
  isSafeExtensionRelPath,
  isReservedExtensionRelPath,
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
  readFileInExtension,
  writeFileInExtension,
  listFilesInExtension,
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

// ★ 【MC-096】坏 store.json 时**拒写**(不能把「坏」当「空」再整份覆盖 —— 那会丢掉用户原有那份)。
{
  const badId = "ext-corrupt";
  const badPath = extensionStorePath(ROOT, badId);
  mkdirSync(dirname(badPath), { recursive: true });
  writeFileSync(badPath, "{ this is not json", "utf-8");
  const before = readFileSync(badPath, "utf-8");
  // 读侧仍宽容(当空,不抛)—— 扩展不崩。
  eq("★ MC-096:坏 store.json 读侧仍宽容(当空 = null)", readValue(ROOT, badId, "x"), null);
  // 写侧 fail-closed:坏数据拒写。
  check("★ MC-096:坏 store.json → writeValue 拒写(不覆盖)", writeValue(ROOT, badId, "newKey", "newVal") === false);
  eq("★ MC-096:拒写后磁盘内容逐字节未变(坏数据还在,没被盖成新的一份)", readFileSync(badPath, "utf-8"), before);
  // 正控:正常文件照写(证明拒的只可能是"坏"这个理由,不是"什么都拒")。
  writeFileSync(badPath, JSON.stringify({ version: 1, values: { keep: "KEEP" } }), "utf-8");
  check("★ MC-096:合法 store.json 照常写(正控)", writeValue(ROOT, badId, "added", 1) === true);
  eq("★ MC-096:写入后原有键仍在(没被清掉)", readValue(ROOT, badId, "keep"), "KEEP");
  eq("★ MC-096:写入后新键也在", readValue(ROOT, badId, "added"), 1);
}

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
// 【MC-096】坏文件**之后不能"正常写"** —— 那会把「坏」当「空」再整份覆盖,静默丢掉用户原有数据。
// 从前这条断言正是那个 fail-open 的凭证;现在写侧 fail-closed:坏数据拒写,原文件不动。
check("★ MC-096:坏文件之后**拒写**(不再把坏当空覆盖)", writeValue(ROOT, "ext-broken", "k", "v") === false);
eq("★ MC-096:拒写后原文件内容未变", readFileSync(extensionStorePath(ROOT, "ext-broken"), "utf-8"), "{ not json");

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

/* ─────────────────── §3.5 文件通道:读写对称 + 路径闸(报告附录 P)───────────────────
 *
 * 这是修「能写不能读」的那一条:面板把数据写进**自己目录**后要能读回来。判据:
 *   1. 写进去 → 读回来(空文件与"不存在"分得开);
 *   2. 绝对路径 / `..` / 盘符 被**契约层** `isSafeExtensionRelPath` 拒;
 *   3. lib 层 `resolveInExtension` 对 `..` 逃逸再拒一道(第二道);
 *   4. `listFiles` 只列**自己**目录,且**不含**别的扩展的文件;
 *   5. 超配额写整次拒、不落盘;
 *   6. 符号链接逃逸被 realpath 那道挡下(Windows 上需权限,拿不到就跳)。 */
console.log("\n§3.5 文件通道:读写对称 + 路径闸(报告附录 P)");

// ① 纯词法判据(契约层,renderer 与 main 共用)。
eq("路径闸:普通相对路径过", isSafeExtensionRelPath("notes/a.md"), true);
eq("路径闸:多级过", isSafeExtensionRelPath("a/b/c.txt"), true);
eq("路径闸:./ 段过", isSafeExtensionRelPath("./a.txt"), true);
eq("路径闸:绝对(unix)拒", isSafeExtensionRelPath("/etc/passwd"), false);
eq("路径闸:绝对(win 反斜杠)拒", isSafeExtensionRelPath("\\Windows\\x"), false);
eq("路径闸:盘符拒", isSafeExtensionRelPath("C:/Windows/x"), false);
eq("路径闸:盘符(小写)拒", isSafeExtensionRelPath("c:\\x"), false);
eq("路径闸:UNC 拒", isSafeExtensionRelPath("\\\\server\\share"), false);
eq("路径闸:.. 段拒", isSafeExtensionRelPath("../evil"), false);
eq("路径闸:中间 .. 段拒", isSafeExtensionRelPath("a/../../evil"), false);
eq("路径闸:反斜杠 .. 也拒", isSafeExtensionRelPath("a\\..\\evil"), false);
eq("路径闸:空串拒", isSafeExtensionRelPath(""), false);
eq("路径闸:NUL 拒", isSafeExtensionRelPath("a\0b"), false);

// ② zod schema:非法路径在 IPC 边界就拒(handler 抛)。
eq("ReadFileSchema 过合法", ExtensionStoreReadFileSchema.safeParse({ extensionId: "a", relPath: "n/a.md" }).success, true);
eq("ReadFileSchema 拒 ..", ExtensionStoreReadFileSchema.safeParse({ extensionId: "a", relPath: "../x" }).success, false);
eq("ReadFileSchema 拒绝对路径", ExtensionStoreReadFileSchema.safeParse({ extensionId: "a", relPath: "/x" }).success, false);
eq("WriteFileSchema 拒 ..", ExtensionStoreWriteFileSchema.safeParse({ extensionId: "a", relPath: "..", content: "x" }).success, false);
eq("ListFilesSchema 空 relPath 过(省略 = 根)", ExtensionStoreListFilesSchema.safeParse({ extensionId: "a" }).success, true);
eq("ListFilesSchema 拒 ..", ExtensionStoreListFilesSchema.safeParse({ extensionId: "a", relPath: "../x" }).success, false);

// ③ lib 层:写进去能读回来 + 目录/文件区分。
{
  const w = writeFileInExtension(ROOT, "ext-files", "notes/draft.md", "# 草稿");
  // UTF-8 字节:'#'(1)+' '(1)+草(3)+稿(3)= 8。
  deepEq("写文件成功(bytes 按 UTF-8 算)", w, { ok: true, bytes: 8 });
  const r = readFileInExtension(ROOT, "ext-files", "notes/draft.md");
  deepEq("★ 写进去能读回来", r, { ok: true, content: "# 草稿" });
  check("文件真的落在 <root>/extensions/<id>/ 下", existsSync(join(extensionsDir(ROOT), "ext-files", "notes", "draft.md")));

  // 空文件 vs 不存在:两种要分得开(项目根闸门那条老路就是都回空串)。
  writeFileInExtension(ROOT, "ext-files", "empty.txt", "");
  deepEq("空文件读回 ok:true content:''", readFileInExtension(ROOT, "ext-files", "empty.txt"), { ok: true, content: "" });
  deepEq("不存在的文件 ok:false notFound(不静默回空)", readFileInExtension(ROOT, "ext-files", "nope.txt"), { ok: false, reason: "notFound" });

  // 读一个目录当文件 —— notAFile。
  deepEq("读目录当文件 = notAFile", readFileInExtension(ROOT, "ext-files", "notes"), { ok: false, reason: "notAFile" });

  // ④ listFiles 只列自己目录。
  const ls = listFilesInExtension(ROOT, "ext-files", "notes");
  check("listFiles 列出自己 notes/ 下的 draft.md", ls.ok && ls.entries.some((e) => e.name === "draft.md" && !e.isDir), ls);
  // 另一个扩展写同名文件,不能串进 ext-files 的列表。
  writeFileInExtension(ROOT, "ext-other", "notes/draft.md", "别人的");
  const ls2 = listFilesInExtension(ROOT, "ext-files", "notes");
  check("listFiles 不含别的扩展的文件", ls2.ok && ls2.entries.length === 1, ls2);
  const rootLs = listFilesInExtension(ROOT, "ext-files");
  check("listFiles 根列到 notes/(目录)", rootLs.ok && rootLs.entries.some((e) => e.name === "notes" && e.isDir), rootLs);
  check("listFiles 目录在前、普通文件在后", rootLs.ok && rootLs.entries[0]?.isDir === true, rootLs.ok ? rootLs.entries.map((e) => e.name) : rootLs);
  deepEq("listFiles 列不存在目录 = notFound", listFilesInExtension(ROOT, "ext-files", "no-such-dir"), { ok: false, reason: "notFound" });
  deepEq("listFiles 列一个文件当目录 = notADir", listFilesInExtension(ROOT, "ext-files", "empty.txt"), { ok: false, reason: "notADir" });
}

// ⑤ lib 层路径闸(第二道):`..` / 绝对路径在 lib 也拒(不只是 zod)。写不允许逃逸。
{
  const esc = writeFileInExtension(ROOT, "ext-files", "../evil.txt", "x");
  deepEq("lib 层写 ../evil 被拒", esc, { ok: false, reason: "invalidPath" });
  check("没有在 extensions/ 外层建 evil.txt", !existsSync(join(ROOT, "extensions", "evil.txt")));
  deepEq("lib 层读绝对路径被拒", readFileInExtension(ROOT, "ext-files", "/etc/passwd"), { ok: false, reason: "invalidPath" });
  deepEq("lib 层写盘符路径被拒", writeFileInExtension(ROOT, "ext-files", "D:/evil.txt", "x"), { ok: false, reason: "invalidPath" });
  deepEq("lib 层 listFiles ../ 被拒", listFilesInExtension(ROOT, "ext-files", "../"), { ok: false, reason: "invalidPath" });
  // 非法扩展 id:整个通道拒。
  deepEq("非法扩展 id 写被拒", writeFileInExtension(ROOT, "..", "a.txt", "x"), { ok: false, reason: "invalidPath" });
  check("非法扩展 id 没在数据根外层建文件", !existsSync(join(ROOT, "extensions", "..", "a.txt")));
}

// ⑥ 超配额写整次拒、不落盘。
{
  writeFileInExtension(ROOT, "ext-fquota", "keep.txt", "small");
  const beforeBytes = readFileSync(join(extensionsDir(ROOT), "ext-fquota", "keep.txt"), "utf8");
  const big = writeFileInExtension(ROOT, "ext-fquota", "big.txt", "x".repeat(EXTENSION_STORE_MAX + 1));
  deepEq("★ 超配额写被拒(整次,不落盘)", big, { ok: false, reason: "tooLarge", limit: EXTENSION_STORE_MAX });
  check("超配额写没落盘 big.txt", !existsSync(join(extensionsDir(ROOT), "ext-fquota", "big.txt")));
  check("超配额写没碰已有的 keep.txt", readFileSync(join(extensionsDir(ROOT), "ext-fquota", "keep.txt"), "utf8") === beforeBytes);
  // 非 ASCII 按字节算配额:一份 `ceil(MAX/3)+1` 个中文字符(每字 3 字节)会**超过** MAX。
  // 若按 `String.length` 数,这么点字符远不到 MAX,就会误判成"能写"。
  const zhBig = "中".repeat(Math.ceil(EXTENSION_STORE_MAX / 3));
  const zhRes = writeFileInExtension(ROOT, "ext-fquota", "zh.txt", zhBig);
  check("★ 配额按 UTF-8 字节算(非 ASCII 不按 String.length)", !zhRes.ok && zhRes.reason === "tooLarge", zhRes);
}

// ⑦ 逃逸:在扩展目录下放一个指向**目录外**的链接,读写都要被 realpath 那道挡下。
//
// ⚠️ 独立复核挑出的**空覆盖**:从前建不出 symlink(Windows 普通权限 EPERM)就 `skip` ——
// 于是这道安全闸在多数 Windows 机器上**从未被断言过**(跑绿了但没验过)。改用**两级回退**:
// 先试 symlink,不行就试 Windows **junction**(`mklink /J`,**不需要管理员**,普通用户
// 就能建)。两者都不行才 skip —— 且如实说清"这道闸本次没验"。
{
  // ⚠️ **逃逸目标必须是本套自己的临时目录**,不能用 `tmpdir()` 本身 —— 那是**系统共享**
  // 目录,别的套件/上次跑的残留会让"库外没出现 pwn.txt"这条假红(实测:全量跑时撞上)。
  const outside = mkdtempSync(join(tmpdir(), "mcode-ext-outside-"));
  const linkPath = join(extensionDir(ROOT, "ext-files"), "link-out");
  let how: "symlink" | "junction" | null = null;
  try {
    symlinkSync(outside, linkPath, "dir");
    how = "symlink";
  } catch {
    // Windows:回退到 junction(普通权限可建)。
    try {
      mkdirSync(extensionDir(ROOT, "ext-files"), { recursive: true });
      const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, outside], { encoding: "utf8" });
      how = r.status === 0 && existsSync(linkPath) ? "junction" : null;
    } catch {
      how = null;
    }
  }
  if (how) {
    // 正控:链接确实指向目录外(否则断言是空过)。
    check("逃逸链接真指向扩展目录外", resolve(linkPath) !== resolve(extensionDir(ROOT, "ext-files")));
    deepEq("★ 经 " + how + " 逃逸的写被拒", writeFileInExtension(ROOT, "ext-files", "link-out/pwn.txt", "x"), { ok: false, reason: "invalidPath" });
    deepEq("★ 经 " + how + " 逃逸的读被拒", readFileInExtension(ROOT, "ext-files", "link-out/anything"), { ok: false, reason: "invalidPath" });
    // 库外**确实没有**被写进去(证明是"拒绝"而不是"写了但返回值是 false")。
    check("★ 库外没有真出现 pwn.txt", !existsSync(join(outside, "pwn.txt")));
  } else {
    console.log("  ⚠️ skip 逃逸断言(本机既建不了 symlink 也建不了 junction)—— 这道闸本次**没验**");
  }
  rmSync(outside, { recursive: true, force: true });
}

/* ─────────────────── §7.5 根级 Junction 逃逸(MC-095)───────────────────
 *
 * E1 复现的缺陷:`<root>/extensions/jump` 是**指向外部目录的 Junction**(不是子目录里
 * 的链接,而是**扩展 ID 根目录自己**),调用 `writeFileInExtension(root,"jump","pwn.txt")`
 * 曾返回 `{ok:true}` 且外部目录真收到文件 —— 因为 `physicalExtensionDir` 盲信了根目录的
 * realpath,而 `resolveInExtension` 之后只相对这个**已越界的 dir** 做检查。
 *
 * 修复:根目录的 realpath 必须仍在 `extensions/` 的物理目录内(复用 realPathWithin)。
 * 与 §7(子路径链接)的区别:§7 建的是扩展目录**内部**的链接;这里建的是**扩展根目录
 * 本身**——它是"扩展 id 就是一条链接"这一档,§7 覆盖不到。
 *
 * 两侧都验:文件通道(`writeFileInExtension`/`readFileInExtension`/`listFilesInExtension`)
 * 与键值通道(`writeValue`/`readValue`)必须都拒,且**外部目录一个字节都没多**。 */
console.log("\n§7.5 根级 Junction/symlink 逃逸(MC-095)");

/** 在 `linkPath` 建一条指向 `target` 的目录链接:symlink 优先,Windows 回退 junction。 */
function makeDirLink(target: string, linkPath: string): "symlink" | "junction" | null {
  try {
    symlinkSync(target, linkPath, "dir");
    return "symlink";
  } catch {
    try {
      const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, target], { encoding: "utf8" });
      return r.status === 0 && existsSync(linkPath) ? "junction" : null;
    } catch {
      return null;
    }
  }
}

{
  // 外部目标 = 本套自己的临时目录(不能用共享 tmpdir() —— 残留会造出假红)。
  const outside = mkdtempSync(join(tmpdir(), "mcode-ext-root-outside-"));
  // 关键:把**扩展 ID 根目录本身**建成链接 —— 这正是 §7 覆盖不到的那一档。
  const rootLink = extensionDir(ROOT, "jump-root");
  mkdirSync(extensionsDir(ROOT), { recursive: true });
  const how = makeDirLink(outside, rootLink);

  if (how) {
    // 正控:扩展根目录**确实是**一条指向库外的目录链接(E2 不是空过 —— 否则下面的断言
    // 可能只是"路径恰好不存在"而非"闸挡下了")。
    check("★ 扩展根目录确实是目录链接(lstat 认作符号链接/junction)", lstatSync(rootLink).isSymbolicLink(), { how });
    const realRootTarget = realpathSync.native(rootLink);
    check(
      "★ 根链接的真实目的地在扩展区之外",
      !realRootTarget.toLowerCase().startsWith(realpathSync.native(extensionsDir(ROOT)).toLowerCase()),
      { realRootTarget },
    );

    // ① 文件通道:写/读/列都必须拒,且外部目录不能多出文件。
    //    先把**外部目录**布置成"里面确实有内容"——否则读/列的断言可能只是"文件恰好
    //    不存在"而非真被闸挡下(撤掉修复也照样绿 = 空过)。sentinel 内容被读到就证明逃逸。
    writeFileSync(join(outside, "leak.md"), "EXTERNAL_SECRET", "utf8");
    deepEq(
      "★ 经根 " + how + " 的文件写被拒",
      writeFileInExtension(ROOT, "jump-root", "pwn.txt", "TEST_ONLY"),
      { ok: false, reason: "invalidPath" },
    );
    deepEq(
      "★ 经根 " + how + " 的读挡在库外文件之前(不泄漏外部内容)",
      readFileInExtension(ROOT, "jump-root", "leak.md"),
      { ok: false, reason: "notFound" },
    );
    deepEq(
      "★ 经根 " + how + " 的 listFiles 被拒(不列库外目录)",
      listFilesInExtension(ROOT, "jump-root"),
      { ok: false, reason: "notFound" },
    );
    check("★ 外部目录没有被写进 pwn.txt", !existsSync(join(outside, "pwn.txt")));

    // ② 键值通道:同一道根闸也要挡住(store.json 不能落到库外)。
    const kvOk = writeValue(ROOT, "jump-root", "important", "KEEP_ME");
    eq("★ 经根 " + how + " 的键值写被拒", kvOk, false);
    check("★ 外部目录没有被写进 store.json", !existsSync(join(outside, "store.json")));
    // 读侧独立判据:外部目录**先**放一份真 store.json,读必须回 null(不泄漏库外键值)。
    // 这条把「读闸」和「写闸」分开验 —— 只撤写闸、读闸还在时,上面两条仍绿,靠这条抓。
    writeFileSync(join(outside, "store.json"), '{"version":1,"values":{"leaked":"EXTERNAL_KV"}}', "utf8");
    eq("★ 经根 " + how + " 的键值读回 null(不泄漏库外 store.json)", readValue(ROOT, "jump-root", "leaked"), null);

    // ③ 同 ID 若换回**真实子目录**,一切照常(闸只挡逃逸,不误伤正常路径)。
    //    (jump-root 仍是链接 —— 这里换一个干净的 id 验正常路径没被这道闸连坐。)
    check("根闸不误伤正常扩展的写", writeFileInExtension(ROOT, "normal-sib", "ok.txt", "v").ok);
    check("根闸不误伤正常扩展的读", readFileInExtension(ROOT, "normal-sib", "ok.txt").ok);
  } else {
    console.log("  ⚠️ skip 根逃逸断言(本机既建不了 symlink 也建不了 junction)—— 这道闸本次**没验**");
  }
  rmSync(outside, { recursive: true, force: true });
  rmSync(rootLink, { recursive: true, force: true });
}

/* ─────────────────── §6.5 内部保留文件闸(MC-096)───────────────────
 *
 * E1 复现的缺陷:键值 `important=KEEP_ME` 落进 `<扩展目录>/store.json` 后,用**公共文件
 * 通道** `writeFileInExtension(root,"good","store.json","NOT_JSON")` 返回 `{ok:true}` ——
 * 把这个扩展自己的键值存储整个覆盖成一段非 JSON,随后 `readValue` 回 null(解析层把损坏
 * 默认为空),数据无告警丢失。
 *
 * 修复:文件通道(`readFileInExtension`/`writeFileInExtension`/`listFilesInExtension`)
 * 对该扩展目录**根**下的内部保留文件(`store.json` 及其临时/备份变体,同一常量
 * `EXTENSION_STORE_FILE`)一律拒(`reason:"reserved"`)。子目录里的同名文件照常可读写
 * (那是扩展自己的数据)。 */
console.log("\n§6.5 内部保留文件闸(MC-096)");

// ① 纯词法判据(契约层)。
eq("保留判据:store.json 保留", isReservedExtensionRelPath("store.json"), true);
eq("保留判据:store.json.mcode-tmp 保留", isReservedExtensionRelPath("store.json.mcode-tmp"), true);
eq("保留判据:store.json.bak 保留", isReservedExtensionRelPath("store.json.bak"), true);
eq("保留判据:大小写变体 Store.json 保留", isReservedExtensionRelPath("Store.json"), true);
eq("保留判据:子目录 a/store.json 不保留", isReservedExtensionRelPath("a/store.json"), false);
eq("保留判据:普通文件 notes.md 不保留", isReservedExtensionRelPath("notes.md"), false);
eq("保留判据:store.txt 不保留", isReservedExtensionRelPath("store.txt"), false);
eq("保留判据:./store.json 仍保留", isReservedExtensionRelPath("./store.json"), true);

{
  const id = "ext-reserved";
  // 键值先写一条,值就是"要被毁掉的证据"。
  eq("保留闸:键值写成功", writeValue(ROOT, id, "important", "KEEP_ME"), true);
  eq("保留闸:键值读得到", readValue(ROOT, id, "important"), "KEEP_ME");

  // ② 文件通道写 store.json 必须被拒,且**一个字节都不落盘**。
  deepEq("★ 文件通道写 store.json 被拒(不是 ok:true)", writeFileInExtension(ROOT, id, "store.json", "NOT_JSON"), { ok: false, reason: "reserved" });
  deepEq("★ 文件通道写 store.json.mcode-tmp 被拒", writeFileInExtension(ROOT, id, "store.json.mcode-tmp", "X"), { ok: false, reason: "reserved" });
  deepEq("★ 文件通道写大小写变体 Store.json 被拒", writeFileInExtension(ROOT, id, "Store.json", "X"), { ok: false, reason: "reserved" });
  // (撤掉修复时,上面这条会返回 ok:true 并真覆盖 —— 下面这条才是"数据还在"的独立判据。)
  eq("★ 键值未被覆盖(重要数据还在)", readValue(ROOT, id, "important"), "KEEP_ME");
  check("★ 存储文件内容仍是合法键值(不是 NOT_JSON)", readFileSync(extensionStorePath(ROOT, id), "utf8").includes("KEEP_ME"));

  // ③ 读 / 列也不许寻址保留文件(否则能读出内部键值、列出内部文件)。
  deepEq("★ 文件通道读 store.json 被拒", readFileInExtension(ROOT, id, "store.json"), { ok: false, reason: "reserved" });
  deepEq("★ 文件通道读 store.json.mcode-tmp 被拒", readFileInExtension(ROOT, id, "store.json.mcode-tmp"), { ok: false, reason: "reserved" });
  const rootLs = listFilesInExtension(ROOT, id);
  check("★ listFiles 根级不含 store.json(保留文件被过滤)", rootLs.ok && rootLs.entries.every((e) => e.name.toLowerCase() !== "store.json"), rootLs.ok ? rootLs.entries.map((e) => e.name) : rootLs);
  deepEq("★ listFiles 列 store.json 这个文件被拒", listFilesInExtension(ROOT, id, "store.json"), { ok: false, reason: "reserved" });

  // ④ 子目录里的同名文件**不是**保留文件 —— 扩展自己的数据照常可读写(不误伤)。
  deepEq("保留闸不误伤子目录同名文件(写)", writeFileInExtension(ROOT, id, "sub/store.json", "LEGIT"), { ok: true, bytes: 5 });
  deepEq("保留闸不误伤子目录同名文件(读)", readFileInExtension(ROOT, id, "sub/store.json"), { ok: true, content: "LEGIT" });
}



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

  /* ── 文件通道 IPC handler(报告附录 P):读写对称 + 越界在 IPC 边界就被拒 ── */
  check(
    "六条通道都注册了(含文件通道三条)",
    handlers.has(EXTENSION_STORE_READ_FILE_CHANNEL) && handlers.has(EXTENSION_STORE_WRITE_FILE_CHANNEL) && handlers.has(EXTENSION_STORE_LIST_FILES_CHANNEL),
  );
  deepEq("★ IPC writeFile → readFile 读写对称", await (async () => {
    const w = await call(EXTENSION_STORE_WRITE_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "a/b.txt", content: "hello" });
    if (!(w as { ok: boolean }).ok) return w;
    return call(EXTENSION_STORE_READ_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "a/b.txt" });
  })(), { ok: true, content: "hello" });
  deepEq("IPC readFile 不存在 = ok:false notFound", await call(EXTENSION_STORE_READ_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "nope.txt" }), { ok: false, reason: "notFound" });
  {
    const ls = listFilesInExtension(ROOT, "ipc-files", "a");
    check("IPC listFiles 列出自己目录", ls.ok && ls.entries.some((e) => e.name === "b.txt"), ls);
  }
  deepEq("IPC writeFile 超配额回 tooLarge", await call(EXTENSION_STORE_WRITE_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "big.txt", content: "x".repeat(EXTENSION_STORE_MAX + 1) }), {
    ok: false,
    reason: "tooLarge",
    limit: EXTENSION_STORE_MAX,
  });

  // MC-096:经 IPC 的公共文件通道也不许寻址内部保留文件 —— 键值仍在。
  {
    const id = "ipc-reserved";
    await call(EXTENSION_STORE_SET_CHANNEL, { extensionId: id, key: "important", value: "KEEP_ME" });
    deepEq("★ IPC writeFile 写 store.json 被拒", await call(EXTENSION_STORE_WRITE_FILE_CHANNEL, { extensionId: id, relPath: "store.json", content: "NOT_JSON" }), { ok: false, reason: "reserved" });
    deepEq("★ IPC readFile 读 store.json 被拒", await call(EXTENSION_STORE_READ_FILE_CHANNEL, { extensionId: id, relPath: "store.json" }), { ok: false, reason: "reserved" });
    eq("★ IPC 后键值仍在(KEEP_ME)", ((await call(EXTENSION_STORE_GET_CHANNEL, { extensionId: id, key: "important" })) as { value: unknown }).value, "KEEP_ME");
  }

  // 越界路径:zod 在 IPC 边界就拒(handler 抛),不落到 lib。
  for (const [label, api, bad] of [
    ["readFile", EXTENSION_STORE_READ_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "../evil" }],
    ["writeFile", EXTENSION_STORE_WRITE_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "/etc/x", content: "x" }],
    ["listFiles", EXTENSION_STORE_LIST_FILES_CHANNEL, { extensionId: "ipc-files", relPath: "../" }],
    ["readFile 盘符", EXTENSION_STORE_READ_FILE_CHANNEL, { extensionId: "ipc-files", relPath: "C:/x" }],
  ] as const) {
    let escRejected = false;
    try {
      await call(api, bad);
    } catch {
      escRejected = true;
    }
    check(`★ IPC ${label} 越界路径被 zod 拦下`, escRejected);
  }
  check("IPC 越界写没在 extensions/ 外层建文件", !existsSync(join(ROOT, "extensions", "evil")) && !existsSync(join(ROOT, "evil")));

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
    // 文件通道(报告附录 P):面板走 extension.* → api.extensionStore.* —— **扩展 id 由桥
    // 用 `host.item.id` 注入**,面板脚本指定不了别的 id。这是那条"只能访问自己"的安全边界。
    check("panelBridge 文件通道走 api.extensionStore.readFile", bridgeCode.includes("api.extensionStore.readFile("));
    check("panelBridge 文件通道走 api.extensionStore.writeFile", bridgeCode.includes("api.extensionStore.writeFile("));
    check("panelBridge 文件通道走 api.extensionStore.listFiles", bridgeCode.includes("api.extensionStore.listFiles("));
    check("★ 文件通道用面板项自己的 id 当 extensionId(不是脚本传的)",
      bridgeCode.includes('api.extensionStore.readFile({ extensionId: host.item.id') &&
      bridgeCode.includes('api.extensionStore.writeFile({ extensionId: host.item.id') &&
      bridgeCode.includes('api.extensionStore.listFiles({ extensionId: host.item.id'),
    );
    // 面板 SDK 里 extension.* 的名字(契约层 PANEL_METHODS + SDK 源)。
    const panelSrc = readFileSync(join(SRC_DIR, "../../../packages/contracts/src/customUiPanel.ts"), "utf8");
    check("契约 PANEL_METHODS 含 extension.readFile", panelSrc.includes('"extension.readFile"'));
    check("契约 PANEL_METHODS 含 extension.writeFile", panelSrc.includes('"extension.writeFile"'));
    check("契约 PANEL_METHODS 含 extension.listFiles", panelSrc.includes('"extension.listFiles"'));
    check("★ SDK 暴露 mcode.extension.{readFile,writeFile,listFiles}",
      /extension:\s*\{\s*\n\s*readFile:/.test(panelSrc) &&
      panelSrc.includes('call("extension.readFile"') &&
      panelSrc.includes('call("extension.writeFile"') &&
      panelSrc.includes('call("extension.listFiles"'));
  }

  console.log(`\nextension-store-smoke:${checks - failed}/${checks} 通过`);
  if (failed > 0) process.exit(1);
})();
