/**
 * 假 `@earendil-works/pi-coding-agent` —— 只提供 `buildPiSkillLoader` 需要的两个导出:
 *   - `DefaultResourceLoader`:`additionalSkillPaths` 里的每个 root 按 `<root>/<name>/SKILL.md`
 *     真扫一遍(模拟 Pi 的发现),`skillsOverride` 原样套用,`reload()` 写入解析结果;
 *   - `getAgentDir()`:返回一个不存在的目录(本套不关心 Pi 本地默认技能)。
 *
 * 这样 `buildPiSkillLoader` 的**真实现**(allowSet 构造 / 插件名单合并 / override 过滤)
 * 被完整驱动,而 Pi SDK 本体不参与。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Skill = { name: string; baseDir?: string };

export function getAgentDir(): string {
  return join(process.env["MCODE_SMOKE_AGENT_DIR"] ?? "/nonexistent-pi-agent", "agent");
}

export interface FakeLoaderOptions {
  additionalSkillPaths?: string[];
  skillsOverride?: (base: { skills: Skill[]; diagnostics: unknown[] }) => { skills: Skill[]; diagnostics: unknown[] };
}

export class DefaultResourceLoader {
  private opts: FakeLoaderOptions;
  private resolved: Skill[] = [];
  constructor(opts: FakeLoaderOptions) {
    this.opts = opts;
  }
  async reload(): Promise<void> {
    const found: Skill[] = [];
    for (const root of this.opts.additionalSkillPaths ?? []) {
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const dir = join(root, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
          if (!statSync(join(dir, "SKILL.md")).isFile()) continue;
        } catch {
          continue;
        }
        found.push({ name: entry, baseDir: dir });
      }
    }
    const out = this.opts.skillsOverride ? this.opts.skillsOverride({ skills: found, diagnostics: [] }) : { skills: found };
    this.resolved = out.skills;
  }
  getSkills(): { skills: Skill[]; diagnostics: unknown[] } {
    return { skills: this.resolved, diagnostics: [] };
  }
}
