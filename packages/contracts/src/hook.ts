/**
 * 钩子(Hook):**某件事发生的时候,跑一条你自己的命令**。
 *
 * ## 它和"节点"是两种东西
 *
 * 节点是流程**里面**的一步,由流程图决定什么时候跑;钩子是**外面**挂的一个观察者,
 * 由"发生了什么"决定什么时候跑。所以钩子不属于任何一张图 —— 它对每一次对话、每一个
 * 工作流节点、每一条自动化都生效。
 *
 * ## 由 Mcode 自己跑,而不是交给 CLI
 *
 * Claude Code 有一套原生的 hooks(写在 settings.json 里、由 CLI 自己执行)。这份契约
 * **不用那套机制**,理由有三条,每条都是这个应用的具体情况:
 *
 * 1. **三个提供方**。Claude / Codex / Pi 各有一套自己的事件流,而 Claude 那套原生
 *    hooks 只有 claude-sdk 有。交给 CLI 就等于"换一个模型,你的钩子就没了"。
 * 2. **要看得见**。宿主侧跑,才能记录每一次执行的命令、退出码、输出、耗时 —— 用户
 *    才有地方回答"我的钩子到底跑了没有"。
 * 3. **工作流与自动化也要用**。节点跑在隐藏会话里,它的事件同样经过宿主的事件流;
 *    交给 CLI 的话,钩子只认得"主对话"。
 *
 * 代价是**这一版只能观察,不能拦截**:`tool.use` 发出的时候审批已经过了。阻断要接进
 * 审批那条路(见 `ApprovalBridge`),是下一步的事,不在这里假装已经支持。
 *
 * ## 事件名为什么和 Claude Code 不一样
 *
 * 能对应上的地方,对照关系是:
 *
 * | Mcode | Claude Code | 什么时候 |
 * |---|---|---|
 * | `tool.use` | `PreToolUse` | 模型决定调用一个工具(⚠️ 审批**之后**) |
 * | `tool.result` | `PostToolUse` | 工具返回了 |
 * | — | `Notification` | Mcode 把它拆成了 `approval.request` / `question.ask` |
 * | `turn.done` | `Stop` | 一轮结束 |
 * | `user.message` | `UserPromptSubmit` | 用户发出一条消息 |
 *
 * 名字不照抄,是因为**语义本来就不一样**:Mcode 的这几个事件对三个提供方都成立,
 * 而且 `tool.use` 的时机和 `PreToolUse` 不同。用一个听起来一样、实际差一点的名字,
 * 比用一个新名字更容易让人写错。
 *
 * ## `matcher` 匹配的是什么,由**事件**决定
 *
 * 不是每种事件都拿工具名去比:`turn.files` 比的是**文件路径**。所以匹配的主语是
 * **每个事件自己的属性**(见 {@link hookSubjectOf}),而不是一个全局的"工具名"。
 * 事件的选法只有两种,是因为其余事件的载荷里没有一个"一眼能筛"的维度 —— 与其编一个
 * (比如拿 `error` 的 message 去比)不如不给。
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import type { Session } from "./session.js";

/* ── 事件 ── */

/**
 * 顺序 = 设置页下拉里的顺序 = **一轮的生命周期**:开始 → 中间发生的事 → 结束 → 出岔子。
 * 按生命周期排而不是字母序,是因为选的时候想的是"我要挂在哪一步",不是"它叫什么"。
 */
export const HOOK_EVENTS = [
  /** 用户发出一条消息 —— 一轮的开始。 */
  "user.message",
  /** 模型决定调用一个工具(`matcher` 匹配工具名)。 */
  "tool.use",
  /** 工具返回了(`matcher` 匹配工具名)。 */
  "tool.result",
  /** 有工具在等用户批准(`matcher` 匹配工具名)。 */
  "approval.request",
  /** 审批/提问被回答了 —— 桌面或手机任一端答的都算。 */
  "request.resolved",
  /** agent 向你提了一个问题,在等你回答。 */
  "question.ask",
  /** 模型在计划模式下写好了计划,在等你批准。 */
  "plan.approval_request",
  /** 待办清单变了(每次 TodoWrite 更新都会触发)。 */
  "todo.update",
  /** 子代理名册变了(起一个、状态变、结束都会触发)。 */
  "subagent.update",
  /** 一轮改动了文件(`matcher` 匹配文件路径)。 */
  "turn.files",
  /** 一轮没正常跑完(工具没回结果 / 模型什么都没说)。**与 `error` 不同**:这不是报错。 */
  "turn.incomplete",
  /** 一轮结束了。 */
  "turn.done",
  /** 上下文被压缩了(手动 `/compact` 或自动)。 */
  "compact.result",
  /** 出错了。 */
  "error",
  /** 上游接口在重试、或者重试后恢复了。 */
  "upstream.issue",
  /** 工作流的一个节点跑完了(在**发起那次对话**的会话上触发)。 */
  "workflow.node.result",
  /** 统一资料库:一条条目入库成功(三种导入入口共用;**不属于任何会话**,见
   *  `@contracts/runtime` 的 `LibraryItemImportedEvent`)。 */
  "library.item.imported",
  /** 统一资料库:一条条目的 **PDF 下载完成**(**不属于任何会话**,见
   *  `@contracts/runtime` 的 `LibraryItemDownloadedEvent`)。
   *
   *  它是「导入之后自动做点什么」(转录、抽图、送外部工具)的**唯一正确时机** ——
   *  导入那一下文件还没下下来。 */
  "library.item.downloaded",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const HookEventSchema = z.enum(HOOK_EVENTS);

/* ── 匹配的主语 ── */

/** `matcher` 能匹配的东西。一件事发生的时候,拿什么去比。 */
export const HOOK_SUBJECTS = ["tool", "path"] as const;
export type HookSubject = (typeof HOOK_SUBJECTS)[number];

/**
 * 这个事件的 `matcher` 比的是什么。`null` = 它没有可筛的维度,`matcher` 对它无意义。
 *
 * 只有两种,而且都是**载荷里现成、用户一眼认得出**的维度。不硬凑第三种:一个"能筛但
 * 筛不准"的字段比没有更糟 —— 用户会照着它写,然后钩子安静地不响。
 */
export function hookSubjectOf(event: HookEvent): HookSubject | null {
  switch (event) {
    case "tool.use":
    case "tool.result":
    case "approval.request":
      return "tool";
    // 一轮改了哪几个文件 —— 最常见的钩子需求就是"改了某类文件就跑点什么"。
    case "turn.files":
      return "path";
    default:
      return null;
  }
}

/** 带**工具名**的事件(历史叫法,等价于 `hookSubjectOf(e) === "tool"`)。 */
export const HOOK_TOOL_EVENTS = ["tool.use", "tool.result", "approval.request"] as const;
export function hookEventHasTool(event: HookEvent): boolean {
  return hookSubjectOf(event) === "tool";
}

/* ── 事件的「这是关于哪一条」 ── */

/**
 * 「这件事是关于哪一条」那几项事实的**键名**。
 *
 * 目前只有资料库的两个事件用得上(见 {@link HOOK_EVENT_ITEM_FACT_FIELDS}),但这几个键是
 * **跨模块共用的字面量**:它同时是事件载荷的字段名、是 `TriggerPayload` 的字段名、
 * 也是用户写在指令里的 `{{trigger.itemId}}`。三处各写一遍字符串的话,改一处漏一处
 * 的表现是"指令里那个名字解不出来",而那种失败只在跑的时候才出现。
 */
export const EVENT_ITEM_FACT_KEYS = ["itemId", "itemTitle", "pdfPath", "filePath"] as const;
export type EventItemFactKey = (typeof EVENT_ITEM_FACT_KEYS)[number];

/**
 * **哪些事件带得出"这是关于哪一条"** —— 事件 → 那几项事实**分别躺在事件的哪个字段上**。
 *
 * ## 为什么它得单独存在(而不是塞进 `subjects`)
 *
 * `subjects` 是 `matcher` 拿去比的东西(工具名 / 文件路径),而资料库这两个事件
 * **没有可筛的维度**(见 {@link hookSubjectOf} 返回 null)。把条目 id 塞进 `subjects`
 * 等于凭空造出一个"能筛"的假象:用户照着它写一条匹配规则,`validateHook` 却照样拦下来
 * 说"这个事件没有可比的东西" —— 两处互相打脸。
 *
 * 而「事件发生时」的自动化**真的需要它**。从前载荷里只有一句「发生了
 * 「library.item.downloaded」」,一条「下载完转 Markdown」的自动化于是不知道**是哪一条**
 * 下完了 —— 它只能靠"库里最新的那一条"去猜,一次下载失败、或者两条同时下来,它转的就
 * 是错的那篇,而且**不报错**。
 *
 * ## 为什么表里存的是「键 → 事件字段名」而不是光一串键名
 *
 * ⚠️ **事件里的字段名和事实键名并不总是一样**:事件上叫 `kind` / `title`,而事实键叫
 * `itemKind` / `itemTitle`。差别是**必须**的 —— `{{trigger.kind}}` 已经是"这次触发的
 * 种类"(取值 `"event"`),条目自己的 kind 不加前缀就会和它撞在同一个名字空间里,后写的
 * 静默盖掉先写的。
 *
 * 早先这里只存一串键名、取的时候照着名字去事件上搬,于是 `itemKind` / `itemTitle`
 * **永远搬不到**(事件上根本没有这两个字段)—— 而失败的样子是"载荷里少两行",模型只收到
 * 一个 id,照样能干活,只是干得笨。所以键名和取法现在写在**同一张表**里:少了哪一项、
 * 它从哪来,都在这一行上看得见。
 *
 * `pdfPath` 例外地没带前缀:它就是这一个字段的唯一含义,而事件里那个键也叫这个名字
 * (钩子脚本 `jq .data.pdfPath` 与指令里 `{{trigger.pdfPath}}` 于是对得上)。⚠️ 它是
 * **库内相对路径**,要拿给外部工具用得自己拼库根 —— 绝对路径从 `library_items` 拿。
 */
export const HOOK_EVENT_ITEM_FACT_FIELDS: Partial<
  Record<HookEvent, Partial<Record<EventItemFactKey, string>>>
> = {
  // （itemKind 已随 kind 退役删除 —— 事件上不再有这个字段。）
  "library.item.imported": { itemId: "itemId", itemTitle: "title", pdfPath: "pdfPath", filePath: "filePath" },
  // 下载完的那一条**多一个 `pdfPath`** —— 导入那一下文件还没下来,那时给路径是骗人。
  "library.item.downloaded": { itemId: "itemId", itemTitle: "title", pdfPath: "pdfPath", filePath: "filePath" },
};

/**
 * 这个事件带得出哪几项(顺序照 {@link EVENT_ITEM_FACT_KEYS},稳定)。带不出就是空。
 *
 * 给「插入变量」那张菜单用:菜单列的每一项,这一种触发都得真取得到 ——
 * `expandTriggerVars` 对取不到的 key 是硬失败,列错一项的代价是那一步跑不起来。
 */
// Generic document imports may already have a local file; metadata-only imports
// do not. Preserve those optional facts at runtime, but never promise them in
// the guaranteed interpolation menu (missing trigger variables fail closed).
const OPTIONAL_EVENT_ITEM_FACT_KEYS: Partial<Record<HookEvent, readonly EventItemFactKey[]>> = {
  "library.item.imported": ["pdfPath", "filePath"],
  "library.item.downloaded": ["filePath"],
};
export function eventItemFactKeysOf(event: HookEvent): readonly EventItemFactKey[] {
  const fields = HOOK_EVENT_ITEM_FACT_FIELDS[event];
  if (fields === undefined) return [];
  return EVENT_ITEM_FACT_KEYS.filter((key) => fields[key] !== undefined && !OPTIONAL_EVENT_ITEM_FACT_KEYS[event]?.includes(key));
}

/**
 * 从**运行时事件**里取出「这是关于哪一条」的那几项。取不到就是 `undefined`。
 *
 * 与 {@link HOOK_EVENT_ITEM_FACT_FIELDS} 放在一起,是因为那张表说的是**有哪些键、各自
 * 躺在哪**,这里说的是**照着搬出来** —— 分两个文件的话,给某个事件加了键却忘了在取的
 * 地方补一行,表现是"表上列着、跑起来解不出来",而那种失败只在被触发的那一刻才出现。
 *
 * 空串当没有:下载完成那条事件的 `pdfPath` 是 `item.pdfPath ?? ""`,而"空字符串"当路径
 * 喂给模型等于告诉它"这篇有 PDF,路径是空的"。
 */
export function eventItemFactsOf(e: RuntimeEvent): Partial<Record<EventItemFactKey, string>> | undefined {
  const event = HOOK_EVENT_OF[e.type];
  if (event === null) return undefined;
  const fields = HOOK_EVENT_ITEM_FACT_FIELDS[event];
  if (fields === undefined) return undefined;
  const source = e as unknown as Record<string, unknown>;
  const out: Partial<Record<EventItemFactKey, string>> = {};
  for (const key of EVENT_ITEM_FACT_KEYS) {
    const field = fields[key];
    if (field === undefined) continue;
    const value = source[field];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 每个 `RuntimeEvent` 对应哪个钩子事件;`null` = **故意不暴露**。
 *
 * 写成 `Record<RuntimeEvent["type"], …>` 而不是 `switch` + `default: null`,是为了让
 * "将来加了一个事件,要不要给它一个钩子"变成**编译期**的问题:`RuntimeEvent` 多一个
 * 成员,这张表就少一行,tsc 当场报错。`switch` 做不到 —— 它会安静地把新事件吞掉,而
 * "这个钩子怎么不响"是最难查的一类问题。
 *
 * ## 为什么这张表在 contracts(原来在主进程的 `HookRunner` 里)
 *
 * 多了一个读它的人:**事件触发器**(`mcode.trigger` 的「事件发生时」那一类)。它要问
 * 同一个问题 —— "这个运行时事件,对应用户能听的那个名字是什么"。两个读法各写一份的话,
 * 迟早出现"钩子听得见、触发器听不见"(或者反过来),而那种差别不报错,只是某个功能
 * 安静地不工作。
 */
export const HOOK_EVENT_OF: Record<RuntimeEvent["type"], HookEvent | null> = {
  "user.message": "user.message",
  "tool.use": "tool.use",
  "tool.result": "tool.result",
  "approval.request": "approval.request",
  "request.resolved": "request.resolved",
  "question.ask": "question.ask",
  "plan.approval_request": "plan.approval_request",
  "todo.update": "todo.update",
  "subagent.update": "subagent.update",
  "turn.files": "turn.files",
  "turn.incomplete": "turn.incomplete",
  "turn.done": "turn.done",
  "compact.result": "compact.result",
  error: "error",
  "upstream.issue": "upstream.issue",
  "workflow.node.result": "workflow.node.result",
  // 统一资料库的入库事件。**不属于任何会话**(sessionId 是合成哨兵 "(system)",见
  // `@contracts/runtime`),matcher 对它无意义 —— `hookSubjectOf` 走 default 返回 null。
  // 它存在的主要理由是 automation 的「事件发生时」触发器(文献自动下载那条模板靠它)。
  "library.item.imported": "library.item.imported",
  // 下载完成。同属资料库、同用哨兵 —— 但它是**另一件事**:导入时文件还没下下来,
  // 而对 PDF 本身的处理(转录、抽图)只能在这一刻做。两条都给,是因为确实有
  // 「导入就该干点什么」的用法(建占位笔记、按标题归类),它不需要等 PDF。
  "library.item.downloaded": "library.item.downloaded",

  /* ─ 还没给,不是不该给 ── */

  // 工作流停在岔路口等用户拍板(`runner.kind === "branch"` 的节点)。
  //
  // 这一条**将来会有**,而且大概是"自动化"那个场景下最该通知的一件事(没人看着的
  // 时候,图停在那儿等一个回答,而外面什么迹象都没有)。现在不给是因为给一个钩子
  // 事件要动四处(本文件的 `HOOK_EVENTS`、这张表、`HooksPanel` 的两张标签表、中英各
  // 两条词条),而它属于"自动化"那一摊 —— 放在这次改动里会让这次改动说不清边界。
  //
  // ️ 放在这一段而不是下面那段,是怕后来的人读成"这是刻意不给的"。**它能给**,
  // 只是还没轮到。
  "workflow.node.choice": null,
  "workflow.node.progress": null,
  // 节点**开始排队**的那一刻(G3 事件补齐新加,载荷见 `@contracts/runtime` 的
  // `WorkflowNodeQueuedEvent`)。要挂"这一步跑完了"挂 `workflow.node.result`;排队
  // 只比它早一瞬间,单独给一个钩子只会让同一步触发两次。
  "workflow.node.queued": null,
  // 引擎报上来的斜杠命令清单(见 `@contracts/runtime` 的 `CommandsAvailableEvent`)。
  // 这是**界面元数据** —— "菜单里该列哪些命令",不是对话里发生了什么事。给它一个钩子
  // 的话,用户能用它表达什么意图?想不出来。同一档的还有下面那批"不该给"。
  "commands.available": null,

  /* ── 故意不暴露的(是"不该给",不是"还没来得及给")── */

  // 太频繁:一次对话能来几万条,挂上就是每秒钟起一堆进程。
  "text.delta": null,
  thinking: null,
  "subagent.transcript": null,
  // 本地命令的输出(`/usage`、`/context` 这类不经过模型的命令印出来的那段文本)。
  // 内容是**给用户看的**,不是给钩子看的 —— 想对"用户查了用量"做点什么,那是自动化
  // 场景里很靠后的事,而它有个更合适的挂点(将来真要做,该挂的是"用户发了某条消息",
  // 那是 `user.message`)。
  "local_command.output": null,
  // 给已经画出来的那张步骤卡**补一个花费数字**。它是 `workflow.node.result` 的**后补**
  // (用量要等那个回合结算才有,而卡片是节点收场那一刻就画出来的,见
  // `@contracts/runtime` 的 `WorkflowNodeUsageEvent`)。所以挂钩子这件事它完全搭不上:
  // 要挂的是"这一步跑完了",那一条已经给了 —— 再给一个"后来又知道了它的花费"只会让
  // 同一个节点触发两次,而后一次什么新信息都没有(除了钱)。
  "workflow.node.usage": null,
  // 工作流节点跑的**过程**(工具调用、中间文本),给界面那张卡片看的。
  // 挂钩子的话"这一步做了什么"该走 `workflow.node.result` —— 那是它跑完的那个点,
  // 也是钩子作者真正想接的时刻;过程流本身是一次运行里最吵的东西。
  "workflow.node.transcript": null,
  // 计划草稿在计划模式里每变一次文本就发一次(和 `text.delta` 同级)。要挂就挂
  // `plan.approval_request` —— 那才是"计划写好了"这个有意义的时间点。
  "plan.update": null,
  // 每次 API 调用后都发,纯展示用。
  "token-usage.updated": null,
  // 宿主侧的行内提示卡(预算到顶/模型回退/结构化校验失败),纯 UI 事件。挂钩子没有
  // 意义:预算到顶那条的"回合结束了"时刻走 `turn.done`(reason="interrupted")。
  "turn.notice": null,
  // 渲染层画一张图用的,不是"发生了什么"。
  "browser.image": null,
  // 内部同步信号(客户端之间对齐"哪些会话在跑"),不是事件。
  "session.runningSnapshot": null,
  // 每次改名 / 置顶 / 归档都发,噪音大而钩子做不了什么。
  "session.changed": null,
  // 用户手点的一次回退,而且要紧的信息(哪些文件)在 `turn.files` 里已经有过了。
  "turn.rewound": null,
  // 助手一条消息写完 —— 与 `turn.done` 重叠(多数轮次只有一条消息)。要挂就挂后者。
  "message.complete": null,
  // 纯界面状态(切到计划模式之类)。
  "mode.change": null,
  // 下面两条**没有活着的会话**,而钩子载荷里的 `session` 是必填的:
  // `session.deleted` 的会话已经没了;`git.changed` 压根不属于任何会话(它的
  // `sessionId` 是空串)。硬塞一个空壳会让 `jq .session.id` 拿到 `""`,用户分不清
  // "没有会话"和"会话 id 是空"。要给它们钩子,得先设计"不属于会话的事件"长什么样。
  "session.deleted": null,
  "git.changed": null,
  // 设置 / 项目列表的跨端同步信号 —— 同上,不属于任何会话,纯界面同步。
  "setting.changed": null,
  "projects.changed": null,
};

/* ── 交付策略(deliveryPolicy) ──
 *
 * 今天的 `HookRunner` 只有一条**写死**的策略:同一条钩子同时只跑一个进程,忙时把这一次
 * 记一条 `skipped`。它对"用户盯着的一场对话"够用,但对**无人值守的长期场景**不够 ——
 * 那种场景里"钩子没跑"和"钩子跑失败了"是两件后果完全不同的事,而这个差别今天只体现在
 * 环里那一条记录上,没有一个可以断言、可以计数的契约。
 *
 * 这里把"一条钩子/触发器/能力任务该如何交付"声明成一个**有限集合**里的选择,并把它和
 * "跳过 / 丢 / 合并"的**可观测计数**绑在一起 —— 交付决定不再是"安静地不见了",而是
 * 明写在计数器上的一条事实。 */

/**
 * 四种交付策略。**只有四种**,因为它们各自对应一类**已经存在**的真实诉求,而多一种
 * 就要多解释一遍"它和相邻那种差在哪":
 *
 *  - `BEST_EFFORT` —— 只求"提示一下",**可丢**。桌面 toast / 桌面通知是原型例:
 *    通知慢了一点、丢了一条,没人在乎。**今天所有已有钩子的默认就在这里。**
 *  - `COALESCE` —— 输入**合并**:高频文件变化、高频事件,不必每条都跑,但要跑一次
 *    "把攒着的那几条一起处理"。形成的运行次数是**有界**的(见 {@link decideDelivery})。
 *  - `AT_MOST_ONCE` —— **不可重复**,但允许**明确地丢**。适用于"重复执行有副作用、
 *    但漏一次可以接受"的动作(比如"发一条状态更新")。
 *  - `DURABLE_AT_LEAST_ONCE` —— 需要**持久领取**(重启后待办还在),因此消费者**必须
 *    有幂等键**(否则重复投递会变成重复副作用)。⚠️ **本版尚未实现**:见
 *    {@link decideDelivery} 对它的处置 —— **明确报 unsupported,不假装已经持久化**。
 *
 * ⚠️ **故意没有 `EXACTLY_ONCE`。** 一个"恰好一次"的承诺,在没有一个统一的、可验证的
 * 分布式事务的前提下,**无法在这里被证明**,而写下一个证明不了的保证比不写更坏 ——
 * 它会让人据此省掉幂等键。对不可幂等的外部动作,故障后的正确结论是 **UNCERTAIN**
 * (要求人 / 外部系统核对),不是一个漂亮的"保证恰好一次"。
 */
export const DELIVERY_POLICY_KINDS = [
  "BEST_EFFORT",
  "COALESCE",
  "AT_MOST_ONCE",
  "DURABLE_AT_LEAST_ONCE",
] as const;
export type DeliveryPolicyKind = (typeof DELIVERY_POLICY_KINDS)[number];

/**
 * 一条交付策略的**声明**。除 `kind` 外全可选 —— 省略的字段走 {@link DEFAULT_DELIVERY_POLICY}
 * 的默认值,所以"只声明一个 `kind`"始终是合法的。
 */
export const DeliveryPolicySchema = z.object({
  kind: z.enum(DELIVERY_POLICY_KINDS),
  /**
   * 同一条钩子/触发器**同时在跑的进程数上限**。默认 1(与今天一致)。
   * 超过上限时按 `kind` 决定合并还是丢,而不是无限起进程。
   */
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  /**
   * 输入合并的**窗口**(毫秒)。给 `COALESCE` 用:这段时间内来的事件算一批。
   * 省略 = 0(不额外等,只做"忙时攒一次"的合并)。
   */
  debounceMs: z.number().int().min(0).max(600_000).optional(),
  /** 覆盖 `HookSpec.timeoutMs`。省略就沿用钩子自己那个(或 {@link DEFAULT_HOOK_TIMEOUT_MS})。 */
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  /**
   * 失败后的**总尝试次数**上限(含第一次)。省略 = 1 → **一次就死,不重试**(= 今天的行为)。
   *
   * ⚠️ 语义与 `@contracts/durableEvent` 的 `settleEventEnvelope` 里那个 `retryBudget`
   * **同义**(那边也是「练到 budget 次才落终态」),不是"额外重试几次" —— 两处各解释一遍
   * 迟早分家,而分家的表现是"配了 3 却只跑 1 次/4 次"这种只在计数里才看得出的错。
   *
   * 接线范围(HookRunner):**只有 `failed`(命令退非零)在预算内重试**;`timeout` 是
   * 「我们把它叫停的」,**不**自动重试 —— 重放一个卡住的脚本只会把同一份副作用再放一遍。
   */
  retryBudget: z.number().int().min(0).max(100).optional(),
  /** 输出字节预算。省略 = {@link HOOK_OUTPUT_LIMIT}。 */
  outputLimit: z.number().int().min(256).max(10_000_000).optional(),
  /** 归属的场景 id —— "按 scene 可查询收到了什么、跳过了什么、实际跑了什么"的键。 */
  ownerScene: z.string().max(120).optional(),
});
export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;

/**
 * 省略策略时用的那一条 —— **刻意等于今天的行为**:`BEST_EFFORT` + 并发上限 1,
 * 即"同一条钩子同时只跑一个进程,忙时明确记一条 skipped"。这样"没声明策略的老钩子"
 * 不会因为这次改动而改变行为(ARC-007 的硬要求:旧 Hook 配置兼容)。
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = { kind: "BEST_EFFORT", maxConcurrency: 1 };

/**
 * 一条钩子的**生效**策略:声明的字段盖在默认值上。纯函数,不碰文件系统。
 *
 * `kind` 是必填的(见 schema),所以这里只补那些可选的默认 —— 别的地方读策略一律走这个,
 * 别自己写 `?? 1`(两份默认值迟早分家,而分家的表现是"某一路的并发上限悄悄变成了别的数")。
 */
export function resolveDeliveryPolicy(spec: HookSpec): DeliveryPolicy {
  const declared = spec.deliveryPolicy;
  if (declared === undefined) return { ...DEFAULT_DELIVERY_POLICY };
  return { ...DEFAULT_DELIVERY_POLICY, ...declared };
}

/* ── 交付决定(纯函数) ── */

export type DeliveryAction = "accept" | "coalesce" | "drop" | "unsupported";

export interface DeliveryDecision {
  action: DeliveryAction;
  /** 为什么这么决定 —— 它会进 `HookRun.error`(skipped 那条),也可以只被计数。 */
  reason: string;
}

export interface DeliveryDecisionInput {
  /** 同一条钩子/触发器**当前正在跑**的进程数。 */
  inFlight: number;
  /** 是否**已经攒着**一次"合并后要跑"的待办(只对 `COALESCE` 有意义)。 */
  coalescePending: boolean;
  /**
   * 最近的事件速率(每秒),可选。**只作判据的证据**,不做精确令牌桶 ——
   * 这一版不需要精确限流,需要的是"决定了就说清楚凭什么"。
   */
  eventRatePerSec?: number;
}

/**
 * 【ARC-007】**交付决定** —— 纯函数,可直测。
 *
 * 给定一条**已解析**的策略、当前在跑的进程数、是否已有待合并项,返回
 * `accept`(现在就跑)/ `coalesce`(并入待合并项,不另起进程)/ `drop`(明确丢)/
 * `unsupported`(这个策略本版实现不了)。
 *
 * ## 四种 `kind` 的规则
 *
 *  - `DURABLE_AT_LEAST_ONCE` → **一律 `unsupported`**。本版没有持久领取的账本
 *    (`DurableOperationLedger`),也没有消费方幂等键的位置 —— 假装它"至少一次"了,
 *    出事时用户会以为待办还在,**比不支持更危险**。所以明确报出来。
 *  - `COALESCE` → 已经攒着一次合并、或已到并发上限 → `coalesce`(并入,不另起);
 *    否则 `accept`。合并形成的运行数因此**有界**:每一次"在跑的"最多兑现一次合并。
 *  - `AT_MOST_ONCE` → 到并发上限 → `drop`(不重复,明确丢);否则 `accept`。
 *  - `BEST_EFFORT`(默认)→ 同上 `drop`;但语义上"丢"本就可接受。
 */
export function decideDelivery(
  policy: DeliveryPolicy,
  input: DeliveryDecisionInput,
): DeliveryDecision {
  const cap = policy.maxConcurrency ?? 1;
  // 速率只作**判据的证据**,不做精确令牌桶 —— 有就写进原因,让它可观测,而不是死字段。
  const rate = input.eventRatePerSec !== undefined ? `,最近 ${input.eventRatePerSec}/秒` : "";
  if (policy.kind === "DURABLE_AT_LEAST_ONCE") {
    return {
      action: "unsupported",
      reason:
        "DURABLE_AT_LEAST_ONCE 尚未支持:需要持久领取(DurableOperationLedger)与消费方幂等键,本版不假装已经持久化",
    };
  }
  const busy = input.inFlight >= cap;
  if (policy.kind === "COALESCE") {
    if (input.coalescePending) {
      return { action: "coalesce", reason: `已攒着一次合并,这一条并进去${rate}` };
    }
    if (busy) {
      return {
        action: "coalesce",
        reason: `在跑的已有 ${input.inFlight} 个(上限 ${cap})${rate},攒一次合并后再跑`,
      };
    }
    return { action: "accept", reason: "空闲,立即跑" };
  }
  if (busy) {
    if (policy.kind === "AT_MOST_ONCE") {
      return { action: "drop", reason: `上一条还在跑(并发上限 ${cap})${rate},AT_MOST_ONCE 不重复,明确丢` };
    }
    return { action: "drop", reason: `上一条还在跑(并发上限 ${cap})${rate}` };
  }
  return { action: "accept", reason: "空闲,立即跑" };
}

/* ── 去抖窗口(debounceMs) ── */

/**
 * 【ARC-007】**COALESCE 的去抖窗口**(毫秒)—— 纯函数,可直测。
 *
 * 「忙时攒一次」(零窗口)只在钩子**已经在跑**的时候合并;而一条高频钩子大半时间空闲,
 * 于是连续来的事件会**每条各起一个进程**。`debounceMs` 要解决的正是这一段:窗口内来的
 * 事件算一批,窗口末尾**只兑现一次**(尾去抖 —— 每条新事件把窗口重置,见 HookRunner)。
 *
 * ## 只有 `COALESCE` 有窗口
 *
 * 只有合并语义才谈得上"攒一批"。所以:
 *  - `COALESCE` + 声明 `debounceMs` → 那个数;
 *  - `COALESCE` + 省略 → `0`(**零窗口 = 今天的行为**,只做"忙时攒一次");
 *  - 其余 kind(`BEST_EFFORT` / `AT_MOST_ONCE` / `DURABLE_AT_LEAST_ONCE`)→ 一律 `0`
 *    —— 它们要么"明确丢"、要么本版不支持,没有"攒一批再跑"的位置。**声明了 `debounceMs`
 *    也不该悄悄把它们变成合并**;那会是一条只在计数里才看得出的错。
 *
 * ⚠️ 返回 `0` 与"窗口 0 毫秒"在 HookRunner 里是**同一条路**(即时交付),所以调用方只需判
 * `> 0` 决定要不要起计时器 —— 一个判据,不让 `?? 0` 在两处各写一遍(两份默认迟早分家)。
 */
export function coalesceWindowMs(policy: DeliveryPolicy): number {
  if (policy.kind !== "COALESCE") return 0;
  return policy.debounceMs ?? 0;
}

/* ── 失败重试(retryBudget) ── */

export interface RetryDecision {
  /** 要不要**再试一次**。`false` 时这一条落终态(记下它的真实结果)。 */
  retry: boolean;
  /** 为什么 —— 会进环里那条重试记录(可观测),不静默。 */
  reason: string;
}

/**
 * 【ARC-007】**失败重试决定** —— 纯函数,可直测。
 *
 * ## 语义:总尝试上限(含第一次)
 *
 * `attempts` 是**已经跑过的次数**(第一次失败时 = 1)。`retryBudget` 是**总尝试次数**上限,
 * 与 `@contracts/durableEvent` 的 `settleEventEnvelope` 里那个 `retryBudget` 同义
 * (那边也是「练到 budget 次才落终态」)—— 不是"额外重试几次"。省略 = 1 → 一次就死。
 *
 * ## 只有 `failed` 重试,`timeout` / 起不来不重试
 *
 * 重试的判据是「这条命令**自己**败了(退非零)」—— 那多半是暂时性的(锁、网络、竞态),
 * 再试一次有机会成。而 `timeout`(被我们叫停)与起不来(命令写错)**不是**这个形状:
 *   - 重放一个卡住的脚本,只是把同一份副作用再放一遍、再挂一次 —— 与 ARC-005 对
 *     不可幂等外部动作的纪律同一条(不确定就别盲发第二次);
 *   - 命令不存在,重试到天荒地老也起不来,只是把失败重复 N 次。
 * 所以「这一次是不是 `failed`」由调用方**按状态**判好再传进来(`failed: true`),超时 /
 * 起不来一律传 `false` —— 本函数只认「失败且还在预算内」。
 */
export function decideRetry(input: {
  /** 已经跑过的次数(含刚刚失败的那一次,≥ 1)。 */
  attempts: number;
  /** 声明的总尝试次数上限(含第一次)。省略 = 1。 */
  retryBudget: number | undefined;
  /** 刚刚那一次的终态是不是 `failed`(退非零)。只有它为真才可能重试。 */
  failed: boolean;
}): RetryDecision {
  const budget = input.retryBudget ?? 1;
  // 非 `failed`(超时 / 起不来)、或额度用尽 → 不重试,落终态。
  if (!input.failed) {
    return { retry: false, reason: "非失败终态(超时 / 起不来),不自动重试" };
  }
  if (input.attempts <= 0) {
    // 没跑过却来问重试,是调用方的账错了 —— 不猜,落终态。
    return { retry: false, reason: "没有已跑过的次数记录,不重试" };
  }
  if (input.attempts < budget) {
    return {
      retry: true,
      reason: `失败,还在预算内(第 ${input.attempts} 次 / 上限 ${budget} 次),再试一次`,
    };
  }
  return { retry: false, reason: `失败且已用尽预算(${input.attempts} / ${budget}),落终态` };
}

/* ── 一条钩子 ── */

/** T63: action is an explicit sum type; command remains the legacy input shape. */
export const HookActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("agent"), profileId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("workflow"), workflowId: z.string().min(1).max(200) }),
]);
export type HookAction = z.infer<typeof HookActionSchema>;
export const MAX_HOOK_DEPTH = 3;
/** Reads old in-memory HookSpec values too (plugins and pre-migration callers). */
export function hookActionOf(spec: { action?: HookAction; command?: string }): HookAction {
  return spec.action ?? { kind: "command", command: spec.command ?? "" };
}

export const HookSpecSchema = z.object({
  /** `h_` 前缀 + 随机。 */
  id: z.string().min(1),
  /** 列表里显示的名字。 */
  name: z.string().min(1).max(60),
  event: HookEventSchema,
  /**
   * 只对**有主语的事件**有意义(见 {@link hookSubjectOf}):匹配工具名,或者文件路径。
   * 留空 = 全都匹配。
   *
   * 写法是**逗号分隔的 glob**(`*` 任意多个字符、`?` 一个),例如 `Edit,Write`、
   * `mcp__*`、`*.ts`。不直接收正则:正则写错是**静默不匹配**,而一个不响的钩子比一个
   * 写错的钩子难查得多 —— glob 能表达的已经够这里的用途。
   */
  matcher: z.string().max(200).optional(),
  /** 要跑的 shell 命令。**它会以你的身份在这台机器上执行。** */
  command: z.string().max(2000).default(""),
  action: HookActionSchema.optional(),
  /** 关掉的钩子不跑,但留在列表里 —— 与"删掉"是两件事(要偶尔用一次的那种)。 */
  enabled: z.boolean(),
  /** 超时(毫秒)。默认 {@link DEFAULT_HOOK_TIMEOUT_MS}。超时的进程会被杀掉。 */
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  /**
   * 【ARC-007】输出字节上限。默认 {@link HOOK_OUTPUT_LIMIT}。超出的部分从**头**丢掉、
   * 并在正文前写明(见 `lib/outBuf.ts` 的 `markTruncatedTail`)。
   *
   * 与 `timeoutMs` 同一个形状:`deliveryPolicy.outputLimit` 会**盖过**这里的值(那是更外/
   * 更粗的那一层声明)。单放在 `HookSpec` 上是为了让一条钩子**自己**也能收紧窗口 —— 与
   * `timeoutMs` 两层并存的理由一样。
   */
  outputLimit: z.number().int().min(256).max(10_000_000).optional(),
  /**
   * 【ARC-007】**声明的交付策略**。**省略 = 今天的行为**(见 {@link resolveDeliveryPolicy}:
   * `BEST_EFFORT` + 并发上限 1,即"同一条钩子同时只跑一个进程,忙时明确丢")。
   *
   * 它回答的是"这条钩子在高频事件下该怎么处置",而不是"怎么跑一条命令"(那是 `command` /
   * `timeoutMs`)。见 {@link DeliveryPolicy} 那一段的取舍说明。
   */
  deliveryPolicy: DeliveryPolicySchema.optional(),
}).superRefine((spec, ctx) => {
  const action = hookActionOf(spec);
  if (action.kind === "command" && action.command.trim().length === 0) {
    ctx.addIssue({ code: "too_small", minimum: 1, inclusive: true, type: "string", path: ["command"], message: "String must contain at least 1 character(s)" });
  }
}).transform((spec) => ({
  ...spec,
  action: hookActionOf(spec),
  // Existing callers still consume .command; only the explicit action determines execution.
  command: hookActionOf(spec).kind === "command" ? (hookActionOf(spec) as { command: string }).command : "",
}));
// Keep existing typed command hook producers source-compatible. All parsed persisted
// records have a discriminated action; older in-memory constructors may omit it.
export type HookSpec = Omit<z.output<typeof HookSpecSchema>, "action"> & { action?: HookAction };

/** 默认超时。够跑一个脚本,又不至于让一堆卡死的进程攒着。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** 一条钩子的命令最多能有多少输出被记下来(超出部分丢掉并标注)。 */
export const HOOK_OUTPUT_LIMIT = 8_192;

/* ── 匹配(纯函数) ── */

/** 一个 glob 转成正则。`*` → 任意多字符,`?` → 一个字符,**其余字符按字面处理**。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * 逗号分隔的一串 glob 拆成一条条。空项丢掉 —— 那个多半是多打了一个逗号。
 *
 * 单独拿出来是因为**两处要用同一份**:钩子的 `matcher` 与事件触发器的筛选规则
 * (`@contracts/nodeType` 的 `NODE_TRIGGER_FILTER_PARAM_KEY`)。各写一遍的话,两处的
 * "空项算不算限制"迟早会分家,而那种差别没有任何地方会报错。
 */
export function splitGlobList(patterns: string): string[] {
  return patterns
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 这一串 glob 里有没有一条能命中这个值。**空模式串 = 不限制**(返回真)。
 *
 * "只写了逗号或空格也算"这一条是刻意的:那是个笔误,而两种解释里"不限制"是安全的那一种
 * —— 它会跑起来,用户当场就看得见。反过来把笔误当成"什么都不匹配",钩子永远不响,那是
 * 最难查的一种坏。
 */
export function matchesGlobList(patterns: string, value: string): boolean {
  const list = splitGlobList(patterns);
  if (list.length === 0) return true;
  return list.some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * 这一串 glob 有没有命中**一组值里的任何一个**。
 *
 * `values` 为空 = **不匹配**(哪怕模式串是空的):调用方给不出主语,说明这次事件根本没有
 * 可比的东西,而"没有主语"和"主语不限制"是两件事(见 {@link matchesHook})。
 */
export function matchesAnyGlob(patterns: string, values: readonly string[]): boolean {
  if (values.length === 0) return false;
  return values.some((value) => matchesGlobList(patterns, value));
}

/**
 * 这条钩子该不该为这次事件跑。
 *
 * `subjects` 是**这次事件里能拿来比的东西**(由宿主按事件挑,见下),`undefined` /
 * 空数组 = 这次没有可比的东西。**没给主语却在 `matcher` 里写了东西,当作不匹配**:
 * 那多半是配错了(见 {@link validateHook},界面上会直接拦住),而"配错了却每次都跑"
 * 比"配错了不跑"危险得多。
 *
 * 主语由**调用方**挑,因为只有它手里有原始事件:
 *  - `tool` 主语给**一个**工具名;
 *  - `path` 主语给每个改动文件的**绝对路径和相对路径**(都写成 `/` 分隔),命中任一个
 *    就算 —— 用户写 `src/*.ts`(相对)和 `*.ts`(哪个目录都算)都该能命中,而只给绝对
 *    路径的话 `src/*.ts` 永远匹配不上(路径是 `D:/…/src/a.ts`)。
 */
export function matchesHook(spec: HookSpec, event: HookEvent, subjects?: readonly string[]): boolean {
  if (!spec.enabled) return false;
  if (spec.event !== event) return false;
  // 没有有效模式 = 没有限制。**只写了逗号或空格也算**,那是个笔误,而两种解释里
  // "不限制"是安全的那一种:钩子会跑起来,用户当场就看得见。反过来把笔误当成"什么都
  // 不匹配",钩子永远不响 —— 那是最难查的一种坏。
  //
  // ⚠️ 用 `splitGlobList`,**不要在这儿再内联一份 `.split(",").map(trim).filter(…)`** ——
  // 那个函数的注释白纸黑字写着"两处要用同一份,各写一遍迟早分家"。这里从前正是各写了一遍:
  // 它的"空 = 不限制"判定与本函数真正走的那条匹配路(`matchesAnyGlob → matchesGlobList
  // → splitGlobList`)一旦对拆分规则的理解不同(比如以后支持 `;` 或转义逗号),用户存的
  // 钩子会"界面合法、却安静地不匹配"。
  if (splitGlobList(spec.matcher ?? "").length === 0) return true;
  // 没给主语却在 matcher 里写了东西 → 不匹配。这多半是配错了(见 `validateHook`,
  // 界面上会直接拦住),而"配错了却每次都跑"比"配错了不跑"危险得多。
  return matchesAnyGlob(spec.matcher ?? "", subjects ?? []);
}

/** 一条钩子配得对不对。界面上存之前先过这一道,理由和 `validateDag` 一样:
 *  错的配置**不会报错**,它只会安安静静地不跑。 */
export function validateHook(spec: HookSpec): { ok: true } | { ok: false; error: string } {
  if (
    hookSubjectOf(spec.event) === null &&
    spec.matcher !== undefined &&
    spec.matcher.trim().length > 0
  ) {
    return {
      ok: false,
      error: `「${spec.event}」不带工具名、也没有文件路径可比,匹配规则填了也不会生效 —— 要么清空它,要么换一个能匹配的事件`,
    };
  }
  return { ok: true };
}

/* ── 命令拿到什么 ── */

/**
 * 一次钩子执行时,传给命令的东西。
 *
 * **`data` 是原始事件本身**(`@contracts/runtime` 的 `RuntimeEvent`),原样给它、不在
 * 这里挑字段。挑字段就等于每加一个事件都要改一次这份契约,而钩子作者想看的常常正是
 * 我们没预料到的那一个字段 —— 让他自己 `jq .data.toolName` 比我们替他选更耐用。
 *
 * JSON 走 **stdin**;同时附几个环境变量(`MCODE_EVENT` / `MCODE_SESSION_ID` /
 * `MCODE_CWD` / `MCODE_TOOL_NAME`)给 shell 里直接用的场景。
 */
export interface HookPayload {
  event: HookEvent;
  /** 事件发生的时刻(main 进程的墙上时间,ms)。 */
  at: number;
  /** 这次事件来自哪个会话 —— 包括隐藏的那两种(`kind: "node"` 的工作流节点会话、
   *  `kind: "automation"` 的自动化后台会话)。 */
  session: {
    id: string;
    kind: Session["kind"];
    title: string;
    projectId: string;
  };
  /** 这一轮的工作目录(会话的工作树,没有就是项目的路径)。命令就在这个目录里跑。 */
  cwd: string;
  /**
   * 这次事件涉及的工具名(**只有带工具名的那几种事件才有**)。
   *
   * ⚠️ **它可能不在 `data` 里**:`tool.use` / `approval.request` 自带工具名,而
   * `tool.result` 只有 `toolCallId`(见 `@contracts/runtime` 的 `ToolResultEvent`——
   * 三个提供方都是这么发的)。所以宿主会在内部按 `toolCallId` 把它找回来填在这儿,
   * **不改 `data` 里那个原始事件**。
   *
   * `turn.files` 那种按**路径**匹配的事件不带这个字段 —— 文件列表本来就在 `data.files`
   * 里,不要再抄一份(`jq '.data.files[].filePath'`)。
   */
  toolName?: string;
  /** 原始事件。 */
  data: unknown;
  /** Current ancestry, read from session metadata; never shared globally. */
  hookDepth?: number;
}

/** 传给命令的环境变量名 —— 只有这几个,其余信息走 stdin 的 JSON。 */
export const HOOK_ENV = {
  event: "MCODE_EVENT",
  sessionId: "MCODE_SESSION_ID",
  sessionKind: "MCODE_SESSION_KIND",
  cwd: "MCODE_CWD",
  toolName: "MCODE_TOOL_NAME",
} as const;

/* ── 文件格式 ── */

/** `hooks.json` 里的形状:一个带版本号的壳,里面是钩子数组。 */
export interface HooksFile {
  hooks: HookSpec[];
  /** 读得见但用不了的条目。**不静默丢弃** —— 界面上要说出来。 */
  problems: Array<{ where: string; error: string }>;
}

/** 去掉开头的 UTF-8 BOM(U+FEFF)。`hooks.json` 是用户手改的文件,读的一侧必须扛住它。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析 `hooks.json` 的正文。**纯函数**:不碰文件系统、不 import 主进程的任何东西。
 *
 * 放在契约里而不是存放的那一层,是因为**这个文件是用户直接改的**(那是把它放成文件的
 * 意义),所以"什么算合法、坏条目怎么办"是一条对外承诺,不是实现细节。附带的好处是
 * 它能被无头脚本喂各种畸形输入 —— 这段容忍规则是这一块最容易写错的地方。
 *
 * 三条容忍规则:
 *  - **文件不存在 / 是空的** = 一条钩子都没有(正常状态,不是错误)。
 *  - **整份读不出来**(不是 JSON、顶层形状不对)= 一条 problem,返回空列表。
 *  - **单条不对** = 跳过那一条并记一条 problem,**其余照常生效**。一条写坏的钩子不该
 *    让其它钩子一起失效。
 */
export function parseHooksFile(text: string): HooksFile {
  // 先剥 UTF-8 BOM:用户在 Windows 上用记事本 / PowerShell 5.1(`-Encoding UTF8`)
  // 改过的文件开头带 U+FEFF,`JSON.parse` 见到就抛 —— 整份钩子会被当成“不是 JSON”。
  text = stripBom(text);
  if (text.trim().length === 0) return { hooks: [], problems: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      hooks: [],
      problems: [{ where: "hooks.json", error: `不是合法的 JSON:${(err as Error).message}` }],
    };
  }

  const list = (raw as { hooks?: unknown } | null)?.hooks;
  if (list !== undefined && !Array.isArray(list)) {
    return { hooks: [], problems: [{ where: "hooks.json", error: "hooks 要是一个数组" }] };
  }
  // **顶层直接给数组也认**:用户手写时最自然的写法就是 `[ {...} ]`,而"必须包一层
  // hooks"这件事他没有任何线索(文件是我写的,但改起来是他改)。
  const items = Array.isArray(list) ? list : Array.isArray(raw) ? raw : null;
  if (items === null) {
    return {
      hooks: [],
      problems: [{ where: "hooks.json", error: "顶层要是一个钩子数组,或者一个有 hooks 数组的对象" }],
    };
  }

  const hooks: HookSpec[] = [];
  const problems: HooksFile["problems"] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    // 报错要能让人在文件里找到是哪一条,所以带上序号(第几条,从 1 数)。
    const where = `hooks.json 第 ${index + 1} 条`;
    const parsed = HookSpecSchema.safeParse(item);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const field = first?.path.length ? `${first.path.join(".")}:` : "";
      problems.push({ where, error: `${field}${first?.message ?? "格式不对"}` });
      return;
    }
    if (seen.has(parsed.data.id)) {
      problems.push({ where, error: `id 重复:${parsed.data.id}` });
      return;
    }
    const check = validateHook(parsed.data);
    if (!check.ok) {
      problems.push({ where, error: check.error });
      return;
    }
    seen.add(parsed.data.id);
    hooks.push(parsed.data);
  });

  return { hooks, problems };
}

/* ── 执行记录 ── */

/**
 * 一次执行的结果。**只给设置页看,不进对话**。
 *
 * 为什么不进对话流:一个挂在 `tool.use` 上的钩子,一轮里会触发几十次 —— 塞进消息流
 * 就是把每一段对话刷屏。而且节点会话是隐藏的,那些事件本来就不该出现在父对话里
 * (见 `RuntimeManager` 里那条按 `kind` 分流的判断)。钩子的执行记录是**给写钩子的
 * 人排错用的**,它该待的地方是它自己的设置页。
 */
export const HOOK_RUN_STATUSES = ["ok", "failed", "timeout", "running", "skipped"] as const;
export type HookRunStatus = (typeof HOOK_RUN_STATUSES)[number];

export interface HookRun {
  /** 这一次执行的 id(与钩子 id 不同 —— 同一条钩子会跑很多次)。 */
  runId: string;
  hookId: string;
  hookName: string;
  event: HookEvent;
  /** 哪个会话触发的。 */
  sessionId: string;
  sessionKind: Session["kind"];
  startedAt: number;
  durationMs?: number;
  status: HookRunStatus;
  exitCode?: number;
  /** 标准输出(**有上限**,见 {@link HOOK_OUTPUT_LIMIT})。 */
  stdout?: string;
  stderr?: string;
  /**
   * 【ARC-007】这一条**实际生效**的输出字节上限。省略 = 用了全局 {@link HOOK_OUTPUT_LIMIT}。
   *
   * 它让"截了没有、按哪个上限截的"变成执行记录里**可断言的数** —— 光有 `stdout` 里那句
   * 截断说明不够:那句话写死了常量,策略覆盖了上限时它会报错数(见 `runCommand` 的
   * `markTail`)。
   */
  outputLimitBytes?: number;
  /**
   * 【ARC-007】输出被截过(尾部之外的东西丢了)。`stdout` / `stderr` 里那句说明之外,
   * 再给一个**结构化**的布尔 —— 消费方(设置页 / 断言)不必去匹配中文。
   */
  truncated?: boolean;
  /** 没能跑起来(命令不存在、spawn 就失败)或者被跳过(上一条还在跑)的原因。 */
  error?: string;
}

/**
 * 【MC-061 审计读取】`hook_runs` 表的一行 —— 一条**插件 hook 的持久执行事实**,可跨重启回读。
 *
 * ## 与 {@link HookRun} 的区别
 *
 * `HookRun` 是**内存里那 50 条环**(`HookRunner.RUN_RING`)的一条:用户手写的钩子也进那个环,
 * 但它会被新记录顶掉、进程一重启就没。`HookAuditEntry` 是**落盘审计**:只有**插件 hook**
 * (带来源身份、经授权执行)落这张表,它是"这份来源的这条钩子跑没跑、哪份授权放行的、被撤权 /
 * 预算用尽挡下几次"的合规账本。两者语义不同,故不合并成一个类型 —— 一个是排错窗口,一个是
 * 审计事实。
 *
 * ## 为什么没有 stdout / stderr
 *
 * 审计要的是「跑没跑、为什么」,不是完整输出(见 `HookRunRow` 的文件头)。输出上限那么大,
 * 逐条留着是写放大换不到审计价值。
 *
 * 字段与主进程 `store/repositories.ts` 的 `HookRunRow` **逐一对应**(结构兼容,直接透传即可)。
 */
export interface HookAuditEntry {
  runId: string;
  hookId: string;
  /** 【MC-010】这次执行的来源 —— `plugin`(不受信来源,经授权驱动)或 `user`
   *  (用户手写在 hooks.json 里)。落不落库的判据从「是不是插件」改为「是不是
   *  一次真实执行」后,来源降为**一列事实**,供界面分栏/过滤。 */
  source: "plugin" | "user";
  /** 贡献这条 hook 的插件名(`HostHookSource.pluginId`)。用户手写的钩子填 `"user"`。 */
  pluginId: string;
  /** 插件版本;未声明为 null。 */
  pluginVersion: string | null;
  /** 原生事件名(如 `PreToolUse`)。 */
  nativeEvent: string;
  /** 命令内容摘要(改命令 = 新来源,旧授权作废)。 */
  commandDigest: string;
  /** matcher 摘要;未声明 matcher 为 null。 */
  matcherDigest: string | null;
  /** 统一 HookEvent(映射后的)。 */
  event: string;
  sessionId: string;
  sessionKind: string;
  /** running | ok | failed | timeout | skipped。 */
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  /** 跳过 / 失败的**原因**(含授权拒绝 / 预算用尽的理由)。 */
  error: string | null;
  startedAt: number;
}

/**
 * 【MC-061】Claude 原生 hook 事件名 → Mcode 统一 {@link HookEvent}。
 *
 * 插件里带的是 Claude 的 hooks.json 事件名(`PreToolUse` / `PostToolUse` / `Stop` / …)。
 * 台账要求:接上执行通道时,**映射不到的事件必须明确报 UNSUPPORTED,不得静默不跑** ——
 * 所以这里给出唯一一份映射表,映射不到就返回 `null`(调用方据此标 `unmappable`)。
 *
 * 只映射语义**明确对应**的;边界不清的宁可返回 null(报不可用)也不猜 —— 猜错会让一条
 * 钩子挂在一个它本不该响应的事件上。
 */
export const CLAUDE_HOOK_EVENT_MAP: Readonly<Record<string, HookEvent | null>> = {
  UserPromptSubmit: "user.message",
  PreToolUse: "tool.use",
  PostToolUse: "tool.result",
  Notification: "approval.request",
  Stop: "turn.done",
  SubagentStop: "subagent.update",
  // 明确不映射(语义在 Mcode 的统一事件里没有对应):会话起止、压缩前后等。
  SessionStart: null,
  SessionEnd: null,
  PreCompact: null,
};

/** 映射一个原生 hook 事件名到统一 {@link HookEvent};未知或不支持的返回 null。 */
export function mapClaudeHookEvent(nativeEvent: string): HookEvent | null {
  return CLAUDE_HOOK_EVENT_MAP[nativeEvent] ?? null;
}

/**
 * 【ARC-015】文件监听的**默认忽略目录**。一次 `npm i` 是几万条事件,让它们各自去跑一遍
 * glob 纯属白烧 CPU —— 所以这些目录下的动静默认不看。
 *
 * ⚠️ 但这不该**无条件**盖住用户显式选的触发源:「dist/*.js 构建完后处理」是开发场景的
 * 合理需求。所以是否忽略由 {@link shouldIgnoreWatchPath} 判,而不是进 onFsChange 就 return。
 */
export const WATCH_SAFE_IGNORED_DIRS: readonly string[] = [
  "node_modules", ".git", "dist", "build", "out", "target", ".next",
];

/**
 * 【ARC-015】这条文件事件该不该被默认忽略目录挡掉 —— 纯函数,可直测。
 *
 * 判据:
 * - 路径里没有默认忽略目录段 → **不看**(正常处理);
 * - 有,但 `policy === "SAFE_DEFAULT"`(缺省)→ **忽略**;
 * - 有,且 `policy === "EXPLICIT_OVERRIDE"` → 再看用户的 include glob 是否**明确、具体**
 *   地命中:命中才放行。**泛化 glob(`**`、`*`、仅目录名)**不给解保护 —— 一个根 glob
 *   等于把整个仓库解保护,那不是"显式选择触发源",是误配置。
 *
 * @param relPath 相对触发器 cwd 的路径(调用方已归一成正斜杠;也接受绝对路径,取段即可)
 * @param includeGlobs 用户写的 include glob 列表
 * @param policy spec.defaultIgnorePolicy(缺省按 SAFE_DEFAULT)
 */
export function shouldIgnoreWatchPath(
  relPath: string,
  includeGlobs: readonly string[],
  policy: "SAFE_DEFAULT" | "EXPLICIT_OVERRIDE" = "SAFE_DEFAULT",
): boolean {
  const segs = relPath.split(/[\/]/).filter(Boolean);
  const hitIgnored = segs.some((seg) => WATCH_SAFE_IGNORED_DIRS.includes(seg));
  if (!hitIgnored) return false;
  if (policy !== "EXPLICIT_OVERRIDE") return true;
  // EXPLICIT_OVERRIDE:只有**具体**的 include glob 命中被忽略目录下的路径才放行。
  return !includeGlobs.some((g) => isSpecificGlob(g) && globToRegExp(g).test(relPath));
}

/**
 * 【MC-091】**统一截断原语** —— 超限就丢**最早**的,并把丢的条数**如实报出**。
 *
 * ## 为什么只留一份
 *
 * 仓库里"超限丢最早的、丢弃要如实计数"这件事原先在几处**各自实现**(文件积压
 * `addToFileBacklog`、事件条目 `mergeEventPayload`、监听期间的方向表),每处写法不同 ——
 * 于是"丢是允许的,假装没丢不允许"这条规矩要靠每处都记得写对;一处漏计就退化成静默截断
 * (模型以为它办的是全部,少办的永远没人办、也不报错)。抽成这**唯一一份**纯函数,几处
 * 都改调它,判据只有一个、只在一条注释里说清。
 *
 * ## 判据(窄,不做任何"智能"取舍)
 *
 * 只按**位置**丢:保留**最后** `limit` 条(最近的),丢掉最早的 `overflow` 条。不改顺序、
 * 不重排、不去重(去重是调用方各自的事,如 `addToFileBacklog`)。`limit <= 0` 时队列恒空,
 * 整条都算丢(不静默扩成无限)。恒返回 `0` 会让调用方以为"没丢" —— 而载荷里恰恰是不完整
 * 的列表,那正是本函数要终结的坏法。
 *
 * @param items 现有条目(不就地改;返回新数组)
 * @param limit 上限(见 `automationRunner` 的 `PENDING_FILES_LIMIT` / `automationPayload`
 *   的 `MAX_EVENT_ITEMS`)
 * @returns 保留的条目(`kept`,最近那批)+ 这次因超限丢掉的条数(`dropped`)
 */
export function capOldest<T>(items: readonly T[], limit: number): { kept: T[]; dropped: number } {
  const cap = limit > 0 ? limit : 0;
  const overflow = items.length - cap;
  if (overflow <= 0) return { kept: [...items], dropped: 0 };
  // 只丢**最早**的几条(从队首),留下的是最近发生的 —— 与原来 `shift()` 的取舍一致。
  return { kept: items.slice(overflow), dropped: overflow };
}

/**
 * 【ARC-015】把一条路径收进文件触发的**积压队列**,并在超限时**如实报出丢了几条**。
 *
 * ## 为什么是一个显式结果,而不是就地 `shift()` 一下
 *
 * 一条长期抖动的目录会把积压队列顶到上限。从前超限只是 `shift()` 掉最早的一条 +
 * 一句 `log.warn` —— 运行照跑,载荷里却是**不完整**的文件列表,而**没有任何消费方
 * 收得到一个"这次输入被截断了"的事实**(台账 ARC-015 剩余项②)。模型以为它办的是全部,
 * 少办的那些**永远没人办**,也不报错。
 *
 * 这个纯函数把「截断」变成一个可测量的数(`dropped`):调用方据此把 `overflowDropped`
 * 记进载荷事实、并在人话描述里明说"输入不完整"。**丢是允许的(性能保护要保留),
 * 假装没丢不允许。** 判据要窄,不做任何"智能"取舍 —— 只丢**最早**的,不重排。
 *
 * 去重:`path` 已在队列里时原样返回(`dropped` = 0),与"文件反复变只算一次"一致。
 * 去重之后的上限截断走**唯一一份** {@link capOldest}(MC-091 统一截断原语)。
 *
 * @param backlog 现有队列(不就地改;返回新数组)
 * @param path 要收进来的路径(调用方已归一)
 * @param limit 队列上限(见 automationRunner 的 `PENDING_FILES_LIMIT`)
 * @returns 新队列 + 这次因超限丢掉的条数
 */
export function addToFileBacklog(
  backlog: readonly string[],
  path: string,
  limit: number,
): { backlog: string[]; dropped: number } {
  // 已在里面:不重复收,也不丢任何东西(同"文件反复变只算一次")。
  if (backlog.includes(path)) return { backlog: [...backlog], dropped: 0 };
  const { kept, dropped } = capOldest([...backlog, path], limit);
  return { backlog: kept, dropped };
}

/**
 * 【ARC-015①】一条文件事件的**结构化变更类型**。
 *
 * `fs.watch` 只给「事件类型 + 文件名」,给不出「从哪儿来」—— 所以这里刻意保留
 * `unknown`:**定不了方向就标它,不假装**。别把「暂时不存在的路径」一律丢掉(那会连
 * 「删除」这条事实都表达不出来),也别把一次 `rename` 硬说成确定的新建或删除。
 */
export type FileChangeKind = "created" | "modified" | "deleted" | "renamed" | "unknown";

/** 【ARC-015①】一条结构化文件变更:`路径 + 类型`。 */
export interface FileChange {
  /** 绝对路径(调用方已归一)。 */
  path: string;
  kind: FileChangeKind;
}

/**
 * 【ARC-015①】把 `fs.watch` 给的零碎线索合成为一条**诚实**的 {@link FileChange} 类型。
 *
 * ## 输入与它们各自能证明什么
 *
 * - `eventType`:`fs.watch` 的回调类型。`"change"` = 内容变了;`"rename"` 同时覆盖
 *   **新建 / 删除 / 改名**(这是 `fs.watch` 的硬事实,不是我们的取舍);别的值或 `null`
 *   = 平台没给。
 * - `exists`:**此刻**问一次盘(`stat`)的结果 —— 这是唯一确定的事实。
 * - `seenBefore`:这一批里**之前**见过这个路径没有(上一轮的观察)。
 *
 * ## 判据(宁可 unknown,不猜方向)
 *
 * - `"change"` + 在 → `modified`;`"change"` + 不在(矛盾,极少:边写边被删)→ `unknown`。
 * - 其余(`"rename"` / 无类型)+ 在 → 见过就是 `unknown`(rename 覆盖到这个已见路径上,
 *   但**给不出源名**),没见过就是 `created`。
 * - 其余 + 不在 → 见过就是 `deleted`,没见过就是 `unknown`(转瞬即逝的临时文件)。
 *
 * ## 为什么**从不**返回 `renamed`
 *
 * `renamed` 是**声明保留**的一档:真要说"X 被改成了 Y",得把 rename 的**两端配对**
 * 起来,而 `fs.watch` 单独给不出另一端(见上)。所以在本函数现在的输入下,rename 一律
 * 落成 `created` / `deleted` / `unknown` —— 这是诚实,不是没做。等有了能配对的事件源
 * (见台账 ARC-015④ 的 `DurableEventEnvelope`)再让这一档有值。
 */
export function classifyFileChange(
  eventType: string | null,
  exists: boolean,
  seenBefore: boolean,
): FileChangeKind {
  if (eventType === "change") {
    // "change" = 内容变过。文件此刻在 → 改动;不在(边写边被删那种矛盾)→ 不假装。
    return exists ? "modified" : "unknown";
  }
  // "rename" 或平台没给类型:靠"此刻在不在 + 之前见没见过"合成。
  if (exists) return seenBefore ? "unknown" : "created";
  return seenBefore ? "deleted" : "unknown";
}

/**
 * 【ARC-015①】收口时的**二次 stat 校正**:一个方向说"还在"的路径,到收口这一刻再问一次盘。
 *
 * 攒着的那几秒里文件可能又没了 —— 若还对外说 `created` / `modified`,模型会去读一个不存在的
 * 文件(正是这一路最坏的坏法:悄悄少办一件事)。这时**降级成 `deleted`** 才是诚实的。
 *
 * 只处理"说在、其实没了"这一个方向:`deleted` / `unknown` 本就不保证文件存在,不必再问;
 * 而"说没了、又回来了"属于重命名来回那种,交给下一次事件自然覆盖(别在这里猜方向)。
 */
export function reconcileFileChangeKind(kind: FileChangeKind, existsNow: boolean): FileChangeKind {
  if (!existsNow && (kind === "created" || kind === "modified")) return "deleted";
  return kind;
}

/**
 * 【ARC-015】这条 glob 够不够"具体",足以解除默认忽略保护?
 *
 * 不够具体的:空串、`**`、纯 `*`、只写一个默认忽略目录名(如 `dist`,那等于说"整个 dist
 * 都看")。够具体的:`dist/*.js`、`build/report.json`、`node_modules/x/index.js` 这类带
 * **具体名字/扩展**的。判据要窄 —— 宁可让用户再写细一点,也不给一个 `**` 把整仓解保护。
 */
export function isSpecificGlob(glob: string): boolean {
  const g = glob.trim();
  if (g.length === 0) return false;
  if (g === "**" || g === "*" || g === "**/*" || g === "*/**") return false;
  // 去掉纯通配的段后,必须还剩至少一个"带字面字符"的段(不是纯 * / **)。
  const literalSegs = g
    .split(/[\/]/)
    .filter((seg) => seg.length > 0 && seg !== "*" && seg !== "**" && /[A-Za-z0-9_.\-]/.test(seg));
  return literalSegs.length > 0;
}

/**
 * 【ARC-015③】一条文件事件的**解析后路径**是否仍在被监听的**根目录之内**。
 *
 * ## 为什么需要这道边界
 *
 * `fs.watch` 回调里给的是**相对被监听目录**的 `filename`。执行器把它 `join(dir, filename)`
 * 拼成绝对路径后直接拿去做 glob 匹配 —— 但 `join` 会**归约 `..`**:一个 `../x.md` 事件会
 * 被解析成**根目录之外**的路径,再配上一条泛化 glob(如 `*` `.md` 或 `**`)就可能命中,
 * 于是"已授权 workspace"被一条相对路径悄悄越出(台账 ARC-015 验收:「目录 symlink/junction
 * 及相对/绝对匹配不逃出已授权 workspace」)。
 *
 * 这道判定把边界**钉在代码里**,而不是依赖"平台恰好不会给越界文件名"这件未写进契约的事实。
 *
 * ## 判据要窄
 *
 * 纯字符串判定,不碰磁盘(不 realpath):先把两条路径的分隔符统一成 `/`,再**按段**把
 * `.`/`..` 归约掉(与 `path.join` 一样是字面归约),最后判前缀 —— `norm(abs) === norm(root)`
 * 或 `norm(abs).startsWith(norm(root) + "/")`。**不在本函数里做大小写折叠** —— 调用方传
 * 进来的 `abs` 是 `join(root, filename)` 的结果,越界的那些前缀本就不同,而"根目录自身的大小写"
 * 由调用方保证一致(见 automationRunner)。函数**自己**归约 `..`(不依赖调用方已归约),
 * 这样它单独拿出来用也正确。
 *
 * @param absPath 事件解析后的路径(`join(dir, filename)`)
 * @param root 被监听的根目录(触发器的 cwd)
 * @returns 仍在根之内(含等于根)为 `true`;`..` 上跳、绝对路径替换等越界为 `false`
 */
export function isWithinWatchRoot(absPath: string, root: string): boolean {
  // 统一分隔符 + 字面归约 `.` / `..`(与 path.join 的段处理一致:上跳弹掉上一段,
  // 已在顶时把 `..` 留成一段以示"仍在外")。
  const norm = (p: string): string => {
    const stack: string[] = [];
    for (const seg of p.replace(/[\\/]+/g, "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
        else stack.push("..");
      } else {
        stack.push(seg);
      }
    }
    return stack.join("/");
  };
  const r = norm(root);
  // 根目录为空(调用方没给 cwd)时不做限制 —— "没有根可比"和"越界"是两件事。
  if (r.length === 0) return true;
  const a = norm(absPath);
  return a === r || a.startsWith(`${r}/`);
}
