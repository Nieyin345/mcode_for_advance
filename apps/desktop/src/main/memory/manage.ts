import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { MemoryManageInput, MemoryManageResult } from "@contracts/memory";
import { ProjectRepo } from "@main/store/repositories.js";
import { memoryRoot, listMemoryFiles, readMemoryFileWithRaw, saveMemoryFile, memoryHistory, readHistory, restoreMemory } from "./store.js";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function directory(path: string): boolean {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}
/** Finite allowlisted roots only; no guessed project ownership and no recursive symlink traversal. */
function nativeSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const owner of [".mcode", ".claude"]) {
    const base = join(homedir(), owner), root = join(base, "projects");
    if (!directory(base) || !directory(root)) continue;
    for (const slug of readdirSync(root).sort().slice(0, 500)) {
      if (!/^[A-Za-z0-9_-]+$/.test(slug)) continue;
      const project = join(root, slug), memories = join(project, "memory");
      if (!directory(project) || !directory(memories)) continue;
      for (const file of readdirSync(memories).sort().slice(0, 100)) {
        if (!/^[^./\\][^/\\]*\.md$/.test(file)) continue;
        const target = join(memories, file), stat = lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 524288) sources.set(`${owner}/${slug}/${file}`, target);
      }
    }
  }
  return sources;
}
function sourceText(id: string): string {
  if (id.startsWith("legacy:")) {
    const path = id.slice(7);
    if (!listMemoryFiles().some(m => m.path === path && m.scope === "legacy")) throw new Error("旧记忆源已改变");
    return readMemoryFileWithRaw(path).content;
  }
  const path = nativeSources().get(id);
  if (!path) throw new Error("来源不存在、过大或不安全");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288) throw new Error("来源已改变");
  return readFileSync(path, "utf8");
}
export function manageMemory(input: MemoryManageInput): MemoryManageResult {
  try {
    if (input.action === "list") return { ok: true,
      projects: ProjectRepo.list().map(p => ({ id: p.id, name: p.name })),
      sources: [...listMemoryFiles().filter(m => m.scope === "legacy").map(m => ({ id: `legacy:${m.path}`, label: `MCode legacy · ${m.path}` })),
        ...Array.from(nativeSources().keys(), id => {
          const [owner, project, file] = id.split("/");
          return { id, label: `${owner === ".claude" ? "Claude CLI" : "MCode CLI"} · ${project} · ${file}` };
        })], history: memoryHistory() };
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
