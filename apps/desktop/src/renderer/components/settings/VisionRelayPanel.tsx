import { useMemo } from "react";
import {
  TITLE_GEN_BUILTIN_ALIASES,
  TITLE_GEN_BUILTIN_MODEL_PREFIX,
} from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Select } from "@renderer/components/ui/index.js";
import { IconRobot } from "@renderer/lib/icons.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

/**
 * 视觉中继（vision relay）设置。
 *
 * 会话背后的引擎 / 模型**没有视觉输入**时（DeepSeek 系网关是典型），图片交给
 * 这个**用户挑定的、有视觉能力的模型**转述成文字，再回到对话里。主进程那一半在
 * `main/lib/visionRelay.ts`（同一套挑模型 / 发请求的骨架，照搬标题生成）。
 *
 * 控件只有一个下拉：选一个**真正支持图片输入**的模型。它的选项与「会话标题生成」
 * 面板**逐项同形**（`@claude` 本机登录 + 内置别名 + 所有自定义模型），因为两者存的
 * 是同一形状的取值 —— 都是 `"@claude"` / `"@claude:<别名>"` / `"configId:modelId"`。
 *
 * ⚠️ **默认是空的，不替用户选。** 「哪个模型有视觉」只有用户自己知道；替它选一个
 * 会把图交给一只读不懂的眼睛，正是这个功能要修的那种静默失败。值存为空 = 能力不
 * 生效（工具会如实说「未配置」，不是静默失败）。
 *
 * Renders as its own SettingsSection (card) so it slots into GeneralPanel as a sibling.
 */
export function VisionRelayPanel() {
  const { t } = useI18n();
  const visionRelayModel = useSessionStore((s) => s.visionRelayModel);
  const setVisionRelayModel = useSessionStore((s) => s.setVisionRelayModel);
  const customModels = useSessionStore((s) => s.customModels);

  // 选项构造**与 TitleGenPanel 逐字一致**：内置 Claude 排最前，然后所有自定义模型的
  // 每个 (config, model) 展平，值 `"configId:modelId"`，标签 `"供应商名 -> 模型id"`。
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: TITLE_GEN_BUILTIN_MODEL_PREFIX, label: t("settings.visionRelay.builtinDefault") },
      ...TITLE_GEN_BUILTIN_ALIASES.map((a) => ({
        value: `${TITLE_GEN_BUILTIN_MODEL_PREFIX}:${a}`,
        label: `Claude Code -> ${a}`,
      })),
    ];
    for (const cfg of customModels) {
      for (const entry of cfg.models) {
        if (entry.id.trim()) {
          opts.push({
            value: `${cfg.id}:${entry.id}`,
            label: `${cfg.name} -> ${entry.id}`,
          });
        }
      }
    }
    return opts;
  }, [customModels, t]);

  // 「未配置」不是一个真实取值，而是一条**清空**的出口（选它 = 把这个能力关掉）。
  // base-ui 的 Select 拿它当作一个普通 item 值；写入时再翻译回空串。
  const NONE = "__vision_relay_none__";

  return (
    <SettingsSection
      title={t("settings.visionRelay.sectionTitle")}
      desc={t("settings.visionRelay.sectionDesc")}
    >
      <SettingRow
        title={t("settings.visionRelay.modelTitle")}
        desc={t("settings.visionRelay.modelDesc")}
      >
        {modelOptions.length > 0 ? (
          <Select.Root
            value={visionRelayModel || NONE}
            onValueChange={(v) => setVisionRelayModel(v === NONE ? null : (v as string))}
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string | null) => (
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      (!val || val === NONE) && "text-content-subtle",
                    )}
                  >
                    <IconRobot size={14} className="text-content-muted" />
                    <span className="truncate">
                      {val && val !== NONE
                        ? (modelOptions.find((o) => o.value === val)?.label ?? val)
                        : t("settings.visionRelay.noneOption")}
                    </span>
                  </span>
                )}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {/* 空选项排最前 —— 默认（未配置）就是它。 */}
                    <Select.Item value={NONE}>
                      <IconRobot size={14} className="text-content-muted" />
                      <Select.ItemText>{t("settings.visionRelay.noneOption")}</Select.ItemText>
                    </Select.Item>
                    {modelOptions.map((opt) => (
                      <Select.Item key={opt.value} value={opt.value}>
                        <IconRobot size={14} className="text-content-muted" />
                        <Select.ItemText>{opt.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        ) : (
          <p className="text-[0.7857em] text-content-subtle">
            {t("settings.visionRelay.noModelsHint")}
          </p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}
