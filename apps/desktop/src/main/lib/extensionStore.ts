/**
 * 扩展专用数据区的**磁盘侧** —— `<数据根>/extensions/<扩展 id>/store.json`。
 *
 * 纯函数(读 / 写 / 删 / 路径拼装)只收一个 `root`(数据根),**不 import electron**;
 * 无头 smoke 直接 bundle 本文件、传一个临时目录当数据根。真正的 IPC handler 在
 * `main/ipc/extensions.ts`,它把 `dataRoot()` 注进来。
 *
 * 契约(形状 / 校验 / 配额 / 通道名)在 `@contracts/extensionStore`。
 *
 * ## 与 `db.export()` 那一类"整库重写"的区别
 *
 * 这里**不是**数据库:每个扩展一份独立的小 JSON,写它只动它自己那份 —— 撞不见聊天
 * 记录、也撞不见别的扩展。落盘走 `atomicWrite`(tmp + rename),写到一半崩了不会留下
 * 半份 JSON。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  emptyStore,
  getStoreValue,
  isSafeExtensionRelPath,
  isValidExtensionId,
  parseStoreFile,
  serializeStore,
  storeBytes,
  withStoreValue,
  withoutStoreValue,
  EXTENSION_STORE_MAX,
  type ExtensionStoreFile,
  type ExtensionStoreListEntry,
  type ExtensionStoreListFilesResult,
  type ExtensionStoreReadFileResult,
  type ExtensionStoreWriteFileResult,
} from "@contracts/extensionStore";
import { atomicWrite } from "@main/lib/appContext.js";

/** `<数据根>/extensions`。 */
export function extensionsDir(root: string): string {
  return join(root, "extensions");
}

/** `<数据根>/extensions/<扩展 id>`。**调用方必须先校验 id** —— 这里只拼。 */
export function extensionDir(root: string, extensionId: string): string {
  return join(extensionsDir(root), extensionId);
}

/** 该扩展的存储文件:`<数据根>/extensions/<扩展 id>/store.json`。 */
export function extensionStorePath(root: string, extensionId: string): string {
  return join(extensionDir(root, extensionId), "store.json");
}

/**
 * 读一份存储。文件不存在 / 坏了 → 空存储(不是抛)。
 *
 * id 非法直接当空 —— 上层 handler 已经用 zod 挡过,这里再兜一道,免得拼出越界路径。
 */
export function readStore(root: string, extensionId: string): ExtensionStoreFile {
  if (!isValidExtensionId(extensionId)) return emptyStore();
  const path = extensionStorePath(root, extensionId);
  try {
    if (!existsSync(path)) return emptyStore();
    return parseStoreFile(readFileSync(path, "utf8"));
  } catch {
    return emptyStore();
  }
}

/** 读一条。 */
export function readValue(root: string, extensionId: string, key: string): unknown | null {
  return getStoreValue(readStore(root, extensionId), key);
}

/** 写一份(整份落盘)。 */
function persist(root: string, extensionId: string, file: ExtensionStoreFile): void {
  atomicWrite(extensionStorePath(root, extensionId), serializeStore(file));
}

/**
 * 写一条。**超过 {@link EXTENSION_STORE_MAX} 时整次拒绝、不落盘** —— 返回 `false`,
 * 由调用方回一句"存储已满"。写成功返回 `true`。
 *
 * id 非法也返回 `false`(不落盘):上层 zod 已经挡过,这里是**第二道** —— 少了它,
 * 一个 `..` 开头的 id 会被 `join` 拼成数据根外的路径(`extensions/../evil`)。
 */
export function writeValue(root: string, extensionId: string, key: string, value: unknown): boolean {
  if (!isValidExtensionId(extensionId)) return false;
  const file = readStore(root, extensionId);
  const next = withStoreValue(file, key, value);
  if (next === null) return false;
  persist(root, extensionId, next);
  return true;
}

/** 删一条。没有这个键就不写(不无谓地重排文件)。id 非法直接不动。 */
export function removeValue(root: string, extensionId: string, key: string): void {
  if (!isValidExtensionId(extensionId)) return;
  const file = readStore(root, extensionId);
  const next = withoutStoreValue(file, key);
  if (next === file) return;
  persist(root, extensionId, next);
}

/** 当前用掉的字节数(配额判据;给未来的"看用了多少"入口留一个出口)。 */
export function usedBytes(root: string, extensionId: string): number {
  return storeBytes(readStore(root, extensionId));
}

/* ═══════════════════════ 文件通道:该扩展自己目录下的任意文件(报告附录 P)═══════════════════════
 *
 * 键值(`store.json`)只能装小东西;面板要落一份 Markdown / 导出 JSON / 截图时,得在一个
 * **该扩展自己的**目录下读写任意文件 —— 而面板唯一的文件接口 `mcode.files.read` 受项目根
 * 闸门,库外静默返回空串(真机实测:项目内读到 2417 字符、数据根里那份读回 0)。这三条补上。
 *
 * ## 为什么这里还带 `sep` 与 `..` 检查(契约层已经查过一遍)
 *
 * 契约的 {@link isSafeExtensionRelPath} 是**纯词法**第一道闸,但它**挡不住符号链接** ——
 * 一个指向目录外的 symlink 词法上完全合法。所以这里第二条:按段切、拒 `..`(第二道),
 * 再对**物理路径**做包含检查(`isWithinExtensionDir` 用 `realpathSync`,挡 symlink/UNC
 * 逃逸)。三道都过才落盘。 */

/** `<数据根>/extensions/<扩展 id>` 的**物理**路径(解析符号链接);目录不存在时返回 null。 */
function physicalExtensionDir(root: string, extensionId: string): string | null {
  try {
    const realRoot = realpathSync.native(extensionsDir(root));
    const candidate = join(realRoot, extensionId);
    if (!existsSync(candidate)) return null;
    const real = realpathSync.native(candidate);
    return real;
  } catch {
    return null;
  }
}

type ResolveResult = { ok: true; abs: string; dir: string } | { ok: false; reason: "invalidPath" | "notFound" };

/**
 * 把 `relPath` 拼成该扩展目录下的**物理**绝对路径,并确认它**没有逃出**那个目录。
 *
 * - `createDir=true`(写):扩展目录不存在时**先建**(与 `writeValue` 的 atomicWrite 建目录
 *   同一姿势);`false`(读/列):目录不存在 → `notFound`(不是 invalidPath —— 那不是"路径
 *   不合法",是"这个扩展还没有任何文件")。
 *
 * 逃逸判据:`target` 必须等于扩展目录,或以其 + `sep` 开头(与 `pathGuard.contained` 同一
 * 姿势);两端都过 `realpath`,一个中间段是 symlink 的路径在这里露馅。
 */
function resolveInExtension(
  root: string,
  extensionId: string,
  relPath: string,
  createDir: boolean,
): ResolveResult {
  if (!isValidExtensionId(extensionId)) return { ok: false, reason: "invalidPath" };
  if (!isSafeExtensionRelPath(relPath)) return { ok: false, reason: "invalidPath" };
  let dir = physicalExtensionDir(root, extensionId);
  if (dir === null) {
    if (!createDir) return { ok: false, reason: "notFound" };
    const rawDir = extensionDir(root, extensionId);
    try {
      mkdirSync(rawDir, { recursive: true });
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    // 建完之后物理目录要是**目录**(万一被一个同名文件/符号链接占着)。
    try {
      if (!lstatSync(rawDir).isDirectory()) return { ok: false, reason: "invalidPath" };
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    dir = physicalExtensionDir(root, extensionId);
    if (dir === null) return { ok: false, reason: "invalidPath" };
  }
  // 拼接:按 `/` 与 `\` 切段后逐段 join —— 段里已无 `..`(上面查过),所以 join 不会上跳。
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  const target = resolve(dir, ...segments);
  // 词法:target 必须在 dir 之内。
  if (target !== dir && !target.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return { ok: false, reason: "invalidPath" };
  // 物理:对**最近的已存在祖先**做 realpath,确认它也在 dir 之内(挡 symlink 逃逸)。
  const nearest = nearestExistingAncestor(target);
  if (nearest !== null) {
    let physicalNearest: string;
    try {
      physicalNearest = realpathSync.native(nearest);
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
    if (physicalNearest !== dir && !physicalNearest.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
      return { ok: false, reason: "invalidPath" };
    }
  }
  return { ok: true, abs: target, dir };
}

/** 从 `target` 往上找第一个已存在的祖先(含自己)。找不到(整棵树都不在)返回 null。 */
function nearestExistingAncestor(target: string): string | null {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 读该扩展目录下的一份文件。**空文件 = `{ ok: true, content: "" }`**;
 * 文件不存在 = `{ ok: false, reason: "notFound" }`(与空文件分得开 —— 那正是项目根闸门
 * 那条老路的病:两种情况都回空串)。
 */
export function readFileInExtension(root: string, extensionId: string, relPath: string): ExtensionStoreReadFileResult {
  const res = resolveInExtension(root, extensionId, relPath, false);
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    const st = lstatSync(res.abs);
    if (st.isDirectory()) return { ok: false, reason: "notAFile" };
    return { ok: true, content: readFileSync(res.abs, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "notFound" };
    return { ok: false, reason: "notFound" };
  }
}

/**
 * 写该扩展目录下的一份文件(建父目录)。**超过 {@link EXTENSION_STORE_MAX} 字节整次拒绝、
 * 不落盘** —— 返回 `{ ok: false, reason: "tooLarge", limit }`。写成功返回 `{ ok: true, bytes }`。
 */
export function writeFileInExtension(
  root: string,
  extensionId: string,
  relPath: string,
  content: string,
): ExtensionStoreWriteFileResult {
  const bytes = utf8Length(content);
  if (bytes > EXTENSION_STORE_MAX) return { ok: false, reason: "tooLarge", limit: EXTENSION_STORE_MAX };
  const res = resolveInExtension(root, extensionId, relPath, true);
  if (!res.ok) return { ok: false, reason: res.reason === "notFound" ? "invalidPath" : res.reason };
  // 目标要么不存在、要么是普通文件;是目录则拒。
  if (existsSync(res.abs)) {
    try {
      if (lstatSync(res.abs).isDirectory()) return { ok: false, reason: "notAFile" };
    } catch {
      return { ok: false, reason: "invalidPath" };
    }
  }
  mkdirSync(dirname(res.abs), { recursive: true });
  atomicWrite(res.abs, content);
  return { ok: true, bytes };
}

/**
 * 列该扩展目录下某个子目录的内容。省略 `relPath` = 该扩展目录根。
 * 只列**自己目录**;不递归。目录不存在 / 目标是文件 → 结构化失败。
 */
export function listFilesInExtension(
  root: string,
  extensionId: string,
  relPath?: string,
): ExtensionStoreListFilesResult {
  // 纯词法先拒绝对路径 / `..`(不依赖目录是否存在 —— 越界无论目录在不在都算 invalidPath)。
  if (!isValidExtensionId(extensionId)) return { ok: false, reason: "invalidPath" };
  const rel = (relPath ?? "").trim();
  if (rel.length > 0 && !isSafeExtensionRelPath(rel)) return { ok: false, reason: "invalidPath" };
  const dir = physicalExtensionDir(root, extensionId);
  if (dir === null) return { ok: false, reason: "notFound" };
  let target = dir;
  if (rel.length > 0) {
    const res = resolveInExtension(root, extensionId, rel, false);
    if (!res.ok) return { ok: false, reason: res.reason };
    target = res.abs;
  }
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return { ok: false, reason: "notFound" };
  }
  if (!st.isDirectory()) return { ok: false, reason: "notADir" };
  const prefix = rel.length > 0 ? `${rel.replace(/\\/g, "/").replace(/\/+$/, "")}/` : "";
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return { ok: false, reason: "notFound" };
  }
  const entries: ExtensionStoreListEntry[] = [];
  for (const name of names) {
    const childAbs = join(target, name);
    let childStat;
    try {
      childStat = lstatSync(childAbs);
    } catch {
      continue; // 列到一半被删了 —— 跳过,不抛
    }
    if (childStat.isDirectory()) {
      entries.push({ name, relPath: `${prefix}${name}`, isDir: true });
    } else if (childStat.isFile()) {
      entries.push({ name, relPath: `${prefix}${name}`, isDir: false, size: childStat.size });
    }
    // 符号链接等其它类型不列(它们正是逃逸的载体)。
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, entries };
}

/** UTF-8 字节数(与契约层同一算法;主进程这层有 `node:fs`,但保持一致免得两处漂移)。 */
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

export { EXTENSION_STORE_MAX };
