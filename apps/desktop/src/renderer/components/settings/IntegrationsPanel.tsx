/**
 * 设置 → 外部集成。
 *
 * ## 这一页是「目录驱动」的
 *
 * 面板不认得当体是哪一家:它从 `INTEGRATION_CATALOG` 渲染,加一个新集成只要往目录
 * 加一条 + 在主进程的 `testFor` 里加一个 case。用户要求「未来可能会有更多的功能
 * 集成进来」—— 所以这里刻意不写死 MinerU。
 *
 * ## 密钥怎么进出
 *
 * 输入框里的明文只在点保存那一下经 `integrations.setKey` 出去,主进程立刻用
 * safeStorage 加密;之后界面拿到的永远是 `keyMasked`(打码串)。所以这一页
 * **没有**「显示密钥」这种功能 —— 想看就重新填一个。
 */
import { useCallback, useEffect, useState } from "react";
import type { IntegrationId, IntegrationPublic } from "@contracts/integrations";
import type { LibraryConversionRow } from "@contracts/library";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconCheck, IconExternalLink, IconX } from "@renderer/lib/icons.js";
import { Input } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";

/** 每个集成在设置页里显示的名字与用途说明。加集成时这里补两条。 */
const NAME_KEY: Record<IntegrationId, MessageId> = {
  mineru: "settings.integrations.mineru.name",
};
const DESC_KEY: Record<IntegrationId, MessageId> = {
  mineru: "settings.integrations.mineru.desc",
};
/** 去哪个站点注册拿密钥。目录里也有 keyUrl,但文案要能跳转,所以这里再放一份。 */
const KEY_URL: Record<IntegrationId, string> = {
  mineru: "https://mineru.net/apiManage/docs",
};

export function IntegrationsPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<IntegrationPublic[]>([]);
  /** 每个集成各自的输入框内容(未保存的明文)。 */
  const [draft, setDraft] = useState<Partial<Record<IntegrationId, string>>>({});
  const [busy, setBusy] = useState<IntegrationId | null>(null);
  const [testing, setTesting] = useState<IntegrationId | null>(null);
  /** 临时提示(保存成功之类),不持久。 */
  const [flash, setFlash] = useState<Partial<Record<IntegrationId, string>>>({});

  /** 转录检测:逐篇的完整度(完整 = md 有 + 它引用的图都在)。 */
  const [stats, setStats] = useState<{
    rows: LibraryConversionRow[];
    total: number;
    complete: number;
    pending: number;
  } | null>(null);
  const [busyConvert, setBusyConvert] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);
  /** 正在单独重转的那一篇。 */
  const [convertingId, setConvertingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.integrations.list();
    setItems(res.integrations);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.library.conversionReport());
    } catch {
      // 主进程还没就绪 —— 保持 null,面板上那块不渲染
      setStats(null);
    }
  }, []);

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
      await loadStats();
    } finally {
      setConvertingId(null);
    }
  };

  useEffect(() => {
    void load();
    void loadStats();
  }, [load, loadStats]);

  /**
   * 批量转换。`force=false` 时主进程会跳过已经有 md 的 —— 所以「转换未转的」这个
   * 按钮重复点也不会浪费 MinerU 的额度。
   */
  const runConvert = async (force: boolean) => {
    if (!stats) return;
    if (
      force &&
      !window.confirm(t("settings.integrations.convertAllConfirm", { n: stats.total }))
    ) {
      return;
    }
    setBusyConvert(true);
    setConvertMsg(null);
    try {
      const res = await api.library.convert(force ? { force: true } : {});
      const parts: string[] = [];
      if (res.converted > 0) {
        parts.push(t("settings.integrations.convertDone", { n: res.converted }));
      }
      if (res.failed.length > 0) {
        parts.push(t("settings.integrations.convertFailed", { n: res.failed.length }));
      }
      setConvertMsg(parts.length > 0 ? parts.join(" · ") : t("settings.integrations.convertNonePending"));
      await loadStats();
    } finally {
      setBusyConvert(false);
    }
  };

  const saveKey = async (id: IntegrationId) => {
    const key = (draft[id] ?? "").trim();
    if (!key) return;
    setBusy(id);
    try {
      const res = await api.integrations.setKey({ id, key });
      setItems(res.integrations);
      setDraft((d) => ({ ...d, [id]: "" }));
      setFlash((f) => ({ ...f, [id]: t("settings.integrations.saved") }));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async (id: IntegrationId) => {
    setBusy(id);
    try {
      const res = await api.integrations.clearKey({ id });
      setItems(res.integrations);
      setFlash((f) => ({ ...f, [id]: "" }));
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: IntegrationId) => {
    setTesting(id);
    try {
      const res = await api.integrations.test({ id });
      setItems(res.integrations);
    } finally {
      setTesting(null);
    }
  };

  /** 不完整的那些 —— 列表只列它们,完整的没必要占地方。 */
  const incomplete = stats?.rows.filter((r) => !r.complete) ?? [];

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.integrations.title")} />
      <SettingsSection
        title={t("settings.integrations.servicesTitle")}
        desc={t("settings.integrations.desc")}
      >
        {/* Card 自身没有内边距(普通设置行由 SettingRow 自带),这里是自定义布局,
            所以自己补一层 —— 否则内容会贴着卡片的边线。 */}
        <div className="flex flex-col gap-4 px-4 py-3">
          {items.map((item) => {
            const name = t(NAME_KEY[item.id]);
            const desc = t(DESC_KEY[item.id]);
            return (
              <div
                key={item.id}
                className="rounded border border-edge bg-surface/40 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-content">{name}</span>
                      <a
                        href={KEY_URL[item.id]}
                        className="inline-flex items-center gap-0.5 text-content-subtle hover:text-accent"
                        title={t("settings.integrations.getKey")}
                      >
                        <IconExternalLink size={11} />
                      </a>
                      {item.configured && (
                        <span className="inline-flex items-center gap-0.5 text-[0.7857em] text-accent">
                          <IconCheck size={11} />
                          {t("settings.integrations.configured")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-content-subtle [font-size:var(--rp-fs-md)]">{desc}</p>
                  </div>
                </div>

                {/* 密钥 */}
                <div className="mt-2.5 flex items-center gap-2">
                  <Input
                    type="password"
                    value={draft[item.id] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveKey(item.id);
                    }}
                    placeholder={
                      item.configured
                        ? t("settings.integrations.keyPlaceholderSet", { masked: item.keyMasked })
                        : t("settings.integrations.keyPlaceholder")
                    }
                    className="min-w-0 flex-1"
                  />
                  <Button
                    onClick={() => void saveKey(item.id)}
                    disabled={busy === item.id || !(draft[item.id] ?? "").trim()}
                  >
                    {t("settings.integrations.save")}
                  </Button>
                  {item.configured && (
                    <Button
                      variant="ghost"
                      onClick={() => void clearKey(item.id)}
                      disabled={busy === item.id}
                    >
                      {t("settings.integrations.clear")}
                    </Button>
                  )}
                </div>

                {/* 测试 + 结果 */}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void test(item.id)}
                    disabled={!item.configured || testing === item.id}
                  >
                    {testing === item.id
                      ? t("settings.integrations.testing")
                      : t("settings.integrations.test")}
                  </Button>
                  {flash[item.id] && (
                    <span className="text-[0.7857em] text-content-subtle">{flash[item.id]}</span>
                  )}
                </div>

                {item.lastTest && (
                  <div
                    className={cn(
                      "mt-2 flex items-start gap-1.5 rounded px-2 py-1.5 [font-size:var(--rp-fs-md)]",
                      item.lastTest.ok
                        ? "bg-accent/5 text-content-muted"
                        : "bg-red-500/5 text-red-500",
                    )}
                  >
                    {item.lastTest.ok ? (
                      <IconCheck size={12} className="mt-px shrink-0" />
                    ) : (
                      <IconX size={12} className="mt-px shrink-0" />
                    )}
                    <span className="min-w-0">{item.lastTest.message}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {/* 批量检测:库里有多少篇真的"能被 AI 读"了。
          放在集成页是因为它查的正是 MinerU 配没配对、生效没有 —— 转换出问题时
          用户第一反应就是来这一页看。 */}
      <SettingsSection
        title={t("settings.integrations.statsTitle")}
        desc={t("settings.integrations.statsDesc")}
      >
        {!stats ? null : stats.total === 0 ? (
          <div className="px-4 py-3 text-[0.7857em] text-content-subtle">
            {t("settings.integrations.statsEmpty")}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-content-muted">
                {t("settings.integrations.statsTotal", { n: stats.total })}
              </span>
              <span className="text-accent">
                {t("settings.integrations.statsConverted", { n: stats.complete })}
              </span>
              {/* 未转的用红色标出来 —— 这类文献 AI 读不到正文、全文检索也搜不到 */}
              <span className={stats.pending > 0 ? "text-red-500" : "text-content-subtle"}>
                {t("settings.integrations.statsPending", { n: stats.pending })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void runConvert(false)}
                disabled={busyConvert || stats.pending === 0}
              >
                {busyConvert
                  ? t("settings.integrations.convertRunning")
                  : t("settings.integrations.convertPending", { n: stats.pending })}
              </Button>
              <Button variant="ghost" onClick={() => void runConvert(true)} disabled={busyConvert}>
                {t("settings.integrations.convertAll")}
              </Button>
            </div>
            {convertMsg && (
              <div className="text-[0.7857em] text-content-subtle">{convertMsg}</div>
            )}

            {/* 待办清单 —— 用户要求「要有个列表,可以单独对一个进行转录」。
                只列不完整的,完整的没必要占地方;每行说清**为什么**不完整。 */}
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
                        {!r.hasMd
                          ? t("settings.integrations.reasonNoMd")
                          : t("settings.integrations.reasonNoAssets", { n: r.imageRefs })}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void convertOne(r.id)}
                      disabled={convertingId === r.id || !r.hasPdf}
                    >
                      {convertingId === r.id
                        ? t("settings.integrations.convertRunning")
                        : t("settings.integrations.convertOne")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
