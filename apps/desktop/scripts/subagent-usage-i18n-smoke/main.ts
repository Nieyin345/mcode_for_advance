/**
 * subagent-usage-i18n-smoke — 子代理用量串上的硬编码英文(activityShared.ts + ActivityConsole)。
 *
 * ## 盯的是什么
 *
 * 子代理头部 / 列表里那段「用量」串,两处实现都把**单位词写死成英文**:
 *
 *   - `activityShared.ts` 的 `fmtUsage()`:`` `${n}k tokens` `` / `` `${n} tools` ``
 *     —— SideChatPanel 用它画子代理头(行 351、582);
 *   - `ActivityConsole.tsx` 的 SubagentRow chips:`` `${n}k tok` `` / `` `${n} tools` ``
 *     与汇总 Stat 的 `label="tok"` / `label="tools"`。
 *
 * 症状:中文界面上,子代理旁边就嵌着一段英文("1.2k tokens · 5 tools")。仓库对这段话
 * **早有定论** —— `ide.turns.subagentDetail` 逐字是「{tokens} tokens · {tools} 次工具 ·
 * {dur}」,即中文里"次工具"才是对的说法。而且两处实现还**互相打架**:同一件事一个是
 * `tokens`、一个是 `tok`(硬规矩 2:同一条规矩只有一份实现)。
 *
 * ## 判据
 *
 * 立在**用户看到的那条串**上,而不是"有没有调用 t":
 *
 *   ① zh 下 `fmtUsage` 里含「次工具」,且**不含** `tools`;
 *   ② en 下含 `tools`(英文界面该是英文);
 *   ③ zh 下单位词取自词典(`statToolsUnit` = 「次工具」、`statTokUnit` = `tokens`),
 *      而不是写死的 `tools` / `tok` —— 这两条直接盖住 ActivityConsole 那两组 label;
 *   ④ 时长那段两端一致(本地化不该把 `12s` 这种数字段弄丢)。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `activityShared.ts` 与真 i18n core;`@tabler/icons-react` 换空壳 barrel
 * (几千导出,打进来只让这套变慢)。不起浏览器、不写盘。
 *
 * Run: scripts/subagent-usage-i18n-smoke/run.sh
 */
import "./prelude.js";
import { fmtUsage, usageUnits } from "@renderer/components/chat/activityShared.js";
import { translate } from "@renderer/lib/i18n/core.js";
import type { SubagentSnapshot } from "@contracts/runtime";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const snap = { totalTokens: 1234, toolUses: 5, durationMs: 12_000 } as unknown as SubagentSnapshot;

const zh = translate.bind(null, "zh") as (k: never, p?: Record<string, string | number>) => string;
const en = translate.bind(null, "en") as (k: never, p?: Record<string, string | number>) => string;

// ① zh:单位词是中文「次工具」,且绝不出现英文 tools。
{
  const s = fmtUsage(snap, zh as never);
  check("★ zh 下用量串含「次工具」", s.includes("次工具"), s);
  check("★ zh 下用量串不含写死的英文 tools", !s.includes("tools"), s);
  check("zh 下仍带 token 数(1.2k)", s.includes("1.2k"), s);
  check("zh 下仍带时长(12s)", s.includes("12s"), s);
}

// ② en:英文界面该是英文。
{
  const s = fmtUsage(snap, en as never);
  check("en 下用量串含 tools", s.includes("tools"), s);
  check("en 下用量串含 tokens", s.includes("tokens"), s);
}

// ③ ActivityConsole 的 chips 走**同一个** `usageUnits`(硬规矩 2:只有一份实现),
//    于是那两组单位词也在这套里被真盖住 —— 不是去测词典,而是测那段拼装。
{
  const zhUnits = usageUnits(zh as never, 1234, 5);
  const enUnits = usageUnits(en as never, 1234, 5);
  check("★ zh:chips 的工具单位来自 usageUnits 且是「次工具」", zhUnits.some((u) => u.includes("次工具")), zhUnits);
  check("★ zh:chips 里不含写死的英文 tools", !zhUnits.join(" ").includes("tools"), zhUnits);
  check("en:chips 的工具单位是 tools", enUnits.some((u) => u.includes("tools")), enUnits);
  // 子代理头与列表 chips 是**同一份**拼装 —— 撤掉共享实现(各写一份)时这条会红。
  check(
    "★ 头部串包含 chips 的每一段(同一份 usageUnits)",
    zhUnits.every((u) => fmtUsage(snap, zh as never).includes(u)),
    { usage: fmtUsage(snap, zh as never), zhUnits },
  );
}

console.log(`\nsubagent-usage-i18n-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
