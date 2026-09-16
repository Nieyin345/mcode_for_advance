/**
 * 左栏的**共享原语** —— 「文档」与「模版」两段是同一套东西的两种配置。
 *
 * ## 为什么要有这一层
 *
 * 用户对模版段的要求从一开始就是「和文档一样的样式,一样的功能」,后来说得更准:
 * 「模版和文档是同级别的,只不过给 ai 的提示词不一样,只有这个区别」,再后来又追加
 * 「你的代码架构要符合工程,要有逻辑,不能搞成屎山代码」。
 *
 * 照着抄一遍确实能"一样",但**两份会各自漂移** —— 改了一边的观感或手感,另一边不会
 * 跟着动,而它们必须长得一样、点起来也一样。所以把两段共用的部分收到这里:
 *
 *   表头 / 标签排 / 行(分组行与叶子行)/ 缩进列表 / 行内输入 / 提示行 / 右键菜单壳
 *
 * 两段各自只留**真正不同的部分**:数据从哪来、点了做什么、右键有哪些项、图标是什么。
 * 判断标准很简单:凡是"两边都得一字不差"的东西写在这里,凡是"两边本来就不同"的东西
 * 留在各自的组件里。
 *
 * ## 类名是从 `LibrarySection` 原样搬过来的
 *
 * 一个字都没改 —— 那套观感(选中只提亮文字、底色留给悬停、展开缩进用左边一条细线、
 * 悬停才出现行内按钮)是用户一条条调出来的,搬过来的时候顺手"优化"等于把那些决定
 * 重做一遍。所以这个文件里看到的每个类名,都能在改动前的 `LibrarySection` 里找到出处。
 */
import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconChevronRight } from "@renderer/lib/icons.js";
import type { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";

/* ─────────────────────────── 表头 ─────────────────────────── */

/** 段落标题 —— 与「项目」段的表头同款(小号、大写、字幕色)。 */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="group mb-1 flex items-center justify-between px-1">
      <h3 className="font-semibold uppercase tracking-wide text-content-subtle [font-size:var(--rp-fs-md)]">
        {title}
      </h3>
      {action}
    </div>
  );
}

/**
 * 表头右侧的按钮(目前只有「+」)。
 *
 * **常显**,不像项目段那样"悬停才出现":这两段表头的右侧只有这一个按钮,一隐藏就
 * 整块看不见 —— 用户报过的正是「没有新建 collection 了」。
 */
export function HeaderAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center rounded px-1 py-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent"
    >
      {children}
    </button>
  );
}

/* ────────────────────────── 标签排 ────────────────────────── */

export interface SectionTab<K extends string> {
  key: K;
  label: string;
  /** 条数。0 / 不给就不显示。 */
  count?: number;
}

/**
 * 一排类目标签(文献 / 教材 / 笔记,或 PPT / LaTeX / Word / 代码 / 图片 / 回收站)。
 *
 * `flex-wrap` 不能省:那边三个塞得下,这边六个不一定 —— 窄侧栏下挤成一条会很难点。
 */
export function SectionTabs<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<SectionTab<K>>;
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-0.5 px-1">
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors [font-size:var(--rp-fs-md)]",
              on
                ? "bg-surface-hover font-medium text-content"
                : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            {tab.label}
            {tab.count ? <span className="tabular-nums opacity-60">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── 行 ─────────────────────────── */

/**
 * 一行。**两种形态由 props 决定**,而不是两个组件:
 *
 *   - 给了 `onToggleExpand` 或 `actions` → 分组行(div 里放"箭头 + 名字按钮 + 悬停
 *     操作"),箭头与名字可以各点各的;
 *   - 都没有 → 叶子行,整行就是一个按钮 —— 点击区域最大,选中铺底也最完整。
 *
 * `active` 的两种强度也来自既有的讲究:
 *   - `"accent"` —— 只把文字/图标提亮成强调色,**底色留给悬停**(分类行)。早先选中
 *     就铺底,而且它不会消失,看起来像一块甩不掉的深色块(用户原话:"阴影加重,鼠标
 *     移走应该消失"),才改成这样。
 *   - `"fill"` —— 直接铺底色(文献行 / 「全部」行),它们的选中条件很窄,不会常亮。
 */
export function SidebarRow({
  icon,
  label,
  title,
  active = false,
  expanded,
  onToggleExpand,
  expandDisabled = false,
  expandTitle,
  collapseTitle,
  onClick,
  onContextMenu,
  actions,
}: {
  /** 行首的小图标 —— 用户明确要求「每个都要有图标」。 */
  icon: ReactNode;
  label: string;
  /** 悬停提示。通常带更多信息(完整标题 / 条数)。 */
  title?: string;
  active?: "accent" | "fill" | false;
  /** 折叠态。给了才画箭头(与 `onToggleExpand` 配套)。 */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 没有子项时把箭头画成不可点(半透明),而不是让它消失 —— 行高不跳。 */
  expandDisabled?: boolean;
  /** 箭头的悬停提示。由调用方传(这一层没有 i18n)。 */
  expandTitle?: string;
  collapseTitle?: string;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 悬停才出现的行内按钮。 */
  actions?: ReactNode;
}) {
  const rowBase =
    "group flex items-center gap-1 rounded px-1 py-1 [font-size:var(--right-panel-font-size)]";
  const tone =
    active === "fill"
      ? "bg-surface-hover text-content"
      : active === "accent"
        ? "text-accent hover:bg-surface-hover/60"
        : "text-content-muted hover:bg-surface-hover/60";

  // 叶子行:整行一个按钮
  if (!onToggleExpand && !actions) {
    return (
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={title ?? label}
        className={cn(rowBase, tone, "w-full min-w-0 text-left transition-colors")}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    );
  }

  return (
    <div onContextMenu={onContextMenu} className={cn(rowBase, tone)}>
      {/* 折叠箭头 —— 与 ProjectNode 的同宽同款(w-3 槽 + 10px chevron + rotate-90) */}
      {onToggleExpand && (
        <button
          onClick={onToggleExpand}
          disabled={expandDisabled}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle disabled:opacity-30"
          title={expanded ? collapseTitle : expandTitle}
        >
          <IconChevronRight
            size={10}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>
      )}
      <button
        onClick={onClick}
        title={title ?? label}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {actions && (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{actions}</span>
      )}
    </div>
  );
}

/** 悬停才出现的行内小按钮(重命名 / 删除 / 挂到对话…)。 */
export function RowAction({
  title,
  onClick,
  danger = false,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "rounded p-0.5 text-content-subtle hover:bg-surface",
        danger ? "hover:text-red-500" : "hover:text-content",
      )}
    >
      {children}
    </button>
  );
}

/* ───────────────────────── 列表容器 ───────────────────────── */

/**
 * 行列表。
 *
 * `nested` 是"展开后的子层":缩进 + 左边一条细线。那条线是**层级**的记号 ——
 * 所以会话流模式里不画它(流模式里没有层级),只保留缩进。
 */
export function SidebarList({
  nested = false,
  border = true,
  children,
}: {
  nested?: boolean;
  /** 子层是否画左边那条层级线。 */
  border?: boolean;
  children: ReactNode;
}) {
  if (!nested) return <ul className="space-y-0.5">{children}</ul>;
  return (
    <ul className={cn("ml-3 mt-0.5 space-y-0.5 pl-2", border && "border-l border-edge/50")}>
      {children}
    </ul>
  );
}

/* ──────────────────── 行内输入 / 提示行 ──────────────────── */

/**
 * 行内输入行 —— 新建与改名共用(与分类行那一套手感一致)。
 *
 * `children` 挂在输入框下面:模版段的新建要在名字下面再放两个"选文件 / 选文件夹"
 * 的按钮,那是它独有的,不该塞进这一层。
 *
 * `onBlur` 可选,因为两种语义都真实存在:文献库那边的改名/新建是**失焦即提交**
 * (用户点开一个会话、点别处,意图就是"我就改这一个名字"),而模版的新建不能这样
 * ——失焦时去弹一个选文件的对话框,那是用户没按过的按钮。
 */
export function InlineInputRow({
  value,
  onChange,
  onSubmit,
  onCancel,
  onBlur,
  placeholder,
  error,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** 失焦时也要提交的动作。不给就是"只有回车/离开才提交"。 */
  onBlur?: () => void;
  placeholder?: string;
  /** 红字提示(重名之类)。它会同时把输入框描红。 */
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <li className="px-1 py-0.5">
      <div className="flex items-center gap-1 pl-4">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            if (e.key === "Escape") onCancel();
          }}
          {...(onBlur ? { onBlur } : {})}
          placeholder={placeholder}
          className={cn(
            "w-full rounded border bg-surface px-2 py-1 text-xs text-content focus:outline-none",
            error ? "border-red-500" : "border-accent",
          )}
        />
      </div>
      {children}
      {error && <div className="pl-4 pt-0.5 text-[0.7143em] text-red-500">{error}</div>}
    </li>
  );
}

/**
 * 一行提示(加载中 / 空 / 读不到)。
 *
 * 三态必须分开说:**「还没拉回来」与「拉回来是空的」在界面上长得一模一样**,而后者
 * 还能自己解决(去建一个)。读失败更要单独说 —— 显示成"空的"会让用户以为东西没了。
 */
export function HintRow({ children }: { children: ReactNode }) {
  return (
    <li className="px-2 py-1 text-content-subtle [font-size:var(--rp-fs-md)]">{children}</li>
  );
}

/* ────────────────────────── 右键菜单 ────────────────────────── */

/** 菜单项的统一样式。四处(文献行 / 分类行 / 模版行 / 模版文件行)共用。 */
export const MENU_ITEM_CLASS = cn(
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
  "text-content-muted data-[highlighted]:bg-surface-muted",
);

/**
 * 右键菜单的外壳:光标锚点 + 定位 + 出入场动画 + 宽度。
 *
 * **光标锚点**(`useCursorAnchor`)必须由调用方给 —— 它要在菜单关闭的动画期间把最后
 * 一个坐标冻住,而那需要知道"上一次的目标是什么"。
 */
export function SidebarMenu({
  open,
  anchor,
  onClose,
  minWidth = 200,
  children,
}: {
  open: boolean;
  anchor: ReturnType<typeof useCursorAnchor>;
  onClose: () => void;
  /** 最小宽度。左边栏的菜单窄一点,设置页的可以宽一点。 */
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" className="z-50">
          <Menu.Popup
            style={{ minWidth }}
            className={cn(
              "origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** 菜单项。`danger` 是红色悬停(删除类);`disabled` 时不响应点击并变淡。 */
export function MenuAction({
  icon,
  onClick,
  danger = false,
  disabled = false,
  closeOnClick = true,
  onClose,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 需要把菜单留着的项(比如"推进到第二步")传 false。 */
  closeOnClick?: boolean;
  /** `closeOnClick` 时由外壳收菜单。 */
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      onClick={() => {
        if (disabled) return;
        onClick();
        if (closeOnClick) onClose();
      }}
      disabled={disabled}
      className={cn(
        MENU_ITEM_CLASS,
        danger && "hover:text-red-500",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Menu.Item>
  );
}

/** 菜单分组之间的横线。 */
export function MenuDivider() {
  return <div className="my-1 border-t border-edge/60" />;
}
