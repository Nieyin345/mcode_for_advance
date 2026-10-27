import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { applyThemeStyle } from "@renderer/lib/theme.js";
import type { ChatDensity, ReduceMotion } from "@contracts/ipc";
// 【ARC-005 M1】设置值 → <html> 属性的纯映射拆到叶子模块:无头套件直接 import 它,
// 不必把本文件（→ sessionStore → Monaco worker）整张图拉进 bundle。
export { applyChatDensity, applyReduceMotion } from "./appearanceAttrs.js";
import { applyChatDensity as applyChatDensityAttr, applyReduceMotion as applyReduceMotionAttr } from "./appearanceAttrs.js";
import { CHAT_FONT_SIZE_DEFAULT, RIGHT_PANEL_FONT_SIZE_DEFAULT } from "@renderer/stores/sessionStoreHelpers.js";

/**
 * Runtime application of user-configurable appearance settings.
 *
 * The settings (font size, user-message bg color, global accent color, chat
 * density) live in the session store (hydrated from the `settings` SQLite
 * table). This module mirrors them onto <html> so they cascade into the
 * rendering without per-component plumbing:
 *
 *   --chat-font-size : consumed by `[font-size:var(--chat-font-size)]`
 *                       classes in ChatPane + Markdown.
 *   --user-bubble    : an "R G B" triplet consumed by the `userBubble`
 *                       Tailwind color token (composes `/10` alpha).
 *   --accent         : an "R G B" triplet consumed by the `accent` Tailwind
 *                       color token — the global emphasis color (buttons,
 *                       links, selected states, focus rings, prompt-card
 *                       accents). Composes `/10`, `/15`, `/60` etc. alpha.
 *   data-chat-density: a `<html>` attribute ("compact"|"comfortable"|"cozy")
 *                       consumed by styles.css attribute selectors to set the
 *                       three density vars (--chat-row-gap-assistant /
 *                       --chat-row-gap-user / --chat-block-gap) that drive
 *                       message-stream vertical rhythm.
 *
 * Static fallbacks for the color/font vars live in styles.css (:root + .dark);
 * when the user has NOT customized a value we REMOVE the inline property so
 * the stylesheet default re-asserts (and correctly differs between light/
 * dark — e.g. --accent is emerald-600 in light, emerald-500 in dark). The
 * density fallback ("comfortable") is handled in styles.css via the same
 * attribute selector so an unset value still resolves.
 *
 * This is the project's first runtime CSS-variable write; lib/theme.ts's
 * `applyThemeClass` is the closest precedent (DOM mutation on <html>).
 */

/** Stylesheet default for both font-size vars (styles.css :root/.dark).
 *  When the store value equals it we REMOVE the inline property instead of
 *  writing it, so a theme-scoped stylesheet default can differ — html.sketch
 *  raises the base to 15px for the handwriting face (kaiti smears below
 *  ~13px). An explicit user choice still wins via the inline write.
 *
 *  【UI 重建 2026-10-27】**这个值必须与 store 的默认值逐字相同。**
 *  原来是 14，而 `sessionStore` 的 `chatFontSize` 默认是 15 —— 两者不等，
 *  于是**默认状态每次都会走 else 分支，往 <html> 内联写 15px**，
 *  把样式表的 12.24px 覆盖掉。症状是「样式表改了，界面纹丝不动」，
 *  而所有读 CSS 的断言全是绿的（它们读的是样式表）。
 *
 *  现在两者都指向 `CHAT_FONT_SIZE_DEFAULT`（12.24），import 同一个常量，
 *  **不再各写一份数字**。 */
/* 【UI 重建 2026-10-27】**两个不同的默认值，不能共用一个常量。**
 *
 * 我一度把这里统一成 `CHAT_FONT_SIZE_DEFAULT`（12.24，Claude 正文档），
 * 于是 `applyRightPanelFontSize` 也拿它当「样式表默认」比较 —— 但右栏的
 * 样式表默认仍是 **14px**（`--right-panel-font-size` 没改）。结果：用户把
 * 右栏字号调回 14 时，`px === DEFAULT` 为假 → 写内联 `14px` → 永远不 remove
 * → 「改回默认」这一步再也回不到样式表默认值（`settings-panels-electron-smoke`
 * 的「全局字号变量移除」超时抓到的就是这个）。
 *
 * 现在两个常量各自对应各自的样式表默认。**改哪个字号，就改哪个常量** ——
 * 判断标准是 `styles.css` 里那个变量在 `:root` 的值。 */
const DEFAULT_CHAT_FONT_SIZE_PX = CHAT_FONT_SIZE_DEFAULT;   // 12.24 = --chat-font-size
const DEFAULT_RIGHT_PANEL_FONT_SIZE_PX = RIGHT_PANEL_FONT_SIZE_DEFAULT;

/** Write the chat font size as `--chat-font-size` on <html>. */
export function applyChatFontSize(px: number): void {
  if (px === DEFAULT_CHAT_FONT_SIZE_PX) {
    document.documentElement.style.removeProperty("--chat-font-size");
  } else {
    document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
  }
}

/** Set the message-stream density by writing `data-chat-density` on <html>.
 *  styles.css holds the three per-density variable maps
 *  (--chat-row-gap-assistant / --chat-row-gap-user / --chat-block-gap); this
 *  attribute is the switch. The "comfortable" default is mirrored in
 *  styles.css as the :root fallback so an unset attribute still resolves. */
const applyChatDensity = applyChatDensityAttr;
const applyReduceMotion = applyReduceMotionAttr;

/** Write the global side-panel + settings base font size as
 *  `--right-panel-font-size` on <html>. Despite the var's legacy name, this
 *  is the app-chrome font size: the left project bar, the right files/git/
 *  terminal panels, AND the settings page all inherit it. The derived
 *  `--rp-fs-sm/xs/xxs` variants (defined in styles.css via calc) track this
 *  automatically. Also mirrored into the xterm terminal fontSize directly
 *  from the store (see TerminalView). */
export function applyRightPanelFontSize(px: number): void {
  if (px === DEFAULT_RIGHT_PANEL_FONT_SIZE_PX) {
    document.documentElement.style.removeProperty("--right-panel-font-size");
  } else {
    document.documentElement.style.setProperty("--right-panel-font-size", `${px}px`);
  }
}

/** Write the user-message bg color (R G B triplet) as `--user-bubble` on
 *  <html>. Pass null to remove the override and fall back to the theme
 *  default defined in styles.css. */
export function applyUserBubbleColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--user-bubble", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--user-bubble");
  }
}

/** Write the global brand/accent color (R G B triplet) as `--accent` on
 *  <html>. Pass null to remove the override and fall back to the per-theme
 *  default defined in styles.css (emerald-600 light / emerald-500 dark). */
export function applyAccentColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--accent", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--accent");
  }
}

/**
 * Keep the appearance CSS vars in sync with the session store. Mount once at
 * the app root (alongside useTheme). Re-runs whenever a store value changes
 * (user dragged the slider / picked a color / switched density in Settings),
 * re-applying each var idempotently.
 */
export function useChatAppearance(): void {
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const accentColor = useSessionStore((s) => s.accentColor);
  const chatDensity = useSessionStore((s) => s.chatDensity);
  const reduceMotion = useSessionStore((s) => s.reduceMotion);

  useEffect(() => {
    applyChatFontSize(chatFontSize);
  }, [chatFontSize]);

  useEffect(() => {
    applyUserBubbleColor(userMessageColor);
  }, [userMessageColor]);

  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  useEffect(() => {
    applyChatDensity(chatDensity);
  }, [chatDensity]);

  useEffect(() => {
    applyReduceMotion(reduceMotion);
  }, [reduceMotion]);
}

/**
 * Keep the global side-panel + settings font-size CSS var in sync with the
 * session store. Mount once at the app root (alongside useChatAppearance).
 * Re-runs whenever the store value changes (user dragged the stepper in
 * Settings), re-applying the var idempotently. The derived --rp-fs-* variants
 * (calc'd in styles.css) track this base automatically; the settings page
 * inherits the base via an inline fontSize on its container.
 *
 * The xterm terminal consumes the store value directly (not the CSS var)
 * since its fontSize is a JS option, not a style - see TerminalView.
 */
export function useRightPanelAppearance(): void {
  const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);

  useEffect(() => {
    applyRightPanelFontSize(rightPanelFontSize);
  }, [rightPanelFontSize]);
}

/**
 * Keep the `.sketch` class on <html> in sync with the session store's
 * themeStyle (settings key ui.themeStyle, hydrated in the first-paint batch).
 * Mount once at the app root. The boot-time FOUC guard (lib/theme.ts) has
 * already applied the localStorage-cached value before React mounts; this
 * reconciles against the SQLite source of truth once it lands.
 */
export function useThemeStyle(): void {
  const themeStyle = useSessionStore((s) => s.themeStyle);

  useEffect(() => {
    applyThemeStyle(themeStyle);
  }, [themeStyle]);
}
