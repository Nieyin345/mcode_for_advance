/**
 * 工作流在界面上的名字 / 说明 / 图标 —— **整个渲染端只有这一份**。
 *
 * ## 内置的名字为什么走 i18n,而自建的不用
 *
 * 内置那六个在数据里**也有** `name`(`main/orchestration/builtins.ts` 里写着中文),
 * 但那是**兜底与日志用**的:界面上显示的名字必须跟着界面语言走 —— 英文界面下冒出
 * 「文献检索」是坏的。所以内置的名字与说明从词条里取(`composer.mode.*`,与输入框
 * 那个选择器同一组键);用户自建的工作流用自己起的 `name`,用户起的名字不该被翻译。
 *
 * ## 为什么单独一个文件
 *
 * 这份映射原先只长在 `WorkflowDropdown.tsx` 里。设置 → 工作流(工作流库 + 编辑器)
 * 要显示同一批名字,再抄一份就是两处状态,而它们漂移起来**不报错**:键名改了只会把
 * `composer.mode.search` 这串原文显示给用户。与 `templateLabels.ts` /
 * `libraryLabels.ts` 同一个处置,这里只是把三样(名字 / 说明 / 图标)一次收齐 ——
 * 图标也一起搬,是因为加第七个内置工作流时漏改一处同样只会静默显示成通用图标。
 *
 * 显式映射而不是模板字面量 `` `composer.mode.${id}` ``:那样要靠模板字面量类型去凑
 * `MessageId` 联合,键名改了同样不报错(与 `contentTag` 里同一个坑)。
 */
import type { ComponentType, ReactNode } from "react";
import type { Locale } from "@contracts/ipc";
import { BUILTIN_WORKFLOW_IDS, type BuiltinWorkflowId } from "@contracts/runtime";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import {
  IconBook,
  IconClipboardText,
  IconCode,
  IconDownload,
  IconEye,
  IconFileText,
  IconMessage,
  IconPencil,
  IconWorldSearch,
  type TablerIconProps,
} from "@renderer/lib/icons.js";

/** 列表项 / 标题上显示的名字。键与输入框那个选择器同源。 */
export const BUILTIN_WORKFLOW_LABEL: Record<BuiltinWorkflowId, MessageId> = {
  default: "composer.mode.default",
  search: "composer.mode.search",
  read: "composer.mode.read",
  write: "composer.mode.write",
  review: "composer.mode.review",
  code: "composer.mode.code",
};

/** 一句话说明。选择器与工作流库都用它 —— 同一份文案,不另写一套短的。 */
export const BUILTIN_WORKFLOW_HINT: Record<BuiltinWorkflowId, MessageId> = {
  default: "composer.mode.defaultHint",
  search: "composer.mode.searchHint",
  read: "composer.mode.readHint",
  write: "composer.mode.writeHint",
  review: "composer.mode.reviewHint",
  code: "composer.mode.codeHint",
};

/** id 是不是内置六个之一。收 `string` 而不是那个联合类型 —— 调用方手上是
 *  `WorkflowListEntry` / `WorkflowDoc`,它们的 id 是开放字符串(用户自建的 `wf_`)。 */
export function isBuiltinWorkflowId(id: string): id is BuiltinWorkflowId {
  return (BUILTIN_WORKFLOW_IDS as readonly string[]).includes(id);
}

/** 界面语言下的名字:内置的查词条,自建的用作者写的 `name`。 */
export function workflowDisplayName(w: { id: string; name: string }, locale: Locale): string {
  const entry = NON_MODE_WORKFLOWS[w.id];
  if (entry) return translate(locale, entry.label);
  return isBuiltinWorkflowId(w.id)
    ? translate(locale, BUILTIN_WORKFLOW_LABEL[w.id])
    : w.name;
}

/** 界面语言下的一句话说明。内置的用词条里的提示(与选择器同源),自建的用作者写的
 *  `description` —— 那份是中文兜底值,但自建工作流的作者就是用户自己,显示原文才对。 */
export function workflowDisplayDescription(
  w: { id: string; description?: string },
  locale: Locale,
): string {
  const entry = NON_MODE_WORKFLOWS[w.id];
  if (entry) return translate(locale, entry.hint);
  if (isBuiltinWorkflowId(w.id)) return translate(locale, BUILTIN_WORKFLOW_HINT[w.id]);
  return w.description ?? "";
}

/** 图标表。**写成 `Record` 而不是 `switch`**:加第七个内置工作流时,漏配一个图标
 *  在 `Record<BuiltinWorkflowId, …>` 上是编译错误;`switch` 的 `default` 会把它
 *  悄悄吞成通用气泡,和标签表漏配一样无声。 */
const BUILTIN_WORKFLOW_ICON: Record<BuiltinWorkflowId, ComponentType<TablerIconProps>> = {
  default: IconMessage,
  search: IconWorldSearch,
  read: IconBook,
  write: IconPencil,
  review: IconClipboardText,
  code: IconCode,
};

/* ── 守望与两条自动化(内置,但**不**在 BUILTIN_WORKFLOW_IDS 六个模式里)──
 *
 * 它们都有触发器,进不得模式选择器(见 WorkflowDropdown 的过滤),所以 id 不进那个
 * 联合类型 —— 上面三张表也就收不下,得单独走一遍。id 与 `main/orchestration/builtins.ts`
 * 的常量按字面量对齐(main 代码渲染端 import 不进来);名字与说明的键与六个模式同源
 * (composer.mode.*)。
 *
 * ⚠️ **加一条内置自动化,只改这一张表。** 名字 / 说明 / 图标三样收在一起,就是为了
 * 别再散成三处 —— 漏了大不了退回数据里那份中文 `name`,界面不会报错,英文语言下
 * 冒出「文献自动下载」只能靠人眼发现。
 */
const NON_MODE_WORKFLOWS: Record<
  string,
  { label: MessageId; hint: MessageId; icon: ComponentType<TablerIconProps> }
> = {
  "memory-capture": { label: "memory.flow.capture", hint: "memory.flow.captureHint", icon: IconClipboardText },
  "memory-checkpoint": { label: "memory.flow.checkpoint", hint: "memory.flow.checkpointHint", icon: IconClipboardText },
  "memory-health": { label: "memory.flow.health", hint: "memory.flow.healthHint", icon: IconClipboardText },

  watch: {
    label: "composer.mode.watch",
    hint: "composer.mode.watchHint",
    icon: IconEye,
  },
  wf_auto_download: {
    label: "composer.mode.autoDownload",
    hint: "composer.mode.autoDownloadHint",
    icon: IconDownload,
  },
  wf_auto_convert: {
    label: "composer.mode.autoConvert",
    hint: "composer.mode.autoConvertHint",
    icon: IconFileText,
  },
};

/** 图标:内置六个各有各的,这张表里的三个各有各的,其余(用户自建)用通用图标。 */
export function workflowIcon(id: string, size: number): ReactNode {
  const Icon =
    NON_MODE_WORKFLOWS[id]?.icon ??
    (isBuiltinWorkflowId(id) ? BUILTIN_WORKFLOW_ICON[id] : IconMessage);
  return <Icon size={size} />;
}
