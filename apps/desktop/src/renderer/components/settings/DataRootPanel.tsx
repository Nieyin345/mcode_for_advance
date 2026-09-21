/**
 * 设置 → 数据位置。
 *
 * ## 这一页要回答的唯一问题:我的东西到底在哪
 *
 * 之前数据库在 `%APPDATA%\@mcode\desktop`、文献库也在那儿、模版在 `~/Mcode`,用户
 * 想备份或搬盘得记住三个地方。现在只有一个根,所以**这一页的主体就是那棵树** ——
 * 论文、教材、笔记分别落在哪,一眼看得见。
 *
 * ## 为什么三个库的路径不再各占一块
 *
 * 早先这一页下面还挂着「库位置」「模版位置」两块,各自显示一个路径框。那是合并三页
 * 时留下的尾巴:库位置和模版位置**本来就是数据根下的两个子目录**,把它们再列一遍
 * 只是同一句话说三次,还把页面撑得很长。现在统一进树里说明,这一页只剩两件事:
 * **根在哪**(可搬)+ **模版管理**(真有操作)。
 *
 * ## 改位置为什么必须重启
 *
 * 数据库在运行期**一直被主进程持有**(sql.js 把整个文件放在内存里,每次写就整体覆盖
 * 回去),没法在运行中给它换地基。所以流程是:同步落盘 → 整树复制到新位置 → 写指针
 * 文件 → **重启应用**。界面上必须把这一点说清楚,不然用户点完看到应用自己重启会以为
 * 崩了。
 */
import { useCallback, useEffect, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconFolder, IconLoader2 } from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

interface RootInfo {
  root: string;
  dbPath: string;
  libraryPath: string;
  templatesPath: string;
}

/** 目录树的一行:`名字` 用等宽、`说明` 用弱色。缩进用 `depth`。 */
function TreeRow({ name, note, depth = 0 }: { name: string; note: string; depth?: number }) {
  return (
    <div className="flex items-baseline gap-3 py-0.5" style={{ paddingLeft: depth * 14 }}>
      <span className="w-40 shrink-0 font-mono text-[0.7857em] text-content">{name}</span>
      <span className="min-w-0 flex-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {note}
      </span>
    </div>
  );
}

export function DataRootPanel() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RootInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已经点了迁移、正在等重启 —— 界面上给一句明确的话,不然会以为卡住。 */
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.app.getDataRoot());
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    // 说清楚会发生什么再动手 —— 会整体复制,并且应用会自己重启
    if (!window.confirm(t("settings.dataRoot.confirm", { path }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.app.moveDataRoot({ path });
      if (!res.ok) {
        setError(res.error ?? t("settings.dataRoot.failed"));
        return;
      }
      setRestarting(true);
    } finally {
      setBusy(false);
    }
  };

  if (restarting) {
    return (
      <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
        <PanelHeader title={t("settings.dataRoot.title")} />
        <div className="flex items-center gap-2 py-3 text-xs text-content-muted">
          <IconLoader2 size={13} className="animate-spin" />
          {t("settings.dataRoot.restarting")}
        </div>
      </section>
    );
  }

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.dataRoot.title")} />

      <SettingsSection
        title={t("settings.dataRoot.locationTitle")}
        desc={t("settings.dataRoot.desc")}
        icon={IconFolder}
      >
        {/* 根在哪 + 搬走 —— 这一页的主操作 */}
        <SettingRow layout="vertical" title={t("settings.dataRoot.currentPath")}>
          <div className="flex min-w-0 flex-col gap-2">
            <div
              className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-surface-muted px-2.5 py-1.5 font-mono text-xs text-content"
              title={info?.root}
            >
              <IconFolder size={12} className="shrink-0 text-content-subtle" />
              <span className="truncate select-all">{info?.root ?? "…"}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void move()} disabled={busy || !info}>
                <IconFolder size={12} />
                {t("settings.dataRoot.move")}
              </Button>
            </div>
            {error && <div className="text-[0.7857em] text-red-500">{error}</div>}
          </div>
        </SettingRow>

        {/* 目录树 —— 直接回答「我的东西在哪」。三个库的落点都标出来。 */}
        <SettingRow layout="vertical" title={t("settings.dataRoot.treeTitle")}>
          <div className="rounded border border-edge bg-surface/40 p-3">
            <TreeRow name="mcode.db" note={t("settings.dataRoot.tree.db")} />
            <TreeRow
              name="library/"
              note={t("settings.dataRoot.tree.library")}
            />
            <TreeRow name="papers/" note={t("settings.dataRoot.tree.papers")} depth={1} />
            <TreeRow name="markdown/" note={t("settings.dataRoot.tree.markdown")} depth={1} />
            <TreeRow name="notes/" note={t("settings.dataRoot.tree.notes")} depth={1} />
            <TreeRow name="collections/" note={t("settings.dataRoot.tree.collections")} depth={1} />
            <TreeRow name="exports/" note={t("settings.dataRoot.tree.exports")} depth={1} />
            <TreeRow name="templates/" note={t("settings.dataRoot.tree.templates")} />
          </div>
        </SettingRow>

        {/* 手工搬法。放在最后、说清与按钮的区别 —— 它不会复制任何东西。
            没用 SettingRow:那一行是"左边标题 + 右边控件"的形状,这里没有控件。
            内边距跟 SettingRow 对齐(px-4 py-3),卡片里的节奏才一致。 */}
        <div className="px-4 py-3">
          <div className="text-[0.8571em] font-medium text-content">
            {t("settings.dataRoot.manualTitle")}
          </div>
          <p className="mt-0.5 text-[0.7857em] leading-relaxed text-content-subtle">
            {t("settings.dataRoot.manualHint")}
          </p>
        </div>
      </SettingsSection>

      {/* ⚠️ **模版库那块管理界面删掉了**（2026-09-21，用户：「设置页面这里删掉吧，
          不要了」）。
          ——
          它当初挂在这里的理由是「数据根决定**放哪儿**，这里决定**放什么**」。但那个
          "放什么"的活**左栏那一段（`TemplateSection`）已经全干了**（建/删/预览/右键
          菜单，与设置页这套是同一套语义，见 `TemplateSection` 里那条注释），而设置页
          这一块是**第二套界面做同一件事** —— 正是用户一直说的"重复入口"。
          删掉之后功能一个不少，只是只剩左栏那一个入口。 */}
    </section>
  );
}
