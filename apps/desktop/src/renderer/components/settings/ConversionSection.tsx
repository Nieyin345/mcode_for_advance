/**
 * 设置 → 转换情况。库里哪些文献还没有 Markdown,以及补转的入口。
 *
 * ## 为什么这一节单独一个文件
 *
 * 它原先长在「外部集成」那一页上(与 MinerU 的密钥框、测试按钮挤在一起)。那一页
 * 随写死的 MinerU 一起删了,而**这块要留住** —— 用户得看得见"还差几篇没转",那是
 * 配合外部转录工具用的(转完一批回来核对)。它现在挂在「数据位置」页(见
 * `DataRootPanel`),与"数据放在哪 / 怎么分"是同一件事的两面。
 *
 * ## 这里不再有"额度"这回事
 *
 * 文案里原来写着"会消耗 MinerU 的额度"。现在软件不内置任何转录服务:按钮跑的是
 * **本地 pdf.js 抽取**(零上传、零外部依赖,但只有纯文本),高质量的转录由用户
 * 让 AI 调自己装的工具去做,再用条目详情页的「用本地 Markdown…」挂回来 ——
 * 那条路是 `library_adopt_markdown`,与本页的按钮**共用同一个** `convertItemToMarkdown`。
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
import { Button } from "@renderer/components/ui/index.js";
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
  const [busy, setBusy] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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

  /**
   * 批量转换。`force = false` 时主进程会跳过已经有 md 的 —— 所以「转换未转的」
   * 重复点也不会白跑一遍。
   */
  const runConvert = async (force: boolean) => {
    if (!stats) return;
    if (force && !window.confirm(t("settings.convert.rerunConfirm", { n: stats.total }))) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.library.convert(force ? { force: true } : {});
      const parts: string[] = [];
      if (res.converted > 0) parts.push(t("settings.convert.done", { n: res.converted }));
      if (res.failed.length > 0) parts.push(t("settings.convert.failed", { n: res.failed.length }));
      setMsg(parts.length > 0 ? parts.join(" · ") : t("settings.convert.nonePending"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 单独重转一篇。
   *
   * 这里**带 force**:用户是看到这篇"不完整"才点的它,不重转就没有意义(默认会跳过
   * 已有 md 的)。
   */
  const convertOne = async (id: string) => {
    setConvertingId(id);
    try {
      await api.library.convert({ ids: [id], force: true });
      await load();
    } finally {
      setConvertingId(null);
    }
  };

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
            {/* 未转的用红色标出来 —— 这类文献 AI 读不到正文、全文检索也搜不到 */}
            <span className={stats.pending > 0 ? "text-red-500" : "text-content-subtle"}>
              {t("settings.convert.pending", { n: stats.pending })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={busy || stats.pending === 0}
              onClick={() => void runConvert(false)}
            >
              {busy
                ? t("settings.convert.running")
                : t("settings.convert.runPending", { n: stats.pending })}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void runConvert(true)}>
              {t("settings.convert.rerunAll")}
            </Button>
          </div>
          {msg && <div className="text-[0.7857em] text-content-subtle">{msg}</div>}

          {/* 本地抽取到什么程度、更好的结果从哪来 —— 说在这里,因为用户点了按钮之后
              最可能问的就是"转出来的东西怎么这么糙"。 */}
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
                  <Button
                    variant="outline"
                    size="sm"
                    title={t("settings.convert.rerunOneTitle")}
                    disabled={convertingId === r.id || !r.hasPdf}
                    onClick={() => void convertOne(r.id)}
                  >
                    {convertingId === r.id
                      ? t("settings.convert.running")
                      : t("settings.convert.rerunOne")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
