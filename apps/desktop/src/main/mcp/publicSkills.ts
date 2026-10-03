import { SKILL_NAME_RE } from "@contracts/ipc/skills";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { parseSkillFrontmatter } from "@main/lib/skillEngines.js";

export const projectSkillRoot = (project: string): string => path.join(project, ".claude", "skills");
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
};
function real(file: string): string {
  let cursor = path.resolve(file);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...suffix); } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(file);
      suffix.unshift(path.basename(cursor)); cursor = parent;
    }
  }
}
export const globalSkillRoots = (): string[] => [".mcode", ".claude", ".codex", ".agents"].map(dir => path.join(homedir(), dir, "skills"));

/** Public file helpers must not turn a global/library allowlist or a project
 * symlink into a second skills channel. This is NOT a sandbox for shell code. */
export function publicSkillReadDenial(project: string | null, file: string, globals = globalSkillRoots()): string | null {
  const target = real(file);
  if (globals.some(root => inside(root, file) || inside(real(root), target))) return "公网不开放全局技能，请使用当前项目 .claude/skills 内的技能";
  if (project && inside(project, file) && !inside(real(project), target)) return "公网文件读取拒绝指向项目外的符号链接";
  for (const candidate of [path.resolve(file), target]) {
    const normalized = candidate.replace(/\\/g, "/").toLowerCase();
    if (/(?:^|\/)\.(?:claude|codex|agents|mcode)\/skills(?:\/|$)/.test(normalized)) {
      if (!project || !(inside(projectSkillRoot(project), candidate) && inside(project, candidate) || inside(real(projectSkillRoot(project)), candidate) && inside(real(project), candidate))) {
        return "这里只允许读取当前链接绑定项目的技能，不继承其他项目、全局或插件技能";
      }
    }
  }
  return null;
}

export interface PublicSkill { name: string; description: string; path: string; scope: "project" }
/** Metadata only, bounded before reading. Do not use global skill discovery:
 * it follows symlinks and reads SKILL.md before public access can be checked. */
export function discoverPublicSkills(project: string | null): { skills: PublicSkill[]; scan_truncated: boolean } {
  if (!project || !path.isAbsolute(project)) return { skills: [], scan_truncated: false };
  const root = projectSkillRoot(project);
  if (publicSkillReadDenial(project, root)) return { skills: [], scan_truncated: false };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { return { skills: [], scan_truncated: false }; }
  const found = new Map<string, PublicSkill>();
  const candidates = entries.filter(e => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()));
  for (const entry of candidates.slice(0, 2000)) {
    const file = path.join(root, entry.name, "SKILL.md");
    if (publicSkillReadDenial(project, file)) continue;
    try {
      const fd = fs.openSync(file, "r");
      let head: string;
      try {
        if (!fs.fstatSync(fd).isFile()) continue;
        const bytes = Buffer.alloc(8192);
        const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        head = bytes.subarray(0, size).toString("utf8");
      } finally { fs.closeSync(fd); }
      const fm = parseSkillFrontmatter(head);
      const name = fm.name?.trim() || entry.name;
      if (!SKILL_NAME_RE.test(name)) continue;
      if (!found.has(name)) found.set(name, { name, description: (fm.description ?? "").slice(0, 240), path: file, scope: "project" });
    } catch { /* unreadable/disappeared skill: not available */ }
  }
  return { skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), scan_truncated: candidates.length > 2000 };
}
