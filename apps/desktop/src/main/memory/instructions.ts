import { lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep, relative } from "node:path";
import { normPathKey } from "@main/lib/pathNorm.js";
/** Host-owned, bounded compatibility: root to cwd; AGENTS.md wins over CLAUDE.md per directory.
 * No parent/home walk, symlinks, native settings, imports or executable configuration. */
export function projectInstructions(root: string, cwd: string): string {
  const base = resolve(root), current = resolve(cwd);
  const dirs = [base];
  // 【MC-070】父子判断走**平台规范化键**,别用大小写敏感的裸 `startsWith`。Windows 上同一
  // 项目仅改 cwd 字母大小写(盘符/目录大小写变体),从前会判定 cwd **不在** root 之下,于是
  // 子目录的 AGENTS.md/CLAUDE.md 全部漏注入 —— 三个引擎对同一项目给出不同上下文。Linux
  // 大小写敏感:不同目录仍不合并(`normPathKey` 只在 win32/darwin 折叠大小写)。分隔符亦统一
  // 为 `/`,故用 `baseKey + "/"` 而非 `sep`。
  if (normPathKey(current).startsWith(normPathKey(base) + "/")) {
    let dir = base;
    for (const segment of relative(base, current).split(sep).slice(0, 20)) { dir = join(dir, segment); dirs.push(dir); }
  }
  const blocks: string[] = []; let remaining = 24000;
  for (const dir of dirs) {
    try { if (lstatSync(dir).isSymbolicLink()) break; } catch { break; }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = join(dir, name);
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) break;
        if (stat.size > 131072) { blocks.push(`项目指令未加载（超过 128 KiB）：${file}`); break; }
        const raw = readFileSync(file, "utf8"), text = raw.slice(0, remaining);
        blocks.push(`### ${file}\n${text}${raw.length > remaining ? "\n[项目指令已按预算截断]" : ""}`);
        remaining -= text.length; break;
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") { blocks.push(`项目指令不可读：${file}`); break; } }
    }
    if (remaining <= 0) break;
  }
  return blocks.length ? "## 项目指令（宿主解析；每目录 AGENTS.md 优先，CLAUDE.md 仅回退）\n" + blocks.join("\n\n") : "";
}
