/** Latest-request-wins token, including project removal and component unmount.
 * No Git IPC, repository mutation or async cancellation is performed here.
 */
export class GitScanGeneration {
  private revision = 0;

  next(): number {
    return ++this.revision;
  }
  invalidate(): void {
    this.revision++;
  }
  isCurrent(revision: number): boolean {
    return Number.isSafeInteger(revision) && revision > 0 && revision === this.revision;
  }
}
