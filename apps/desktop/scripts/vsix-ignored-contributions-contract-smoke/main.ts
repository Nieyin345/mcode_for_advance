/**
 * 【F012】`ignoredContributions` 要能到达用户手里。
 *
 * ## 这张卡补的是什么
 *
 * F011 把「哪些贡献点不会生效」记在 `VscodeL1Bridge` 实例上，有断言、信息是真的 ——
 * **但到不了用户手里**：`ModuleChangeResult` 里没有这个字段，handler 也没带出去。
 *
 * 后果具体：用户装完一个扩展，界面上什么都没变，**他会去查是不是自己装错了、
 * 权限问题、版本不对**。告诉「menus 不实现、configuration 不读取」是唯一能让
 * 他停止自我怀疑的东西。
 *
 * ## 为什么加在 `ModuleInstallVsixResult` 而不是 `ModuleChangeResult`
 *
 * 后者是 `modules.install` 与 `modules.remove` **共用**的返回类型。
 * 往那里加字段，`remove` 也就承诺返回一个它永远不会有的列表 ——
 * VSIX 独有的信息进 VSIX 独有的类型。变异表第 3 条验这个。
 *
 * ## 为什么 `kind` 必须带出去
 *
 * `declarative`（我们不**读**）与 `runtime`（我们不**做**）对用户意味着不同的事：
 * 前者是「设置改了没用」，后者是「菜单项不会出现」。
 * 压成一个字符串会丢掉那个区分，而那是他判断「还要不要用」的依据。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();
const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {}, persist: async () => {}, requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm, persistModulePermissions: async (t) => { perm = t; },
  });
}

function zipOf(contributes: Record<string, unknown>): Uint8Array {
  const pkg = {
    publisher: "acme", name: "demo", version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" }, activationEvents: ["onCommand:demo.hello"],
    contributes: { commands: [{ command: "demo.hello", title: "Hello" }], ...contributes },
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

console.log("[1] 契约：ModuleInstallVsixResult 带上 ignoredContributions 与 kind");
{
  const mod = read("../../packages/contracts/src/ipc/modules.ts");
  check("★ 有 IgnoredVsixContribution 类型", /interface IgnoredVsixContribution/.test(mod));
  check("★ kind 是 declarative | runtime 两值", /kind:\s*"declarative"\s*\|\s*"runtime"/.test(mod));
  check("★ ModuleInstallVsixResult 含 ignoredContributions", /ignoredContributions:\s*IgnoredVsixContribution\[\]/.test(mod));
  // 负控：不能塞进共用的 ModuleChangeResult
  const shared = read("../../packages/contracts/src/modules.ts");
  const changeResult = /export interface ModuleChangeResult \{[\s\S]*?\n\}/.exec(shared)?.[0] ?? "";
  check("★ 没有把它塞进共用的 ModuleChangeResult（remove 不该承诺这个列表）",
    !/ignoredContributions/.test(changeResult), { changeResult });
}

console.log("[2] handler 把 bridge 的列表带出去了");
{
  const ipc = read("src/main/ipc/modules.ts");
  check("★ handler 里出现 ignoredContributions", /ignoredContributions/.test(ipc));
  check("★ 它取自 bridge.ignoredContributions", /bridge\.ignoredContributions/.test(ipc));
  // 关键：必须**原样**带出 kind，不在这一层合并
  check(
    "★ 没有在 handler 里压平 kind（不应出现只取 section 的 map）",
    !/ignoredContributions\s*:\s*\[\s*\.\.\.bridge\.ignoredContributions\s*\]\s*\.map\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.section\s*\)/.test(ipc),
    { hint: "压平会丢掉 declarative/runtime 的区分" },
  );
}

console.log("[3] 端到端：真正安装后，列表能读到，且 kind 正确");
{
  const bridge = await VscodeL1Bridge.install(host(), zipOf({ configuration: {}, menus: {} }), {
    confirmReadAccess: true, confirmExecutableCode: true,
  });
  const list = bridge.ignoredContributions;
  check("★ 安装后能读到两个被忽略的贡献点", list.length === 2, { list });
  const cfg = list.find((c) => c.section === "configuration");
  const menus = list.find((c) => c.section === "menus");
  check("★ configuration 是 declarative（不读）", cfg?.kind === "declarative", { cfg });
  check("★ menus 是 runtime（不做）", menus?.kind === "runtime", { menus });
  // 变异第 2 条：如果 kind 全填 declarative，上面那条会红
}

console.log("[4] 只装了 commands 时，列表为空（不是永远有一段噪音）");
{
  const bridge = await VscodeL1Bridge.install(host(), zipOf({}), {
    confirmReadAccess: true, confirmExecutableCode: true,
  });
  check("★ 只有 commands 时 ignoredContributions 为空", bridge.ignoredContributions.length === 0, {
    list: bridge.ignoredContributions,
  });
}

console.log("[5] UI 两类文案分开（不合并成一句）");
{
  const zh = read("src/renderer/lib/i18n/zh/ide.ts");
  const en = read("src/renderer/lib/i18n/en/ide.ts");
  check("★ zh 有「不读取」文案", /vsixIgnoredDeclarative["']:\s*"[^"]*不读取/.test(zh));
  check("★ zh 有「不实现」文案", /vsixIgnoredRuntime["']:\s*"[^"]*不实现/.test(zh));
  check("★ en 有对应两条", /vsixIgnoredDeclarative/.test(en) && /vsixIgnoredRuntime/.test(en));

  // 两条文案必须不同 —— 合并成一句后用户就分不出「不读」与「不做」
  const zhDecl = /vsixIgnoredDeclarative["']:\s*"([^"]*)"/.exec(zh)?.[1];
  const zhRt = /vsixIgnoredRuntime["']:\s*"([^"]*)"/.exec(zh)?.[1];
  check("★ zh 两条文案不同（否则分类白做）", zhDecl !== undefined && zhRt !== undefined && zhDecl !== zhRt, {
    zhDecl, zhRt,
  });

  // 不能把内部术语直接给用户
  check("★ 用户文案里没有裸的 declarative/runtime 术语",
    !/declarative/i.test(zhDecl ?? "") && !/runtime/i.test(zhRt ?? ""),
    { zhDecl, zhRt });
}

console.log("[6] UI 真的把它们分别显示出来");
{
  const ui = read("src/renderer/components/modules/VsixInstallSection.tsx");
  check("★ 按 kind 分了 declarative / runtime 两路", /kind\s*===\s*"declarative"/.test(ui) && /kind\s*===\s*"runtime"/.test(ui));
  check("★ 两条 toast 各用各的文案 key",
    /vsixIgnoredDeclarative/.test(ui) && /vsixIgnoredRuntime/.test(ui));
  // 负控：不能只显示一条
  const pushes = (ui.match(/useToastStore\.getState\(\)\.push/g) ?? []).length;
  check("★ 至少三次 push（安装成功 + 两类各一次）", pushes >= 3, { pushes });
}

console.log("[7] 负控：modules.remove 不受影响（它仍返回 ModuleChangeResult）");
{
  const rpc = read("../../packages/contracts/src/ipc/rpcMap.ts");
  const removeLine = /"modules\.remove":[^\n]*/.exec(rpc)?.[0] ?? "";
  check("★ modules.remove 仍返回 ModuleChangeResult", /ModuleChangeResult/.test(removeLine), { removeLine });
  check(
    "★ 它没有被改成返回 ModuleInstallVsixResult",
    !/ModuleInstallVsixResult/.test(removeLine), { removeLine },
  );
}

console.log(`\nvsix-ignored-contributions-contract-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
