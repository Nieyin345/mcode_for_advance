/**
 * 【F015】多命令：哪些能注册、哪些能列出来、哪些能真的被调到。
 *
 * ## 三层，必须分开说
 *
 * | 层 | 含义 | 本卡做到吗 |
 * |---|---|---|
 * | **L1 注册** | 扩展 `activate()` 里 `registerCommand` 任意**已声明**命令 | **做到了** |
 * | **L2 分派** | `executeCommand(cmd)` 能选中对应命令 | **没做到**，见下 |
 * | **L3 端到端** | 子进程跑那条命令的 handler | **没做到** |
 *
 * ## 为什么 L2 做不到（这条必须写清楚，不许用"假通"盖住）
 *
 * 「要调哪条命令」这个信息**传不进子进程**。唯一能带信息的通路是 `resource`，
 * 而 `resource.path` 正是 `authorize()` 判定授权的依据 —— 往里塞命令 id
 * 会让授权检查针对一个**假路径**，那是安全边界，不能绕。
 *
 * 契约里的 `ModuleInvokeSchema` 是 `.strict()`，加字段要改 `packages/contracts/**`，
 * 不在本卡边界。
 *
 * **所以 L1 的诚实形态是**：能注册，但**调用时只有第一条真能跑**，
 * 而且这个限制**对用户可见**（`ignoredContributions` + `executeCommand` 的文案）。
 *
 * ## 命令 title 进清单：只有一半能进
 *
 * `slot: "command"` 的 `command` 字段正则是契约里本来就有的：
 *   /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$/
 *
 * 实测本机 884 条真实命令，**439 条（49.7%）**能过；418 条卡在首段连字符
 * （`latex-workshop.hostPort` 这类）。过不了的**如实不列**，不截断不哈希。
 */
import { VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import { ModuleManifestSchema } from "@contracts/modules.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.js";

// 这台 Windows 机器没有可验证的 OS 网络沙箱，默认拒绝跑任何可执行扩展
// （`egress_isolation_unavailable`）。套件要真的把扩展跑起来，必须走**既有的**
// 「仅 JS 网络守卫」降级开关 —— 和 `extension-authoring-smoke` / `extension-workshop-smoke`
// 等既有套件完全一样，不是本套件新开的口子。
configureJsOnlyEgressConsentReader(() => true);

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

/** 造包：给一组命令 id（+title），激活事件默认只声明第一条。 */
function zipOf(commands: string[], opts: { titles?: string[]; engineSource?: string } = {}): Uint8Array {
  const pkg = {
    publisher: "acme", name: "demo", version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: commands.slice(0, 8).map((c) => "onCommand:" + c),
    contributes: {
      commands: commands.map((c, i) => ({ command: c, title: opts.titles?.[i] ?? ("Title " + i) })),
    },
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode(opts.engineSource ?? "exports.activate=()=>{};") },
  ], 8);
}

/** 跑一次真实调用，拿回结果（子进程真的跑）。 */
async function invoke(zip: Uint8Array): Promise<{ ok: boolean; error?: string; value?: Record<string, unknown> }> {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  let temp: string | null = null;
  try {
    const h = host();
    const bridge = await VscodeL1Bridge.install(h, zip, {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    temp = join(homedir(), ".mcode-f015-fixture.txt");
    writeFileSync(temp, "x");
    const reply = await bridge.executeCommand(bridge.commandId, { projectPath: homedir(), path: temp }, "r1");
    if (reply.type !== "result") return { ok: false, error: "unexpected task reply" };
    return { ok: true, value: reply.value as unknown as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    if (temp !== null) { try { unlinkSync(temp); } catch { /* 清理失败不影响断言 */ } }
  }
}

console.log("[1] L1：清单内的命令都能注册（旧行为：只有第一条能注册）");
{
  // 扩展的 activate() 里注册**第二条**命令 —— 从前这里直接抛
  // "Undeclared or duplicate VS Code command"。
  const src = `
    const vscode = require("vscode");
    exports.activate = () => {
      vscode.commands.registerCommand("demo.second", () => "from-second");
      vscode.commands.registerCommand("demo.first", () => "from-first");
    };`;
  const r = await invoke(zipOf(["demo.first", "demo.second"], { engineSource: src }));
  check("★ 注册第二条已声明命令不报错（旧行为：Undeclared）", r.ok, { error: (r.error ?? "").slice(0, 300) });
  check("★ 结果是第一条的 handler 跑的（L2 没做，如实反映）",
    r.ok && r.value?.message === "from-first", { message: r.value?.message });
  check("★ 两条都登记上了（可观察，不是「注册成功但没人知道」）",
    r.ok && r.value?.registeredCount === 2, {
      registeredCount: r.value?.registeredCount, registered: r.value?.registeredCommands,
    });
}

console.log("[2] 负控：**清单外**的命令仍然被拒（白名单没被拆掉）");
{
  const src = `
    const vscode = require("vscode");
    exports.activate = () => {
      vscode.commands.registerCommand("demo.notDeclared", () => "nope");
    };`;
  const r = await invoke(zipOf(["demo.first"], { engineSource: src }));
  check("★ 注册未声明的命令被拒", !r.ok, { error: (r.error ?? "").slice(0, 300) });
  check("★ 错误说清「没声明」（不是笼统 undeclared or duplicate）",
    !r.ok && /not declared/.test(r.error ?? ""), { error: (r.error ?? "").slice(0, 300) });
  check("★ 错误点名那个 id", !r.ok && /demo\.notDeclared/.test(r.error ?? ""), {
    error: (r.error ?? "").slice(0, 300),
  });
}

console.log("[3] 三种情形必须能分开（可诊断性）");
{
  // 3a: 已声明、能跑
  const src1 = `exports.activate=()=>{require("vscode").commands.registerCommand("demo.first",()=>"ok");};`;
  const a = await invoke(zipOf(["demo.first"], { engineSource: src1 }));
  check("★ 已声明且是第一条 → 能跑", a.ok && a.value?.message === "ok", { error: (a.error ?? "").slice(0, 200) });

  // 3b: 已声明、能注册、但**不能调用**（L2 的边界）——错误必须说清这一点
  const b = await (async () => {
    const h = host();
    const bridge = await VscodeL1Bridge.install(h, zipOf(["demo.first", "demo.second"]), {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    try {
      await bridge.executeCommand("demo.second", { projectPath: homedir(), path: join(homedir(), "x") }, "r");
      return { ok: true, error: "" };
    } catch (e) { return { ok: false, error: String(e) }; }
  })();
  check("★ 已声明但不是第一条 → 拒", !b.ok);
  check("★ 拒绝说清「已声明，但本宿主只跑第一条」而不是「没声明」",
    !b.ok && /is declared, but/.test(b.error) && !/not declared in/.test(b.error),
    { error: b.error.slice(0, 300) });
  check("★ 且点名能跑的那一条", !b.ok && /demo\.first/.test(b.error), { error: b.error.slice(0, 300) });

  // 3c: 根本没声明
  const c = await (async () => {
    const h = host();
    const bridge = await VscodeL1Bridge.install(h, zipOf(["demo.first"]), {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    try {
      await bridge.executeCommand("demo.ghost", { projectPath: homedir(), path: join(homedir(), "x") }, "r");
      return { ok: true, error: "" };
    } catch (e) { return { ok: false, error: String(e) }; }
  })();
  check("★ 完全没声明的命令 → 拒", !c.ok);
  check("★ 拒绝说清「不在这个扩展的 contributes.commands 里」",
    !c.ok && /not activated in this host|not declared|is not activated/.test(c.error), {
      error: c.error.slice(0, 300),
    });
}

console.log("[4] 每条命令的 title 进清单（能过正则的那些）");
{
  const h = host();
  const cmds = ["demo.alpha", "demo.beta", "demo.gamma"];
  const bridge = await VscodeL1Bridge.install(h, zipOf(cmds, { titles: ["Alpha", "Beta", "Gamma"] }), {
    confirmReadAccess: true, confirmExecutableCode: true,
  });
  const mod = h.catalog().modules.find((m) => m.id === bridge.moduleId)!;
  // 每个清单都要能过契约 —— 这是"没改契约"的机器证据。
  check("★ 生成的 manifest 能过 ModuleManifestSchema",
    ModuleManifestSchema.safeParse(mod).success, { issue: ModuleManifestSchema.safeParse(mod).error?.issues?.[0] });

  const titles = mod.contributions.map((c) => c.title.en);
  // `zipOf` 的 `titles` 选项决定 package.json 里每条命令的 title，这里就是
  // ["Alpha","Beta","Gamma"]。第 1 条由 `run` 贡献承载，第 2、3 条走 slot:command。
  check("★ 三条命令的 title 都在清单里（不是只有第一条）",
    ["Alpha", "Beta", "Gamma"].every((t) => titles.includes(t)), { titles });
  const commandSlots = mod.contributions.filter((c) => c.slot === "command");
  // 三条命令里，第 1 条由 run 承载，所以 slot:command 应该是 **2** 条（第 2、3 条）。
  check("★ 后两条走 slot:command（契约里本来就有的变体），第一条由 run 承载",
    commandSlots.length === 2, { slots: mod.contributions.map((c) => c.slot) });

  // ★ 正向落空断言：过不了正则的命令**不列**，且**不**被伪装
  //   —— 首段连字符是真实形态（latex-workshop.hostPort）。
  const h2 = host();
  const b2 = await VscodeL1Bridge.install(h2, zipOf(["demo.ok", "latex-workshop.hostPort"]), {
    confirmReadAccess: true, confirmExecutableCode: true,
  });
  const mod2 = h2.catalog().modules.find((m) => m.id === b2.moduleId)!;
  const c2 = mod2.contributions.filter((c) => c.slot === "command").map((c) => (c as { command: string }).command);
  check("★ 过不了正则的命令**不进清单**（如实不列）", !c2.includes("latex-workshop.hostPort"), { c2 });

  // ★ 但它**仍能注册** —— 白名单来自 `contributes.commands`，与清单里有没有 title 无关。
  //   （上面那个 invoke() 调的是第一条 `demo.ok`，测不到这里；所以单独跑一次。）
  const srcHyphen = `exports.activate=()=>{require("vscode").commands.registerCommand("latex-workshop.hostPort",()=>"x");};`;
  const rHyphen = await invoke(zipOf(["demo.ok", "latex-workshop.hostPort"], { engineSource: srcHyphen }));
  // 注册成功了，但**第一条 demo.ok 没被注册** → 跑的时候找不到它 → 失败。
  // 这恰恰证明：注册阶段放行了（否则会报 "not declared"），失败在后来的「找不到第一条」。
  check("★ 它注册时**没被白名单拒**（失败原因是第一条没注册，不是 'not declared'）",
    !rHyphen.ok && !/not declared/.test(rHyphen.error ?? "") && /not registered/.test(rHyphen.error ?? ""),
    { error: (rHyphen.error ?? "").slice(0, 240) });
}

console.log("[5] contributes 上限 12：命令最多列 11 条（契约决定，不是我们选的）");
{
  const many = Array.from({ length: 20 }, (_, i) => `demo.c${i}`);
  const h = host();
  const bridge = await VscodeL1Bridge.install(h, zipOf(many), {
    confirmReadAccess: true, confirmExecutableCode: true,
  });
  const mod = h.catalog().modules.find((m) => m.id === bridge.moduleId)!;
  check("★ 装得进来（20 条命令不导致失败）", mod !== undefined);
  check("★ 清单里最多 12 条 contribution（1 个 run + 11 条命令）",
    mod.contributions.length <= 12, { n: mod.contributions.length });
  check("★ 超出的命令**没被伪装**成有 title", mod.contributions.filter((c) => c.slot === "command").length === 11, {
    commandSlots: mod.contributions.filter((c) => c.slot === "command").length,
  });
}

console.log("[6] 真实扩展 rainbow-csv：24 条命令，现在几条能注册 / 几条有 title");
{
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let pkg: any = null;
  try { pkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 没装 */ }
  if (!pkg) {
    console.log("      （本机没有 rainbow-csv，跳过）");
  } else {
    const cmds: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const CMD_SLOT = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$/;
    const passRegex = cmds.filter((c) => CMD_SLOT.test(c));
    // ★ 实测修正：**0/24**，不是 24/24。
    // 我写卡时以为 `rainbow-csv.CSVLint` 能过 —— 它过不了，因为**首段是 `rainbow-csv`
    // 带连字符**。那个正则的每一段只允许字母数字（第二段开始才允许 `-`）。
    // 这条记下来：**总体的 439/884 是别的扩展（`ms-python.python` 这类）贡献的**，
    // 一个具体扩展能不能过，要单独看。
    console.log(`      24 条命令里，过 slot:command 正则的：${passRegex.length} / ${cmds.length}`);
    check("★ 它的命令**过不了** slot:command 正则（首段 `rainbow-csv` 带连字符）",
      passRegex.length === 0, { pass: passRegex.length });
    check("★ 所以它的清单里**一条命令贡献都没有**（如实不列，不是假装列了）",
      true, { note: "下面用真实 manifest 验" });

    const h = host();
    const bridge = await VscodeL1Bridge.install(h, buildZip([
      { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
      { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
    ], 8), { confirmReadAccess: true, confirmExecutableCode: true });
    const mod = h.catalog().modules.find((m) => m.id === bridge.moduleId)!;
    const listed = mod.contributions.filter((c) => c.slot === "command").length;
    check("★ 清单里 0 条命令贡献 —— 与上面的正则结论一致", listed === 0, { listed });
    check("★ 它仍然装得进来（清单有 title 不是装进来的前提）", mod !== undefined);
    check("★ 它的第 1 条命令仍有 title（run 那条贡献）",
      mod.contributions[0]!.title.en === pkg.contributes.commands[0].title, {
        got: mod.contributions[0]!.title.en, want: pkg.contributes.commands[0].title,
      });
    check("★ 它的命令**全部**能注册（白名单是全部 24 条，与清单列不列无关）",
      bridge.declaredCommands.length === cmds.length, {
        declared: bridge.declaredCommands.length, total: cmds.length,
      });
    console.log(`      结论：24 条命令中，**能注册 24 条**、**有 title 0 条**、**能真正调用 1 条**。`);
  }
}

console.log("[7] MAX_COMMANDS：64 会拒掉 3 个真实扩展，256 不会");
{
  // 真实最大值 101（ms-azuretools.vscode-containers）。旧的 64 会拒它。
  const n101 = Array.from({ length: 101 }, (_, i) => `demo.cmd${i}`);
  const h = host();
  const r = await VscodeL1Bridge.install(h, zipOf(n101), {
    confirmReadAccess: true, confirmExecutableCode: true,
  }).then((b) => ({ ok: true as const, bridge: b })).catch((e) => ({ ok: false as const, error: String(e) }));
  check("★ 101 条命令能装（旧 MAX_COMMANDS=64 会拒，真实扩展 containers 就是 101 条）",
    r.ok, { error: (r as { error?: string }).error?.slice(0, 240) });

  // 负控：上限仍然存在，不是无界。
  // ⚠️ 10000 条**测不到这条** —— 它会先撞 64 KiB 的清单上限（实测 458 KB），
  // 于是「被拒」是对的，但拒它的不是 MAX_COMMANDS。用 257（上限 +1）才测得到。
  const over = Array.from({ length: 257 }, (_, i) => `demo.cmd${i}`);
  const r2 = await VscodeL1Bridge.install(host(), zipOf(over), {
    confirmReadAccess: true, confirmExecutableCode: true,
  }).then(() => ({ ok: true as const })).catch((e) => ({ ok: false as const, error: String(e) }));
  check("★ 257 条（上限 +1）被拒 —— 上限还在，不是无界数组", !r2.ok);
  check("★ 拒绝信息点名 256（不是笼统 invalid）", !r2.ok && /256/.test((r2 as { error: string }).error), {
    error: ((r2 as { error: string }).error ?? "").slice(0, 240),
  });
}

console.log(`\nvsix-multi-command-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
