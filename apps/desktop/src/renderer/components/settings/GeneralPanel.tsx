import {
  useSessionStore,
  PASTE_TAG_THRESHOLD_CHARS_MIN,
  PASTE_TAG_THRESHOLD_CHARS_MAX,
} from "@renderer/stores/sessionStore.js";
import { Select, Input, Switch, Button } from "@renderer/components/ui/index.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { IconSquare, IconStack2, IconList, IconListDetails, IconGripHorizontal, IconX } from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { ChatDensity, DisplayMode, AutoArchiveConfig, Locale } from "@contracts/ipc";
import type { ReactNode } from "react";
import { useState } from "react";
import { useUiPrefsStore, type ComposerSendKey } from "@renderer/lib/uiPrefs.js";
import { SettingRow } from "./SettingRow.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { TitleGenPanel } from "./TitleGenPanel.js";
import { OutputStylePanel } from "./OutputStylePanel.js";
import { SettingsTransferSection } from "./SettingsTransferSection.js";
import { TurnBudgetPanel, FallbackModelsPanel } from "./RuntimePolicyPanel.js";

/**
 * "常规" (General) settings panel.
 *
 * Hosts general-purpose preferences that aren't tied to a specific feature
 * area. Currently:
 *  - 基础 (SettingsSection): 界面语言 + 中间面板显示模式 + 对话紧凑度 + 长文本折叠阈值
 *    (语言与显示合并为一组——单行小节不值得独占一张卡)
 *  - 会话自动归档 (SettingsSection): 开关 + 默认不活跃天数 + 按项目覆盖
 *  - 回合预算 / 失败自动回退 (RuntimePolicyPanel, self-contained sections)
 *  - 会话标题生成 (TitleGenPanel, renders its own SettingsSection)
 *  - 输出风格 (OutputStylePanel, renders its own SettingsSection)
 *
 * Card-grouped layout: a sticky PanelHeader toolbar on top, then one
 * SettingsSection per functional category. TitleGenPanel / OutputStylePanel
 * are dropped in as sibling sections — the outer space-y-4 keeps the cards
 * apart.
 */

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "single", labelKey: "settings.general.displayModeSingle", icon: <IconSquare size={14} className="text-content-muted" /> },
  { value: "tabs", labelKey: "settings.general.displayModeTabs", icon: <IconStack2 size={14} className="text-content-muted" /> },
];

const DENSITY_OPTIONS: { value: ChatDensity; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "compact", labelKey: "settings.general.densityCompact", icon: <IconList size={14} className="text-content-muted" /> },
  { value: "comfortable", labelKey: "settings.general.densityComfortable", icon: <IconListDetails size={14} className="text-content-muted" /> },
  { value: "cozy", labelKey: "settings.general.densityCozy", icon: <IconGripHorizontal size={14} className="text-content-muted" /> },
];

/** Inactivity day thresholds. Labels are built via t("common.dayCount") at
 *  render time — the numeric value IS the label, only the unit word localizes. */
const AUTO_ARCHIVE_DAY_VALUES = [7, 14, 30, 60, 90];

/** Sentinel value for the per-project override select, distinct from the
 *  numeric day options. */
const NEVER_OVERRIDE = "0";
const CUSTOM_DAYS = "__custom__";
const ARCHIVE_DAYS_MAX = 3650;

/**
 * 归档天数选择:预设(7/14/30/60/90)+「自定义…」(就地换成数字框)+ 可选「从不」。
 *
 * 以前是写死的五个预设:存进去的值只要不在预设里(手改配置、旧版本、或者「添加项目
 * 覆盖」时抄过来的默认值),默认天数那一栏一律显示成「30 天」,项目覆盖那一栏一律显示
 * 成「从不」——显示的和实际生效的对不上。现在当前值不在预设里时会作为一项补进列表。
 */
function ArchiveDaysSelect({
  id,
  value,
  allowNever,
  onChange,
  className,
}: {
  id: string;
  value: number;
  allowNever?: boolean;
  onChange: (days: number) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [custom, setCustom] = useState<string | null>(null);
  const label = (d: number) =>
    d === 0 ? t("settings.general.archiveNever") : t("common.dayCount", { n: d });
  const options =
    value === 0 || AUTO_ARCHIVE_DAY_VALUES.includes(value)
      ? AUTO_ARCHIVE_DAY_VALUES
      : [...AUTO_ARCHIVE_DAY_VALUES, value].sort((a, b) => a - b);

  if (custom !== null) {
    const commit = () => {
      const n = Math.round(Number(custom));
      if (custom.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= ARCHIVE_DAYS_MAX) onChange(n);
      setCustom(null);
    };
    return (
      <Input
        id={id}
        type="number"
        min={1}
        max={ARCHIVE_DAYS_MAX}
        step={1}
        autoFocus
        value={custom}
        placeholder={t("settings.general.archiveCustomPlaceholder")}
        onChange={(e) => setCustom(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            // 只退出编辑,别让设置页的 Esc 把整页关掉。
            e.stopPropagation();
            setCustom(null);
          }
        }}
        className={className}
      />
    );
  }

  return (
    <Select.Root
      value={String(value)}
      onValueChange={(v) => {
        if (v === CUSTOM_DAYS) setCustom(String(value > 0 ? value : 30));
        else if (v !== null && v !== undefined) onChange(Number(v));
      }}
    >
      <Select.Trigger id={id} className={className}>
        <Select.Value>{(val: string) => label(Number(val))}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            <Select.List>
              {(allowNever || value === 0) && (
                <Select.Item value={NEVER_OVERRIDE}>
                  <Select.ItemText>{t("settings.general.archiveNever")}</Select.ItemText>
                </Select.Item>
              )}
              {options.map((d) => (
                <Select.Item key={d} value={String(d)}>
                  <Select.ItemText>{label(d)}</Select.ItemText>
                </Select.Item>
              ))}
              <Select.Item value={CUSTOM_DAYS}>
                <Select.ItemText>{t("settings.general.archiveCustom")}</Select.ItemText>
              </Select.Item>
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function GeneralPanel() {
  const { t } = useI18n();

  // ── UI language ──
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);

  // ── Display mode ──
  const displayMode = useSessionStore((s) => s.displayMode);
  const setDisplayMode = useSessionStore((s) => s.setDisplayMode);

  // ── Message-stream density ──
  const chatDensity = useSessionStore((s) => s.chatDensity);
  const setChatDensity = useSessionStore((s) => s.setChatDensity);

  // ── Paste-to-card threshold ──
  const pasteTagThresholdChars = useSessionStore((s) => s.pasteTagThresholdChars);
  const setPasteTagThresholdChars = useSessionStore((s) => s.setPasteTagThresholdChars);
  // In-progress text of the threshold field. The store setter clamps
  // defensively — right for PERSISTED values, wrong for keystrokes: committing
  // every keystroke turns the "3" on the way to "300" (or a cleared field)
  // into the clamped min under the user's cursor, so the field can never be
  // edited normally. Keep the raw draft locally, apply valid in-range numbers
  // live, and clamp-commit only on blur. null = not editing (show the store).
  const [pasteDraft, setPasteDraft] = useState<string | null>(null);
  const sendKey = useUiPrefsStore((s) => s.sendKey);
  const setSendKey = useUiPrefsStore((s) => s.setSendKey);

  const onPasteThresholdChange = (raw: string) => {
    setPasteDraft(raw);
    const n = Number(raw);
    if (
      raw.trim() !== "" &&
      Number.isFinite(n) &&
      n >= PASTE_TAG_THRESHOLD_CHARS_MIN &&
      n <= PASTE_TAG_THRESHOLD_CHARS_MAX
    ) {
      void setPasteTagThresholdChars(n);
    }
  };

  const onPasteThresholdBlur = () => {
    if (pasteDraft === null) return;
    const n = Number(pasteDraft);
    // Empty / unparsable drafts are abandoned edits: revert to the stored
    // value instead of clamping "" to the minimum behind the user's back.
    if (pasteDraft.trim() !== "" && Number.isFinite(n)) {
      void setPasteTagThresholdChars(n);
    }
    setPasteDraft(null);
  };

  // ── Session auto-archive rules ──
  const autoArchiveConfig = useSessionStore((s) => s.autoArchiveConfig);
  const setAutoArchiveConfig = useSessionStore((s) => s.setAutoArchiveConfig);
  const projects = useSessionStore((s) => s.projects);

  const patchAutoArchive = (patch: Partial<AutoArchiveConfig>) =>
    void setAutoArchiveConfig({ ...autoArchiveConfig, ...patch });

  const setProjectOverride = (projectId: string, value: string) => {
    const days = Number(value);
    if (!Number.isFinite(days) || days < 0) return;
    patchAutoArchive({ overrides: { ...autoArchiveConfig.overrides, [projectId]: days } });
  };

  const addProjectOverride = (projectId: string) => {
    // Start the new override at the current default; the user then adjusts it.
    patchAutoArchive({
      overrides: { ...autoArchiveConfig.overrides, [projectId]: autoArchiveConfig.defaultDays },
    });
  };

  const removeProjectOverride = (projectId: string) => {
    const overrides = { ...autoArchiveConfig.overrides };
    delete overrides[projectId];
    patchAutoArchive({ overrides });
  };

  const activeProjects = projects.filter((p) => !p.archived);
  // Only projects WITH a custom override are listed; the rest stay hidden
  // behind the "add" picker so the panel stays compact.
  const overriddenProjects = activeProjects.filter(
    (p) => autoArchiveConfig.overrides[p.id] !== undefined,
  );
  const addableProjects = activeProjects.filter(
    (p) => autoArchiveConfig.overrides[p.id] === undefined,
  );

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader
        title={t("settings.general.title")}
      />

      {/* ── 基础(语言 + 显示与布局合并为一组) ── */}
      <SettingsSection title={t("settings.general.sectionBasics")}>
        <SettingRow
          title={t("settings.general.language")}
          desc={t("settings.general.languageDesc")}
          htmlFor="setting-locale"
        >
          <Select.Root
            value={locale}
            onValueChange={(v) => void setLocale(v as Locale)}
          >
            <Select.Trigger id="setting-locale" className="w-full">
              <Select.Value>
                {(val: Locale) =>
                  val === "en"
                    ? t("settings.general.languageEn")
                    : t("settings.general.languageZh")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="zh">
                      <Select.ItemText>{t("settings.general.languageZh")}</Select.ItemText>
                    </Select.Item>
                    <Select.Item value="en">
                      <Select.ItemText>{t("settings.general.languageEn")}</Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {/* ── Center-pane display mode ── */}
        <SettingRow
          title={t("settings.general.displayMode")}
          desc={t("settings.general.displayModeDesc")}
          htmlFor="setting-displaymode"
        >
          <Select.Root
            value={displayMode}
            onValueChange={(v) => void setDisplayMode(v as DisplayMode)}
          >
            <Select.Trigger id="setting-displaymode" className="w-full">
              <Select.Value>
                {(val: DisplayMode) => {
                  const o =
                    DISPLAY_MODE_OPTIONS.find((x) => x.value === val) ??
                    DISPLAY_MODE_OPTIONS[0];
                  return (
                    <span className="flex items-center gap-1.5">
                      {o.icon}
                      {t(o.labelKey)}
                    </span>
                  );
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {DISPLAY_MODE_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        {o.icon}
                        <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {/* ── Message-stream density (vertical rhythm) ── */}
        <SettingRow
          title={t("settings.general.density")}
          desc={t("settings.general.densityDesc")}
          htmlFor="setting-chatdensity"
        >
          <Select.Root
            value={chatDensity}
            onValueChange={(v) => void setChatDensity(v as ChatDensity)}
          >
            <Select.Trigger id="setting-chatdensity" className="w-full">
              <Select.Value>
                {(val: ChatDensity) => {
                  const o =
                    DENSITY_OPTIONS.find((x) => x.value === val) ??
                    DENSITY_OPTIONS[1];
                  return (
                    <span className="flex items-center gap-1.5">
                      {o.icon}
                      {t(o.labelKey)}
                    </span>
                  );
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {DENSITY_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        {o.icon}
                        <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {/* ── Long-text paste folding threshold ── */}
        <SettingRow
          title={t("settings.general.pasteThreshold")}
          desc={t("settings.general.pasteThresholdDesc", {
            min: PASTE_TAG_THRESHOLD_CHARS_MIN,
            max: PASTE_TAG_THRESHOLD_CHARS_MAX,
          })}
          htmlFor="setting-paste-threshold"
        >
          <Input
            id="setting-paste-threshold"
            type="number"
            min={PASTE_TAG_THRESHOLD_CHARS_MIN}
            max={PASTE_TAG_THRESHOLD_CHARS_MAX}
            step={50}
            value={pasteDraft ?? pasteTagThresholdChars}
            onChange={(e) => onPasteThresholdChange(e.target.value)}
            onBlur={onPasteThresholdBlur}
            className="w-full"
          />
        </SettingRow>

        {/* ── 发送键(lib/uiPrefs.ts) ── */}
        <SettingRow
          title={t("settings.general.sendKey")}
          desc={t("settings.general.sendKeyDesc")}
          htmlFor="setting-send-key"
        >
          <Select.Root value={sendKey} onValueChange={(v) => setSendKey(v === "modEnter" ? "modEnter" : "enter")}>
            <Select.Trigger id="setting-send-key" className="w-full">
              <Select.Value>
                {(val: ComposerSendKey) =>
                  val === "modEnter" ? t("settings.general.sendKeyMod") : t("settings.general.sendKeyEnter")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="enter">
                      <Select.ItemText>{t("settings.general.sendKeyEnter")}</Select.ItemText>
                    </Select.Item>
                    <Select.Item value="modEnter">
                      <Select.ItemText>{t("settings.general.sendKeyMod")}</Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>

      {/* ── 会话自动归档 ── */}
      <SettingsSection title={t("settings.general.sectionArchive")}>
        <SettingRow
          title={t("settings.general.archiveEnabled")}
          desc={t("settings.general.archiveEnabledDesc")}
        >
          <Switch
            id="setting-autoarchive-enabled"
            checked={autoArchiveConfig.enabled}
            onCheckedChange={(v) => patchAutoArchive({ enabled: v })}
            label={autoArchiveConfig.enabled ? t("settings.general.archiveOn") : t("settings.general.archiveOff")}
          />
        </SettingRow>

        <SettingRow
          title={t("settings.general.archiveDefaultDays")}
          desc={t("settings.general.archiveDefaultDaysDesc")}
          htmlFor="setting-autoarchive-default-days"
        >
          <ArchiveDaysSelect
            id="setting-autoarchive-default-days"
            value={autoArchiveConfig.defaultDays}
            onChange={(days) => patchAutoArchive({ defaultDays: days })}
            className="w-full"
          />
        </SettingRow>

        {overriddenProjects.map((p) => (
          <SettingRow
            key={p.id}
            title={p.name}
            desc={t("settings.general.archiveOverrideDesc")}
            htmlFor={`setting-autoarchive-project-${p.id}`}
          >
            <div className="flex items-center gap-2">
              <ArchiveDaysSelect
                id={`setting-autoarchive-project-${p.id}`}
                value={autoArchiveConfig.overrides[p.id] ?? autoArchiveConfig.defaultDays}
                allowNever
                onChange={(days) => setProjectOverride(p.id, String(days))}
                className="min-w-0 flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeProjectOverride(p.id)}
                aria-label={t("settings.general.archiveRemoveOverrideAria", { name: p.name })}
                title={t("settings.general.archiveRemoveOverrideTitle")}
              >
                <IconX size={14} />
              </Button>
            </div>
          </SettingRow>
        ))}

        {addableProjects.length > 0 && (
          <SettingRow
            title={t("settings.general.archiveAddOverride")}
            desc={t("settings.general.archiveAddOverrideDesc")}
          >
            <Select.Root value={null} onValueChange={(v) => addProjectOverride(v as string)}>
              <Select.Trigger className="w-full">
                <Select.Value placeholder={t("settings.general.archivePickProject")} />
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {addableProjects.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          <Select.ItemText>{p.name}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </SettingRow>
        )}
      </SettingsSection>

      {/* ── 回合预算（自包含 section，读写 runtime.turnBudget） ── */}
      <TurnBudgetPanel />

      {/* ── 失败自动回退（自包含 section，读写 runtime.fallbackModels） ── */}
      <FallbackModelsPanel />

      {/* ── 会话标题生成 (self-contained section) ── */}
      <TitleGenPanel />

      {/* ── 输出风格 (self-contained section) ── */}
      <OutputStylePanel />

      <SettingsTransferSection />
    </section>
  );
}
