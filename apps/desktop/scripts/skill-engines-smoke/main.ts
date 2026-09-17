/**
 * Headless smoke for 通用 skill 层的 per-engine 矩阵 — `main/lib/skillEngines.ts`.
 *
 * ## 为什么要钉这里
 *
 * `.mcode-engines.json` 的语义里藏着几个**只看代码看不出对错、错了还安静**的决策:
 *
 *  - missing = enabled:矩阵文件只存用户的**限制**(false 键),无条目 = 三引擎全开。
 *    语义反了,所有没配置过的 skill 会突然从某个引擎里消失;
 *  - 最小化持久化:`{claude:true,codex:false,pi:false}` 必须落盘成
 *    `{codex:false,pi:false}`,全开时整个条目删除 —— 否则文件很快塞满无意义的
 *    true,而且"用户显式设过 true"和"默认就是 true"会混淆;
 *  - 坏文件防御:坏 JSON / 坏条目必须逐个丢弃而不是全盘失效(否则一个手滑的
 *    编辑就让所有 skill 离线);
 *  - 名字解析:frontmatter `name` 优先、目录名兜底,三个引擎的过滤必须和
 *    设置面板的列表用**同一套**名字解析,否则矩阵写的是 A 名、provider 过滤
 *    的是 B 名,开关静默失效。
 *
 * 这些全在临时目录里真读真写地跑一遍。没有覆盖的:IPC 层(SKILLS_ENGINES_SET
 * handler,拉 electron)与三引擎 provider 的消费点(要活的会话),靠真机验收。
 *
 * Run: scripts/skill-engines-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_ENGINES,
  defaultSkillsRoot,
  engineEnabled,
  engineRestricted,
  enginesMapPath,
  enabledSkillDirs,
  enabledSkillNames,
  minimizeEntry,
  parseSkillFrontmatter,
  readEnginesMap,
  readEnginesMapFile,
  setEnginesEntry,
  skillNamesInRoot,
  writeEnginesMap,
} from "@main/lib/skillEngines.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

function eqDeep(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const root = mkdtempSync(join(tmpdir(), "mcode-skill-engines-smoke-"));
try {
  /* ── 引擎清单 ── */
  eqDeep("SKILL_ENGINES 顺序固定(claude/codex/pi)", [...SKILL_ENGINES], ["claude", "codex", "pi"]);

  /* ── 默认语义:missing = enabled ── */
  const empty = readEnginesMap(root); // 根目录都没有矩阵文件
  eqDeep("无矩阵文件 → 空 map", empty, {});
  eq("空 map:任意名对 claude 启用", engineEnabled(empty, "anything", "claude"), true);
  eq("空 map:engineRestricted(claude) false", engineRestricted(empty, "claude"), false);
  eq("无限制 → enabledSkillNames null", enabledSkillNames(root, "codex"), null);
  eq("无限制 → enabledSkillDirs null", enabledSkillDirs(root, "codex"), null);

  /* ── minimizeEntry ── */
  eqDeep("minimize 只留 false 键", minimizeEntry({ claude: true, codex: false, pi: false }), { codex: false, pi: false });
  eq("全 true → null(条目该删)", minimizeEntry({ claude: true, codex: true, pi: true }), null);
  eq("空条目 → null", minimizeEntry({}), null);
  eq("非 false 值不构成限制 → null(条目该删)", minimizeEntry({ claude: "yes" as unknown as boolean }), null);

  /* ── 坏文件防御 ── */
  mkdirSync(root, { recursive: true });
  writeFileSync(enginesMapPath(root), "{ this is not json", "utf-8");
  eqDeep("坏 JSON → 空 map(全开兜底)", readEnginesMap(root), {});
  writeFileSync(enginesMapPath(root), JSON.stringify(["not", "an", "object"]), "utf-8");
  eqDeep("数组根 → 空 map", readEnginesMap(root), {});
  writeFileSync(
    enginesMapPath(root),
    JSON.stringify({
      "good-skill": { codex: false },
      "bad-1": "not an object",
      "bad-2": { codex: "no" },
      "bad-3": [1, 2],
      nullkey: null,
      "all-true": { claude: true, codex: true, pi: true },
    }),
    "utf-8",
  );
  const defensive = readEnginesMap(root);
  eqDeep("坏条目逐个丢弃,只留 good-skill", defensive, { "good-skill": { codex: false } });
  eq("good-skill 对 codex 禁用", engineEnabled(defensive, "good-skill", "codex"), false);
  eq("good-skill 对 pi 仍启用(缺键 = true)", engineEnabled(defensive, "good-skill", "pi"), true);

  /* ── setEnginesEntry + round-trip ── */
  const map = readEnginesMap(root);
  setEnginesEntry(map, "my-skill", { claude: true, codex: false, pi: false });
  writeEnginesMap(root, map);
  const persisted = JSON.parse(readFileSync(enginesMapPath(root), "utf-8"));
  eqDeep("落盘最小化:只存 false 键", persisted["my-skill"], { codex: false, pi: false });
  const reread = readEnginesMap(root);
  eq("round-trip:my-skill 对 codex 禁用", engineEnabled(reread, "my-skill", "codex"), false);
  eq("round-trip:my-skill 对 claude 启用", engineEnabled(reread, "my-skill", "claude"), true);

  // 路径参数版薄壳(readEnginesMapFile/writeEnginesMapFile):MCP 矩阵复用这套
  // 核心,两版必须永远等价 —— 否则技能与 MCP 的矩阵语义会悄悄分叉。
  eqDeep(
    "薄壳:readEnginesMapFile 与 readEnginesMap 等价",
    readEnginesMapFile(enginesMapPath(root)),
    reread,
  );

  // 移回通用:全 true → 条目整个消失
  setEnginesEntry(reread, "my-skill", { claude: true, codex: true, pi: true });
  writeEnginesMap(root, reread);
  eq("全开后条目删除", "my-skill" in readEnginesMap(root), false);

  // setEnginesEntry 返回同一 map(链式)
  const chained = setEnginesEntry({}, "x", { claude: false, codex: true, pi: true });
  eqDeep("setEnginesEntry 返回 map 本身", chained, { x: { claude: false } });

  /* ── frontmatter 名字解析 ── */
  eqDeep(
    "frontmatter:双引号 description + argument-hint",
    parseSkillFrontmatter('---\nname: my-skill\ndescription: "Has \\"quotes\\"" \nargument-hint: <file>\n---\nbody'),
    { name: "my-skill", description: 'Has \\"quotes\\"', argumentHint: "<file>" },
  );
  eqDeep("argumentHint 别名", parseSkillFrontmatter("---\nname: a\nargumentHint: x\n---"), { name: "a", argumentHint: "x" });
  eqDeep("无 frontmatter → {}", parseSkillFrontmatter("plain text"), {});
  eqDeep("frontmatter 不在文件头 → {}", parseSkillFrontmatter("intro\n---\nname: a\n---"), {});

  /* ── skillNamesInRoot + 过滤函数 ── */
  const skillsRoot = join(root, "skills");
  mkdirSync(join(skillsRoot, "alpha"), { recursive: true });
  writeFileSync(join(skillsRoot, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n", "utf-8");
  mkdirSync(join(skillsRoot, "beta"), { recursive: true });
  writeFileSync(join(skillsRoot, "beta", "SKILL.md"), "---\ndescription: no name field\n---\n", "utf-8"); // 目录名兜底
  mkdirSync(join(skillsRoot, "empty-dir"), { recursive: true }); // 无 SKILL.md → 目录名兜底
  writeFileSync(join(skillsRoot, "plain-file.txt"), "not a skill", "utf-8"); // 文件 → 跳过

  const names = skillNamesInRoot(skillsRoot);
  eq("frontmatter 名优先", names.get("alpha") !== undefined, true);
  eq("无 name 字段 → 目录名兜底", names.get("beta") !== undefined, true);
  eq("无 SKILL.md 的目录也算技能(目录名)", names.get("empty-dir") !== undefined, true);
  eq("普通文件跳过", names.get("plain-file.txt"), undefined);

  // 矩阵:只给 claude 留 alpha(beta/empty-dir 对 claude 禁用)
  const m2 = readEnginesMap(skillsRoot);
  setEnginesEntry(m2, "beta", { claude: false, codex: true, pi: true });
  setEnginesEntry(m2, "empty-dir", { claude: false, codex: true, pi: true });
  writeEnginesMap(skillsRoot, m2);
  eqDeep("claude 的启用名单(限制后)", enabledSkillNames(skillsRoot, "claude"), ["alpha"]);
  eqDeep("codex 无限制仍返回 null", enabledSkillNames(skillsRoot, "codex"), null);
  const claudeDirs = enabledSkillDirs(skillsRoot, "claude");
  eq("claude 的启用目录只有一个", claudeDirs?.length === 1, true);
  check("启用目录指向 alpha", (claudeDirs ?? [])[0]?.endsWith(join("skills", "alpha")) ?? false, claudeDirs);

  // 全部禁用 → 空数组(真 allowlist 语义,不是 null)
  const m3 = readEnginesMap(skillsRoot);
  setEnginesEntry(m3, "alpha", { claude: false, codex: true, pi: true });
  writeEnginesMap(skillsRoot, m3);
  eqDeep("全部禁用 → 空数组", enabledSkillNames(skillsRoot, "claude"), []);

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// defaultSkillsRoot 只做 homedir 拼接,不碰磁盘 —— 冒烟里只钉它的形状。
check(
  "defaultSkillsRoot 指向 ~/.mcode/skills",
  defaultSkillsRoot().replace(/\\/g, "/").endsWith("/.mcode/skills"),
  defaultSkillsRoot(),
);
console.log(`${checks} checks, ${failures} failures (final)`);
if (failures > 0) process.exit(1);
