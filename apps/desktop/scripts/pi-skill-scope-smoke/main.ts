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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\npi-skill-scope-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
