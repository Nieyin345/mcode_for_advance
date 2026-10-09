/** Shared deterministic initializer core. Desktop IPC calls these same functions.
 * Never overwrites a file/memory, executes code, or sends a model turn.
 * Partial failures are reported per action; successful creations are NOT rolled back.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, mkdir, open, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ProjectInitDraftSchema, ProjectInitSaveSchema, ProjectInitDeleteSchema,
  ProjectInitIdSchema, ProjectInitPreviewSchema, ProjectInitApplySchema, ProjectInitDefaultSchema,
  initCommand, initNameKey, buildAgentFilePrompt,
  type ProjectInitTemplate, type ProjectInitSummary, type ProjectInitSaveInput,
  type ProjectInitPreviewInput, type ProjectInitApplyInput, type ProjectInitPreview,
  type ProjectInitAction, type ProjectInitResult, type ProjectInitList, type ProjectInitAgentPlan,
} from "@contracts/ipc/projectInit";
import { SettingRepo, ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { MEMORY_PROJECT_ID } from "@main/memory/paths.js";
import { saveMemoryFile } from "@main/memory/store.js";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
import { errText } from "@main/lib/ipcError.js";
import { SHIPPED_INITIALIZERS } from "./shipped.js";
const PREFIX = "projectInit.template.";
const MAX_TEMPLATES = 200;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const busy = new Set<string>();
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function stored(id: string): ProjectInitTemplate {
  const raw = SettingRepo.get(PREFIX + ProjectInitIdSchema.parse({ id }).id);
  if (raw === null) throw new Error("初始化方案不存在");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("初始化方案无法读取;未替换它"); }
  // ⚠️ schema 校验失败也必须翻成人话。`ZodError.message` 是一整段英文 JSON 数组,而
  // `stored()` 的调用方(`list`/`get`/`delete` 与渲染端 `ProjectInitManager`)把
  // `err.message` 原样画在设置页的 ErrorNote 上 —— 一条"JSON 合法但 schema 不符"的坏模板
  // (外部/旧版写入、名字不再匹配 `INIT_NAME_RE`、files 非数组…)会让整块面板蹦出英文 JSON。
  // 紧邻的 JSON 解析失败已经译成中文了,这条不该漏。
  let parsed: ReturnType<typeof ProjectInitDraftSchema.parse>;
  try { parsed = ProjectInitDraftSchema.parse(value); }
  catch (err) { throw new Error(`初始化方案内容不合法,已跳过:${errText(err)}`); }
  return { ...parsed, id, revision: hash(raw) };
}
const DEFAULT_KEY = "projectInit.defaultId";
export function listProjectInitializers(): ProjectInitList {
  const keys = SettingRepo.keysWithPrefix(PREFIX);
  if (keys.length > MAX_TEMPLATES) throw new Error("初始化方案数量已达上限");
  const templates = keys.map((key): ProjectInitSummary => {
    const { id, name, description, revision, agentFile } = stored(key.slice(PREFIX.length));
    return { id, name, description, revision, ...(agentFile?.enabled ? { agentFile: agentFile.filename } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  // 默认场景删掉之后这里自然变回 null(不必在删除时联动清理)。
  const saved = SettingRepo.get(DEFAULT_KEY);
  return { templates, defaultId: templates.some(t => t.id === saved) ? saved : null };
}
/** 裸 `/init` 预选哪个场景。`null` 清除。 */
export function setDefaultProjectInitializer(raw: { id: string | null }): { ok: true } {
  const { id } = ProjectInitDefaultSchema.parse(raw);
  if (id === null) { SettingRepo.delete(DEFAULT_KEY); return { ok: true }; }
  stored(id); // 不存在 / 读不了就抛,不记一个悬空的 id
  SettingRepo.set(DEFAULT_KEY, id);
  return { ok: true };
}
const SEEDED_KEY = "projectInit.seededShipped";
/** 出厂模板只播种一次(见 `shipped.ts` 文件头):播过的 id 记下来,用户删了不复活;
 *  命令名与用户已有模板冲突时不播,同样记下。启动时调一次(`main/index.ts`)——
 *  不放进 `listProjectInitializers`,那是纯读取,不该有副作用。 */
export function ensureShippedInitializersSeeded(): void {
  upgradeUntouchedShipped();
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
/** 出厂模板后来补了「AI 生成说明文件」(2026-10)。用户**从没改过**的那份 —— 存的正好是旧版
 *  逐字内容(= 新版去掉 agentFile)—— 原地升级成新版;改过一个字、或自己关掉过 AI 生成的都不动。
 *  逐字比较,所以只适用于「新版 = 旧版 + agentFile」;升级后不再相等,天然幂等。
 *
 *  后来一种情况让「逐字相等」失效:出厂正文本身被改过(`610403b8` 统一「资料库」叫法时顺手
 *  改了 RESEARCH 的 references/README.md 一句话)。那样老安装里那份**原版**就不等于「新版
 *  去掉 agentFile」了——用 `legacyPristineRevisions`(历次发过的正文哈希)把它认回来。 */
function upgradeUntouchedShipped(): void {
  for (const shipped of SHIPPED_INITIALIZERS) {
    if (!shipped.upgradeAddsAgentFile) continue;
    const raw = SettingRepo.get(PREFIX + shipped.id);
    if (raw === null) continue;
    const next = ProjectInitDraftSchema.parse(shipped.draft);
    const previous = { ...next };
    delete previous.agentFile;
    const pristine = raw === JSON.stringify(previous)
      || (shipped.legacyPristineRevisions ?? []).includes(hash(raw));
    if (pristine) SettingRepo.set(PREFIX + shipped.id, JSON.stringify(next));
  }
}
export function getProjectInitializer(input: { id: string }): ProjectInitTemplate {
  return stored(ProjectInitIdSchema.parse(input).id);
}
export function saveProjectInitializer(raw: ProjectInitSaveInput): ProjectInitTemplate {
  const input = ProjectInitSaveSchema.parse(raw);
  const templates = listProjectInitializers().templates;
  if (!input.id && templates.length >= MAX_TEMPLATES) throw new Error("初始化方案数量已达上限");
  if (input.id && stored(input.id).revision !== input.expectedRevision) throw new Error("方案已改动;保存前请重新加载");
  if (templates.some(t => t.id !== input.id && initNameKey(t.name) === initNameKey(input.draft.name))) throw new Error("已存在同名的初始化命令");
  const id = input.id ?? randomUUID();
  SettingRepo.set(PREFIX + id, JSON.stringify(input.draft));
  return stored(id);
}
export function deleteProjectInitializer(raw: { id: string; expectedRevision: string }): { ok: true } {
  const input = ProjectInitDeleteSchema.parse(raw);
  if (stored(input.id).revision !== input.expectedRevision) throw new Error("方案已改动;删除前请重新加载");
  SettingRepo.delete(PREFIX + input.id);
  return { ok: true };
}
async function context(input: ProjectInitPreviewInput) {
  const session = SessionRepo.get(input.sessionId);
  const project = session ? ProjectRepo.get(session.projectId) : undefined;
  if (!session || !project || !MEMORY_PROJECT_ID.test(project.id)) throw new Error("当前对话没有有效的项目");
  // The selected checkout, not the renderer's mutable active-project setting.
  const root = await realpath(session.worktreePath || project.path);
  const memoryBase = await realpath(dataRoot());
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("项目根路径不是文件夹");
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
    if ((await inspect(root, path, "file")).status !== "create") throw new Error("发布前目标已被改动;没有覆盖任何内容");
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
  if (!summary) throw new Error("未找到初始化命令;请在「设置 → 记忆与上下文 → 项目初始化」中配置");
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
  const agentFile = await planAgentFile(template, ctx.root);
  const plan = { templateId: template.id, name: template.name, revision: template.revision,
    sessionId: input.sessionId, projectId: ctx.project.id, projectName: ctx.project.name, root: ctx.root, actions,
    ...(agentFile ? { agentFile } : {}) };
  return { ctx, plan: { ...plan, digest: hash(JSON.stringify({ ...plan, memoryBase: ctx.memoryBase, rootIdentity: ctx.rootIdentity })) } };
}
/** AI 生成说明文件那一步的计划。只看不写:文件本身由引擎在对话里写(它要先读项目)。
 *  进 digest —— 预览之后文件冒出来 / 消失,会和其他条目一样要求重新预览。 */
async function planAgentFile(template: ProjectInitTemplate, root: string): Promise<ProjectInitAgentPlan | undefined> {
  const config = template.agentFile;
  if (!config?.enabled) return undefined;
  const seeds = new Set(template.files.map(f => initNameKey(f.path)));
  const state = await inspect(root, config.filename, "file");
  const exists = state.status === "skip" || seeds.has(initNameKey(config.filename));
  let shadowed = false;
  if (config.filename === "CLAUDE.md") {
    shadowed = seeds.has(initNameKey("AGENTS.md")) || (await inspect(root, "AGENTS.md", "file")).status === "skip";
  }
  return {
    filename: config.filename, exists, shadowed,
    ...(state.status === "blocked" ? { blocked: state.reason } : {}),
    prompt: buildAgentFilePrompt({
      filename: config.filename, exists, scenario: template.name, focus: config.focus,
      scaffold: [...template.directories, ...template.files.map(f => f.path)],
    }),
  };
}
export async function previewProjectInitializer(raw: ProjectInitPreviewInput): Promise<ProjectInitPreview> {
  return (await build(raw)).plan;
}
export async function applyProjectInitializer(raw: ProjectInitApplyInput): Promise<ProjectInitResult> {
  const input = ProjectInitApplySchema.parse(raw);
  const first = await context(input);
  // Different worktree sessions still share project memories; serialize per project.
  if (busy.has(first.project.id)) throw new Error("该项目已有一个初始化正在进行");
  busy.add(first.project.id);
  try {
    const { ctx, plan } = await build({ sessionId: input.sessionId, command: input.command });
    if (ctx.project.id !== first.project.id) throw new Error("对话的项目已改变;请重新预览");
    if (plan.digest !== input.digest) throw new Error("预览已改变;应用前请重新查看当前方案");
    if (plan.actions.some(a => a.status === "blocked") || plan.agentFile?.blocked) throw new Error("初始化被不安全的路径或不兼容的已有条目阻止");
    const results: ProjectInitAction[] = [];
    let memoryChanged = false;
    for (const action of plan.actions) {
      if (action.status === "skip") { results.push(action); continue; }
      try {
        const current = await context(input);
        if (current.project.id !== ctx.project.id || current.root !== ctx.root || current.rootIdentity !== ctx.rootIdentity || current.memoryBase !== ctx.memoryBase) throw new Error("初始化期间项目或记忆根已改变");
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
    // 说明文件不在这里写:渲染端拿 agentPrompt 在本对话里发一轮,由当前引擎分析项目后写入。
    return { projectId: ctx.project.id, root: ctx.root, actions: results,
      ...(plan.agentFile ? { agentPrompt: plan.agentFile.prompt, agentFilename: plan.agentFile.filename } : {}) };
  } finally { busy.delete(first.project.id); }
}
