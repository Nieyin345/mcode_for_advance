/**
 * 「能力 × 引擎」矩阵 —— 一张只读的说明表（报告 MSP3）。
 *
 * 三个引擎的能力面对不等，而这些事实原本散在技能页 / MCP 页 / 插件页 / 引擎工具页
 * 各处文案里，用户得自己拼。这一张表把它们汇到一处：行是能力面（技能 / 斜杠命令 /
 * 子代理 / MCP / 引擎原生 hooks / 按名禁用内置工具），列是三个引擎。
 *
 * ## 只读，不是控件
 *
 * 它**不改变任何投递逻辑** —— 开关仍在各自的面板（技能矩阵在技能页、引擎可见性在
 * MCP 页、内置工具在下面的引擎卡片里）。这里只回答「谁支持什么」。
 *
 * 数据出自纯模块 `engineCapabilityData.ts`，`engine-capability-matrix-smoke` 会把它
 * 与各真实来源对账防漂移。品牌名（Claude / Codex / Pi）不本地化。
 */
import { ENGINE_CAPABILITY_ENGINES, ENGINE_CAPABILITY_MATRIX, supportsCapability } from "./engineCapabilityData.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SettingsSection } from "./SettingsSection.js";
import { IconCheck, IconMinus } from "@renderer/lib/icons.js";

/** 引擎展示名（品牌名，不翻译）。 */
const ENGINE_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

export function EngineCapabilityMatrix() {
  const { t } = useI18n();
  return (
    <SettingsSection title={t("settings.engineMatrix.title")} desc={t("settings.engineMatrix.desc")}>
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full text-[0.8571em]">
          <thead>
            <tr className="text-content-subtle">
              <th className="w-1/4 pb-2 text-left font-medium" />
              {ENGINE_CAPABILITY_ENGINES.map((engine) => (
                <th key={engine} className="w-1/4 pb-2 text-center font-medium">
                  {ENGINE_LABEL[engine] ?? engine}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ENGINE_CAPABILITY_MATRIX.map((row) => (
              <tr key={row.labelKey} className="border-t border-edge">
                <td className="py-2 pr-3">
                  <div className="text-content">{t(row.labelKey)}</div>
                  {row.noteKey && (
                    <div className="mt-0.5 text-[0.857em] text-content-subtle">{t(row.noteKey)}</div>
                  )}
                </td>
                {ENGINE_CAPABILITY_ENGINES.map((engine) => {
                  const on = supportsCapability(row, engine);
                  return (
                    <td key={engine} className="py-2 text-center">
                      {on ? (
                        <IconCheck
                          size={15}
                          className="mx-auto text-accent"
                          aria-label={t("settings.engineMatrix.supported")}
                        />
                      ) : (
                        <IconMinus
                          size={15}
                          className="mx-auto text-content-subtle/60"
                          aria-label={t("settings.engineMatrix.unsupported")}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}
