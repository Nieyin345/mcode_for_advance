/**
 * 三个库在界面上的名字 —— **整个渲染端只有这一份**。
 *
 * 与 `@contracts/library` 的 `LIBRARY_KINDS` 一一对应。这个映射早先在三个文件里各
 * 抄了一份(`LibrarySection` / `LibraryPanel` / `LibraryPicker`),每份上面都写着
 * "类目名只有一处定义"。靠注释维系的约定会破,而且破得**不报错** —— 键名改了只会把
 * `library.kind.paper` 这串原文显示给用户。这正是模版那边 `templateLabels.ts` 的同一个
 * 处置(两个库的形状刻意对齐:它们是同一套东西的两种配置)。
 */
import type { Locale } from "@contracts/ipc";
import { isLibraryKind, type LibraryKind } from "@contracts/library";
import type { LibraryTypeMeta } from "@contracts/libraryTypes";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";

export const LIBRARY_KIND_LABEL: Record<LibraryKind, MessageId> = {
  paper: "library.kind.paper",
  textbook: "library.kind.textbook",
  note: "library.kind.note",
};

/**
 * kind 的显示名 —— 统一资料库之后**注册表里的名字就是显示名**(用户可改,改完界面
 * 直接跟着变,不走 i18n)。查不到注册表(还没拉到 / 这个 kind 已被删)再退回内置
 * 三类的 i18n 名,最后退回 kind 本身,保证任何情况下都有一个能看的字符串。
 *
 * 注册表在调用方手里(`api.library.typesGet()` 拉的那份),这里不自己发请求 ——
 * 左栏和右栏各有一份列表,共用一个请求反而要加缓存层,不值得。
 */
export function kindLibraryLabel(
  kind: string,
  metas: readonly LibraryTypeMeta[] | undefined,
  locale: Locale,
): string {
  const meta = metas?.find((m) => m.id === kind);
  if (meta) return meta.name;
  const key = (LIBRARY_KIND_LABEL as Record<string, MessageId>)[kind];
  return key ? translate(locale, key) : kind;
}

/**
 * 一条文献库附件在 chip 上该显示什么 —— 附件键 + 主进程给的 `name` → 界面文案。
 *
 *   `c:<分类 id>` / `i:<条目 id>` —— 显示名就是用户自己起的分类名 / 条目标题,
 *                                   主进程给的 `name` 正是它,直接用;
 *   `k:<库>`                      —— 键里只有库名,而主进程发来的 `name` 是它那份
 *                                   清单的标题(中文,给模型读的)。拿它当界面文案会
 *                                   让英文界面冒出中文,所以这里用界面语言自己拼。
 *
 * 认不出来的键就退回主进程给的 `name`(总比显示一个空 chip 强)。
 */
export function libraryAttachChipLabel(key: string, name: string, locale: Locale): string {
  if (!key.startsWith("k:")) return name;
  const kind = key.slice(2);
  if (!isLibraryKind(kind)) return name;
  return translate(locale, "library.view.allInKind", {
    kind: translate(locale, LIBRARY_KIND_LABEL[kind]),
  });
}
