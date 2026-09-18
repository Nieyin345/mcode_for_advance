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
  // 长期任务的状态广播(见 `longTask.ts`)—— 钩子/触发器暂不暴露,和 `git.changed`
  // 同一档"故意不给":它描述的是循环器内部进度,用户能表达的意图已经由 turn 级事件覆盖。
  "longtask.update": null,

  /* ── 故意不暴露的(是"不该给",不是"还没来得及给")── */

  // 太频繁:一次对话能来几万条,挂上就是每秒钟起一堆进程。
  "text.delta": null,
  thinking: null,
  "subagent.transcript": null,
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
};

/* ── 一条钩子 ── */

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
  command: z.string().min(1).max(2000),
  /** 关掉的钩子不跑,但留在列表里 —— 与"删掉"是两件事(要偶尔用一次的那种)。 */
  enabled: z.boolean(),
  /** 超时(毫秒)。默认 {@link DEFAULT_HOOK_TIMEOUT_MS}。超时的进程会被杀掉。 */
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
export type HookSpec = z.infer<typeof HookSpecSchema>;

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
  const patterns = (spec.matcher ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // 没有有效模式 = 没有限制。**只写了逗号或空格也算**,那是个笔误,而两种解释里
  // "不限制"是安全的那一种:钩子会跑起来,用户当场就看得见。反过来把笔误当成"什么都
  // 不匹配",钩子永远不响 —— 那是最难查的一种坏。
  if (patterns.length === 0) return true;
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
  /** 没能跑起来(命令不存在、spawn 就失败)或者被跳过(上一条还在跑)的原因。 */
  error?: string;
}
