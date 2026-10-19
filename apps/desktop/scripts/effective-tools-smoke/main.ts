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
import {
  DEFAULT_TOOL_PROFILE_NAME,
  CLAUDE_HARNESS_BUILTINS,
  applyToolBudget,
  claudeToolSelectionOptions,
  codexDynamicToolsForProfile,
  piToolsAllowlist,
  resolveEngineToolSelection,
} from "@main/orchestration/toolSelection.js";

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
  // ⚠️ `buildDynamicTools` 已拆到 `CodexDynamicTools.ts` —— 扫**两文件拼接**。
  const codexSrc = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8")
    + "\n" + readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexDynamicTools.ts"), "utf8");
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

  // 8.6 bucketsForProfile:floor 恒含;`full` 回 null(它放行全部,不对应桶集合)。
  for (const p of ["minimal", "chat", "code", "research", "browser", "workflow"] as const) {
    const buckets = bucketsForProfile(p);
    check(`bucketsForProfile(${p}) 含 essential`, buckets !== null && buckets.includes("essential"), buckets);
  }
  check("★ bucketsForProfile(full) 回 null(全量不对应桶集合)", bucketsForProfile("full") === null, bucketsForProfile("full"));

  // 8.7 ★ `full` 画像:放行清单里**全部**工具(含桶判不出的),这是显式的「不裁剪」。
  const allNames = inv.tools.map((t) => t.name).sort();
  eq("★ full 画像 = 清单全部工具名(升序)", selectToolsForProfile(inv, { name: "full" }), allNames);
  {
    const unknownInv = buildEffectiveToolInventory({
      providerId: "t",
      tools: [
        { name: "app_api_list", source: "dynamic" },
        { name: "totally_unknown_tool_xyz", source: "dynamic" },
      ],
    });
    check("★ full 连桶判不出的名字也放行(与最小化画像相反)", selectToolsForProfile(unknownInv, { name: "full" }).includes("totally_unknown_tool_xyz"));
  }
}

/* ── 9. ★【MC-100/101 执行层】共享选择层 + 三引擎薄适配器 ────────────────────
 *
 * 台账点名的缺口是:「实际 Claude / Pi / Codex provider `src` 里没有 `selectToolsForProfile`
 * 调用 —— 仍未真实缩减模型可见的工具集」。这一段钉的就是**装配层真的把画像结果喂进了各 SDK 形态**:
 *  - `resolveEngineToolSelection` 是唯一入口(provider 调它),给的是**原始形态**工具名子集;
 *  - 三个薄适配器把名字子集翻成 Pi `tools` 白名单 / Codex `dynamicTools` 过滤 / Claude `options` 片段;
 *  - `full`(默认画像)**显式**回全量(不是省略);更小的画像**真的少**工具。
 * 这些断言测的是「provider 请求会收到的那个集合」,不是纯选择函数返回小集合。
 */
{
  // 9.1 默认画像 = full(全量),这才是改动前行为,且它是**显式**画像分支。
  eq("默认画像名 = full", DEFAULT_TOOL_PROFILE_NAME, "full");

  // 9.2 Pi:full → tools=undefined(Pi 的"启用全部");minimal → 只有 floor 白名单。
  const piFull = resolveEngineToolSelection("pi", { browserEnabled: true, profile: { name: "full" } });
  check("★ Pi full → piToolsAllowlist = undefined(启用全部,显式画像)", piToolsAllowlist(piFull) === undefined, piToolsAllowlist(piFull));
  const piMin = resolveEngineToolSelection("pi", { browserEnabled: true, profile: { name: "minimal" } });
  const piMinTools = piToolsAllowlist(piMin);
  check("★ Pi minimal → tools 是数组且只含 floor 三件套", Array.isArray(piMinTools) && piMinTools.length === 3 && ESSENTIAL_TOOL_NAMES.every((n) => piMinTools!.includes(n)), piMinTools);
  check("★ Pi minimal 白名单真的更小(少于 full 的清单)", piMinTools!.length < piFull.inventory.tools.length, { minimal: piMinTools!.length, all: piFull.inventory.tools.length });

  // 9.3 Codex:full → dynamicTools 原样;minimal → 只剩名字在选中集合里的项。
  const codexFull = resolveEngineToolSelection("codex", { browserEnabled: true, profile: { name: "full" } });
  const allDynamic = codexFull.inventory.tools.map((t) => ({ name: t.name }));
  eq("★ Codex full → dynamicTools 原样(全量)", codexDynamicToolsForProfile(allDynamic, codexFull).length, allDynamic.length);
  const codexMin = resolveEngineToolSelection("codex", { browserEnabled: true, profile: { name: "minimal" } });
  const trimmedDynamic = codexDynamicToolsForProfile(allDynamic, codexMin);
  // minimal 的选中集合(裸名)里,落在 dynamicTools 名字上的只有 floor 三件套。
  check("★ Codex minimal → dynamicTools 被真实过滤(少于 full)", trimmedDynamic.length < allDynamic.length, { trimmed: trimmedDynamic.length, all: allDynamic.length });
  check("★ Codex minimal 过滤后每一项都在选中集合里", trimmedDynamic.every((t) => codexMin.selected.includes(t.name)), trimmedDynamic.map((t) => t.name));

  // 9.4 Claude:full → tools=undefined 且保留全部 server;research → 收窄内置 + 只留选中 server。
  const claudeFull = resolveEngineToolSelection("claude", { browserEnabled: true, profile: { name: "full" } });
  const servers = ["mcode-browser", "mcode-library", "mcode-workflow", "mcode-memory", "mcode-app", "mcode-agent-tools"];
  // 内置名从**同一份清单**的 builtin 来源取(不另引 IpcMain 那条重依赖链)。
  const claudeBuiltin = toolNamesOfSource(claudeFull.inventory, "builtin");
  const claudeFullOpts = claudeToolSelectionOptions(claudeFull, { allBuiltin: claudeBuiltin, allServers: servers });
  check("★ Claude full → Options.tools = undefined(保留 SDK 预设,显式画像)", claudeFullOpts.tools === undefined, claudeFullOpts.tools);
  eq("★ Claude full → mcpServers 全保留", claudeFullOpts.mcpServers, servers);

  const claudeResearch = resolveEngineToolSelection("claude", { browserEnabled: true, profile: { name: "research" } });
  const claudeResearchOpts = claudeToolSelectionOptions(claudeResearch, { allBuiltin: claudeBuiltin, allServers: servers });
  check("★ Claude research → Options.tools 收窄为内置数组(不是 undefined)", Array.isArray(claudeResearchOpts.tools), claudeResearchOpts.tools);
  check("★ Claude research → 保留 mcode-library(资料库桶)", claudeResearchOpts.mcpServers.includes("mcode-library"), claudeResearchOpts.mcpServers);
  check("★ Claude research → 裁掉 mcode-browser(浏览器桶与 research 无关)", !claudeResearchOpts.mcpServers.includes("mcode-browser"), claudeResearchOpts.mcpServers);
  check("★ Claude research → mcode-app 恒留(floor 的 app_api_* 在 app server 上)", claudeResearchOpts.mcpServers.includes("mcode-app"), claudeResearchOpts.mcpServers);
  check("★ Claude research → server 数少于 full", claudeResearchOpts.mcpServers.length < servers.length, claudeResearchOpts.mcpServers);

  // 9.4b ★ 内置收窄要**真的**按桶裁:code 画像选中内置文件/终端工具,而 chat 桶内置(WebSearch/Task)
  // 与 research/browser 桶内置都不该出现。判据是**精确集合**,不只「不含 Bash」——否则当选中集合里
  // 一个内置都没有时(如 research),「不含 Bash」会假绿(这正是 review 点名的"断言测了个空")。
  const claudeCode = resolveEngineToolSelection("claude", { browserEnabled: true, profile: { name: "code" } });
  const claudeCodeOpts = claudeToolSelectionOptions(claudeCode, { allBuiltin: claudeBuiltin, allServers: servers });
  const expectedCodeBuiltin = [...new Set([...claudeCode.selected.filter((n) => claudeBuiltin.includes(n)), ...CLAUDE_HARNESS_BUILTINS])].sort();
  eq("★ Claude code → Options.tools 精确等于 code 桶内置 ∪ harness 并集(真按桶裁)", claudeCodeOpts.tools, expectedCodeBuiltin);
  check("★ Claude code 内置集**非空**(证明了它真的放行了内置,不是侥幸为空)", (claudeCodeOpts.tools ?? []).length > 0, claudeCodeOpts.tools);
  check("★ Claude code → 含 Bash(内置文件/终端桶)", (claudeCodeOpts.tools ?? []).includes("Bash"), claudeCodeOpts.tools);
  check("★ Claude code → 不含 chat 桶内置 WebSearch(chat 不在 code 画像)", !(claudeCodeOpts.tools ?? []).includes("WebSearch"), claudeCodeOpts.tools);
  check("★ Claude code → 不含 chat 桶内置 Task", !(claudeCodeOpts.tools ?? []).includes("Task"), claudeCodeOpts.tools);
  // harness 平面(计划模式 / 提问 / 技能)在任何收窄画像下都保留 —— 安全并集,只增不减。
  for (const h of CLAUDE_HARNESS_BUILTINS) {
    check(`★ harness 内置 ${h} 在 code 画像收窄后仍保留`, (claudeCodeOpts.tools ?? []).includes(h), claudeCodeOpts.tools);
    check(`★ harness 内置 ${h} 在 research 画像收窄后仍保留`, (claudeResearchOpts.tools ?? []).includes(h), claudeResearchOpts.tools);
  }
  check("★ Claude research 内置里不含 Bash(code 桶被裁掉)", !(claudeResearchOpts.tools ?? []).includes("Bash"), claudeResearchOpts.tools);

  // 9.5 userOverride 贯通到适配器(只加不删):minimal + add 一个真实 browser 工具 → 该 server 被保留。
  const inv9 = claudeFull.inventory;
  const aBrowserTool = inv9.tools.map((t) => t.name).find((n) => n.includes("browser_"))!;
  const claudeMinOverride = resolveEngineToolSelection("claude", { browserEnabled: true, profile: { name: "minimal", userOverride: { add: [aBrowserTool] } } });
  const claudeMinOverrideOpts = claudeToolSelectionOptions(claudeMinOverride, { allBuiltin: claudeBuiltin, allServers: servers });
  check("★ userOverride.add 的工具贯通到 Claude mcpServers(该 server 被保留)", claudeMinOverrideOpts.mcpServers.includes("mcode-browser"), { added: aBrowserTool, servers: claudeMinOverrideOpts.mcpServers });

  // 9.6 工具预算:maxTools 收紧,floor 恒不裁。
  const piBudgeted = resolveEngineToolSelection("pi", { browserEnabled: false, profile: { name: "code" }, budget: { maxTools: 5 } });
  check("★ 预算 maxTools=5 → 选中数 ≤ 5", piBudgeted.selected.length <= 5, piBudgeted.selected);
  check("★ 预算触顶后 floor 仍在(发现通道不被预算砍)", ESSENTIAL_TOOL_NAMES.every((n) => piBudgeted.selected.includes(n)), piBudgeted.selected);
  const piCodeNoBudget = resolveEngineToolSelection("pi", { browserEnabled: false, profile: { name: "code" } });
  check("★ 预算确实收紧了(code 画像无预算时更多)", piBudgeted.selected.length < piCodeNoBudget.selected.length, { budgeted: piBudgeted.selected.length, unbudgeted: piCodeNoBudget.selected.length });
  // floor-first:maxTools 小于 floor 数时仍保留 floor(可略超预算)。
  const tiny = resolveEngineToolSelection("pi", { browserEnabled: false, profile: { name: "code" }, budget: { maxTools: 1 } });
  check("★ maxTools < floor 数 → floor 仍全保留(预算不砍发现通道)", ESSENTIAL_TOOL_NAMES.every((n) => tiny.selected.includes(n)), tiny.selected);
  // 直接测 applyToolBudget 的 token 分支。
  const tokenBudgeted = applyToolBudget(piCodeNoBudget, { maxTokens: 1 });
  check("★ 预算 maxTokens=1 → 只剩 floor(其余被 token 上限挡住)", tokenBudgeted.every((n) => ESSENTIAL_TOOL_NAMES.includes(bareToolName(n))) && tokenBudgeted.length >= 3, tokenBudgeted);

  // The first alphabetic optional tool may be too expensive; smaller tools
  // later must still be evaluated. A 'break' for token exhaustion wrongly
  // hides otherwise affordable tools from all three provider adapters.
  const synthetic = {
    ...piCodeNoBudget,
    selected: ["app_api_call", "app_api_describe", "app_api_list", "a_very_heavy", "b_light", "c_light"],
    inventory: {
      ...piCodeNoBudget.inventory,
      tools: [
        ...piCodeNoBudget.inventory.tools.filter(t => ESSENTIAL_TOOL_NAMES.includes(t.name)),
        { name: "a_very_heavy", estimatedTokens: 100 },
        { name: "b_light", estimatedTokens: 2 },
        { name: "c_light", estimatedTokens: 2 },
      ],
    },
  } as typeof piCodeNoBudget;
  const floorCost = synthetic.inventory.tools.filter(t => ESSENTIAL_TOOL_NAMES.includes(t.name)).reduce((sum, t) => sum + t.estimatedTokens, 0);
  const affordable = applyToolBudget(synthetic, { maxTokens: floorCost + 4 });
  check("★ oversized first optional tool cannot hide later cheap tools",
    affordable.includes("b_light") || affordable.includes("c_light"), affordable);
  check("oversized optional tool remains excluded under token budget",
    !affordable.includes("a_very_heavy"), affordable);
  const countLimited = applyToolBudget(synthetic, { maxTools: 4 });
  check("maxTools limit includes only one optional entry", countLimited.length === 4, countLimited);
}

/* ── 10. ★ 接线:三个 provider 真的调了共享选择层(不是只定义不调) ─────────────
 *
 * MC-100/101 点名的正是「provider src 里没有 selectToolsForProfile 调用」。判据是**调用形态**
 * (函数名 + 引擎实参),不是裸词 —— 注释里合法地会提到这些名字。
 */
{
  const claudeSrc = readFileSync(resolve(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  const piSrc = readFileSync(resolve(process.cwd(), "src/main/providers/pi-sdk/PiAgentSdkProvider.ts"), "utf8");
  // ⚠️ `buildDynamicTools` 已拆到 `CodexDynamicTools.ts` —— 扫**两文件拼接**。
  const codexSrc = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8")
    + "\n" + readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexDynamicTools.ts"), "utf8");

  check("★ Claude provider 调 resolveEngineToolSelection(\"claude\", …)", /resolveEngineToolSelection\(\s*"claude"/.test(claudeSrc));
  check("★ Claude provider 把选择结果赋进 options(调 claudeToolSelectionOptions)", claudeSrc.includes("claudeToolSelectionOptions(") && claudeSrc.includes("options.tools = "));
  check("★ Pi provider 调 resolveEngineToolSelection(\"pi\", …)", /resolveEngineToolSelection\(\s*"pi"/.test(piSrc));
  check("★ Pi provider 用 piToolsAllowlist 求 tools(不再写死 undefined)", piSrc.includes("piToolsAllowlist("));
  check("★ Pi provider 不再写死 `const tools = undefined`", !/const tools = undefined/.test(piSrc));
  check("★ Codex provider 调 resolveEngineToolSelection(\"codex\", …)", /resolveEngineToolSelection\(\s*"codex"/.test(codexSrc));
  check("★ Codex provider 两处 dynamicTools 都经 codexDynamicToolsForProfile", (codexSrc.match(/codexDynamicToolsForProfile\(/g) ?? []).length >= 2);
  // 唯一入口复用:provider 不自己调纯选择函数(否则就是三份平行实现)。
  check("★ 三个 provider 都不直接调 selectToolsForProfile(选择只有一份)", !claudeSrc.includes("selectToolsForProfile(") && !piSrc.includes("selectToolsForProfile(") && !codexSrc.includes("selectToolsForProfile("));
}

console.log(`\neffective-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);