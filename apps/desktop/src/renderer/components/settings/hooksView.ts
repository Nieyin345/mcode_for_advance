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

/** 哪个引擎。与 `lib/engineFilter.ts` 的 `MatrixEngine` 同一套取值(那边管技能矩阵)。 */
export type HookEngineId = "claude" | "pi" | "codex";

/**
 * **哪些事件,哪个引擎根本不发。**
 *
 * ## 为什么需要这样一张表
 *
 * 面板把 `HOOK_EVENTS` 整个列出来,而钩子是**宿主侧**的东西 —— 它对三个引擎的会话都
 * 生效。可是有些事件只有部分引擎会发:Pi 没有待办清单,也不报子代理,`todo.update` /
 * `subagent.update` 在它那儿一次都不会出现。
 *
 * 不知道这件事的人给 Pi 挂一条"待办更新时",命令写好了、保存成功、界面上一应俱全,
 * **它永远不会响** —— 而且没有任何地方告诉他。这属于"坏东西不报出来"那一类。
 *
 * 不删选项(那也是一种错:换个引擎它是能用的),而是**如实标出来**。
 *
 * ## 这张表怎么核出来的 / 为什么它不算在契约里
 *
 * 按三个 provider 目录里**真实的发出点**(`ctx.emit({ type: "…" })`)数出来的,不是
 * 猜的 —— `scripts/hooks-smoke` 现在会扫那三个目录跟这张表对账,所以它抄不动。
 *
 * 不放进 `@contracts/hook`:那份契约讲的是"钩子事件是什么、载荷长什么样",对三个引擎
 * 都成立;而"哪个引擎实现得了"是**主进程实现的现状**,会随引擎升级变。放契约里会让
 * 一份讲语义的文件背上"某家 SDK 今天做了什么"这种会过期的事实。
 *
 * ⚠️ **宿主侧发的事件不在表里** —— 用户消息、审批/提问/计划那几条、工作流节点结果、
 * 资料库入库/下载,都是主进程按会话统一发的,三个引擎走同一份代码,没有差别。
 *
 * ⚠️ **`upstream.issue` 在表里,理由不直观**:宿主侧也有一个它的发出点,但那一个住在
 * `RuntimeManager` 的**自定义模型桥接**分支里 —— 只有 claude 会话会走到那里(Pi /
 * Codex 自管模型清单,`supportsCustomEndpoint: false`,拿不到 `customModelId`)。
 */
export const HOOK_EVENT_UNSUPPORTED_BY: Partial<Record<HookEvent, readonly HookEngineId[]>> = {
  // Pi 没有待办清单这个东西(它的 adapter 里连 `todo` 这个词都没有)。
  "todo.update": ["pi"],
  // Pi 不报子代理名册。宿主那次"重放"也救不了:名册本身就来自这个事件。
  "subagent.update": ["pi"],
  // "一轮没跑完"是 claude 那套截断检测的产物(工具没回结果 / 末段文本像被切断)。
  // Codex 与 Pi 各自的 adapter 没有这一步。
  "turn.incomplete": ["pi", "codex"],
  // 上下文压缩:codex 的 adapter 明确把 `context_compaction` 丢掉。
  "compact.result": ["codex"],
  // 上游重试提示:见上面那条 ⚠️(只有 claude 走自定义模型桥接那条路)。
  "upstream.issue": ["pi", "codex"],
};

/** 引擎名(专有名词,两个语言都不译 —— 与 `RuntimesPanel` 的 `AGENT_META` 同款)。 */
export const HOOK_ENGINE_LABEL: Record<HookEngineId, string> = {
  claude: "Claude",
  pi: "Pi",
  codex: "Codex",
};

/** 这个事件**哪些引擎根本不会发**。空数组 = 三个引擎都会发。 */
export function hookEventUnsupportedBy(event: HookEvent): HookEngineId[] {
  return [...(HOOK_EVENT_UNSUPPORTED_BY[event] ?? [])];
}

/** 一次执行的时间戳怎么显示 —— 只到秒,钩子的记录不需要毫秒。 */
export function formatRunTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
