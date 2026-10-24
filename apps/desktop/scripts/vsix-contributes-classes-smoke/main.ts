/**
 * 【F011】贡献点三分类：A 接受+标记 / B 接受+标记 / C 拒绝。
 *
 * ## 分类依据是「用户会不会当场发现」
 *
 * | 类 | 例 | 处理 | 用户会发现吗 |
 * |---|---|---|---|
 * | **A 声明式** | `configuration` `languages` `grammars` `colors` | 接受 + 标记「不读」 | **不会** ← 最危险 |
 * | **B 需运行时** | `menus` `submenus` `views` `keybindings` | 接受 + 标记「不做」 | 会（菜单项不出现） |
 * | **C 未知** | 其余 | 拒绝并点名 | 会（装不上） |
 *
 * ## 为什么 A 类必须标记（这套的核心论点）
 *
 * `menus` 至少会「菜单项不出现」—— **当场可见**。
 * `configuration` 接受了但设置项不生效 —— **用户永远不会知道**。
 *
 * **所以 A 类不能因为「它不报错」被当成无害**：它恰恰因为不报错而更难发现。
 * 标记对 A/B 两类都强制，差别只在措辞。
 *
 * ## ⚠️ 这套必须走 install 层
 *
 * F009 的教训：`contributes` 的分类只在 `packageSchema.parse`（`install()` 里）生效，
 * `readMinimalVsix` 完全不知道它。测在 read 层等于什么都没测。
 */
import { VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {}, persist: async () => {}, requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm, persistModulePermissions: async (t) => { perm = t; },
  });
}

function zipOf(contributes: Record<string, unknown>, name = "demo"): Uint8Array {
  const pkg = {
    publisher: "acme", name, version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: [`onCommand:${name}.hello`],
    contributes: { commands: [{ command: `${name}.hello`, title: "Hello" }], ...contributes },
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

async function install(contributes: Record<string, unknown>, name = "demo"):
  Promise<{ ok: boolean; error?: string; ignored?: readonly { section: string; kind: string }[] }> {
  try {
    const bridge = await VscodeL1Bridge.install(host(), zipOf(contributes, name), {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    return { ok: true, ignored: bridge.ignoredContributions };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

console.log("[1] 正控：只有 commands 时，ignored 为空");
{
  const r = await install({});
  check("★ 只有 commands 能装", r.ok, { error: r.error });
  check("★ ignoredContributions 为空（没有额外贡献点）", r.ok && r.ignored?.length === 0, {
    ignored: r.ignored,
  });
}

console.log("[2] A 类：接受，且**必须被标记**为「不读」");
{
  const aSections = ["configuration", "configurationDefaults", "languages", "grammars", "colors", "jsonValidation", "semanticTokenScopes"];
  for (const section of aSections) {
    const r = await install({ [section]: section === "languages" ? [] : section === "grammars" ? [] : {} });
    check(`★ A 类 ${section} 不导致安装失败`, r.ok, { error: r.error });
    check(
      `★   ${section} 被标记为 declarative（不读）`,
      r.ok && (r.ignored ?? []).some((i) => i.section === section && i.kind === "declarative"),
      { ignored: r.ignored },
    );
  }
}

console.log("[3] B 类：接受，且**必须被标记**为「不做」");
{
  const bSections = ["menus", "submenus", "views", "keybindings"];
  for (const section of bSections) {
    const r = await install({ [section]: {} });
    check(`★ B 类 ${section} 不导致安装失败`, r.ok, { error: r.error });
    check(
      `★   ${section} 被标记为 runtime（不做）`,
      r.ok && (r.ignored ?? []).some((i) => i.section === section && i.kind === "runtime"),
      { ignored: r.ignored },
    );
  }
}

console.log("[4] A 与 B 的标记**不同**（措辞区分，不是同一个标签）");
{
  const r = await install({ configuration: {}, menus: {} });
  check("★ 两者都被标记", r.ok && (r.ignored ?? []).length === 2, { ignored: r.ignored });
  const kinds = new Set((r.ignored ?? []).map((i) => i.kind));
  check("★ 两种 kind 都出现（declarative 与 runtime 不同）", kinds.size === 2, { kinds: [...kinds] });
}

console.log("[5] 负控：C 类（完全不认识）仍拒绝，并点名");
{
  const r = await install({ madeUpSection: { x: 1 } });
  check("★ 未知贡献点被拒", !r.ok, { error: r.error });
  check("★ 错误信息点名它", !r.ok && /madeUpSection/.test(r.error ?? ""), {
    error: (r.error ?? "").slice(0, 240),
  });
  check(
    "★ 错误信息说清「本宿主认识哪些」（可行动）",
    !r.ok && /Known sections/.test(r.error ?? ""),
    { error: (r.error ?? "").slice(0, 240) },
  );
}

console.log("[6] 混合：A + B 都被标记，C 仍然拒");
{
  const ok = await install({ configuration: {}, menus: {}, languages: [] });
  check("★ A+B 混合能装", ok.ok, { error: ok.error });
  check("★ 三个都被标记", ok.ok && (ok.ignored ?? []).length === 3, { ignored: ok.ignored });

  const bad = await install({ configuration: {}, madeUpSection: {} });
  check("★ A + C 混合仍被拒（C 不让步）", !bad.ok, { error: bad.error });
}

console.log("[7] 真实扩展：rainbow-csv 的 9 个贡献点逐个有结论");
{
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let pkg: any = null;
  try { pkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 没装 */ }

  if (!pkg) {
    console.log("      （本机没有 rainbow-csv，跳过）");
  } else {
    const sections = Object.keys(pkg.contributes ?? {});
    console.log(`      rainbow-csv 的贡献点：${sections.join(", ")}`);
    // 用它真实的 contributes 造包（commands 也用它真实的）
    const real = {
      publisher: pkg.publisher, name: pkg.name, version: pkg.version,
      displayName: pkg.displayName, main: pkg.main,
      engines: pkg.engines, activationEvents: pkg.activationEvents,
      contributes: pkg.contributes,
    };
    const zip = buildZip([
      { name: "extension/package.json", data: enc.encode(JSON.stringify(real)) },
      { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
    ], 8);
    let error: string | undefined;
    let ignored: readonly { section: string; kind: string }[] = [];
    try {
      const bridge = await VscodeL1Bridge.install(host(), zip, {
        confirmReadAccess: true, confirmExecutableCode: true,
      });
      ignored = bridge.ignoredContributions;
    } catch (e) { error = String(e); }

    console.log(`      安装结果：${error ? "被拒 → " + error.replace(/\s+/g, " ").slice(0, 160) : "成功"}`);
    if (ignored.length > 0) {
      console.log(`      被标记的贡献点：${ignored.map((i) => `${i.section}(${i.kind})`).join(", ")}`);
    }

    // 它现在可能卡在**顶层未知字段**（F011 之后又前移了一格），
    // 但**不该再因贡献点被拒**。这两件事必须分开断言。
    check(
      "★ rainbow-csv 不再因**贡献点**被拒",
      !(error !== undefined && /does not recognise/.test(error)),
      { error: error?.slice(0, 200) },
    );
  }
}

console.log(`\nvsix-contributes-classes-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
