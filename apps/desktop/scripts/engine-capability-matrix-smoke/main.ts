/**
 * 「能力 × 引擎」矩阵的回归 —— `renderer/components/settings/engineCapabilityData.ts`。
 *
 * ## 为什么钉这里
 *
 * 这张矩阵是**汇总视图**:技能 / 斜杠命令 / 子代理 / MCP / 引擎 hooks / 按名禁用工具
 * 六行能力的真相,分别散在 `lib/skillEngines.ts`、各 provider 的 `capabilities` 与
 * `listCommands()`、`lib/mcpEngines.ts`、`lib/engineToolPolicy.ts`、`@contracts/plugin`。
 * 矩阵把结论抄了一份摆到用户面前 —— 于是有了两类会**静默漂移**的失败面:
 *
 *   ① 某引擎的真实能力翻转了(比如 Pi 忽然支持 MCP),矩阵没跟着改 —— 用户看到的
 *      是一张**过期的**表,比没有表更糟。
 *   ② 面板**没渲染**这张表,或它的 i18n 词条缺了 —— 矩阵数据在、界面上什么都不显示
 *      (本仓库踩过的"登记了却没人命中"那一类)。
 *
 * 所以每一格都跟**它的真实来源**对账,并在源码层面钉住面板的接线。
 *
 * ## 它怎么跑
 *
 * esbuild 打包**纯**模块(矩阵数据 + `skillEngines` / `mcpEngines` / `engineToolPolicy`
 * 三个纯核,都不 import electron),provider 的能力面读其源码字面量(bundle 三个
 * provider 会把 SDK / electron 拖进来)。不起 Electron、不写盘、不碰 `~/.mcode`。
 *
 * Run: scripts/engine-capability-matrix-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENGINE_CAPABILITY_ENGINES,
  ENGINE_CAPABILITY_MATRIX,
  supportsCapability,
  type MatrixEngineId,
} from "@renderer/components/settings/engineCapabilityData.js";
import { SKILL_ENGINES } from "@main/lib/skillEngines.js";
import { MCP_ENGINES } from "@main/lib/mcpEngines.js";
import { engineSupportsToolExclusion } from "@main/lib/engineToolPolicy.js";
import { translate } from "@renderer/lib/i18n/core.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 某行某格的矩阵取值。行按 labelKey 找,避免下标漂移。 */
function cell(labelKey: string, engine: MatrixEngineId): boolean {
  const row = ENGINE_CAPABILITY_MATRIX.find((r) => r.labelKey === labelKey);
  if (!row) throw new Error(`矩阵里没有这一行:${labelKey}`);
  return supportsCapability(row, engine);
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const claudeSrc = read("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
const codexSrc = read("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
const piSrc = read("src/main/providers/pi-sdk/PiAgentSdkProvider.ts");
const pluginSrc = read("../../packages/contracts/src/plugin.ts");

/* ── 0. 形状:三列、六行能力 ── */
check("三列引擎 = claude/codex/pi", JSON.stringify([...ENGINE_CAPABILITY_ENGINES]) === JSON.stringify(["claude", "codex", "pi"]));
check("每行的 support 都覆盖三个引擎", ENGINE_CAPABILITY_MATRIX.every((r) => ENGINE_CAPABILITY_ENGINES.every((e) => typeof r.support[e] === "boolean")));

/* ── 1. 技能:三引擎共用技能库 ── */
for (const e of ENGINE_CAPABILITY_ENGINES) {
  check(
    `技能[${e}] = SKILL_ENGINES 含 ${e}`,
    cell("settings.engineMatrix.cap.skills", e) === (SKILL_ENGINES as readonly string[]).includes(e),
  );
}

/* ── 2. 斜杠命令:只有 Claude 经 Mcode 的协议拿得到清单 ── */
check("命令[claude] = true", cell("settings.engineMatrix.cap.commands", "claude") === true);
check(
  "命令[claude] 与源码一致(listCommands 返回 supported:true)",
  /supported:\s*true/.test(claudeSrc),
);
check("命令[codex] = false", cell("settings.engineMatrix.cap.commands", "codex") === false);
check("命令[pi] = false", cell("settings.engineMatrix.cap.commands", "pi") === false);
check(
  "命令[codex]/[pi] 与源码一致(两家 listCommands 返回 supported:false)",
  codexSrc.includes("supported: false, commands: []") &&
    piSrc.includes("supported: false, commands: []"),
);

/* ── 3. 子代理:只有 Claude 声明 supportsCustomSubagents ── */
check("子代理[claude] = true", cell("settings.engineMatrix.cap.subagents", "claude") === true);
check("子代理[codex] = false", cell("settings.engineMatrix.cap.subagents", "codex") === false);
check("子代理[pi] = false", cell("settings.engineMatrix.cap.subagents", "pi") === false);
check("子代理[claude] 与源码一致(claude 声明 supportsCustomSubagents:true)", /supportsCustomSubagents:\s*true/.test(claudeSrc));
check(
  "子代理[codex]/[pi] 与源码一致(两家都不声明 supportsCustomSubagents)",
  !codexSrc.includes("supportsCustomSubagents") && !piSrc.includes("supportsCustomSubagents"),
);

/* ── 4. MCP:claude/codex 有,pi 没有 ── */
check("MCP[claude] = true", cell("settings.engineMatrix.cap.mcp", "claude") === true);
check("MCP[codex] = true", cell("settings.engineMatrix.cap.mcp", "codex") === true);
check("MCP[pi] = false", cell("settings.engineMatrix.cap.mcp", "pi") === false);
check(
  "MCP 列与 MCP_ENGINES 一致(claude/codex)",
  (MCP_ENGINES as readonly string[]).includes("claude") &&
    (MCP_ENGINES as readonly string[]).includes("codex") &&
    !(MCP_ENGINES as readonly string[]).includes("pi"),
);
check(
  "MCP[pi] 与源码一致(pi 声明 supportsMcp:false)",
  /supportsMcp:\s*false/.test(piSrc) && /supportsMcp:\s*true/.test(codexSrc) && /supportsMcp:\s*true/.test(claudeSrc),
);

/* ── 5. 引擎原生 / 插件 hooks:三个引擎都不执行 ── */
for (const e of ENGINE_CAPABILITY_ENGINES) {
  check(`hooks[${e}] = false`, cell("settings.engineMatrix.cap.hooks", e) === false);
}
// ⚠️ 锚点必须钉**hooks 那句**:`plugin.ts` 里有两处「没有引擎能跑它们」的措辞 ——
//   一处讲 hooks(前导注释那段 `held OFF in v1 via disableAllHooks` / 组件字段那段
//   `never executes them`,:262),另一处讲 Codex 的 `apps` 字段(:152)。从前这条断言
//   用的正则是 `no Mcode engine can run them`,而那句**只在 apps 字段的注释里** ——
//   结果是:改掉 hooks 的真注释,套件照样绿(假绿);改 apps 注释才变红。现在钉 hooks
//   的真依据(disableAllHooks + never executes),与矩阵那一行的语义对齐。
check(
  "hooks 全 false 与源码一致(@contracts/plugin 说明 hooks 被 disableAllHooks 关掉、不执行)",
  /held OFF in v1 via `disableAllHooks`/.test(pluginSrc) || /never executes them/.test(pluginSrc),
);

/* ── 6. 按名禁用内置工具:Claude / Pi 能,Codex 只有沙箱/审批档 ── */
for (const e of ENGINE_CAPABILITY_ENGINES) {
  check(
    `按名禁用工具[${e}] = engineSupportsToolExclusion(${e})`,
    cell("settings.engineMatrix.cap.toolExclusion", e) === engineSupportsToolExclusion(e),
  );
}
check("按名禁用工具:claude 支持", engineSupportsToolExclusion("claude"));
check("按名禁用工具:pi 支持", engineSupportsToolExclusion("pi"));
check("按名禁用工具:codex 不支持", !engineSupportsToolExclusion("codex"));

/* ── 7. 词条:每行标签 + 说明都真的解析出来了(没解析出来时 translate 回吐 key) ── */
for (const row of ENGINE_CAPABILITY_MATRIX) {
  for (const key of [row.labelKey, row.noteKey].filter(Boolean) as string[]) {
    const zh = translate("zh", key as never);
    const en = translate("en", key as never);
    check(`zh 词条存在:${key}`, zh !== key && zh.trim().length > 0, zh);
    check(`en 词条存在:${key}`, en !== key && en.trim().length > 0, en);
  }
}

/* ── 8. 面板真的渲染这张表(词条在、数据在,面板不引用 = 界面上一个字都没有) ── */
{
  const panelSrc = read("src/renderer/components/settings/EngineToolsPanel.tsx");
  check("EngineToolsPanel 渲染了 <EngineCapabilityMatrix />", panelSrc.includes("<EngineCapabilityMatrix"));
  const matrixSrc = read("src/renderer/components/settings/EngineCapabilityMatrix.tsx");
  check("组件引用了矩阵数据模块", matrixSrc.includes("engineCapabilityData.js"));
  check("组件对每行逐格读 supportsCapability", matrixSrc.includes("supportsCapability("));

  /* 【MC-071】策略文件损坏必须**显式出现在界面上** —— 契约把 status/recovered 带出来了
     (`EngineToolsSnapshot`),但若面板不消费它,用户看到的就是"没限制",而引擎那边其实
     按不设限或旧策略在跑。判据立在**面板真的读了 status 且两种分支各有文案**。 */
  check("★ 面板消费策略 status 并显示损坏告警", panelSrc.includes('snap?.status === "INVALID"'));
  check(
    "★ 面板对 recovered / 无备份两种事实各给一条文案(不笼统一句)",
    panelSrc.includes("policyCorruptRecovered") && panelSrc.includes("policyCorruptNoBackup"),
  );
  for (const key of ["settings.engineTools.policyCorruptRecovered", "settings.engineTools.policyCorruptNoBackup"] as const) {
    for (const lang of ["zh", "en"] as const) {
      const v = translate(lang, key as never);
      check(`${lang} 词条存在:${key}`, v !== key && v.trim().length > 0, v);
    }
  }
}

console.log(`\nengine-capability-matrix-smoke: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exitCode = 1;
