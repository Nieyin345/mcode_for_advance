/**
 * 设置 → 模版库。
 *
 * 五个类目(PPT / LaTeX / Word / 代码 / 图片)加一个**回收站**,每个类目下是一堆
 * **目录** —— 一条模版就是一个文件夹。所以这一页的交互刻意做得很薄:建、看、挂到对话、
 * 删、在文件夹中显示。增删改文件本身交给资源管理器 —— 反正扫描是每次实时做的,在外面
 * 怎么整都算数。
 *
 * 图片类目按用户定的规则显示:一条 = **一组图 + 一份代码**,所以列表上直接标出
 * 「N 张图 · M 份代码」,不用点进去数。
 *
 * ## 删除是两步,和文献库一致
 *
 * 「删除」= 移进回收站(可逆);回收站里才有「彻底删除」。用户对模版库的要求是
 * 「模版和文档是同级别的,只不过给 ai 的提示词不一样,只有这个区别」—— 而文献库的
 * 删除正是两步,所以这里照着来。左栏那一段也长一样(见 TemplateSection)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TEMPLATE_KINDS,
  type TemplateEntry,
  type TemplateKind,
} from "@contracts/templates";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { TEMPLATE_KIND_LABEL } from "@renderer/lib/templateLabels.js";
import { api } from "@renderer/lib/api.js";
import { attachTemplateToCurrentChat } from "@renderer/lib/attachToChat.js";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconArrowBackUp,
  IconFolderOpen,
  IconLoader2,
  IconMessage,
  IconTrash,
} from "@renderer/lib/icons.js";
import { SettingsSection } from "./SettingsSection.js";


/** 这一页能看的"页"。`"trash"` 是回收站 —— 与五个类目并排。 */
type PanelTab = TemplateKind | "trash";

export function TemplatesPanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanelTab>("latex");
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** 新建时输入的名字。必填 —— 它就是磁盘上的目录名。 */
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const inTrash = tab === "trash";

  const reload = useCallback(async (which: PanelTab) => {
    try {
      if (which === "trash") {
        const res = await api.templates.trashList();
        setEntries(res.trashed);
      } else {
        const res = await api.templates.list({ kind: which });
        setEntries(res.entries);
      }
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void reload(tab);
  }, [tab, reload]);

  /**
   * 模版库变了 → 重扫当前这一页。
   *
   * 这一页和左栏那段是**同一批数据的两张脸**:在左栏删了一条、或者 AI 往模版库里
   * 放了东西,这一页不订阅就会一直显示旧列表 —— 用户看到的会是"我在左边删了,设置里
   * 还在"。空实现也行不通:`load()` 之外没有任何东西会替这一页刷新。
   */
  useEffect(() => {
    const off = window.api?.on?.templatesChanged?.(() => void reload(tab));
    return off;
  }, [tab, reload]);

  /** 新建:名字必填(它会成为目录名),然后挑文件或整个文件夹。 */
  const create = async (from: "files" | "folder") => {
    if (inTrash) return;
    const name = newName.trim();
    if (!name) {
      setError(t("settings.templates.nameRequired"));
      return;
    }
    setError(null);
    const picked =
      from === "files" ? (await api.pickFiles({})).paths : [await api.pickFolder().then((r) => r.path ?? "")];
    const sourcePaths = picked.filter(Boolean);
    if (sourcePaths.length === 0) return;
    setBusy(true);
    try {
      const res = await api.templates.add({ kind: tab, name, sourcePaths });
      setEntries(res.entries);
      setNewName("");
    } catch (err) {
      // 重名、复制失败都要如实说 —— 静默什么都不发生是最糟的
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 打开这条模版的文件夹。
   *
   * 结果**必须显示出来** —— 上一版直接 `void` 掉了返回值,所以失败时(比如用户已经
   * 在资源管理器里把目录删了)界面上什么都不发生,或者只弹一个系统报错对话框,
   * 用户完全不知道发生了什么。顺手重扫一次,把已经不存在的条目从列表里去掉。
   */
  const reveal = async (entry: TemplateEntry) => {
    const res = await api.templates.reveal({ kind: entry.kind, dirName: entry.dirName });
    if (!res.ok) setError(res.error ?? t("settings.templates.openFailed"));
    await reload(tab);
  };

  /** 删除 = **移进回收站**(可逆)。真正的删除在回收站页里(见 purge)。 */
  const trash = async (entry: TemplateEntry) => {
    if (!window.confirm(t("settings.templates.deleteConfirm", { name: entry.dirName }))) return;
    setBusy(true);
    try {
      const res = await api.templates.trash({ kind: entry.kind, dirName: entry.dirName });
      setEntries(res.entries);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 从回收站还原回原来的类目。目标被占用时主进程会拒绝 —— 把那句话显示出来。 */
  const restore = async (entry: TemplateEntry) => {
    setBusy(true);
    try {
      const res = await api.templates.restore({ kind: entry.kind, dirName: entry.dirName });
      if (!res.ok) setError(res.error ?? t("templates.ctx.actionFailed"));
      setEntries(res.trashed);
    } finally {
      setBusy(false);
    }
  };

  /** 回收站里删 —— 目录连文件一起从磁盘上消失,不可还原。 */
  const purge = async (entry: TemplateEntry) => {
    if (!window.confirm(t("templates.ctx.purgeConfirm", { name: entry.dirName }))) return;
    setBusy(true);
    try {
      const res = await api.templates.purge({ kind: entry.kind, dirName: entry.dirName });
      if (!res.ok) setError(res.error ?? t("templates.ctx.actionFailed"));
      setEntries(res.trashed);
    } finally {
      setBusy(false);
    }
  };

  const tabs = useMemo(
    () =>
      [
        ...TEMPLATE_KINDS.map((k) => ({ tab: k as PanelTab, label: t(TEMPLATE_KIND_LABEL[k]) })),
        { tab: "trash" as PanelTab, label: t("templates.section.trash") },
      ],
    [t],
  );

  return (
    <>
      <SettingsSection title={t("settings.templates.title")} desc={t("settings.templates.desc")}>
        {/* Card 本身没有内边距(普通设置行由 SettingRow 自带)。这里是自定义布局,
            所以自己补一层 —— 否则内容会贴着卡片的边线。 */}
        <div className="px-4 py-3">
        {/* 类目切换 */}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {tabs.map((item) => (
            <button
              key={item.tab}
              onClick={() => setTab(item.tab)}
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                item.tab === tab
                  ? "bg-surface-hover font-medium text-content"
                  : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 新建 —— 回收站页里没有它:"往回收站里新建一条模版"没有意义 */}
        {!inTrash && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t("settings.templates.newName")}
              className="min-w-[180px] flex-1"
            />
            <Button variant="outline" onClick={() => void create("files")} disabled={busy}>
              {t("settings.templates.pickFiles")}
            </Button>
            <Button variant="outline" onClick={() => void create("folder")} disabled={busy}>
              {t("settings.templates.pickFolder")}
            </Button>
          </div>
        )}
        {error && <div className="mb-2 text-[0.7857em] text-red-500">{error}</div>}

        {/* 列表 */}
        {entries.length === 0 ? (
          <div className="text-[0.7857em] text-content-subtle">
            {inTrash ? t("templates.section.trashEmpty") : t("settings.templates.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li
                key={`${entry.kind}/${entry.dirName}`}
                className="group flex items-center gap-2 rounded border border-edge bg-surface/40 px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-content">{entry.dirName}</div>
                  <div className="text-[0.7857em] text-content-subtle">
                    {/* 回收站里必须标出**原来属于哪个类目** —— 还原要放回去,而目录名
                        不带这个信息,用户也得认得出这条是从哪儿删的 */}
                    {inTrash && `${t(TEMPLATE_KIND_LABEL[entry.kind])} · `}
                    {entry.kind === "image" && entry.imageCount > 0
                      ? t("settings.templates.imagePair", {
                          img: entry.imageCount,
                          code: entry.codeFiles.length,
                        })
                      : t("settings.templates.fileCount", { n: entry.files.length })}
                  </div>
                </div>
                {/* 挂到当前对话 —— 与左栏右键和「+ → 模版」共用主进程那一份实现。
                    回收站里的也照样能挂:文献库那边同理,回收站只是一个普通分类。 */}
                <button
                  onClick={() => void attachTemplateToCurrentChat(entry.kind, entry.dirName)}
                  title={t("templates.ctx.attachToChat")}
                  className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-accent"
                >
                  <IconMessage size={13} />
                </button>
                <button
                  onClick={() => void reveal(entry)}
                  title={t("settings.templates.reveal")}
                  className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                >
                  <IconFolderOpen size={13} />
                </button>
                {inTrash ? (
                  <>
                    <button
                      onClick={() => void restore(entry)}
                      disabled={busy}
                      title={t("templates.ctx.restore")}
                      className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content disabled:opacity-40"
                    >
                      <IconArrowBackUp size={13} />
                    </button>
                    <button
                      onClick={() => void purge(entry)}
                      disabled={busy}
                      title={t("templates.ctx.purge")}
                      className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-red-500 disabled:opacity-40"
                    >
                      <IconTrash size={13} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => void trash(entry)}
                    disabled={busy}
                    title={t("settings.templates.delete")}
                    className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-red-500 disabled:opacity-40"
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        </div>
      </SettingsSection>
    </>
  );
}
