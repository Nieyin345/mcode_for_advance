/** F033: one bounded workspace watcher; file events are revalidated by the native root handle. */
import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { fileResource, type FileResource } from "./mcodeWorkspaceFs.js";

export type WorkspaceChanges = { created: FileResource[]; changed: FileResource[]; deleted: FileResource[] };
export type WorkspaceWatchState = "file" | "missing" | "ignore";
export class McodeWorkspaceWatcher {
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, "created" | "changed" | "deleted">();
  private checking = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(
    private readonly root: string,
    private readonly emit: (events: WorkspaceChanges) => void,
    private readonly validate: (relativePath: string) => Promise<WorkspaceWatchState>,
  ) {}

  start(): void {
    if (this.watcher) return;
    const generation = ++this.generation;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (event, name) => {
        if (generation !== this.generation || !name) return;
        const relativeName = String(name);
        if (path.isAbsolute(relativeName) ||
            relativeName.split(/[\\/]/).some((part) =>
              part === ".." || [".git", "node_modules", ".tmp", ".cache"].includes(part))) return;
        const full = path.resolve(this.root, relativeName);
        const relative = path.relative(this.root, full);
        if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) return;
        if (this.pending.size >= 128 && !this.pending.has(full)) return;
        if (this.checking.has(full) || this.checking.size >= 128) return;
        this.checking.add(full);
        const nativeRelative = relative.split(path.sep).join("/");
        void this.validate(nativeRelative).then((state) => {
          if (generation !== this.generation) return;
          if (state === "file") {
            this.enqueue(full, event === "rename" ? "created" : "changed", generation);
          } else if (state === "missing") {
            this.enqueue(full, "deleted", generation);
          }
        }).catch(() => {
          // A rejected/closed native root must never be converted into a file event.
        }).finally(() => {
          if (generation === this.generation) this.checking.delete(full);
        });
      });
      this.watcher.on("error", () => {
        if (generation === this.generation) this.dispose();
      });
    } catch {
      this.dispose();
    }
  }

  private enqueue(full: string, kind: "created" | "changed" | "deleted", generation: number): void {
    if (!this.watcher || generation !== this.generation) return;
    if (this.pending.size >= 128 && !this.pending.has(full)) return;
    this.pending.set(full, kind);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 65);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    this.timer = undefined;
    if (!this.watcher) return;
    const result: WorkspaceChanges = { created: [], changed: [], deleted: [] };
    for (const [file, kind] of this.pending) result[kind].push(fileResource(file));
    this.pending.clear();
    if (result.created.length || result.changed.length || result.deleted.length) {
      try { this.emit(result); } catch { this.dispose(); }
    }
  }

  dispose(): void {
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.checking.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }

  get active(): boolean { return Boolean(this.watcher); }
}
