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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyStore,
  getStoreValue,
  isValidExtensionId,
  parseStoreFile,
  serializeStore,
  storeBytes,
  withStoreValue,
  withoutStoreValue,
  EXTENSION_STORE_MAX,
  type ExtensionStoreFile,
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

export { EXTENSION_STORE_MAX };
