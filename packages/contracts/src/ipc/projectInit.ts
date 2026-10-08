/** User-authored, deterministic project scaffolds. No shell or model execution. */
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../memory.js";
export const INIT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;
/** 窗口级自定义事件:模板被设置页改过,让对话里的 `/init` 选择框刷新。**只有一份** ——
 *  从前 `useProjectInitializer.tsx` 与 `ProjectInitManager.tsx` 各写了一份字面量(前者
 *  刻意不 import 后者,免得把整个设置编辑器拉进每个对话),于是改一处漏一处就静默不刷新。
 *  放进契约里两边都能便宜地 import。 */
export const PROJECT_INIT_CHANGED_EVENT = "mcode:project-initializers-changed";
export function initCommand(name: string): string { return `init-${name}`; }
export function initNameKey(name: string): string { return name.normalize("NFKC").toLowerCase(); }
/** Portable relative paths only; no URL decoding or ambient cwd resolution. */
export function safeInitPath(value: string): boolean {
  if (!value || value.length > 240 || value.includes("\\") || /[\x00-\x1f<>:"|?*]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= 16 && parts.every(p => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p)
    && p.toLowerCase() !== ".git" && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
const Path = z.string().refine(safeInitPath, "Use a portable project-relative path without .. or .git");
const Content = z.string().max(131072);
/** AI 生成的项目说明文件。三个引擎都经宿主统一注入(`main/memory/instructions.ts`:每个目录
 *  AGENTS.md 优先,CLAUDE.md 只作回退),所以默认写 AGENTS.md;选 CLAUDE.md 只为兼容在
 *  Mcode 之外也用 Claude Code CLI 的项目 —— 同一目录两份都在时 Mcode 只读 AGENTS.md。 */
export const AGENT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export type AgentFileName = (typeof AGENT_FILE_NAMES)[number];
export const AgentFileSchema = z.object({
  enabled: z.boolean().default(true),
  filename: z.enum(AGENT_FILE_NAMES).default("AGENTS.md"),
  /** 这个场景对说明文件的额外要求(拼进生成提示词的「本场景的要求」一节)。 */
  focus: z.string().max(8000).default(""),
}).strict();
export type AgentFileConfig = z.infer<typeof AgentFileSchema>;
export const ProjectInitDraftSchema = z.object({
  name: z.string().trim().max(48).regex(INIT_NAME_RE),
  description: z.string().max(500).default(""),
  directories: z.array(Path).max(100).default([]),
  files: z.array(z.object({ path: Path, content: Content }).strict()).max(100).default([]),
  memories: z.array(z.object({
    category: z.enum(MEMORY_CATEGORIES),
    filename: z.string().max(100).refine(p => safeInitPath(p) && !p.includes("/") && !p.startsWith(".") && p.endsWith(".md"), "Memory filename must end in .md"),
    title: z.string().trim().min(1).max(200), content: Content,
    pinned: z.boolean().default(true),
  }).strict()).max(30).default([]),
  /** 可选:老模板没有这个字段,等同于不生成说明文件(存储格式向后兼容)。 */
  agentFile: AgentFileSchema.optional(),
}).strict().superRefine((draft, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!draft.directories.length && !draft.files.length && !draft.memories.length && !draft.agentFile?.enabled) fail("Add at least one directory, file, memory or the AI-generated guide file");
  if ([...draft.files, ...draft.memories].reduce((n, f) => n + f.content.length, 0) > 1048576) fail("Template content exceeds 1,048,576 characters");
  const paths = [...draft.directories, ...draft.files.map(f => f.path)].map(initNameKey);
  if (new Set(paths).size !== paths.length) fail("Duplicate file/directory paths");
  for (const file of draft.files) if (paths.some(p => p.startsWith(initNameKey(file.path) + "/"))) fail("A file cannot be another entry's parent");
  const parents = new Set(draft.directories.map(initNameKey));
  for (const path of paths) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { parents.add(parts.join("/")); parts.pop(); }
  }
  if (parents.size > 500) fail("A template may create at most 500 directories including parents");
  const memories = draft.memories.map(m => initNameKey(`${m.category}/${m.filename}`));
  if (new Set(memories).size !== memories.length) fail("Duplicate memory paths");
});
export type ProjectInitDraft = z.infer<typeof ProjectInitDraftSchema>;
export interface ProjectInitTemplate extends ProjectInitDraft { id: string; revision: string; }
export interface ProjectInitSummary {
  id: string; name: string; description: string; revision: string;
  /** 启用了 AI 生成说明文件时是哪个文件名;没启用则没有这个字段。 */
  agentFile?: AgentFileName;
}
export interface ProjectInitList { templates: ProjectInitSummary[]; /** 裸 `/init` 预选的场景;没设或已删除时为 null。 */ defaultId: string | null; }
const Id = z.string().uuid();
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
export const ProjectInitIdSchema = z.object({ id: Id }).strict();
export const ProjectInitSaveSchema = z.object({ id: Id.optional(), expectedRevision: Revision.optional(), draft: ProjectInitDraftSchema }).strict()
  .refine(v => !!v.id === !!v.expectedRevision, "An update requires its original revision");
export const ProjectInitDeleteSchema = z.object({ id: Id, expectedRevision: Revision }).strict();
export const ProjectInitDefaultSchema = z.object({ id: Id.nullable() }).strict();
export const ProjectInitPreviewSchema = z.object({ sessionId: z.string().min(1), command: z.string().max(60) }).strict();
export const ProjectInitApplySchema = ProjectInitPreviewSchema.extend({ digest: Revision });
export type ProjectInitSaveInput = z.infer<typeof ProjectInitSaveSchema>;
export type ProjectInitPreviewInput = z.infer<typeof ProjectInitPreviewSchema>;
export type ProjectInitApplyInput = z.infer<typeof ProjectInitApplySchema>;
export interface ProjectInitAction {
  kind: "directory" | "file" | "memory"; path: string;
  status: "create" | "skip" | "blocked" | "created" | "failed";
  reason?: "exists" | "symlink" | "parentFile" | "wrongType" | "io";
  error?: string; content?: string; title?: string; pinned?: boolean;
}
export interface ProjectInitPreview {
  templateId: string; name: string; revision: string; sessionId: string;
  projectId: string; projectName: string; root: string; digest: string;
  actions: ProjectInitAction[];
  /** 模板启用了 AI 生成说明文件时才有。 */
  agentFile?: ProjectInitAgentPlan;
}
export interface ProjectInitAgentPlan {
  filename: AgentFileName;
  /** 文件已存在(或本次模板会先放一份种子)→ 提示词走「改进」而不是「新建」。 */
  exists: boolean;
  /** 选了 CLAUDE.md 而根目录已有(或将有)AGENTS.md:Mcode 每个目录只读 AGENTS.md,CLAUDE.md 不会生效。 */
  shadowed: boolean;
  /** 路径被符号链接 / 同名目录占着:与 actions 的 blocked 同一判据,阻止执行。 */
  blocked?: ProjectInitAction["reason"];
  /** 将在本对话里发给当前引擎的完整提示词(不含用户补充)。 */
  prompt: string;
}
export interface ProjectInitResult {
  projectId: string; root: string; actions: ProjectInitAction[];
  /** 有 AI 生成步骤时:要发给引擎的提示词,由渲染端作为普通一轮对话发出。 */
  agentPrompt?: string; agentFilename?: AgentFileName;
}

/* ───────────────────────── AI 生成说明文件的提示词 ─────────────────────────
 *
 * 为什么由 Mcode 拼、而不是转给引擎原生的 `/init`:三个引擎里只有 Claude Code CLI 会认
 * `/init`(写 CLAUDE.md);Codex 的 `/init` 只在它的 TUI 里有,app-server 会把这几个字原样
 * 当用户消息发给模型(见 CodexAgentSdkProvider.listCommands 的实测记录);Pi 没有。
 * Claude Code 的 `/init` 本质上也只是「在当前对话里发一段提示词」—— 所以这里照它和 Codex
 * 原版提示词的要点自己拼一段,三个引擎拿到的是同一段话、写同一个文件。
 */
const SCAFFOLD_LIST_MAX = 40;
export function buildAgentFilePrompt(input: {
  filename: AgentFileName; exists: boolean; scenario: string; focus: string; scaffold: readonly string[];
}): string {
  const { filename, exists } = input;
  const out: string[] = [];
  out.push(`# 任务:${exists ? "改进" : "生成"}项目说明文件 \`${filename}\``);
  out.push(`请分析当前项目,在项目根目录${exists ? "改进已有的" : "创建"} \`${filename}\`。这份文件会在之后每一轮对话开始时自动提供给在这个项目里工作的 AI 助手(Mcode 的 Claude、Codex、Pi 三个引擎共用),让它们不必重新摸索就能上手。`);
  out.push(["## 先了解项目", "",
    "- 浏览目录结构,阅读 README、各目录里的说明文件,以及构建 / 依赖配置(package.json、pyproject.toml、requirements.txt、Makefile、CMakeLists.txt 等,有哪些读哪些);",
    "- 如果有 .cursor/rules/、.cursorrules、.github/copilot-instructions.md,或子目录里的 AGENTS.md / CLAUDE.md,吸收其中重要的部分;",
    "- 如果是 git 仓库,看看最近的提交记录,总结提交信息的写法。"].join("\n"));
  out.push(["## 要写的内容", "",
    "1. **常用命令**:构建、运行、测试(包括怎么只跑单个测试)、代码检查。只写项目里确实存在的命令。",
    "2. **整体结构**:需要读好几个文件才能看明白的架构、模块分工和数据流向;主要目录各放什么。",
    "3. **本项目特有的约定**:命名、代码 / 写作风格、文件存放规则、不能改动的文件或目录。"].join("\n"));
  const scaffold = input.scaffold.filter(Boolean);
  if (scaffold.length) {
    const shown = scaffold.slice(0, SCAFFOLD_LIST_MAX).map(p => `- ${p}`);
    if (scaffold.length > SCAFFOLD_LIST_MAX) shown.push(`- ……等共 ${scaffold.length} 项`);
    out.push([`## 刚建好的结构`, "", `这次初始化(「${input.scenario}」场景)建好了下面这些目录 / 文件(已存在的保持原样),把它们的用途写进结构说明:`, "", ...shown].join("\n"));
  }
  const focus = input.focus.trim();
  if (focus) out.push(`## 本场景的要求\n\n${focus}`);
  out.push(["## 写法要求", "",
    "- 简洁、具体、只针对这个项目;用 Markdown 标题分节,一般控制在 200–600 字。",
    "- 不要罗列一眼就能看到的每个文件;不要写通用的开发常识(如「写单元测试」「不要提交密钥」);不要编造项目里没有依据的内容。",
    "- 项目几乎是空的(刚初始化)时不要硬凑:根据现有目录说明和场景要求写一份简短骨架,留出「待补充」的位置,之后随项目推进再更新。",
    exists
      ? "- 文件已经存在:先完整读一遍,保留仍然正确的内容,补充缺失的、修正过时的,不要整篇推倒重写。"
      : `- 文件开头写:\n\n    # ${filename}\n\n    本文件为在此项目中工作的 AI 助手提供指引(Mcode 的 Claude、Codex、Pi 共用)。`,
    `- 只创建或修改 \`${filename}\` 这一个文件,不要改动项目里的其他文件。完成后用一两句话说明写了什么${exists ? "、改了哪些地方" : ""}。`].join("\n"));
  return out.join("\n\n");
}
/** 用户在预览框里补充的要求,附在提示词最后。 */
export function appendInitNote(prompt: string, note: string): string {
  const value = note.trim();
  return value ? `${prompt}\n\n## 用户补充\n\n${value}` : prompt;
}
