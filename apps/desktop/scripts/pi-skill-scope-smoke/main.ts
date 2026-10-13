/**
 * 【MC-074】Pi 单轮 Skill 选择范围回归 —— 显式点选不得被插件兼容名单意外扩展。
 *
 * ## 钉的是什么
 *
 * `buildPiSkillLoader` 里有一处"当矩阵限制 pi 时,把矩阵仍放行的**插件** skill 名
 * 并进 allowSet"的合并。它存在的理由正当(否则矩阵一受限,插件 skill 全被过滤掉),
 * 但它曾经**对显式点选同样生效** —— 于是用户在输入框里只选了 A,合并又把一堆插件
 * skill 塞进同一份 allowSet,"我只选了 A"变成"选了 A 加一堆"。
 *
 * 判据立在**最终交付的技能名单**上(不是"某段代码在不在"):
 *   - 显式点选 {A} → 只有 A 出现,插件里矩阵放行的 B 不得混进来;
 *   - 无点选、矩阵限制 pi → 插件里矩阵放行的仍保留(合并的真正职责,不能修坏);
 *   - 无点选、矩阵不限制 → 全部通过(不设限语义)。
 *
 * 驱动的是**真** `buildPiSkillLoader`,只在 SDK 边界换假 loader(见 stubs/piSdk.ts)。
 *
 * Run: scripts/pi-skill-scope-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiSkillLoader } from "@main/providers/pi-sdk/piSkillBridge.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eqSet(name: string, actual: string[], expected: string[]): void {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  check(name, a === e, { actual: a, expected: e });
}

const sdk = await import("./stubs/piSdk.js");

/** 建一个 mock skills root,每个名字一个 `<name>/SKILL.md`。 */
function makeSkillRoot(base: string, names: string[]): string {
  const root = join(base, "skills");
  for (const name of names) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  }
  return root;
}

/** 把 `defaultSkillsRoot()`(=`~/.mcode/skills`)指到给定 root —— 用 USERPROFILE/HOME。 */
function useHome(home: string): void {
  process.env["USERPROFILE"] = home;
  process.env["HOME"] = home;
}

async function resolvedNames(loader: { getSkills: () => { skills: Array<{ name: string }> } }): Promise<string[]> {
  return loader.getSkills().skills.map((s) => s.name);
}

const root = mkdtempSync(join(tmpdir(), "mcode-pi-skill-scope-"));
try {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  useHome(home);

  // 通用技能库:universal-a / universal-b。插件根:plugin-x / plugin-y。
  const universal = makeSkillRoot(join(home, ".mcode"), ["universal-a", "universal-b"]);
  const pluginRoot = join(root, "plugin-skills");
  makeSkillRoot(root, []); // no-op, keep shape
  mkdirSync(join(pluginRoot, "plugin-x"), { recursive: true });
  writeFileSync(join(pluginRoot, "plugin-x", "SKILL.md"), "---\nname: plugin-x\n---\n", "utf-8");
  mkdirSync(join(pluginRoot, "plugin-y"), { recursive: true });
  writeFileSync(join(pluginRoot, "plugin-y", "SKILL.md"), "---\nname: plugin-y\n---\n", "utf-8");
  check("夹具:通用库建成", universal.replace(/\\/g, "/").endsWith("/.mcode/skills") && universal !== pluginRoot, { universal, pluginRoot });

  // ── ① 显式点选 {universal-a},矩阵无限制 → 只有 universal-a ──
  // 这是 MC-074 的核心反例:插件合并曾把 plugin-x / plugin-y 也塞进点选集。
  {
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      allowNames: ["universal-a"],
      extraSkillPaths: [pluginRoot],
    });
    eqSet("★ 显式点选 {universal-a}:交付名单恰好是它(插件不被并入)", await resolvedNames(loader), ["universal-a"]);
    check(
      "★ 显式点选时 plugin-x 不出现(范围没被插件名单扩展)",
      !(await resolvedNames(loader)).includes("plugin-x"),
      await resolvedNames(loader),
    );
  }

  // ── ② 显式点选 {universal-a},矩阵**限制 pi** 且放行插件名 ──
  // 同一条反例在最容易触发的形态下:矩阵限制存在,合并分支会被走到。
  {
    // 让矩阵限制 pi:universal-b 对 pi 禁用(条目只要有一条 pi:false,restricted=true)。
    writeFileSync(
      join(home, ".mcode", "skills", ".mcode-engines.json"),
      JSON.stringify({ "universal-b": { pi: false } }),
      "utf-8",
    );
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      allowNames: ["universal-a"],
      extraSkillPaths: [pluginRoot],
    });
    const names = await resolvedNames(loader);
    eqSet("★ 矩阵限制 + 显式点选:仍是恰好 {universal-a}(不并入 plugin-*)", names, ["universal-a"]);
  }

  // ── ③ 无点选、矩阵限制 pi → 矩阵放行的插件 skill 保留(合并分支的真正职责) ──
  {
    // 矩阵只把 universal-b 从 pi 拿掉;universal-a / plugin-x / plugin-y 仍放行。
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      // 不传 allowNames = 无点选
      extraSkillPaths: [pluginRoot],
    });
    const names = await resolvedNames(loader);
    check("○ 无点选 + 矩阵限制:被禁的 universal-b 不出现", !names.includes("universal-b"), names);
    check("○ 无点选 + 矩阵限制:放行的 universal-a 在", names.includes("universal-a"), names);
    check("★ 无点选 + 矩阵限制:矩阵放行的插件 skill 保留(合并职责没修坏)", names.includes("plugin-x") && names.includes("plugin-y"), names);
  }

  // ── ④ 无点选、矩阵**不**限制 pi → 全部通过 ──
  {
    // 清掉矩阵文件(或写成空)→ 不限制。
    writeFileSync(join(home, ".mcode", "skills", ".mcode-engines.json"), JSON.stringify({}), "utf-8");
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      extraSkillPaths: [pluginRoot],
    });
    const names = await resolvedNames(loader);
    check("○ 无限制:通用库两个都在", names.includes("universal-a") && names.includes("universal-b"), names);
    check("○ 无限制:插件两个也在", names.includes("plugin-x") && names.includes("plugin-y"), names);
  }

  // ── ⑤ 显式点选里点名了一个插件 skill → 它就应当被交付(且只有它+同批点选) ──
  {
    writeFileSync(join(home, ".mcode", "skills", ".mcode-engines.json"), JSON.stringify({}), "utf-8");
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      allowNames: ["plugin-x"],
      extraSkillPaths: [pluginRoot],
    });
    eqSet("★ 显式点选插件 skill {plugin-x}:只交付它", await resolvedNames(loader), ["plugin-x"]);
  }

  // ── ⑥【MC-094】项目技能根 `<cwd>/.claude/skills` 必须真到 loader ──
  // 从前 Pi 的 mcodeSkillRoots 只给全局库,项目技能在面板看得见、Pi 收不到。
  mkdirSync(join(root, ".claude", "skills", "proj-skill"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\n---\n", "utf-8");
  {
    writeFileSync(join(home, ".mcode", "skills", ".mcode-engines.json"), JSON.stringify({}), "utf-8");
    const loader = await buildPiSkillLoader({
      sdk: sdk as never,
      cwd: root,
      extraSkillPaths: [pluginRoot],
    });
    const names = await resolvedNames(loader);
    check("★ MC-094:项目技能 proj-skill 被交付 Pi(矩阵不限制时)", names.includes("proj-skill"), names);
    check("○ MC-094:全局与插件技能不因接入项目根而消失",
      names.includes("universal-a") && names.includes("plugin-x"), names);
  }

  // ── ⑦【MC-094】同名优先级:项目 > 全局(面板同一档次),且只交付一次 ──
  {
    // 全局库里也叫 dup- 的一份;项目里放同名 dup-skill。项目那份必须赢。
    mkdirSync(join(home, ".mcode", "skills", "dup-skill"), { recursive: true });
    writeFileSync(join(home, ".mcode", "skills", "dup-skill", "SKILL.md"), "---\nname: dup-skill\n---\n", "utf-8");
    mkdirSync(join(root, ".claude", "skills", "dup-skill"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "dup-skill", "SKILL.md"), "---\nname: dup-skill\n---\n", "utf-8");
    const loader = await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] });
    const resolved = loader.getSkills().skills;
    const dups = resolved.filter((s) => s.name === "dup-skill");
    check("★ MC-094:同名只交付一次(不重复注入)", dups.length === 1, resolved.map((s) => s.name));
    check("★ MC-094:同名交付的是**项目**那一份(项目优先)",
      !!dups[0]?.baseDir && dups[0].baseDir.replace(/\\/g, "/").includes("/.claude/skills/"),
      dups[0]?.baseDir);
    rmSync(join(root, ".claude", "skills", "dup-skill"), { recursive: true, force: true });
    rmSync(join(home, ".mcode", "skills", "dup-skill"), { recursive: true, force: true });
  }

  // ── ⑧【MC-094】矩阵按名字把某项目技能从 pi 拿掉 → 它不得交付 ──
  {
    writeFileSync(
      join(home, ".mcode", "skills", ".mcode-engines.json"),
      JSON.stringify({ "proj-skill": { pi: false } }),
      "utf-8",
    );
    const loader = await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] });
    const names = await resolvedNames(loader);
    check("★ MC-094:矩阵禁掉的项目技能 proj-skill 不交付 pi", !names.includes("proj-skill"), names);
    check("○ MC-094:同矩阵下其它放行技能仍在", names.includes("universal-a"), names);
  }

  // ── ⑨【MC-094】禁用**即时生效**:矩阵改一次 → 重建 loader → 交付集合立刻跟着变 ──
  // 承重点:provider 每轮重建 loader,所以"改完矩阵下一轮就生效"必须成立;这里用同一
  // 份目录、只翻矩阵,证明交付集合跟着矩阵重算,而不是被上一次结果缓存住。
  {
    const matrixFile = join(home, ".mcode", "skills", ".mcode-engines.json");
    // 先全放行 → universal-a 在。
    writeFileSync(matrixFile, JSON.stringify({}), "utf-8");
    const before = await resolvedNames(await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] }));
    check("★ MC-094:禁用前 universal-a 交付 pi", before.includes("universal-a"), before);
    // 只改矩阵禁掉 universal-a(pi)→ 重建 loader → 立刻不交付。
    writeFileSync(matrixFile, JSON.stringify({ "universal-a": { pi: false } }), "utf-8");
    const disabled = await resolvedNames(await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] }));
    check("★ MC-094:改矩阵禁 universal-a 后重建 → 立即不交付", !disabled.includes("universal-a"), disabled);
    check("○ MC-094:禁用只影响被改名,universal-b 仍在", disabled.includes("universal-b"), disabled);
    // 再翻回来(放行)→ 重建 → 立刻恢复交付。证明不是"禁用一次就永久消失"。
    writeFileSync(matrixFile, JSON.stringify({}), "utf-8");
    const reenabled = await resolvedNames(await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] }));
    check("★ MC-094:矩阵放行后重建 → universal-a 立即恢复交付(重算,不缓存)", reenabled.includes("universal-a"), reenabled);
  }

  // ── ⑩【MC-094】同名覆盖**承重反例**:项目那份不是"碰巧赢了",而是**压住了**一份
  //     真实存在的全局同名件。撤掉项目那份,被压住的全局件必须**重新出现** —— 否则上一条
  //     可能只是因为全局那份根本不在。 ──
  {
    writeFileSync(join(home, ".mcode", "skills", ".mcode-engines.json"), JSON.stringify({}), "utf-8");
    const globalDir = join(home, ".mcode", "skills", "shadow");
    const projectDir = join(root, ".claude", "skills", "shadow");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "SKILL.md"), "---\nname: shadow\n---\n", "utf-8");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "SKILL.md"), "---\nname: shadow\n---\n", "utf-8");

    const both = (await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] })).getSkills().skills.filter((s) => s.name === "shadow");
    check("★ MC-094:同名(全局+项目)只交付一次", both.length === 1, both.map((s) => s.baseDir));
    check("★ MC-094:同名交付项目那份(baseDir 在 .claude/skills)",
      !!both[0]?.baseDir && both[0].baseDir.replace(/\\/g, "/").includes("/.claude/skills/"), both[0]?.baseDir);

    // 撤掉项目那份 → 被压住的全局那份**必须重现**(证明它一直在,只是被优先级压住了)。
    rmSync(projectDir, { recursive: true, force: true });
    const afterRemoval = (await buildPiSkillLoader({ sdk: sdk as never, cwd: root, extraSkillPaths: [pluginRoot] })).getSkills().skills.filter((s) => s.name === "shadow");
    check("★ MC-094:撤掉项目同名件后,被压住的全局件重现(优先级真在承重)",
      afterRemoval.length === 1 && !!afterRemoval[0]?.baseDir && afterRemoval[0].baseDir.replace(/\\/g, "/").includes("/.mcode/skills/"),
      afterRemoval.map((s) => s.baseDir));
    rmSync(globalDir, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\npi-skill-scope-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
