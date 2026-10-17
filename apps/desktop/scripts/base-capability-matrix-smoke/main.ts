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
import { baseCapabilityRow as rowFromData } from "@renderer/components/settings/engineCapabilityData.js";
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

console.log(`\nbase-capability-matrix-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
