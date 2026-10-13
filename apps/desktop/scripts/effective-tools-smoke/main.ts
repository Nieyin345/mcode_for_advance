/**
 * **EffectiveToolInventory 诊断的回归**(MC-100 / MC-101)。
 *
 * 钉住四件事:
 *  1. 被 `excludeTools` 排除的工具**不在清单里**(且记进 `excluded`,不静默消失);
 *  2. 三引擎看到**不同**的工具集(Claude 用 `mcp__server__tool` 形态、Codex 用
 *     `dynamic` 形态、Pi 用内置 + 动态形态),但都经同一份生产者取值;
 *  3. token 估计对定义字符数**单调**(schema 越大,估计不更低);
 *  4. 来源标签正确(内置 / `mcp:<server>` / 动态 / 恢复遗留),且按来源聚合的数对得上。
 *
 * 这是**纯诊断**:不起 Electron、不调任何 SDK、不碰 ~/.mcode。它调各生产者现成的构造函数
 * 拿真实描述符(硬规矩 2:不另抄工具名),只做统计。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHARS_PER_TOKEN,
  buildEffectiveToolInventory,
  estimateToolTokens,
  type EffectiveToolInput,
} from "@contracts/effectiveToolInventory";
import {
  buildEngineToolInventory,
  claudeEffectiveToolInventory,
  codexEffectiveToolInventory,
  piEffectiveToolInventory,
  toolNamesOfSource,
} from "@main/orchestration/effectiveToolInventory.js";
import {
  ESSENTIAL_TOOL_NAMES,
  bareToolName,
  bucketsForProfile,
  classifyToolBucket,
  selectToolsForProfile,
  type ToolProfileName,
} from "@contracts/toolProfile";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ── 1. 纯核:来源标签 + 排除 + 单调 ──────────────────────────────────────── */

{
  const tools: EffectiveToolInput[] = [
    { name: "Bash", source: "builtin" },
    { name: "mcp__mcode-library__library_search", description: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } }, source: "mcp:mcode-library" },
    { name: "app_api_call", description: "call", inputSchema: { type: "object", properties: { method: { type: "string" } } }, source: "dynamic" },
    { name: "browser_old_legacy", source: "resumed-legacy" },
  ];
  const inv = buildEffectiveToolInventory({
    providerId: "test",
    tools,
    excludeTools: ["Bash"],
  });

  check("★ 被排除的工具不在清单里", !inv.tools.some((t) => t.name === "Bash"), inv.tools.map((t) => t.name));
  eq("★ 被排除的名字记进 excluded(不静默)", inv.excluded, ["Bash"]);
  eq("按来源聚合有 mcp:mcode-library", inv.bySource["mcp:mcode-library"]?.count, 1);
  eq("来源 builtin 被排除后为 0 条", inv.bySource["builtin"]?.count ?? 0, 0);
  eq("恢复遗留归入 resumed-legacy", inv.bySource["resumed-legacy"]?.count, 1);

  // 恢复遗留参与统计,但不与本轮工具混源。
  const mcpEntry = inv.tools.find((t) => t.name.startsWith("mcp__"))!;
  check("MCP 工具名保留 mcp__<server>__<tool> 形态", mcpEntry.name === "mcp__mcode-library__library_search", mcpEntry.name);
  check("MCP 工具 schema 字符数 > 0", mcpEntry.schemaChars > 0, mcpEntry.schemaChars);

  // 重复名字:先到先得。
  const dup = buildEffectiveToolInventory({
    providerId: "test",
    tools: [{ name: "X", source: "builtin" }, { name: "X", source: "dynamic" }],
  });
  eq("同名去重(先到先得,只留第一条)", dup.tools.map((t) => t.source), ["builtin"]);

  // token 估计 = ceil(定义字符 / CHARS_PER_TOKEN)。
  const one = buildEffectiveToolInventory({
    providerId: "t", tools: [{ name: "abc", description: "de", inputSchema: { x: 1 }, source: "builtin" }],
  });
  const defChars = "abc".length + "de".length + JSON.stringify({ x: 1 }).length;
  eq("estimatedTokens = ceil(定义字符 / CHARS_PER_TOKEN)", one.tools[0].estimatedTokens, Math.ceil(defChars / CHARS_PER_TOKEN));
  eq("definitionChars = name + description + schemaChars", one.tools[0].definitionChars, defChars);
}

/* ── 2. ★ token 估计对 schema 大小单调 ────────────────────────────────────── */
{
  const small: EffectiveToolInput = { name: "t", description: "d", inputSchema: { type: "object" }, source: "builtin" };
  const big: EffectiveToolInput = {
    name: "t", description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string", description: "abcdefghijklmnopqrstuvwxyz" }, b: { type: "number" } } },
    source: "builtin",
  };
  check("大 schema 的 token 估计更大", estimateToolTokens(big) > estimateToolTokens(small), {
    small: estimateToolTokens(small), big: estimateToolTokens(big),
  });
  // 单调(严格):名字大幅变长(差距远大于 1 个 token)→ 估计必须严格更大。
  // 用大差距而非 +1 字符,免得"整除/取整"这类边界把真差异吃掉,令变异测不出来。
  const tiny = estimateToolTokens({ name: "x", source: "builtin" });
  const huge = estimateToolTokens({ name: "x".repeat(400), source: "builtin" });
  check("★ 字符数大幅增加 → token 估计严格更大(单调)", huge > tiny, { tiny, huge });
  check("无 schema 时 schemaChars=0 但定义字符仍计 name", buildEffectiveToolInventory({ providerId: "t", tools: [{ name: "abcd", source: "builtin" }] }).totalSchemaChars === 0);
}

/* ── 3. ★ 三引擎真实装配:都拿到工具,但集合不同 ──────────────────────────── */
{
  const absent = (t: { inputSchema?: unknown }) => t;

  const claude = claudeEffectiveToolInventory({ browserEnabled: true });
  const codex = codexEffectiveToolInventory({ browserEnabled: true });
  const pi = piEffectiveToolInventory({ browserEnabled: true });

  check("Claude 清单非空", claude.tools.length > 0, claude.tools.length);
  check("Codex 清单非空", codex.tools.length > 0, codex.tools.length);
  check("Pi 清单非空", pi.tools.length > 0, pi.tools.length);

  // 三引擎都经同一份生产者拿到 app 控制工具 —— 但**暴露形态不同**:
  // Claude 是 mcp__mcode-app__app_api_call;Codex/Pi 是裸 app_api_call。
  const claudeAppNames = claude.tools.filter((t) => t.source === "mcp:mcode-app").map((t) => t.name);
  check("★ Claude 的 app 工具带 mcp__mcode-app__ 前缀", claudeAppNames.every((n) => n.startsWith("mcp__mcode-app__")) && claudeAppNames.length > 0, claudeAppNames.slice(0, 3));
  const codexNames = codex.tools.map((t) => t.name);
  const piNames = pi.tools.map((t) => t.name);
  check("★ Codex 的 app_api_call 是裸名(dynamic)", codexNames.includes("app_api_call"), codexNames.slice(0, 5));
  check("★ Pi 的 app_api_call 也是裸名", piNames.includes("app_api_call"), piNames.slice(0, 5));

  // 集合确实不同:Claude 里没有裸 "app_api_call"(它带前缀);Codex 里有。
  check("★ 三引擎工具集不同(Claude 无裸 app_api_call,Codex 有)", !claude.tools.some((t) => t.name === "app_api_call") && codexNames.includes("app_api_call"));

  // 来源标签正确:Claude 有 builtin + 多个 mcp:<server> 桶。
  const claudeSources = Object.keys(claude.bySource).sort();
  check("★ Claude 来源含 builtin", claudeSources.includes("builtin"), claudeSources);
  check("★ Claude 来源含 mcp:mcode-library", claudeSources.includes("mcp:mcode-library"), claudeSources);
  check("Claude 来源含 mcp:mcode-browser(browserEnabled=true)", claudeSources.includes("mcp:mcode-browser"), claudeSources);
  check("Codex 来源只有 dynamic(无 builtin 可枚举)", Object.keys(codex.bySource).every((s) => s === "dynamic"), Object.keys(codex.bySource));
  check("Pi 来源含 builtin + dynamic", Object.keys(pi.bySource).includes("builtin") && Object.keys(pi.bySource).includes("dynamic"), Object.keys(pi.bySource));

  // browserEnabled 关掉:浏览器工具消失(两引擎一致)。
  const claudeNoBrowser = claudeEffectiveToolInventory({ browserEnabled: false });
  const codexNoBrowser = codexEffectiveToolInventory({ browserEnabled: false });
  check("★ browserEnabled=false → Claude 无 mcode-browser 桶", !Object.keys(claudeNoBrowser.bySource).includes("mcp:mcode-browser"));
  check("★ browserEnabled=false → Codex dynamic 数减少", codexNoBrowser.tools.length < codex.tools.length, { off: codexNoBrowser.tools.length, on: codex.tools.length });
  void absent;

  // 聚合守恒:各来源 token 之和 = 总数。
  const sumTokens = Object.values(claude.bySource).reduce((a, b) => a + b.estimatedTokens, 0);
  eq("Claude 各来源 token 之和 = 总数", sumTokens, claude.totalEstimatedTokens);
  const sumDef = Object.values(codex.bySource).reduce((a, b) => a + b.definitionChars, 0);
  eq("Codex 各来源定义字符之和 = 总数", sumDef, codex.totalDefinitionChars);
}

/* ── 4. 排除贯通到真实装配 ───────────────────────────────────────────────── */
{
  const inv = claudeEffectiveToolInventory({ browserEnabled: false, excluded: ["Bash"] });
  const builtin = toolNamesOfSource(inv, "builtin");
  check("★ 排除 Bash → builtin 里没有 Bash", !builtin.includes("Bash"), builtin);
  check("★ 排除记进 excluded", inv.excluded.includes("Bash"), inv.excluded);
}

/* ── 5. ★ 恢复遗留(Codex):旧工具显式列出,不当成本轮注册 ──────────────── */
{
  const legacy: EffectiveToolInput[] = [{ name: "browser_old_rollout_tool", source: "resumed-legacy" }];
  const codex = codexEffectiveToolInventory({ browserEnabled: false, resumedLegacyTools: legacy });
  const names = codex.tools.map((t) => t.name);
  check("★ 恢复遗留工具出现在清单里", names.includes("browser_old_rollout_tool"), names.slice(-5));
  eq("★ 恢复遗留归入 resumed-legacy 来源", codex.bySource["resumed-legacy"]?.count, 1);
  check("本轮注册的工具与恢复遗留分属不同来源桶", !codex.tools.filter((t) => t.source === "dynamic").some((t) => t.name === "browser_old_rollout_tool"));
}

/* ── 6. 分派入口 buildEngineToolInventory 与各分函数一致 ──────────────────── */
{
  for (const engine of ["claude", "codex", "pi"] as const) {
    const viaDispatch = buildEngineToolInventory(engine, { browserEnabled: false });
    const direct = engine === "claude" ? claudeEffectiveToolInventory({ browserEnabled: false })
      : engine === "codex" ? codexEffectiveToolInventory({ browserEnabled: false })
      : piEffectiveToolInventory({ browserEnabled: false });
    eq(`buildEngineToolInventory(${engine}) 与直接调用一致`, viaDispatch.tools.length, direct.tools.length);
  }
}

/* ── 7. 接线:这份诊断**只读**,没有改任何 provider 行为 ──────────────────
 *
 * 判据:主进程那份装配 import 的是各生产者的**只读描述符构造函数**,且不含任何写路径
 * (不含 .registerTool / thread/start / options.mcpServers 赋值)。Codex 的
 * `buildDynamicTools` 必须**导出**才复用得到,不得另抄一份工具名表。
 */
{
  const src = readFileSync(resolve(process.cwd(), "src/main/orchestration/effectiveToolInventory.ts"), "utf8");
  check("★ 装配复用各生产者的描述符(含 libraryToolDescriptors)", src.includes("libraryToolDescriptors("));
  check("★ 装配复用 workflowEngineBridge.descriptors", src.includes("workflowEngineBridge.descriptors("));
  check("★ 装配复用 Codex 的 buildDynamicTools(不另抄工具名)", src.includes("buildDynamicTools("));
  check("★ 装配复用 KNOWN_BUILTIN_TOOLS(内置清单唯一来源)", src.includes("KNOWN_BUILTIN_TOOLS"));
  // 只读判据要盯**写形态**(调用/赋值),不能盯裸词 —— 注释里合法地会提到
  // `options.mcpServers` 与 `registerTool`(说明"与它们同源")。这里只禁真写路径。
  check("★ 诊断是只读的(无 registerTool 调用 / options.mcpServers 赋值)", !/\.registerTool\s*\(/.test(src) && !/options\.mcpServers\s*=/.test(src));
  const codexSrc = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8");
  check("★ buildDynamicTools 已导出(供诊断复用)", /export function buildDynamicTools/.test(codexSrc));
  const ipcSrc = readFileSync(resolve(process.cwd(), "src/main/ipc/engineTools.ts"), "utf8");
  check("★ KNOWN_BUILTIN_TOOLS 已导出(内置清单唯一来源)", /export const KNOWN_BUILTIN_TOOLS/.test(ipcSrc));
}

/* ── 8. ★ ToolProfile 选择层(MC-100 第二步):按任务派生最小工具子集 ─────────
 *
 * 这些是**纯选择**断言:给定清单 + 画像 → 应暴露的工具名子集。判据:
 *  - 每个画像回它该有的桶(floor + 自己的桶),集间有真实差异;
 *  - `minimal` 只留必需集,绝不带 research/browser 工具;
 *  - 未知名字**永不**被自动选中;
 *  - `userOverride` 只能加、加不进清单里没有的名字,且**动不了 floor**;
 *  - 桶判定对三形态(内置裸名 / Claude 的 `mcp__<server>__` 前缀 / Codex+Pi 的裸 dynamic)一致。
 */
{
  // 用 Claude 的真实装配(带 browser)做「大清单」:它同时含 builtin、mcode-app、library、
  // memory、workflow、browser 六个来源,正好覆盖六个桶。
  const inv = claudeEffectiveToolInventory({ browserEnabled: true });
  const names = new Set(inv.tools.map((t) => t.name));

  // 前提:这张真实清单里确实有各桶的代表(否则下面的断言没意义)。
  check("清单含必需工具 mcp__mcode-app__app_api_call", names.has("mcp__mcode-app__app_api_call"), [...names].filter((n) => n.includes("app_api")));
  check("清单含资料库工具(library_)", [...names].some((n) => n.includes("library_")), [...names].filter((n) => n.includes("library_")).slice(0, 3));
  check("清单含浏览器工具(browser_)", [...names].some((n) => n.includes("browser_")), [...names].filter((n) => n.includes("browser_")).slice(0, 3));

  const sel = (p: ToolProfileName) => selectToolsForProfile(inv, { name: p });
  const minimal = sel("minimal");
  const chat = sel("chat");
  const code = sel("code");
  const research = sel("research");
  const browser = sel("browser");
  const workflow = sel("workflow");

  // 8.1 minimal:只含必需集(此处为 Claude 带前缀形态)。
  eq("★ minimal = 必需集(仅 app_api 三件套,带前缀)", minimal, [
    "mcp__mcode-app__app_api_call", "mcp__mcode-app__app_api_describe", "mcp__mcode-app__app_api_list",
  ]);
  check("★ minimal 不含 research 工具(library_)", !minimal.some((n) => n.includes("library_")), minimal);
  check("★ minimal 不含 browser 工具(browser_)", !minimal.some((n) => n.includes("browser_")), minimal);
  check("★ minimal 不含 code 内置(Bash)", !minimal.includes("Bash"), minimal);

  // 8.2 各画像确为「minimal + 自己那桶」的超集,且彼此不同。
  check("★ code ⊋ minimal(多了内置 Bash)", code.includes("Bash") && minimal.every((n) => code.includes(n)));
  check("research ⊋ minimal(多了 library_)", research.some((n) => n.includes("library_")) && minimal.every((n) => research.includes(n)));
  check("browser ⊋ minimal(多了 browser_)", browser.some((n) => n.includes("browser_")) && minimal.every((n) => browser.includes(n)));
  check("workflow ⊋ minimal(多了 workflow_/session_)", workflow.some((n) => n.includes("workflow_") || n.includes("session_")) && minimal.every((n) => workflow.includes(n)));
  check("chat ⊋ minimal", minimal.every((n) => chat.includes(n)) && chat.length >= minimal.length);

  check("★ research 不带 browser 工具", !research.some((n) => n.includes("browser_")), research.filter((n) => n.includes("browser_")));
  check("★ browser 不带 library 工具", !browser.some((n) => n.includes("library_")), browser.filter((n) => n.includes("library_")));
  check("★ code 不含 research/browser", !code.some((n) => n.includes("library_") || n.includes("browser_")));

  // 必需集在**每个**画像里都在(floor 恒含)。
  for (const [label, list] of [["minimal", minimal], ["chat", chat], ["code", code], ["research", research], ["browser", browser], ["workflow", workflow]] as const) {
    check(`floor 在每个画像恒含(${label})`, ESSENTIAL_TOOL_NAMES.map((n) => `mcp__mcode-app__${n}`).every((n) => list.includes(n)), list.filter((n) => n.includes("app_api")));
  }

  // 8.3 桶判定对三形态一致:内置裸名 / Claude 前缀形态 / 裸 dynamic。
  check("内置裸名 Bash → code 桶", classifyToolBucket("Bash", "builtin") === "code");
  check("Claude 前缀形态 mcp__mcode-app__app_api_call → essential", classifyToolBucket("mcp__mcode-app__app_api_call", "mcp:mcode-app") === "essential");
  check("来源 mcp:mcode-browser → browser 桶(不按名猜)", classifyToolBucket("browser_navigate", "mcp:mcode-browser") === "browser");
  check("裸 dynamic browser_navigate → browser 桶(名字族)", classifyToolBucket("browser_navigate", "dynamic") === "browser");
  check("裸 dynamic library_search → research 桶(名字族)", classifyToolBucket("library_search", "dynamic") === "research");
  check("裸名 app_api_list → essential 桶", classifyToolBucket("app_api_list", "dynamic") === "essential");
  eq("bareToolName 剥掉 mcp__server__ 前缀", bareToolName("mcp__mcode-app__app_api_call"), "app_api_call");
  eq("bareToolName 对裸名原样返回", bareToolName("app_api_call"), "app_api_call");

  // 8.4 ★ 未知名字绝不静默加入:一个清单里存在、但桶认不出的名字,任何画像都不选它。
  const unknownInv = buildEffectiveToolInventory({
    providerId: "t",
    tools: [
      { name: "app_api_list", source: "dynamic" },
      { name: "totally_unknown_tool_xyz", source: "dynamic" },
    ],
  });
  check("未知名字 → 桶判定为 null", classifyToolBucket("totally_unknown_tool_xyz", "dynamic") === null);
  for (const p of ["minimal", "chat", "code", "research", "browser", "workflow"] as const) {
    check(`★ 未知名字不被画像 ${p} 选中`, !selectToolsForProfile(unknownInv, { name: p }).includes("totally_unknown_tool_xyz"));
  }

  // 8.5 ★ userOverride:只加不删;加不进清单里没有的名字;动不了 floor。
  //   在 minimal 上追加一个真实存在的 code 工具(Bash 不在 Claude 清单?——用清单里真实的)。
  const pickReal = [...names].find((n) => n.includes("library_"))!;
  const withOverride = selectToolsForProfile(inv, { name: "minimal", userOverride: { add: [pickReal, "nonexistent_tool_zzz"] } });
  check("★ userOverride.add 能把清单里真实的工具加进 minimal", withOverride.includes(pickReal), { pickReal, got: withOverride.includes(pickReal) });
  check("★ userOverride.add 里不存在的名字被忽略(不虚增)", !withOverride.includes("nonexistent_tool_zzz"), withOverride);
  check("★ userOverride 动不了 floor(必需集仍在)", ESSENTIAL_TOOL_NAMES.map((n) => `mcp__mcode-app__${n}`).every((n) => withOverride.includes(n)), minimal);

  // userOverride 没有 remove 形态 —— 类型层保证,这里断言「即使加了东西,minimal 的其余工具没因此变多」。
  eq("★ userOverride 只加必需集 + 追加项,不多不少", withOverride, [...minimal, pickReal].sort());

  // 8.6 bucketsForProfile:floor 恒含。
  for (const p of ["minimal", "chat", "code", "research", "browser", "workflow"] as const) {
    check(`bucketsForProfile(${p}) 含 essential`, bucketsForProfile(p).includes("essential"), bucketsForProfile(p));
  }
}

console.log(`\neffective-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);