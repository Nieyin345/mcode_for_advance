import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 一次能力调用要访问的资源。与从前 `@contracts/modules` 的 `ModuleResource` 同形。 */
export interface ModuleResource { projectPath: string; path: string }

const within = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return !(isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep));
};
// A child name that no registered project/worktree uses. If an ancestor admits
// it too, that ancestor trusts its whole subtree (the documents roots).
const SUBTREE_PROBE = ".mcode-module-subtree-probe";

/** Resolve symlinks before authorizing the actual target, not only its spelling.
 * Known-root lookup is injected so tests use temporary directories, never user DB.
 * A workspace admitted only because it lies below a subtree-trusted directory
 * must canonically stay below that directory; a link inside it cannot promote
 * an outside directory (for example the app data root) to a workspace. */
export async function resolveModuleResource(resource: ModuleResource, knownRoot: (path:string)=>boolean): Promise<string> {
  if (!knownRoot(resource.projectPath)) throw Error("未知工作区");
  const lexicalRoot = resolve(resource.projectPath);
  const root = await realpath(lexicalRoot);
  for (let child = lexicalRoot, parent = dirname(lexicalRoot); parent !== child; child = parent, parent = dirname(parent)) {
    if (!knownRoot(parent) || !knownRoot(join(parent, SUBTREE_PROBE))) continue;
    if (!within(await realpath(parent), root)) throw Error("工作区在其受信根之外");
  }
  const file = await realpath(resolve(resource.path));
  if (!within(root, file)) throw Error("资源在工作区之外");
  const detail = await stat(file);
  if (!detail.isFile() || detail.nlink !== 1) throw Error("需要一个普通文件（拒绝跨工作区硬链接）");
  return file;
}
/** Open the exact inode that was authorized, not a different file swapped in
 * after realpath/stat. A single hardlink to an outside path must also be denied:
 * a correct-looking lexical path does not make its inode workspace-owned.
 * This is bounded Node-level mitigation; an OS openat2-style directory anchor
 * is still needed against malicious concurrent ancestor renames.
 */
async function openAuthorizedFile(
  resource: ModuleResource,
  knownRoot: (path: string) => boolean,
) {
  const authorized = await resolveModuleResource(resource, knownRoot);
  const fd = await open(authorized, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw Error("拒绝非普通文件或硬链接");
    // Catch symlink / hardlink replacement after the initial authorization, and
    // never use a pathname stat as the content actually read from this descriptor.
    const checked = await resolveModuleResource(resource, knownRoot);
    const current = await stat(checked);
    if (checked !== authorized || !current.isFile() || current.nlink !== 1 ||
        current.dev !== opened.dev || current.ino !== opened.ino) {
      throw Error("文件在授权与打开期间已变化，拒绝读取");
    }
    return fd;
  } catch (error) {
    await fd.close();
    throw error;
  }
}
