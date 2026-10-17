/**
 * 【ARC-005 M1】**设计 token + 减弱动效总闸**的回归网。
 *
 * 逆向报告 §2/§3.6 的三件低成本高收益项:统一动效词表、三层焦点环、
 * `data-reduce-motion` 属性总闸。本套验的是**判据与接线**,不是视觉:
 *
 *  1. `reduceMotionAttribute` 三态映射(system → null 移除属性);
 *  2. `applyReduceMotion` 真的写/移除 `<html data-reduce-motion>`(用最小 DOM 桩);
 *  3. styles.css 里真的有那三样:动效 token、`--focus-ring` 两个变体、
 *     属性总闸规则,且**未设置时**仍保留既有的 `prefers-reduced-motion` 块;
 *  4. 设置流水线接齐:契约键 → store 默认值/设置器 → appearance → 设置面板
 *     (源码断言,防"写了但没接");
 *  5. i18n zh/en 两套键都存在。
 *
 * 变异验证:撤掉 `applyReduceMotion` 的属性写入 → 2 红;把 styles.css 的总闸
 * 改成只在媒体查询里 → 3 红。
 *
 * Run: scripts/design-tokens-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UI_REDUCE_MOTION_SETTING_KEY,
  ReduceMotionSchema,
  reduceMotionAttribute,
} from "@contracts/ipc";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ── 最小 DOM 桩,只为 applyReduceMotion ── */
const attrs = new Map<string, string>();
(globalThis as unknown as { document: unknown }).document = {
  documentElement: {
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    removeAttribute: (k: string) => { attrs.delete(k); },
  },
};

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), "utf8");

function section(t: string): void { console.log("\n" + t); }
section("1. 契约:键名 / 三态 / 属性映射");
{
  eq("设置键 ui.reduceMotion", UI_REDUCE_MOTION_SETTING_KEY, "ui.reduceMotion");
  check("三态 schema:system/on/off", ReduceMotionSchema.safeParse("system").success && ReduceMotionSchema.safeParse("on").success && ReduceMotionSchema.safeParse("off").success);
  check("非法值被拒", !ReduceMotionSchema.safeParse("always").success);
  eq("on → true", reduceMotionAttribute("on"), "true");
  eq("off → false", reduceMotionAttribute("off"), "false");
  eq("system → null(移除属性,交给媒体查询)", reduceMotionAttribute("system"), null);
}


section("2. applyReduceMotion 真的写 <html>");
{
  const { applyReduceMotion } = await import("../../src/renderer/lib/appearanceAttrs.js");
  applyReduceMotion("on");
  eq("on 写入 true", attrs.get("data-reduce-motion"), "true");
  applyReduceMotion("off");
  eq("off 写入 false", attrs.get("data-reduce-motion"), "false");
  applyReduceMotion("system");
  eq("system 移除属性", attrs.get("data-reduce-motion"), undefined);
}


section("3. styles.css:token / 焦点环 / 属性总闸");
{
  const css = read("src/renderer/styles.css");
  // 动效词表
  for (const token of ["--dur-fast", "--dur-snap", "--dur-base", "--dur-sheet", "--dur-slow",
    "--ease-out", "--ease-snap", "--ease-overshoot"]) {
    check(`动效 token ${token} 已定义`, new RegExp(`${token}\\s*:`).test(css));
  }
  // 焦点环两个变体
  check("★ --focus-ring 三层写法", /--focus-ring:\s*\n?\s*inset 0 0 0 1px rgb\(var\(--surface\)\)/.test(css));
  check("★ --focus-ring-danger 同形状换色", /--focus-ring-danger:\s*\n?\s*inset 0 0 0 1px rgb\(var\(--surface\)\)[\s\S]{0,120}--danger/.test(css));
  check("★ 焦点环经 :focus-visible 应用", /:focus-visible\s*\{[\s\S]{0,200}box-shadow:\s*var\(--focus-ring\)/.test(css));
  check("★ 透明 outline 占位保留(Windows 高对比度)", /outline:\s*2px solid #0000/.test(css));
  // 属性总闸
  // 锚定**规则本体**（选择器 + `{` 后紧跟被压制的属性），避免只匹配到注释里的说明。
  check("★ 属性总闸规则真的存在(选择器 + 声明)", new RegExp(String.raw`html\[data-reduce-motion="true"\]\s*\*\s*,\s*` + String.raw`html\[data-reduce-motion="true"\]\s*\*::before[\s\S]{0,260}animation-duration:\s*0\.01ms`).test(css));
  check("总闸把动画/过渡压到近零", /animation-duration:\s*0\.01ms\s*!important/.test(css) && /transition-duration:\s*0\.01ms\s*!important/.test(css));
  // 未设置时仍跟随系统:既有媒体查询块必须保留(>=9 处)
  const media = css.match(/@media \(prefers-reduced-motion: reduce\)/g)?.length ?? 0;
  check("★ 未设置属性时仍跟随系统(媒体查询块仍在)", media >= 9, media);
  // 反向:总闸不能只写成 @media(那做不出应用内开关)
  check("★ 总闸不是仅靠媒体查询", css.includes('html[data-reduce-motion="true"]'));
}


section("4. 设置流水线接齐(源码断言)");
{
  const store = read("src/renderer/stores/sessionStore.ts");
  check("★ store 默认 reduceMotion: \"system\"", store.includes('reduceMotion: "system"'));
  check("★ store 首帧读设置键", store.includes("UI_REDUCE_MOTION_SETTING_KEY"));
  check("★ store 有 setReduceMotion 并落库", store.includes("setReduceMotion: async") && store.includes("setting.set({ key: UI_REDUCE_MOTION_SETTING_KEY"));
  const appearance = read("src/renderer/lib/appearance.ts");
  check("★ appearance 订阅 reduceMotion", appearance.includes("s.reduceMotion") && appearance.includes("applyReduceMotion("));
  const panel = read("src/renderer/components/settings/GeneralPanel.tsx");
  check("★ 设置页有 reduceMotion 控件", panel.includes("setting-reducemotion") && panel.includes("setReduceMotion("));
  const sync = read("../../packages/contracts/src/ipc/settingsSync.ts");
  check("★ reduceMotion 进设备本地键(不随账号同步)", sync.includes("UI_REDUCE_MOTION_SETTING_KEY") && sync.includes("DEVICE_LOCAL_SETTING_KEYS"));
  // i18n 两套
  const zh = read("src/renderer/lib/i18n/zh/settings.ts");
  const en = read("src/renderer/lib/i18n/en/settings.ts");
  for (const key of ["settings.general.reduceMotion", "settings.general.reduceMotionDesc",
    "settings.general.reduceMotionSystem", "settings.general.reduceMotionOn", "settings.general.reduceMotionOff"]) {
    check(`i18n zh 有 ${key}`, zh.includes(`"${key}"`));
    check(`i18n en 有 ${key}`, en.includes(`"${key}"`));
  }
}

section("5. 【ARC-005 V0】CDS 原始色阶与语义层映射");
{
  const { execFileSync } = await import("node:child_process");
  let checkOk = true;
  let checkMsg = "";
  try {
    checkMsg = execFileSync(process.execPath, ["scripts/gen-cds-tokens.mjs", "--check"], { cwd: root, encoding: "utf8" });
  } catch (e) {
    checkOk = false;
    checkMsg = (e as { stderr?: string }).stderr ?? String(e);
  }
  check("★ tokens.cds.css 与上游 open-claude-ui 一致", checkOk, checkMsg.slice(0, 300));
  // 几何/阴影:生成物不得残留上游变量名(--cds-*),否则整条阴影静默失效。
  const geomTokens = read("src/renderer/tokens.cds.css");
  check("★ 几何 token 不含未解析的上游变量(--cds-*)", !/var\(--cds-/.test(geomTokens), geomTokens.match(/var\(--cds-[^)]*/g));
  for (const t of ["--m-panel-radius", "--m-radius-composer", "--m-message-bubble-radius", "--m-shadow-composer"]) {
    check("几何 token " + t + " 已生成", geomTokens.includes(t + ":"));
  }
  // 会话流微动效(从上游纯 CSS 提取):关键帧与类都在,且不残留上游变量。

  const motion = read("src/renderer/chat-motion.css");
  for (const kf of ["timeline-quiet-dot", "timeline-expand", "cds-skeleton-sweep", "dframe-clay-breathe", "dframe-dot-blink"]) {
    check("动效关键帧 " + kf + " 已提取", motion.includes("@keyframes " + kf));
  }
  check("★ 微动效不残留上游变量(--cds-*)", !motion.includes("var(--cds-"));
  check("三点波浪类已提取", motion.includes(".timeline-quiet-dots"));
  check("状态灯类已提取", motion.includes(".status-dot"));
  check("styles.css 引入了微动效", read("src/renderer/styles.css").includes('@import "./chat-motion.css";'));

  const cssAliases = read("src/renderer/styles.css");
  check("★ 真弹簧用 linear() 采样(cubic-bezier 做不出二次回弹)", /--spring-btn:\s*linear\(0,\s*0\.2459/.test(cssAliases));
  for (const a of ["--radius-panel:", "--radius-composer:", "--radius-bubble:", "--shadow-composer:", "--hairline:"]) {
    check("样式别名 " + a.replace(":", "") + " 已接", cssAliases.includes(a));
  }

  const tokens = read("src/renderer/tokens.cds.css");
  const rampCount = (tokens.match(/^  --m-/gm) ?? []).length;
  check("原始色阶数量合理(>=60)", rampCount >= 60, rampCount);
  for (const probe of ["--m-gray-10", "--m-gray-850", "--m-orange-350", "--m-orange-500"]) {
    check("原始色阶 " + probe + " 在生成物里", tokens.includes(probe + ":"));
  }
  check("★ 生成物是 R G B 三元组(不是 hex)", /--m-gray-10:\s*252 252 251;/.test(tokens));

  const css = read("src/renderer/styles.css");
  // 上游取证曲线与真弹簧(linear 采样)。
  for (const t of ["--ease-swift:", "--ease-expand:", "--ease-enter:", "--ease-pop:", "--ease-pulse:", "--ease-rise:", "--ease-fall:"]) {
    check("上游曲线 " + t.replace(":", "") + " 已接", css.includes(t));
  }
  check("styles.css 引入了生成物", css.includes('@import "./tokens.cds.css";'));
  check("★ 亮色 --surface 指到 --m-gray-10", /--surface:\s*var\(--m-gray-10\)/.test(css));
  check("★ 暗色 --surface 指到 --m-gray-850", /--surface:\s*var\(--m-gray-850\)/.test(css));
  check("★ 亮色 --content 指到 --m-gray-850", /--content:\s*var\(--m-gray-850\)/.test(css));
  check("★ 暗色 --content 指到 --m-gray-20", /--content:\s*var\(--m-gray-20\)/.test(css));
  check("★ --accent 仍是 emerald(未擅自换成陶土橙)", /--accent:\s*5 150 105;/.test(css));
  check("陶土橙作为备选品牌色暴露", css.includes("--brand-clay:") && css.includes("--brand-clay-strong:"));
  // 用户气泡接到 Claude 的陶土浅底(亮/暗各一档),alpha 已按实色调高。
  check("★ 亮色用户气泡指到 --m-orange-100", /--user-bubble:\s*var\(--m-orange-100\)/.test(css));
  check("★ 暗色用户气泡指到 --m-orange-850", /--user-bubble:\s*var\(--m-orange-850\)/.test(css));
  check("用户气泡 alpha 已按近实色调高", /--user-bubble-alpha:\s*0\.9;/.test(css) && /--user-bubble-alpha:\s*0\.55;/.test(css));
  check("sketch 主题仍覆盖 --surface", /html\.sketch:not\(\.dark\)[\s\S]{0,400}--surface:/.test(css));
}


console.log(`\ndesign-tokens-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
