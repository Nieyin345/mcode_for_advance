/** Pure workspace-UI rules: keep Git scan results scoped to the current
 * checkout and let keyboard users navigate the three panel views. */
export function gitScanMatchesProject(scannedPath: string | null, projectPath: string | null): boolean {
  return !!projectPath && scannedPath === projectPath;
}
export function nextGitTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return null;
}
