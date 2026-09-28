/** User-authored, deterministic project scaffolds. No shell or model execution. */
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../memory.js";
export const INIT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;
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
}).strict().superRefine((draft, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!draft.directories.length && !draft.files.length && !draft.memories.length) fail("Add at least one directory, file or memory");
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
export interface ProjectInitSummary { id: string; name: string; description: string; revision: string; }
const Id = z.string().uuid();
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
export const ProjectInitIdSchema = z.object({ id: Id }).strict();
export const ProjectInitSaveSchema = z.object({ id: Id.optional(), expectedRevision: Revision.optional(), draft: ProjectInitDraftSchema }).strict()
  .refine(v => !!v.id === !!v.expectedRevision, "An update requires its original revision");
export const ProjectInitDeleteSchema = z.object({ id: Id, expectedRevision: Revision }).strict();
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
}
export interface ProjectInitResult { projectId: string; root: string; actions: ProjectInitAction[]; }
