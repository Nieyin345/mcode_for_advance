/**
 * 【T136】设置页三处 token 的判据。
 *
 * 这三处都是「一行改动，全局生效」的位置 —— 设置页每个子页面都会走到：
 *
 *   1. `PanelHeader` 的页面标题 → `text-heading`（16/20）
 *   2. `SettingRow` 的表单主文字 → `text-body`（14/20）
 *   3. 导航轨（recess）与内容区（canvas）必须是**不同的** Surface 层
 *
 * ## 为什么用 `sourceHas` 而不是 `includes`
 *
 * T119 的 94 处断言栽在「注释里的文字也算命中」上。这三处的旧写法都会留在注释里
 * 解释历史（「原来是 --chat-fs-sm」），裸 `includes` 会把解释当成代码。
 *
 * ## 为什么还要断言「档位在 tailwind.config.js 里存在」
 *
 * `text-heading` 是个**不存在的类**时，Tailwind 什么都不生成，浏览器也不会报错 ——
 * 组件看起来只是「字号没变」。那种失效和「改对了但观感没差别」在截图里一模一样。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceHas } from "../lib/sourceText.js";

// run.sh 会先 `cd` 到 apps/desktop —— 用 cwd 而不是 import.meta.url。
// 打包产物在临时目录里，`import.meta.url` 指向那里，不是仓库。
const APP = resolve(process.cwd());
const REPO = resolve(APP, "../..");
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const panelHeader = read("apps/desktop/src/renderer/components/settings/PanelHeader.tsx");
const settingRow = read("apps/desktop/src/renderer/components/settings/SettingRow.tsx");
const settingsPage = read("apps/desktop/src/renderer/components/settings/SettingsPage.tsx");
const tailwind = read("apps/desktop/tailwind.config.js");

console.log("\n[1] 页面标题走 heading 档");

check(
  "★ PanelHeader 的标题用 text-heading",
  sourceHas(panelHeader, 'text-heading font-semibold'),
  { hint: "期望 `text-heading font-semibold text-content`" },
);
check(
  "★ PanelHeader 不再用 --chat-fs-sm",
  !sourceHas(panelHeader, "text-[length:var(--chat-fs-sm)]"),
  { hint: "旧写法会把设置页标题绑到对话字号上" },
);

console.log("\n[2] 表单主文字走 body 档");

check(
  "★ SettingRow 的标题用 text-body",
  sourceHas(settingRow, "text-body font-medium"),
  { hint: "期望 `text-body font-medium text-content`" },
);
check(
  "★ SettingRow 不再用 --chat-fs-xs",
  !sourceHas(settingRow, "text-[length:var(--chat-fs-xs)]"),
  { hint: "12px 且跟随对话字号，两处都不对" },
);

console.log("\n[3] 导航轨与内容区是两个 Surface 层");

check(
  "导航轨是 recess（bg-surface-muted）",
  sourceHas(settingsPage, "border-r border-edge bg-surface-muted px-3 py-4"),
);
check(
  "内容区是 canvas（bg-surface）",
  sourceHas(settingsPage, "overflow-y-auto bg-surface px-6 pb-5"),
);
check(
  "★ 内容区不再叠 alpha（bg-surface-muted/20 会让层次反过来）",
  !sourceHas(settingsPage, "bg-surface-muted/20"),
);

console.log("\n[4] 用到的档位在 tailwind.config.js 里真的存在");

// ⚠️ 只断言**键存在**，不断言值。
//
// 第一版写的是 `/body:\s*\["14px"/`，于是「把 body 改成 15px」这条负控会红 ——
// 而那不该红：本套管的是「设置页有没有用这个档位」，不是「档位值是多少」。
// 值属于 T121 的 `font-scale-smoke`（它有一条专门钉 `body = 14px / 20px`）。
// 两个套件各守一层，混在一起会让任一侧改值都误伤另一个。
check("fontSize.heading 键存在", /heading:\s*\[\s*"/.test(tailwind));
check("fontSize.body 键存在", /body:\s*\[\s*"/.test(tailwind));

console.log("\n[5] 负控：这三处只管自己");

check(
  "PanelHeader 不含 SettingRow 的写法（两者不该互相污染）",
  !sourceHas(panelHeader, "text-body font-medium"),
);

console.log(`\nsettings-tokens-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
