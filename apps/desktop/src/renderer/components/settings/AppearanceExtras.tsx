/**
 * 设置 → 外观 里的两块扩展:「字体与版式」(界面字体、代码字体、聊天内容宽度)
 * 和「自定义 CSS」。状态在 `lib/uiPrefs.ts`(自成一个小 store,纯渲染端)。
 *
 * 字体输入框失焦 / 回车才提交 —— 边打边套用会让整页字体在半截名字之间来回跳。
 * 自定义 CSS 要点「应用」才生效,写坏了随时能关开关恢复。
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select, Switch } from "@renderer/components/ui/index.js";
import {
  CHAT_MAX_WIDTHS,
  CUSTOM_CSS_MAX,
  FONT_FAMILY_MAX,
  sanitizeFontFamily,
  useUiPrefsStore,
  type ChatMaxWidth,
} from "@renderer/lib/uiPrefs.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const SANS_SUGGESTIONS = [
  "Microsoft YaHei UI",
  "PingFang SC",
  "HarmonyOS Sans SC",
  "MiSans",
  "Source Han Sans SC",
  "Noto Sans SC",
  "LXGW WenKai",
  "Inter",
  "Segoe UI",
];
const MONO_SUGGESTIONS = [
  "JetBrains Mono Variable",
  "Cascadia Code",
  "Fira Code",
  "Consolas",
  "Sarasa Mono SC",
  "Maple Mono NF CN",
  "Source Code Pro",
  "Menlo",
];

const WIDTH_LABEL: Record<ChatMaxWidth, MessageId> = {
  narrow: "settings.appearance.chatWidth.narrow",
  standard: "settings.appearance.chatWidth.standard",
  wide: "settings.appearance.chatWidth.wide",
  full: "settings.appearance.chatWidth.full",
};

/** 失焦 / 回车提交的字体输入框;外部值变了(另一处改了 / 清空)会同步回来。 */
function FontInput({
  id,
  value,
  onCommit,
  placeholder,
  listId,
  suggestions,
  mono,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder: string;
  listId: string;
  suggestions: string[];
  mono?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full items-center gap-1.5">
        <Input
          id={id}
          value={draft}
          list={listId}
          maxLength={FONT_FAMILY_MAX}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 font-sans"
        />
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onCommit("")} title={t("settings.appearance.fontResetTitle")}>
            {t("settings.appearance.fontReset")}
          </Button>
        )}
      </div>
      <datalist id={listId}>
        {suggestions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <span
        className={cn("truncate text-[0.8571em] text-content-muted", mono && "font-mono")}
        style={value ? { fontFamily: `${value}, ${mono ? "monospace" : "sans-serif"}` } : undefined}
      >
        {mono ? "const 示例 = () => 0x1F; // il1I O0" : t("settings.appearance.fontPreview")}
      </span>
    </div>
  );
}

export function TypographySection() {
  const { t } = useI18n();
  const fontSans = useUiPrefsStore((s) => s.fontSans);
  const fontMono = useUiPrefsStore((s) => s.fontMono);
  const chatMaxWidth = useUiPrefsStore((s) => s.chatMaxWidth);
  const setFontSans = useUiPrefsStore((s) => s.setFontSans);
  const setFontMono = useUiPrefsStore((s) => s.setFontMono);
  const setChatMaxWidth = useUiPrefsStore((s) => s.setChatMaxWidth);

  return (
    <SettingsSection title={t("settings.appearance.sectionTypography")}>
      <SettingRow
        title={t("settings.appearance.fontSans")}
        desc={t("settings.appearance.fontSansDesc")}
        htmlFor="setting-font-sans"
        controlAlign="start"
      >
        <FontInput
          id="setting-font-sans"
          value={fontSans}
          onCommit={setFontSans}
          placeholder={t("settings.appearance.fontDefault")}
          listId="setting-font-sans-list"
          suggestions={SANS_SUGGESTIONS}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.appearance.fontMono")}
        desc={t("settings.appearance.fontMonoDesc")}
        htmlFor="setting-font-mono"
        controlAlign="start"
      >
        <FontInput
          id="setting-font-mono"
          value={fontMono}
          onCommit={setFontMono}
          placeholder={t("settings.appearance.fontDefault")}
          listId="setting-font-mono-list"
          suggestions={MONO_SUGGESTIONS}
          mono
        />
      </SettingRow>
      <SettingRow
        title={t("settings.appearance.chatWidth")}
        desc={t("settings.appearance.chatWidthDesc")}
        htmlFor="setting-chat-width"
      >
        <Select.Root value={chatMaxWidth} onValueChange={(v) => setChatMaxWidth(v as ChatMaxWidth)}>
          <Select.Trigger id="setting-chat-width" className="w-full">
            <Select.Value>{(val: ChatMaxWidth) => t(WIDTH_LABEL[val] ?? WIDTH_LABEL.standard)}</Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner>
              <Select.Popup>
                <Select.List>
                  {CHAT_MAX_WIDTHS.map((w) => (
                    <Select.Item key={w} value={w}>
                      <Select.ItemText>{t(WIDTH_LABEL[w])}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </SettingRow>
    </SettingsSection>
  );
}

export function CustomCssSection() {
  const { t } = useI18n();
  const customCss = useUiPrefsStore((s) => s.customCss);
  const enabled = useUiPrefsStore((s) => s.customCssEnabled);
  const setCustomCss = useUiPrefsStore((s) => s.setCustomCss);
  const setEnabled = useUiPrefsStore((s) => s.setCustomCssEnabled);
  const [draft, setDraft] = useState(customCss);
  useEffect(() => setDraft(customCss), [customCss]);
  const dirty = draft !== customCss;

  return (
    <SettingsSection title={t("settings.appearance.sectionCustomCss")}>
      <SettingRow
        title={t("settings.appearance.customCssEnabled")}
        desc={t("settings.appearance.customCssEnabledDesc")}
        htmlFor="setting-custom-css-enabled"
      >
        <Switch
          id="setting-custom-css-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          label={enabled ? t("settings.on") : t("settings.off")}
        />
      </SettingRow>
      <SettingRow
        layout="vertical"
        title={t("settings.appearance.customCss")}
        desc={t("settings.appearance.customCssDesc")}
        htmlFor="setting-custom-css"
      >
        <textarea
          id="setting-custom-css"
          value={draft}
          maxLength={CUSTOM_CSS_MAX}
          spellCheck={false}
          rows={8}
          placeholder={".chat-md h2 {\n  color: rgb(var(--accent));\n}"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              setCustomCss(draft);
            }
          }}
          className={cn(
            "w-full resize-y rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs text-content",
            "outline-none placeholder:text-content-subtle focus:border-accent",
          )}
        />
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-[0.7857em] text-content-subtle">{t("settings.appearance.customCssDirty")}</span>}
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(customCss)}>
            {t("settings.appearance.customCssRevert")}
          </Button>
          <Button variant="primary" size="sm" disabled={!dirty} onClick={() => setCustomCss(draft)}>
            {t("settings.appearance.customCssApply")}
          </Button>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
