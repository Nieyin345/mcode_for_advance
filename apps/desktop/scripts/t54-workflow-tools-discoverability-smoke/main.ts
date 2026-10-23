/**
 * 【T54】**可发现性**：让模型知道 `mcode-workflow` 那套工具存在。
 *
 * ## 盯的缺陷
 *
 * 这个软件有**两套工具面**：
 *   - appControl（`apiCatalog.generated.ts` → `app_api_list` / `app_api_call`）：RPC 方法；
 *   - `mcode-workflow` MCP server（`mcp/mcodeServer.ts` 的 `workflowMcpTools()`）：
 *     `node_types_list` / `workflow_save` … 14 个**工具**。
 *
 * 后者**不在** `app_api_call` 的调用面里，所以 `app_api_list` 按名字一个都搜不到。
 * 实测后果：有人找「AI 能不能看工作流节点」，在 `app_api_list` 里零命中 →
 * 得出「没有这个能力」的结论 —— 而 `node_types_list` 早就挂在三家引擎上了。
 *
 * ## 本套钉住什么
 *
 * 1. **`app_api_list` 的「几道门」说明里点名了 mcode-workflow**（路线 A）；
 * 2. **`app_guide({topic:"workflow-tools"})` 能取到清单**（路线 B）；
 * 3. **那份清单与 `workflowMcpTools()` 的实际返回逐条一致** —— 这是本套最值钱的一条：
 *    两份清单分开维护必然漂，套件把它们钉在一起；
 * 4. **清单里的名字不在 `app_api_call` 的目录里**（证明它确实是另一道门，而不是重复登记）；
 * 5. **只读/需批准的分档与 `WORKFLOW_READONLY_TOOLS` 一致**。
 */
import assert from "node:assert/strict";
import { API_CATALOG } from "@main/appControl/apiCatalog.generated.js";
import { WORKFLOW_TOOL_SURFACE } from "@main/appControl/guide.js";
import { workflowMcpTools, WORKFLOW_READONLY_TOOLS } from "@main/mcp/mcodeServer.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

/* ── 1. 清单与真实工具面逐条一致（本套最值钱的一条） ────────── */

console.log("\n① 清单与 workflowMcpTools() 一致");
{
  const real = workflowMcpTools().map((t) => t.name).sort();
  const declared = WORKFLOW_TOOL_SURFACE.map((t) => t.name).sort();
  check(
    "★ 声明的清单条数 == 真实工具数",
    declared.length === real.length,
    { declared: declared.length, real: real.length },
  );
  check(
    "★ 没有漏声明的工具（真实有、清单没有）",
    real.every((n) => declared.includes(n)),
    { missingFromList: real.filter((n) => !declared.includes(n)) },
  );
  check(
    "★ 没有凭空多出来的工具（清单有、真实没有）",
    declared.every((n) => real.includes(n)),
    { extraInList: declared.filter((n) => !real.includes(n)) },
  );
  // 防空过：这两个工具是这张卡的由头，必须真在。
  check("★ node_types_list 在清单里（T48 的由头）", declared.includes("node_types_list"));
  check("★ workflow_save 在清单里（写工作流的入口）", declared.includes("workflow_save"));
}

/* ── 2. 只读/需批准分档与 WORKFLOW_READONLY_TOOLS 一致 ──────── */

console.log("\n② 分档与 WORKFLOW_READONLY_TOOLS 一致");
{
  const mismatched = WORKFLOW_TOOL_SURFACE.filter((t) => t.readonly_ !== WORKFLOW_READONLY_TOOLS.has(t.name));
  check(
    "★ 每条「只读」标注与 WORKFLOW_READONLY_TOOLS 完全一致",
    mismatched.length === 0,
    mismatched.map((t) => `${t.name}: list=${t.readonly_} real=${WORKFLOW_READONLY_TOOLS.has(t.name)}`),
  );
  check(
    "只读工具确实存在（不是空集）",
    WORKFLOW_TOOL_SURFACE.some((t) => t.readonly_),
  );
  check(
    "需批准的工具确实存在（证明不只是只读那一半）",
    WORKFLOW_TOOL_SURFACE.some((t) => !t.readonly_),
  );
}

/* ── 3. 它们确实不在 app_api_call 的目录里（证明是「另一道门」） ── */

console.log("\n③ 这些工具不是 RPC 方法");
{
  const methods = new Set(API_CATALOG.map((e) => e.method));
  const asRpc = WORKFLOW_TOOL_SURFACE.filter((t) => methods.has(t.name));
  check(
    "★ 清单里没有任何一个名字同时是 RPC 方法（否则就是另一回事）",
    asRpc.length === 0,
    asRpc.map((t) => t.name),
  );
  // 反向对照：`workflow.save` 是 RPC，`workflow_save` 是工具 —— 名字相近但不是同一个。
  check(
    "对照:`workflow.save` 是 RPC，`workflow_save` 是工具（两者都在，不混淆）",
    methods.has("workflow.save") && !methods.has("workflow_save"),
  );
}

/* ── 4. app_api_list 的「几道门」说明点名 mcode-workflow ─────── */

console.log("\n④ app_api_list 指路");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/main/appControl/tools.ts", "utf8");
  // ⚠️ **不能只锚 `⑥`** —— 这个文件里还有另外两处 `⑥`（`modules.install` 的注释、
  // workshop 的对账步骤）。第一次写这条断言时正则 `⑥[^\\]*` 就在那里误命中了，
  // 变异测试把这个坑照出来了。所以锚**整段**：门号那一行起，到「要找**有没有**」为止
  //（那句是本段说明的收尾，跨行内容都在中间）。
  const gateStart = src.indexOf('"  ⑥ **看/写工作流本身**');
  const gateEnd = gateStart >= 0 ? src.indexOf("要找**有没有**某个能力", gateStart) : -1;
  const gateBlock = gateStart >= 0 && gateEnd > gateStart ? src.slice(gateStart, gateEnd) : "";
  check(
    "★ 无参数说明里有第六道门（看/写工作流本身）",
    gateBlock.length > 0 && gateBlock.includes("节点类型"),
    { matched: gateBlock.slice(0, 100) || "(没匹配到)" },
  );
  check(
    "★ 那道门点名了 node_types_list / workflow_save",
    gateBlock.includes("node_types_list") && gateBlock.includes("workflow_save"),
    { matched: gateBlock.slice(0, 200) || "(没匹配到)" },
  );
  check(
    "★ 明确写了「不是 app_api_call 的方法」（防模型误用）",
    gateBlock.includes("**不是** app_api_call 的方法"),
    { matched: gateBlock.slice(0, 240) || "(没匹配到)" },
  );
  check(
    "★ 指向了 app_guide({topic:\\\"workflow-tools\\\"})",
    gateBlock.includes('app_guide({topic:\\"workflow-tools\\"})'),
    { matched: gateBlock.slice(0, 240) || "(没匹配到)" },
  );
  // 防空过:那道门必须**真的**在 app_api_list 的说明串里 —— 不是散落在文件某处。
  // 判据:它前面 1500 字内必须出现同一段说明里的邻居（`app_panel_api_list` 那道门）。
  {
    const window = gateStart >= 0 ? src.slice(Math.max(0, gateStart - 1500), gateStart + 500) : "";
    check(
      "★ 那段话确实在 app_api_list 的说明串里（不是别处的注释）",
      window.includes("app_panel_api_list") || window.includes("不带参数列全部 topic"),
      { found: gateStart >= 0, context: window.slice(-200) },
    );
  }
}

/* ── 5. 空白检查：清单里的说明不是空串 ─────────────────────── */

console.log("\n⑤ 文档质量");
{
  const empty = WORKFLOW_TOOL_SURFACE.filter((t) => !t.summary.trim());
  check("每条工具都有非空的一句说明", empty.length === 0, empty.map((t) => t.name));
  const short = WORKFLOW_TOOL_SURFACE.filter((t) => t.summary.trim().length < 8);
  check("说明不是敷衍的两个字", short.length === 0, short.map((t) => `${t.name}:${t.summary}`));
}

console.log(`\nt54-workflow-tools-discoverability-smoke: ${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
