/** An already-attached file is visible for context but cannot be chosen
 * again by Enter/Tab. Match pointer-disabled rows with keyboard semantics. */
export function eligibleFileIndex<T extends { path: string }>(
  files: readonly T[],
  excluded: ReadonlySet<string>,
  preferred: number,
  direction: -1 | 0 | 1 = 0,
): number {
  if (files.length === 0) return -1;
  const allowed = (index: number) => index >= 0 && index < files.length && !excluded.has(files[index]!.path);
  if (direction === 0 && allowed(preferred)) return preferred;
  const step = direction === 0 ? 1 : direction;
  let index = direction === 0 ? 0 : preferred + step;
  while (index >= 0 && index < files.length) {
    if (allowed(index)) return index;
    index += step;
  }
  return direction === 0 ? -1 : allowed(preferred) ? preferred : eligibleFileIndex(files, excluded, 0);
}
