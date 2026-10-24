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
 *  5. i18n zh/en 两套键都存在;
 *  9. **动效 token 的消费侧**:四张共享浮层(Select/Tooltip/InfoHint/Dialog)
 *     必须经 `duration-[var(--dur-*)]` / `ease-[var(--ease-*)]` 消费词表,
 *     且用仓库真 tailwind.config.js 真编译一遍,证明类名真的产出 CSS 声明
 *     （类存在 ≠ CSS 存在）,同时反向证明这四个文件不再产出裸毫秒规则。
 *
 * 变异验证:撤掉 `applyReduceMotion` 的属性写入 → 2 红;把 styles.css 的总闸
 * 改成只在媒体查询里 → 3 红。把 select.tsx 的 token 类改回 `duration-100`
 * → 第 9 节红(源码断言 + 真编译反向正控)。
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
  // 【T116】选中态边框必须与「悬停填充」不同值。
  //
  // 选中行是「bg-surface-hover 填充 + 边框」。深色主题下 `--surface-hover` 与
  // `--edge` 都是 #2c2c2a —— 用 --edge 画边框等于没画，「选中」和「悬停」长一样。
  // 那次是靠人肉算对比度发现的，套件当时 345/345 全绿：**判据体系对「看不看得见」是盲区**。
  // 这条把那一格补上：两个 token 的**字面值**不许相同。
  {
    const cdst = read("src/renderer/tokens.cds.css");
    // styles.css 的主题块：`:root {` 是浅色，`.dark {` 是深色。
    const blockOf = (selector: string): string | null => {
      const at = cssAliases.indexOf("\n" + selector + " {");
      if (at < 0) return null;
      const end = cssAliases.indexOf("\n}", at);
      return end < 0 ? null : cssAliases.slice(at, end);
    };
    const resolve = (block: string | null, name: string): string | null => {
      if (block === null) return null;
      const m = new RegExp("--" + name + ":\\s*var\\(--(m-gray-\\d+)\\)").exec(block);
      if (m === null) return null;
      const hex = new RegExp("--" + m[1] + ":\\s*[\\d\\s]+;\\s*/\\*\\s*(#[0-9a-fA-F]+)").exec(cdst);
      return hex === null ? null : hex[1].toLowerCase();
    };
    for (const [selector, themeName] of [["", "浅色"], [".dark", "深色"]] as const) {
      const block = blockOf(selector === "" ? ":root" : selector);
      const hover = resolve(block, "surface-hover");
      const selected = resolve(block, "selected-edge");
      check(`★ [${themeName}] --selected-edge 已定义且可解析`, selected !== null && hover !== null,
        { hover, selected });
      check(`★ [${themeName}] 选中边框 ${selected ?? "?"} 必须 ≠ 悬停填充 ${hover ?? "?"}（同值 = 边框看不见）`,
        selected !== null && hover !== null && selected !== hover, { hover, selected });
    }
  }
  // 【反向】`--spring-btn` 曾经定义过但全仓零调用 —— 死 token 会让人以为哪里
  // 有弹簧动画。断言它**不存在**；真要加弹簧时，定义与第一个调用点同批落地。
  check("★ 没有无人调用的死弹簧 token", !/--spring-btn\s*:/.test(cssAliases));
  for (const a of ["--radius-panel:", "--composer-radius:", "--radius-bubble:", "--composer-shadow:", "--hairline:"]) {
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
  // 【ARC-005 2026-10-20 用户拍板】品牌色已切到陶土橙。断言不再是「保持 emerald」，
  // 而是「切了、且切到过 AA 的那两档」：亮色 orange-450 (4.55:1) / orange-500 (5.54:1)，
  // 暗色 orange-300 (6.92:1)。上游 #d97757 只有 3.04:1，**不得**被直接拿来当 accent。
  check("★ 亮色 --accent 是过 AA 的陶土橙 orange-450", /--accent:\s*194 81 36;/.test(css));
  check("★ 亮色 --accent-strong 是 orange-500", /--accent-strong:\s*174 70 28;/.test(css));
  check("★ 暗色 --accent 是 orange-300", /--accent:\s*236 131 90;/.test(css));
  check("★ 未把 3.04:1 的上游 clay 直接当 accent", !/--accent:\s*217 119 87;/.test(css));
  check("上游原始陶土色仍作为装饰品牌色暴露", css.includes("--brand-clay:") && css.includes("--brand-clay-strong:"));
  // 【T136】用户气泡：**值守、性质守、色相不守**。
  //
  // 10dbb0ce 把气泡从 ARC-005 的暖陶土改成 #f0f4f8，依据是**考古结论**：
  // 上游 `--cds-bg-neutral` 被引用但从未赋值，所以只有 Personal 分支有具体值，
  // 而它解析到 #f0f4f8。**那不是「冷色更好」的设计偏好。**
  //
  // 所以这里分三类：
  //   值   —— 换色时会红，而那是预期的（你知道自己在换色）
  //   性质 —— 可辨 / 暗色不与画布同值 / alpha 结构。**任何配色都该满足**
  //   色相 —— **不守**。那是当时的结论，上游若补上 --cds-bg-neutral 它就成错的。
  //            由来记在 styles.css 的注释里，不放套件。
  const bubble = (re: RegExp) => {
    const m = css.match(re);
    return m ? m.slice(1, 4).map(Number) : null;
  };
  const lightBubble = bubble(/--user-bubble:\s*(\d+)\s+(\d+)\s+(\d+);[^\n]*#f0f4f8/);
  const darkBubble = bubble(/--user-bubble:\s*(\d+)\s+(\d+)\s+(\d+);[^\n]*#232323/);
  check("亮色用户气泡是 CDS 的 #f0f4f8（240 244 248）", lightBubble !== null, { lightBubble });
  check("暗色用户气泡是 #232323（35 35 35）", darkBubble !== null, { darkBubble });

  // 相对亮度（WCAG），只用来算「可辨」这个性质，不参与色相判断。
  const relLum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a: number[], b: number[]) => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const CANVAS_LIGHT = [252, 252, 251]; // --surface #fcfcfb
  const CANVAS_DARK = [21, 21, 21]; // --surface #151515
  check(
    "★ 亮色气泡对画布可辨（≥1.05:1，任何配色都该满足）",
    lightBubble !== null && contrast(lightBubble, CANVAS_LIGHT) >= 1.05,
    { lightBubble, ratio: lightBubble ? Number(contrast(lightBubble, CANVAS_LIGHT).toFixed(3)) : null },
  );
  check(
    "★ 暗色气泡与画布不同值（否则是看不见的气泡）",
    darkBubble !== null && contrast(darkBubble, CANVAS_DARK) >= 1.05,
    { darkBubble, ratio: darkBubble ? Number(contrast(darkBubble, CANVAS_DARK).toFixed(3)) : null },
  );
  check(
    "用户气泡不再指到品牌橙色系",
    !/--user-bubble:\s*var\(--m-orange-/.test(css),
  );
  check(
    "用户气泡 alpha 两处都是 1（triplet 本身已是合成色）",
    (css.match(/--user-bubble-alpha:\s*1;/g) ?? []).length === 2,
    { count: (css.match(/--user-bubble-alpha:\s*1;/g) ?? []).length },
  );
  check(
    "用户气泡 alpha 两处都是 1（triplet 本身已是合成色）",
    (css.match(/--user-bubble-alpha:\s*1;/g) ?? []).length === 2,
    { count: (css.match(/--user-bubble-alpha:\s*1;/g) ?? []).length },
  );
  check("sketch 主题仍覆盖 --surface", /html\.sketch:not\(\.dark\)[\s\S]{0,400}--surface:/.test(css));
}


section("6. 【ARC-005】Composer 外框接上游几何/阴影 token");
{
  const css = read("src/renderer/styles.css");
  // 语义别名必须**引用**生成物（tokens.cds.css 的 --m-*），不在语义层重抄数值。
  check("★ --composer-radius 指向 var(--m-radius-composer)",
    /--composer-radius:\s*var\(--m-radius-composer\)/.test(css));
  check("★ --composer-shadow 指向 var(--m-shadow-composer)",
    /--composer-shadow:\s*var\(--m-shadow-composer\)/.test(css));
  check("★ --composer-shadow-focus 指向 var(--m-shadow-composer-focus)",
    /--composer-shadow-focus:\s*var\(--m-shadow-composer-focus\)/.test(css));
  // 反向正控限定在通用语义层：新版 Claude Desktop v2 有独立 workspace
  // 密度作用域，可使用 14px comfortable Composer，但不许回写 :root 影响 classic。
  // 先剔除精确的 workspace 作用域块，再审查全局别名是否漂移。
  const workspaceScope = '[data-ui-shell-variant="workspace"] {';
  const scopeStart = css.indexOf(workspaceScope);
  const scopeEnd = scopeStart < 0 ? -1 : css.indexOf("}", scopeStart);
  const globalCss = scopeEnd < 0 ? css : css.slice(0, scopeStart) + css.slice(scopeEnd + 1);
  for (const name of ["--composer-radius", "--composer-shadow", "--composer-shadow-focus"]) {
    check(`★ ${name} 值走 var(--m-*) 而非字面量`, new RegExp(`${name}:\\s*var\\(--m-`).test(globalCss));
    check(`${name} 全局别名未回落为 px/hex 字面量`, !new RegExp(`${name}:\\s*(\\d|#)`).test(globalCss));
  }
  // 生成物的阴影边线色必须包 rgb()：Mcode 的 --edge/--input-edge 是 "R G B"
  // 三元组，裸写进 box-shadow 会展开成 "195 194 183"，整条声明在计算值阶段
  // 失效、阴影静默消失 —— 这正是 gen-cds-tokens 的 VAR_MAP 修复要钉住的。
  const tokens = read("src/renderer/tokens.cds.css");
  // 亮色与暗色各一组三态(resting / hover / focus)。暗色组不是重复:上游在
  // `.dark` 里把 alpha 从 0.035 调到 0.4、focus 从 0.08 调到 0.65 —— 没有它,
  // 深底上的卡片阴影几乎不可见。
  const darkAt = tokens.indexOf(".dark {");
  const lightPart = darkAt >= 0 ? tokens.slice(0, darkAt) : tokens;
  const darkPart = darkAt >= 0 ? tokens.slice(darkAt) : "";
  const countIn = (part: string): number => (part.match(/--m-shadow-composer/g) ?? []).length;
  check("★ Composer 阴影 token 亮色 3 态", countIn(lightPart) === 3, countIn(lightPart));
  check("★ Composer 阴影 token 暗色 3 态(上游 .dark 覆盖)", countIn(darkPart) === 3, countIn(darkPart));
  const shadowDecls = lightPart + String.fromCharCode(10) + darkPart;
  const bareRefs = shadowDecls.replace(/rgb\(var\(--(edge|input-edge)\)\)/g, "WRAPPED");
  check("★ Composer 阴影引用边线色都包了 rgb()(防整条阴影静默失效)",
    !/var\(--(edge|input-edge)\)/.test(bareRefs), bareRefs.slice(0, 300));

  // 源码断言：外框 class 真的接上了别名（防"token 写了但没人用"）。
  const pane = read("src/renderer/components/chat/ChatPane.tsx");
  const cardCls = /"composer-card[^"]*"/.exec(pane)?.[0] ?? "";
  check("★ composer-card 外框类名存在", cardCls.length > 0);
  check("★ 外框圆角引用 --composer-radius", cardCls.includes("rounded-[var(--composer-radius)]"));
  check("★ 外框 resting 阴影引用 --composer-shadow", cardCls.includes("shadow-[var(--composer-shadow)]"));
  check("★ 外框 focus-within 阴影引用 --composer-shadow-focus",
    /focus-within:shadow-\[var\(--composer-shadow-focus\)\]/.test(pane));
  check("外框不再硬编码 rounded-2xl(旧 16px)", !/composer-card[^"]*rounded-2xl/.test(pane));
  // busy 扫光条贴着顶边，圆角必须跟随外框，否则外框换 20px 后扫光露直角。
  check("★ busy 扫光圆角跟随 --composer-radius",
    /composer-card\[data-busy="1"\]::before[\s\S]{0,400}border-radius:\s*var\(--composer-radius\)/.test(css));
}

section("7. 【ARC-005】工具调用卡接 CDS 几何/表面 token");
{
  const css = read("src/renderer/styles.css");
  const blocks = read("src/renderer/components/chat/MessageBlocks.tsx");
  const tokens = read("src/renderer/tokens.cds.css");

  // 语义别名：控件档圆角必须**引用**生成物里的上游值（--radius-sm 是上游
  // 原样键名，生成器只改写 --cds-* 前缀，所以不是 --m-radius-sm）。
  check("★ --radius-control 指向 var(--radius-sm)", /--radius-control:\s*var\(--radius-sm\)/.test(css));
  // 反向正控：别名若写成 px/rem 字面量，上游 4px 改动时这里会静默漂移。
  check("★ --radius-control 不是字面量", !/--radius-control:\s*[\d.]/.test(css));
  check("★ 生成物里 --radius-sm 是上游 4px(.25rem)", /--radius-sm:\s*\.25rem;/.test(tokens));
  check("★ --hairline 指向 var(--m-ring-hairline)", /--hairline:\s*var\(--m-ring-hairline\)/.test(css));

  // 源码断言：四个工具卡头部共享同一个几何常量，且真的接到 token 上。
  check("★ MessageBlocks 有共享工具行常量 TOOL_ROW_CLS", /const TOOL_ROW_CLS\s*=/.test(blocks));
  check("★ TOOL_ROW_CLS 圆角引用 --radius-control",
    /TOOL_ROW_CLS\s*=\s*\n?\s*"[^"]*rounded-\[var\(--radius-control\)\]/.test(blocks));
  check("★ TOOL_ROW_CLS 背景走既有 surface-muted", /TOOL_ROW_CLS[\s\S]{0,300}hover:bg-surface-muted\/50/.test(blocks));
  check("★ TOOL_ROW_CLS 被四处工具卡引用(批量组+Edit+Write+通用)",
    (blocks.match(/className=\{TOOL_ROW_CLS\}/g) ?? []).length === 4,
    (blocks.match(/className=\{TOOL_ROW_CLS\}/g) ?? []).length);
  // 反向正控：旧字面量圆角不能再出现在工具行里（6px 散装 rounded-md）。
  // 精确到旧的两个完整类串：BatchToolGroup 是 hover /40，Edit/Write/Generic 是
  // hover /50。思考折叠行（Collapsible）的类串里多一个 text-content-muted，
  // 不在本切片范围，不会被这两条误伤。
  check("★ 工具行不再硬编码 rounded-md(旧 6px, hover /50 三处)",
    !blocks.includes('"flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-surface-muted/50"'));
  check("★ 工具行不再硬编码 rounded-md(旧 6px, 批量组 hover /40)",
    !blocks.includes('"flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-surface-muted/40"'));

  // 展开体的发丝边宽度走 --hairline（1px），颜色仍走 --edge。
  check("★ 工具展开体有共享发丝边常量 TOOL_BODY_RULE_CLS", /const TOOL_BODY_RULE_CLS\s*=/.test(blocks));
  check("★ 展开体左边发丝宽度引用 --hairline",
    /TOOL_BODY_RULE_CLS\s*=\s*"[^"]*border-l-\[length:var\(--hairline\)\]/.test(blocks));
  check("★ 展开体发丝边仍用 --edge 色", /TOOL_BODY_RULE_CLS\s*=\s*"[^"]*border-edge/.test(blocks));
  // 反向正控：旧写法 `border-l border-edge`（Tailwind 隐式 1px）不能再出现在
  // 工具卡展开体里。思考折叠行（Collapsible 的 max-h-80 overflow-y-auto
  // border-l border-edge py-2 pl-2）不在这三处之列，本切片的反向断言只钉
  // 工具卡的两个旧类串。
  check("★ 展开体不再用隐式 border(旧 space-y-2 border-l border-edge)",
    !blocks.includes('"space-y-2 border-l border-edge py-2 pl-2"'));
  check("★ 展开体不再用隐式 border(旧 批量组 overflow 行)",
    !blocks.includes('"max-h-80 space-y-1.5 overflow-y-auto border-l border-edge py-1 pl-2"'));
  check("★ TOOL_BODY_RULE_CLS 被四张卡引用(批量组+Edit+Write+通用)",
    (blocks.match(/TOOL_BODY_RULE_CLS\)\}/g) ?? []).length === 4,
    (blocks.match(/TOOL_BODY_RULE_CLS\)\}/g) ?? []).length);

  // 状态胶囊几何：运行态呼吸灯对齐上游 StatusIndicators 的 6px 标准状态灯。
  check("★ .chat-ledger-dot 直径 6px(上游 .status-dot)", /\.chat-ledger-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/.test(css));
  // 反向正控：旧 7px 必须消失（否则尺寸断言会因两处并存而假绿）。
  check("★ .chat-ledger-dot 不再是旧的 7px", !/\.chat-ledger-dot\s*\{[^}]*width:\s*7px;/.test(css));
  // 灯→标签间距对齐参考的 gap-2(8px)：行内 gap 6px + 2px margin。
  check("★ 状态灯与标签间距对齐 gap-2(8px)", /\.chat-ledger-head \.chat-ledger-dot\s*\{[^}]*margin-right:\s*2px;/.test(css));

  // 暗色观感：背景与发丝边都走既有语义 token（其暗色值在 styles.css 的 .dark
  // 里指到 --m-gray-800/--m-gray-750），本切片没有新增暗色专用字面量。
  check("★ 工具行背景不新增暗色字面量(dark:bg-*)", !/TOOL_ROW_CLS[\s\S]{0,300}dark:bg-/.test(blocks));
}

section("8. 【ARC-005】forced-colors 高对比层");
{
  const css = read("src/renderer/styles.css");
  // 从规则本体取块，不从注释里认：先把块注释剥掉，再定位 @media 的
  // 选择器 + `{`，块内同时出现声明才算数。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockAt = noComments.indexOf("@media (forced-colors: active)");
  check("★ forced-colors 媒体块存在", blockAt >= 0);
  const block = blockAt >= 0 ? noComments.slice(blockAt) : "";
  // 反向正控：规则不能只出现在注释里。逐字符扫描原文，只有**注释之外**
  // 的那次出现才算数（上面剥注释后定位只证明"剥完还在"，不能证明原文那次
  // 不是注释；两边都核，注释里写规则而真规则没写时这里会红）。
  const NEEDLE = "@media (forced-colors: active)";
  let inComment = false;
  let liveAt = -1;
  for (let i = 0; i < css.length; i++) {
    if (!inComment && css.startsWith("/*", i)) { inComment = true; i++; continue; }
    if (inComment && css.startsWith("*/", i)) { inComment = false; i++; continue; }
    if (!inComment && css.startsWith(NEEDLE, i)) { liveAt = i; break; }
  }
  check("★ forced-colors 规则不是只写在注释里", liveAt >= 0);

  // 1) 焦点环：box-shadow 环在高对比下被 UA 丢弃，必须落到 outline 上。
  check("★ 高对比焦点落 outline 而非 box-shadow",
    /:focus-visible\s*\{[\s\S]{0,200}?outline:\s*2px solid CanvasText[\s\S]{0,200}?box-shadow:\s*none/.test(block));
  check("★ 高对比危险焦点不再依赖 --danger 区分",
    /\[data-danger\][\s\S]{0,160}?box-shadow:\s*none/.test(block));

  // 2) 纯底色小形状改画系统色。
  for (const sel of [".chat-ledger-dot", ".chat-caret", ".live-eq > span"]) {
    check(`★ 高对比下 ${sel} 改画 CanvasText`,
      new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]{0,120}?background:\\s*CanvasText").test(block));
  }

  // 3) 用户气泡边界恢复。
  check("★ 高对比下用户气泡用内描边恢复边界",
    /\.user-bubble-fill\s*\{[\s\S]{0,160}?outline:\s*1px solid CanvasText[\s\S]{0,80}?outline-offset:\s*-1px/.test(block));

  // 4) 任务进度轨道可见 + 填充系统色。
  check("★ 高对比下任务进度轨道有描边",
    /\.activity-cluster-miniprog\s*\{[\s\S]{0,120}?outline:\s*1px solid CanvasText/.test(block));
  check("★ 高对比下任务进度填充改画 CanvasText",
    /\.activity-cluster-miniprog > i\s*\{[\s\S]{0,120}?background:\s*CanvasText/.test(block));

  // 5) 档位条：`.on` 变体特异性更高，必须一并覆盖，否则亮档被强制回 Canvas。
  check("★ 高对比下档位条亮/暗两态都改画 CanvasText",
    /\.composer-lvlbars > span,[\s\S]{0,80}?\.composer-lvlbars > span\.on\s*\{[\s\S]{0,80}?background:\s*CanvasText/.test(block));

  // 6) 源序前提：媒体查询不提升优先级，同特异性下靠源序覆盖 —— 块若
  // 出现在被覆盖规则之前，高对比规则会被后写的纯色规则反压，整层失效。
  // 只在**真实规则起点之前**找基础规则的最后一次出现（块内也有同名选择器，
  // 直接 lastIndexOf 会命中块内那份，断言永远假绿）。
  const rawAt = liveAt;
  const lastBubble = rawAt >= 0 ? css.lastIndexOf(".user-bubble-fill {", rawAt) : -1;
  const lastDot = rawAt >= 0 ? css.lastIndexOf(".chat-ledger-dot {", rawAt) : -1;
  check("★ forced-colors 块在被覆盖规则之后（源序前提）",
    rawAt >= 0 && lastBubble >= 0 && lastDot >= 0 && lastBubble < rawAt && lastDot < rawAt);
}

section("9. 【ARC-005】动效 token 的消费侧:四张共享浮层 + 真编译");
{
  // 改前事实(本片取证):styles.css 定义了 --dur-* / --ease-* 词表,但全渲染端
  // `var(--dur` 出现 **0 次** —— token 只写不读。本节的判据分两层:
  //   ① 源码层:四张共享浮层(每页都用)的揭示/弹窗过渡必须引用词表变量;
  //   ② 编译层:用仓库**真** tailwind.config.js 真编译这四个文件,证明那些
  //      任意值类真的产出 transition-duration/timing-function 声明 ——
  //      "class 写在字符串里" ≠ "CSS 里有这条规则"(Tailwind 只产出它认识的类)。
  // 反向正控:同一份编译产物里,这四个文件不得再产出裸毫秒规则;源码里也不得
  // 再有 duration-<数字>。任何一条被改回裸毫秒,本节点红。
  const primitives: { file: string; must: string[] }[] = [
    { file: "src/renderer/components/ui/select.tsx",
      must: ["duration-[var(--dur-snap)]", "ease-[var(--ease-out)]"] },
    { file: "src/renderer/components/ui/tooltip.tsx",
      must: ["duration-[var(--dur-snap)]", "ease-[var(--ease-out)]"] },
    { file: "src/renderer/components/ui/info-hint.tsx",
      must: ["duration-[var(--dur-snap)]", "ease-[var(--ease-out)]"] },
    { file: "src/renderer/components/ui/dialog.tsx",
      must: ["duration-[var(--dur-base)]", "ease-[var(--ease-pop)]"] },
  ];
  for (const { file, must } of primitives) {
    const src = read(file);
    for (const cls of must) {
      check(`★ ${file.split("/").pop()} 引用 ${cls}`, src.includes(cls));
    }
    // 反向正控:该文件不得再出现裸毫秒时长类。用 "duration-" 后紧跟数字判定,
    // 不误伤 duration-[var(--dur-*)];注释里也不许写(会误导后人 + 被 Tailwind
    // 全文扫描后产出无用规则)。
    const bare = src.match(/duration-[0-9]+/g);
    check(`★ ${file.split("/").pop()} 不再有裸毫秒时长类`, bare === null, bare);
  }

  // 真编译:用 postcss + tailwindcss(仓库安装版本)对这四份源码跑一次
  // utilities 生成。content 用 raw 注入 —— 与 UI 套件编译 styles.css 的机制
  // 同源,但只看这四份文件的产出,足够回答"类名真的会变成声明吗"。
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(join(root, "package.json"));
  const postcss = require("postcss") as {
    (plugins: unknown[]): { process: (css: string, opts: { from: undefined }) => Promise<{ css: string }> };
  };
  const tailwind = require("tailwindcss") as (cfg: unknown) => unknown;
  // Windows 上绝对路径必须先转 file:// URL,直接 import("D:\\…") 会因 scheme
  // 不被 ESM loader 接受而崩(ERR_UNSUPPORTED_ESM_URL_SCHEME)。
  const cfg = (await import(pathToFileURL(join(root, "tailwind.config.js")).href)).default as Record<string, unknown>;
  const raw = primitives.map(({ file }) => read(file)).join("\n");
  const compiled = (
    await postcss([tailwind({ ...cfg, content: [{ raw, extension: "tsx" }] })]).process(
      "@tailwind utilities;",
      { from: undefined },
    )
  ).css;

  // Tailwind 任意值类在产物里的选择器形态:.duration-\[var\(--dur-snap\)\]
  // —— `[` `(` `)` `]` 在 CSS 里各带一个反斜杠,按同一规则拼出字面选择器,
  // 不做正则转义(两级转义叠在一起曾让这条断言永远假红)。
  const selectorFor = (cls: string): string =>
    "." + cls.replace(/[[\]()]/g, (ch) => "\\" + ch);
  for (const { must } of primitives) {
    for (const cls of must) {
      check(`★ 真编译产出 .${cls}`, compiled.includes(selectorFor(cls) + " {"));
    }
  }
  // 值真的指到词表(不是被 Tailwind 截成别的值)。
  check(
    "★ 编译产物的 duration 声明指向 var(--dur-*)",
    /transition-duration:\s*var\(--dur-(snap|base)\)/.test(compiled),
  );
  check(
    "★ 编译产物的 timing-function 指向 var(--ease-*)",
    /transition-timing-function:\s*var\(--ease-(out|pop)\)/.test(compiled),
  );
  // 反向正控:同一份产物里不得出现裸毫秒规则(证明上面的正向断言不是"两个
  // 类都在"造成的假绿)。
  const bareRules = compiled.match(/^\.duration-[0-9]+/gm);
  check("★ 四文件编译产物不再含裸毫秒规则", bareRules === null, bareRules);
}

section("10. 【ARC-005】共享原语消费 --focus-ring(不再散装 ring)");
{
  // 判据:三份可聚焦原语(Button / Switch / InfoHint)的源码不得再出现
  // `focus-visible:ring-*` —— 那些 Tailwind ring 工具类的特异性是 (0,2,0),
  // 高于 styles.css 全局 token 规则 `:where(...):focus-visible` 的 (0,1,0);
  // 留一个 ring 类,用户实际看到的就还是旧环,token 只是"写了没人用"。
  for (const file of [
    "src/renderer/components/ui/button.tsx",
    "src/renderer/components/ui/switch.tsx",
    "src/renderer/components/ui/info-hint.tsx",
  ]) {
    const src = read(file);
    const scattered = src.match(/focus-visible:ring-[^\s"]+/g);
    check(`★ ${file.split("/").pop()} 不再写散装 focus-visible:ring-*`, scattered === null, scattered);
  }

  // 正向:全局选择器列表必须覆盖角色型可聚焦控件。Base UI Switch 渲染的是
  // `span[role="switch"]`(不是 button),漏了它,开关就完全没有 token 焦点环。
  const css = read("src/renderer/styles.css");
  const baseRule = /:where\(button, \[role="button"\], \[role="switch"\], \[role="tab"\], \[role="menuitem"\], \[role="option"\], a\[href\], input, select, textarea\):focus-visible \{\s*\n?\s*outline: 2px solid #0000;/.test(css);
  check("★ 全局焦点规则含 [role=switch] 且保留透明 outline 占位", baseRule);

  // 死亡选择器正控:`button[data-variant="danger"]` 只有在组件真的把 variant
  // 落到 DOM 时才不是死代码。两条都要:模板里有 data-variant,且 CSS 有选择器。
  check("★ button.tsx 把 variant 落到 DOM(data-variant)",
    /data-variant=\{variant \?\? "secondary"\}/.test(read("src/renderer/components/ui/button.tsx")));
  check("★ styles.css 危险焦点选择器存在", css.includes('button[data-variant="danger"]'));

  // forced-colors 层同样要含 [role=switch](它复制了基础选择器列表)。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const fcAt = noComments.indexOf("@media (forced-colors: active)");
  const fcBlock = fcAt >= 0 ? noComments.slice(fcAt) : "";
  check("★ forced-colors 焦点规则也含 [role=switch]",
    /\[role="switch"\][\s\S]{0,160}outline: 2px solid CanvasText/.test(fcBlock));
}

section("11. 【ARC-005】reduce-motion 总闸覆盖动效词表本身");
{
  const css = read("src/renderer/styles.css");
  // 只压 `animation-duration/transition-duration` 不够:新代码读 `--dur-*`
  // 写进任意属性(或 JS 读变量做 setTimeout 基准)时,词表仍是 300ms。
  // 总闸必须把五个时长变量本身归零。
  const gateAt = css.indexOf('html[data-reduce-motion="true"] {');
  check("★ 总闸有词表归零块", gateAt >= 0);
  const gateBlock = gateAt >= 0 ? css.slice(gateAt, css.indexOf("}", gateAt)) : "";
  for (const t of ["--dur-fast", "--dur-snap", "--dur-base", "--dur-sheet", "--dur-slow"]) {
    check(`★ 总闸把 ${t} 归零`, new RegExp(`${t}:\\s*0ms;`).test(gateBlock));
  }
  // 反向正控:声明真实存在而不是只出现在注释 —— 取规则本体判。
  check("★ 词表归零不是注释", !/\/\*[^*]*--dur-fast:\s*0ms[\s\S]*?\*\//.test(gateBlock));

  // 延迟也压:入场动画常带 delay,只压 duration 会让"等 300ms 再瞬间出现"。
  const childRule = css.slice(gateAt, css.indexOf("scroll-behavior", gateAt));
  check("★ 总闸压 animation-delay", /animation-delay:\s*0ms\s*!important/.test(childRule));
  check("★ 总闸压 transition-delay", /transition-delay:\s*0ms\s*!important/.test(childRule));
}

section("12. 【ARC-005】Diff 行色 token 化 + 高对比形状");
{
  const css = read("src/renderer/styles.css");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const DIFF_TOKENS = ["--diff-add-bg", "--diff-add-text", "--diff-del-bg", "--diff-del-text", "--diff-context"];

  // ★ 五个 token 在浅/深两套都有**定义**（声明本体,不是注释）。
  // 取 :root 与 .dark 两个块的真实文本:按块起始定位,截到下一个顶层 `}`。
  const rootAt = noComments.indexOf(":root {");
  const darkAt2 = noComments.indexOf(".dark {");
  check("★ :root 与 .dark 块都存在", rootAt >= 0 && darkAt2 > rootAt);
  const rootBlock = rootAt >= 0 ? noComments.slice(rootAt, noComments.indexOf("}", rootAt)) : "";
  const darkBlock = darkAt2 >= 0 ? noComments.slice(darkAt2, noComments.indexOf("}", darkAt2)) : "";
  for (const token of DIFF_TOKENS) {
    check(`★ 亮色定义 ${token}`, new RegExp(`${token}:\\s*[^;]+;`).test(rootBlock));
    check(`★ 暗色定义 ${token}`, new RegExp(`${token}:\\s*[^;]+;`).test(darkBlock));
  }
  // 反向正控:仅注释里写 token 不算（上面已在剥注释文本上判,这里再钉原文
  // 的活声明次数 —— 两套各一次,合计 >= 10 次真实声明）。
  const liveDecls = (noComments.match(/--diff-(add|del|context)[a-z-]*\s*:/g) ?? []).length;
  check("★ --diff-* 真实声明 >= 10 处（两套 × 五个）", liveDecls >= 10, liveDecls);

  // ★ 消费端真的接到 token 上（不做"token 写了没人用"的假绿）。
  check("★ .diff-add 行底走 --diff-add-bg", /\.diff-add\s*\{[^}]*background:\s*rgb\(var\(--diff-add-bg\)/.test(noComments));
  check("★ .diff-add 文字走 --diff-add-text", /\.diff-add\s*\{[^}]*color:\s*rgb\(var\(--diff-add-text\)\)/.test(noComments));
  check("★ .diff-del 行底走 --diff-del-bg", /\.diff-del\s*\{[^}]*background:\s*rgb\(var\(--diff-del-bg\)/.test(noComments));
  check("★ .diff-del 文字走 --diff-del-text", /\.diff-del\s*\{[^}]*color:\s*rgb\(var\(--diff-del-text\)\)/.test(noComments));
  check("★ .diff-context 文字走 --diff-context", /\.diff-context\s*\{[^}]*color:\s*rgb\(var\(--diff-context\)\)/.test(noComments));

  // ★ 被替换的组件不再出现硬编码的增删颜色（源码级,排除注释）。
  // 旧类串:`bg-red-500/15` / `text-red-600 dark:text-red-400` / green 同构。
  // 只核两个 Diff 渲染组件 —— 其它面板（错误提示、浏览器浮条）的红绿不是
  // diff 语义,不在本切片范围。
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const file of ["src/renderer/components/chat/DiffView.tsx", "src/renderer/components/mobile/PatchView.tsx"]) {
    const src = stripComments(read(file));
    const hardcoded = src.match(/bg-(red|green)-(400|500)\/\d+|text-(red|green)-(400|500|600)(?![\w-])|dark:text-(red|green)-/g);
    check(`★ ${file.split("/").pop()} 不再硬编码增删颜色`, hardcoded === null, hardcoded);
    check(`★ ${file.split("/").pop()} 行色接了 diff-* 类`, /\bdiff-(add|del|context)\b/.test(src));
  }

  // ★ forced-colors 块含 diff 规则,且增删形状**不只靠颜色**区分：增行实线、
  // 删行虚线（outline-style: dashed 是形状差,不是色差）。
  const fcAt2 = noComments.indexOf("@media (forced-colors: active)");
  const fcBlock2 = fcAt2 >= 0 ? noComments.slice(fcAt2) : "";
  check("★ forced-colors 块含 .diff-add/.diff-del 规则",
    /\.diff-add,[\s\S]{0,80}?\.diff-del\s*\{[\s\S]{0,160}?outline:\s*2px solid CanvasText/.test(fcBlock2));
  check("★ 高对比下删行用虚线形状（不靠颜色区分增删）",
    /\.diff-del\s*\{[\s\S]{0,80}?outline-style:\s*dashed/.test(fcBlock2));
}

section("13. 【ARC-005】终端主题接语义 token");
{
  const css = read("src/renderer/styles.css");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rootAt = noComments.indexOf(":root {");
  const darkAt3 = noComments.indexOf(".dark {");
  const rootBlock = rootAt >= 0 ? noComments.slice(rootAt, noComments.indexOf("}", rootAt)) : "";
  const darkBlock = darkAt3 >= 0 ? noComments.slice(darkAt3, noComments.indexOf("}", darkAt3)) : "";
  const TERM_TOKENS = [
    "--terminal-bg", "--terminal-fg", "--terminal-cursor", "--terminal-cursor-accent",
    "--terminal-selection-bg", "--terminal-selection-fg",
    "--terminal-black", "--terminal-red", "--terminal-green", "--terminal-yellow",
    "--terminal-blue", "--terminal-magenta", "--terminal-cyan", "--terminal-white",
    "--terminal-bright-black", "--terminal-bright-red", "--terminal-bright-green",
    "--terminal-bright-yellow", "--terminal-bright-blue", "--terminal-bright-magenta",
    "--terminal-bright-cyan", "--terminal-bright-white",
  ];
  // ★ 22 个终端 token 浅/深两套都有真实定义（剥注释后判规则本体）。
  const missingLight = TERM_TOKENS.filter((t) => !new RegExp(`${t}:\\s*[^;]+;`).test(rootBlock));
  const missingDark = TERM_TOKENS.filter((t) => !new RegExp(`${t}:\\s*[^;]+;`).test(darkBlock));
  check("★ 终端 token 浅色 22 个全定义", missingLight.length === 0, missingLight);
  check("★ 终端 token 深色 22 个全定义", missingDark.length === 0, missingDark);
  // ★ 语义项必须**引用**语义 token（不是字面量）—— 背景/前景/光标/选区。
  for (const [tok, ref] of [
    ["--terminal-bg", "--surface"],
    ["--terminal-fg", "--content"],
    ["--terminal-cursor", "--accent"],
    ["--terminal-selection-bg", "--surface-hover"],
    ["--terminal-selection-fg", "--content"],
    ["--terminal-cursor-accent", "--surface"],
  ] as const) {
    check(`★ ${tok} 引用 var(${ref})`, new RegExp(`${tok}:\\s*var\\(${ref.replace(/[()]/g, "\\$&")}\\)`).test(rootBlock));
  }
  // ★ 构建器是纯函数且**不持有字面量颜色**（源码级，剥注释）。
  const theme = read("src/renderer/lib/terminalTheme.ts");
  const themeNoComments = theme.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("★ terminalTheme.ts 无硬编码颜色(hex/rgb 字面量)",
    !/#[0-9a-fA-F]{3,8}\b/.test(themeNoComments) && !/\brgba?\(\s*\d/.test(themeNoComments),
    themeNoComments.match(/#[0-9a-fA-F]{3,8}|\brgba?\(/g));
  check("★ 主题构建纯函数 buildThemeFromVars 导出", /export function buildThemeFromVars\s*\(/.test(themeNoComments));
  check("★ 三元组→rgb 转换存在且拒绝非法值",
    /export function tripletToXtermColor/.test(themeNoComments) && /parts\.length !== 3/.test(themeNoComments));

  // ★ 消费端：两个 xterm 组件经 buildTheme() 读 token，不再有 hex 字面量。
  for (const file of ["src/renderer/components/ide/TerminalView.tsx", "src/renderer/components/ide/ReadonlyTerminal.tsx"]) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g);
    check(`★ ${file.split("/").pop()} 无硬编码 hex`, hex === null, hex);
    check(`★ ${file.split("/").pop()} 主题经 buildTheme() 构建`, /buildTheme\(\)/.test(src));
  }

  // ★ 主题变化会重建：`[dark]` effect 调 buildTheme()（现读计算值），
  // 两个组件都必须有这条。source 级断言 —— 改回「构造时读一次、之后不更新」
  // 会红。
  const tv = read("src/renderer/components/ide/TerminalView.tsx");
  check("★ TerminalView 在 [dark] 变化时重建主题",
    /useEffect\(\(\) => \{[\s\S]{0,200}?options\.theme = buildTheme\(\)[\s\S]{0,80}?\}, \[dark\]\)/.test(tv));
  const rt = read("src/renderer/components/ide/ReadonlyTerminal.tsx");
  check("★ ReadonlyTerminal 在 [dark] 变化时重建主题",
    /useEffect\(\(\) => \{[\s\S]{0,200}?options\.theme = buildTheme\(\)[\s\S]{0,80}?\}, \[dark\]\)/.test(rt));
  // ★ 运行期真的走计算值（token 解析），不是按 dark 分支的两套常量。
  check("★ buildTheme 走 buildTerminalTheme()(getComputedStyle 现读)",
    /buildTerminalTheme\(\)/.test(tv) && /getComputedStyle\(document\.documentElement\)/.test(themeNoComments));
  // ★ xterm 视口 CSS 背景/前景也接同一组 token（画布与宿主底色同源）。
  check("★ .xterm-viewport 背景/前景走 --terminal-bg/--terminal-fg",
    /\.xterm \.xterm-viewport\s*\{[\s\S]{0,160}?background-color:\s*rgb\(var\(--terminal-bg\)\)[\s\S]{0,80}?color:\s*rgb\(var\(--terminal-fg\)\)/.test(noComments));

  // ★ 纯函数级：给定假 token 值时真的产出 xterm 格式；缺 token 时省略而非编造。
  const { buildThemeFromVars, tripletToXtermColor } = await import("../../src/renderer/lib/terminalTheme.js");
  eq("triplet → rgb()", tripletToXtermColor(" 5 150 105 "), "rgb(5, 150, 105)");
  eq("非法三元组(两段) → null", tripletToXtermColor("5 150"), null);
  eq("越界 → null", tripletToXtermColor("5 300 105"), null);
  eq("hex → null(不猜)", tripletToXtermColor("#059669"), null);
  const fakeDark = new Map<string, string>([
    ["--terminal-bg", "21 21 21"],
    ["--terminal-fg", "249 249 247"],
    ["--terminal-cursor", "16 185 129"],
    ["--terminal-red", "248 113 113"],
  ]);
  const built = buildThemeFromVars((t) => fakeDark.get(t));
  eq("buildThemeFromVars: background", built.background, "rgb(21, 21, 21)");
  eq("buildThemeFromVars: red", built.red, "rgb(248, 113, 113)");
  eq("buildThemeFromVars: 缺失 token 省略", built.green, undefined);
  const fakeLight = new Map<string, string>([
    ["--terminal-bg", "252 252 251"],
    ["--terminal-fg", "21 21 21"],
    ["--terminal-cursor", "5 150 105"],
  ]);
  const builtLight = buildThemeFromVars((t) => fakeLight.get(t));
  check("★ 同一构建器能产出浅/深两套不同值", builtLight.background !== built.background && builtLight.cursor !== built.cursor);
}

section("14. 【ARC-005】圆角 role 档（btn-xs/btn-md/dialog/code/card）");
{
  const css = read("src/renderer/styles.css");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = read("src/renderer/tokens.cds.css");
  const ROLE_TOKENS = ["--radius-btn-xs", "--radius-btn-md", "--radius-dialog", "--radius-code", "--radius-card"];

  // ★ 五个 role 档都有**真实定义**（剥注释后的声明本体）。这些档主题无关
  // （上游在 :root 的别名块里、暗色不覆盖），所以只要求 `:root` 有一份 ——
  // 但 sketch 的形状块必须重指它们（see below），否则手绘主题丢形状语言。
  for (const tok of ROLE_TOKENS) {
    check(`★ ${tok} 已定义`, new RegExp(`${tok}:\\s*var\\([^)]+\\);`).test(noComments));
  }
  // 反向正控：role 档不许重抄 px/rem 字面量（值必须来自生成物/已有档）。
  const literals = ROLE_TOKENS.filter((tok) => new RegExp(`${tok}:\\s*[\\d.]`).test(noComments));
  check("★ role 档不写 px/rem 字面量（单一真源）", literals.length === 0, literals);

  // ★ 每个 role 档引用的上游键在生成物里真的存在且有值 —— 否则 var() 解析
  // 为空、圆角整条失效（静默）。
  const upstreamRefs: Record<string, string> = {
    "--radius-btn-xs": "--radius-md",
    "--radius-btn-md": "--radius-lg",
    "--radius-dialog": "--radius-2xl",
    "--radius-code": "--radius-xl",
    "--radius-card": "--m-message-bubble-radius",
  };
  for (const [role, upstream] of Object.entries(upstreamRefs)) {
    check(`★ ${role} 指向上游键 ${upstream}`, new RegExp(`${role}:\\s*var\\(${upstream.replace(/[()]/g, "\\$&")}\\)`).test(noComments));
    check(`★ 生成物里有 ${upstream} 且非空`, new RegExp(`${upstream}:\\s*[^;]+;`).test(tokens));
  }
  // 上游档位值与参考矩阵一致（6/8/16/12px + card 的 calc 同算式）。
  check("★ 上游 radius-md = 6px（btn-xs 档）", /--radius-md:\s*\.375rem;/.test(tokens));
  check("★ 上游 radius-lg = 8px（btn-md 档）", /--radius-lg:\s*\.5rem;/.test(tokens));
  check("★ 上游 radius-2xl = 16px（dialog 档）", /--radius-2xl:\s*1rem;/.test(tokens));
  check("★ 上游 radius-xl = 12px（code 档）", /--radius-xl:\s*\.75rem;/.test(tokens));
  check("★ card 档与气泡同算式（≈12px）", /--m-message-bubble-radius:\s*calc\(8px \+ calc\(\.25rem \* 1\)\)/.test(tokens));

  // ★ Button 各 size 不再写裸 rounded 数值 —— 三个 size 都消费 role 档。
  const button = read("src/renderer/components/ui/button.tsx");
  const buttonNoComments = button.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("★ button base 不再有裸 rounded", !/"inline-flex[^"]*\brounded\b(?!-\[)/.test(buttonNoComments));
  check("★ button sm 消费 --radius-btn-xs", /sm:\s*"[^"]*rounded-\[var\(--radius-btn-xs\)\]/.test(buttonNoComments));
  check("★ button md 消费 --radius-btn-md", /md:\s*"[^"]*rounded-\[var\(--radius-btn-md\)\]/.test(buttonNoComments));
  check("★ button icon 消费 --radius-btn-xs", /icon:\s*"[^"]*rounded-\[var\(--radius-btn-xs\)\]/.test(buttonNoComments));
  // 反向正控：size 里不得再出现 Tailwind 数值圆角（rounded / rounded-lg / rounded-md）。
  const sizeBlock = /size:\s*\{([\s\S]*?)\},\s*defaultVariants/.exec(buttonNoComments)?.[1] ?? "";
  const bareSizes = sizeBlock.match(/\brounded(-(sm|md|lg|xl|2xl))?\b(?!-\[)/g);
  check("★ button 各 size 无裸圆角类", bareSizes === null, bareSizes);

  // ★ 其它消费点接上 role 档：Card→card、Dialog.Popup→dialog、代码块→code。
  const card = read("src/renderer/components/ui/card.tsx").replace(/\/\/[^\n]*/g, "");
  check("★ Card 消费 --radius-card", card.includes("rounded-[var(--radius-card)]"));
  check("★ Card 不再写 rounded-lg", !/"rounded-lg[^"]*border border-edge bg-surface"/.test(card));
  const dialog = read("src/renderer/components/ui/dialog.tsx").replace(/\/\/[^\n]*/g, "");
  check("★ Dialog.Popup 消费 --radius-dialog", dialog.includes("rounded-[var(--radius-dialog)]"));
  check("★ Dialog.Popup 不再写 rounded-lg", !/"rounded-lg border border-edge bg-surface shadow-2xl"/.test(dialog));
  const md = read("src/renderer/components/chat/Markdown.tsx").replace(/\/\/[^\n]*/g, "");
  // code 档在 CSS 侧消费（不动 Markdown.tsx）：`.chat-md > pre` 特异性
  // (0,1,1) 高于 Tailwind `.rounded-lg` (0,1,0)，围栏代码块改用 role 档。
  check("★ 围栏代码块消费 --radius-code（styles.css）",
    /\.chat-md > pre\s*\{[^}]*border-radius:\s*var\(--radius-code\)/.test(noComments));
  check("★ Markdown.tsx 未写入 role token（消费点在 CSS）", !md.includes("--radius-code"));

  // ★ sketch 主题必须把 role 档重指回手抖档 —— Tailwind 任意值类
  // (rounded-[var(--radius-*)]) 是字面量选择器，不经过 .rounded-lg 那套映射，
  // 不重指的话手绘主题在这几处直接退化成规则圆角。
  const sketchAt = noComments.lastIndexOf("html.sketch {");
  const sketchBlock = sketchAt >= 0 ? noComments.slice(sketchAt, noComments.indexOf("}", sketchAt)) : "";
  for (const tok of ROLE_TOKENS) {
    check(`★ sketch 重指 ${tok} 到手抖档`, new RegExp(`${tok}:\\s*var\\(--sk-r-(sm|md|lg)\\)`).test(sketchBlock));
  }
  // 源序：重指块必须在 --sk-r-* 定义块之后，否则引用了未定义变量。
  const skDefAt = noComments.indexOf("--sk-r-lg:");
  check("★ sketch role 重指在 --sk-r-* 定义之后", skDefAt >= 0 && sketchAt > skDefAt);
}


section("15. 【ARC-005】HTML 本地预览入口（工作区围栏 + 复用浏览器面板）");
{
  const { htmlPreviewDecision, canPreviewHtml } = await import(
    "../../src/renderer/components/ide/fileEditorKinds.js"
  );
  const PROJ = "D:/work/proj";
  const posixProj = "/home/u/proj";
  /** 对象结果按内容比（本套的 eq 是 Object.is，比不了新对象）。 */
  const same = (name: string, actual: unknown, expected: unknown): void =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

  // ★ 工作区内 html 被接受（Windows / POSIX 两种拼写、大小写、反斜杠）。
  same("★ 工作区内 .html → 接受", htmlPreviewDecision(PROJ + "/docs/page.html", PROJ), { ok: true });
  same("★ 工作区内 .htm → 接受", htmlPreviewDecision(PROJ + "/a.htm", PROJ), { ok: true });
  same("★ 扩展名大写 → 接受", htmlPreviewDecision(PROJ + "/PAGE.HTML", PROJ), { ok: true });
  same("★ Windows 反斜杠路径 → 接受", htmlPreviewDecision(String.raw`D:\work\proj\docs\p.html`, PROJ), { ok: true });
  same("★ 盘符大小写不同（Windows 语义）→ 接受", htmlPreviewDecision("d:/work/proj/x.html", PROJ), { ok: true });
  same("★ POSIX 工作区内 → 接受", htmlPreviewDecision(posixProj + "/site/index.html", posixProj), { ok: true });
  check("★ canPreviewHtml 与 decision 同判据", canPreviewHtml(PROJ + "/x.html", PROJ) === true);

  // ★ 工作区外路径被拒 —— 系统目录、前缀相同的兄弟目录、上跳目录都不能借道。
  same("★ 工作区外（系统目录）→ 拒绝",
    htmlPreviewDecision(process.platform === "win32" ? "C:/Windows/help.html" : "/etc/index.html", PROJ),
    { ok: false, reason: "outside-workspace" });
  same("★ 前缀相同的兄弟目录 → 拒绝（段比较，不是字符串前缀）",
    htmlPreviewDecision("D:/work/proj-evil/x.html", PROJ), { ok: false, reason: "outside-workspace" });
  same("★ 上跳目录 → 拒绝",
    htmlPreviewDecision(PROJ + "/../other/x.html", PROJ), { ok: false, reason: "outside-workspace" });
  same("★ 空 projectPath → 拒绝（不放开围栏）", htmlPreviewDecision(PROJ + "/x.html", ""),
    { ok: false, reason: "outside-workspace" });

  // ★ 非 html 不误入该入口（防空过）—— 即便在工作区内也拒绝。
  for (const p of ["a.pdf", "a.md", "a.png", "a.tsx", "a.html.txt", "a.docx"]) {
    same(`★ 工作区内 ${p} → 不进 HTML 预览`, htmlPreviewDecision(PROJ + "/" + p, PROJ),
      { ok: false, reason: "not-html" });
  }
  // 判据顺序：种类围栏先判 —— 工作区外的 .pdf 报 not-html 而不是 outside-workspace，
  // 证明两道围栏都在、且不会互相吞掉。
  same("★ 工作区外的 .pdf 仍是 not-html（种类围栏先判）",
    htmlPreviewDecision("/etc/a.pdf", PROJ), { ok: false, reason: "not-html" });

  // ★ 源码级接线：FileEditor 真的用这个判据画按钮、真的走浏览器面板通路。
  const fe = read("src/renderer/components/ide/FileEditor.tsx");
  const feCode = fe.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("★ FileEditor 引入 canPreviewHtml", /\bcanPreviewHtml\b/.test(feCode));
  check("★ FileEditor 预览动作走 openUrlInBrowser", /openUrlInBrowser\(localPathToFileUrl\(/.test(feCode));
  check("★ 按钮仅在 canPreviewHtml 时渲染", /\{canPreviewHtml && \(/.test(feCode));
  // 反向正控：不许为预览新开浏览器视图（会多一份 WebContentsView 生命周期）。
  check("★ 预览入口不新开 WebContentsView（无 browser.create）", !/api\.browser\.create\b/.test(feCode));
  // i18n 两套都有入口文案（zh 是 MessageId 源，缺 key typecheck 会红；这里再钉一次）。
  for (const loc of ["zh", "en"]) {
    const dict = read(`src/renderer/lib/i18n/${loc}/ide.ts`);
    check(`i18n ${loc} 有 ide.editor.previewHtml`, dict.includes('"ide.editor.previewHtml"'));
    check(`i18n ${loc} 有 ide.editor.previewHtmlHint`, dict.includes('"ide.editor.previewHtmlHint"'));
  }
}

section("16. 【ARC-005】每个被消费的语义 token 都真的有定义");
{
  // 判据来自一个真实缺陷：`dialog.tsx` 写着 `shadow-[var(--shadow-lg)]`，
  // 而 styles.css 里**只定义过 --shadow-popover** —— 未定义的自定义属性让
  // 整条 box-shadow 在计算值阶段失效，所有弹窗实际都没有阴影，却没有任何
  // 门禁会红。这里做系统性扫描：渲染端每个 `var(--x)` 引用，若 `--x` 是
  // 本仓库自有的 token（出现在任何 `--x:` 声明里，或属于受管的语义族），
  // 就必须在 styles.css / tokens.cds.css 的某处有定义（或由 TS 运行时写入，
  // 见白名单）。
  const cssAll = read("src/renderer/styles.css") + "\n" + read("src/renderer/tokens.cds.css");
  const defined = new Set<string>();
  for (const m of cssAll.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);

  // 运行时写入的变量：品牌色覆盖（AppearancePanel 内联 style）、滚动羽化
  // 四边（ScrollFade 组件用 style.setProperty 写）。
  //
  // `--terminal-cursor-color` 曾在这里，但它没有任何消费方：xterm 走 ITheme
  // 对象（canvas 绘制），不读 CSS 变量。白名单里留一个没人写的名字会让这条
  // 扫描对"注册了但没人用"的属性失明，已随 @property 一起删除。
  const RUNTIME_WRITTEN = new Set([
    "--accent", "--accent-strong", "--brand-clay", "--brand-clay-strong",
    "--sf-top", "--sf-bottom", "--sf-left", "--sf-right",
  ]);

  // 只扫「本仓库命名的语义族」—— 不扫 Tailwind/第三方自带的（--tw-*、--radix-*）。
  const OWNED_PREFIX = /^--(cds|m|sk|chat|rp|right-panel|composer|dur|ease|spring|shadow|radius|sf|terminal|diff|git-lane|focus|hairline|edge|surface|content|accent|danger|warning|success|info|code|panel|input|brand|bubble|space|font|text|border)/;

  const srcFiles: string[] = [];
  const walk = (dir: string): void => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(tsx?|css)$/.test(name)) srcFiles.push(rel);
    }
  };
  walk("src/renderer");

  const missing = new Map<string, string[]>(); // token → 引用它的文件
  for (const file of srcFiles) {
    const src = read(file);
    // 只取 var() 的**第一个参数**，并记下有没有 fallback：
    //  - `var(--x, 64rem)` 带回落值时，即使 --x 未定义也不会让整条声明失效
    //    （--chat-max-w 就是这种「用户自定义可选」变量），不列为缺陷；
    //  - 名字里带 `${` 是模板拼出来的动态 token（`--git-lane-${i}`），跳过；
    //  - 以 `-` 结尾或形如 `-N` 的是文档/注释里的占位名，跳过。
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)(\s*,[^)]*)?\)/gi)) {
      const tok = m[1];
      const hasFallback = m[2] !== undefined;
      if (hasFallback) continue;
      if (!OWNED_PREFIX.test(tok)) continue;
      if (tok.endsWith("-") || /-N$/.test(tok)) continue;
      if (defined.has(tok) || RUNTIME_WRITTEN.has(tok)) continue;
      // 同文件内自己定义的（组件内联 <style> 或局部 :root）也算有定义。
      if (new RegExp(`${tok}\\s*:`).test(src)) continue;
      const list = missing.get(tok) ?? [];
      if (!list.includes(file)) list.push(file);
      missing.set(tok, list);
    }
  }
  check("★ 所有被引用的自有 token 都有定义（--shadow-lg 缺定义就是这样漏掉的）",
    missing.size === 0, Object.fromEntries(missing));

  // 反向正控：确认扫描**不是空过** —— styles.css 里必须能认出 shadow 族，
  // 且上面那个真实缺陷的 token 现在确实被定义。
  check("★ 扫描基线：--shadow-popover 被认出为已定义", defined.has("--shadow-popover"));
  check("★ --shadow-lg 已定义（Dialog 阴影不再是死声明）", defined.has("--shadow-lg"));
}

section("17. 【ARC-005】手机端安全区与浏览器栏配色");
{
  const html = read("src/renderer/index.html");
  // viewport-fit=cover 是 iOS 上 env(safe-area-inset-*) 非零的前提；
  // 少了它，下面所有 --safe-* 在 iPhone 上恒为 0，刘海照样压内容。
  check("★ viewport 带 viewport-fit=cover", /viewport-fit=cover/.test(html));
  check("★ 有 theme-color meta（首帧按 OS 偏好）", (html.match(/name="theme-color"/g) ?? []).length >= 2);

  const css = read("src/renderer/styles.css");
  for (const tok of ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"]) {
    check(`★ styles.css 定义 ${tok}`, new RegExp(`${tok}:\\s*env\\(safe-area-inset`).test(css));
  }

  // 消费侧：根容器用四边，对话框背板随顶部栏一起下移。
  const appMobile = read("src/renderer/AppMobile.tsx");
  for (const tok of ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"]) {
    check(`★ AppMobile 消费 ${tok}`, appMobile.includes(`var(${tok})`));
  }
  const dialog = read("src/renderer/components/ui/dialog.tsx");
  check("★ Dialog 背板把安全区算进 top",
    /top-\[calc\(2\.5rem\+var\(--safe-top,0px\)\)\]/.test(dialog));

  // theme-color 必须跟着**实际生效**主题走，而不是停在 index.html 的 OS 猜测值：
  // 否则 sketch/kraft 与自定义品牌色下，手机地址栏是一条异色。
  const theme = read("src/renderer/lib/theme.ts");
  /** 取某个函数**自己的函数体**（到下一个顶格 `}` 为止）。
   *
   * 变异验证抓到的教训：先前写成「`applyThemeClass` 之后 600 字符内出现
   * syncThemeColorMeta()」—— 撤掉函数体内的调用后，**下一个函数的调用**
   * 仍落在窗口里，断言照样绿。判据必须按函数体边界，不能按字符距离。 */
  const bodyOf = (name: string): string => {
    const at = theme.indexOf(`export function ${name}`);
    if (at < 0) return "";
    const end = theme.indexOf("\n}\n", at);
    return end < 0 ? "" : theme.slice(at, end);
  };
  check("★ theme.ts 导出 syncThemeColorMeta", /export function syncThemeColorMeta/.test(theme));
  check("★ 主题类切换后同步（applyThemeClass 函数体内）",
    bodyOf("applyThemeClass").includes("syncThemeColorMeta()"));
  check("★ sketch/kraft 切换后同步（applyThemeStyle 函数体内）",
    bodyOf("applyThemeStyle").includes("syncThemeColorMeta()"));
  check("★ 首帧 FOUC guard 末尾同步一次（initFoucGuard 函数体内）",
    bodyOf("initFoucGuard").includes("syncThemeColorMeta()"));
  // 颜色取自 --surface 的计算值（三元组），不是写死两套 hex —— 新主题自动跟随。
  check("★ 颜色读 --surface 而非写死 hex",
    /getPropertyValue\("--surface"\)/.test(theme) && !/syncThemeColorMeta[\s\S]{0,400}#[0-9a-f]{6}/i.test(theme));

  // 手机上的底部抽屉（会话抽屉、活动面板、Git 操作、设置）全部贴 bottom-0，
  // 全面屏手势条会盖住最后一行；四张都必须把 --safe-bottom 加进底部留白。
  for (const [file, label] of [
    ["src/renderer/components/mobile/MobileSessionDrawer.tsx", "会话抽屉"],
    ["src/renderer/components/mobile/ActivitySheet.tsx", "活动面板"],
    ["src/renderer/components/mobile/MobileGitScreenParts.tsx", "Git 操作面板"],
    ["src/renderer/components/mobile/MobileSettingsSheet.tsx", "设置面板"],
  ] as const) {
    const src = read(file);
    const sheetTag = /className=(?:\{cn\(\s*)?"absolute inset-x-0 bottom-0[^"]*"/.exec(src)?.[0] ?? "";
    check(`★ ${label}的底部留白含 --safe-bottom`, sheetTag.includes("--safe-bottom"));
    // 反向正控：不许再写死 pb-2/pb-6（安全区加不进去，手势条照样压）。
    check(`★ ${label}不再写死 pb-2/pb-6`, !/\bpb-(2|6)\b/.test(sheetTag), sheetTag.slice(0, 120));
  }
  // 设置抽屉此前还漏了 CDS 圆角档（rounded-t-2xl），一并钉住。
  check("★ 设置面板圆角走 --radius-dialog",
    read("src/renderer/components/mobile/MobileSettingsSheet.tsx").includes("rounded-t-[var(--radius-dialog)]"));
  // 配对页的二选一也走同一套分段控件 —— 此前是自写的「按钮 + 高亮底」，
  // 与侧栏/抽屉的切换器几何不一致。
  const pairing = read("src/renderer/components/mobile/PairingScreen.tsx");
  check("★ 配对页二选一复用 CDS Segmented", /<Segmented[\s\S]{0,300}?value=\{mode\}/.test(pairing));
  check("★ 配对页不再自写按钮高亮底", !/mode === m \? "bg-surface font-medium/.test(pairing));
  for (const loc of ["zh", "en"]) {
    const dict = read(`src/renderer/lib/i18n/${loc}/mobile.ts`);
    check(`i18n ${loc} 有 mobile.pair.methodLabel`, dict.includes('"mobile.pair.methodLabel"'));
  }
  // 手机 Git 的「变更 / 暂存」也走同一套分段控件（此前是自写按钮组）。
  const mobileGit = read("src/renderer/components/mobile/MobileGitScreen.tsx");
  check("★ 手机 Git 二选一复用 CDS Segmented", /<Segmented[\s\S]{0,400}?value=\{tab\}/.test(mobileGit));
  check("★ 手机 Git 不再自写变更/暂存按钮组", !/tab === "changes" \? "bg-surface/.test(mobileGit));
  for (const loc of ["zh", "en"]) {
    const dict = read(`src/renderer/lib/i18n/${loc}/mobile.ts`);
    check(`i18n ${loc} 有 mobile.git.tabSwitch`, dict.includes('"mobile.git.tabSwitch"'));
  }
  // 计划审批的「执行方式」三选一也走共享分段控件。
  const plan = read("src/renderer/components/chat/PlanApprovalPrompt.tsx");
  check("★ 计划审批三选一复用 CDS Segmented", /<Segmented[\s\S]{0,300}?value=\{exec\}/.test(plan));
  check("★ 计划审批不再自写 segButton 高亮底",
    !/const segButton = /.test(plan) && !/exec === mode[\s\S]{0,40}?bg-surface text-accent/.test(plan));
  // 分段控件的 title 透传：文字被容器查询折叠成图标后，title 是唯一说明。
  const segmented = read("src/renderer/components/ui/cds/Segmented.tsx");
  check("★ Segmented 支持 title 透传", /title\?: string/.test(segmented) && /title=\{tab\.title\}/.test(segmented));

  // 「选中/开关已开」不得再染品牌色（accent 只留给运行中/需要注意）。
  //
  // ── 【T114】这条判据的上一个版本只认「bg-accent/15 紧跟 text-accent」──
  // 它声称的范围是「选中/开关态」，实际只抓「两个类紧邻且顺序固定」这一种写法。
  // 全仓另有四种同一违规的写法一个都抓不到：
  //     border-accent bg-accent/15 text-content        (AskChoiceDialog / BranchChoiceCard)
  //     bg-accent/15 text-content ring-1 …            (FileMentionPicker / SlashCommandPicker)
  //     active ? "bg-accent/15 text-content"          (FileTree / SearchDialog)
  //     bg-accent/15 text-accent-strong               (ActivityConsole，这个是合理的)
  // 判据收窄到字面量组合，和它名字声称的范围不一致 —— 属于「判据范围小于名字」
  // （CLAUDE.md 第二十条 / T113 同族）。
  //
  // ── 为什么不是「把正则放宽到 bg-accent/\d+」──
  // 那样会把「当前」徽标、"1M" 标记、保存成功 toast 一起报出来，而那些是
  // accent 允许的「运行中/需要注意」信号。放宽只会让判据换个方式变窄。
  //
  // ── 现在的形状：按 className 表达式分段，只认「选中语义」──
  // 取 `className={...}` 的整个表达式（不是一行），在同一个表达式里同时要求：
  //   (a) 出现 `bg-accent/15`；
  //   (b) 驱动它的条件里出现**相等比较或"是否是当前项"的标识符**。
  // 「是当前项」用相等比较表达（`picked === o.id`、`idx === activeIdx`），
  // 而「能不能点」用别的形状（`picked.length === 0 || busy`）—— 两者可静态区分，
  // 实测 BranchChoiceCard:127（===）违规、:165（.length===0）合理。
  //
  // ── 它**不覆盖**什么（由下面的负控断言钉住）──
  //   · 选中态用 `bg-accent/10` 或其它透明度（由后面那条 tint 判据管，范围也有限）；
  //   · 运行时拼接的类名（`cn()` 之外用变量拼的）；
  //   · 由非"相等比较"驱动的选中态（例如 `state === "selected"` 之外的语义）。
  const ACTIVE_ACCENT_ALLOWED = [
    // 运行中 / 成功提示
    "chat/ActivityConsole.tsx",
    "chat/PlanViewer.tsx",   // saved toast + 保存按钮可用态
    "chat/PlanStreamBlock.tsx",
    "chat/MessageBlocks.tsx",
    "ide/FileEditor.tsx",    // saved toast
    "mobile/MobileGitScreen.tsx",     // added 是增行语义色
    "settings/CustomModelsPanel.tsx", // 桥接连接状态
    // **分类身份色**（不是选中态）：活动节点的四类、工具类别色板、用户消息
    // 步骤标记 —— 与 git lane 同性质，颜色本身在表达"这是哪一类"。
    "chat/activityShared.ts",
    "ide/turnFlowModel.ts",
    "ide/TurnFlowPanel.tsx",
  ];

  /**
   * 取 `className={...}` 的完整表达式（跳过字符串，按花括号配对）。
   * 只做**静态可靠的**切分；它不是解析器，遇到无法配对的表达式返回 null。
   */
  const classNameBlocks = (src: string): string[] => {
    const blocks: string[] = [];
    const re = /className=\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + "className=".length;
      let depth = 0;
      let i = start;
      let quote: string | null = null;
      let closed = false;
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote !== null) {
          if (c === "\\") { i++; continue; }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { blocks.push(src.slice(start, i + 1)); closed = true; break; } }
      }
      if (!closed) return blocks;   // 切分失败：不做猜测
    }
    return blocks;
  };

  /**
   * 选中态判定：`bg-accent/15` 所在表达式的驱动条件里出现**相等比较**。
   *
   * 【T114 实测】只认相等比较，不认裸标识符。原因是 `picked` 这类名字在两种
   * 语义里都会出现：
   *   `picked === o.id ? "…bg-accent/15…"`        ← 选中态（违规）
   *   `picked.length === 0 || busy ? … : "…bg-accent/15…"` ← 按钮可用态（合理）
   * 用裸标识符 `picked` 判定会把后者一起报出来 —— 实测确实报出来了。
   * 相等比较能把两者分开：一个是 `x === y`，一个是 `x.length === 0`。
   */
  const isSelectionDriven = (block: string): boolean => {
    // 只把 `bg-accent/15` 这个**类名 token 本身**抹掉，不要贪心吃到下一个引号 ——
    // 曾经写成 `bg-accent\/15[^"'`]*`，它会把同一段字符串字面量里
    // bg-accent/15 之后的所有内容（包括别的分支里的 `===`）一起删掉，
    // 导致样本 `picked === "a" ? "…bg-accent/15 text-content" : …` 判不出来。
    const expr = block.replace(/bg-accent\/15/g, "");
    // 相等比较：`x === y` / `x == y`，但**排除**与"空/未定义/布尔/数量"字面量的比较：
    //   `picked.length === 0`、`x === undefined`、`s === ""`、`on === true` 等
    //   都不是"选中了哪一项"。
    // 右侧可以是**标识符**（`picked === o.id`）也可以是**非空字符串字面量**
    // （`mode === "select"`）—— 后者是实测补上的：样本 `picked === "a"` 曾判不出来。
    const eq = /([\w$.]+)\s*===?\s*("[^"]*"|'[^']*'|`[^`]*`|[\w$.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = eq.exec(expr)) !== null) {
      const right = m[2]!.trim();
      // 右边是空字符串 / 布尔 / undefined / null / 小整数 → "是否可用/是否为空"，跳过。
      if (/^(""|''|``|undefined|null|false|true|0|1|2)$/.test(right)) continue;
      // 右边是 `.length` / `.size` / `.count` → 数量判断，不是选中项。
      if (/\.(length|size|count)$/.test(right)) continue;
      // 左边是 `.length` 之类同理（`arr.length === 3`）。
      if (/\.(length|size|count)$/.test(m[1]!.trim())) continue;
      return true;
    }
    // 没有相等比较时的第二类形状：**直接由布尔量驱动**。
    //   `isActive ? "…bg-accent/15…" : "…"`   ← 选中态（违规）
    //   `hasApproval ? "…" : "…"`             ← 注意信号（合理，且不在下方标识符名单里）
    //
    // `active` 是裸的名字，加上它之前实测过：全仓「含 bg-accent/15 且表达式里有 active」
    // 只有 2 处（FileTree 的当前文件、TaskCenterPanel 的筛选条），都是真选中态，
    // 没有误报。**加它之前必须先数，不加就直接加是猜。**
    return /(?:^|[^A-Za-z0-9_$])(active|isActive|isSelected|isPicked|activeIdx|currentIdx)(?:[^A-Za-z0-9_$]|$)/.test(expr);
  };

  const offenders: string[] = [];
  const selectionViolations: string[] = [];
  const scan = (dir: string): void => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) {
        // 必须递归：settings/workflows/ 等子目录里的开关同样是选中态。
        // 变异验证抓到过——只扫一层时，把 SkillsPanel 改回品牌色断言照样绿。
        scan(rel);
        continue;
      }
      if (/\.[jt]sx?$/.test(name)) {
        const src = read(rel);
        const allowed = ACTIVE_ACCENT_ALLOWED.some((a) => rel.endsWith(a));
        // ① 【T114】选中语义驱动的品牌淡底 —— 不管后面跟什么类。
        if (!allowed) {
          for (const block of classNameBlocks(src)) {
            if (block.includes("bg-accent/15") && isSelectionDriven(block)) {
              selectionViolations.push(rel);
              break;
            }
          }
        }
        // ② 旧形状保留：紧邻的 `text-accent`（它是①的子集，但保留是为了
        //    在①的切分失败时仍有一条能红，且覆盖非 className 的字面量场景）。
        if (/bg-accent\/15 text-accent/.test(src) && !allowed) {
          offenders.push(rel);
        }
      }
    }
  };
  scan("src/renderer/components");
  check("★ 选中态不再使用 bg-accent/15 品牌淡底（按 className 表达式分段，只认相等比较/当前项标识符）",
    selectionViolations.length === 0, [...new Set(selectionViolations)]);
  check("★ 选中/开关态不再使用 bg-accent/15 品牌淡底（旧形状：紧邻 text-accent）",
    offenders.length === 0, offenders);

  // 【T114】**负控**：把这条判据「不覆盖什么」变成会红的事实。
  //
  // 一条只在注释里写局限的判据，仍然会让人以为局限之外验过了。下面这些
  // 反例断言证明：它们**确实**会被放过 —— 一旦哪条开始报，说明判据变了，
  // 该回来更新这里的说明，而不是当它是好事。
  {
    // ① 结论：它是"选中"还是"可用"，静态上分不出，所以判据选了相等比较。
    //    这张卡片证明「按钮可用态」不会被误报（BranchChoiceCard:165 是真实样本）。
    const buttonEnabled = `{cn("rounded border px-2.5 py-1", picked.length === 0 || busy
      ? "cursor-default border-edge text-content-subtle"
      : "cursor-pointer border-accent bg-accent/15 text-content hover:bg-accent/25")}`;
    // ② 「运行中/注意」信号：由 `latest` 驱动，是 accent 允许的语义。
    const runningSignal = `{cn("rounded", latest ? "bg-accent/15 text-accent-strong" : "bg-surface-muted")}`;
    // ③ 无条件徽标：整段是静态类，没有驱动条件。
    //    注意用 `className={...}` 形式 —— 判据只看花括号表达式，纯字符串
    //    `className="…"` 根本不在它的扫描范围里（这一条本身也是"不覆盖什么"的一部分）。
    const staticBadge = `<span className={"rounded bg-accent/15 px-1 text-[9px] text-accent"}>{"1M"}</span>`;

    const blockOf = (s: string): string | null => {
      const at = s.indexOf("className={");
      if (at >= 0) return classNameBlocks(s)[0] ?? null;
      const cnAt = s.indexOf("{cn(");
      return cnAt >= 0 ? s.slice(cnAt) : null;
    };
    const notFlagged = (s: string): boolean => {
      const block = blockOf(s);
      if (block === null) return false;
      if (!block.includes("bg-accent/15")) return false;
      return !isSelectionDriven(block);
    };
    check("★【T114 负控】按钮可用态（picked.length === 0）不被当作选中态",
      notFlagged(buttonEnabled), buttonEnabled);
    check("★【T114 负控】运行中信号（latest ? …bg-accent/15…）不被当作选中态",
      notFlagged(runningSignal), runningSignal);
    check("★【T114 负控】无驱动的静态类（className={...} 里没有条件）不被当作选中态",
      notFlagged(staticBadge), staticBadge);
    // ④ 明说不覆盖：纯字符串 `className="…bg-accent/15…"` 不在扫描范围。
    //    这类写法目前全仓存在（MessageTimeline / ModelDropdown 的徽标），
    //    它们都是静态徽标，但**判据本身看不到它们** —— 所以如果将来有人
    //    在这一形状里写了选中态，这条判据不会红。把它写成断言，别让它变成盲区。
    const plainStringClass = `<span className="bg-accent/15 text-accent">x</span>`;
    check("★【T114 不覆盖】纯字符串 className（不带花括号）不在判据扫描范围内",
      classNameBlocks(plainStringClass).length === 0, plainStringClass);

    // ④ 正控：真的选中态必须被抓 —— 否则上面三条「不报」可能只是因为判据恒不报。
    const realSelection = `{cn("rounded border", picked === o.id
      ? "border-accent bg-accent/15 text-content"
      : "border-edge text-content-muted")}`;
    const block = blockOf(realSelection);
    check("★【T114 正控】相等比较驱动的选中态（picked === o.id）必须被抓",
      block !== null && block.includes("bg-accent/15") && isSelectionDriven(block), realSelection);
  }

  // 同一判据的淡底变体：`bg-accent/10`。允许项 = 需要"注意/运行中"的信号
  // （下载条、已选元素条、计划/侧聊的待处理提示、选择引用、恢复/合并向导
  // 的注意力图标、拖放目标、手势录制中的按键、LSP 成功已改 success）。
  const TINT10_ALLOWED = [
    "chat/McpToolDecisionCard.tsx", // 真 MCP 执行中的状态徽标（非选择/开关态）
    "browser/DownloadBar.tsx",
    "browser/PickedElementsBar.tsx",
    "chat/ContentTagChip.tsx",
    "chat/MessageBlocks.tsx",
    "chat/MessageRow.tsx",
    "chat/QuestionPrompt.tsx",
    "chat/SelectionQuoteMenu.tsx",
    "chat/SideChatPanel.tsx",
    "chat/SelectionToolbar.tsx",
    "chat/WorktreeMergeBackParts.tsx",
    "ide/GitRepoCard.tsx",
    "layout/ThreePaneLayout.tsx",       // 拖放目标
    "settings/AboutPanel.tsx",          // 品牌大图标
    "settings/GestureRecorder.tsx",     // 录制中
    "settings/LspLanguagesPanel.tsx",   // 服务器状态徽标
    "chat/PlanViewer.tsx",
    "chat/PlanStreamBlock.tsx",
    "chat/BranchChoiceCard.tsx",
    "chat/ChatPane.tsx",
    "ide/SearchDialog.tsx",
    "layout/CommandPalette.tsx",
    "chat/MicButton.tsx",               // 录音中
    "settings/RuntimesPanel.tsx",       // 安装中 / 已安装
    "settings/ShortcutRecorder.tsx",    // 录制中
    "settings/PluginsPanel.tsx",        // 插件生态身份色
    "settings/workflows/WorkflowNodeCard.tsx", // 节点类型身份色
    "ui/badge.tsx",                     // accent 变体定义本身
  ];
  const tint10: string[] = [];
  const scan10 = (dir: string): void => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) { scan10(rel); continue; }
      if (!/\.[jt]sx?$/.test(name)) continue;
      const src = read(rel);
      // 只看**非 hover** 的淡底：hover:bg-accent/10 已在第一批全部改中性。
      if (/[^:]bg-accent\/10/.test(src.replace(/hover:bg-accent\/10/g, ""))
        && !TINT10_ALLOWED.some((a) => rel.endsWith(a))) {
        tint10.push(rel);
      }
    }
  };
  scan10("src/renderer/components");
  check("★ 未登记的白名单外 bg-accent/10 淡底为零", tint10.length === 0, tint10);
  // 反向正控：白名单里的确实还在用（否则白名单本身失效、断言空过）。
  check("★ 白名单正控：运行中/成功提示仍用品牌色",
    read("src/renderer/components/chat/ActivityConsole.tsx").includes("bg-accent/15"));
  // 共享 Skeleton 必须走 CDS 扫光，不许回退 animate-pulse —— 两套加载观感
  // 同时存在会让"同一个面板等待中"看起来像两个产品。
  // 比较前先剥注释：注释里提到 animate-pulse（解释"不再用它"）不该判红。
  const skeletonSrc = read("src/renderer/components/ui/spinner.tsx");
  const skeleton = skeletonSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("★ 共享 Skeleton 使用 CDS 扫光", skeleton.includes("cds-skeleton"));
  check("★ 共享 Skeleton 不再用 animate-pulse", !/animate-pulse/.test(skeleton));
  // @property 注册只留**有消费方**的四个滚动羽化边。注册一个没人读的
  // 类型化属性不会让任何东西可插值，只会给后来者制造"这里在动"的错觉。
  const cssForProps = read("src/renderer/styles.css") + "\n" + read("src/renderer/tokens.cds.css");
  const registered = [...cssForProps.matchAll(/@property\s+(--[a-z0-9-]+)/g)].map((m) => m[1]);
  check("★ @property 只注册 ScrollFade 四边",
    registered.length === 4 && registered.every((t) => t.startsWith("--sf-")), registered);
  for (const dead of ["--cds-dot-scale", "--terminal-cursor-color"]) {
    check(`★ 无消费方的 @property ${dead} 未被注册`, !registered.includes(dead));
  }
}
console.log(`\ndesign-tokens-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
