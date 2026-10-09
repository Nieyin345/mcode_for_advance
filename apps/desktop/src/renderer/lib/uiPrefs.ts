/**
 * 外观 / 输入的「扩展偏好」:界面字体、代码字体、聊天内容宽度、自定义 CSS、
 * 输入框发送键。
 *
 * 和 sessionStore 里那批外观设置(字号、强调色、气泡色……)的区别:这几项都是纯
 * 渲染端的东西,主进程不用知道、手机也不同步(自定义 CSS 尤其不能让手机写 ——
 * 见 `@contracts/ipc/settingsSync` 的白名单,这些键都不在里面)。所以自成一个小
 * store,不往那份几千行的 sessionStore 里加字段。
 *
 * 落地方式:
 *   - 字体 / 宽度 → `<style id="mcode-ui-prefs">` 里生成几条规则 + `--chat-max-w`;
 *     用户没设的项不生成规则,样式表默认值原样生效。
 *   - 自定义 CSS → 单独一个 `<style id="mcode-user-css">`,挂在 <head> 最后,
 *     排在应用样式表之后,同优先级时用户的规则赢。
 *   - 发送键 → ComposerEditor 在按键时读 `useUiPrefsStore.getState().sendKey`。
 *   - 终端字体 → TerminalView 订阅 `fontMono`(xterm 用 canvas 画字,CSS 管不到)。
 */
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@renderer/lib/api.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

export const UI_FONT_SANS_SETTING_KEY = "ui.font.sans";
export const UI_FONT_MONO_SETTING_KEY = "ui.font.mono";
export const UI_CHAT_MAX_WIDTH_SETTING_KEY = "ui.chat.maxWidth";
export const UI_CUSTOM_CSS_SETTING_KEY = "ui.customCss";
export const UI_CUSTOM_CSS_ENABLED_SETTING_KEY = "ui.customCss.enabled";
export const UI_COMPOSER_SEND_KEY_SETTING_KEY = "ui.composer.sendKey";

export const CHAT_MAX_WIDTHS = ["narrow", "standard", "wide", "full"] as const;
export type ChatMaxWidth = (typeof CHAT_MAX_WIDTHS)[number];
/** standard = 历来的 max-w-5xl(64rem)。 */
const CHAT_MAX_WIDTH_CSS: Record<ChatMaxWidth, string> = {
  narrow: "48rem",
  standard: "64rem",
  wide: "80rem",
  full: "none",
};

/** enter:Enter 发送、Shift+Enter 换行(默认);modEnter:Ctrl/⌘+Enter 发送、Enter 换行。 */
export type ComposerSendKey = "enter" | "modEnter";

/** 与 styles.css 的 `html, body, #root` 一致 —— 用户字体排在前面,这串当兜底。 */
const DEFAULT_SANS_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
/** 与 tailwind `font-mono` / TerminalView 一致。 */
export const DEFAULT_MONO_STACK =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const FONT_FAMILY_MAX = 300;
export const CUSTOM_CSS_MAX = 100_000;

/**
 * 把用户输入的字体列表清洗成能安全放进一条 CSS 声明的值:去掉会结束声明 / 规则
 * 的字符(`; { } < >` 反斜杠、换行),引号不成对时整体去掉引号(不然未闭合的字符串
 * 会把这条声明吞掉),首尾多余逗号去掉。空串 = 未设置。
 */
export function sanitizeFontFamily(raw: string): string {
  let s = raw.replace(/[;{}<>\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, FONT_FAMILY_MAX);
  if ((s.match(/"/g) ?? []).length % 2 === 1) s = s.replace(/"/g, "");
  if ((s.match(/'/g) ?? []).length % 2 === 1) s = s.replace(/'/g, "");
  return s.replace(/^[\s,]+|[\s,]+$/g, "");
}

function parseChatMaxWidth(v: string | null | undefined): ChatMaxWidth {
  return (CHAT_MAX_WIDTHS as readonly string[]).includes(v ?? "") ? (v as ChatMaxWidth) : "standard";
}

interface UiPrefsState {
  loaded: boolean;
  fontSans: string;
  fontMono: string;
  chatMaxWidth: ChatMaxWidth;
  customCss: string;
  customCssEnabled: boolean;
  sendKey: ComposerSendKey;
  hydrate: () => Promise<void>;
  setFontSans: (v: string) => void;
  setFontMono: (v: string) => void;
  setChatMaxWidth: (v: ChatMaxWidth) => void;
  setCustomCss: (v: string) => void;
  setCustomCssEnabled: (v: boolean) => void;
  setSendKey: (v: ComposerSendKey) => void;
}

function persist(key: string, value: string): void {
  void api.setting.set({ key, value }).catch((err: unknown) => {
    // **落盘失败要说出来。** 这几个 setter 都是"先乐观改 store、再落盘"——失败时界面上
    // 已是新值,只打日志的话用户看到"改动生效了",直到重启才静默弹回旧值。与
    // `sessionStore` 那批外观 setter 走同一个共享出口(`store.toast.settingSaveFailed`,
    // toastStore 按标题去重)。`uiPrefs` 不 import i18n 的 hook,用 core 的纯函数取词。
    console.error(`setting.set(${key}) failed:`, err);
    useToastStore.getState().push({
      kind: "error",
      title: translate(useSessionStore.getState().locale, "store.toast.settingSaveFailed"),
      body: err instanceof Error ? err.message : String(err),
    });
  });
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  loaded: false,
  fontSans: "",
  fontMono: "",
  chatMaxWidth: "standard",
  customCss: "",
  customCssEnabled: true,
  sendKey: "enter",

  hydrate: async () => {
    if (get().loaded) return;
    const v = await api.setting
      .getMany({
        keys: [
          UI_FONT_SANS_SETTING_KEY,
          UI_FONT_MONO_SETTING_KEY,
          UI_CHAT_MAX_WIDTH_SETTING_KEY,
          UI_CUSTOM_CSS_SETTING_KEY,
          UI_CUSTOM_CSS_ENABLED_SETTING_KEY,
          UI_COMPOSER_SEND_KEY_SETTING_KEY,
        ],
      })
      .catch((err: unknown) => {
        console.error("setting.getMany(uiPrefs) failed:", err);
        return {} as Record<string, string | null>;
      });
    set({
      loaded: true,
      fontSans: sanitizeFontFamily(v[UI_FONT_SANS_SETTING_KEY] ?? ""),
      fontMono: sanitizeFontFamily(v[UI_FONT_MONO_SETTING_KEY] ?? ""),
      chatMaxWidth: parseChatMaxWidth(v[UI_CHAT_MAX_WIDTH_SETTING_KEY]),
      customCss: (v[UI_CUSTOM_CSS_SETTING_KEY] ?? "").slice(0, CUSTOM_CSS_MAX),
      customCssEnabled: v[UI_CUSTOM_CSS_ENABLED_SETTING_KEY] !== "off",
      sendKey: v[UI_COMPOSER_SEND_KEY_SETTING_KEY] === "modEnter" ? "modEnter" : "enter",
    });
  },

  setFontSans: (raw) => {
    const v = sanitizeFontFamily(raw);
    set({ fontSans: v });
    persist(UI_FONT_SANS_SETTING_KEY, v);
  },
  setFontMono: (raw) => {
    const v = sanitizeFontFamily(raw);
    set({ fontMono: v });
    persist(UI_FONT_MONO_SETTING_KEY, v);
  },
  setChatMaxWidth: (v) => {
    set({ chatMaxWidth: v });
    persist(UI_CHAT_MAX_WIDTH_SETTING_KEY, v);
  },
  setCustomCss: (raw) => {
    const v = raw.slice(0, CUSTOM_CSS_MAX);
    set({ customCss: v });
    persist(UI_CUSTOM_CSS_SETTING_KEY, v);
  },
  setCustomCssEnabled: (on) => {
    set({ customCssEnabled: on });
    persist(UI_CUSTOM_CSS_ENABLED_SETTING_KEY, on ? "on" : "off");
  },
  setSendKey: (v) => {
    set({ sendKey: v });
    persist(UI_COMPOSER_SEND_KEY_SETTING_KEY, v);
  },
}));

/** 由字体 / 宽度偏好生成的样式表文本;全是默认值时返回空串。 */
export function buildUiPrefsCss(p: Pick<UiPrefsState, "fontSans" | "fontMono" | "chatMaxWidth">): string {
  const rules: string[] = [];
  if (p.chatMaxWidth !== "standard") {
    rules.push(`:root { --chat-max-w: ${CHAT_MAX_WIDTH_CSS[p.chatMaxWidth]}; }`);
  }
  if (p.fontSans) {
    // 手绘风格(html.sketch)保留它自己的手写字体 —— 那是该风格的一部分。
    rules.push(
      `html:not(.sketch) body, html:not(.sketch) #root, html:not(.sketch) .font-sans { font-family: ${p.fontSans}, ${DEFAULT_SANS_STACK}; }`,
    );
  }
  if (p.fontMono) {
    // 代码块 / 行内代码 / diff / 文件编辑器(CodeMirror)。终端走 xterm 选项,见 TerminalView。
    rules.push(
      `html .font-mono, html code, html kbd, html samp, html pre, html .cm-editor .cm-scroller { font-family: ${p.fontMono}, ${DEFAULT_MONO_STACK}; }`,
    );
  }
  return rules.join("\n");
}

function upsertStyle(id: string, css: string): void {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
  }
  // 每次都挪到 <head> 末尾:开发模式下 Vite 会在后面追加样式,要保证用户的规则排最后。
  document.head.appendChild(el);
  if (el.textContent !== css) el.textContent = css;
}

/** 终端用的字体栈(用户设了代码字体就排在前面)。 */
export function monoFontStack(fontMono: string): string {
  return fontMono ? `${fontMono}, ${DEFAULT_MONO_STACK}` : DEFAULT_MONO_STACK;
}

/** 在应用根挂一次:读取偏好并把它们同步到 DOM。 */
export function useUiPrefsAppearance(): void {
  const hydrate = useUiPrefsStore((s) => s.hydrate);
  const fontSans = useUiPrefsStore((s) => s.fontSans);
  const fontMono = useUiPrefsStore((s) => s.fontMono);
  const chatMaxWidth = useUiPrefsStore((s) => s.chatMaxWidth);
  const customCss = useUiPrefsStore((s) => s.customCss);
  const customCssEnabled = useUiPrefsStore((s) => s.customCssEnabled);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    upsertStyle("mcode-ui-prefs", buildUiPrefsCss({ fontSans, fontMono, chatMaxWidth }));
  }, [fontSans, fontMono, chatMaxWidth]);

  useEffect(() => {
    upsertStyle("mcode-user-css", customCssEnabled ? customCss.trim() : "");
  }, [customCss, customCssEnabled]);
}
