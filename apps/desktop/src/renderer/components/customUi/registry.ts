/**
 * 自定义 UI 的**内置项注册表** —— 每个挂载位上有哪些软件自带的功能项、叫什么、用什么图标。
 *
 * 这里只有元数据;点了做什么由挂载它的那个菜单传进来(`BuiltinRuntime`):「文献信息」
 * 要开的浮层、「采纳 MD」要走的那段流程都长在 `LibrarySection` 里,注册表不该知道。
 *
 * 数组顺序 = **默认顺序**(用户没排过时菜单里的先后)。新增一个内置项:往这里加一行,
 * 再在对应菜单里给它一个 `BuiltinRuntime` —— 没给 runtime 的内置项不显示(比如「采纳 MD」
 * 在没有文件的条目上)。
 *
 * **管理项不进这里**(重命名 / 移动复制 / 移除删除 / 打开文件夹 / 新建分类 / 新建笔记):
 * 那些是固定的,用户定的规矩。
 */
import type { ComponentType } from "react";
import type { CustomUiActionType, CustomUiIcon, CustomUiSlot } from "@contracts/customUi";
import type { MessageId } from "@renderer/lib/i18n/index.js";
import {
  IconBolt,
  IconBook,
  IconBulb,
  IconCalendar,
  IconChartBar,
  IconCode,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconFileSearch,
  IconFileText,
  IconFlask,
  IconFolder,
  IconGitBranch,
  IconInfoCircle,
  IconLayoutSidebarRightExpand,
  IconLink,
  IconListCheck,
  IconListDetails,
  IconListTree,
  IconMessage,
  IconNotebook,
  IconQuote,
  IconRobot,
  IconSparkles,
  IconStar,
  IconTag,
  IconTemplate,
  IconTerminal2,
  IconWorld,
  type TablerIconProps,
} from "@renderer/lib/icons.js";

export type IconComponent = ComponentType<TablerIconProps>;

export interface BuiltinMeta {
  id: string;
  labelKey: MessageId;
  icon: IconComponent;
}

export const BUILTINS: Record<CustomUiSlot, readonly BuiltinMeta[]> = {
  "library.item": [
    { id: "attachToChat", labelKey: "library.ctx.attachToChat", icon: IconMessage },
    // ★ 2026-09-28 退役(通用 agent 方向,文献是用户需求不是通用需求):
    //   「文献信息」→ 自定义 UI 的「条目信息卡」view 模板(templateDraft.itemInfo);
    //   「采纳 MD」入口 → 能力仍在(library.adoptMarkdown RPC / MCP 工具 / 详情页),
    //   转录本身在自动化;手动兜漏用「手动转录」automation 模板(带 skipWhen 检测)。
    { id: "viewTranscript", labelKey: "library.ctx.viewTranscript", icon: IconFileText },
    { id: "openMdExternal", labelKey: "library.ctx.openMdExternal", icon: IconExternalLink },
    { id: "links", labelKey: "library.links.title", icon: IconLink },
  ],
  "library.collection": [
    { id: "attachToChat", labelKey: "library.ctx.attachToChat", icon: IconMessage },
    { id: "info", labelKey: "library.collection.info", icon: IconInfoCircle },
  ],
  "library.subcategory": [
    { id: "attachToChat", labelKey: "library.ctx.attachToChat", icon: IconMessage },
    { id: "info", labelKey: "library.collection.info", icon: IconInfoCircle },
  ],
  "library.group": [{ id: "attachToChat", labelKey: "library.ctx.attachToChat", icon: IconMessage }],
  "files.context": [
    { id: "addToChat", labelKey: "ide.tree.addToChat", icon: IconMessage },
    { id: "openInBrowser", labelKey: "ide.tree.openInBrowser", icon: IconWorld },
  ],
  // 右栏自带的那排页签。id 就是 `RightPanelTab` 的值(`builtin:files` 这种键也被工具栏的
  // 「切到页签」动作引用)。「宽屏模式」按钮不在这里 —— 它是布局开关,不是页签。
  "rightPanel.tab": [
    { id: "files", labelKey: "layout.tabFiles", icon: IconFolder },
    { id: "git", labelKey: "customUi.builtin.git", icon: IconGitBranch },
    { id: "browser", labelKey: "customUi.builtin.browser", icon: IconWorld },
    { id: "turns", labelKey: "layout.tabTurns", icon: IconListDetails },
    { id: "flow", labelKey: "layout.tabFlow", icon: IconListTree },
    { id: "tasks", labelKey: "layout.tabTasks", icon: IconTerminal2 },
    { id: "preview", labelKey: "layout.tabPreview", icon: IconFileSearch },
  ],
  // 工具栏没有内置按钮:整条都是用户自己摆的。
  toolbar: [],
};

/** 右栏内置页签的 id(与 `RightPanelTab` 的值一一对应)。 */
export const BUILTIN_TAB_IDS = ["files", "git", "browser", "turns", "flow", "tasks", "preview"] as const;
export type BuiltinTabId = (typeof BUILTIN_TAB_IDS)[number];
export function isBuiltinTabId(id: string): id is BuiltinTabId {
  return (BUILTIN_TAB_IDS as readonly string[]).includes(id);
}

export const CUSTOM_ICONS: Record<CustomUiIcon, IconComponent> = {
  sparkles: IconSparkles,
  bolt: IconBolt,
  message: IconMessage,
  "file-text": IconFileText,
  copy: IconCopy,
  book: IconBook,
  robot: IconRobot,
  world: IconWorld,
  code: IconCode,
  quote: IconQuote,
  tag: IconTag,
  star: IconStar,
  flask: IconFlask,
  eye: IconEye,
  template: IconTemplate,
  download: IconDownload,
  "list-check": IconListCheck,
  calendar: IconCalendar,
  chart: IconChartBar,
  folder: IconFolder,
  terminal: IconTerminal2,
  notebook: IconNotebook,
  bulb: IconBulb,
};

/** 没选图标时按动作给一个。 */
export const DEFAULT_ACTION_ICON: Record<CustomUiActionType, IconComponent> = {
  view: IconEye,
  prompt: IconMessage,
  copy: IconCopy,
  automation: IconBolt,
  file: IconFileText,
  openTab: IconLayoutSidebarRightExpand,
};
