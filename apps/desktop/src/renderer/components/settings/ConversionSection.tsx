/**
 * 设置 → 转换情况。库里哪些文献还没有 Markdown,以及补转的入口。
 *
 * ## 为什么这一节单独一个文件
 *
 * 它显示文档库里 MinerU Markdown 的关联与完整度；转录由在线 API 执行，
 * 用户通过已配置的自动化发起，核心不上传或转录。它现在挂在「数据位置」页(见
 * `DataRootPanel`),与"数据放在哪 / 怎么分"是同一件事的两面。
 *
 * ## 这里不再有"额度"这回事
 *
 * 在线转录由 MinerU 完成；本页仅作状态检查，不提供全库转换或重转操作。
 * 用户可在条目详情/右键菜单采纳已有 Markdown，但那不是本地转录回退。
 *
 * ## 为什么列表只列不完整的
 *
 * 完整的文献没必要占地方。每行要说清**为什么**不完整(没转过 / 有图没落盘),
 * 只说"不完整"等于让用户自己猜。
 */
import { useCallback, useEffect, useState } from "react";
import type { LibraryConversionRow } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { IconFileText } from "@renderer/lib/icons.js";
import { SettingsSection } from "./SettingsSection.js";

interface Stats {
  rows: LibraryConversionRow[];
  total: number;
  complete: number;
  pending: number;
}

export function ConversionSection() {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.library.conversionReport());
    } catch {
      // 库还没建好 / 主进程刚起来 —— 这一节留空,不把设置页整页拖垮
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!stats) return null;
  const incomplete = stats.rows.filter((r) => !r.complete);

  return (
    <SettingsSection
      title={t("settings.convert.title")}
      desc={t("settings.convert.desc")}
      icon={IconFileText}
    >
      {stats.total === 0 ? (
        <div className="px-4 py-3 text-[0.7857em] text-content-subtle">
          {t("settings.convert.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-content-muted">{t("settings.convert.total", { n: stats.total })}</span>
            <span className="text-accent">{t("settings.convert.converted", { n: stats.complete })}</span>
            {/* 未转的用红色标出来 —— 尚未进入 Markdown 全文检索，PDF 仍可按需读文本 */}
            <span className={stats.pending > 0 ? "text-red-500" : "text-content-subtle"}>
              {t("settings.convert.pending", { n: stats.pending })}
            </span>
          </div>

          <p className="text-[0.7857em] leading-relaxed text-content-subtle">
            {t("settings.convert.localNote")}
          </p>

          {/* 待办清单 —— 只列不完整的,每行说清为什么不完整。 */}
          {incomplete.length > 0 && (
            <ul className="max-h-72 overflow-y-auto rounded border border-edge">
              {incomplete.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 border-b border-edge/60 px-2 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-content">{r.title}</div>
                    <div className="text-[0.7143em] text-content-subtle">
                      {r.hasMd
                        ? t("settings.convert.reasonNoAssets", { n: r.imageRefs })
                        : t("settings.convert.reasonNoMd")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
