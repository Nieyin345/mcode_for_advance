/**
 * base-capability-matrix-smoke — 【ARC-003】基础能力语义表与**真实工具表**对账。
 *
 * ## 钉的是什么
 *
 * 契约包 `@contracts/baseToolCapabilities` 声明「某引擎的某能力由哪个工具承担」。
 * 这种静态声明最容易出的错不是写错一次，而是**漂移**：工具改名/换实现，表没跟着改，
 * 于是界面与提示词一起广告一个不存在的工具（MC-044 就是这种病的实例）。
 *
 * 所以每一格都拿**真实来源**核对，而不是拿另一份手写清单：
 *
 *   - Claude / Pi 的 native 格 → `KNOWN_BUILTIN_TOOLS`（设置面板与诊断层同一份）；
 *   - 三家的浏览器格 → `BROWSER_TOOL_SPECS`（18 个工具的真实规格表）；
 *   - 三家的文档读取格 → agent 桥的真实描述符（`agentToolDescriptors()`）；
 *   - Codex 的 `none` 格 → 它的动态工具表里**确实没有**同名工具（不是我们漏看）；
 *   - `readToolNameForTurn`（提示词用）→ 必须与表**同一答案**（ARC-003 收口前的
 *     第二份硬编码已删）。
 *
 * ## 它怎么跑
 *
 * 纯模块 + 主进程的真实工具表（`engineTools.ts` 会拖 electron，用与 effective-tools
 * 相同的桩）。不起 Electron、不碰 ~/.mcode。
 *
 * Run: scripts/base-capability-matrix-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_TOOL_CAPABILITIES,
  BASE_TOOL_CAPABILITY_IDS,
  baseToolNameFor,
  baseToolCapabilityRow,
  type BaseToolCapabilityId,
} from "@contracts/baseToolCapabilities";
import { ENGINE_TOOL_ENGINE_IDS, type EngineToolEngineId } from "@contracts/ipc/engineTools";
import { KNOWN_BUILTIN_TOOLS } from "@main/ipc/engineTools.js";
import { BROWSER_TOOL_SPECS } from "@main/browser/agentBrowserTools.js";
import { agentToolDescriptors } from "@main/mcp/agentEngineBridge.js";
import { baseCapabilityRow as rowFromData, baseCapabilityCellState } from "@renderer/components/settings/engineCapabilityData.js";
import { BASE_TOOL_CAPABILITY_VIEW } from "@renderer/components/settings/engineCapabilityData.js";
import { readToolNameForTurn } from "@main/lib/systemPrompt.js";

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

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const engines = [...ENGINE_TOOL_ENGINE_IDS] as EngineToolEngineId[];

/* ── 0. 形状：能力 ID 完整、三引擎每格齐全、顺序与契约一致 ── */
check(
  "★ 九个稳定能力 ID 全在(与契约清单一致)",
  JSON.stringify(BASE_TOOL_CAPABILITIES.map((r) => r.id)) === JSON.stringify([...BASE_TOOL_CAPABILITY_IDS]),
  BASE_TOOL_CAPABILITIES.map((r) => r.id),
);
check(
  "★ 每行三个引擎都有格子",
  BASE_TOOL_CAPABILITIES.every((r) => engines.every((e) => r.engines[e] !== undefined)),
);
check(
  "实现形态只允许 native/bridge/none",
  BASE_TOOL_CAPABILITIES.every((r) => engines.every((e) => ["native", "bridge", "none"].includes(r.engines[e].implementation))),
);
check(
  "★ none 格不带工具名；其余格必须有名字",
  BASE_TOOL_CAPABILITIES.every((r) =>
    engines.every((e) => {
      const c = r.engines[e];
      return c.implementation === "none" ? c.toolName === null : typeof c.toolName === "string" && c.toolName.length > 0;
    }),
  ),
  BASE_TOOL_CAPABILITIES.flatMap((r) => engines.map((e) => [r.id, e, r.engines[e]] as const)).filter(([, , c]) => (c.implementation === "none") !== (c.toolName === null)),
);

/* ── 1. Claude / Pi 的 native 格 ↔ KNOWN_BUILTIN_TOOLS ── */
for (const engine of ["claude", "pi"] as const) {
  for (const row of BASE_TOOL_CAPABILITIES) {
    const cell = row.engines[engine];
    if (cell.implementation !== "native") continue;
    check(
      `${engine} · ${row.id} 的 native 工具 ${cell.toolName} 真在 KNOWN_BUILTIN_TOOLS 里`,
      KNOWN_BUILTIN_TOOLS[engine].includes(cell.toolName!),
      KNOWN_BUILTIN_TOOLS[engine],
    );
  }
}

/* ── 2. 浏览器格 ↔ BROWSER_TOOL_SPECS（三家同一实现，注册形态不同） ── */
{
  const browserRow = baseToolCapabilityRow("browser.navigate")!;
  const spec = BROWSER_TOOL_SPECS.browser_navigate;
  check("前提：浏览器规格表里有 browser_navigate", spec !== undefined);
  for (const engine of engines) {
    const cell = browserRow.engines[engine];
    check(`★ ${engine} · 浏览器格是宿主桥`, cell.implementation === "bridge", cell);
    const bare = cell.toolName!.replace(/^mcp__mcode-browser__/, "");
    check(
      `★ ${engine} · 浏览器工具名在真实规格表里(${bare})`,
      spec?.name === bare && bare in BROWSER_TOOL_SPECS,
      { toolName: cell.toolName, specName: spec?.name },
    );
    // Claude 走 MCP 前缀形态，Pi/Codex 用裸名 —— 与三家的注册方式一致。
    if (engine === "claude") check("Claude 浏览器名带 mcp__mcode-browser__ 前缀", cell.toolName!.startsWith("mcp__mcode-browser__"), cell.toolName);
    else check(`${engine} 浏览器名是裸名(动态工具形态)`, !cell.toolName!.startsWith("mcp__"), cell.toolName);
  }
}

/* ── 3. 文档读取格 ↔ agent 桥的真实描述符 ── */
{
  const names = new Set(agentToolDescriptors().map((t) => t.name));
  check("前提：agent 桥确有 agent_read_document", names.has("agent_read_document"), [...names]);
  for (const engine of engines) {
    const cell = baseToolCapabilityRow("document.read")!.engines[engine];
    const bare = cell.toolName!.replace(/^mcp__[^_]+__/, "");
    check(`★ ${engine} · 文档读取指向真实桥工具(agent_read_document)`, bare === "agent_read_document", cell.toolName);
  }
}

/* ── 4. Codex 的 none 格：动态工具表里**确实没有**同名工具 ── */
{
  // 只读 Codex 的动态工具源码（bundle 它会把整个 provider 拖进来）；判据是它
  // 确实不注册 Read/Write/Edit/Grep/Bash 这类名字 —— 名字只来自各描述符表。
  const codexDyn = read("src/main/providers/codex-sdk/CodexDynamicTools.ts");
  for (const id of ["file.read", "file.write", "file.edit", "file.search", "shell.run", "web.fetch", "web.search"] as BaseToolCapabilityId[]) {
    const cell = baseToolCapabilityRow(id)!.engines.codex;
    check(`Codex · ${id} 如实标为 none`, cell.implementation === "none", cell);
    check(`Codex · ${id} 的说明讲清了替代路径(不是空白)`, typeof cell.note === "string" && cell.note.length > 0, cell.note);
  }
  // 反向：Codex 也没有偷偷在别处注册同名文件工具。
  for (const name of ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]) {
    check(
      `Codex 动态工具没有注册 ${name}(能力表说 none 是有依据的)`,
      !codexDyn.includes(`name: "${name}"`) && !codexDyn.includes(`name: '${name}'`),
    );
  }
}

/* ── 5. 提示词派生与表**同一答案**（ARC-003 收口的第二份事实已删） ── */
for (const engine of engines) {
  const fromTable = baseToolNameFor(engine, "file.read");
  const fromPrompt = readToolNameForTurn(engine, []);
  check(`★ 提示词派生的读工具名与能力表一致(${engine})`, fromTable === fromPrompt, { fromTable, fromPrompt });
  if (fromTable !== null) {
    check(`★ 表里的读工具被禁用 → 提示词不点名(${engine})`, readToolNameForTurn(engine, [fromTable]) === null);
  }
}
{
  const src = read("src/main/lib/systemPrompt.ts");
  check(
    "★ 提示词模块不再自带第二份工具名硬编码(不含 '\"Read\"'/'\"read\"' 字面分支)",
    !/engine === "claude"[\s\S]{0,80}?"Read"/.test(src) && src.includes("baseToolNameFor"),
  );
}

/* ── 6. 渲染端视图：同一顺序、同一数据、词条键齐全 ── */
{
  check("视图行数与契约行数一致", BASE_TOOL_CAPABILITY_VIEW.length === BASE_TOOL_CAPABILITIES.length);
  check(
    "视图原样引用契约行(不复制数据)",
    BASE_TOOL_CAPABILITY_VIEW.every((v, i) => v.source === BASE_TOOL_CAPABILITIES[i]),
  );
  check("视图每行都有词条键", BASE_TOOL_CAPABILITY_VIEW.every((v) => typeof v.labelKey === "string" && v.labelKey.startsWith("settings.engineMatrix.base.")));
  const view = rowFromData("file.read" as never);
  check("engineCapabilityData 的读法取到的是同一行", view === BASE_TOOL_CAPABILITIES[0]);
  // 面板真的把这张表画出来（数据在、组件不引用 = 界面上一个字都没有）。
  const matrixSrc = read("src/renderer/components/settings/EngineCapabilityMatrix.tsx");
  check("★ EngineCapabilityMatrix 渲染基础能力表", matrixSrc.includes("BASE_TOOL_CAPABILITY_VIEW") && matrixSrc.includes("baseCapabilityCell("));
  // 三态标记由模板拼出(`base.impl.${impl}`)—— 判据是模板在、且状态并集覆盖三种。
  check(
    "面板对 native/bridge/none 三态各给不同标记",
    matrixSrc.includes("base.impl.${impl}") &&
      ["native", "bridge", "none"].every((k) =>
        BASE_TOOL_CAPABILITIES.some((r) => engines.some((e) => r.engines[e].implementation === k)),
      ),
  );
}

/* ── 7. 【ARC-003 第 4 条】运行期叠加:用户按名禁用的工具在矩阵上必须显式标出 ── */
{
  const readCell = rowFromData("file.read")!.engines.claude;
  const on = baseCapabilityCellState(readCell, []);
  check("未禁用 → 不标 disabledByPolicy", on.disabledByPolicy === false && on.toolName === "Read", on);
  const off = baseCapabilityCellState(readCell, ["Read"]);
  check("★ Claude 禁用 Read → 该格标 disabledByPolicy(静态声明不冒充可用)", off.disabledByPolicy === true && off.toolName === "Read", off);
  check("禁用无关工具不影响该格", baseCapabilityCellState(readCell, ["Bash"]).disabledByPolicy === false);
  check("★ 大小写不同不命中(工具名逐字比对)", baseCapabilityCellState(readCell, ["read"]).disabledByPolicy === false);
  const docCell = rowFromData("document.read")!.engines.claude;
  check("宿主桥格不被引擎排除表误标", baseCapabilityCellState(docCell, [docCell.toolName ?? ""]).disabledByPolicy === false);
  const codexShell = rowFromData("shell.run")!.engines.codex;
  check("none 格不被误标", baseCapabilityCellState(codexShell, ["whatever"]).disabledByPolicy === false);
  const panelSrc = read("src/renderer/components/settings/EngineToolsPanel.tsx");
  check("★ EngineToolsPanel 把三引擎排除表传给矩阵", /<EngineCapabilityMatrix[\s\S]{0,400}?excludedByEngine/.test(panelSrc));
  const matrixSrc2 = read("src/renderer/components/settings/EngineCapabilityMatrix.tsx");
  check("★ 矩阵组件消费 excludedByEngine 并渲染 disabledByPolicy", matrixSrc2.includes("excludedByEngine?.[engine]") && matrixSrc2.includes("disabledByPolicy"));
}

/* ── 8. 【ARC-003 验收】提示词宣称的每个工具名,都必须在该回合的有效清单里 ── */
{
  // 台账原文:「assembledPrompt 所宣称的每一"可调用工具名"都存在于该回合可见清单」。
  // 这里把三段真实渲染器接起来验同一件事:
  //   ① 清单来自 `buildEngineToolInventory`(各 provider 同一份装配来源);
  //   ② 提示词来自 `fileArchitecturePrompt` / `claudePlanModeNudge`(真实纯函数);
  //   ③ 判据是**集合包含**:提示词点名了清单里没有的名字 = 广告了不存在的工具。
  const { buildEngineToolInventory } = await import("@main/orchestration/effectiveToolInventory.js");
  const { claudePlanModeNudge, fileArchitecturePrompt: renderArch } = await import("@main/lib/systemPrompt.js");
  const inventoryNames = (engine: "claude" | "pi" | "codex", excluded: string[] = []): Set<string> =>
    new Set(buildEngineToolInventory(engine, { browserEnabled: true, excluded }).tools.map((t) => t.name));

  // ① Claude:读工具 + 计划模式那段点名的四件,全部在清单里。
  {
    const names = inventoryNames("claude");
    const read = readToolNameForTurn("claude", []);
    check("★ Claude 提示词点名的读工具在有效清单里", read !== null && names.has(read), { read });
    const nudge = claudePlanModeNudge([]);
    const advertised = ["Read", "Grep", "Glob", "WebSearch"].filter((n) => nudge.includes(n));
    check("计划模式 nudge 确实点了名(防空过)", advertised.length === 4, advertised);
    check("★ Claude 计划模式点名的每个工具都在有效清单里", advertised.every((n) => names.has(n)), advertised.filter((n) => !names.has(n)));
  }

  // ② Pi:读工具是小写 `read`,且清单里**没有** Claude 的大写 `Read` —— 提示词不许点名后者。
  {
    const names = inventoryNames("pi");
    const read = readToolNameForTurn("pi", []);
    check("★ Pi 提示词点名的读工具在有效清单里", read !== null && names.has(read), { read });
    check("Pi 清单里没有 Claude 的大写 Read(夹具前提)", !names.has("Read"));
  }

  // ③ Codex:没有独立读工具 → 提示词不点名;若点名了就必须在清单里(这里是空集断言)。
  {
    const names = inventoryNames("codex");
    check("★ Codex 读工具名为 null 且提示词不点名任何特定读工具", readToolNameForTurn("codex", []) === null && !names.has("Read") && !names.has("read"));
  }

  // ④ 禁用后:提示词不再点名,且清单里也真的没有它(两层一致,不是各说各话)。
  {
    const names = inventoryNames("claude", ["Read"]);
    const read = readToolNameForTurn("claude", ["Read"]);
    check("★ Claude 禁用 Read 后:提示词不点名且清单里也没有", read === null && !names.has("Read"), { read, listed: names.has("Read") });
    const nudge = claudePlanModeNudge(["WebSearch"]);
    // 清单也要按**同一张排除表**装配(不能拿"禁了 Read"的清单去要求 Read 在场)。
    const namesNoSearch = inventoryNames("claude", ["WebSearch"]);
    check(
      "★ 禁用 WebSearch 后 nudge 不再点名它且其余仍在清单",
      !nudge.includes("WebSearch") && !namesNoSearch.has("WebSearch") && ["Read", "Grep", "Glob"].every((n) => namesNoSearch.has(n)),
      { nudge, listed: [...namesNoSearch].filter((n) => /^(Read|Grep|Glob|WebSearch)$/.test(n)) },
    );
  }

  // ⑤ 浏览器开关:关掉时 browser_* 不在清单里 —— 提示词/文档若宣称浏览器能力,
  //    依据必须是开关后的清单,不是静态表。这里钉清单本身的开关语义(ARC-003 第 3 条)。
  {
    const off = new Set(buildEngineToolInventory("claude", { browserEnabled: false }).tools.map((t) => t.name));
    const on = inventoryNames("claude");
    const browserNames = [...on].filter((n) => n.includes("browser_"));
    check("浏览器关时清单里没有任何 browser_* 工具", browserNames.length > 0 && browserNames.every((n) => !off.has(n)), browserNames.filter((n) => off.has(n)));
  }

  // ⑥b.【MC-006】通用系统提示词**不许**含具体领域的脚本名/领域词。
  // 台账第十六轮复核的失败判据:真实 `fileArchitecturePrompt` 输出里出现了
  // `check_citations.py` 与「写作的引用核对」。断言立在**渲染后的正文**上(不是源码),
  // 三个引擎逐一核对 —— 三个 SDK 注入的是同一段正文,一个引擎看到就等于都看到。
  {
    const forbidden: Array<[string, RegExp]> = [
      ["具体脚本名 check_citations.py", /check_citations\.py/],
      ["学术引用核对", /引用核对|citation check/i],
      ["论文/学术/文献综述等学术场景词", /论文|学术|文献综述|paper writing|academic/i],
      ["研究项目模板术语", /refs\.bib|BibTeX/i],
    ];
    for (const engine of ["claude", "pi", "codex"] as const) {
      const body = renderArch("C:", "C:\s", engine);
      // 防空过:正文确实是一大段(includes 树结构),不是空串。
      check(`MC-006 提示词正文非空(${engine})`, body.includes("mcode.db") && body.includes("library.py"), body.length);
      for (const [label, pattern] of forbidden) {
        check(`★ MC-006 通用提示词不含${label}(${engine})`, !pattern.test(body), body.match(pattern)?.[0]);
      }
    }
    // 反向正控:领域词**出现**时这套判据真的抓得到(防止正则写错永远不匹配)。
    check("★ MC-006 判据本身能抓到领域词(正控)", /check_citations\.py/.test("…运行 check_citations.py …"));
  }

  // ⑥ 渲染面不变:提示词里点名读工具的那句话,引擎换掉时名字跟着换(同一渲染器,不是两份)。
  {
    const claudePrompt = renderArch("C:\f", "C:\f\s", "claude");
    const piPrompt = renderArch("C:\f", "C:\f\s", "pi");
    check("★ 同一渲染器按引擎给出不同读工具名", claudePrompt.includes("先 Read 它") && piPrompt.includes("先 read 它") && !piPrompt.includes("先 Read 它"));
  }
}

/* ── 9. 【MC-043 验收】面板提供「编辑 / 还原默认」,且还原不是第二套存储 ── */
{
  const panelSrc = read("src/renderer/components/settings/EngineToolsPanel.tsx");
  check("★ 面板有「还原为内置说明」按钮", panelSrc.includes("guidanceReset") && /setGuidance\(""\)/.test(panelSrc));
  check("★ 还原走同一份状态(清空 = 从未写过),不另建存储", !/guidanceDefault|defaultGuidance/.test(panelSrc));
}

console.log(`\nbase-capability-matrix-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
