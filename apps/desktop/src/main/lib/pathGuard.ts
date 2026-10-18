/**
 * Shared filesystem path containment helpers used by IDE IPC handlers
 * (files / git / terminal / lsp). Every renderer-supplied path must resolve
 * inside a known project root before main touches the disk or spawns a process.
 *
 * On Windows + macOS (case-insensitive filesystems) path comparisons are
 * case-insensitive so a lowercased drive letter from Monaco/LSP (`d:\foo`)
 * still matches a project stored with an uppercase letter (`D:\foo`).
 */
import { isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
// 物理包含判据(`pathWithin` 及其 contained/physicalPath/norm 支撑)拆到了零依赖的
// 叶子模块,让 fileSnapshot 这类不能拉进 electron/db 的模块复用同一份实现。
import { pathWithin as realPathWithin } from "@main/lib/realPathWithin.js";

/** True on case-insensitive filesystems (Windows, macOS). Linux is
 *  case-sensitive. Used to normalize path comparisons. */
const CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";

/** Normalize a path for comparison: resolve + optional lowercase. */
function norm(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** Compare two filesystem paths for equality after normalizing (resolving
 *  `.`, `..`, redundant separators, and trailing separators). On
 *  case-insensitive filesystems the comparison is case-insensitive. */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** True only if the lexical path AND its physical destination (including the
 *  nearest existing ancestor for a new file) are inside the registered root.
 *  Case-insensitive on Windows/macOS. This guards symlink/junction escapes in
 *  files, git, terminal and LSP callers sharing this function.
 *
 *  Implementation lives in `@main/lib/realPathWithin.ts` (a zero-dependency
 *  leaf) so non-Electron bundles can reuse it without pulling this module's
 *  repositories → db → electron import chain. */
export function pathWithin(root: string, abs: string): boolean {
  return realPathWithin(root, abs);
}

/** Verify a path is inside SOME persisted project root. Returns the matching
 *  project root path, or null if the path is outside all roots (refuse). */
export function findContainingProject(absPath: string): string | null {
  const root = ProjectRepo.listPaths().find((p) => pathWithin(p, absPath));
  return root ?? null;
}

/** True if `projectPath` exactly matches a persisted Project.path (normalized,
 *  case-insensitive on Windows/macOS). */
export function isKnownProjectPath(projectPath: string): boolean {
  return ProjectRepo.listPaths().some((p) => samePath(p, projectPath));
}

/* ── Workspace roots: projects ∪ materialized session worktrees ∪ 文献库 ──
 *  A worktree session's isolated checkout lives OUTSIDE every project root
 *  by design, yet the session legitimately operates there (its cwd, its
 *  file tree, its git panel). These guards admit those directories as a
 *  SECOND class of legal root: project roots keep priority, worktree roots
 *  (the distinct sessions.worktree_path values) form the fallback tier.
 *
 *  **文献库是第三类**（2026-09-21）。用户的规矩是「我不管从哪打开，只要你在主页面
 *  显示它，我就该能编辑它」—— 而文献库的文件住在 `<数据根>/library/{papers,markdown}/…`，
 *  不归任何项目根管，于是那些文件一旦送进 `FileEditor`（它读写全走 `file:readFile`
 *  / `file:writeFile`），**读会被拒、写更会被拒**，表现是"打开了但是空的、存不下去"。
 *
 *  ## 为什么是 `library/` + `templates/`，不是整个数据根
 *
 *  **范围最小**。数据根底下还有 `mcode.db`、`workflows/`、`hooks.json`、`memory/`
 *  这些 Mcode 自己管理的状态 —— 它们各有各的 IPC 和校验，**不该**从"随便读写一个
 *  文件"这条通用口子进去。而 `library/`（文献库）和 `templates/`（模版库）里装的
 *  是**用户自己的文档**，那才是要能直接编辑的东西。
 *
 *  ⚠️ 两个都要 —— 只放 library 是我第一版的漏：模版库的文件在 `<数据根>/templates/`
 *  下，同样是"用户的东西、同样要在主页面里编辑"，漏掉它的话那些文件送进编辑器
 *  照样被判越界。
 *
 *  ⚠️ 这不是"新开一个口子"，是**把已有的口子收进同一道闸**：这两处的内容本来就能
 *  通过 `library.writeNote` / `library.adoptMarkdown` / `templates.writeFile` 那些
 *  专用 IPC 写。区别只在那几条各自校验各自的形状，而这里给的是"按普通文本文件读写"
 *  这条通用路。 */
function userDocRootsForGuard(): string[] {
  try {
    const root = dataRoot();
    return [join(root, "library"), join(root, "templates")];
  } catch {
    return []; // 数据根还没初始化（启动早期）—— 当作没有这一类根
  }
}

/** True if `path` is a registered project root OR some session's
 *  materialized worktree root OR inside the 文献库 / 模版库根. */
export function isKnownWorkspaceRoot(path: string): boolean {
  if (isKnownProjectPath(path)) return true;
  if (SessionRepo.listWorktreeRoots().some((r) => samePath(r, path))) return true;
  return userDocRootsForGuard().some((r) => pathWithin(r, path));
}

/** The workspace root containing `absPath` — the matching project root if
 *  any, otherwise the first worktree root that contains it, otherwise the
 *  文献库 / 模版库根 that contains it, else null. */
export function findContainingWorkspaceRoot(absPath: string): string | null {
  const project = findContainingProject(absPath);
  if (project) return project;
  const wt = SessionRepo.listWorktreeRoots().find((r) => pathWithin(r, absPath));
  if (wt) return wt;
  return userDocRootsForGuard().find((r) => pathWithin(r, absPath)) ?? null;
}

/**
 * **所有已知工作区根的并集** —— 与 `isKnownWorkspaceRoot` /
 * `findContainingWorkspaceRoot` 同一条判据(项目 ∪ 会话工作树 ∪ 文献库/模版库),
 * 只是返回整个集合而不是判定单个路径。
 *
 * 为什么需要它:GenOffice 的 MCP 子进程里**没有** Mcode 的这层守卫
 * (`findContainingWorkspaceRoot`),围栏只能作为环境变量快照交给它
 * (见 `mcp/genofficeMcp.ts`)。若这里另写一套根判定,"装的时候允许的目录"
 * 与"编辑器里允许的目录"就会分家 —— 那正是第二条旁路。
 *
 * 去重按 `samePath`(Windows/macOS 大小写不敏感),顺序与包含判定的优先级一致:
 * 项目根在前,工作树其次,文献库/模版库最后。相对路径直接丢弃:围栏需要能与
 * 绝对路径比较的根,一条相对路径在 GenOffice 侧只会永远不命中(fail-closed)。
 */
export function listKnownWorkspaceRoots(): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined): void => {
    if (typeof p !== "string" || p.trim() === "" || !isAbsolute(p)) return;
    if (out.some((r) => samePath(r, p))) return;
    out.push(p);
  };
  for (const p of ProjectRepo.listPaths()) add(p);
  for (const p of SessionRepo.listWorktreeRoots()) add(p);
  for (const p of userDocRootsForGuard()) add(p);
  return out;
}
