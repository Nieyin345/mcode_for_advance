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

console.log(`\neffective-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);
