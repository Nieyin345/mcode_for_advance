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
  if (subjects === undefined || subjects.length === 0) return false;
  return patterns.some((pattern) => {
    // 一个模式编译一次,再拿所有主语去试 —— 主语可能有一整个文件列表那么长。
    const re = globToRegExp(pattern);
    return subjects.some((subject) => re.test(subject));
  });
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
  /** 这次事件来自哪个会话 —— 包括隐藏的工作流节点会话(`kind: "node"`)。 */
  session: {
    id: string;
    kind: "chat" | "side" | "node";
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
  sessionKind: "chat" | "side" | "node";
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
