/**
 * Editor navigation-history support — the last-known cursor per file.
 *
 * The back/forward stacks themselves live in `sessionStore`
 * (`navBackByProject` / `navForwardByProject`, per project). To snapshot the
 * OUTGOING location when the user navigates away, the store needs the current
 * file's cursor — but that cursor moves constantly, and writing it into
 * zustand on every selection change would re-run every store selector on each
 * keystroke/click. So the cursor lives here as a plain module-level Map,
 * updated by EditPane's selection listener, and read by the store's nav
 * actions. Plain module state is also safe across the App.tsx `key={filePath}`
 * remounts that destroy every EditPane instance.
 *
 * This module must not import the store (the store imports this) — no cycles.
 */

/** One location in the editor navigation history. Lines/columns are 1-based
 *  (Monaco coordinates), matching `idePendingReveal`. */
export interface NavEntry {
  filePath: string;
  line: number;
  column: number;
}

/** Last-known primary cursor per absolute file path (1-based). Seeded by
 *  EditPane on mount (after the view-state restore) and refreshed on every
 *  cursor-selection change. Entries persist after the EditPane unmounts —
 *  that's the point. */
const lastCursorByFile = new Map<string, { line: number; column: number }>();

/** 上限,理由同 `FileEditor` 的 view state 表:留住"来回切换的那几十个文件"就够,
 *  被挤掉的代价只是重开时光标回到上次跳转点而不是上次停留处。 */
const LAST_CURSOR_MAX = 200;

export function setLastCursor(
  filePath: string,
  pos: { line: number; column: number },
): void {
  // 按最近使用封顶。一条只有两个数字,但"这次开机点开过的每个文件"都留一条,
  // 在大仓库里翻一遍就是几千条,而其中绝大多数用户再也不会回去。删掉再插入
  // 是为了把这一条挪到队尾 —— Map 按插入序迭代,队头就是最久没碰过的那个。
  lastCursorByFile.delete(filePath);
  lastCursorByFile.set(filePath, pos);
  while (lastCursorByFile.size > LAST_CURSOR_MAX) {
    const oldest: string | undefined = lastCursorByFile.keys().next().value;
    if (oldest === undefined) break;
    lastCursorByFile.delete(oldest);
  }
}

export function getLastCursor(
  filePath: string,
): { line: number; column: number } | undefined {
  const pos = lastCursorByFile.get(filePath);
  // 读到了就提到队尾:常来常往的那几个文件不该被一次大范围浏览挤掉。
  if (pos !== undefined) {
    lastCursorByFile.delete(filePath);
    lastCursorByFile.set(filePath, pos);
  }
  return pos;
}
