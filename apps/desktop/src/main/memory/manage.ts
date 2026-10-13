import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { MemoryManageInput, MemoryManageResult } from "@contracts/memory";
import { ProjectRepo } from "@main/store/repositories.js";
import { listMemoryFiles, readMemoryFileWithRaw, saveMemoryFile, memoryHistory, readHistory, restoreMemory } from "./store.js";
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
export function manageMemory(input: MemoryManageInput, visible?: (path: string) => boolean): MemoryManageResult {
  // 【MC-092】`visible` 是宿主(带 agent 作用域时)传进来的「当前可见集合」判据:`undefined` =
  // 桌面用户(全局管理权限,不设限);给了谓词 = agent,只许碰**本项目 + 全局**的路径。
  // 作用域判据**只有一份**(在 `ipc/memory.ts` 的 `agentVisible`);这里只把它套到每个要读/写的
  // 路径上,不自己再写一份规则。列表型输出(sources/history/projects)按同一谓词**先滤后返回**,
  // 出参计数才与列出来的条目同源(否则会出现"计数里带着别项目、列表里却没有"的错位)。
  const canSee = (path: string): boolean => visible === undefined || visible(path);
  try {
    if (input.action === "list") {
      const native = nativeSources();
      const history = memoryHistory();
      return { ok: true,
        // 项目清单:agent 只看得见自己那个项目(拿一条本项目记忆路径当探针问同一谓词)。
        projects: ProjectRepo.list().filter(p => canSee(`projects/${p.id}/project/x.md`)).map(p => ({ id: p.id, name: p.name })),
        sources: [...listMemoryFiles().filter(m => m.scope === "legacy" && canSee(m.path)).map(m => ({ id: `legacy:${m.path}`, label: `MCode legacy · ${m.path}` })),
          // 原生来源 id 不是记忆路径,经同一谓词时对 agent 一律不可见(旧记忆 / 别的 owner 的项目
          // 记忆不归 agent);桌面用户照旧看到全部。
          ...Array.from(native.map.keys()).filter(id => canSee(id)).map(id => {
            const [owner, project, file] = id.split("/");
            return { id, label: `${owner === ".claude" ? "Claude CLI" : "MCode CLI"} · ${project} · ${file}` };
          })],
        // 被上限挡掉的数如实报出(0 也带上,界面据此决定显不显示那句话)。
        truncatedSources: native.truncatedProjects + native.truncatedFiles,
        history: history.entries.filter(e => canSee(e.path)),
        historyTruncated: history.truncated };
    }
    if (input.action === "history") {
      const h = readHistory(input.id);
      if (!canSee(h.path)) throw new Error("记忆历史不属于本项目或显式全局范围;agent 只能整理当前项目的记忆。");
      return { ok: true, content: h.raw, digest: digest(h.raw) };
    }
    if (input.action === "restore") {
      const h = readHistory(input.id);
      if (!canSee(h.path)) throw new Error("记忆历史不属于本项目或显式全局范围;agent 只能整理当前项目的记忆。");
      if (digest(h.raw) !== input.digest) throw new Error("历史来源已改变，请重新预览");
      const result = restoreMemory(input.id); notifyMemoryChanged("restore:" + result.path);
      return { ok: true, path: result.path };
    }
    // preview / import:来源(`legacy:` 旧记忆 / `owner/slug/file` 原生引擎目录)必须落在可见集合里
    // —— 这两类来源都不是「本项目 + 全局」的记忆路径,故 agent 作用域下会被拒(与 `memory.read`
    // 拒 legacy 同口径)。**这一道同时管住 import 的写**:import 只会把来源正文写进
    // `projects/<目标>` 或 `global`,来源读不到就没有可写的正文;桌面用户(无谓词)照旧可导入。
    const sourcePath = input.source.startsWith("legacy:") ? input.source.slice(7) : null;
    if (!canSee(sourcePath ?? input.source)) throw new Error("记忆来源不属于本项目或显式全局范围;agent 只能整理当前项目的记忆。");
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
