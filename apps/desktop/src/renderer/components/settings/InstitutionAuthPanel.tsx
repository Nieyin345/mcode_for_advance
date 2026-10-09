/**
 * 设置 → 机构认证。
 *
 * ## 这个面板不管理凭据
 *
 * 用户在这里**不会**输入任何密码。真正的登录发生在内嵌浏览器里,登录态由浏览器
 * 的共享分区持有,并由 BrowserManager 的 cookie 保管库持久化。本面板只做两件事:
 *
 *   1. 记录「常用入口」(名字 + 登录地址 + 域名)—— 纯粹方便用户自己找入口;
 *   2. 从分区 cookie **实时反推**已登录站点,让用户看得见凭据覆盖范围并能清除。
 *
 * 之所以不做成「每个机构一套凭据」:需求明确要求认证要通用、不绑定具体机构。
 * 共用分区意味着在哪儿登录都算数,用户不需要先声明机构才能登录。
 */
import { useCallback, useEffect, useState } from "react";
import type { AuthSiteStatus, InstitutionProfile } from "@contracts/library";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconExternalLink,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
} from "@renderer/lib/icons.js";
import { Button, ErrorNote, Input } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

interface Draft {
  id?: string;
  name: string;
  loginUrl: string;
  domains: string;
  proxyPrefix: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = { name: "", loginUrl: "", domains: "", proxyPrefix: "", notes: "" };

function toDraft(p: InstitutionProfile): Draft {
  return {
    id: p.id,
    name: p.name,
    loginUrl: p.loginUrl ?? "",
    domains: p.domains.join(", "),
    proxyPrefix: p.proxyPrefix ?? "",
    notes: p.notes ?? "",
  };
}

export function InstitutionAuthPanel() {
  const { t } = useI18n();
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);

  const [profiles, setProfiles] = useState<InstitutionProfile[]>([]);
  const [sites, setSites] = useState<AuthSiteStatus[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  /** 这条路上每一处 IPC 都可能抛:保存/删除会因 schema 或"机构配置不存在"抛,
   *  `clearCookies` 会把 BrowserManager 的异常原样再抛。从前它们全是裸 `void` ——
   *  抛出来只落进 unhandled rejection(渲染端没有全局监听),用户点了按钮,屏幕上一句
   *  话都没有。挂一条始终可见的横幅接住。 */
  const [error, setError] = useState<string | null>(null);

  /** 拉一次登录站点概览。这条路**会抛** —— `authStatus` handler 要经
   *  `BrowserManager.browserSession()` 读分区 cookie,而它内部的 `session.fromPath()`
   *  对坏的数据目录会抛,handler 原样再抛回来。就地接住,一条出口覆盖全部调用方:
   *  六条调用路里(初始加载、保存、删除、单单清一个域、清全部,以及**头部那颗「重新
   *  加载」按钮**),前五条各自裹了 try/catch,只有按钮那条从前是裸 `void reloadStatus()` ——
   *  抛出来只落进 unhandled rejection(渲染端没有全局监听),用户点了「重新加载」,
   *  屏幕上一句话都没有。 */
  const reloadStatus = useCallback(async () => {
    try {
      const res = await api.institution.authStatus({});
      setSites(res.sites);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.institution.list();
        setProfiles(res.profiles);
        await reloadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [reloadStatus]);

  const saveDraft = async () => {
    if (!draft || !draft.name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.institution.save({
        id: draft.id,
        name: draft.name.trim(),
        loginUrl: draft.loginUrl.trim() || undefined,
        // 逗号分隔 → 数组;顺手 trim 掉空项
        domains: draft.domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        proxyPrefix: draft.proxyPrefix.trim() || undefined,
        notes: draft.notes.trim() || undefined,
      });
      setProfiles(res.profiles);
      setDraft(null);
      await reloadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const removeProfile = async (id: string) => {
    setError(null);
    try {
      const res = await api.institution.delete({ id });
      setProfiles(res.profiles);
      await reloadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearDomain = async (domain: string) => {
    setError(null);
    try {
      const res = await api.institution.clearCookies({ domains: [domain] });
      setSites(res.sites);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearAll = async () => {
    if (!window.confirm(t("institution.clearAllConfirm"))) return;
    setError(null);
    try {
      const res = await api.institution.clearCookies({});
      setSites(res.sites);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 版式与其它设置页**完全一致**(见 PanelHeader 顶部的三级说明):
  // 吸顶标题 + 若干 SettingsSection(卡片),卡片里用带内边距的行分隔。
  //   - 页面级说明段被删掉了:PanelHeader 明确不放 banner 描述,那段话挪进第一个
  //     分组的 desc —— 它本来就该由"这块在讲什么"来承载。
  //   - 主操作「打开浏览器登录」放进 PanelHeader 的 action 槽:那正是给页面主操作
  //     留的位置(与「快捷键」页的恢复默认、用量页的区间选择同一套)。
  //   - 每块内容都包一层 px-4:Card 自己没有内边距(普通设置行由 SettingRow 自带),
  //     不补的话内容会贴着卡片边线。
  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader
        title={t("institution.title")}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => openUrlInBrowser("about:blank")}
            className="gap-1.5"
          >
            <IconExternalLink size={14} />
            {t("institution.loginButton")}
          </Button>
        }
      />

      {error && (
        <ErrorNote title={t("settings.operationFailed")}>{error}</ErrorNote>
      )}

      {/* ── 已登录站点(从 cookie 实时推导)── */}
      <SettingsSection title={t("institution.authStatus")} desc={t("institution.desc")}>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="min-w-0 text-[0.7857em] leading-relaxed text-content-subtle">
            {t("institution.authStatusHint")}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => void reloadStatus()} className="gap-1.5">
              <IconRefresh size={13} />
              {t("institution.reload")}
            </Button>
            {sites.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void clearAll()} className="gap-1.5">
                <IconTrash size={13} />
                {t("institution.clearAll")}
              </Button>
            )}
          </div>
        </div>

        {sites.length === 0 ? (
          <div className="px-4 py-4 text-center text-xs text-content-subtle">
            {t("institution.authStatusEmpty")}
          </div>
        ) : (
          <div className="divide-y divide-edge/50">
            {sites.map((s) => {
              const matched = profiles.filter((p) => s.matchedProfileIds.includes(p.id));
              return (
                <div key={s.domain} className="flex items-center gap-2 px-4 py-2">
                  <IconShieldCheck size={14} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs text-content">{s.domain}</span>
                      {matched.length > 0 && (
                        <span className="shrink-0 rounded bg-surface-hover px-1 py-px text-[0.7143em] text-content-muted">
                          {matched.map((m) => m.name).join(" / ")}
                        </span>
                      )}
                    </div>
                    <div className="text-[0.7143em] text-content-subtle">
                      {t("institution.cookieCount", { n: s.cookieCount })}
                      {" · "}
                      {s.expiresAt
                        ? t("institution.expiresAt", {
                            date: new Date(s.expiresAt * 1000).toLocaleDateString(),
                          })
                        : t("institution.sessionCookie")}
                    </div>
                  </div>
                  <button
                    onClick={() => void clearDomain(s.domain)}
                    title={t("institution.clearDomain")}
                    className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {/* ── 常用入口(纯组织性记录)── */}
      <SettingsSection title={t("institution.profiles")} desc={t("institution.profilesHint")}>
        <div className="space-y-2 px-4 py-3">
          {profiles.map((p) => (
            <div key={p.id} className="rounded border border-edge bg-surface/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <IconLock size={13} className="shrink-0 text-content-subtle" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-content">{p.name}</span>
                <button
                  onClick={() => setDraft(toDraft(p))}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
                >
                  {t("institution.profile.save")}
                </button>
                <button
                  onClick={() => void removeProfile(p.id)}
                  className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                >
                  <IconTrash size={12} />
                </button>
              </div>
              {(p.loginUrl || p.domains.length > 0) && (
                <div className="mt-1 text-[0.7143em] text-content-subtle">
                  {p.loginUrl && (
                    <button
                      onClick={() => openUrlInBrowser(p.loginUrl!)}
                      className="text-accent hover:underline"
                    >
                      {p.loginUrl}
                    </button>
                  )}
                  {p.domains.length > 0 && <span className="ml-2">{p.domains.join(", ")}</span>}
                </div>
              )}
            </div>
          ))}

          {draft ? (
            <div className="space-y-2 rounded border border-accent bg-surface/40 p-3">
              <SettingRow title={t("institution.profile.name")}>
                <Input
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("institution.profile.namePlaceholder")}
                />
              </SettingRow>
              <SettingRow title={t("institution.profile.loginUrl")}>
                <Input
                  value={draft.loginUrl}
                  onChange={(e) => setDraft({ ...draft, loginUrl: e.target.value })}
                />
              </SettingRow>
              <SettingRow title={t("institution.profile.domains")} desc={t("institution.profile.domainsHint")}>
                <Input
                  value={draft.domains}
                  onChange={(e) => setDraft({ ...draft, domains: e.target.value })}
                />
              </SettingRow>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
                  {t("library.collection.cancel")}
                </Button>
                <Button size="sm" disabled={loading || !draft.name.trim()} onClick={() => void saveDraft()}>
                  {t("institution.profile.save")}
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setDraft(EMPTY_DRAFT)}
              className={cn(
                "flex w-full items-center gap-2 rounded border border-dashed border-edge px-3 py-2",
                "text-xs text-content-subtle transition-colors hover:border-accent hover:text-content",
              )}
            >
              <IconPlus size={14} />
              {t("institution.profile.new")}
            </button>
          )}
        </div>
      </SettingsSection>
    </section>
  );
}
