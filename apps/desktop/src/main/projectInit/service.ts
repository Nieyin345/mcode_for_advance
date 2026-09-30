/** Shared deterministic initializer core. Desktop IPC calls these same functions.
 * Never overwrites a file/memory, executes code, or sends a model turn.
 * Partial failures are reported per action; successful creations are NOT rolled back.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, mkdir, open, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ProjectInitDraftSchema, ProjectInitSaveSchema, ProjectInitDeleteSchema,
  ProjectInitIdSchema, ProjectInitPreviewSchema, ProjectInitApplySchema,
  initCommand, initNameKey,
  type ProjectInitTemplate, type ProjectInitSummary, type ProjectInitSaveInput,
  type ProjectInitPreviewInput, type ProjectInitApplyInput, type ProjectInitPreview,
  type ProjectInitAction, type ProjectInitResult,
} from "@contracts/ipc/projectInit";
import { SettingRepo, ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { MEMORY_PROJECT_ID } from "@main/memory/paths.js";
import { saveMemoryFile } from "@main/memory/store.js";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
import { SHIPPED_INITIALIZERS } from "./shipped.js";
const PREFIX = "projectInit.template.";
const MAX_TEMPLATES = 200;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const busy = new Set<string>();
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function stored(id: string): ProjectInitTemplate {
  const raw = SettingRepo.get(PREFIX + ProjectInitIdSchema.parse({ id }).id);
  if (raw === null) throw new Error("Initialization template not found");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Initialization template is unreadable; it was not replaced"); }
  return { ...ProjectInitDraftSchema.parse(value), id, revision: hash(raw) };
}
export function listProjectInitializers(): { templates: ProjectInitSummary[] } {
  const keys = SettingRepo.keysWithPrefix(PREFIX);
  if (keys.length > MAX_TEMPLATES) throw new Error("Too many initialization templates");
  return { templates: keys.map(key => {
    const { id, name, description, revision } = stored(key.slice(PREFIX.length));
    return { id, name, description, revision };
  }).sort((a, b) => a.name.localeCompare(b.name)) };
}
const SEEDED_KEY = "projectInit.seededShipped";
/** 出厂模板只播种一次(见 `shipped.ts` 文件头):播过的 id 记下来,用户删了不复活;
 *  命令名与用户已有模板冲突时不播,同样记下。启动时调一次(`main/index.ts`)——
 *  不放进 `listProjectInitializers`,那是纯读取,不该有副作用。 */
export function ensureShippedInitializersSeeded(): void {
  let seeded: string[] = [];
  try {
    const parsed: unknown = JSON.parse(SettingRepo.get(SEEDED_KEY) ?? "[]");
    if (Array.isArray(parsed)) seeded = parsed.filter((v): v is string => typeof v === "string");
  } catch { /* 清单坏了就当空的;模板本身已存在时下面照样跳过,不会重复。 */ }
  const pending = SHIPPED_INITIALIZERS.filter(s => !seeded.includes(s.id));
  if (!pending.length) return;
  const names = new Set(SettingRepo.keysWithPrefix(PREFIX).map(key => {
    try { return initNameKey(stored(key.slice(PREFIX.length)).name); } catch { return ""; }
  }));
  for (const shipped of pending) {
    const draft = ProjectInitDraftSchema.parse(shipped.draft);
    if (SettingRepo.get(PREFIX + shipped.id) === null && !names.has(initNameKey(draft.name))) {
      SettingRepo.set(PREFIX + shipped.id, JSON.stringify(draft));
      names.add(initNameKey(draft.name));
    }
    seeded.push(shipped.id);
  }
  SettingRepo.set(SEEDED_KEY, JSON.stringify(seeded));
}
export function getProjectInitializer(input: { id: string }): ProjectInitTemplate {
  return stored(ProjectInitIdSchema.parse(input).id);
}
export function saveProjectInitializer(raw: ProjectInitSaveInput): ProjectInitTemplate {
  const input = ProjectInitSaveSchema.parse(raw);
  const templates = listProjectInitializers().templates;
  if (!input.id && templates.length >= MAX_TEMPLATES) throw new Error("Too many initialization templates");
  if (input.id && stored(input.id).revision !== input.expectedRevision) throw new Error("Template changed; reload before saving");
  if (templates.some(t => t.id !== input.id && initNameKey(t.name) === initNameKey(input.draft.name))) throw new Error("Initialization command name already exists");
  const id = input.id ?? randomUUID();
  SettingRepo.set(PREFIX + id, JSON.stringify(input.draft));
  return stored(id);
}
export function deleteProjectInitializer(raw: { id: string; expectedRevision: string }): { ok: true } {
  const input = ProjectInitDeleteSchema.parse(raw);
  if (stored(input.id).revision !== input.expectedRevision) throw new Error("Template changed; reload before deleting");
  SettingRepo.delete(PREFIX + input.id);
  return { ok: true };
}
async function context(input: ProjectInitPreviewInput) {
  const session = SessionRepo.get(input.sessionId);
  const project = session ? ProjectRepo.get(session.projectId) : undefined;
  if (!session || !project || !MEMORY_PROJECT_ID.test(project.id)) throw new Error("No valid project for this conversation");
  // The selected checkout, not the renderer's mutable active-project setting.
  const root = await realpath(session.worktreePath || project.path);
  const memoryBase = await realpath(dataRoot());
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("Project root is not a directory");
  return { session, project, root, memoryBase, rootIdentity: `${rootStat.dev}:${rootStat.ino}` };
}
/** Inspect each ancestor without reading existing content. Missing parents are
 * planned, not created by preview. Reject symlinks/junctions before every I/O.
 * This is not an OS-level transaction against a hostile concurrent filesystem. */
async function inspect(root: string, path: string, kind: ProjectInitAction["kind"]): Promise<Pick<ProjectInitAction, "status" | "reason" | "error">> {
  const parts = path.split("/");
  let current = root;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return { status: "blocked", reason: "symlink" };
      if (i < parts.length - 1 && !stat.isDirectory()) return { status: "blocked", reason: "parentFile" };
      if (i === parts.length - 1) {
        if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return { status: "blocked", reason: "wrongType" };
        return { status: "skip", reason: "exists" };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "create" };
      return { status: "blocked", reason: "io", error: errorText(e) };
    }
  }
  return { status: "create" };
}
/** Publish only a completely written file; a failed write must not leave a
 * truncated target that a retry would mistake for an existing user file. */
async function publishFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  const temporary = join(dirname(target), `.mcode-init-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  const owned = await handle.stat();
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    if ((await inspect(root, path, "file")).status !== "create") throw new Error("Target changed before publication; nothing was overwritten");
    await link(temporary, target); // Atomic no-clobber, same filesystem.
  } finally {
    await handle.close();
    try {
      const current = await lstat(temporary);
      if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) await unlink(temporary);
    } catch { /* Cleanup is best effort; never remove or replace the target. */ }
  }
}
async function build(raw: ProjectInitPreviewInput) {
  const input = ProjectInitPreviewSchema.parse(raw);
  const summary = listProjectInitializers().templates.find(t => initNameKey(initCommand(t.name)) === initNameKey(input.command));
  if (!summary) throw new Error("Initialization command not found; configure it in Memory & context");
  const template = stored(summary.id);
  const ctx = await context(input);
  const directories = new Set(template.directories);
  for (const entry of [...template.directories, ...template.files.map(f => f.path)]) {
    const parts = entry.split("/"); parts.pop();
    while (parts.length) { directories.add(parts.join("/")); parts.pop(); }
  }
  const actions: ProjectInitAction[] = [];
  for (const path of [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    actions.push({ kind: "directory", path, ...await inspect(ctx.root, path, "directory") });
  }
  for (const file of template.files) actions.push({ kind: "file", ...file, ...await inspect(ctx.root, file.path, "file") });
  for (const memory of template.memories) {
    const path = `projects/${ctx.project.id}/${memory.category}/${memory.filename}`;
    actions.push({ kind: "memory", path, title: memory.title, content: memory.content, pinned: memory.pinned,
      ...await inspect(ctx.memoryBase, `memory/${path}`, "memory") });
  }
  const plan = { templateId: template.id, name: template.name, revision: template.revision,
    sessionId: input.sessionId, projectId: ctx.project.id, projectName: ctx.project.name, root: ctx.root, actions };
  return { ctx, plan: { ...plan, digest: hash(JSON.stringify({ ...plan, memoryBase: ctx.memoryBase, rootIdentity: ctx.rootIdentity })) } };
}
export async function previewProjectInitializer(raw: ProjectInitPreviewInput): Promise<ProjectInitPreview> {
  return (await build(raw)).plan;
}
export async function applyProjectInitializer(raw: ProjectInitApplyInput): Promise<ProjectInitResult> {
  const input = ProjectInitApplySchema.parse(raw);
  const first = await context(input);
  // Different worktree sessions still share project memories; serialize per project.
  if (busy.has(first.project.id)) throw new Error("An initialization is already running for this project");
  busy.add(first.project.id);
  try {
    const { ctx, plan } = await build({ sessionId: input.sessionId, command: input.command });
    if (ctx.project.id !== first.project.id) throw new Error("Conversation project changed; preview again");
    if (plan.digest !== input.digest) throw new Error("Preview changed; review the current plan before applying");
    if (plan.actions.some(a => a.status === "blocked")) throw new Error("Initialization is blocked by unsafe paths or incompatible existing entries");
    const results: ProjectInitAction[] = [];
    let memoryChanged = false;
    for (const action of plan.actions) {
      if (action.status === "skip") { results.push(action); continue; }
      try {
        const current = await context(input);
        if (current.project.id !== ctx.project.id || current.root !== ctx.root || current.rootIdentity !== ctx.rootIdentity || current.memoryBase !== ctx.memoryBase) throw new Error("Project or memory root changed during initialization");
        const root = action.kind === "memory" ? ctx.memoryBase : ctx.root;
        const path = action.kind === "memory" ? `memory/${action.path}` : action.path;
        const state = await inspect(root, path, action.kind);
        if (state.status === "skip") { results.push({ ...action, ...state }); continue; }
        if (state.status === "blocked") { results.push({ ...action, ...state, status: "failed" }); continue; }
        if (action.kind === "directory") {
          await mkdir(join(root, path)); // Parents are explicit ordered actions.
        } else if (action.kind === "file") {
          // No-clobber even if another creator wins after preview/inspection.
          await publishFile(root, path, action.content ?? "");
        } else {
          saveMemoryFile({ path: action.path, title: action.title, content: action.content ?? "", pinned: action.pinned, expectedRevision: null });
          memoryChanged = true;
        }
        results.push({ ...action, status: "created" });
      } catch (e) {
        results.push({ ...action, status: "failed", reason: "io", error: errorText(e) });
      }
    }
    if (memoryChanged) notifyMemoryChanged(`project-init:${plan.templateId}`);
    return { projectId: ctx.project.id, root: ctx.root, actions: results };
  } finally { busy.delete(first.project.id); }
}
