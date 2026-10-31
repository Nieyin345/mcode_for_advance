/** F032: VS Code file: operations rooted in one native, handle-pinned workspace. */
import * as path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openNativeFsRoot, type NativeFsRoot } from "@main/lib/nativeFs.js";

export interface FileResource { scheme: string; path: string; authority?: string }
function fail(reason: string): never { throw Error("THEIA_WORKSPACE_FS: " + reason); }

const workspaceMutationTails = new Map<string, Promise<void>>();
async function withWorkspaceMutationLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root;
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.then(() => current);
  workspaceMutationTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (workspaceMutationTails.get(key) === tail) workspaceMutationTails.delete(key);
  }
}

export function fileResource(value: string): FileResource {
  const url = pathToFileURL(value);
  return { scheme: "file", path: decodeURIComponent(url.pathname), authority: "" };
}

export class McodeWorkspaceFs {
  private active = 0;
  private closing = false;
  private closed = false;

  private constructor(
    readonly root: string,
    private readonly native: NativeFsRoot,
    private readonly rootDevice: string,
    private readonly rootInode: string,
  ) {}

  static async open(root: string): Promise<McodeWorkspaceFs> {
    if (!path.isAbsolute(root)) fail("未选择有效的 Mcode 工作区");
    const full = await realpath(root);
    const before = await lstat(full, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail("工作区不是独立普通目录");
    const native = openNativeFsRoot(full);
    try {
      const info = await native.stat([]);
      const after = await lstat(full, { bigint: true });
      if (info.type !== "directory" || !after.isDirectory() || after.isSymbolicLink() ||
          before.dev !== after.dev || before.ino !== after.ino ||
          BigInt(info.device) !== after.dev || BigInt(info.inode) !== after.ino) {
        fail("工作区根目录在打开期间已被替换");
      }
      return new McodeWorkspaceFs(full, native, info.device, info.inode);
    } catch (error) {
      native.close();
      throw error;
    }
  }

  private async assertRootIdentity(): Promise<void> {
    const current = await lstat(this.root, { bigint: true }).catch(() => null);
    if (!current || !current.isDirectory() || current.isSymbolicLink() ||
        BigInt(this.rootDevice) !== current.dev || BigInt(this.rootInode) !== current.ino) {
      fail("工作区根目录在打开后已被移除或替换");
    }
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) fail("工作区文件句柄已关闭");
    this.active++;
    try {
      await this.assertRootIdentity();
      return await work();
    } finally {
      this.active--;
      if (this.closing && this.active === 0 && !this.closed) {
        this.native.close();
        this.closed = true;
      }
    }
  }

  close(): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    if (this.active === 0) {
      this.native.close();
      this.closed = true;
    }
  }

  private segments(uri: FileResource): string[] {
    if (!uri || uri.scheme !== "file" || typeof uri.path !== "string" ||
        (uri.authority && uri.authority !== "localhost")) {
      fail("仅支持本机 file URI");
    }
    // Theia/vscode-uri exposes a decoded URI path. Encode each path component
    // independently so literal '%' sequences, '#', '?', spaces and Unicode are
    // preserved as filename bytes instead of being interpreted as URL syntax.
    const pathParts = uri.path.split("/");
    const encoded = pathParts.map((part, index) =>
      index === 1 && uri.path.startsWith("/") && /^[A-Za-z]:$/.test(part)
        ? part
        : encodeURIComponent(part),
    ).join("/");
    let absolute: string;
    try {
      absolute = path.resolve(fileURLToPath(new URL("file://" + (uri.authority ?? "") + encoded)));
    } catch {
      fail("非法文件 URI");
    }
    const relative = path.relative(this.root, absolute);
    if (relative === "") return [];
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
      fail("文件不属于当前 Mcode 工作区");
    }
    const segments = relative.split(path.sep);
    if (segments.some((part) => !part || part === "." || part === "..")) {
      fail("工作区路径包含非法组件");
    }
    return segments;
  }

  /** Resolve is retained for Theia's watcher registration only; actual I/O never uses this path. */
  async resolve(uri: FileResource): Promise<string> {
    const segments = this.segments(uri);
    await this.run(() => this.native.stat(segments));
    return path.join(this.root, ...segments);
  }

  async watchState(relativePath: string): Promise<"file" | "missing" | "ignore"> {
    const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (!segments.length || segments.some((part) => part === "." || part === "..")) return "ignore";
    try {
      return (await this.run(() => this.native.stat(segments))).type === "file" ? "file" : "ignore";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "ignore";
    }
  }

  async stat(uri: FileResource) {
    const info = await this.run(() => this.native.stat(this.segments(uri)));
    return {
      type: info.type === "directory" ? 2 : info.type === "file" ? 1 : 0,
      ctime: info.birthtimeMs,
      mtime: info.mtimeMs,
      size: info.size,
    };
  }

  async readdir(uri: FileResource): Promise<Array<[string, number]>> {
    const entries = await this.run(() => this.native.readdir(this.segments(uri), 5000));
    return entries.map((entry) => [entry.name, entry.type]);
  }

  async readFile(uri: FileResource): Promise<Uint8Array> {
    return this.run(() => this.native.readFile(this.segments(uri), 8 * 1024 * 1024));
  }

  async writeFile(uri: FileResource, content: Uint8Array): Promise<void> {
    if (!(content instanceof Uint8Array) || content.byteLength > 8 * 1024 * 1024) {
      fail("文件写入超过 8 MiB");
    }
    return withWorkspaceMutationLock(this.root, () =>
      this.run(() => this.native.writeFile(this.segments(uri), Buffer.from(content), false)));
  }

  async mkdir(uri: FileResource): Promise<void> {
    return withWorkspaceMutationLock(this.root, () => this.run(async () => {
      const segments = this.segments(uri);
      for (let i = 1; i <= segments.length; i++) {
        await this.native.mkdir(segments.slice(0, i));
      }
    }));
  }

  async rename(from: FileResource, to: FileResource, overwrite = false): Promise<void> {
    const source = this.segments(from);
    const destination = this.segments(to);
    if (source.length === destination.length && source.every((part, index) => part === destination[index])) {
      fail("不可重命名为同一路径");
    }
    return withWorkspaceMutationLock(this.root, () =>
      this.run(() => this.native.rename(source, destination, overwrite)));
  }

  async copy(from: FileResource, to: FileResource, overwrite = false): Promise<void> {
    const source = this.segments(from);
    const destination = this.segments(to);
    if (source.length === destination.length && source.every((part, index) => part === destination[index])) {
      fail("不可复制文件到自身");
    }
    return withWorkspaceMutationLock(this.root, () =>
      this.run(() => this.native.copy(source, destination, overwrite)));
  }

  async delete(uri: FileResource, recursive = false): Promise<void> {
    if (recursive) fail("扩展递归删除暂不支持，请使用 Mcode 原生文件管理器");
    return withWorkspaceMutationLock(this.root, () =>
      this.run(() => this.native.remove(this.segments(uri))));
  }

  /** Bounded VS Code glob search. Every directory and file is reached through the pinned root handle. */
  async findFiles(include: string, exclude?: string, maxResults = 200,
                  folder?: FileResource): Promise<FileResource[]> {
    if (typeof include !== "string" || !include || include.length > 300 ||
        (exclude !== undefined && (typeof exclude !== "string" || exclude.length > 300))) {
      fail("搜索规则无效");
    }
    const toPattern = (glob: string): RegExp => {
      const normal = glob.replace(/\\/g, "/");
      let out = "^";
      for (let i = 0; i < normal.length; i++) {
        const c = normal[i];
        if (c === "*" && normal[i + 1] === "*") {
          i++;
          if (normal[i + 1] === "/") { i++; out += "(?:.*/)?"; }
          else out += ".*";
        } else if (c === "*") out += "[^/]*";
        else if (c === "?") out += "[^/]";
        else out += /[.*+?^$()|[\]\\]/.test(c) ? "\\" + c : c;
      }
      return new RegExp(out + "$", "i");
    };
    const accepted = toPattern(include);
    const rejected = exclude ? toPattern(exclude) : null;
    const requestedLimit = typeof maxResults === "number" && Number.isFinite(maxResults)
      ? Math.floor(maxResults) : 200;
    const limit = Math.min(500, Math.max(1, requestedLimit));
    const base = folder ? this.segments(folder) : [];
    const queue: string[][] = [base];
    return this.run(async () => {
      const results: FileResource[] = [];
      let visited = 0;
      let queueCursor = 0;

      // An index cursor avoids repeated O(n) Array.shift() work on wide workspaces.
      while (queueCursor < queue.length && results.length < limit) {
        const directory = queue[queueCursor++]!;
        const entries = await this.native.readdir(directory, 5000);
        for (const entry of entries) {
          if (++visited > 10000) fail("工作区搜索超过安全遍历上限");
          const child = [...directory, entry.name];
          const relative = child.join("/");
          if (entry.type === 2) {
            if (![".git", "node_modules", ".tmp", ".cache"].includes(entry.name)) queue.push(child);
            continue;
          }
          if (entry.type === 1 && accepted.test(relative) && !rejected?.test(relative)) {
            results.push(fileResource(path.join(this.root, ...child)));
            if (results.length >= limit) break;
          }
        }
      }
      return results;
    });
  }
}
