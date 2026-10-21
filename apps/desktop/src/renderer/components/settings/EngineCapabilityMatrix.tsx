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
import { ENGINE_CAPABILITY_ENGINES, ENGINE_CAPABILITY_MATRIX, supportsCapability, BASE_TOOL_CAPABILITY_VIEW, baseCapabilityCell, baseCapabilityCellState } from "./engineCapabilityData.js";
import type { EngineToolEngineId } from "@contracts/ipc/engineTools";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { cn } from "@renderer/lib/cn.js";
import { SettingsSection } from "./SettingsSection.js";
import { Badge } from "@renderer/components/ui/badge.js";
import { IconCheck, IconMinus } from "@renderer/lib/icons.js";

/** 引擎展示名（品牌名，不翻译）。 */
const ENGINE_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

/** 【ARC-003】基础能力格的形态标记 —— 名字原样展示（模型看到的就是它），
 *  形态只用词条前缀/颜色区分：原生与宿主桥都是能用，`无` 是灰的。 */
function BaseCapabilityCell({ impl, toolName, note, disabledByPolicy, t }: {
  impl: "native" | "bridge" | "none";
  toolName: string | null;
  note?: string;
  /** 【ARC-003 第 4 条】该格的工具在本机策略里被用户按名禁用了。 */
  disabledByPolicy?: boolean;
  t: (key: MessageId) => string;
}) {
  const implLabel = t(`settings.engineMatrix.base.impl.${impl}` as MessageId);
  return (
    <div className="text-center" data-disabled-by-policy={disabledByPolicy ? "true" : undefined}>
      <div className="text-[0.857em] text-content-subtle">{implLabel}</div>
      {toolName ? (
        <code className={cn("mt-0.5 inline-block break-all font-mono text-[0.857em]", disabledByPolicy ? "text-content-subtle line-through" : "text-content")}>{toolName}</code>
      ) : (
        <div className="mt-0.5 text-[0.857em] text-content-subtle/60">—</div>
      )}
      {disabledByPolicy && (
        <Badge variant="danger" className="mt-0.5">{t("settings.engineMatrix.base.disabledByPolicy" as MessageId)}</Badge>
      )}
      {note && <div className="mt-0.5 text-[0.786em] text-content-subtle">{note}</div>}
    </div>
  );
}

export function EngineCapabilityMatrix({ excludedByEngine }: { excludedByEngine?: Partial<Record<EngineToolEngineId, readonly string[]>> } = {}) {
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

        {/* 【ARC-003】基础能力语义表 —— 上面的矩阵讲"引擎层面支持什么"，
            这张讲"读写/搜索/命令/联网到底用哪个工具"。数据是契约包里的唯一一份
            （@contracts/baseToolCapabilities），工具名由套件与真实工具表对账。 */}
        <div className="mt-6 border-t border-edge pt-4">
          <div className="text-content">{t("settings.engineMatrix.base.title")}</div>
          <div className="mt-0.5 text-[0.857em] text-content-subtle">{t("settings.engineMatrix.base.desc")}</div>
          <table className="mt-3 w-full text-[0.8571em]">
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
              {BASE_TOOL_CAPABILITY_VIEW.map((row) => (
                <tr key={row.source.id} className="border-t border-edge align-top">
                  <td className="py-2 pr-3 text-content">{t(row.labelKey)}</td>
                  {ENGINE_CAPABILITY_ENGINES.map((engine) => {
                    // 【ARC-003 第 4 条】静态声明 + 本机策略(用户按名禁用的内置工具)。
                    // 未传入策略(加载中/读取失败)时按"未禁用"显示 —— 静态声明本身仍是真的。
                    const cell = baseCapabilityCellState(baseCapabilityCell(row.source, engine), excludedByEngine?.[engine] ?? []);
                    return (
                      <td key={engine} className="py-2 text-center">
                        <BaseCapabilityCell impl={cell.impl} toolName={cell.toolName} note={cell.note} disabledByPolicy={cell.disabledByPolicy} t={t} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SettingsSection>
  );
}
