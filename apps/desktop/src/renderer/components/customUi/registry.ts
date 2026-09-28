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
import type { CustomUiIcon, CustomUiSlot } from "@contracts/customUi";
import type { MessageId } from "@renderer/lib/i18n/index.js";
import {
  IconBolt,
  IconBook,
  IconCode,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconFileText,
  IconFlask,
  IconInfoCircle,
  IconLink,
  IconMessage,
  IconQuote,
  IconRobot,
  IconSparkles,
  IconStar,
  IconTag,
  IconTemplate,
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
    { id: "info", labelKey: "library.info.title", icon: IconInfoCircle },
    { id: "adoptMarkdown", labelKey: "library.convert.adopt", icon: IconFileText },
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
};

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
};

/** 没选图标时按动作给一个。 */
export const DEFAULT_ACTION_ICON: Record<"view" | "prompt" | "copy" | "automation", IconComponent> = {
  view: IconEye,
  prompt: IconMessage,
  copy: IconCopy,
  automation: IconBolt,
};
