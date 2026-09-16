/**
 * 钩子设置页的**视图模型**:事件怎么念、新钩子长什么样、草稿算不算改过。
 * 全是纯函数 —— 不 import React、不碰 `api`、不读 i18n(`workflowView.ts` 同一条)。
 *
 * 拎出来的理由也一样:这几条都是有分支的规则,埋在组件里就只剩"点一下看看"这一种
 * 验证方式。这里没有测试框架,`scripts/workflow-view-smoke` 那种无头脚本是它实际在用
 * 的验证方式。
 */
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  hookSubjectOf,
  type HookEvent,
  type HookSpec,
} from "@contracts/hook";

/** 生成一个钩子 id(`h_` 前缀 + 时间戳 + 随机)。图内唯一即可。 */
export function makeHookId(): string {
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 一条**还没存**的新钩子。
 *
 * 三个默认值是刻意的:
 *  - **`enabled: false`**。新建出来就是打开状态的话,用户还没写命令就先点了一下"保存",
 *    这条钩子会立刻在所有事件上跑起来。默认关着,让他先试跑、再打开。
 *  - **事件是 `tool.use`** —— 最常用的那一个(想在某个工具跑的时候做点什么)。
 *  - **命令是空串**。它在契约里是非法的(`command` 有 `min(1)`),所以这条草稿**存不
 *    下去**,界面上「保存」按钮要一直禁用着,直到用户写了命令 —— 这是有意的:与其让
 *    一条空命令存进文件、在每次事件上安静地失败,不如让它在界面上就看不出来是"没写完"。
 */
export function newHookDraft(): HookSpec {
  return {
    id: makeHookId(),
    name: "",
    event: "tool.use",
    command: "",
    enabled: false,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  };
}

/** 这条草稿能不能存 —— 名称和命令都填了。 */
export function hookDraftProblem(draft: HookSpec): string | null {
  if (draft.name.trim().length === 0) return "name";
  if (draft.command.trim().length === 0) return "command";
  return null;
}

/**
 * 草稿和磁盘上那一份是不是同一份内容。
 *
 * **比较的是内容而不是引用**:用户在输入框里改一个字再改回来,不该还显示着"未保存" ——
 * 那会让人以为有个改动在等着,而实际上没有。
 *
 * `matcher` 只在**有主语的事件**上参与比较:一条 `turn.done` 的钩子上残留的匹配规则
 * 不会被执行(见 `validateHook`),拿它来判"改过没有"会让用户改不动一个无关紧要的字段。
 */
export function isHookDirty(draft: HookSpec, saved: HookSpec | undefined): boolean {
  if (!saved) return true; // 新钩子:没存过就是"还没落盘"
  const matcherOf = (hook: HookSpec): string =>
    hookSubjectOf(hook.event) === null ? "" : (hook.matcher ?? "").trim();
  const sameMatcher = matcherOf(draft) === matcherOf(saved);
  return (
    draft.name !== saved.name ||
    draft.event !== saved.event ||
    draft.command !== saved.command ||
    draft.enabled !== saved.enabled ||
    (draft.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS) !== (saved.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS) ||
    !sameMatcher
  );
}

/** 一次执行的时间戳怎么显示 —— 只到秒,钩子的记录不需要毫秒。 */
export function formatRunTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
