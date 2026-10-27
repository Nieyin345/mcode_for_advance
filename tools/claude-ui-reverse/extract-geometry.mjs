/**
 * 从 UI 骨架的 className 里抽出**写死的几何常量**，聚合成一张表。
 *
 * 为什么不包含 `var(--df-row-h)` 这类：
 *   它们在 CSS 里**没有默认值**，JS 里也没有赋值 ——
 *   是运行时 `getComputedStyle` 算出来的（`shared-46` 里有转发代码）。
 *   **静态拿不到，硬猜就是造假。** 见 README「必须跑起来才能拿的」一节。
 *
 * 本脚本只收「类名本身就定死了数值」的那些：
 *   `w-[280px]` `h-[36px]` `size-5` `gap-2.5` `px-3` `rounded-lg` …
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { resolveClass, evalLength } from "./resolve-class.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);
const ASSETS =
  "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

/** 每个区域的特征词 + 说明。 */
const REGIONS = [
  ["标题栏 titlebar", /dframe-chrome-bar|Titlebar|titlebar|drag-region/],
  ["侧栏·会话轨 session-rail", /session-rail|EpitaxySessionRailHost|df-row-|df-leading-slot/],
  ["侧栏·搜索", /df-search-field|command_palette.*search/],
  ["侧栏·底部用户区", /df-user-menu-btn|df-footer-btn-size/],
  ["消息区·容器", /epitaxy-transcript|EpitaxyTranscriptHost/],
  ["消息区·回合", /EpitaxyTurnBox|turn-status|TurnStatus/],
  ["输入框", /ChatComposerDock|epitaxy-sticky-prompt|composer-action-row|ChatComposerChin/],
  ["面板", /data-cds=Panel|PanelHost|side-panel/],
];

/** 所有 chunk，按大小降序（大的先，命中率高）。 */
const files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: statSync(join(ASSETS, f)).size }))
  .sort((a, b) => b.size - a.size);

/**
 * 只保留「自己能算出 px」的类。
 * 返回 `{ w:[], h:[], pad:[], gap:[], radius:[], font:[] }` 形式的量清单。
 */
function sizesOf(classString) {
  const out = { width: [], height: [], padding: [], gap: [], radius: [], fontSize: [] };
  for (const cls of classString.split(/\s+/)) {
    const d = resolveClass(cls);
    if (!d) continue;
    for (const [prop, raw] of Object.entries(d)) {
      const { px } = evalLength(raw);
      if (px == null) continue;            // 解不开的一律丢掉，不猜
      const bucket =
        prop === "width" || prop === "min-width" || prop === "max-width" ? "width" :
        prop === "height" || prop === "min-height" || prop === "max-height" ? "height" :
        prop.startsWith("padding") || prop === "margin" || prop.startsWith("margin") ? "padding" :
        prop === "gap" || prop.endsWith("gap") ? "gap" :
        prop === "border-radius" ? "radius" :
        prop === "font-size" ? "fontSize" : null;
      if (!bucket) continue;
      out[bucket].push({ cls, prop, px });
    }
  }
  return out;
}

const table = new Map();   // region -> Map(`${bucket}|${prop}` -> Map(px -> Set(cls)))

for (const { f } of files) {
  let src;
  try { src = readFileSync(join(ASSETS, f), "utf8"); } catch { continue; }

  for (const m of src.matchAll(/className\s*:\s*"([^"]{3,400})"/g)) {
    const cs = m[1];
    if (!cs) continue;
    const win = src.slice(Math.max(0, m.index - 1500), Math.min(src.length, m.index + 1500));
    const region = REGIONS.find(([, re]) => re.test(win))?.[0];
    if (!region) continue;

    const sz = sizesOf(cs);
    for (const [bucket, arr] of Object.entries(sz)) {
      for (const { cls, prop, px } of arr) {
        if (!table.has(region)) table.set(region, new Map());
        const key = `${bucket}|${prop}`;
        const rm = table.get(region);
        if (!rm.has(key)) rm.set(key, new Map());
        const pm = rm.get(key);
        if (!pm.has(px)) pm.set(px, new Set());
        pm.get(px).add(cls);
      }
    }
  }
}

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— 骨架里**写死**的几何常量

⚠️ 只包含「类名本身定死了数值」的项。
   \`var(--df-row-h)\` 这类运行时变量**故意不在表里** ——
   它们在 CSS 与 JS 里都没有值，只有跑起来才有。硬填数字就是造假。

每格：<px>  ← 用到的类名
`;

for (const [region] of REGIONS) {
  const rm = table.get(region);
  if (!rm) continue;
  out += `\n${"=".repeat(78)}\n${region}\n${"=".repeat(78)}\n`;
  for (const [key, pm] of [...rm].sort()) {
    const [bucket, prop] = key.split("|");
    const vals = [...pm.keys()].sort((a, b) => a - b);
    out += `  ${prop.padEnd(16)} ${vals.map((v) => v.toFixed(1)).join(" / ")}\n`;
    out += `      ${vals.map((v) => `${v.toFixed(1)}←${[...pm.get(v)].join(" ")}`).join("\n      ")}\n`;
  }
}

writeFileSync(R(".tmp/rev/hardcoded-geometry.txt"), out);
console.log(out.slice(0, 10000));
console.log(`\n…完整：.tmp/rev/hardcoded-geometry.txt`);
