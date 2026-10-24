/**
 * 【F004】VSIX 清单层：从「只收 1 条命令」到能收下真实扩展的清单。
 *
 * ## 这套的四个关注点
 *
 * 1. **`contributes.commands` 收得下多条**（`z.tuple` → `z.array`），但有上限；
 * 2. **旧清单仍然能过**（正控：不能为了多命令弄坏单命令）；
 * 3. **不支持的东西显式拒绝并点名**，不静默丢弃、不假装支持；
 * 4. **`activationEvents` 能声明多条，但运行时只认 `onCommand:第一条`** ——
 *    这条是「清单能过 ≠ 功能支持」的机器表达。
 *
 * ## 为什么不直接测「rainbow-csv 能装」
 *
 * 它能过 schema，但**装不进 ModuleHost**：`main` 必须是 `./extension.js`，
 * 而 rainbow-csv 是 `./extension`（VS Code 会补 `.js`，我们不补）。那是另一件事。
 * 所以这里测的是 **schema 层**：`packageSchema.safeParse` 的结果，不是 `install`。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// 【F004】schema 没有单独导出，但它决定的行为可以从 `install` 的拒绝理由反推。
// 这里走 `install` —— 因为「schema 过了但 install 还拒」正是本卡要暴露的边界。
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

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {},
    persist: async () => {},
    requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm,
    persistModulePermissions: async (t) => { perm = t; },
  });
}

/** 造一个最小合法的包，`main` 用 VS Code 会补 `.js` 的形式取决于 `mainField`。 */
function archive(manifest: Record<string, unknown>, mainField = "./extension.js"): Uint8Array {
  const pkg = enc.encode(JSON.stringify({ main: mainField, ...manifest }));
  return buildZip([
    { name: "extension/package.json", data: pkg },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

async function tryInstall(manifest: Record<string, unknown>, mainField?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await VscodeL1Bridge.install(host(), archive(manifest, mainField), {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const BASE = {
  publisher: "acme",
  name: "demo",
  version: "1.0.0",
  engines: { vscode: "^1.80.0" },
};

const cmd = (id: string, title = id) => ({ command: `acme.demo.${id}`, title });
const onCmd = (id: string) => `onCommand:acme.demo.${id}`;

console.log("[1] 正控：单命令的旧清单仍然能过");
{
  const r = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("hello")],
    contributes: { commands: [cmd("hello", "Hello")] },
  });
  check("★ 单命令清单安装成功", r.ok, { error: r.error });
}

console.log("[2] 多命令（本卡的核心：z.tuple → z.array）");
{
  const many = Array.from({ length: 24 }, (_, i) => cmd(`c${i}`, `Command ${i}`));
  const r = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("c0")],
    contributes: { commands: many },
  });
  check("★ 24 条命令的清单安装成功（旧实现 z.tuple 只收 1 条）", r.ok, { error: r.error });
}

console.log("[3] 负控：commands 为空 / 超上限");
{
  const empty = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("hello")],
    contributes: { commands: [] },
  });
  check("★ 空 commands 被拒（0 条命令的扩展无效）", !empty.ok, { error: empty.error });
  // ⚠️ **不能只验「被拒了」**。去掉 `.min(1)` 之后空数组仍然会被拒 ——
  // 但拒它的是 `pkg.contributes.commands[0]!.command` 的 **TypeError**
  // （`Cannot read properties of undefined`），不是 schema 的校验。
  // 那是崩溃，不是「说清原因的拒绝」。变异 M2 第一版就是因此显示 0 条红。
  // 所以这里要求错误信息**点名是 commands**，并且不是 TypeError。
  check(
    "★ 拒绝理由是「commands 不能为空」而不是崩溃（不是 TypeError）",
    !empty.ok &&
      !/TypeError|Cannot read properties/.test(empty.error ?? "") &&
      /commands/i.test(empty.error ?? ""),
    { error: (empty.error ?? "").slice(0, 200) },
  );

  // 【F015】上限从 64 提到 256 —— 实测 3 个真实扩展超过 64
  // （azurefunctions 74、containers 101、remote-containers 71），全被拒。
  // 256 的依据是「本机实测最大 101 + 余量」，**不是生态上限**（没有扫过市场）。
  // 所以这里验的是 257（新上限 +1），不是 65。
  const tooMany = Array.from({ length: 257 }, (_, i) => cmd(`x${i}`));
  const over = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("x0")],
    contributes: { commands: tooMany },
  });
  check("★ 257 条命令被拒（上限 256）", !over.ok, { error: over.error });
  check(
    "★ 拒绝信息点名上限 256（不是笼统 invalid）",
    !over.ok && /256/.test(over.error ?? ""),
    { error: over.error },
  );
}

console.log("[4] 贡献点分类：A/B 接受，C 拒绝（【F011】改了语义）");
{
  // 【F011】这三条断言原来验「menus/keybindings 被拒」—— **那个行为已经变了**。
  // 现在 menus/keybindings 是 **B 类**（接受但标记「不做」），
  // 因为 rainbow-csv 有 menus，拒它等于让真实扩展装不进。
  // 新的判据在 `vsix-contributes-classes-smoke`，这里只留「C 类仍拒」的负控。
  const r = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("hello")],
    contributes: {
      commands: [cmd("hello")],
      // C 类：本宿主完全不认识的贡献点
      madeUpSection: { whatever: true },
    },
  });
  check("★ 本宿主不认识的贡献点被拒（C 类负控）", !r.ok, { error: r.error });
  check(
    "★ 拒绝信息点名是 madeUpSection",
    !r.ok && /madeUpSection/.test(r.error ?? ""),
    { error: (r.error ?? "").slice(0, 240) },
  );

  // A/B 类不再被拒 —— 这是本卡的语义变更，单独断言
  const accepted = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("hello")],
    contributes: {
      commands: [cmd("hello")],
      menus: { "editor/context": [{ command: "demo.hello" }] },   // B 类
      configuration: { title: "x", properties: {} },              // A 类
    },
  });
  check("★ A/B 类贡献点不再导致安装失败（F011 的语义变更）", accepted.ok, {
    error: accepted.error,
  });
}

console.log("[5] activationEvents：能声明多条，但运行时只认 onCommand:第一条");
{
  // 5a: rainbow-csv 那样 11 条（含 onLanguage:*）—— schema 应接受
  const real = await tryInstall({
    ...BASE,
    activationEvents: [
      "onLanguage:csv", "onLanguage:tsv", "onLanguage:plaintext",
      onCmd("c0"), "onCommand:acme.demo.c1",
    ],
    contributes: { commands: [cmd("c0"), cmd("c1")] },
  });
  check("★ 混合事件（含 onLanguage）的清单能过 —— 只代表「装得进来」", real.ok, { error: real.error });

  // 5b: 一条 onCommand 都没有 → 合法（15 个真实扩展如此，它们靠 onLanguage: 激活）。
  const noOnCommand = await tryInstall({
    ...BASE,
    activationEvents: ["onLanguage:csv", "workspaceContains:**/*.csv"],
    contributes: { commands: [cmd("c0")] },
  });
  check("★ 没有 onCommand 的清单能过（15 个真实扩展如此）", noOnCommand.ok, {
    error: noOnCommand.error,
  });

  // 5c: 【F014 结论】**有 onCommand 却都不是第一条 → 也装得进来**。
  //
  // 上一版这里断言「仍然拒」。改成接受的理由是三层证据：
  //   1. 运行时**从不读** `activationEvents`（全仓唯一消费者是那条校验本身）；
  //   2. 本机 10 个有 onCommand 的真实扩展，**10 个都不含第一条命令** ——
  //      拒绝它们等于拒绝所有真实输入；
  //   3. 拒绝的时机挪到**调用时**更有用：`executeCommand` 会点名「这条不激活」+「哪条能跑」。
  //
  // 这是本卡「障碍前移」叙事的终点：从「装不进」变成「装进来 + 用到时才说」。
  const mismatched = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("c1"), onCmd("c2")],
    contributes: { commands: [cmd("c0"), cmd("c1"), cmd("c2")] },
  });
  check("★ onCommand 都不是第一条时**也能装**（F014 撤掉校验）", mismatched.ok, {
    error: mismatched.error,
  });
}

console.log("[6] 负控：顶层与 engines 的 strict 保留（分类处理，不一刀切）");
{
  const topUnknown = await tryInstall({
    ...BASE,
    activationEvents: [onCmd("hello")],
    contributes: { commands: [cmd("hello")] },
    someTopLevelField: true,
  });
  check("★ 顶层未知字段仍被拒（strict 保留）", !topUnknown.ok, { error: topUnknown.error });

  const engineUnknown = await tryInstall({
    ...BASE,
    engines: { vscode: "^1.80.0", node: ">=18" },
    activationEvents: [onCmd("hello")],
    contributes: { commands: [cmd("hello")] },
  });
  check("★ engines 里多声明 node 仍被拒（不静默忽略）", !engineUnknown.ok, { error: engineUnknown.error });
}

console.log("[7] 真实扩展的清单：schema 层能过，install 层卡在 main 路径");
{
  // 这是本卡最重要的**边界声明**，不是缺陷。
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let realPkg: any = null;
  try { realPkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 机器上没这个扩展 */ }

  if (!realPkg) {
    console.log("      （本机没有 rainbow-csv，跳过这一组）");
  } else {
    const r = await tryInstall(realPkg, realPkg.main);
    // 它会被拒 —— 但**不是因为 commands**（24 条现在收得下了）。
    //
    // ⚠️ 不能用 `/commands/.test(error)` 判断 —— zod 的报错里会回显**整个 schema 的**
    // 字段路径。改成解析 issue 的 `path`。
    let commandIssues = 0;
    try {
      const issues = JSON.parse((r.error ?? "").replace(/^Error:\s*/, "")) as { path?: unknown[] }[];
      commandIssues = issues.filter((i) => Array.isArray(i.path) && i.path.join(".").includes("commands")).length;
    } catch { /* 不是 JSON，保持 0 */ }

    check("★ rainbow-csv 的清单**没有一条 issue 指向 commands**（24 条收下了）", commandIssues === 0, {
      commandIssues, error: (r.error ?? "").slice(0, 120),
    });

    // 【F009】原断言「有一条 issue 指向 main」；【F011】改成「卡在贡献点」；
    // 【F014】又前移两次 —— 先到 activationEvents（当时还拒），现在**清单层全通**。
    //
    // ⚠️ 这里测的是 `tryInstall(realPkg, realPkg.main)` —— `realPkg.main` 是
    // `./dist/extension.js`，**本机那个文件不存在**（rainbow-csv 的 vsix 里才有）。
    // 所以它现在卡在**读不到 main 入口**，不是清单的问题。
    //
    // **这条断言已经改过四次**（main → 贡献点 → 顶层字段 → activationEvents → 入口读取）。
    // 它记的是「当前挡在最前面的是哪一道」，**不是**「清单层有什么缺陷」。
    const errNow = (r.error ?? "").replace(/\s+/g, " ");
    const manifestLayerClean = !/top-level field|activationEvents|contributes section|Unrecognized|unrecognised/i.test(errNow);
    check(
      "★ 清单层已全部通过（main/贡献点/顶层字段/activationEvents 都不再拒）—— 障碍第 5 次前移",
      manifestLayerClean,
      { error: errNow.slice(0, 240) },
    );
    console.log(`      实际拒绝理由（前 240 字符）：${errNow.slice(0, 240)}`);
  }
}

console.log(`\nvsix-manifest-schema-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
