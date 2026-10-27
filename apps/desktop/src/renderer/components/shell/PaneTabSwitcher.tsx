/**
 * 【UI 重建 2026-10-28】**右栏 tile 的页签切换器 + 自定义页签内容**。
 *
 * ## 它解决的是哪件事（三条线共同断在这里）
 *
 * 换壳之后，`rightPanelTab` 这个状态**只有写入口、没有全集读入口**：
 *
 * | 写入口 | 在哪 |
 * |---|---|
 * | 顶栏五个 pane 开关 | `ClaudeTitlebar` 的 `paneToggles`（概览/终端/侧聊/预览/文件） |
 * | 命令面板三条 | `view.right-panel.files` / `.git` / `.turns` |
 *
 * 而 `RightPanelTabSchema` 里现在有 **13 个值**。其余的（`browser` / `extensions` /
 * `canvas` / `tasks` / `taskcenter` / `flow` / `sidechat`）**没有任何用户可点的
 * 入口** —— 值能写进 store、tile 在 `paneContent` 里也有分支，但用户到不了。
 *
 * 三条并行线各自的症状，根都是这一条：
 *  - **扩展线**：装完扩展，右栏找不到它（`extensions` 只能由代码设置）；
 *  - **工作流线**：WF-01 写明「画布右栏也可停靠」，而停靠入口随旧右栏下线；
 *  - **Office 线**：`artifact` 分支能渲染，没有任何页签映射过去。
 *
 * 旧外壳有那条图标轨（`customUi/registry.ts` 的 `rightPanel.tab`）承担这件事，
 * 换壳换成 tile 之后它没有跟着搬过来。**本文件把轨搬进 tile 标题栏** ——
 * 不新开一块空间，就在既有的 pane 标题行上多一个切换入口。
 *
 * ## 为什么不自己再列一份页签清单
 *
 * 页签有哪些、叫什么、什么顺序、哪些被用户隐藏 —— **由 `rightPanel.tab` 这个
 * 挂载位的自定义 UI 配置说了算**（设置 → 自定义界面 → 右栏页签）。那份配置
 * 旧外壳在用、设置页在编辑、套件在守。这里**只消费它，不另立一份**：
 *
 * ```ts
 * resolveSlotEntries("rightPanel.tab", …)   // 顺序 + 隐藏 + 自定义项，全是它算的
 * ```
 *
 * 硬规矩 2：两处若各抄一份清单，加页签时必然只改一处 —— 而漏掉的那处
 * **不会报错**，只是那个页签在新外壳里点不到。
 *
 * ## 自定义页签也要能显示（同一件事的另一半）
 *
 * 旧 `RightPanel` 里「切到自定义页签」和「把它的内容画出来」是两处代码
 * （`activeCustomId` + `CustomTabView`）。**只搬前一半会得到「点了没反应」**：
 * 切换器高亮变了，内容区还是上一个内置面板。所以本文件同时导出
 * `PaneCustomContent` —— 由 tile 渲染路径在「当前是自定义页签」时调用。
 *
 * ## 与顶栏五个开关的关系
 *
 * 不冲突、不重复实现：顶栏那五个是**常用项的快捷键**（Claude 真机截图就那么排），
 * 本文件是**全集入口**。两者最终都走同一个 store action（`setRightPanelTab` +
 * `setRightOpen`），不会各记一份状态。
 */
import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import {
  BUILTINS,
  CUSTOM_ICONS,
  DEFAULT_ACTION_ICON,
  type IconComponent,
} from "@renderer/components/customUi/registry.js";
import { resolveSlotEntries } from "@renderer/components/customUi/CustomUiMenuItems.js";
import { CustomTabView } from "@renderer/components/customUi/CustomTabView.js";
import { useWorkspaceTarget } from "@renderer/components/customUi/useWorkspaceTarget.js";
import { customUiLabel, type CustomUiSlot } from "@contracts/customUi";

/** 本文件只吃这一个挂载位；写成常量是为了让「换挂载位」不会静默错位。 */
const SLOT: CustomUiSlot = "rightPanel.tab";

/**
 * 右栏页签的切换器。
 *
 * 放在 tile 的标题行里（`TilePane` 的 `header` 槽）—— 与顶部那排 pane 开关
 * 是同一个视觉家族：小图标 + 短文字、28px 高、选中态用 ghost-selected 底。
 */
export function PaneTabSwitcher() {
  const { t, locale } = useI18n();
  const activeTab = useSessionStore((s) => s.rightPanelTab);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const activeCustomId = useCustomUiStore((s) => s.activeTab);
  const setActiveCustomTab = useCustomUiStore((s) => s.setActiveTab);
  const items = useCustomUiStore((s) => s.config.items);
  const layout = useCustomUiStore((s) => s.config.layout[SLOT]);
  const target = useWorkspaceTarget();

  /* 内置页签的「点了做什么」。
   *
   * `resolveSlotEntries` 要求每个内置项**显式给一个 runtime**，没给的就不显示 ——
   * 这是它的设计（「这一刻不适用」的项不该出现）。右栏页签在这里**全部适用**：
   * 每一个都对应一个真实存在的 tile，所以全部给上。
   *
   * ⚠️ 键必须覆盖 `registry.ts` 里 `rightPanel.tab` 的每一项。漏一项的后果是
   * 「那个页签从切换器里消失」—— **不报错、不红**，只是没了。
   * `claude-shell-smoke` 有一条断言守这件事。
   *
   * ⚠️ `rightOpen` 在闭包里：右栏关着时点页签必须**连栏一起打开**，
   * 否则只改了一个隐藏的值（`view.right-panel.browser` 那条命令的注释里
   * 记着同一个坑）。 */
  const builtins = useMemo(() => {
    const map: Record<string, { run: () => void }> = {};
    for (const meta of BUILTINS[SLOT]) {
      map[meta.id] = {
        run: () => {
          setActiveCustomTab(null); // 内置页签 → 退出自定义页签
          setRightPanelTab(meta.id as never);
          if (!rightOpen) setRightOpen(true);
        },
      };
    }
    return map;
  }, [rightOpen, setActiveCustomTab, setRightPanelTab, setRightOpen]);

  const entries = useMemo(
    () => resolveSlotEntries(SLOT, target, items, layout, builtins, []),
    [target, items, layout, builtins],
  );

  if (entries.length === 0) return null;

  const iconFor = (entry: (typeof entries)[number]): IconComponent | null => {
    if (entry.kind === "builtin") return entry.meta.icon;
    if (entry.kind === "custom") {
      return entry.item.icon ? CUSTOM_ICONS[entry.item.icon] : DEFAULT_ACTION_ICON[entry.item.action.type];
    }
    return null;
  };

  return (
    <div
      data-cds="PaneTabSwitcher"
      role="tablist"
      aria-label={t("layout.paneTabSwitcher")}
      /* 横向滚动而不是换行：tile 并排时只有半宽，换行会把标题行撑成两层。
       *
       * 【UI 重建 2026-10-28】滚动条隐藏（Claude 的 pane 标题行也不显示）。
       *
       * ⚠️ **「只隐藏滚动条」本身是个缺陷的温床**：内容溢出时裁切毫无提示。
       * 那件事在本组件上真的发生过 —— `ddb0ff28a` 之前 13 个页签全带文字
       * （约 866px），窄格下 `侧聊` 只剩一个「侧」字、`扩展` / `画布` 整个
       * 看不到。**那一版已经不是现状**：现在只有选中项画文字，13 个约 260px，
       * 常规宽度排得开（这条由 `pane-tab-switcher-smoke` 的宽度账断言守）。
       *
       * `.pane-tab-scroll` 是**兜底**：真到了要滚的宽度（更窄的格、将来又加
       * 页签），两端各一条 28px 渐隐带由 `animation-timeline: scroll()` 驱动
       * **纯 CSS** 地随滚动位置出现/消失 —— 让「右边还有」看得见，而不是
       * 对着切掉半个字的按钮。
       *
       * 所以这一层服务的场景是「已经排不开了」，不是「常态」。
       * 别拿它当「排不开也没关系」的许可 —— 常态排不开仍然要修布局本身。 */
      className="pane-tab-scroll flex min-w-0 flex-1 items-center gap-0.5"
    >
      {entries.map((entry) => {
        const selected =
          entry.kind === "custom"
            ? activeCustomId === entry.item.id
            : entry.kind === "builtin"
              ? activeCustomId === null && activeTab === entry.meta.id
              : false;

        const label =
          entry.kind === "builtin"
            ? t(entry.meta.labelKey)
            : entry.kind === "custom"
              ? customUiLabel(entry.item.label, locale === "en" ? "en" : "zh")
              : entry.entry.label;

        const Icon = iconFor(entry);

        const onSelect = () => {
          if (entry.kind === "builtin") entry.runtime.run();
          else if (entry.kind === "custom") {
            setActiveCustomTab(entry.item.id);
            if (!rightOpen) setRightOpen(true);
          } else entry.entry.run();
        };

        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={selected}
            data-pane-tab={entry.key}
            data-active={selected ? "" : undefined}
            /* 名字只在 tooltip 与无障碍树里 —— 见下面 `hideLabel` 的注释。 */
            title={label}
            aria-label={label}
            onClick={onSelect}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-[6px]",
              /* 【UI 重建 2026-10-28】**只有选中的那个带文字，其余是纯图标。**
               *
               * 实测宽度账：13 个页签全带文字约 **866px**，而右栏默认只占一半
               * （≈700px），标题行还要放放大/换边/关闭三个按钮 —— 于是后 5 个
               * （`turns` / `flow` / `tasks` / `taskcenter` / `preview`）被横向
               * 滚动条推到看不见的地方。
               *
               * 这个代价对「扩展找不到」这条诉求是致命的：`extensions` 排第 7，
               * 恰好卡在可见区边缘 —— 用户装完扩展，大概率还是点不到。
               *
               * 保持图标常驻 + 只给选中项展开文字后，13 个约 **260px**，任何
               * 宽度下都排得开；当前在哪一格仍然一眼可辨（图标 + 高亮底），
               * 其余靠 hover 提示与 `aria-label` 给出全名。
               *
               * 与 Claude 的 pane 标题行同一个取舍：那一排也是图标为主。 */
              selected ? "px-1.5" : "px-1",
              "text-[length:var(--m-fs-caption)] transition-colors",
              selected
                ? "bg-[var(--m-fill-ghost-selected)] text-[var(--m-text-primary)]"
                : "text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]",
            )}
          >
            {Icon ? (
              <Icon size={13} className="shrink-0" />
            ) : (
              /* 没有图标的自定义项：用首字代替，否则整格是空的（只剩 padding）。 */
              <span aria-hidden className="shrink-0 text-[10px] font-medium leading-none">
                {label.slice(0, 1)}
              </span>
            )}
            {selected && <span className="max-w-[7rem] truncate">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 当前选中的**自定义页签**的内容。不是自定义页签时返回 `null`。
 *
 * 与 `PaneTabSwitcher` 是同一件事的两半（选得中 + 看得见）。由
 * `ClaudeShellMount` 的 `renderTile` 在调 `renderPaneContent` 之前先问它一次。
 *
 * ⚠️ **`action.type === "panel"` 也走这里** —— 旧 `RightPanel` 分了两支
 * （缓存面板 vs 一次性视图），但两者的内容都由 `CustomTabView` 画，
 * 区别只在生命周期。新外壳的 tile 本来就常驻挂载，所以统一走常驻那一支：
 * 少一支 = 少一条「这个类型忘了接」的静默空壳。
 */
export function PaneCustomContent({ customId }: { customId: string }): React.ReactNode {
  const items = useCustomUiStore((s) => s.config.items);
  const target = useWorkspaceTarget();
  const item = items.find((i) => i.id === customId && i.slot === SLOT);
  if (!item) return null;
  return <CustomTabView item={item} target={target} />;
}
