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

/**
 * 存储文件名(该扩展目录**根**下的键值文件)。键值通道的读写只动这一个名字的文件。
 *
 * 键值通道(`readStore` / `persist`)与文件通道的**保留闸**共用这一个名字(不写第二份
 * 字符串字面量)—— 详见 {@link isReservedExtensionRelPath}。
 */
export const EXTENSION_STORE_FILE = "store.json";

/**
 * 扩展目录根下的**内部保留文件**判据(纯词法,renderer 与 main 共用)。
 *
 * 键值通道把数据存在 `<扩展目录>/store.json`;它的原子写(`atomicWrite`)又会在这旁边
 * 落一份临时文件(`<file>.mcode-tmp`)。**公共文件通道绝不能寻址它们** —— 否则一个扩展
 * 用文件接口往 `store.json` 写一段非 JSON,就把自己的键值存储整份毁掉(MC-096,解析层把
 * 损坏默认为空,数据无告警丢失)。
 *
 * 判据:**只在该扩展目录根**、且文件名等于 store.json 或以 `store.json.` 开头(覆盖
 * `.mcode-tmp` 临时文件与将来的备份变体)。子目录里的同名文件(`a/store.json`)不是保留
 * 文件 —— 那是扩展自己的数据,照常可读写。
 *
 * **大小写不敏感**:Windows 文件系统不分大小写,`Store.json` 会**别名**到 `store.json`
 * 同一个文件,不这么判就留一条覆盖后门。在大小写敏感的文件系统上这只会**过度拒绝**一个
 * 内部保留名(可接受,内部命名空间),不放过任何真覆盖。
 *
 * 这一层是**词法第一道**;主进程 `main/lib/extensionStore.ts` 的 `resolveInExtension` 再
 * 拦一道(真实落盘路径),两层都过才落盘(与 `isSafeExtensionRelPath` 同一姿势)。
 */
export function isReservedExtensionRelPath(p: string): boolean {
  if (typeof p !== "string") return false;
  // 按两种分隔符切段、丢掉空段与 `.` 段后,保留文件只可能是**单段**(根级文件名)。
  const segments = p.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (segments.length !== 1) return false;
  const name = segments[0].toLowerCase();
  const store = EXTENSION_STORE_FILE.toLowerCase();
  return name === store || name.startsWith(`${store}.`);
}

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

/* ──────────────── 文件通道:该扩展自己目录下的任意文件(报告附录 P)────────────────
 *
 * ## 为什么要开这条
 *
 * 上面那三条只给「键值」。而面板(扩展 UI,跑在沙箱 iframe 里)想存一个稍微像样的东西
 * —— 一段 Markdown 草稿、一份导出的 JSON、一张截图 —— 键值就不够用,该落成**文件**。
 * 可面板唯一的文件读接口 `mcode.files.read` **受项目根闸门约束**:只能读当前项目目录
 * 内的文件,**库外一律静默返回空串**(不报错)。于是扩展把数据写进自己的目录
 * (`<数据根>/extensions/<id>/…`)后,**面板自己读不回来** —— 真机实测:项目内文件读到
 * 2417 字符,数据根里那份读回 0 字符。
 *
 * 这三条补上「读写对称」:在**该扩展自己的目录**下读 / 写 / 列任意文件。
 *
 * ## 安全边界(关键)
 *
 * 路径**必须**落在 `<数据根>/extensions/<该扩展 id>/` 之内 —— {@link isSafeExtensionRelPath}
 * 在这一层做**词法**校验(拒绝对路径、盘符、UNC、任何 `..` 段);主进程
 * `main/lib/extensionStore.ts` 再做一道 **realpath** 包含检查(挡住符号链接逃逸)。
 * 扩展 id 由**桥注入**(面板脚本不能自己指定别的 id —— 见 `panelBridge.ts`)。
 *
 * 配额与键值共用 {@link EXTENSION_STORE_MAX}(单次写超限整次拒绝)。
 * 落档:与 `extensionStore.set` 同档 —— 写方法经 `policyFor` 兜底落**写档**,读落只读档。 */

/** 相对路径长度上限(与键名同量级;够深,又不至于把 IPC 载荷撑爆)。 */
const EXTENSION_REL_PATH_MAX = 1024;

/**
 * 该扩展目录内的**相对路径**判据(纯词法)。
 *
 * 拒:空 / 超长 / 含 NUL / 绝对路径(`/`、`\` 开头)/ Windows 盘符(`C:`)/ 任何 `..` 段。
 * 允许:普通相对路径(`a/b.txt`)、`.` 段(`./a` —— 无意义但无害)。
 *
 * 注意这是**第一道**闸(纯字符串、renderer 与 main 共用)。**它挡不住符号链接** ——
 * 一个真的指向目录外的 symlink 词法上是合法的相对路径。所以在主进程那层还有一道
 * **realpath 包含**检查(`physicalPath`),两道都过才落盘。
 */
export function isSafeExtensionRelPath(p: string): boolean {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > EXTENSION_REL_PATH_MAX) return false;
  if (p.includes("\0")) return false;
  // 绝对路径:unix(`/`)、UNC(`\\` 或 `//`)、Windows 盘符(`C:` / `c:/` / `c:\`)。
  if (/^[\\/]/.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  // 按两种分隔符切段,任何一段是 `..` 就拒(路径穿越)。`.` 段放行。
  if (p.split(/[\\/]+/).some((s) => s === "..")) return false;
  return true;
}

export const ExtensionRelPathSchema = z
  .string()
  .min(1)
  .max(EXTENSION_REL_PATH_MAX)
  .refine(isSafeExtensionRelPath, "路径不合法(必须是该扩展目录内的相对路径,不能是绝对路径或含 ..)");

/** 文件通道失败的原因。`tooLarge` 只在写时出现;`notAFile` / `notADir` 分读写。
 *  `reserved` = 路径指向该扩展自己的**内部保留文件**(`store.json` 及其临时/备份变体),
 *  普通文件通道不许寻址它 —— 见 {@link isReservedExtensionRelPath}(MC-096)。 */
export type ExtensionFileErrorReason =
  | "invalidPath"
  | "escapes"
  | "reserved"
  | "notFound"
  | "notAFile"
  | "notADir"
  | "tooLarge";

export const ExtensionStoreReadFileSchema = z.object({
  extensionId: ExtensionIdSchema,
  relPath: ExtensionRelPathSchema,
});
export type ExtensionStoreReadFileInput = z.infer<typeof ExtensionStoreReadFileSchema>;
/** 读回一份文件:`{ ok: true, content }` 或一条结构化失败(**不再静默返回空串** —— 那正是
 *  项目根闸门那条老路的问题)。空文件 = `ok: true, content: ""`,与 `notFound` 分得开。 */
export type ExtensionStoreReadFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: ExtensionFileErrorReason };

/** 单次写入的字符数上限。**字节**上限由主进程按 UTF-8 实测(`EXTENSION_STORE_MAX`);
 *  这一层只做个粗闸(4×上限),免得把荒唐大的载荷送过 IPC。 */
export const ExtensionStoreWriteFileSchema = z.object({
  extensionId: ExtensionIdSchema,
  relPath: ExtensionRelPathSchema,
  content: z.string().max(EXTENSION_STORE_MAX * 4),
});
export type ExtensionStoreWriteFileInput = z.infer<typeof ExtensionStoreWriteFileSchema>;
/** `ok: false, reason: "tooLarge"` 时带 `limit`(字节);其余失败不带。 */
export type ExtensionStoreWriteFileResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: ExtensionFileErrorReason; limit?: number };

export const ExtensionStoreListFilesSchema = z.object({
  extensionId: ExtensionIdSchema,
  /** 要列的相对目录;省略 / 空串 = 该扩展目录根。 */
  relPath: z
    .string()
    .max(EXTENSION_REL_PATH_MAX)
    .optional()
    .refine((v) => v === undefined || v === "" || isSafeExtensionRelPath(v), "路径不合法"),
});
export type ExtensionStoreListFilesInput = z.infer<typeof ExtensionStoreListFilesSchema>;
export interface ExtensionStoreListEntry {
  name: string;
  /** 相对该扩展目录的路径(以 `/` 分隔)。 */
  relPath: string;
  isDir: boolean;
  /** 普通文件的字节数;目录不带。 */
  size?: number;
}
export type ExtensionStoreListFilesResult =
  | { ok: true; entries: ExtensionStoreListEntry[] }
  | { ok: false; reason: ExtensionFileErrorReason };

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

/**
 * 【MC-096】`store.json` 读取的**三态事实** —— 与 `parseStoreFile` 的"坏就当空"不同:
 * 读**用于展示/取值**时可以宽容(别让扩展崩),但写**绝不能**把「坏」当「空」再覆盖 ——
 * 那会把用户原有的一整份键值**静默丢掉**(读回空 → 加一个键 → 整份重写成只剩一个键)。
 *
 *   - `MISSING`:文件不存在(全新扩展)→ 写没问题,从空起;
 *   - `VALID`:正常解析 → 照常;
 *   - `CORRUPT`:有文件但读不出/JSON 坏/形状不对 → **写侧 fail-closed 拒写**,让调用方
 *     知道"这里有一份坏了的数据,别覆盖",而不是把它当空盖掉。
 */
export type ExtensionStoreStatus = "MISSING" | "VALID" | "CORRUPT";

export interface ExtensionStoreRead {
  status: ExtensionStoreStatus;
  /** `VALID` 时是解析结果;`MISSING`/`CORRUPT` 时是空存储(调用方按 status 决定怎么用)。 */
  file: ExtensionStoreFile;
}

/** 读一份存储文件并**区分三态**(见 {@link ExtensionStoreStatus})。 */
export function readStoreFileDetailed(raw: string | null | undefined): ExtensionStoreRead {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { status: "MISSING", file: emptyStore() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "CORRUPT", file: emptyStore() };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "CORRUPT", file: emptyStore() };
  }
  const values = (parsed as { values?: unknown }).values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return { status: "CORRUPT", file: emptyStore() };
  }
  return { status: "VALID", file: { version: 1, values: values as Record<string, unknown> } };
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
export const EXTENSION_STORE_READ_FILE_CHANNEL = "extensionStore:readFile";
export const EXTENSION_STORE_WRITE_FILE_CHANNEL = "extensionStore:writeFile";
export const EXTENSION_STORE_LIST_FILES_CHANNEL = "extensionStore:listFiles";
