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
  IconClipboardText,
  IconDownload,
  IconEye,
  IconFileText,
  IconMessage,
  type TablerIconProps,
} from "@renderer/lib/icons.js";

/** 列表项 / 标题上显示的名字。键与输入框那个选择器同源。
 *  ⚠️ 2026-10-10 可选内容外置后只剩 `default` —— 五个模式不再内置。 */
export const BUILTIN_WORKFLOW_LABEL: Record<BuiltinWorkflowId, MessageId> = {
  default: "composer.mode.default",
};

/** 一句话说明。选择器与工作流库都用它 —— 同一份文案,不另写一套短的。 */
export const BUILTIN_WORKFLOW_HINT: Record<BuiltinWorkflowId, MessageId> = {
  default: "composer.mode.defaultHint",
};

/** id 是不是内置工作流(现在只剩 `default`)。收 `string` 而不是那个联合类型 ——
 *  调用方手上是 `WorkflowListEntry` / `WorkflowDoc`,它们的 id 是开放字符串。 */
export function isBuiltinWorkflowId(id: string): id is BuiltinWorkflowId {
  return (BUILTIN_WORKFLOW_IDS as readonly string[]).includes(id);
}

/** 界面上显示的名字 —— **就是数据里的 `name`**(内置退役,2026-09-26)。
 *
 *  从前自带的查 i18n 词条、切语言跟着变;现在自带内容是播种进表的普通行,名称可改,
 *  改完必须立刻到处生效 —— 词条继续盖在上面的话,用户改名后列表/下拉显示的还是旧
 *  词条,就是"界面在说假话"。代价(用户拍板「可以」):没改过名的自带工作流在英文
 *  界面下也显示数据里的中文名。词条表(`BUILTIN_WORKFLOW_LABEL`)留给
 *  WorkflowDropdown 库读不到时的兜底与图标表用。 */
export function workflowDisplayName(w: { id: string; name: string }, _locale: Locale): string {
  return w.name;
}

/** 界面上显示的一句话说明 —— 同 `workflowDisplayName`:就是数据里的
 *  `description`(没有就空着)。理由同上,不再按 id 查词条。 */
export function workflowDisplayDescription(
  w: { id: string; description?: string },
  _locale: Locale,
): string {
  return w.description ?? "";
}

/** 图标表。**写成 `Record` 而不是 `switch`**:加第七个内置工作流时,漏配一个图标
 *  在 `Record<BuiltinWorkflowId, …>` 上是编译错误;`switch` 的 `default` 会把它
 *  悄悄吞成通用气泡,和标签表漏配一样无声。 */
const BUILTIN_WORKFLOW_ICON: Record<BuiltinWorkflowId, ComponentType<TablerIconProps>> = {
  default: IconMessage,
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
