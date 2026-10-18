/**
 * 【ARC-005】xterm 主题的 token 解析层。
 *
 * xterm 用 canvas 画字，CSS 规则管不到它 —— 配色只能经 `ITheme` 对象喂进去。
 * 此前 `TerminalView.buildTheme(dark)` 里是两套硬编码 hex 调色板（44 处色值），
 * 与 styles.css 的语义 token 体系完全脱节：主题/品牌色/sketch 风格变化时终端
 * 不跟随。现在改为：
 *
 *  1. styles.css 的 `:root` / `.dark` 定义 `--terminal-*` token（R G B 三元组，
 *     与 `--surface` 等同源的写法）；语义项引用 `var(--surface)` 等，ANSI 协议色
 *     保留现有终端调色板值（红必须是红，不跟品牌色）。
 *  2. 本模块的纯函数 `buildThemeFromVars(readVar)` 把三元组拼成 xterm 接受的
 *     `rgb(r, g, b)`；`buildTerminalTheme()` 在浏览器侧从
 *     `getComputedStyle(document.documentElement)` 读当前生效值。
 *
 * 因为每次建主题都**现读**计算值，`html.dark` / `html.sketch` 的切换（以及
 * runtime 品牌色覆盖）下一次重建就会生效 —— 消费端在 `useIsDark()` 变化时重建
 * 主题（TerminalView / ReadonlyTerminal 的 `[dark]` effect）。
 *
 * 断言在 scripts/design-tokens-smoke §13。
 */
import type { ITheme } from "@xterm/xterm";

/**
 * ITheme 字段 → styles.css token 名。ANSI 十六色是终端协议色，集中在这里
 * 定义；语义六项（背景/前景/光标×2/选区×2）引用语义 token。
 */
export const TERMINAL_THEME_TOKENS = {
  background: "--terminal-bg",
  foreground: "--terminal-fg",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-cursor-accent",
  selectionBackground: "--terminal-selection-bg",
  selectionForeground: "--terminal-selection-fg",
  black: "--terminal-black",
  red: "--terminal-red",
  green: "--terminal-green",
  yellow: "--terminal-yellow",
  blue: "--terminal-blue",
  magenta: "--terminal-magenta",
  cyan: "--terminal-cyan",
  white: "--terminal-white",
  brightBlack: "--terminal-bright-black",
  brightRed: "--terminal-bright-red",
  brightGreen: "--terminal-bright-green",
  brightYellow: "--terminal-bright-yellow",
  brightBlue: "--terminal-bright-blue",
  brightMagenta: "--terminal-bright-magenta",
  brightCyan: "--terminal-bright-cyan",
  brightWhite: "--terminal-bright-white",
} as const satisfies Record<string, `--terminal-${string}`>;

/**
 * 把 CSS 自定义属性的 "R G B" 三元组转成 xterm 的 `rgb(r, g, b)`。
 * 不识别的形态（空串 / hex / 缺分量 / 越界）返回 null —— 调用方跳过该键，
 * xterm 回落到内置默认值；**不在这里编造颜色**。
 */
export function tripletToXtermColor(value: string | null | undefined): string | null {
  const triplet = value?.trim();
  if (!triplet) return null;
  const parts = triplet.split(/\s+/);
  if (parts.length !== 3) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (Number(part) > 255) return null;
  }
  return `rgb(${parts.join(", ")})`;
}

/**
 * 纯函数：给定「token 名 → 原始值」的读取器，产出 xterm ITheme。
 * 读不到/格式不对的 token 直接省略（不落任何字面量颜色）。
 */
export function buildThemeFromVars(readVar: (token: string) => string | null | undefined): ITheme {
  const theme: Record<string, string> = {};
  for (const [field, token] of Object.entries(TERMINAL_THEME_TOKENS)) {
    const color = tripletToXtermColor(readVar(token));
    if (color) theme[field] = color;
  }
  return theme as ITheme;
}

/** 浏览器侧：从 `<html>` 的**当前计算值**建主题（浅/深/sketch 都已生效）。 */
export function buildTerminalTheme(): ITheme {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return {};
  }
  const style = getComputedStyle(document.documentElement);
  return buildThemeFromVars((token) => style.getPropertyValue(token));
}
