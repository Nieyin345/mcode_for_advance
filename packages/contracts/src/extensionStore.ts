/**
 * **扩展专用的持久数据区**(报告 E12)—— `<数据根>/extensions/<扩展 id>/store.json`。
 *
 * ## 为什么单开这块地基
 *
 * 扩展(自定义面板 / 模块)从前想存自己的数据**没有"自己的地方"**,只能三选一:
 *
 *   1. 借**项目目录** —— 污染用户的项目,换个项目就丢;
 *   2. 借**数据根** —— 污染核心数据(`mcode.db` / library 那边);
 *   3. 挤进面板的 `localStorage` —— 浏览器级 1 MB 全局上限,**所有面板共用**一份配额,
 *      彼此挤占、还会串号。
 *
 * 这里给它一块**与项目解耦、按扩展隔离、不进核心数据区**的地方:
 *
 * ```
 * <数据根>/
 *   ├── mcode.db            ← 聊天记录
 *   ├── library/            ← 文献库
 *   └── extensions/         ← ★ 本模块
 *         └── <扩展 id>/
 *               └── store.json   ← 该扩展私有的键值存储
 * ```
 *
 * 一个扩展一个目录 ⟹ 换项目不丢、删别的扩展不影响它、单个扩展写爆也挤不到别人。
 *
 * ## 边界(纯模块)
 *
 * 本文件**不 import electron / node:fs / node:path** —— 它是 renderer 与主进程共用的
 * 形状(校验 / 解析 / 结果类型),无头 smoke 直接 bundle。真正的读写(路径拼装 + 文件
 * 落盘)在主进程 `main/lib/extensionStore.ts`。
 *
 * 权限分级:这属于**写操作**。经 `policyFor` 分级,`extensionStore.get`(动词 `get`)落
 * 只读档,`extensionStore.set` / `remove`(动词不在只读前缀里)落**写档**(兜底 write),
 * 与仓库"未知方法按 write 处理"的规矩一致。**刻意不改成 danger**:面板正常使用时就靠
 * 这条口存东西,不给每次一个审批卡;真给 agent 经 `app_api_call` 调,写档那一道审批已经
 * 拦住了。
 */
import { z } from "zod";

/* ─────────────────────────── 标识与配额 ─────────────────────────── */

/**
 * 扩展 id:一段**安全的目录名** —— 会被拼进 `<数据根>/extensions/<id>/`。
 *
 * 判据:首字符是字母 / 数字(顺带排除 `.` 开头的隐藏目录与 `.` / `..`),其余允许
 * `[A-Za-z0-9._-]`,总长 ≤ 64。自定义面板项的 id(`u-<时间戳><随机>`)与模块 id
 * (`user.file-report`)都在这个集合里。
 */
const EXTENSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidExtensionId(id: string): boolean {
  // 首字符非 `.` 已由正则排除,`.` 与 `..` 因此进不来 —— 那正是路径穿越的两个形状。
  return EXTENSION_ID_RE.test(id);
}

export const ExtensionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidExtensionId, "扩展 id 不合法(只能是字母/数字/._-,且不以 . 开头)");

/** 存储里一条记录的键。`__proto__` / `constructor` / `prototype` 一律拒(原型污染)。 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const ExtensionStoreKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((k) => !RESERVED_KEYS.has(k), "这个键是保留字");

/**
 * 单个扩展的存储总量上限。
 *
 * 从前是面板 `localStorage` 的 `PANEL_STORAGE_MAX`(1 MB,**全局共用**):所有面板挤在
 * 一份里,谁写多了别人就存不下。这里改成**每个扩展各一份**、且放宽到 4 MB —— 一份
 * JSON 撑到 4 MB 已经远超"面板自己的小存储"的用途,再大就该落成文件而不是键值。
 */
export const EXTENSION_STORE_MAX = 4 * 1024 * 1024;

/* ─────────────────────────── IPC 载荷形状 ─────────────────────────── */

export const ExtensionStoreGetSchema = z.object({
  extensionId: ExtensionIdSchema,
  key: ExtensionStoreKeySchema,
});
export type ExtensionStoreGetInput = z.infer<typeof ExtensionStoreGetSchema>;
export type ExtensionStoreGetResult = { value: unknown | null };

export const ExtensionStoreSetSchema = z.object({
  extensionId: ExtensionIdSchema,
  key: ExtensionStoreKeySchema,
  value: z.unknown(),
});
export type ExtensionStoreSetInput = z.infer<typeof ExtensionStoreSetSchema>;
/** `ok: false` 只有一种原因:这份扩展的存储超过 {@link EXTENSION_STORE_MAX}。 */
export type ExtensionStoreSetResult = { ok: true } | { ok: false; reason: "tooLarge"; limit: number };

export const ExtensionStoreRemoveSchema = z.object({
  extensionId: ExtensionIdSchema,
  key: ExtensionStoreKeySchema,
});
export type ExtensionStoreRemoveInput = z.infer<typeof ExtensionStoreRemoveSchema>;
export type ExtensionStoreRemoveResult = { ok: true };

/* ─────────────────────────── 文件形状(纯函数) ─────────────────────────── */

/** 一个扩展的存储:**版本号 + 键值表**。版本号写进文件,将来格式大改换一个版本。 */
export interface ExtensionStoreFile {
  version: 1;
  values: Record<string, unknown>;
}

export function emptyStore(): ExtensionStoreFile {
  return { version: 1, values: {} };
}

/**
 * 读一份存储文件。**永远返回一份能用的**:
 *
 *   - 空 / 不是 JSON / 顶层形状不对 / `values` 不是对象 → 空存储(用户数据可能被手改坏,
 *     不能因此让扩展崩)。
 *
 * 与 `parseCustomUiConfig` 同一个规矩:坏数据当空,不抛。
 */
export function parseStoreFile(raw: string | null | undefined): ExtensionStoreFile {
  if (raw === null || raw === undefined || raw.trim().length === 0) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyStore();
  const values = (parsed as { values?: unknown }).values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) return emptyStore();
  return { version: 1, values: values as Record<string, unknown> };
}

export function serializeStore(file: ExtensionStoreFile): string {
  return JSON.stringify({ version: 1, values: file.values });
}

/** UTF-8 字节数。**不能用 `TextEncoder`** —— contracts 的 lib target 里没有 DOM / Node
 *  全局,`TextEncoder` 会 typecheck 失败。这里按**码点**手算:`for...of` 按码点迭代
 *  (代理对算一个),UTF-8 里 ≤0x7F 一个字节、≤0x7FF 两个、≤0xFFFF 三个、其余四个。 */
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x7f) n += 1;
    else if (c <= 0x7ff) n += 2;
    else if (c <= 0xffff) n += 3;
    else n += 4;
  }
  return n;
}

/** 一份存储的 UTF-8 字节数 —— 配额判据用它(不能用 `String.length`,非 ASCII 会少算)。 */
export function storeBytes(file: ExtensionStoreFile): number {
  return utf8Length(serializeStore(file));
}

/** 读一条(没有返回 `null` —— 与面板 SDK `storage.get` 的"没有 → null"语义一致)。 */
export function getStoreValue(file: ExtensionStoreFile, key: string): unknown | null {
  return Object.prototype.hasOwnProperty.call(file.values, key) ? file.values[key] : null;
}

/** 写一条,**返回新的一份**(不改入参)。超配额返回 `null` 由调用方处置。 */
export function withStoreValue(
  file: ExtensionStoreFile,
  key: string,
  value: unknown,
): ExtensionStoreFile | null {
  const next: ExtensionStoreFile = { version: 1, values: { ...file.values, [key]: value } };
  return storeBytes(next) > EXTENSION_STORE_MAX ? null : next;
}

/** 删一条,**返回新的一份**。 */
export function withoutStoreValue(file: ExtensionStoreFile, key: string): ExtensionStoreFile {
  if (!Object.prototype.hasOwnProperty.call(file.values, key)) return file;
  const values = { ...file.values };
  delete values[key];
  return { version: 1, values };
}

/* ─────────────────────────── 通道名 ─────────────────────────── */

/** 渠道字符串本体钉在这里;`rpcMap` 的 `IPC` 表引用它们(不写第二份字符串)。 */
export const EXTENSION_STORE_GET_CHANNEL = "extensionStore:get";
export const EXTENSION_STORE_SET_CHANNEL = "extensionStore:set";
export const EXTENSION_STORE_REMOVE_CHANNEL = "extensionStore:remove";
