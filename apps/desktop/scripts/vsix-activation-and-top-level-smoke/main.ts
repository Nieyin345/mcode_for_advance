/**
 * 【F014】顶层字段分类 + activationEvents 对齐真实运行时。
 *
 * ## 顶层字段：不是枚举那 11 个
 *
 * 实测 29 个扩展，schema 之外共有 **25 个不同的顶层字段**，rainbow-csv 只占 11 个。
 * 只放行那 11 个，下一个扩展照样装不进。所以按**「会不会改变行为」**分类：
 *
 * | 类 | 例 | 处理 |
 * |---|---|---|
 * | 元数据 | `description` `license` `scripts` `repository` | 接受，无副作用 |
 * | 影响行为 | `browser` `capabilities` `extensionKind` `enabledApiProposals` | 接受**但标记** |
 * | 未知 | 其余 | 拒绝并点名 |
 *
 * ## 两个要判断的字段
 *
 * **`browser`**：VS Code 的 **web 版入口**，与 `main` 并列。我们不跑 web 版 ——
 * 静默接受会让用户以为「浏览器里也能用」。**必须标记。**
 *
 * **`capabilities`**：**不是元数据，是信任声明**（`untrustedWorkspaces` /
 * `virtualWorkspaces`）。扩展用它**主动在不受信任的工作区里关掉自己**。
 * 本宿主的沙箱模型是「一次授权一个资源」，**不是** VS Code 的工作区信任 ——
 * 所以这些自我保护**不会生效**。**不假装尊重它，但必须让用户知道。**
 *
 * ## activationEvents：**整个撤掉校验，改成标记**
 *
 * 决定性的事实：**运行时根本不读这个字段**。全仓（`src/` + `packages/`）
 * `activationEvents` 的消费者只有那条校验自己。本宿主的激活路径是
 * 「有人调 `executeCommand` → 跑 `activate()`」，一律在调用时发生。
 *
 * 而任何「对齐」规则都在拒真实扩展：本机 27 个有 commands 的扩展里，
 * 15 个没有 `onCommand:`，10 个有但**10 个都不含第一条命令**。
 * 方案 A（至少一条指向已声明命令）仍拒 9/10，方案 B（必须含第一条）拒 10/10。
 * **一条让 100% 真实输入失败的规则，挡不住坏扩展。**
 *
 * 所以：接受 + 进 `ignoredContributions`（`top-level:activationEvents`），
 * 拒绝的时机挪到**调用时**（`executeCommand` 点名「哪条能跑」）。
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

/** 造包：`extra` 是顶层的额外字段，`activation` 覆盖激活列表。 */
function zipOf(extra: Record<string, unknown> = {}, activation?: string[], name = "demo"): Uint8Array {
  const pkg = {
    publisher: "acme", name, version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: activation ?? [`onCommand:${name}.hello`],
    contributes: { commands: [{ command: `${name}.hello`, title: "Hello" }] },
    ...extra,
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

async function install(zip: Uint8Array): Promise<{
  ok: boolean; error?: string; ignored?: readonly { section: string; kind: string }[];
}> {
  try {
    const b = await VscodeL1Bridge.install(host(), zip, {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    return { ok: true, ignored: b.ignoredContributions };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

console.log("[1] 元数据字段：接受，且**不产生噪音标记**");
{
  const metadata = {
    description: "x", license: "MIT", icon: "icon.png", keywords: ["a"],
    categories: ["Other"], repository: { type: "git", url: "https://x" },
    scripts: { build: "tsc" }, devDependencies: { typescript: "^5" },
    __metadata: { id: "abc" }, galleryBanner: { color: "#fff" },
    preview: true, private: true, author: "someone", homepage: "https://x",
    bugs: { url: "https://x" },
  };
  const r = await install(zipOf(metadata));
  check("★ 全元数据的清单能装（旧的表现：全拒）", r.ok, { error: r.error });
  // 元数据不该进 ignoredContributions —— 它本来就没有「生效」这回事
  check("★ 元数据不产生 ignored 标记（不是「不实现」，是「不需要实现」）",
    (r.ignored ?? []).every((i) => !(`${i.section}` in metadata)), { ignored: r.ignored });
}

console.log("[2] `browser`：接受，但**必须标记为不实现**");
{
  // rainbow-csv 真实用的形态
  const r = await install(zipOf({ browser: "./dist/web/extension.js" }));
  check("★ 含 browser 的清单能装", r.ok, { error: r.error });
  check("★ browser 被标记（用户要知道 web 版不支持）",
    (r.ignored ?? []).some((i) => i.section === "top-level:browser" && i.kind === "runtime"),
    { ignored: r.ignored });
}

console.log("[3] `capabilities`：接受，但**必须标记**（它不是元数据，是信任声明）");
{
  // 真实形态：untrustedWorkspaces 声明
  const caps = { untrustedWorkspaces: { supported: false, description: "not available" } };
  const r = await install(zipOf({ capabilities: caps }));
  check("★ 含 capabilities 的清单能装", r.ok, { error: r.error });
  check("★ capabilities 被标记（它的自我保护在本宿主不生效）",
    (r.ignored ?? []).some((i) => i.section === "top-level:capabilities" && i.kind === "runtime"),
    { ignored: r.ignored });
  // 并且不能把它当成普通元数据混进去
  check("★ 它没有和元数据混在一起（是独立标记）",
    (r.ignored ?? []).filter((i) => i.section === "top-level:capabilities").length === 1,
    { ignored: r.ignored });
}

console.log("[4] 其他影响行为的顶层字段也标记");
{
  for (const field of ["extensionKind", "enabledApiProposals"]) {
    const r = await install(zipOf({ [field]: field === "extensionKind" ? ["workspace"] : ["x"] }));
    check(`★ ${field} 能装`, r.ok, { error: r.error });
    check(`★   ${field} 被标记`, (r.ignored ?? []).some((i) => i.section === `top-level:${field}`), {
      ignored: r.ignored,
    });
  }
}

console.log("[5] 负控：**不认识的**顶层字段仍然拒绝并点名");
{
  const r = await install(zipOf({ someUnknownTopLevelField: { x: 1 } }));
  check("★ 未知顶层字段被拒", !r.ok, { error: r.error });
  check("★ 错误信息点名它", !r.ok && /someUnknownTopLevelField/.test(r.error ?? ""), {
    error: (r.error ?? "").slice(0, 240),
  });
  check("★ 错误信息说清「元数据接受、行为类标记」的策略（可行动）",
    !r.ok && /Metadata fields are accepted/.test(r.error ?? ""),
    { error: (r.error ?? "").slice(0, 240) },
  );
}

console.log("[6] activationEvents：接受 + 标记，**不再拒绝**（F014 结论）");
{
  // 6a: 一条 onCommand 都没有 → 合法（15 个真实扩展如此）
  const noOn = await install(zipOf({}, ["onLanguage:csv", "workspaceContains:**/*.csv"]));
  check("★ 没有 onCommand 的清单能装", noOn.ok, { error: noOn.error });
  check("★ 且被标记（用户要知道这些激活条件不生效）",
    (noOn.ignored ?? []).some((i) => i.section === "top-level:activationEvents" && i.kind === "runtime"),
    { ignored: noOn.ignored });

  // 6b: onCommand 恰好就是第一条 → 本宿主**完全满足**，不该有标记
  const good = await install(zipOf({}, ["onCommand:demo.hello"]));
  check("★ onCommand 含第一条时能装", good.ok, { error: good.error });
  check("★ 负控：完全满足的声明**不标记**（假警告会让用户学会忽略所有警告）",
    !(good.ignored ?? []).some((i) => i.section === "top-level:activationEvents"),
    { ignored: good.ignored });

  // 6c: ★ 核心 —— onCommand **都不含第一条**也必须能装。
  // 这是 10/10 真实扩展的形态（rainbow-csv / latex-workshop / python …）。
  // 旧行为：拒绝。新行为：装进来，靠 executeCommand 在**调用时**说清。
  const mismatched = await install(zipOf({}, ["onCommand:demo.other"]));
  check("★ onCommand 都不含第一条时**也能装**（10/10 真实扩展如此）", mismatched.ok, {
    error: mismatched.error,
  });
  check("★ 但它被标记为「激活条件不生效」",
    (mismatched.ignored ?? []).some((i) => i.section === "top-level:activationEvents"),
    { ignored: mismatched.ignored });

  // 6c-2: 非 onCommand 的事件（onLanguage: 等）本宿主一个触发源都没有 → 必须标记
  const langOnly = await install(zipOf({}, ["onLanguage:csv"]));
  check("★ 只有 onLanguage: 的清单能装", langOnly.ok, { error: langOnly.error });
  check("★ 且被标记（本宿主没有语言监听这条触发源）",
    (langOnly.ignored ?? []).some((i) => i.section === "top-level:activationEvents"),
    { ignored: langOnly.ignored });

  // 6d: 省略 activationEvents → 合法，且**不产生标记**（没有声明，就没有东西被忽略）
  const omitted = await install(zipOf({}, undefined));
  check("★ 省略 activationEvents 时能装", omitted.ok, { error: omitted.error });

  // 6e: 空数组 [] → 合法（2 个真实扩展如此：azurecontainerapps 53 条命令）
  const emptyArr = await install(zipOf({ activationEvents: [] }));
  check("★ activationEvents: [] 能装（旧 .min(1) 拒掉 2 个真实扩展）", emptyArr.ok, {
    error: emptyArr.error,
  });
  check("★ 但空数组**不产生**标记（没有东西被忽略）",
    !(emptyArr.ignored ?? []).some((i) => i.section === "top-level:activationEvents"),
    { ignored: emptyArr.ignored });

  // 6f: 超上限仍然拒（上限本身没撤，只是不再要求非空）
  const tooMany = await install(zipOf({}, Array.from({ length: 65 }, (_, i) => `onLanguage:x${i}`)));
  check("★ 65 条激活事件仍被拒（上限 64 保留）", !tooMany.ok, { error: tooMany.error });
  check("★ 拒绝信息点名 64", !tooMany.ok && /64/.test(tooMany.error ?? ""), {
    error: (tooMany.error ?? "").slice(0, 200),
  });
}

console.log("[7] extensionPack / extensionDependencies：接受但**必须标记**");
{
  for (const field of ["extensionPack", "extensionDependencies"]) {
    const value = field === "extensionPack"
      ? ["publisher.a", "publisher.b"]
      : ["publisher.dep"];
    const r = await install(zipOf({ [field]: value }));
    check(`★ ${field} 能装`, r.ok, { error: r.error });
    check(`★   ${field} 被标记为 runtime（本宿主不装依赖，扩展可能因此崩）`,
      (r.ignored ?? []).some((i) => i.section === `top-level:${field}` && i.kind === "runtime"),
      { ignored: r.ignored });
  }
  // 负控：它们**不能**被当成元数据静默放行 —— 第一版就是把它们放进了元数据表。
  const r = await install(zipOf({ extensionDependencies: ["x.dep"] }));
  check("★ 负控：extensionDependencies 没有出现在元数据组（它影响行为）",
    (r.ignored ?? []).length > 0 && (r.ignored ?? []).some((i) => i.section.startsWith("top-level:")),
    { ignored: r.ignored });
}

console.log("[8] 真实扩展：rainbow-csv 现在能装进来了吗？");
{
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let pkg: any = null;
  try { pkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 没装 */ }
  if (!pkg) {
    console.log("      （本机没有 rainbow-csv，跳过）");
  } else {
    const zip = buildZip([
      { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
      { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
    ], 8);
    const r = await install(zip);
    const err = r.error ?? "";
    check("★ 不再因为 activationEvents 被拒", !/activationEvents|onCommand/i.test(err), {
      error: err.slice(0, 240),
    });
    check("★ 不再因为顶层字段被拒", !/top-level field/i.test(err), { error: err.slice(0, 240) });
    // ★ 核心：清单层已全部通过，**它装进来了**。
    check("★ rainbow-csv 的清单整份通过、安装成功", r.ok, { error: err.slice(0, 300) });

    // 用户会收到的「哪些部分不工作」—— 这是 F011 的载体，必须真的说得出来。
    const sections = (r.ignored ?? []).map((i) => i.section).sort();
    check("★ 它的 8 个不生效部分都被标记（不是静默接受）", sections.length >= 8, { sections });
    check("★   commands 不在标记里（那个是支持的）", !sections.includes("commands"), { sections });
    check("★   声明类的 7 个在（colors/configuration/languages/…）",
      ["colors", "configuration", "configurationDefaults", "grammars", "languages",
        "semanticTokenScopes"].every((s) => sections.includes(s)), { sections });
    check("★   需运行时的 2 个在（menus/submenus —— 用户会发现菜单项没了）",
      sections.includes("menus") && sections.includes("submenus"), { sections });
    check("★   行为类顶层字段在（browser + capabilities）",
      sections.includes("top-level:browser") && sections.includes("top-level:capabilities"), { sections });
    check("★   激活条件也被标记（它的 onLanguage:/onCommand: 我们不实现）",
      sections.includes("top-level:activationEvents"), { sections });

    // 但**真实源码**仍会撞 24 KiB —— 那是 F002 的限额，不是本卡能动的。
    const realSource = readFileSync(join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/extension.js"));
    const realZip = buildZip([
      { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
      { name: "extension/extension.js", data: realSource },
    ], 8);
    const real = await install(realZip);
    check("★ 但**真实源码**（" + realSource.byteLength + " B）仍撞 24 KiB —— 最后一道墙",
      !real.ok && /24576|24 KiB|source limit/i.test(real.error ?? ""),
      { error: (real.error ?? "").slice(0, 200) });
    console.log(`      它的顶层额外字段：${Object.keys(pkg).filter((k) =>
      !["publisher","name","version","displayName","main","engines","activationEvents","contributes"].includes(k)).join(", ")}`);
  }
}

console.log(`\nvsix-activation-and-top-level-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
