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
  readEnginesMapDetailed,
  readEnginesMapFile,
  lastGoodEnginesMapPath,
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

  /* ── 坏文件防御(【MC-077】损坏且无 last-good → fail-closed,不是全开) ── */
  mkdirSync(root, { recursive: true });
  rmSync(lastGoodEnginesMapPath(enginesMapPath(root)), { force: true });
  writeFileSync(enginesMapPath(root), "{ this is not json", "utf-8");
  eqDeep("坏 JSON → 形状仍是空 map(stringify 看不到哨兵)", readEnginesMap(root), {});
  eq("坏 JSON 且无备份 → 任意名对 claude 拒绝(fail-closed)", engineEnabled(readEnginesMap(root), "anything", "claude"), false);
  eq("坏 JSON 且无备份 → engineRestricted true", engineRestricted(readEnginesMap(root), "claude"), true);
  rmSync(lastGoodEnginesMapPath(enginesMapPath(root)), { force: true });
  writeFileSync(enginesMapPath(root), JSON.stringify(["not", "an", "object"]), "utf-8");
  eqDeep("数组根 → 形状仍是空 map", readEnginesMap(root), {});
  eq("数组根且无备份 → 任意名拒绝(fail-closed)", engineEnabled(readEnginesMap(root), "anything", "claude"), false);
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
  mkdirSync(join(skillsRoot, "empty-dir"), { recursive: true }); // 无 SKILL.md → 不是技能
  writeFileSync(join(skillsRoot, "plain-file.txt"), "not a skill", "utf-8"); // 文件 → 跳过

  const names = skillNamesInRoot(skillsRoot);
  eq("frontmatter 名优先", names.get("alpha") !== undefined, true);
  eq("无 name 字段 → 目录名兜底", names.get("beta") !== undefined, true);
  eq("无 SKILL.md 的目录不是技能", names.get("empty-dir"), undefined);
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
// 【MC-077】矩阵文件损坏 → 保守恢复到 last-good,不静默把禁用条目重新启用。
{
  const r2 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-mc077-")), "skills");
  mkdirSync(r2, { recursive: true });
  try {
    const f = enginesMapPath(r2);
    // 缺文件 → MISSING。
    eq("MC-077:缺文件 → MISSING(不是 INVALID)", readEnginesMapDetailed(f).status, "MISSING");
    // 先存一份有禁用的矩阵 → 刷新 last-good。
    writeEnginesMap(r2, { "audit-skill": { codex: false } });
    eq("MC-077:合法矩阵 → VALID", readEnginesMapDetailed(f).status, "VALID");
    eqDeep("MC-077:last-good 已落", readEnginesMapDetailed(lastGoodEnginesMapPath(f)).map, { "audit-skill": { codex: false } });
    // 主文件损坏 → INVALID 且**保守恢复**(不接受"坏文件 = 全可见")。
    writeFileSync(f, "{ not json", "utf-8");
    const broken = readEnginesMapDetailed(f);
    eq("MC-077:坏 JSON → INVALID(不是静默全可见)", broken.status, "INVALID");
    eqDeep("MC-077:损坏后恢复到 last-good(禁用仍在)", broken.map, { "audit-skill": { codex: false } });
    eq("MC-077:recovered=true", broken.recovered, true);
    eq("MC-077:恢复后该技能仍对 codex 禁用", engineEnabled(readEnginesMap(r2), "audit-skill", "codex"), false);

    // 用户**明确全允许**(空矩阵)→ last-good 也刷成空;再损坏不得复活旧禁用。
    writeEnginesMap(r2, {});
    eqDeep("MC-077:明确全允许后 last-good 也刷成空", readEnginesMapDetailed(lastGoodEnginesMapPath(f)).map, {});
    writeFileSync(f, "{ broken again", "utf-8");
    eqDeep("MC-077:明确全允许后损坏 → 恢复到空(不复活旧禁用)", readEnginesMapDetailed(f).map, {});

    // 无 last-good 的损坏 → 报 INVALID 带原因,按不设限但绝不假装用户主动启用。
    const r3 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-mc077b-")), "skills");
    mkdirSync(r3, { recursive: true });
    writeFileSync(enginesMapPath(r3), "garbage", "utf-8");
    const noBackup = readEnginesMapDetailed(enginesMapPath(r3));
    eq("MC-077:无备份的损坏 → INVALID", noBackup.status, "INVALID");
    eq("MC-077:无备份的损坏 recovered=false", noBackup.recovered, false);
    check("MC-077:带可读原因", typeof noBackup.error === "string" && noBackup.error.length > 0, noBackup.error);
  } finally {
    rmSync(r2, { recursive: true, force: true });
  }
}

// 【MC-077 复审 E1】独立复审反例:老用户设置**从未创建 last-good**(直写主文件,不走
// writeEnginesMap),主文件被截断后必须 fail-closed —— 被禁用项**绝不能重新出现**。
// 这里断言的是 engineEnabled 的**实际效果**(不是只断言 status=INVALID)。
{
  const r4 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-e1-")), "skills");
  mkdirSync(join(r4, "private-skill"), { recursive: true });
  writeFileSync(join(r4, "private-skill", "SKILL.md"), "---\nname: private-skill\n---\n", "utf-8");
  try {
    const f = enginesMapPath(r4);
    // 直写主文件,并确保 last-good 不存在(模拟迁移前的老配置)。
    writeFileSync(f, JSON.stringify({ "private-skill": { codex: false, pi: false } }), "utf-8");
    rmSync(lastGoodEnginesMapPath(f), { force: true });
    // 有效读取:被禁用项确实被挡。
    const blockedBefore = !engineEnabled(readEnginesMap(r4), "private-skill", "codex");
    eq("E1:有效读时被禁用项已挡(codex)", blockedBefore, true);
    eq("E1:有效读时 enabledSkillNames(codex) 只留空", JSON.stringify(enabledSkillNames(r4, "codex")), "[]");
    // 模拟截断为不完整 JSON。
    writeFileSync(f, '{"private-skill": {"code', "utf-8");
    const after = readEnginesMapDetailed(f);
    eq("E1:截断后 status=INVALID", after.status, "INVALID");
    eq("E1:截断后 recovered=false(确无备份)", after.recovered, false);
    // ★ 核心判据:被禁用项**没有重新出现**。
    eq("★ E1:截断后 private-skill 对 codex 仍禁用(未 fail-open)",
      engineEnabled(readEnginesMap(r4), "private-skill", "codex"), false);
    eq("★ E1:截断后 private-skill 对 pi 仍禁用",
      engineEnabled(readEnginesMap(r4), "private-skill", "pi"), false);
    // fail-closed 是**全拒绝**:连从没受限的 claude 列也不放行,而不是只挡已知的那条。
    eq("E1:截断后任意未受限项对 claude 也拒绝(全拒绝语义)",
      engineEnabled(readEnginesMap(r4), "anything-else", "claude"), false);
    // 空 allowlist(不是 null「不设限」)—— Provider 据此切成显式空名单。
    eq("★ E1:截断后 codex 是空 allowlist 而非 null(不设限)",
      JSON.stringify(enabledSkillNames(r4, "codex")), "[]");
    eq("E1:截断后 engineRestricted(codex) 为 true",
      engineRestricted(readEnginesMap(r4), "codex"), true);
    eq("E1:截断后 enabledSkillDirs(codex) 为空数组",
      JSON.stringify(enabledSkillDirs(r4, "codex")), "[]");
    // 目录读权限异常(ENOENT 之外)→ 也 fail-closed(这里用「路径是目录」造非 ENOENT 读错)。
    const dirAsFile = join(r4, "iam-a-dir");
    mkdirSync(dirAsFile, { recursive: true });
    const readErr = readEnginesMapDetailed(dirAsFile);
    eq("E1:读非 ENOENT 故障(把目录当文件)→ INVALID", readErr.status, "INVALID");
    eq("★ E1:读故障且无备份 → 任意项拒绝", engineEnabled(readErr.map, "x", "claude"), false);
  } finally {
    rmSync(r4, { recursive: true, force: true });
  }
}

// 【MC-077】三条合法决议的边界(MISSING / VALID 空 / VALID 受限)。
{
  const r5 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-ok-")), "skills");
  mkdirSync(r5, { recursive: true });
  try {
    // ① MISSING:全新用户 → 全可见。
    rmSync(enginesMapPath(r5), { force: true });
    rmSync(lastGoodEnginesMapPath(enginesMapPath(r5)), { force: true });
    eq("边界①:MISSING 时任意项对 claude 可见", engineEnabled(readEnginesMap(r5), "fresh", "claude"), true);
    eq("边界①:MISSING 时 enabledSkillNames 为 null(不设限)", enabledSkillNames(r5, "claude"), null);
    // ② 用户**明确清空**(VALID 空映射)→ 全可见。
    writeEnginesMap(r5, {});
    eq("边界②:明确清空后任意项可见", engineEnabled(readEnginesMap(r5), "fresh", "claude"), true);
    eq("边界②:明确清空后 enabledSkillNames 仍 null", enabledSkillNames(r5, "claude"), null);
    // ③ VALID 受限 → 按限制交付。
    writeEnginesMap(r5, { "kept-out": { claude: false } });
    eq("边界③:受限项对 claude 拒绝", engineEnabled(readEnginesMap(r5), "kept-out", "claude"), false);
    eq("边界③:未提及项仍可见", engineEnabled(readEnginesMap(r5), "other", "claude"), true);
    eq("边界③:engineRestricted(claude) 为 true", engineRestricted(readEnginesMap(r5), "claude"), true);
  } finally {
    rmSync(r5, { recursive: true, force: true });
  }
}

// 【MC-077】部分条目类型异常(VALID,坏条目逐个丢弃,不牵连好条目,也不误触 fail-closed)。
{
  const r6 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-partial-")), "skills");
  mkdirSync(r6, { recursive: true });
  try {
    writeEnginesMap(r6, {});
    writeFileSync(enginesMapPath(r6), JSON.stringify({ ok: { codex: false }, bad: "x", alsobad: [1] }), "utf-8");
    const partial = readEnginesMapDetailed(enginesMapPath(r6));
    eq("部分坏条目:整体仍是 VALID", partial.status, "VALID");
    eq("部分坏条目:好条目保留(codex 禁用)", engineEnabled(partial.map, "ok", "codex"), false);
    eq("部分坏条目:未提及项仍可见(没有误触 fail-closed)", engineEnabled(partial.map, "unmentioned", "claude"), true);
  } finally {
    rmSync(r6, { recursive: true, force: true });
  }
}

// 【MC-077】两个窗口并发:同一次持久化里先写 last-good 再写主文件,任一顺序都不丢安全语义。
{
  const r7 = join(mkdtempSync(join(tmpdir(), "mcode-skill-engines-conc-")), "skills");
  mkdirSync(r7, { recursive: true });
  try {
    const w1 = writeEnginesMap;
    // 两个"窗口"各写一份:窗口 A 限制 skill-x,窗口 B 限制 skill-y。
    w1(r7, { "skill-x": { codex: false } });
    w1(r7, { "skill-y": { pi: false } });
    // 最后一次写入胜出,但它同时刷新了 last-good。
    eq("并发:最后一次写入的内容正确", engineEnabled(readEnginesMap(r7), "skill-y", "pi"), false);
    eq("并发:last-good 与主文件一致",
      JSON.stringify(readEnginesMapDetailed(lastGoodEnginesMapPath(enginesMapPath(r7))).map),
      JSON.stringify({ "skill-y": { pi: false } }));
    // 主文件损坏 → 恢复到最近一次提交,不是更旧的。
    writeFileSync(enginesMapPath(r7), "broken", "utf-8");
    eq("并发:损坏后恢复到最近提交(B 的限制)", engineEnabled(readEnginesMap(r7), "skill-y", "pi"), false);
  } finally {
    rmSync(r7, { recursive: true, force: true });
  }
}

console.log(`${checks} checks, ${failures} failures (final)`);
if (failures > 0) process.exit(1);