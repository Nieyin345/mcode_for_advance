/**
 * 未保存文件（dirty）的集中登记与**关闭守卫**。
 *
 * ## 为什么单独一个模块
 *
 * 脏表原先长在 `components/ide/OpenTabsBar.tsx` 里，只有标签栏自己看得见。但"有未保存
 * 改动的标签不许被关掉"这条规矩要由 **store 的三个关闭动作**来守 —— store 不能 import
 * 组件（会成环），所以把登记表和守卫挪到这儿，组件与 store 共用同一份实现。
 * 见仓库硬规矩「共享实现只有一份」。
 *
 * ⚠️ **这个文件不许 import React。** store 会 import 它，而 `session-store-smoke` 是在
 * 纯 node 里跑的；订阅用的 `useDirtyFiles` 钩子因此另放 `@renderer/hooks/useDirtyFiles`。
 *
 * ## 脏表是模块级的临时状态，不是 store 切片
 *
 * 每个键一次，值只有"脏 / 不脏"。放进 zustand 会让每次击键都触发 selector 重算
 * （内容变了 → 脏状态变了），所以这里用一个小 pub/sub：谁关心谁订阅，集合真变了才通知。
 * 它天然是**瞬态**的（未保存改动本来就活不过重启），所以不做持久化。
 */

const dirtyFiles = new Set<string>();
/** Dirty state reported by native document editors (Docs/Sheets/Slides/PDF/Markdown/HTML). */
const nativeDirtyFiles = new Set<string>();
const listeners = new Set<() => void>();
/** The UI snapshot is the union; the close guard checks both sources. */
let dirtySnapshot: ReadonlySet<string> = new Set();

function setDirtySource(source: Set<string>, filePath: string, dirty: boolean): void {
  const had = source.has(filePath);
  if (dirty === had) return;
  const wasDirty = dirtyFiles.has(filePath) || nativeDirtyFiles.has(filePath);
  if (dirty) source.add(filePath);
  else source.delete(filePath);
  const isDirty = dirtyFiles.has(filePath) || nativeDirtyFiles.has(filePath);
  // If the other editor source still marks this path dirty, the public snapshot
  // is unchanged and there is no reason to re-render every file tab.
  if (wasDirty === isDirty) return;
  dirtySnapshot = new Set([...dirtyFiles, ...nativeDirtyFiles]);
  // Snapshot the observer set: one tab can unsubscribe a sibling while a dirty
  // update is being delivered. Every listener present at notification start
  // must get one chance; a crashing observer must not block the rest.
  for (const fn of [...listeners]) {
    try { fn(); }
    catch (error) { console.warn("ideDirtyTracker observer failed:", error); }
  }
}

export const ideDirtyTracker = {
  /** Dirty state owned by the Monaco/Mcode text editor. */
  set(filePath: string, dirty: boolean) {
    setDirtySource(dirtyFiles, filePath, dirty);
  },
  /** Dirty state reported by the embedded native Office/document editor. */
  setNative(filePath: string, dirty: boolean) {
    setDirtySource(nativeDirtyFiles, filePath, dirty);
  },
  /** Combined dirty state for tab close guards and file-tab indicators. */
  has(filePath: string) {
    return dirtyFiles.has(filePath) || nativeDirtyFiles.has(filePath);
  },
  /** Monaco-only dirty state for editor model reconciliation; native dirty must not block disk refresh logic. */
  hasEditor(filePath: string) {
    return dirtyFiles.has(filePath);
  },
  /** 订阅用的联合快照 —— 每次可见脏状态变化都换新引用。 */
  snapshot(): ReadonlySet<string> {
    return dirtySnapshot;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** 一次关闭请求的收敛结果。 */
export interface IdeCloseResult {
  /** 真被关掉的路径（顺序与请求一致）。 */
  closed: readonly string[];
  /** 因为**有未保存改动**被拦下的路径 —— 调用方据此提示用户。 */
  blocked: readonly string[];
}

/**
 * 把"请求关闭的一批路径"收敛成"能关的 / 被拦下的"。
 *
 * 纯函数（脏状态从外面喂进来），所以能脱离 store 单测 —— 见
 * `scripts/renderer-pure-smoke`。
 *
 * `force` 是给**文件已经不在了**那几条路用的（文件树里删掉文件、删掉整个目录时，
 * 那个标签必须跟着消失）—— 那时"未保存"已经没有意义，拦下来反而留下一个指向空气的
 * 标签。删除以外的所有关闭一律不传 force。
 */
export function partitionClosable(
  requested: readonly string[],
  isDirty: (path: string) => boolean,
  force = false,
): IdeCloseResult {
  if (force) return { closed: [...requested], blocked: [] };
  const closed: string[] = [];
  const blocked: string[] = [];
  for (const p of requested) {
    if (isDirty(p)) blocked.push(p);
    else closed.push(p);
  }
  return { closed, blocked };
}
