import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import type { ThemeName, EffectiveTheme, ThemeStyle } from "@contracts/theme";

/**
 * Toggle the `.dark` class on <html>, which (with `darkMode: 'class'` in the
 * Tailwind config) is what actually re-themes the UI. Exposed for the FOUC
 * guard below and for useTheme() to keep the class in sync.
 *
 * When the effective theme actually flips, the `theme-transition` flag is
 * stamped on <html> for ~260ms so styles.css animates the whole chrome
 * between palettes (backgrounds/borders/text fade instead of hard-cutting);
 * the flag is removed afterwards so element-level hover transitions return
 * to their normal timing. No-ops when the theme didn't change (e.g. the FOUC
 * guard already applied the right class at startup) — that keeps the first
 * paint transition-free.
 */
const THEME_TRANSITION_MS = 260;

/** localStorage key mirroring the last applied theme style. Read
 *  synchronously by initFoucGuard() before React mounts (SQLite/IPC aren't
 *  up yet), written by applyThemeStyle() on every change. */
const THEME_STYLE_CACHE_KEY = "mcode-theme-style";

export function applyThemeClass(effective: EffectiveTheme): void {
  const root = document.documentElement;
  const wasDark = root.classList.contains("dark");
  const isDark = effective === "dark";
  if (wasDark === isDark) return;
  root.classList.add("theme-transition");
  if (isDark) root.classList.add("dark");
  else root.classList.remove("dark");
  window.setTimeout(() => root.classList.remove("theme-transition"), THEME_TRANSITION_MS);
  syncThemeColorMeta();
}

/**
 * FOUC guard: apply the initial `.dark` class to <html> BEFORE React mounts,
 * so the first painted frame matches the OS theme preference. Call this once
 * at the top of main.tsx (synchronously, before createRoot).
 *
 * We can't read the persisted SQLite preference here (preload/IPC aren't ready
 * yet), so we fall back to the OS `prefers-color-scheme` media query - which
 * matches the default "system" theme. The main process has already set
 * `nativeTheme.themeSource` from the persisted preference during `whenReady`,
 * so under Electron this media query reflects the *resolved* theme, not just
 * the raw OS setting. useTheme() corrects the class the moment it loads the
 * real preference.
 *
 * Lives in an external ESM module (not an inline <script>) so it passes the
 * production CSP `script-src 'self'`.
 */
export function initFoucGuard(): void {
  try {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyThemeClass(prefersDark ? "dark" : "light");
  } catch {
    // matchMedia unavailable - leave default (light); useTheme() will fix up.
  }
  // Sketch-style FOUC guard: unlike the color scheme there is no OS media
  // query to guess from, so we keep a localStorage mirror of the last applied
  // value (written by applyThemeStyle) and read it synchronously here. SQLite
  // isn't reachable yet at this point; the first-paint hydration in
  // sessionStore corrects the class the moment the real preference lands.
  try {
    const cached = localStorage.getItem(THEME_STYLE_CACHE_KEY);
    if (cached === "sketch" || cached === "classic") applyThemeStyle(cached);
  } catch {
    // localStorage unavailable (or disabled) - stay classic; hydration fixes.
  }
  syncThemeColorMeta();
}

/**
 * Mirror the theme-style preference as a `.sketch` class on <html> (sibling
 * of `.dark`; the two dimensions are independent). styles.css holds ONE
 * centralized `html.sketch` section — token palette, hand-drawn shape
 * recipes, the handwriting font stack and the icon wobble filter all live
 * there. Also refreshed into the localStorage cache the FOUC guard reads.
 */
/**
 * 【ARC-005 V2】把手机浏览器地址栏 / 状态栏的颜色同步到**实际生效**主题。
 *
 * index.html 里的两条 `<meta name="theme-color">` 只是按 OS 偏好做的首帧
 * 猜测（那时还读不到 SQLite 偏好，也还不知道 sketch/kraft 主题与自定义
 * 品牌色）。这里从 `--surface` 的计算值生成真正的色值并写进 meta：
 *   - 主题切换（`applyThemeClass`）后调用；
 *   - sketch/kraft 切换（`applyThemeStyle`）后调用；
 *   - 自定义 CSS 注入后由设置面板调用。
 *
 * 读 `--surface` 而不是写死浅/深两值：它是 "R G B" 三元组，sketch/kraft 与
 * 未来任何主题都会自动跟随。桌面 Electron 也有这个 API，但无副作用
 * （没有浏览器栏），不必特判平台。
 */
export function syncThemeColorMeta(): void {
  if (typeof document === "undefined") return;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,3}$/.test(p))) return;
  const color = `rgb(${parts.join(", ")})`;
  // 两条 media-variant meta 都改写：浏览器按当前媒体查询取其中一条，保持
  // 两者同步可以让用户切到系统深色时，地址栏在新主题生效前就已经是深色。
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = color;
  }
}

export function applyThemeStyle(style: ThemeStyle): void {
  document.documentElement.classList.toggle("sketch", style === "sketch");
  syncThemeColorMeta();
  try {
    localStorage.setItem(THEME_STYLE_CACHE_KEY, style);
  } catch {
    // Cache is best-effort only - a failed write just means one classic
    // first frame after restart before hydration re-applies the class.
  }
}

export interface ThemeState {
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering (system resolved). */
  effective: EffectiveTheme;
}

/**
 * Subscribe to the theme: load the current preference on mount, keep the
 * `.dark` class in sync, and re-apply whenever the effective theme changes
 * (user picked a new one in settings, or the OS switched in 'system' mode).
 *
 * Mount once at the app root (App.tsx). Returns the current state so the
 * appearance panel can render its radio selection.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>({ theme: "system", effective: "dark" });

  useEffect(() => {
    let cancelled = false;
    // Initial load: ask main for the persisted preference + effective value.
    void api.theme.get().then((s) => {
      if (cancelled) return;
      setState(s);
      applyThemeClass(s.effective);
    });
    // Live updates: main pushes theme.changed when the user picks a new theme
    // OR when the OS theme changes while in 'system' mode.
    const off = api.on.themeChanged((msg) => {
      setState({ theme: msg.theme, effective: msg.effective });
      applyThemeClass(msg.effective);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
