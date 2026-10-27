/**
 * File-type icon helper (VS Code Material Icon Theme style).
 *
 * Maps a file's extension (or special filename) to a per-type icon from the
 * `material-icon-theme` Iconify collection (634 file icons, MIT, fully offline
 * - no API at runtime). Shared across the file tree, editor tabs, and editor
 * toolbar via the `FileTypeIcon` component, so every surface shows the same
 * icon for a given file.
 *
 * The extension -> icon and filename -> icon maps **lived here until 2026-10-15**;
 * they are now in `./fileIconTables.ts` (2404 行纯数据，与下面的查找逻辑零耦合 ——
 * 探针实测依赖为 0)。本文件只剩查找逻辑，所以读"图标怎么解析"不必翻过那两张表。
 * 它们的来源仍是上游 vscode-material-icon-theme（1360 扩展 + 1039 文件名），
 * 过滤到装着的那套 collection 里有的图标。同一扩展永远解析到同一个图标。
 * 未知扩展与无扩展名文件回落到通用的 `document` 图标。
 *
 * Only the icons those tables reference are bundled: `fileIconCollection.json`
 * is generated from the full collection by `scripts/file-icon-subset/gen.mjs`
 * (536 of 1175 icons, ~446KB vs ~851KB; perf-startup-smoke fails if it goes
 * stale). **改表之后要重跑那个脚本**，并在改图标名时同步
 * `fileIconTables.ts` 的 `REFERENCED_ICON_NAMES`
 * （`file-icon-tables-smoke` 会核对清单与表是否一致）。
 * It is loaded as a separate chunk right after this module is first
 * imported, then registered
 * via `addCollection`; after that every lookup is a synchronous local
 * `getIcon` call - no network. Until it lands (a few ms after first paint),
 * `FileTypeIcon` renders a same-size blank box, so layout never shifts and
 * Iconify never tries its online API for a not-yet-registered icon.
 * Folders show no icon in the tree (chevron + name only) per the current design.
 */
import { useSyncExternalStore } from "react";
import { addCollection, Icon as IconifyIcon } from "@iconify/react";
import { basename } from "@renderer/lib/path.js";
import { EXT_ICON, NAME_ICON } from "@renderer/lib/fileIconTables.js";
import {
  PHOSPHOR_FILE_ICONS,
  PHOSPHOR_NAME_MAP,
  PHOSPHOR_EXT_MAP,
  type PhosphorIcon,
} from "@renderer/lib/phosphorFileIcons.js";

// Register the whole collection once, off the startup critical path. After
// this, icons resolve synchronously via getIcon("material-icon-theme:<name>").
let collectionReady = false;
const readyListeners = new Set<() => void>();
void import("./fileIconCollection.json")
  .then((mod) => {
    addCollection(mod.default);
    collectionReady = true;
    for (const cb of readyListeners) cb();
  })
  .catch((err: unknown) => {
    console.error("fileIcon: failed to load the icon collection", err);
  });
function subscribeCollection(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}
const collectionSnapshot = (): boolean => collectionReady;

const COLLECTION_PREFIX = "material-icon-theme";


/** Generic fallback icon for files with no themed extension. */
const DEFAULT_ICON = "document";

/** Lowercase basename of a path (the segment after the last separator). */
function basenameLower(p: string): string {
  return basename(p).toLowerCase();
}

/** Lowercase extension WITHOUT the leading dot, or "" if none / dotfile.
 *  Mirrors the logic of extname() in lib/path.ts but strips the dot so it
 *  indexes directly into EXT_ICON. */
function extOf(base: string): string {
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // dot at 0 = hidden file, treat as no extension
  return base.slice(dot + 1).toLowerCase();
}

/** Resolve the collection icon id for a file path, or null if no themed icon
 *  matches. Special filenames (case-insensitive basename) win over the
 *  extension (so package.json -> npm, not json). */
export function fileIconIdForPath(filePath: string): string | null {
  const base = basenameLower(filePath);
  if (NAME_ICON[base]) return `${COLLECTION_PREFIX}:${NAME_ICON[base]}`;
  const ext = extOf(base);
  if (ext && EXT_ICON[ext]) return `${COLLECTION_PREFIX}:${EXT_ICON[ext]}`;
  return null;
}

/** Whether the collection has a themed icon for this path (exposed for tests
 *  / debugging coverage). */
export function hasFileIcon(filePath: string): boolean {
  return fileIconIdForPath(filePath) !== null;
}

/**
 * 【UI 重建 2026-10-27】**解析到 Claude 的 Phosphor 图标**，或有 null。
 *
 * ## 为什么需要第二条解析路径
 *
 * Mcode 原本的 `fileIconIdForPath` 返回 Material Icon Theme 的 id
 * （`material-icon-theme:typescript`），那是 **24 视框的彩色实心图标**。
 * Claude 用的是 **Phosphor**（256 视框的线性图标，MIT 许可），两者形状
 * 完全不同 —— 这是「一眼看起来不像」的一个真实来源，不是配色差异。
 *
 * ## 为什么是「优先」而不是「替换」
 *
 * Material 那套覆盖 **1360 个扩展 + 1039 个文件名**；Claude 的产物里只
 * 抽出 **12 个** 文件类型图标。所以：
 *
 *   - 这 12 类能表达的（文档 / 表格 / PDF / 文本 / 图片 / 视频 / 压缩 /
 *     代码）→ **走 Phosphor**，形状与 Claude 一致；
 *   - 其余 1300+ 扩展（`.env`、`.proto`、`.graphql`、各种语言方言）
 *     → 继续走 Material。它们 Claude 根本没有对应图标，砍掉只会让文件树
 *     变成一片通用文档图标，那比「图标形状不同」更糟。
 *
 * **文件名表的优先级高于扩展名表**（与 `fileIconIdForPath` 同一顺序），
 * 否则 `package.json` 会被 `.json` 抢走。
 *
 * 这个函数**不读 collection 的加载状态** —— Phosphor 的 path 是内联在这里的
 * 静态数据，不需要异步注册。所以它在首帧就能画出来，不像 Material 那条路
 * 要等 `addCollection` 落地。
 */
export function phosphorIconForPath(filePath: string): PhosphorIcon | null {
  const base = basenameLower(filePath);
  const byName = PHOSPHOR_NAME_MAP[base];
  if (byName && PHOSPHOR_FILE_ICONS[byName]) return PHOSPHOR_FILE_ICONS[byName];
  const ext = extOf(base);
  if (ext) {
    const byExt = PHOSPHOR_EXT_MAP[ext];
    if (byExt && PHOSPHOR_FILE_ICONS[byExt]) return PHOSPHOR_FILE_ICONS[byExt];
  }
  return null;
}

/** 渲染一个 Phosphor 图标（纯内联 SVG，无异步依赖）。
 *
 *  `viewBox` 固定 `0 0 256 256` —— 那是 Phosphor 的视框，**不能换**：
 *  path 的坐标是按 256 网格写的，换成 24 会画出一个巨大的局部。
 *  `fill="currentColor"` 让图标跟随文字色（Claude 的图标也是这么做的）。 */
function PhosphorSvg({
  icon,
  size,
  className,
}: {
  icon: PhosphorIcon;
  size: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      className={className}
      style={{ flexShrink: 0, verticalAlign: "-0.125em" }}
    >
      {icon.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** Render the per-type file icon for a path. Falls back to the generic
 *  `document` icon for unknown extensions, so callers need no fallback of
 *  their own. Themed icons carry their own colors.
 *
 *  ★ `flexShrink: 0`(2026-09-28 修):SVG 在 flex 行里默认**可以被压缩** ——
 *  长标题挤压行内空间时图标跟着缩(实测回收站里 PDF 行标题长、图标被压小,
 *  MD 行标题短、看起来"没事",于是像是"PDF 图标会变、MD 不会")。图标尺寸
 *  是身份标识,不参与弹性布局。占位 span 同样钉死,加载前后不跳版。 */
export function FileTypeIcon({
  path,
  size = 16,
  className,
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  /* 【UI 重建 2026-10-27】**Phosphor 优先。**
   *
   * 这一分支必须在 `ready` 判断**之前** —— Phosphor 的 path 是内联静态
   * 数据，不依赖 Material collection 是否加载完。放在后面会让首帧仍画
   * 空白方框，而 Phosphor 本来就能立刻画。
   *
   * 覆盖不到的扩展（1300+）落到下面原有的 Material 路径，行为完全不变。 */
  const phosphor = phosphorIconForPath(path);
  if (phosphor) {
    return <PhosphorSvg icon={phosphor} size={size} className={className} />;
  }
  const ready = useSyncExternalStore(subscribeCollection, collectionSnapshot);
  if (!ready) {
    return (
      <span
        aria-hidden
        className={className}
        style={{ display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "-0.125em" }}
      />
    );
  }
  const id = fileIconIdForPath(path) ?? `${COLLECTION_PREFIX}:${DEFAULT_ICON}`;
  return <IconifyIcon icon={id} width={size} height={size} inline className={className} style={{ flexShrink: 0 }} />;
}
