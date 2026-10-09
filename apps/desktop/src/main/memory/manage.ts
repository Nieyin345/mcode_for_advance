import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { MemoryManageInput, MemoryManageResult } from "@contracts/memory";
import { ProjectRepo } from "@main/store/repositories.js";
import { memoryRoot, listMemoryFiles, readMemoryFileWithRaw, saveMemoryFile, memoryHistory, readHistory, restoreMemory } from "./store.js";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** 原生记忆源的扫描上限(每 owner)。超出的部分会被**报出来**,不是静默丢弃。 */
const PROJECT_CAP = 500;
const FILE_CAP = 100;
function directory(path: string): boolean {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}
/**
 * 有限、白名单的根目录;不猜项目归属,不递归跟随符号链接。
 *
 * ⚠️ **截断要能报出来。** 项目 slug 与每个项目下的 `.md` 都有上限,而从前 `.slice(0,N)`
 * 是**静默的** —— 用户的第 501 个项目、第 101 个记忆文件会**凭空不在列表里**,用户以为
 * 那份记忆不存在(与 `review.ts` 明确报 unreadable/tooLong 的口径对立)。所以这里把
 * "被上限挡掉多少"一并返回,由 list 那条路显式告诉用户。
 */
function nativeSources(): { map: Map<string, string>; truncatedProjects: number; truncatedFiles: number } {
  const sources = new Map<string, string>();
  let truncatedProjects = 0;
  let truncatedFiles = 0;
  for (const owner of [".mcode", ".claude"]) {
    const base = join(homedir(), owner), root = join(base, "projects");
    if (!directory(base) || !directory(root)) continue;
    const allSlugs = readdirSync(root).sort();
    if (allSlugs.length > PROJECT_CAP) truncatedProjects += allSlugs.length - PROJECT_CAP;
    for (const slug of allSlugs.slice(0, PROJECT_CAP)) {
      if (!/^[A-Za-z0-9_-]+$/.test(slug)) continue;
      const project = join(root, slug), memories = join(project, "memory");
      if (!directory(project) || !directory(memories)) continue;
      const allFiles = readdirSync(memories).sort();
      if (allFiles.length > FILE_CAP) truncatedFiles += allFiles.length - FILE_CAP;
      for (const file of allFiles.slice(0, FILE_CAP)) {
        if (!/^[^./\\][^/\\]*\.md$/.test(file)) continue;
        const target = join(memories, file), stat = lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 524288) sources.set(`${owner}/${slug}/${file}`, target);
      }
    }
  }
  return { map: sources, truncatedProjects, truncatedFiles };
}
function sourceText(id: string): string {
  if (id.startsWith("legacy:")) {
    const path = id.slice(7);
    if (!listMemoryFiles().some(m => m.path === path && m.scope === "legacy")) throw new Error("旧记忆源已改变");
    return readMemoryFileWithRaw(path).content;
  }
  const path = nativeSources().map.get(id);
  if (!path) throw new Error("来源不存在、过大或不安全");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288) throw new Error("来源已改变");
  return readFileSync(path, "utf8");
}
export function manageMemory(input: MemoryManageInput): MemoryManageResult {
  try {
    if (input.action === "list") {
      const native = nativeSources();
      const history = memoryHistory();
      return { ok: true,
        projects: ProjectRepo.list().map(p => ({ id: p.id, name: p.name })),
        sources: [...listMemoryFiles().filter(m => m.scope === "legacy").map(m => ({ id: `legacy:${m.path}`, label: `MCode legacy · ${m.path}` })),
          ...Array.from(native.map.keys(), id => {
            const [owner, project, file] = id.split("/");
            return { id, label: `${owner === ".claude" ? "Claude CLI" : "MCode CLI"} · ${project} · ${file}` };
          })],
        // 被上限挡掉的数如实报出(0 也带上,界面据此决定显不显示那句话)。
        truncatedSources: native.truncatedProjects + native.truncatedFiles,
        history: history.entries,
        historyTruncated: history.truncated };
    }
    if (input.action === "history") { const raw = readHistory(input.id).raw; return { ok: true, content: raw, digest: digest(raw) }; }
    if (input.action === "restore") {
      if (digest(readHistory(input.id).raw) !== input.digest) throw new Error("历史来源已改变，请重新预览");
      const result = restoreMemory(input.id); notifyMemoryChanged("restore:" + result.path);
      return { ok: true, path: result.path };
    }
    const raw = sourceText(input.source), hash = digest(raw);
    if (input.action === "preview") return { ok: true, content: raw, digest: hash };
    if (hash !== input.digest) throw new Error("来源已改变，请重新预览后确认");
    if (!input.global && !ProjectRepo.list().some(p => p.id === input.projectId)) throw new Error("请选择有效项目");
    const prefix = input.global ? "global" : `projects/${input.projectId}`;
    const path = `${prefix}/${input.category}/import-${digest(input.source).slice(0, 24)}.md`;
    saveMemoryFile({ path, title: input.source, content: raw, expectedRevision: null });
    notifyMemoryChanged("import:" + path);
    return { ok: true, path };
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}
