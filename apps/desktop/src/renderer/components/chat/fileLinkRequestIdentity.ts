/** Identity check for click-triggered file-path resolution. Never open a
 * result after its path token or owning project has changed, even when the
 * asynchronous file search returns just one candidate. */
export function fileLinkRequestKey(token: string, projectPath?: string | null): string {
  return JSON.stringify([token, projectPath ?? null]);
}
export function fileLinkRequestCurrent(
  seq: number,
  latestSeq: number,
  startedKey: string,
  currentKey: string,
): boolean {
  return seq === latestSeq && startedKey === currentKey;
}
