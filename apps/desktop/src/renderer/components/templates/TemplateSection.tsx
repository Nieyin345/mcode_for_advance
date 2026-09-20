/**
 * 左栏的「模版」段。
 *
 * ## 与「文档」(文献库)段的关系:同级别,只是内容不同
 *
 * 用户的明确要求是「左边栏再加一个模版栏,和上面的文档一样的样式,一样的功能」,
 * 后来的补充更准确:「**模版和文档是同级别的,只不过给 ai 的提示词不一样,只有这个
 * 区别**」,再后来把层次和"两段得一样"都说死了:
 *
 *   文档部分的做法是每个部分都有自己独立的回收站…模版也应该这么做,而且和文档一样
 *   要有全部内容,每一个都要有,然后位置调整一下,全部内容始终在最上面,回收站在
 *   最下面,而且每个都要有图标
 *   …而且文档和模版没有统一,两个不一样呀,得一样呀
 *
 * 所以这一段的层次是**照文献库那一段一行一行对着摆的**,两段共用
 * `components/sidebar` 那套原语:
 *
 *   文档段                                模版段
 *   ─────────────────────────────────────────────────────────────────
 *   表头「文档」+ 常显的「+」              表头「模版」+ 常显的「+」
 *   标签排 文献 / 教材 / 笔记             标签排 PPT / LaTeX / Word / 代码 / 图片
 *   「全部文献」在最上面(可展开)          「全部 LaTeX 模版」在最上面(可展开)
 *   分类(与「全部」**同级**,可展开)    模版(与「全部」**同级**,可展开)
 *     └ 条目                                 └ 文件
 *   「回收站」在最下面(每个库一个)        「回收站」在最下面(每个类目一个)
 *
 * 两个"全部"行的语义也是同一个:**这一层里的全部叶子**。文档那边展开出来是库里所有
 * 条目(不分分类),这边展开出来是这个类目下的所有文件(不分模版)—— 所以模版行是它
 * 的**兄弟**,不是它的子级(早先把模版嵌在「全部」里面,两段的形状一眼就不一样:
 * 一边是缩进的一棵树,另一边是平铺的几行)。
 *
 * 图标也是这么排的:全部 = `IconFiles`、容器 = `IconBook` / `IconFolder`、
 * 叶子 = `IconFileText`、回收站 = `IconArchive`(它是个"地方",不是一个"动作",
 * 所以不用垃圾桶图标 —— 那是「删除」按钮用的)。
 *
 * ## 行尾那三个按钮,与分类行逐个对齐
 *
 * 分类行有「重命名 / 删除」,而模版这一层还需要一个「加入对话」(模版最常见的用途
 * 就是丢给 AI 照着做)。所以两段的中间层统一成同一组:
 *
 *   💬 加入对话   ✏️ 重命名   🗑 删除
 *
 * 文献库那边的分类行也补上了 💬(它的右键菜单里本来就有这一项,现在两段的行尾长得
 * 一模一样)。**改名两边都是真的改名字**:这边改的是磁盘上那个目录(这个库的约定:
 * 目录名即显示名),那边改的是数据库里一行。
 *
 * ## 回收站
 *
 * 每个类目**各自**有一个(磁盘上就是 `<类目>/回收站/`,见 main/templates/store.ts),
 * 它挂在当前这一类目的列表最下面、**永远在最下面、默认收起**:平时不占位置,要找的
 * 时候总在同一个地方。删除是两步:先移进回收站(可逆),在回收站里删才是真删。
 *
 * ## 文件行也能点、也能右键
 *
 * 与文献库里那一篇文献一样:左键点开 = **中间**预览它(见 `FileViewer`),右键 =
 * 应用内预览 / 在文件夹中打开 / 用外部程序打开(见 TemplateFileContextMenu)。
 * 预览落在中间而不是左栏就地展开,是照文献库那套来的 —— 左栏两百来像素宽,一屏
 * LaTeX 源在这儿根本不够看。
 *
 * ⚠️ 2026-09-20:预览本体**从右栏搬到了中间**(用户要"文件在中间、右栏留给对话"),
 * 所以 `templateStore.previewFile` 现在只剩"左栏树里给当前文件高亮"这一个用处。
 *
 * ## 两种呈现,跟着顶部那个切换图标走
 *
 * 与文档段一样受 `leftBarMode` 控制,**不另设控件**。两段的规矩也一样:
 *   tree   —— 行带 chevron,点开看里面有哪些文件
 *   stream —— 中间层与叶子不画 chevron(它是「层级」的记号,而流模式里没有层级),
 *             点名字照样开合;「全部」那一行照文献库的做法**保留箭头**
 *
 * 展开态、当前标签、两个列表、预览选中的那个文件都在 `templateStore` 里 —— 切模式时
 * 组件会重挂载,留在组件里会丢(与文献库当年把 `expandedIds` 提进 store 是同一个原因)。
 */
import { useEffect, useMemo, useState } from "react";
import {
  TEMPLATE_KINDS,
  templateAttachKey,
  type TemplateEntry,
  type TemplateFile,
  type TemplateKind,
} from "@contracts/templates";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { TEMPLATE_KIND_LABEL } from "@renderer/lib/templateLabels.js";
import { api } from "@renderer/lib/api.js";
import { attachTemplateToCurrentChat } from "@renderer/lib/attachToChat.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useFileViewStore, basenameOf } from "@renderer/stores/fileViewStore.js";
import { useTemplateStore } from "@renderer/stores/templateStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import {
  IconArchive,
  IconArrowBackUp,
  IconFileText,
  IconFiles,
  IconFolder,
  IconMessage,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import {
  HeaderAction,
  HintRow,
  InlineInputRow,
  RowAction,
  SectionHeader,
  SectionTabs,
  SidebarList,
  SidebarRow,
  type SectionTab,
} from "@renderer/components/sidebar/Sidebar.js";
import { TemplateContextMenu, type TemplateCtxTarget } from "./TemplateContextMenu.js";
import {
  TemplateFileContextMenu,
  type TemplateFileCtxTarget,
} from "./TemplateFileContextMenu.js";

/** 展开一层后最多列这么多行(一条模版的文件、或「全部」里的所有文件)。
 *  模版最多可以有 500 个文件,全画出来会把左栏撑成一条几百行的长条 ——
 *  这里只要让用户认出"这套东西里有啥",剩下的去资源管理器看。 */
const MAX_FILES_SHOWN = 20;

export function TemplateSection() {
  const { t } = useI18n();
  const entries = useTemplateStore((s) => s.entries);
  const trashed = useTemplateStore((s) => s.trashed);
  const loaded = useTemplateStore((s) => s.loaded);
  const failed = useTemplateStore((s) => s.failed);
  const load = useTemplateStore((s) => s.load);
  const activeTab = useTemplateStore((s) => s.activeTab);
  const setActiveTab = useTemplateStore((s) => s.setActiveTab);
  const expanded = useTemplateStore((s) => s.expanded);
  const toggle = useTemplateStore((s) => s.toggle);
  const toggleAll = useTemplateStore((s) => s.toggleAll);
  const toggleTrash = useTemplateStore((s) => s.toggleTrash);
  const expandedAll = useTemplateStore((s) => s.expandedAll);
  const expandedTrash = useTemplateStore((s) => s.expandedTrash);
  const add = useTemplateStore((s) => s.add);
  const rename = useTemplateStore((s) => s.rename);
  const trash = useTemplateStore((s) => s.trash);
  const restore = useTemplateStore((s) => s.restore);
  const purge = useTemplateStore((s) => s.purge);
  const previewFile = useTemplateStore((s) => s.previewFile);
  const openFile = useTemplateStore((s) => s.openFile);
  const leftBarMode = useSessionStore((s) => s.leftBarMode);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const setCenterTabFocus = useSessionStore((s) => s.setCenterTabFocus);
  const openFileView = useFileViewStore((s) => s.open);

  /** 正在新建(输入框态)。 */
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  /** 新建失败的提示(重名、复制失败)。 */
  const [error, setError] = useState<string | null>(null);
  /** 模版行的右键菜单目标。 */
  const [ctxMenu, setCtxMenu] = useState<TemplateCtxTarget | null>(null);
  /** **文件行**的右键菜单目标 —— 与模版行那两个菜单各管一层。 */
  const [ctxFile, setCtxFile] = useState<TemplateFileCtxTarget | null>(null);
  /** 正在改名的那一条(键是 `templateAttachKey`)+ 输入中的名字 + 该处提示。
   *  与新建的输入框分开,因为两者的报错要显示在各自的输入框下面。 */
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const stream = leftBarMode === "stream";

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 模版库变了 —— 设置页那个「模版库」面板也能增删,这边不订阅就会一直显示旧列表
   * (用户会觉得"加了没反应")。与文献库订阅 `libraryChanged` 是同一个理由。
   *
   * 用 `?.` 调用:手机端的 web shim 对没列出的推送通道会同步抛错,而这段可能被共用
   * 组件带进移动端(见 webApi.ts 顶部的说明)。
   */
  useEffect(() => {
    const off = window.api?.on?.templatesChanged?.(() => void load());
    return off;
  }, [load]);

  /** 当前这一类目的模版。顺序由主进程给(mtime 倒序)—— 最近动过的排前面。 */
  const kindEntries = useMemo(
    () => entries.filter((e) => e.kind === activeTab),
    [entries, activeTab],
  );
  /** 当前这一类目**自己的**那个回收站。 */
  const kindTrashed = useMemo(
    () => trashed.filter((e) => e.kind === activeTab),
    [trashed, activeTab],
  );
  /** 「全部<类目>」展开后列的东西:**这一类目下所有模版的全部文件**,平铺。
   *  与文献库那边「全部文献」展开后列"所有条目"是同一个口径。 */
  const kindFiles = useMemo(
    () => kindEntries.flatMap((entry) => entry.files.map((file) => ({ entry, file }))),
    [kindEntries],
  );

  /** 五个标签各几条 —— 标签上显示,用户不用切过去就知道那边有没有东西。 */
  const tabs: ReadonlyArray<SectionTab<TemplateKind>> = useMemo(
    () =>
      TEMPLATE_KINDS.map((k) => ({
        key: k,
        label: t(TEMPLATE_KIND_LABEL[k]),
        count: entries.reduce((n, e) => (e.kind === k ? n + 1 : n), 0),
      })),
    [entries, t],
  );

  /** 「全部<类目>」展开着没有。默认**收起** —— 与文献库那个「全部文献」一致。 */
  const allOpen = !!expandedAll[activeTab];
  const trashExpanded = !!expandedTrash[activeTab];

  const cancelCreate = () => {
    setCreating(false);
    setName("");
    setError(null);
  };

  /**
   * 新建:名字必填(它会成为目录名),然后挑文件或整个文件夹。
   *
   * 与设置页的「模版库」面板**同一套语义**(那条路是 `TemplatesPanel.create`):
   * Enter 等价于点「选择文件…」,文件夹则整包收进来(LaTeX 常常是 .cls + .tex + 图)。
   * 挑选被取消时什么都不做 —— 不是错误。
   */
  const create = async (from: "files" | "folder") => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("settings.templates.nameRequired"));
      return;
    }
    setError(null);
    try {
      const picked =
        from === "files"
          ? (await api.pickFiles({})).paths
          : [await api.pickFolder().then((r) => r.path ?? "")];
      const sourcePaths = picked.filter(Boolean);
      if (sourcePaths.length === 0) return;
      const res = await add(activeTab, trimmed, sourcePaths);
      if (!res.ok) {
        // 重名、复制失败都要如实说 —— 静默什么都不发生是最糟的
        setError(res.error ?? t("settings.templates.openFailed"));
        return;
      }
      setName("");
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 失败一律弹出来。这几个动作都是用户亲手点的,静默失败会被当成功能坏了。 */
  const report = (body: string | undefined) =>
    useToastStore.getState().push({
      kind: "error",
      title: t("templates.ctx.actionFailed"),
      body,
    });

  /** 删除 = **移进回收站**(可逆)。真正的删除在回收站里(见 purgeEntry)。 */
  const trashEntry = async (entry: TemplateEntry) => {
    if (!window.confirm(t("settings.templates.deleteConfirm", { name: entry.dirName }))) return;
    await trash(entry);
  };

  /** 从回收站还原回原来的类目。目标位置被占用时主进程会拒绝,如实说出来。 */
  const restoreEntry = async (entry: TemplateEntry) => {
    const res = await restore(entry);
    if (!res.ok) report(res.error);
  };

  /** 回收站里删 —— **目录连文件一起从磁盘上消失**,这是一次不可逆的操作。 */
  const purgeEntry = async (entry: TemplateEntry) => {
    if (!window.confirm(t("templates.ctx.purgeConfirm", { name: entry.dirName }))) return;
    const res = await purge(entry);
    if (!res.ok) report(res.error);
  };

  /** 开始改名(目录名即显示名,所以改的是磁盘上那个目录)。 */
  const startRename = (entry: TemplateEntry) => {
    setRenamingKey(templateAttachKey(entry.kind, entry.dirName));
    setRenameDraft(entry.dirName);
    setRenameError(null);
  };

  /**
   * 提交改名。
   *
   * 失败(重名 / 目录已经不在了)时**把输入框留着并显示原因** —— 与文献库那边改分类名
   * 同一处理:关掉再让用户重新点一次「重命名」很烦,而"已经有一条同名的了"正是他改
   * 一个字就能解决的事。
   */
  const submitRename = async (entry: TemplateEntry) => {
    if (!renamingKey) return;
    const next = renameDraft.trim();
    // 没改 / 清空 → 当作放弃,不算错误
    if (!next || next === entry.dirName) {
      setRenamingKey(null);
      setRenameError(null);
      return;
    }
    const res = await rename(entry, next);
    if (!res.ok) {
      setRenameError(res.error ?? t("templates.ctx.actionFailed"));
      return;
    }
    setRenamingKey(null);
    setRenameError(null);
  };

  /** 展开/收起一条模版。chevron 与名字都走它 —— 与分类行的手感一致。 */
  const toggleEntry = (entry: TemplateEntry) => {
    if (entry.files.length === 0) return;
    toggle(templateAttachKey(entry.kind, entry.dirName));
  };

  /**
   * 点一个模版文件 —— **2026-09-20 起改在中间打开**(与文献库点一篇文件同一套)。
   *
   * 用户的原话:「要把之前的文献预览的页面,还有模版预览的页面合并成一个通用的,
   * 所有的文件的预览都走同一个右边栏类里面,然后…点开会在中间页面显示出来」。
   * 所以两处现在都落到同一个 `FileViewer`(按来源选一条 RPC),中间显示,右栏腾给
   * 对话。
   *
   * `templateStore.previewFile` **照旧写一份**:右栏那个「模版」标签里的树还在读它
   * (那份树要显示"现在看的是哪个文件"),只是预览本体搬走了。两份状态指向同一个
   * 文件,不冲突。
   *
   * 右栏**不再被强行拉出来**(`setRightOpen(true)` 去掉了)—— 用户要的正是"文件在
   * 中间的时候,右栏还能跟子代理说话"。
   */
  const openPreview = (entry: TemplateEntry, relPath: string) => {
    openFile(entry, relPath);
    openFileView({
      source: {
        kind: "template",
        ref: { kind: entry.kind, dirName: entry.dirName, relPath },
      },
      name: basenameOf(relPath),
    });
    setCenterTabFocus("editor");
  };

  /** 一条模版的次要说明:「N 个文件」/「M 张图 · K 份代码」。 */
  const countLabel = (entry: TemplateEntry) =>
    entry.kind === "image" && entry.imageCount > 0
      ? t("settings.templates.imagePair", { img: entry.imageCount, code: entry.codeFiles.length })
      : t("settings.templates.fileCount", { n: entry.files.length });

  /**
   * 一个文件行 —— 模版展开后的那一层,与「全部<类目>」展开后的那一层**共用这一个**。
   *
   * `withEntry` 只有「全部」那一层开:那一层是平铺的,不标出"这是哪条模版的文件",
   * 两条模版里同名的 `main.tex` 就分不出来了。
   */
  const fileRow = (entry: TemplateEntry, file: TemplateFile, withEntry: boolean) => {
    // 正在预览的那个高亮 —— 与文献库里"当前那篇"同一个观感,用户一眼知道右栏
    // 现在显示的是哪一个
    const on =
      !!previewFile &&
      previewFile.kind === entry.kind &&
      previewFile.dirName === entry.dirName &&
      previewFile.relPath === file.relPath;
    const label = withEntry ? `${entry.dirName} / ${file.relPath}` : file.relPath;
    return (
      <SidebarRow
        icon={<IconFileText size={12} className="shrink-0" />}
        label={label}
        // 点开是在**中间**预览(与文献库一致:左栏导航、中间看内容)。左栏两百来
        // 像素宽,一屏 LaTeX 源在这儿根本不够看。
        title={`${label}\n${t("templates.ctx.preview")}`}
        active={on ? "fill" : false}
        onClick={() => openPreview(entry, file.relPath)}
      />
    );
  };

  /** 展开后那一层:一条模版里有哪些文件。
   *
   *  `withBorder` 只有树模式才开 —— 左边那条竖线是「层级」的记号,而会话流模式里
   *  没有层级(与文档段 `renderStreamCollection` 同一处讲究)。 */
  const fileList = (entry: TemplateEntry, withBorder: boolean) => (
    <SidebarList nested border={withBorder}>
      {entry.files.slice(0, MAX_FILES_SHOWN).map((f) => (
        <li
          key={f.relPath}
          // 右键落在整行上(不只是文字),与文献行的手感一致
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxFile({ entry, relPath: f.relPath, x: e.clientX, y: e.clientY });
          }}
        >
          {fileRow(entry, f, false)}
        </li>
      ))}
      {entry.files.length > MAX_FILES_SHOWN && (
        <HintRow>
          {t("templates.section.moreFiles", { n: entry.files.length - MAX_FILES_SHOWN })}
        </HintRow>
      )}
    </SidebarList>
  );

  /** 一条模版的行 —— 与分类行同级、同款(悬停那三个按钮也一样)。 */
  const renderEntryRow = (entry: TemplateEntry) => {
    const key = templateAttachKey(entry.kind, entry.dirName);

    // 改名态:整行换成输入框(与分类改名的输入行同一套手感)
    if (renamingKey === key) {
      return (
        <InlineInputRow
          key={key}
          value={renameDraft}
          onChange={(next) => {
            setRenameDraft(next);
            if (renameError) setRenameError(null);
          }}
          onSubmit={() => void submitRename(entry)}
          onCancel={() => {
            setRenamingKey(null);
            setRenameError(null);
          }}
          onBlur={() => void submitRename(entry)}
          placeholder={t("templates.section.namePlaceholder")}
          error={renameError}
        />
      );
    }

    const isExpanded = !!expanded[key];
    return (
      <li key={key}>
        <SidebarRow
          icon={<IconFolder size={14} className="shrink-0" />}
          label={entry.dirName}
          title={`${entry.dirName}\n${countLabel(entry)}`}
          expanded={isExpanded}
          // 会话流模式里不画 chevron:那个箭头是「这里有一层更深的层级」的记号,而流
          // 模式的整体语义就是"没有层级"。**只藏控件、不藏功能** —— 点名字照样展开。
          onToggleExpand={stream ? undefined : () => toggleEntry(entry)}
          expandDisabled={entry.files.length === 0}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
          onClick={() => toggleEntry(entry)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ entry, inTrash: false, x: e.clientX, y: e.clientY });
          }}
          // 行尾三件:加入对话 / 重命名 / 删除 —— 与文献库那边分类行**同一组**。
          // 那边多出来的「新建笔记」只对笔记库有意义,所以它留在右键菜单里。
          actions={
            <>
              <RowAction
                title={t("templates.ctx.attachToChat")}
                onClick={(e) => {
                  e.stopPropagation();
                  void attachTemplateToCurrentChat(entry.kind, entry.dirName);
                }}
              >
                <IconMessage size={12} />
              </RowAction>
              <RowAction
                title={t("templates.ctx.rename")}
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(entry);
                }}
              >
                <IconPencil size={12} />
              </RowAction>
              <RowAction
                title={t("settings.templates.delete")}
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  void trashEntry(entry);
                }}
              >
                <IconTrash size={12} />
              </RowAction>
            </>
          }
        />

        {/* 模版里的文件。**两种模式共用同一个展开态** —— 会话流那边只是不画 chevron
            (它表示"层级",而流模式里没有层级),点名字照样能展开。 */}
        {isExpanded && fileList(entry, !stream)}
      </li>
    );
  };

  /** 回收站里的一条 —— 挂到对话 / 还原在行尾,彻底删除在它右边(带确认)。 */
  const renderTrashedRow = (entry: TemplateEntry) => {
    const key = `trash:${templateAttachKey(entry.kind, entry.dirName)}`;
    const isExpanded = !!expanded[key];
    return (
      <li key={key}>
        <SidebarRow
          icon={<IconFolder size={14} className="shrink-0" />}
          label={entry.dirName}
          // 类目不用写进标签 —— 这一行本来就挂在那个类目的回收站下面
          title={`${entry.dirName}\n${countLabel(entry)}`}
          expanded={isExpanded}
          onToggleExpand={stream ? undefined : () => toggle(key)}
          expandDisabled={entry.files.length === 0}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
          onClick={() => toggle(key)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ entry, inTrash: true, x: e.clientX, y: e.clientY });
          }}
          actions={
            <>
              <RowAction
                title={t("templates.ctx.attachToChat")}
                onClick={(e) => {
                  e.stopPropagation();
                  void attachTemplateToCurrentChat(entry.kind, entry.dirName);
                }}
              >
                <IconMessage size={12} />
              </RowAction>
              {/* 回收站里那个按钮是**还原**,不是删除 —— 与右键菜单同一套语义。删掉一个
                  已经在回收站里的东西,在这里只能理解成"彻底清掉",而那是右边那一个。 */}
              <RowAction
                title={t("templates.ctx.restore")}
                onClick={(e) => {
                  e.stopPropagation();
                  void restoreEntry(entry);
                }}
              >
                <IconArrowBackUp size={12} />
              </RowAction>
              <RowAction
                title={t("templates.ctx.purge")}
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  void purgeEntry(entry);
                }}
              >
                <IconTrash size={12} />
              </RowAction>
            </>
          }
        />
        {isExpanded && fileList(entry, !stream)}
      </li>
    );
  };

  /** 「+ 新建」的输入行 —— 与新建分类那一行同一套手感。 */
  const creatingRow = creating && (
    <InlineInputRow
      value={name}
      onChange={(next) => {
        setName(next);
        // 用户一开始改就把上次的提示清掉,否则红字会一直挂着
        if (error) setError(null);
      }}
      onSubmit={() => void create("files")}
      onCancel={cancelCreate}
      placeholder={t("templates.section.namePlaceholder")}
      error={error}
    >
      {/* 名字起好之后要挑东西进来 —— 一条模版就是一包文件,没有"空模版"的用法。
          两个入口与设置页那张面板一致:文件 / 文件夹。 */}
      <div className="flex items-center gap-1 pl-4 pt-1">
        <button
          onClick={() => void create("files")}
          className="rounded px-1.5 py-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent [font-size:var(--rp-fs-md)]"
        >
          {t("settings.templates.pickFiles")}
        </button>
        <button
          onClick={() => void create("folder")}
          className="rounded px-1.5 py-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent [font-size:var(--rp-fs-md)]"
        >
          {t("settings.templates.pickFolder")}
        </button>
      </div>
    </InlineInputRow>
  );

  /** 「全部<类目>」那一行的字。与文献库的 `library.view.allInKind` 逐字同款。 */
  const allLabel = t("templates.section.all", { kind: t(TEMPLATE_KIND_LABEL[activeTab]) });

  return (
    <>
      {/* 表头 —— 与「项目」「文档」的表头同款。右侧那个「+」**常显**,理由与文献库
          那段逐字相同:这里右边只有这一个按钮,一隐藏就整块看不见。 */}
      <SectionHeader
        title={t("templates.section.title")}
        action={
          <HeaderAction
            title={t("templates.section.new")}
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
          >
            <IconPlus size={12} />
          </HeaderAction>
        }
      />

      {/* 五个类目 —— 与文献库那排「文献 / 教材 / 笔记」同款(选中铺底、未选只提亮
          文字)。**回收站不在这里** —— 它是每个类目列表最下面的一行。 */}
      <SectionTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <ul className="space-y-0.5">
        {!loaded ? (
          // 还没拉回来 —— 给一行占位,避免"加载中"和"空的"看起来一样
          <HintRow>…</HintRow>
        ) : failed ? (
          // 读不到就说读不到,不能显示成"这个类目还没有模版"
          <HintRow>{t("templates.section.loadFailed")}</HintRow>
        ) : (
          <>
            {/* 「全部<类目>」—— **永远在最上面**。与文献库那个「全部文献」逐字同款:
                展开看这一类目下的**全部文件**,行尾那个气泡把整个类目挂进当前对话
                (给的是索引清单,见 main/templates/store.ts 的 writeTemplateKindManifest)。 */}
            <li>
              <SidebarRow
                icon={<IconFiles size={14} className="shrink-0" />}
                label={allLabel}
                title={`${allLabel}\n${t("templates.ctx.attachToChat")}`}
                expanded={allOpen}
                // 两种模式都保留箭头 —— 文献库那边「全部文献」也是这么处理的
                onToggleExpand={() => toggleAll(activeTab)}
                expandTitle={t("layout.expand")}
                collapseTitle={t("layout.collapse")}
                onClick={() => toggleAll(activeTab)}
                actions={
                  <RowAction
                    title={t("templates.ctx.attachToChat")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void attachTemplateToCurrentChat(activeTab);
                    }}
                  >
                    <IconMessage size={12} />
                  </RowAction>
                }
              />
              {allOpen && (
                <SidebarList nested>
                  {kindFiles.length === 0 ? (
                    <HintRow>{t("settings.templates.empty")}</HintRow>
                  ) : (
                    <>
                      {kindFiles.slice(0, MAX_FILES_SHOWN).map(({ entry, file }) => (
                        <li
                          key={`${entry.dirName}/${file.relPath}`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCtxFile({
                              entry,
                              relPath: file.relPath,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                        >
                          {fileRow(entry, file, true)}
                        </li>
                      ))}
                      {kindFiles.length > MAX_FILES_SHOWN && (
                        <HintRow>
                          {t("templates.section.moreFiles", {
                            n: kindFiles.length - MAX_FILES_SHOWN,
                          })}
                        </HintRow>
                      )}
                    </>
                  )}
                </SidebarList>
              )}
            </li>

            {/* 这个类目的模版 —— 与「全部」**同级**(文档那边分类也是「全部文献」的
                同级),展开看各自的文件 */}
            {kindEntries.map(renderEntryRow)}

            {/* 回收站 —— **永远在最下面**。每个类目一个(磁盘上就是 `<类目>/回收站/`),
                默认收起:平时不占位置,要找的时候总在同一个地方。 */}
            <li>
              <SidebarRow
                icon={<IconArchive size={14} className="shrink-0" />}
                label={t("templates.section.trash")}
                title={
                  kindTrashed.length > 0
                    ? `${t("templates.section.trash")} · ${kindTrashed.length}`
                    : t("templates.section.trashEmpty")
                }
                expanded={trashExpanded}
                // 同模版行:会话流模式不画 chevron(层级记号),点名字照样开合
                onToggleExpand={stream ? undefined : () => toggleTrash(activeTab)}
                expandTitle={t("layout.expand")}
                collapseTitle={t("layout.collapse")}
                onClick={() => toggleTrash(activeTab)}
              />
              {trashExpanded &&
                (kindTrashed.length === 0 ? (
                  <SidebarList nested>
                    <HintRow>{t("templates.section.trashEmpty")}</HintRow>
                  </SidebarList>
                ) : (
                  <SidebarList nested>{kindTrashed.map(renderTrashedRow)}</SidebarList>
                ))}
            </li>
          </>
        )}
        {creatingRow}
      </ul>

      {/* 模版行的右键菜单。普通行给「改名 / 删除(→回收站)」,回收站里的行给
          「还原 / 彻底删除」—— 见 TemplateContextMenu 的说明。 */}
      <TemplateContextMenu
        target={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={startRename}
        onTrash={(entry) => void trashEntry(entry)}
        onRestore={(entry) => void restoreEntry(entry)}
        onPurge={(entry) => void purgeEntry(entry)}
      />

      {/* 文件行的右键菜单:应用内预览 / 在文件夹中打开 / 用外部程序打开 */}
      <TemplateFileContextMenu
        target={ctxFile}
        onClose={() => setCtxFile(null)}
        onPreview={openPreview}
      />
    </>
  );
}
