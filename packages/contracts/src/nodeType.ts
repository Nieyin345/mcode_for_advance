/**
 * 节点类型(Node Type)—— 工作流底座**唯一的规范**。
 *
 * ## 这个文件解决什么
 *
 * 工作流的节点将来不可能只有一种:今天是"一个子 agent",明天是"跑一个本地脚本"、
 * "起一个训练进程"。如果每加一种就给 `WorkflowNode` 加几个字段,那么:第三方想加
 * 一种节点要改 Mcode 的源码;**用户让 AI 给自己造一种节点也办不到**;而且每加一次
 * 都要迁移 `payload` 的结构。
 *
 * 所以节点**不描述自己**,它只**引用一个类型** + 带一袋参数:
 *
 * ```ts
 * { id, type: "mcode.agent", params: { instruction: "…" }, position, … }
 * ```
 *
 * 类型由一份**清单**(manifest)描述,清单长什么样由本文件规定。于是:
 *
 * - **规范**:清单是 zod schema,签名不对的第三方内容装不进来、也跑不起来;
 * - **统一接口**:任何节点类型都只暴露同样四件事 —— 要什么参数(`params`)、要什么
 *   能力(`capability`)、怎么跑(`runner`)、产出什么(`outcome`);
 * - **可编辑**:清单是普通的 JSON/TS 对象,人和 AI 都能直接读写;
 * - **可下载**:清单 + 脚本装进一个插件就能分发(见下面「三种来源」)。
 *
 * ## 边界:什么是 Mcode 的,什么是第三方的
 *
 * 这条线划在哪里,决定了这个底座会不会变成一坨:
 *
 * | | 谁提供 | 为什么 |
 * |---|---|---|
 * | **执行原语**(`runner.kind`) | **Mcode** | 只有它能 spawn 进程、建子会话、管审批 |
 * | 参数怎么填、怎么绑到命令上 | 第三方 | 纯声明,不碰执行 |
 * | 清单(id/名字/图标/参数/文档) | 第三方 | 这是内容,不是代码 |
 * | 脚本本体 | 第三方 | 随插件分发 |
 *
 * **执行原语是一个封闭的小集合**,第三方不能自己发明一个新的 `runner.kind` —— 那等于
 * 要求 Mcode 执行任意代码。但这不构成限制:绝大多数第三方节点都能落进 `command`
 * (跑它自己带的脚本)。
 *
 * ⚠️ **`command` 有两种形状,实现程度不同**(见 {@link IMPLEMENTED_RUNNER_KINDS}):
 * 命令来自**节点参数**的(`entry` 缺省,内置的 `mcode.command` 那种)已实现;命令来自
 * **清单自带脚本**的(`entry` 填了,第三方插件那种)仍只定形状、未实现 —— 遇到会**明确
 * 报错**,而不是假装跑了。
 *
 * ## 三种来源与优先级
 *
 * | 来源 | 在哪 | 谁写的 |
 * |---|---|---|
 * | `builtin` | 代码(`main/orchestration/nodeTypes.ts`) | 随应用发布 |
 * | `plugin` | `~/.mcode/plugins/<名>/<版本>/node-types/` | 从市场/git/zip 装进来的 |
 * | `local` | `<数据根>/workflows/node-types/` | 用户自己写的,或让 AI 写的 |
 *
 * **同名时 `local` > `plugin` > `builtin`**(见 {@link NODE_TYPE_SOURCE_RANK})。这是本
 * 仓库既有的优先级约定(见 `ipc/skills.ts` 的 `SOURCE_RANK`),不另立一套。
 *
 * ⚠️ 但 **`mcode.` 前缀是保留的**(见 {@link RESERVED_NODE_TYPE_PREFIX}),所以"用户覆盖
 * 内置类型"这件事**实际不会发生** —— 内置 id 别人根本用不了。想要一个不同的实现,该起
 * 自己的 id(`myorg.agent`)而不是顶掉官方那个:这样一份分享来的工作流,在任何机器上
 * 引用 `mcode.agent` 指的都是同一个东西。优先级真正起作用的地方是 **local 盖 plugin**
 * —— 用户改掉某个插件带来的类型。
 *
 * ## 为什么放 contracts 而不是主进程
 *
 * 三处要用同一份:主进程注册表(解析与校验)、调度器(按 `runner` 派发)、渲染端画布
 * (按 `params` 生成表单)。三处各写一遍 schema 必然漂移,而漂移的后果是"界面上填得
 * 进去、一执行就说参数不对"。
 */

import { z } from "zod";
import { CapabilityRequirementSchema } from "./capability.js";
import { LIBRARY_KINDS } from "./library.js";
import { TEMPLATE_KINDS } from "./templates.js";
import { parseCron, type CronSpec } from "./cron.js";
import { HOOK_EVENTS, hookSubjectOf, splitGlobList, type HookEvent } from "./hook.js";
import {
  WorkflowCapabilitySchema,
  type WorkflowCapability,
  type WorkflowTrigger,
} from "./workflow.js";

/* ── id ── */

/**
 * 类型 id 的形状:`作者.名字`,两段都小写、用连字符分词。例:`mcode.agent`、
 * `myorg.pdf-parse`。
 *
 * 强制两段是**故意的**:一段式 id(`agent`)会让"谁提供的"这个问题没有答案,而
 * 第三方内容一旦多了,`agent` / `agent2` / `my-agent` 这种命名必然撞车。
 */
export const NODE_TYPE_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** `mcode.` 是内置类型的命名空间,**第三方不得占用** —— 否则它可以覆盖内置节点,
 *  把自己的 `mcode.agent` 塞进来冒充官方实现。 */
export const RESERVED_NODE_TYPE_PREFIX = "mcode.";

/**
 * 内置的**主代理**节点类型 id。
 *
 * 一份工作流里它是**入口**:用户那句话先到它这儿,由它拆成几步、分给下游的子 agent。
 * 新建的工作流自带一个(`workflowEdit.ts` 的 `seedMainAgent`),而且**删不掉**
 * (`workflowView.ts` 的 `isProtectedNode`)。
 *
 * ## 为什么这个 id 定在 contracts 而不是主进程那一份清单里
 *
 * 因为**三个地方要认同一个字符串**,而它们分属三层:主进程拿它声明内置类型
 * (`orchestration/nodeTypes.ts`)、渲染端拿它决定"这个节点能不能删 / 画不画星标"、
 * 存下来的文档里它就是 `node.type`。定在别处的话,渲染端要么 import 主进程(那层
 * 依赖不存在),要么自己再写一遍字面量 —— 后者是"改了一处忘了另一处"的经典形状,
 * 而它错起来的表现是**主代理变得可以删**。
 *
 * 与 `@contracts/nodeType` 里其它东西同一个位置理由:它是**契约**,不是实现。
 */
export const MAIN_NODE_TYPE_ID = "mcode.main";

/**
 * 内置的**分支**节点类型 id —— 图跑到它就把决定权交给用户。
 *
 * 和 {@link MAIN_NODE_TYPE_ID} 同一个位置理由:**三层要认同一个字符串** —— 主进程
 * 拿它声明内置类型、调度器拿它判断"这个节点要不要挂起等用户"、渲染端拿它决定卡片上
 * 摆不摆选项按钮。定在别处的话,渲染端要么 import 主进程(那层依赖不存在),要么自己
 * 再写一遍字面量,而它错起来的表现是**卡片上没有按钮、图永远挂在那里**。
 *
 * ⚠️ 判断"一个节点是不是分支"**不要用这个 id**,要用它清单里的 `runner.kind ===
 * "branch"` —— 第三方可以带自己的分支类型进来,而它们的行为必须一模一样(那是
 * 调度器的能力,不是这份清单的)。这个常量是给**界面**用的:卡片和画布要认出"官方
 * 那一个"来做特判(比如插入菜单里不重复列)。
 */
export const BRANCH_NODE_TYPE_ID = "mcode.branch";

/**
 * 内置的**触发器**节点类型 id —— 一条自动化的起点。
 *
 * 与 {@link BRANCH_NODE_TYPE_ID} 同一个位置理由:三层要认同一个字符串(主进程声明内置
 * 类型、渲染端在插入菜单里认出它、存下来的文档里它就是 `node.type`)。⚠️ 判"这是不是
 * 触发器"**永远看 `runner.kind === "trigger"`**,不要看这个 id。
 */
export const TRIGGER_NODE_TYPE_ID = "mcode.trigger";

/* ── 触发器 ─ */

/**
 * 触发方式(节点参数 `triggerKind` 的取值)。
 *
 * **四类,而且只有这四类**:手动点、到点了、文件变了、某件事发生了。`webhook` 不在这里
 * —— 那要一个对外的 HTTP 入口(得动手机服务那一摊),属于另一件事,这一版不接。枚举里
 * 保留该值(`@contracts/workflow` 的 `WORKFLOW_TRIGGERS`)只是为了老文档读得回来。
 */
export const TRIGGER_KINDS = ["manual", "schedule", "file", "event"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === "string" && (TRIGGER_KINDS as readonly string[]).includes(value);
}

export const NODE_TRIGGER_KIND_PARAM_KEY = "triggerKind";
/** 在哪个项目里跑:后台会话的 `projectId` 与这次运行的工作目录都从它来。 */
export const NODE_TRIGGER_PROJECT_PARAM_KEY = "project";
/** 被触发时,整次运行的**用户请求**就是这段字(根节点读到的那一句)。 */
export const NODE_TRIGGER_TASK_PARAM_KEY = "task";
/** 只在「定时」时生效。5 段 cron,见 `@contracts/cron`。 */
export const NODE_TRIGGER_CRON_PARAM_KEY = "cron";
/** 只在「文件变化」时生效:逗号分隔的 glob,相对项目目录。 */
export const NODE_TRIGGER_PATHS_PARAM_KEY = "paths";
/** 只在「事件发生时」生效:逗号分隔,取值来自 `@contracts/hook` 的 `HOOK_EVENTS`。 */
export const NODE_TRIGGER_EVENTS_PARAM_KEY = "events";
/** 事件触发时的进一步筛选(工具名 / 文件路径,glob,规则同钩子)。 */
export const NODE_TRIGGER_FILTER_PARAM_KEY = "eventFilter";
/** 合并窗口(毫秒):文件连着变、事件连着来,合成一次运行。 */
export const NODE_TRIGGER_DEBOUNCE_PARAM_KEY = "debounceMs";

/**
 * 触发器参数 →`WorkflowDoc.trigger` 的**唯一那张表**。
 *
 * `trigger` 字段在这一版**降级成了一个开关**:它不再有独立的真相,值一律由触发器节点
 * 反推写回(见 `orchestration/library.ts` 的 `deriveTrigger`)。所以"哪一种"这件事只有
 * 一个写入方,两处不可能矛盾 —— 而列表分栏、MCP、i18n 那些照旧读那个字段,一行都不用改。
 */
export const WORKFLOW_TRIGGER_OF_TRIGGER_KIND: Record<TriggerKind, WorkflowTrigger> = {
  manual: "manual",
  schedule: "schedule",
  file: "file",
  event: "event",
};

/** 从节点参数里取触发方式。认不出来的值 = `undefined`(调用方按"没配好"处理)。 */
export function triggerKindOf(params: Record<string, unknown>): TriggerKind | undefined {
  const raw = params[NODE_TRIGGER_KIND_PARAM_KEY];
  return isTriggerKind(raw) ? raw : undefined;
}

/** 逗号分隔的一串 glob。空项丢掉;一个都没有 = 空数组。切分规则与钩子的 `matcher`
 *  共用一份(见 `@contracts/hook` 的 `splitGlobList`)。 */
export function patternListOf(raw: unknown): string[] {
  return typeof raw === "string" ? splitGlobList(raw) : [];
}

/** 默认的合并窗口。够把"保存时连着改了三个文件"收成一次,又不至于让人等。 */
export const DEFAULT_TRIGGER_DEBOUNCE_MS = 2000;

/** 解析好的触发条件。判别联合 —— 调度器按 `kind` 分派,没有"哪几个字段这时候有效"的疑问。 */
export type TriggerSpec =
  | { kind: "manual" }
  | { kind: "schedule"; cron: CronSpec }
  | { kind: "file"; globs: string[]; debounceMs: number }
  | { kind: "event"; events: HookEvent[]; matcher: string; debounceMs: number };

/** 一次触发条件的解读结果。**存盘与执行器共用这一份判定**(见 `parseTriggerSpec`)。 */
export type TriggerSpecCheck = { ok: true; spec: TriggerSpec } | { ok: false; error: string };

/**
 * 把触发器节点的参数解读成一份触发条件。**纯函数**,存盘前与真要挂监听时各跑一次。
 *
 * ## 为什么两处都跑同一份
 *
 * 存盘前跑,是为了**不允许存下一份永远不响的自动化**(cron 写错、glob 写空、事件名拼错
 * —— 这些都不会报错,只会安安静静地不跑,而"我的自动化没反应"是最难查的一类)。
 * 真要挂监听时再跑一次,是因为清单可以改、参数可以被 AI 或手改:存下的时候对,读出来
 * 不一定还对。两处用**同一个函数**才谈得上"一致"。
 *
 * 报错的话术是给**配这个节点的人**看的(用「触发方式」「在哪个项目里跑」这些界面上的词),
 * 而不是字段名。
 */
export function parseTriggerSpec(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
): TriggerSpecCheck {
  if (manifest.runner.kind !== "trigger") {
    return { ok: false, error: `「${manifest.name}」不是触发器类型的节点` };
  }

  const project = params[NODE_TRIGGER_PROJECT_PARAM_KEY];
  if (typeof project !== "string" || project.trim().length === 0) {
    return { ok: false, error: "「在哪个项目里跑」没填 —— 触发器要知道它该在哪个目录里工作" };
  }
  const task = params[NODE_TRIGGER_TASK_PARAM_KEY];
  if (typeof task !== "string" || task.trim().length === 0) {
    return { ok: false, error: "「这次要做什么」没填 —— 被触发时这句话就是这次运行的请求" };
  }

  const kind = triggerKindOf(params);
  if (kind === undefined) {
    return { ok: false, error: "「触发方式」没选(手动 / 定时 / 文件变化 / 事件发生时)" };
  }
  if (kind === "manual") return { ok: true, spec: { kind: "manual" } };

  if (kind === "schedule") {
    const text = params[NODE_TRIGGER_CRON_PARAM_KEY];
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, error: "触发方式是「定时」,但表达式没填 —— 例如 `0 9 * * 1-5`" };
    }
    const parsed = parseCron(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, spec: { kind: "schedule", cron: parsed.spec } };
  }

  const debounce = debounceOf(params);
  if (!debounce.ok) return { ok: false, error: debounce.error };

  if (kind === "file") {
    const globs = patternListOf(params[NODE_TRIGGER_PATHS_PARAM_KEY]);
    if (globs.length === 0) {
      return { ok: false, error: "触发方式是「文件变化」,但没写监听哪些文件 —— 逗号分隔,例如 `*.md, src/*.ts`" };
    }
    return { ok: true, spec: { kind: "file", globs, debounceMs: debounce.value } };
  }

  const names = patternListOf(params[NODE_TRIGGER_EVENTS_PARAM_KEY]);
  if (names.length === 0) {
    return { ok: false, error: "触发方式是「事件发生时」,但没写听哪些事件 —— 逗号分隔,取值见事件列表" };
  }
  const events: HookEvent[] = [];
  for (const name of names) {
    if (!(HOOK_EVENTS as readonly string[]).includes(name)) {
      return { ok: false, error: `不认识的事件「${name}」—— 取值只能是:${HOOK_EVENTS.join(" / ")}` };
    }
    if (!events.includes(name as HookEvent)) events.push(name as HookEvent);
  }
  const matcher = params[NODE_TRIGGER_FILTER_PARAM_KEY];
  const trimmedMatcher = typeof matcher === "string" ? matcher.trim() : "";
  // 一轮挑一个**能筛**的事件来问 —— 这几个事件的主语是一回事(工具名或路径),所以
  // 只要有一个能筛,这条筛选就有意义。
  if (trimmedMatcher.length > 0 && events.every((e) => hookSubjectOf(e) === null)) {
    return {
      ok: false,
      error: `选中的事件(${events.join("、")})都没有可筛的维度,筛选规则填了也不会生效 —— 要么清空它,要么选一个带工具名或文件路径的事件`,
    };
  }
  return { ok: true, spec: { kind: "event", events, matcher: trimmedMatcher, debounceMs: debounce.value } };
}

/** 合并窗口:没填就用默认;填了必须是 0 以上的整数(0 = 不合并,立刻跑)。 */
function debounceOf(params: Record<string, unknown>): { ok: true; value: number } | { ok: false; error: string } {
  const raw = params[NODE_TRIGGER_DEBOUNCE_PARAM_KEY];
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: DEFAULT_TRIGGER_DEBOUNCE_MS };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return { ok: false, error: "「合并窗口」要是一个不小于 0 的毫秒数" };
  }
  return { ok: true, value: Math.round(raw) };
}

/**
 * 岔路口上那个**系统自带的**选项:「就到这儿」。
 *
 * ## 为什么它是**界面**加的,不是图上的边
 *
 * 「我不想选了」是每个岔路口**都该有**的一条出路 —— 而画一条通向"什么都不做"的节点
 * 的线,只是为了说一句"算了",那是让用户替系统打杂。所以它不出现在图上、不算一条边、
 * 也没有 `note`:卡片自己摆这个按钮,点了之后**所有出路一起作废**,这次运行自然收场
 * (没有节点可派发了,调度循环就退出来了)。
 *
 * ## 它为什么是个**哨兵 id** 而不是"没有 id"
 *
 * `WorkflowChooseSchema.edgeId` 是必填的字符串,而"空串"在协议里是**取消**的意思
 * (见 `RunPorts.choose`:被中止时返回空串)。两者混用的话,"用户点了停止"和"运行被
 * 取消了"在调度器那一头长得一模一样,而它们的收场完全不同 —— 一个是正常结束,一个是
 * `cancelled`。
 *
 * 放 contracts 是因为**三层要认同同一个字符串**:渲染端拿它摆按钮和回传、调度器拿它
 * 判断"这不是任何一个出路"(于是所有边都判死)、文档拿它解释这个行为。
 */
export const BRANCH_STOP_CHOICE = "__stop__";

/** 清单格式版本。第三方据此声明"我按哪一版规范写的";将来规范演进时,老清单能被
 *  识别出来并给出可读的提示,而不是抛一堆 zod 错误。 */
export const NODE_MANIFEST_VERSION = 1;

/* ── 参数 ── */

/**
 * 参数在画布上渲染成什么控件。
 *
 * 这是一个**封闭集合**:渲染端要能穷举它。三方内容想要一个我们没有的控件,正确做法
 * 是往这里加一个值(一次小改动),而不是让清单自带一段 HTML —— 那等于让下载来的
 * 内容决定界面长什么样。
 */
export const NODE_PARAM_KINDS = [
  "text", // 单行文本
  "longtext", // 多行文本(指令、脚本正文)
  "number",
  "boolean",
  "select", // 从 options 里选(候选写在清单里)
  "file", // 文件路径,画布给一个选择器
  "dir", // 目录路径
  "ref", // 从**这台机器上有什么**里挑 —— 哪些模型、哪些技能……(见 NODE_PARAM_REF_SOURCES)
  "variables", // 一张「名字 + 示例」的表(节点产出的变量,见 @contracts/outputConstraint)
  // 一张「名字 + 内容 + 解释」的表 —— 主对话入口节点的**输入选项**:每行会变成聊天
  // 输入框上方那个下拉框里的一项,选中后内容插到光标处、解释注入提示词(见
  // `main/orchestration/runner.ts` 的注入段)。与下面 `NodeParamSpecSchema` 的
  // `options` 字段(select 的候选清单)只是撞名,两回事。
  "options",
  // 一组**下拉条件** —— 主对话入口节点的**固定条件**:每一行(条件名 + 一串候选值)
  // 变成聊天输入框上方的一个下拉框,选中的值**每轮**随工作流提示词注入("一贯的习惯,
  // 不要再问"那套)。与 `select` 的区别:`select` 是**一个**下拉、候选写在清单里、
  // 谁都不注入;`selects` 是**一张条件表**、候选写在参数值里、值要进提示词。
  "selects",
] as const;
export type NodeParamKind = (typeof NODE_PARAM_KINDS)[number];
export const NodeParamKindSchema = z.enum(NODE_PARAM_KINDS);

/**
 * `kind: "ref"` 的参数**从哪一份列表里挑**。
 *
 * 这是 `ref` 与 `select` 的分界,也是这个种类**唯一可扩展的那一维**:`select` 的候选
 * 写在清单里(作者知道有哪些值),`ref` 的候选在**用户这台机器上** —— 装了哪些技能、
 * 配了哪些模型。写清单的人不可能知道这些,所以清单只能声明"挑哪一类"。
 *
 * 因此加一种新的"可选的东西"(记忆、知识库、子 agent、MCP 服务……)是往这里**加一个
 * 值** + 在渲染端加一个取数分支,**而不是再加一个 `kind`**。后者看着也行,但每加一个
 * kind 就要在契约、检查器、参数校验三处各开一个形状完全一样的口子 —— 而真正不同的
 * 只有"候选从哪来"这一件事。
 *
 * ⚠️ 加值的时候**必须是实现好了才加**:这个集合是封闭的,渲染端要能穷举它,所以列在
 * 这里就等于承诺"选了它会有用"。
 */
export const NODE_PARAM_REF_SOURCES = [
  "models",
  "skills",
  "providers",
  // 这一步能用到哪几个 **MCP 服务器**。空的 = 不限制(全都给,也就是现在的行为)。
  //
  // 与技能那一维的差别不在形状上,在**代价**上:多带一个 MCP 服务器 = 它的全部工具
  // 定义都进上下文(`browser_*` 那一套有二十来个),而每一步都要把上下文整段重发一遍。
  // 第三步在写稿、根本不会开浏览器的时候,那些定义是白花的钱。
  "mcp",
  // 这一步加载哪几个**插件**。空的 = 不限制(所有已启用的都加载)。
  //
  // 同上:插件带的技能 / 命令 / 子 agent 会各自带一段说明进上下文,而一个只查库的
  // 步骤用不到文档排版那四个技能。
  "plugins",
  // 这一步在**哪个项目**里跑 —— 自动化那条路要用(触发器得知道它该在哪个目录里工作,
  // 见 `@contracts/nodeType` 的 `NODE_TRIGGER_PROJECT_PARAM_KEY`)。候选是左栏那张项目表。
  //
  // 它是唯一一个**不带 `multiple` 选项**的用例(值就是项目 id 那一个字符串):"在哪几个
  // 目录里跑"这件事对一次运行没有意义 —— 一次运行只有一个工作目录。
  "projects",
] as const;
export type NodeParamRefSource = (typeof NODE_PARAM_REF_SOURCES)[number];
export const NodeParamRefSourceSchema = z.enum(NODE_PARAM_REF_SOURCES);

/**
 * 参数值怎么送到**命令行**节点手上。
 *
 * 存在的意义是**让清单保持声明式**:如果让第三方自己在清单里写
 * `"command": "python x.py --in ${input}"` 然后由 Mcode 做字符串替换,那就等于
 * 把注入面直接敞开(参数里带个引号或分号就变命令)。改成声明"这个参数绑到哪个
 * argv/env",由运行时**拼数组**,值永远是一个独立的参数,不进 shell 解析。
 *
 * `prompt` 类节点不用这个 —— 它们的参数由 provider 侧自己消费。
 */
export const NodeParamBindingSchema = z.union([
  /** 作为环境变量传给进程。名字大写、下划线分词。 */
  z.object({ kind: z.literal("env"), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  /** 作为命令行参数。`flag` 省略 = 位置参数(按 params 数组顺序追加)。 */
  z.object({ kind: z.literal("arg"), flag: z.string().optional() }),
  /** 写到进程的 stdin。**一个节点最多一个参数绑 stdin**(校验会拒绝第二个)。 */
  z.object({ kind: z.literal("stdin") }),
]);
export type NodeParamBinding = z.infer<typeof NodeParamBindingSchema>;

export const NodeParamSpecSchema = z.object({
  /** 在节点 `params` 对象里的键。 */
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  kind: NodeParamKindSchema,
  /** 画布上的字段名。 */
  label: z.string().min(1),
  help: z.string().optional(),
  required: z.boolean().optional(),
  /** 新节点取默认值。不给且 `required` 未设 = 可选且无默认。 */
  default: z.unknown().optional(),
  /** `kind: "select"` 专用。 */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** `kind: "ref"` 专用:从哪一份列表里挑。**是 `ref` 就必须给** ——
   *  清单校验会拒绝没写 `from` 的引用型参数(否则渲染端不知道去哪取候选)。 */
  from: NodeParamRefSourceSchema.optional(),
  /** 能不能多选。省略 = 单选,值是一个字符串;多选时值是 `string[]`
   *  (`[]` = 一个都没选,等同于没限制)。
   *
   *  两种**值写死在清单里**的参数都支持:`ref`(候选在这台机器上)与 `select`
   *  (候选写在 `options` 里)。`ref` 先有的这个字段,但"能挑几个"和"候选从哪来"
   *  本来就是两件事 —— 一个类目表(「要哪几类上下文」)是多选的,而它的候选是固定的,
   *  没有任何理由逼它退化成 `ref`。 */
  multiple: z.boolean().optional(),
  /** 只在 `runner.kind === "command"` 时有意义,见 {@link NodeParamBindingSchema}。 */
  bind: NodeParamBindingSchema.optional(),
});
export type NodeParamSpec = z.infer<typeof NodeParamSpecSchema>;

/* ── 执行 ── */

/**
 * 节点怎么跑起来。**这是 Mcode 保留的执行原语**,第三方只能选,不能自创。
 *
 * - `prompt`:交给一个带独立指令的子 agent(一次对话轮次,**新开一段会话**)。
 * - `conversation`:同样跑一轮模型,但**跑在主对话里** —— 见下面那一段。
 * - `branch`:不跑东西。出边选谁,由参数 `decider` 说了算 —— `user`(默认,把决定权
 *   交给用户)或 `model`(跑一轮模型自己选,即过去的"决策节点")。
 * - `trigger`:图的起点 —— "什么情况下起一次运行"。不跑东西,它是自动化的声明。
 * - `command`:在本机跑一个进程。`param` 形状(**已实现**):跑什么由图上的参数写;
 *   `entry` 形状(第三方自带脚本,**尚未实现**):调度器遇到会明确拒绝。
 *
 * `command` 的字段刻意只有最少的几个:`entry` 是**相对清单所在目录**的脚本路径
 * (解析时会拒绝逃出该目录的路径,规则抄 `pluginManifest.ts` 的 `resolveInRoot`)。
 */
export const NodeRunnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt") }),
  z.object({ kind: z.literal("code"), language: z.enum(["python", "node", "shell", "powershell"]).default("python") }),
  /**
   * **对话节点**:跑一轮模型,指令**当作主对话里的一条用户消息发出去** —— 主对话
   * (连同它到此刻为止的全部历史)就像平时那样回一轮。
   *
   * ## 它和 `prompt` 的区别只有一个:在哪儿跑
   *
   * `prompt` 节点是**新开一段会话**、不继承任何历史(见 `orchestration/runner.ts` 的
   * `createNodeSession`)。那是刻意的隔离:节点不会跑偏、可以重复跑、一张图能分享给别人
   * ——别人拿到你的图,可没有你那半小时的聊天记录。
   *
   * 但有些步骤**恰恰需要那段聊天**:"按刚才聊定的思路改第三章"。隔离节点做不到这件事,
   * 所以有这一种。
   *
   * ## 三个后果,都是这个选择的必然
   *
   * 1. **产出就留在主对话里** —— 不经过"结果回灌"那条管道,因为压根没离开过。用户在
   *    聊天框里看见的是**一轮正常对话**(一条用户消息 + 一条回复),外加流程图那一张
   *    步骤卡片。这一种节点**没有"看过程"按钮**:过程就是聊天本身。
   * 2. **上下文只增不减。** 这一步读过的文件、工具的每一次返回,都永久留在主对话里。
   * 3. **节点上那些"换引擎 / 换模型 / 限技能"的配置对它没有意义** —— 它用的就是主对话
   *    当前这一套。所以这种节点的参数表里只有「指令」。
   *
   * ## 它不产生"新的回合"
   *
   * 主对话正在跑这张图(`running`),这一步是**图内部的一步**,不是用户那一轮的结束。
   * 所以它跑完**不会**发一条面向界面的 `turn.done` —— 那条要等整张图收尾才发,否则
   * 界面上会中途冒出"回合完成"、输入框提前解禁(见 `RuntimeManager.holdTurnEnd`)。
   */
  z.object({ kind: z.literal("conversation") }),
  /**
   * **分支**:把决定权交出去 —— 挂在岔路口,选中的那条出边照常,其余出边连同它们
   * 拖着的整条支路一起作废(见 {@link NodeOutcomeStatus} 的 `unselected`)。
   *
   * **决定权给谁**由参数 `{@link NODE_DECIDER_KEY}` 说了算:`user`(默认)挂起等用户
   * 点(弹卡片),`model` 真跑一轮模型、按它交出的「出路」选边 —— 后者就是原来的
   * "决策节点",现在只是分支的一种填法(见 {@link isModelDecider})。两种模式共用
   * 同一套"选项=出边"的机制,差别只有一件事:**谁决定**。
   *
   * 它的**选项就是它的出边**(见 `@contracts/workflow` 的 `WorkflowEdgeSchema`)——
   * 所以不需要"选项表"这个参数:图上拉了几根线就是几个选项。
   *
   * 为什么是一种**执行原语**而不是一个普通的 prompt 节点:用户选时不消费模型,而"挂起、
   * 等、作废整条支路"是调度器的能力,不是提示词能表达的 —— 提示词里的"如果用户选 A
   * 就……"只是请求,而这里要让**代码**保证没走的那条路真的不跑。
   */
  z.object({ kind: z.literal("branch") }),
  /**
   * **触发器**:图的**起点** —— "什么情况下起一次运行"。
   *
   * ## 它自己不跑任何东西
   *
   * 不跑模型、不建会话、不 fork 进程。它是一个**声明**:声明这条自动化等的是什么,以及
   * 被触发时这次运行要干什么(见 {@link NODE_TRIGGER_TASK_PARAM_KEY})。真正的监听在
   * `main/orchestration/automationRunner.ts`,那儿才是看时钟、看文件、订阅事件的地方。
   *
   * ## 为什么它必须是图上的一员,而不是文档上的一个字段
   *
   * `WorkflowDoc.trigger` 只能回答"哪一种",回答不了"几点"、"监听哪"、"这次要做什么" ——
   * 那些是**参数**,而参数长在节点上。更要紧的是:**一条自动化可以有多个触发器**
   * (「每天九点」+「我改完稿子」),一个字段说不出来两件事。
   *
   * ## 走到它的时候会发生什么
   *
   * 被触发的那一个:预置成已完成(`runWorkflow` 的 `entry`),不派发。同一条自动化里
   * **别的**触发器:标 `unselected`(它们这次没走这条路,不是失败),它们**独自**拖着的
   * 下游跟着作废,而汇合点照常跑。
   */
  z.object({ kind: z.literal("trigger") }),
  /**
   * **命令**:在本机跑一个进程,跑完把退出码与输出尾部交成产出变量。它是"直跑形态"
   * 的那一步:工作流**自己**起命令,跑到它就停在那儿**等退出** —— 不需要任何监控。
   *
   * ## 两种形状,谁提供命令
   *
   * - **`entry` 缺省**(内置 `mcode.command` 那种):命令来自**节点参数**
   *   (见 {@link NODE_COMMAND_PARAM_KEY}),跑什么由画图的人写。
   * - **`entry` 填了**(第三方插件那种):跑清单目录里自带的脚本。这种**仍未实现**,
   *   调度器遇到会明确拒绝(见 {@link isNodeRunnable} 的那条补刀)。
   *
   * ## 为什么它没有审批
   *
   * 命令是用户写死在节点上的配置,不是模型临时起意 —— 审批没有对象。代价是:把它挂到
   * 定时/事件触发的自动化上 = 无人值守执行,清单的 usage 里要写明这件事。
   */
  z.object({
    kind: z.literal("command"),
    /** 相对清单目录的脚本/可执行文件路径。**缺省 = 命令来自节点参数**(内置那种)。 */
    entry: z.string().min(1).optional(),
    /** 显式解释器(如 `python`)。省略 = 直接执行 `entry`(需要可执行位)。 */
    interpreter: z.string().optional(),
    /** 固定附加的参数(不来自 params)。 */
    args: z.array(z.string()).optional(),
  }),
]);
export type NodeRunner = z.infer<typeof NodeRunnerSchema>;
export type NodeRunnerKind = NodeRunner["kind"];

/**
 * `runner.kind === "prompt"` 的节点,这一轮执行的**指令从哪个参数来**。
 *
 * 这是一条**约定**,不是字段:清单里没有"哪个参数是指令"的声明位。定在 contracts
 * 是因为它同时被两处读 —— 主进程调度器(`orchestration/scheduler.ts` 拿它拼这一轮
 * 的提示词)与渲染端(检查器把它标成这一步的主体)。加一个显式的声明位(比如
 * `runner: { kind: "prompt", instructionParam: "..." }`)当然更灵活,但那要改清单
 * schema 与所有已发布的清单;而"一个提示词节点必须有指令"本来就是这类节点的定义,
 * 不值得为它开一个自由度。第三方要写自己的提示词节点,键就叫 `instruction`。
 *
 * 不叫 "prompt" 是为了和 `WorkflowDoc.prompt`(提示词型**工作流**的正文)区分开:
 * 那个是整条流程的说明,这个是某一步的指令。
 */
export const NODE_PROMPT_PARAM_KEY = "instruction";

/**
 * 主对话入口节点的**输入选项**参数键(`kind: "options"`) —— 每行是聊天输入框上方
 * 那个下拉框里的一项:`{ name: 名字, content: 内容, note?: 解释 }`。选中后内容插进
 * 输入框光标处,解释随这次运行进提示词(见 `main/orchestration/runner.ts`)。
 *
 * 和 {@link NODE_PROMPT_PARAM_KEY} 同一条约定:不是 schema 上的字段,是一个**键名**。
 * 只有随应用发布的入口节点(`mcode.main`)带这个参数 —— 那个下拉框陪着"用户那句话
 * 进图的第一站",别的节点没有这个位置。
 */
export const NODE_OPTIONS_PARAM_KEY = "options";

/**
 * 主对话入口节点的**固定条件**参数键 —— 聊天输入框上方那一排下拉框的条目表。
 *
 * 值是一张 `{ name: 条件名, choices: 候选值[] }` 的表:每一行变成输入框上方**一个**
 * 下拉框,选中的值随**每次运行最开头**的提示词注入**一次**(`main/lib/searchPrefs.ts`
 * 的 `nodeCriteriaPrompt`,注入点在 `runner.ts` 的 `startWorkflowRun`),之后不再重复。
 * 它接过了文献检索那条**写死的筛选条**:那四个条件(时间范围 /
 * 期刊层次 / 影响因子 / 每源条数)现在是内置检索图主节点上的预填数据,用户可以改候选、
 * 加条件、删条件 —— 定义在节点上,界面只是渲染。
 *
 * 和 {@link NODE_PROMPT_PARAM_KEY} 同一条约定:不是 schema 上的字段,是一个**键名**。
 * 只有入口节点(`mcode.main`)带这个参数。
 */
export const NODE_CRITERIA_PARAM_KEY = "criteria";

/**
 * `runner.kind === "prompt"` 的节点,**这一步要用哪些技能**的参数键。
 *
 * 和 {@link NODE_PROMPT_PARAM_KEY} 同一条约定:不是 schema 上的字段,是一个**键名**。
 * 引擎按这个名字去 `params` 里取,取到就交给 provider 当技能的允许清单(见
 * `StartTurnRequest.skills`)。第三方要写自己的提示词节点,想让这一步能用技能,键就叫
 * `skills`、类型就是 `kind: "ref", from: "skills", multiple: true`。
 *
 * 用"约定键"而不是"给 `WorkflowNode` 加字段"的理由,和当初 `dependsOn` 让位给 `edges`
 * 是同一条:节点上加字段意味着**每一种能力**都要改一次 schema、改一次迁移;而键是清单
 * 里的一个参数,加一种能力只是加一个清单条目(见本文件头「边界」那张表)。
 */
export const NODE_SKILLS_PARAM_KEY = "skills";

/**
 * 从节点参数里取一串**名字**。三个名字列表参数(技能 / MCP 服务器 / 插件)共用这一份
 * 规则,因为它们的脏值形态完全一样 —— 参数是用户和 AI 都能写的自由数据,要能容忍:
 * 不是数组、数组里混进非字符串、空串、重复项、以及带前导斜杠的写法。
 *
 * 放在 contracts 而不是主进程,是因为渲染端也要用同一份判据(它得把"这一步选了哪些
 * 技能"显示出来)—— 两处各写一遍过滤规则,迟早会在"参数里存了个脏值"这种输入上分家。
 *
 * **斜杠那一条是"丢掉"不是"剥掉"**:清单里存的是**名字**(`pdf`),`/pdf` 是**调用**
 * 技能时的写法,两者不是同一个位置的东西,所以不替写的人做转换。代价是只写了一个
 * `/pdf` 时这个参数会变成空 = 不限制,得靠界面把存进去的值显示出来给人看 ——
 * 这是"宁可显示原样,也不猜"的一贯取舍。
 */
function nameListOf(params: Record<string, unknown>, key: string): string[] {
  const raw = params[key];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name.length === 0 || name.startsWith("/") || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 从节点参数里取技能名。空数组 = **没选**(不限制),不是"一个技能都不许用"。 */
export function skillNamesOf(params: Record<string, unknown>): string[] {
  return nameListOf(params, NODE_SKILLS_PARAM_KEY);
}

/**
 * `runner.kind === "prompt"` 的节点,**这一步能用哪几个 MCP 服务器**的参数键。
 *
 * 和 {@link NODE_SKILLS_PARAM_KEY} 同一条约定:不是 schema 上的字段,是一个**键名**。
 *
 * ## 语义:空 = 不限制(全部),非空 = 只要这几个
 *
 * 与技能那一维完全一致,这一条是刻意的 —— 三个"可选的东西"用同一套读法,用户不必记
 * 三套规则,提示词里也只需要一句话。
 *
 * ## 代价:服务器是**按整份工具表**进上下文的
 *
 * 多带一个 MCP 服务器,进去的不是"这个名字",是它的**全部工具定义**(浏览器那一套有
 * 二十来个),而模型每一次调用都要把上下文整段重发一遍。所以一个"整理稿子"的步骤挂着
 * 浏览器工具,是每一步都在白花的钱。这是这个参数唯一的存在理由:**让每一步只带它用得着
 * 的那几样。**
 *
 * ## 内置的那两个不在这里
 *
 * `mcode-library` / `mcode-workflow` 是 Mcode 自己的骨干(查库、操作流程),**始终挂
 * 着,也不进候选表** —— 它们不是用户装的东西,列出来只会让人以为自己关得掉。
 */
export const NODE_MCP_PARAM_KEY = "mcp";

/** 从节点参数里取 MCP 服务器名。空数组 = 不限制。 */
export function mcpServerNamesOf(params: Record<string, unknown>): string[] {
  return nameListOf(params, NODE_MCP_PARAM_KEY);
}

/**
 * `runner.kind === "prompt"` 的节点,**这一步加载哪几个插件**的参数键。
 *
 * 同一条约定、同一套读法(空 = 不限制)。与 MCP 分开成两个参数而不是合并成一个"组件"
 * 参数,是因为它们的**粒度不同**:插件是一整包(技能 + 命令 + 子 agent),而 MCP 服务器
 * 是一个。一个插件自带的服务器**不跟着插件参数走** —— 它在「MCP 服务器」那张表里按名字
 * 选,所以"只要这个插件的技能、不要它那份服务器"是分得开的。
 *
 * 候选只列**已启用**的插件:这个参数只能往下减,减不到用户没开的东西(同 `NODE_MCP_PARAM_KEY`)。
 */
export const NODE_PLUGINS_PARAM_KEY = "plugins";

/** 从节点参数里取插件名。空数组 = 不限制。 */
export function pluginNamesOf(params: Record<string, unknown>): string[] {
  return nameListOf(params, NODE_PLUGINS_PARAM_KEY);
}

/**
 * `runner.kind === "prompt"` 的节点,**它跑完之后有多少东西回到主对话**的参数键。
 *
 * ## 为什么要有它
 *
 * 隔离节点跑在自己的会话里,产出回到图里、由下游取 —— **主对话那边一个字都收不到**。
 * 用户看着一张张卡片,而跟他说话的那个助手对这些一无所知:接着问「刚才那三步说了啥」
 * 它答不上来,因为它压根没看见过。
 *
 * ## 三档
 *
 * - `none`(默认,也是今天的行为):什么都不回;
 * - `result`:每一步**交出来的东西**并回主对话 —— 那个助手下一轮就知道各步产出了什么;
 * - `full`:连**过程**也并(它说了什么、调了哪些工具,见 `nodeTranscript.ts`)。上下文
 *   会长很多,但"它凭什么得出这个结论"变成可查的。
 *
 * ## 并的是**上下文**,不是界面
 *
 * 界面上本来就有每一步的卡片 —— 缺的从来不是"显示",是**主对话那个助手看不见**。
 * 所以这个选项做的是:把内容挂到这个对话上,**下一次它开口时带进去**(见
 * `RuntimeManager.sendTurn`)。因此它是**下一次才生效**的:图刚跑完那一刻,那个助手
 * 还没被叫醒。
 *
 * ## 为什么默认 `none`
 *
 * 并回去是**累积**的:一张十步的图全并进去,主对话从此每一轮都背着这十段。而多数图
 * 跟主对话在聊的事没什么关系。**按步选,别默认。**
 */
export const NODE_RETURN_PARAM_KEY = "returnToChat";

/** 三档,见 {@link NODE_RETURN_PARAM_KEY}。 */
export const NODE_RETURN_MODES = ["none", "result", "full"] as const;
export type NodeReturnMode = (typeof NODE_RETURN_MODES)[number];

export function isNodeReturnMode(value: unknown): value is NodeReturnMode {
  return typeof value === "string" && (NODE_RETURN_MODES as readonly string[]).includes(value);
}

/** 从节点参数里取"回多少"。认不出来的值一律当 `none` —— **宁可什么都不回,也不要
 *  因为一个拼错的字符串就把一整段过程灌进主对话**(那是一次性的、事后收不回的代价,
 *  而不并回去顶多是用户再问一句)。 */
export function returnModeOf(params: Record<string, unknown>): NodeReturnMode {
  const raw = params[NODE_RETURN_PARAM_KEY];
  return isNodeReturnMode(raw) ? raw : "none";
}

/**
 * `runner.kind === "prompt"` 的节点,**这一步用哪个引擎**(哪家提供方)的参数键。
 *
 * 和 {@link NODE_PROMPT_PARAM_KEY} / {@link NODE_SKILLS_PARAM_KEY} 同一条约定:不是
 * schema 上的字段,是一个**键名**。留空 = 跟着这次对话走(见 `runner.ts` 的
 * `createNodeSession`),那是最常见的选择 —— 绝大多数步骤不需要换引擎。
 *
 * 为什么值得给一个自由度:一条流程里"便宜的分拣"和"贵的推理"用不同引擎是常态,而
 * "整条图换引擎"要在对话上换、会连主对话一起换掉。**换的是引擎,不是模型** —— 模型由
 * `model` 参数管,两者可以同时用(同一个模型 id 在不同引擎下不通用,所以两个都留空
 * 是最稳的写法)。
 *
 * ⚠️ 引擎必须在**这台机器上装了**才有意义(`provider.list` 里有一份),填了一个没装的
 * 会让节点起不来。这一条不在参数校验里拦:参数是值,而"装了没有"是这台机器的状态 ——
 * 一份分享来的工作流在别人机器上引用一个没装的引擎是正常的,它该在**跑的时候**以
 * "这个引擎没装"失败,而不是存不进去(同 `validateNodeParams` 对 `ref` 的处理)。
 */
export const NODE_PROVIDER_PARAM_KEY = "provider";

/** 从节点参数里取引擎 id。留空 = 跟着对话走。形状容忍度同 {@link skillNamesOf}。 */
export function providerIdOf(params: Record<string, unknown>): string | undefined {
  const raw = params[NODE_PROVIDER_PARAM_KEY];
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id.length === 0 ? undefined : id;
}

/**
 * `runner.kind === "prompt"` 的节点,**这一步要用哪几类上下文**的参数键。
 *
 * 「上下文」指的是对话里挂的那些东西 —— 文献 / 教材 / 笔记(文献库的三个库)、以及
 * ppt / latex / word / code / image(模版库的五个类目)。这**正是用户在界面上看到的
 * 一级分类**,不是另立一套词汇(见 {@link NODE_CONTEXT_KINDS})。
 *
 * ## 语义:继承,不是查找
 *
 * 这个参数**不产生内容**,它只做筛选:一次工作流运行开始时,宿主先看**发起这次运行的
 * 那条消息挂了哪些东西**(它们本来就是提示词里的 `@<清单路径>`,见
 * `@contracts/library` 的附件机制),然后把其中属于这几类的**原样**交给这个节点 ——
 * 同一批清单文件、同一份说明。
 *
 * 所以「这一步要文献」这句话的完整意思是:**如果这次对话挂了文献,就给这一步同样的
 * 文献**。没挂就是没有 —— 不会替用户去库里翻,也不会让模型判断"要不要去找"。
 * 这是刻意的:能不能拿到某个文件是**确定性**的事,交给模型判断只会得到一个有时对
 * 有时错的答案,而"这一步该看到什么"不该是概率问题。
 */
export const NODE_CONTEXT_PARAM_KEY = "context";

/**
 * 节点能要求的上下文类目 —— **出厂时的全集**:两个库的一级分类。
 *
 * 直接从 `LIBRARY_KINDS` / `TEMPLATE_KINDS` 拼出来,而不是在这里再抄一份:抄一份的
 * 那天,库里加了一个新分类,这个下拉里就不会有它,而没有任何地方会报错。
 *
 * ⚠️ **它是"出厂清单",不再是类型全集。** 统一资料库后 kind 开放注册(见
 * `@contracts/libraryTypes`),用户自建的类型也要能被节点要求 —— 所以
 * `NodeContextKind` 已放宽为 string;这个数组降级为**静态兜底**(没接注册表的调用方
 * 拿它当内置全集用),`isNodeContextKind` 同理只认内置那八个。"动态全集"在
 * `main/library/kindRegistry`(M2)接进上下文链。
 */
export const NODE_CONTEXT_KINDS = [...LIBRARY_KINDS, ...TEMPLATE_KINDS] as const;
export type NodeContextKind = string;

export function isNodeContextKind(value: unknown): value is NodeContextKind {
  return typeof value === "string" && (NODE_CONTEXT_KINDS as readonly string[]).includes(value);
}

/** 从节点参数里取上下文类目。**只留下认识的那些** —— 参数是用户和 AI 都能写的自由
 *  数据,而一个不认识的类目名会让"要继承什么"这件事变得没法推理。形状容忍度同
 *  {@link skillNamesOf}。 */
export function contextKindsOf(params: Record<string, unknown>): NodeContextKind[] {
  const raw = params[NODE_CONTEXT_PARAM_KEY];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: NodeContextKind[] = [];
  for (const item of list) {
    if (!isNodeContextKind(item) || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

/**
 * `runner.kind === "prompt"` 的节点,**这一步要不要读整条流程的记录**的参数键。
 *
 * 值是一个布尔。缺席 = **没表过态**,由调度器按图的结构给一个默认值(见
 * `@contracts/workflow` 的 `nodesOnLoopOf`);用户或 AI 显式写下的值一律以它为准。
 *
 * ## 「记录」和「上下文」是两样东西
 *
 * - {@link NODE_CONTEXT_PARAM_KEY}(「上下文」)是**外部输入**:这次对话挂了哪些文献、
 *   哪些模版 —— 用户自己带进来的;
 * - 这个键是**内部产出**:这条流程从开始到现在,每一步各自交了什么。
 *
 * 两样都要,但不能混在一个控件里。混的代价不只是界面难看:`NODE_CONTEXT_KINDS` 是
 * 「文献库 + 模版库」拼出来的,而"这条资料拿来干嘛"({@link contextPurposeOf})判的是
 * "属不属于文献库" —— 一个既不是文献也不是模版的东西塞进去,会被归进"当格式仿"那一
 * 栏,于是提示词里出现一句教模型照着流程记录仿写的话。
 *
 * ## 为什么不默认给每个节点都读
 *
 * 记录是**累积**的:它带着这条流程到此刻为止每一份产出。给不需要它的步骤也塞一份,
 * 是纯浪费 —— 而且会稀释指令。一个"只做这一步"的节点在读到下游才该关心的东西之后,
 * 越界的概率反而上升(这正是「整条流程」那一节只给名字、不给指令的原因)。
 */
export const NODE_FLOW_RECORD_PARAM_KEY = "flowRecord";

/**
 * 这一步要不要读整条流程的记录。
 *
 * 返回 `undefined` = **没表过态**,调用方按图的结构补默认值。区分"没表态"和"说了不要"
 * 是要紧的:前者该跟着"这个节点在不在环上"走(画一个环,回头那一步自然就该读记录),
 * 后者是用户明确关掉的,不该被任何默认值覆盖回去。
 */
export function flowRecordOf(params: Record<string, unknown>): boolean | undefined {
  const raw = params[NODE_FLOW_RECORD_PARAM_KEY];
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * **走到这一步之前,先弹个框问一下** —— 打开这个开关的对话节点,跑之前先把决定权
 * 交给用户(见 {@link ASK_CHOICES} 那四个选项)。
 *
 * ## 为什么是一个参数,而不是第五种 `runner.kind`
 *
 * `NodeRunnerSchema` 是一个**封闭集合**,文件头写明那是 "Mcode 保留的执行原语"。
 * 而这个功能的执行方式仍然是 `conversation` —— 它只是**多问一句**,问完之后该怎么跑
 * 还是怎么跑。所以它和 {@link NODE_FLOW_RECORD_PARAM_KEY} 是同一档:参数驱动的行为,
 * 不是新的原语。
 *
 * 判定要**同时**看两样:清单的 `runner.kind === "conversation"` 且这个参数为真。
 * 只看参数的话,别的类型(包括将来第三方的)误填一个同名键就会被卷进来。
 */
export const NODE_ASK_PARAM_KEY = "askBeforeRun";

/** 从节点参数里取「运行前先问我」。非 `true` 一律当没开。 */
export function askBeforeRunOf(params: Record<string, unknown>): boolean {
  return params[NODE_ASK_PARAM_KEY] === true;
}

/* ── 分支的「决定权」 ── */

/**
 * 分支节点参数 `decider` —— **谁来选那条出边**。
 *
 * ## 为什么是分支的一个参数,而不是第五种原语
 *
 * "分支"这个原语的全部价值在**岔路的机制**里:选项=出边、没走的路连下游一起作废、
 * 上下游的活性按选中的那条算。这套机制对"用户点"和"模型判"**一字不差** —— 差的只有
 * "谁来选"这一个决定。做成两种原语的话,同一段活性判定要写两遍,迟早漂移;做成参数,
 * 判据收口在 {@link isModelDecider} 一个函数里,三处(调度器派发、产出校验、渲染端
 * 徽标)读同一个答案。
 *
 * ⚠️ **模型选不能当环的闸门**(见 `library.ts` 的 `isLoopGate`):用户点一下就停得
 * 下来,模型会一环一环自己转下去。这条不是约定,是 `validateDag` 的硬校验。
 */
export const NODE_DECIDER_KEY = "decider";

/** `decider` 的两个取值。缺省 = `user`(老图的分支行为不变)。 */
export const DECIDER_MODES = ["user", "model"] as const;
export type DeciderMode = (typeof DECIDER_MODES)[number];

/** 从节点参数里取决定权。认不出的值一律当 `user` —— 保守的那个方向。 */
export function deciderOf(params: Record<string, unknown>): DeciderMode {
  return params[NODE_DECIDER_KEY] === "model" ? "model" : "user";
}

/**
 * 分支切到模型选、但**指令没填**时给模型的那句话。
 *
 * 指令是可空的:大多数岔路口不需要额外嘱咐,把上游产出摆给模型就够了。默认指令只做
 * 一件事 —— 把"交出选项名、一字不改"这条硬约束的口气在提示词里立住。
 */
export const DEFAULT_DECIDER_INSTRUCTION =
  "看看上游的结果,从下面的选项里选出最合适的一条。把选项的名字一字不改地交出来,不要自己发明别的说法。";

/**
 * 这个节点是不是"**模型选**"的分支 —— 三个调用点(调度器派发、产出校验、渲染端徽标)
 * 必须给出同一个答案,所以收口在这里。`params` 必传:决定权长在节点参数上,只看清单
 * 的话一个第三方分支会被误判。
 */
export function isModelDecider(
  manifest: { runner: NodeRunner },
  params: Record<string, unknown>,
): boolean {
  return manifest.runner.kind === "branch" && deciderOf(params) === "model";
}

/* ── 命令节点 ── */

/**
 * 命令节点(`runner.kind === "command"`、`entry` 缺省那种)**要跑的命令行**。
 *
 * 一段 shell 文本,宿主起进程执行。它跑在**发起会话的项目目录**里,吃的是用户自己写的
 * 配置 —— 所以没有审批(见 `NodeRunnerSchema` 里 command 那段的说明)。
 */
export const NODE_COMMAND_PARAM_KEY = "command";

export const NODE_CODE_PARAM_KEY = "code";
export const NODE_CODE_LANGUAGE_KEY = "language";
export const NODE_CODE_TIMEOUT_KEY = "timeoutMs";
export const NODE_CODE_INPUT_KEY = "input";

/** 命令节点参数 `timeoutMs` —— 超时上限,毫秒。**0 = 不限**(默认:训练动辄数小时)。 */
export const NODE_COMMAND_TIMEOUT_KEY = "timeoutMs";

/**
 * 命令节点产出里**输出尾部**最多保留多少字符。
 *
 * 长任务的输出动辄几万行,全量进产出变量的话,一段训练日志就能把下游的提示词撑爆。
 * 只留尾部:错误栈、进度条、最终几行结果都在最后面 —— 那才是"跑完了之后要看的东西"。
 */
export const COMMAND_OUTPUT_TAIL_CHARS = 8_000;

/** 从节点参数里取命令行。空串当没填(必填校验在那边负责报错)。 */
export function commandOf(params: Record<string, unknown>): string {
  const raw = params[NODE_COMMAND_PARAM_KEY];
  return typeof raw === "string" ? raw.trim() : "";
}

/** 从节点参数里取超时。负数、不是数字,一律当不限 —— 宁可多等,不误杀。 */
export function commandTimeoutOf(params: Record<string, unknown>): number {
  const raw = params[NODE_COMMAND_TIMEOUT_KEY];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/* ── 对话节点的注入 ── */

/**
 * 对话节点参数 `injectMode` —— **发出去之前问不问**。
 *
 * `ask`(默认)是现状:弹卡片四选一(见 {@link ASK_CHOICES});`auto` 是"自动注入":
 * 把指令作为一条用户消息直接投进目标会话并起一轮,**发完即走** —— 不弹卡片、不等回答。
 * 它就是"长任务守望"的最后一步:命令跑完了,替你说一句话,让对话自己继续。
 */
export const NODE_INJECT_MODE_KEY = "injectMode";

export const INJECT_MODES = ["ask", "auto"] as const;
export type InjectMode = (typeof INJECT_MODES)[number];

/** 从节点参数里取注入模式。认不出的值一律当 `ask` —— 保守的那个方向。 */
export function injectModeOf(params: Record<string, unknown>): InjectMode {
  return params[NODE_INJECT_MODE_KEY] === "auto" ? "auto" : "ask";
}

/**
 * 对话节点参数 `injectTarget` —— **发到哪个会话**。
 *
 * `self`(默认)是现状:发进正在跑这张图的那条会话;`origin` 是"发起会话" —— 通过
 * 会话界面的「守望」按钮起跑的自动化,把按钮按下时的那条会话记在 automation 会话的
 * `parentSessionId` 上,`origin` 就解析到它。解析不到(比如从设置里手动跑)这一步
 * 明确失败,而不是悄悄发进自己。
 */
export const NODE_INJECT_TARGET_KEY = "injectTarget";

export const INJECT_TARGETS = ["self", "origin"] as const;
export type InjectTarget = (typeof INJECT_TARGETS)[number];

/** 从节点参数里取投递目标。认不出的值一律当 `self`。 */
export function injectTargetOf(params: Record<string, unknown>): InjectTarget {
  return params[NODE_INJECT_TARGET_KEY] === "origin" ? "origin" : "self";
}

/**
 * 「运行前先问我」那四个选项。
 *
 * ## 它们和 {@link BRANCH_STOP_CHOICE} 是同一个路数
 *
 * 都是**界面给的、不在图上**的哨兵 id:`WorkflowChooseSchema.edgeId` 是个必填字符串,
 * 空串在协议里已经表示"这次选择被取消了"(见 `RunPorts.choose`),所以这里必须另起
 * 一串谁也匹配不上的值。三层要认同同一份字符串 —— 渲染端拿它摆按钮和回传、调度器拿它
 * 分派行为 —— 所以定在 contracts。
 *
 * ## 四个各是什么
 *
 * | 常量 | 用户看到的 | 之后 |
 * |---|---|---|
 * | `ASK_RUN_CHOICE` | 用这一步的指令 | 照常跑,把用户在框里补的话接在指令后面 |
 * | `ASK_SKIP_CHOICE` | 跳过 | 这一步标成"没走这条路",下游照常按 `unselected` 传 |
 * | `ASK_REPEAT_CHOICE` | 重复上一个任务 | 上一步及其后续作废重跑,跑完**回到这一步再问一次** |
 * | `ASK_EXIT_CHOICE` | 退出流程 | 整张图收场;框里那段字作为主对话的下一条消息发出去 |
 *
 * `ASK_REPEAT_CHOICE` 在**没有上游**的节点上不出现 —— "上一步"根本不存在。
 */
export const ASK_RUN_CHOICE = "__ask_run__";
export const ASK_SKIP_CHOICE = "__ask_skip__";
export const ASK_REPEAT_CHOICE = "__ask_repeat__";
export const ASK_EXIT_CHOICE = "__ask_exit__";

/** 四个哨兵。顺序即界面上的顺序。 */
export const ASK_CHOICES = [
  ASK_RUN_CHOICE,
  ASK_SKIP_CHOICE,
  ASK_REPEAT_CHOICE,
  ASK_EXIT_CHOICE,
] as const;
export type AskChoice = (typeof ASK_CHOICES)[number];

export function isAskChoice(value: unknown): value is AskChoice {
  return typeof value === "string" && (ASK_CHOICES as readonly string[]).includes(value);
}

/**
 * **Mcode 真正实现了的** runner —— 清单里可以声明别的(为了形状),但调度器遇到
 * 未实现的会**明确拒绝执行**,不会静默跳过或假装成功。
 *
 * 放在 contracts 而不是主进程,是因为渲染端也要用它:画布上那种节点要标出"这个节点
 * 当前跑不了",否则用户画好一张图、发消息,才发现有一格是死的。
 */
export const IMPLEMENTED_RUNNER_KINDS = ["prompt", "conversation", "branch", "trigger", "command", "code"] as const;
export function isRunnerImplemented(kind: NodeRunnerKind): boolean {
  return (IMPLEMENTED_RUNNER_KINDS as readonly string[]).includes(kind);
}

/**
 * 这个清单**真的跑得起来吗** —— 比 {@link isRunnerImplemented} 更细的一层。
 *
 * `command` 有两种形状:命令来自**节点参数**的(内置)已实现;命令来自**清单自带
 * 脚本**的(`entry` 填了,第三方插件那种)只定了形状、还没实现。只看 kind 的话,
 * 第三方的 command 节点会在画布上标成"能跑"、真跑起来却失败 —— 两种说法必须
 * 收口成一个函数,调度器的拒绝与渲染端的"跑不了"徽标读同一份答案。
 */
export function isNodeRunnable(manifest: NodeTypeManifest): boolean {
  if (!isRunnerImplemented(manifest.runner.kind)) return false;
  if (manifest.runner.kind === "command" && manifest.runner.entry !== undefined) return false;
  return true;
}

/* ── 清单 ── */

export const NodeTypeManifestSchema = z.object({
  id: z.string().regex(NODE_TYPE_ID_RE, "类型 id 必须形如 作者.名字(小写,连字符分词)"),
  manifestVersion: z.literal(NODE_MANIFEST_VERSION),
  name: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
  /** 图标键,渲染端映射成具体图标;认不出的键回落成通用图标(不报错)。 */
  icon: z.string().optional(),
  /** 画布"添加节点"菜单里的分组。省略归入"其他"。 */
  category: z.string().optional(),
  runner: NodeRunnerSchema,
  /** 这个类型的**默认**能力。节点上可以覆盖(见 `WorkflowNode.capability`)。 */
  capability: WorkflowCapabilitySchema,
  params: z.array(NodeParamSpecSchema),
  /** 声明产出什么。纯说明 —— 给下游节点和结果卡片看,不做强制。 */
  outputs: z
    .array(z.object({ key: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  /** Declarative capability requirements checked before execution. Shape is
   *  shared with the plugin capability declaration (see `@contracts/capability`)
   *  so the two sides can never drift apart. */
  requirements: z.array(CapabilityRequirementSchema).optional(),
  /** 供**模型**看的用法说明。会被 `renderNodeTypeCatalog` 拼进系统提示词,让 AI 知道
   *  有这个节点、什么时候用、参数怎么填。这是"让 AI 自己改工作流"的前提 —— 它得先
   *  知道有什么可用。 */
  usage: z.string().optional(),
  /** 作者给的说明文档,相对清单目录的 markdown 路径。画布上可打开。 */
  doc: z.string().optional(),
});
export type NodeTypeManifest = z.infer<typeof NodeTypeManifestSchema>;

/** 一个可用节点类型,连同它是从哪来的。 */
export interface NodeTypeEntry {
  id: string;
  source: NodeTypeSource;
  /** 来源的可读标识:内置类型是 `"mcode"`,插件是插件名,本地是相对数据根的路径。 */
  from: string;
  manifest: NodeTypeManifest;
}

export const NODE_TYPE_SOURCES = ["builtin", "plugin", "local"] as const;
export type NodeTypeSource = (typeof NODE_TYPE_SOURCES)[number];

/** 一次节点类型加载的结果:能用的 + 读得见但用不了的。
 *
 *  **为什么 `problems` 必须一起返回**:一个格式错的清单如果被静默跳过,用户看到的
 *  现象是"我写的类型没出现",没有任何线索。界面要能把错误原样显示出来。
 *
 *  放在 contracts 而不是加载器里,是因为它是 `workflow.nodeTypes` 的**返回类型**,
 *  渲染端要按它渲染 —— 与其它 RPC 结果类型同一个位置。 */
export interface NodeTypeCatalog {
  entries: NodeTypeEntry[];
  problems: Array<{ file: string; error: string }>;
}

/** 同名冲突时的优先级,**大的赢**。与 `ipc/skills.ts` 的 `SOURCE_RANK` 同序。
 *
 *  注意 `builtin` 那一档在**类型 id** 上其实用不到(内置前缀是保留的,没人能占用),
 *  它只在内置**插件**随带的类型与代码里的类型相撞时才可能生效。 */
export const NODE_TYPE_SOURCE_RANK: Record<NodeTypeSource, number> = {
  builtin: 0,
  plugin: 1,
  local: 2,
};

/* ── 结果 ── */

export const NODE_OUTCOME_STATUSES = [
  "success",
  "failed",
  "cancelled",
  /** 上游失败/取消了,所以这一步没意义。**会往下游传** —— 下游也是 skipped。 */
  "skipped",
  /**
   * **没跑,但不是因为它坏了** —— 用户在分支节点上选了别的路,这一步不在那条路上。
   *
   * ## 为什么非得分出来
   *
   * 混进 `skipped` 的话,用户在断点上选了「进入查重」,卡片上「写作②」「写作③」会显示
   * 成**"上游没有成功"** —— 那是在说某一步炸了,而实际上什么都没炸,是**他自己选的路**。
   * 一句错的原因比没有原因更难查:他会去翻那几步的日志,而那里什么也没有。
   *
   * ## 它和"失败"在传播上的关键差别
   *
   * 失败会**污染汇合点**:现在的语义是"上游全都成功才派发",所以一条支路失败,下游的
   * 汇合节点整步跳过。而"没走的那条路"必须**当作它不存在** —— 分支之后两条支路在汇合点
   * 重新碰头时(「再来一轮」和「进入查重」最后都走到「导出」),用户选了一条,另一条标
   * `unselected`,而**「导出」必须照跑**。
   *
   * 所以调度器算"这一步能不能跑"时看的是**活跃的上游**(没走的那条边不算数),不是所有
   * 上游 —— 见 `orchestration/scheduler.ts` 的 `liveUpstreamOf`。往下游**传**的时候传的
   * 仍然是 `unselected`(而不是直接消失):"这一步为什么没跑"得有个说得出口的答案。
   */
  "unselected",
] as const;
export type NodeOutcomeStatus = (typeof NODE_OUTCOME_STATUSES)[number];

/**
 * 任何节点跑完都产出这个。**下游节点和对话里的结果卡片只看它**,不关心上游是子
 * agent 还是脚本 —— 这是"统一接口"在运行时的落点。
 */
export interface NodeExecutionRecord {
  executorKind: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/** A stable reference to a node-produced artifact. The bytes remain external. */
export interface NodeArtifact {
  kind: "file" | "directory" | "data";
  uri: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface NodeOutcome {
  status: NodeOutcomeStatus;
  /** 给下游节点和卡片看的文本。会拼进下游的指令里。 */
  summary: string;
  /** 结构化值:指标、任意 JSON。 */
  outputs?: Record<string, unknown>;
  /** 外部产物引用:文件、目录或数据资源。 */
  artifacts?: NodeArtifact[];
  execution?: NodeExecutionRecord;
  error?: string;
}

/**
 * **命令行节点的上报协议。** 脚本往 stdout 打一行以这个前缀开头的 JSON,就能上报
 * 进度或最终结果;不以它开头的输出按普通日志处理。
 *
 * ```
 * @@mcode:progress {"percent":40,"message":"已解析 120/300 页"}
 * @@mcode:result   {"summary":"解析完成","outputs":{"pages":300}}
 * ```
 *
 * 现在只定义、没人消费(没有 `command` 节点)。但**协议必须先定下来**:将来做自动化
 * (长跑训练要实时看 loss)时,格式一变,第三方已经写好的脚本就全废了。
 */
export const NODE_STDOUT_PROTOCOL_PREFIX = "@@mcode:";
export type NodeStdoutDirective = "progress" | "result";

/* ── 校验(纯函数) ── */

export type ManifestCheck =
  | { ok: true; manifest: NodeTypeManifest }
  | { ok: false; error: string };

/**
 * 校验一份清单。**装进来的时候和读出来的时候都要过这一道** —— 前者挡住格式错的
 * 第三方包,后者挡住用户/AI 手改坏的文件(那种文件在磁盘上,没人替你把关)。
 *
 * 除了 zod 的形状检查,还有三条**形状之外**的规则,它们都会让节点实际跑不起来:
 *  - `mcode.` 前缀只留给内置;
 *  - 参数键不能重复(重复的那个在画布上改不动);
 *  - 最多一个参数绑 stdin(两个的话后一个永远收不到值)。
 */
export function validateNodeTypeManifest(raw: unknown): ManifestCheck {
  const parsed = NodeTypeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}:` : "";
    return { ok: false, error: `节点类型清单校验失败(${where}${first?.message ?? "格式不对"})` };
  }
  const manifest = parsed.data;

  const seen = new Set<string>();
  for (const p of manifest.params) {
    if (seen.has(p.key)) return { ok: false, error: `参数键重复:${p.key}` };
    seen.add(p.key);
    if (p.kind === "select" && (p.options?.length ?? 0) === 0) {
      return { ok: false, error: `参数 ${p.key} 是下拉,但没有给选项` };
    }
    // 引用型参数的候选**不在清单里**,而在这台机器上 —— 所以 `from` 是它唯一的取数
    // 线索,缺了就没法渲染。这个错必须在**装进来的时候**就报,而不是等到用户把节点
    // 拖到画布上、看见一个空下拉、再回来猜为什么。
    if (p.kind === "ref" && p.from === undefined) {
      return { ok: false, error: `参数 ${p.key} 是引用型(ref),但没有说 from` };
    }
    if (p.kind !== "ref" && p.from !== undefined) {
      return { ok: false, error: `参数 ${p.key}:from 只在 kind 是 ref 时有意义` };
    }
    // `multiple` 只对**候选是一组值**的两种参数有意义。写在单值控件(文本、数字、
    // 文件路径)上是个笔误:那些控件的值就是它本身,没有"多选"可言。
    if (p.multiple !== undefined && p.kind !== "ref" && p.kind !== "select") {
      return { ok: false, error: `参数 ${p.key}:multiple 只在 kind 是 ref 或 select 时有意义` };
    }
  }

  const stdinCount = manifest.params.filter((p) => p.bind?.kind === "stdin").length;
  if (stdinCount > 1) return { ok: false, error: "最多只能有一个参数绑定 stdin" };

  return { ok: true, manifest };
}

/** 参数值是否满足清单的要求。**存盘前和解算前各跑一次** —— 存盘时挡住错的,解算时
 *  挡住"清单改过、老节点还带着旧参数"的情况。 */
export function validateNodeParams(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  for (const spec of manifest.params) {
    const value = params[spec.key];
    if (value === undefined || value === null || value === "") {
      if (spec.required) return { ok: false, error: `参数「${spec.label}」是必填的` };
      continue;
    }
    if (spec.kind === "number" && typeof value !== "number") {
      return { ok: false, error: `参数「${spec.label}」应该是数字` };
    }
    if (spec.kind === "boolean" && typeof value !== "boolean") {
      return { ok: false, error: `参数「${spec.label}」应该是开关` };
    }
    if (spec.kind === "select" && spec.multiple) {
      const allowed = (spec.options ?? []).map((o) => o.value);
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return { ok: false, error: `参数「${spec.label}」应该是一组选项` };
      }
      const bad = value.find((v) => !allowed.includes(v as string));
      // **多选也要查取值在不在选项里** —— 单选那条查的就是这个,多选少查一遍的话,
      // 手改过的清单能塞进一个界面上根本不存在的类目,而它会被静静地"继承"下去。
      if (bad !== undefined) {
        return { ok: false, error: `参数「${spec.label}」的取值不在选项里:${String(bad)}` };
      }
    } else if (spec.kind === "select" && typeof value === "string") {
      const allowed = (spec.options ?? []).map((o) => o.value);
      if (!allowed.includes(value)) {
        return { ok: false, error: `参数「${spec.label}」的取值不在选项里:${value}` };
      }
    }
    // 引用型:多选是一组名字,单选是一个名字。**只查形状,不查名字存不存在** ——
    // 候选在这台机器上,同一份工作流换台机器跑,那个技能可能就没装。存盘时按"名字
    // 在不在当前机器上"拒绝,等于让工作流没法分享(同 `@contracts/workflow` 里
    // "类型缺失不算错误"那条)。
    if (spec.kind === "ref") {
      const bad = spec.multiple
        ? !Array.isArray(value) || value.some((v) => typeof v !== "string")
        : typeof value !== "string";
      if (bad) {
        return {
          ok: false,
          error: `参数「${spec.label}」应该是${spec.multiple ? "一组名字" : "一个名字"}`,
        };
      }
    }
    // 变量表:一项一项的 `{ name, example }`。**只查形状** —— "名字不能重复""不能叫
    // output"那种是**产出约束**那个用法的规矩,归 `@contracts/outputConstraint` 管。
    // 这个 kind 本身只是"一张两栏的表",别的用途可以有自己的规矩。
    if (spec.kind === "variables") {
      if (!Array.isArray(value)) {
        return { ok: false, error: `参数「${spec.label}」应该是一张表` };
      }
      const bad = value.some(
        (v) =>
          typeof v !== "object" ||
          v === null ||
          typeof (v as { name?: unknown }).name !== "string" ||
          typeof (v as { example?: unknown }).example !== "string",
      );
      if (bad) {
        return { ok: false, error: `参数「${spec.label}」里有一项不是「名字 + 示例」` };
      }
    }
    // 输入选项表:一项一项的 `{ name, content, note? }`。**只查形状,容忍空行** ——
    // 编辑态里"刚点了加号还没填"的那一行必须存得下来(和 `varRows` 的读法同一条),
    // 名字空的行到了聊天那边自然不进下拉框。
    if (spec.kind === "options") {
      if (!Array.isArray(value)) {
        return { ok: false, error: `参数「${spec.label}」应该是一张表` };
      }
      const bad = value.some(
        (v) =>
          typeof v !== "object" ||
          v === null ||
          typeof (v as { name?: unknown }).name !== "string" ||
          typeof (v as { content?: unknown }).content !== "string",
      );
      if (bad) {
        return { ok: false, error: `参数「${spec.label}」里有一项不是「名字 + 内容」` };
      }
    }
    // 固定条件表:一项一项的 `{ name, choices[] }`。**只查形状,容忍空行** —— 编辑态里
    // "刚点了加号还没填"的那一行必须存得下来;候选值空一行(用户打了个回车)也不算错,
    // 渲染端会把空串滤掉。
    if (spec.kind === "selects") {
      if (!Array.isArray(value)) {
        return { ok: false, error: `参数「${spec.label}」应该是一张表` };
      }
      const bad = value.some(
        (v) =>
          typeof v !== "object" ||
          v === null ||
          typeof (v as { name?: unknown }).name !== "string" ||
          !Array.isArray((v as { choices?: unknown }).choices) ||
          (v as { choices: unknown[] }).choices.some((c) => typeof c !== "string"),
      );
      if (bad) {
        return { ok: false, error: `参数「${spec.label}」里有一项不是「条件名 + 一串候选值」` };
      }
    }
  }
  return { ok: true };
}

/** 给新节点铺一份参数:取每个 spec 的默认值,没有默认值的必填项落一个**空值**
 *  (让画布上立刻可见、立刻能填,而不是一个空对象看不出缺什么)。
 *
 *  空值按形状给:开关是 `false`、一列东西(`multiple` 与变量表)是 `[]`、其余是空串。
 *  多选要是落了空串,那个值的类型就和它声明的 `string[]` 对不上 —— 界面上暂时看不出
 *  问题(两种都被当成"没选"),但同一个参数会因此有两种"空"的写法,而它们迟早会在某个
 *  `Array.isArray` 上分家。 */
export function defaultParamsOf(manifest: NodeTypeManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of manifest.params) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
    else if (spec.required) {
      out[spec.key] = spec.kind === "boolean" ? false : isListKind(spec) ? [] : "";
    }
  }
  return out;
}

/** 这个参数的值是不是一列东西(空值该给 `[]` 而不是空串)。 */
function isListKind(spec: NodeParamSpec): boolean {
  return (
    spec.kind === "variables" ||
    spec.kind === "options" ||
    spec.kind === "selects" ||
    (spec.multiple === true && (spec.kind === "ref" || spec.kind === "select"))
  );
}

/* ── 给模型看的目录 ── */

/**
 * 一个参数在目录里怎么写 —— 一行一个参数,缩进在「参数:」下面。
 *
 * 三个不能省的东西,各对应一种"模型一定会猜错"的失败:
 *
 * 1. **值的形状**(`ref:string` 还是 `ref:string[]`)。引用型的候选在**用户的机器上**,
 *    模型看不见那份列表,只能靠这里的声明知道该往 `params` 里写什么。不写的话它只能
 *    猜,而猜错的代价是一次存盘失败(见 `NODE_PARAM_REF_SOURCES`)。
 * 2. **下拉的候选值**。同理:它看不到那个选择框,不列出来只能自己编一个,而
 *    `validateNodeParams` 会直接拒掉。
 * 3. **`label` 与 `help`**。它们是清单作者写给这个参数的解释,而**模型就是那个要填的
 *    人** —— 只给 `outputVars(variables)` 而不说"一样一行、变量名是下游引用时用的词",
 *    它填出来的东西形状对、意思不对。
 */
function describeParam(p: NodeParamSpec): string {
  const multi = p.multiple === true && (p.kind === "ref" || p.kind === "select");
  const kind = p.kind === "ref" ? `ref:${multi ? "string[]" : "string"}` : multi ? `${p.kind}:string[]` : p.kind;
  const head = `    - ${p.key}(${kind}${p.required ? ",必填" : ""}) **${p.label}**`;
  const help = p.help ? ` —— ${p.help}` : "";
  const options =
    p.kind === "select" && p.options && p.options.length > 0
      ? `
      可选值:${p.options.map((o) => o.value).join(" | ")}`
      : "";
  // 值既不是标量、也不是标量数组的参数种类,形状单独说一句 —— 它猜不出来。
  const shape =
    p.kind === "variables"
      ? `
      值的形状:[{ name: 变量名, example: 示例 }]`
      : p.kind === "options"
        ? `
      值的形状:[{ name: 选项名, content: 选中后插进输入框的内容, note: 给模型的一句解释 }]`
        : p.kind === "selects"
          ? `
      值的形状:[{ name: 条件名, choices: ["候选值", ...] }] —— 一行一个下拉框,候选值就是下拉里能选的那些`
          : "";
  return `${head}${help}${options}${shape}`;
}

/**
 * 把当前可用的节点类型渲染成一段文字 —— **"这个环境里有哪些节点"的唯一定义**。
 *
 * **为什么非有不可**:用户让 AI"把这个流程改成先下载再解析",AI 得先知道存在哪些
 * 节点类型、各自的参数叫什么。不知道的话它只能凭空编一个类型 id,而那张图存不下
 * 去(校验会拒绝)。这和 `fileArchitecturePrompt` 解决的是同一类问题 —— 把"环境里
 * 有什么"告诉模型,它才不用猜。
 *
 * ## 谁在读它
 *
 * 现在是 `mcp__mcode-workflow__node_types_list` 这个工具的返回(`main/mcp/mcodeServer.ts`)
 * —— AI 主动问"有哪些节点类型能用"时现读一份。写这个函数的时候设想的是"拼进系统
 * 提示词",但那个方案在本项目行不通:每轮都重发一份目录是**常驻的 token 开销**,
 * 而这个目录只有真要改工作流时才用得上。工具化之后它变成按需的,内容却一模一样。
 *
 * ## 为什么是文字而不是 JSON
 *
 * 模型读列表式的短文本比读一大坨 JSON 便宜,而且这里只需要它认得 id 和参数名,
 * 不需要精确的结构。
 */
export function renderNodeTypeCatalog(entries: NodeTypeEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [
    `## 可用的工作流节点类型`,
    `用户在设置里画工作流时,每个节点要选一个**类型**并填它的参数。当前可用:`,
    ``,
  ];
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const m = entry.manifest;
    lines.push(`- \`${m.id}\` **${m.name}** —— ${m.description ?? "无说明"}`);
    lines.push(`  能力:${m.capability}`);
    if (m.params.length === 0) {
      lines.push(`  参数:无`);
    } else {
      lines.push(`  参数:`);
      for (const p of m.params) lines.push(describeParam(p));
    }
    if (m.usage) lines.push(`  用法:${m.usage}`);
    // 声明的能力依赖也进目录:模型(和读目录的人)得知道"用这种节点要装什么" ——
    // 否则它画出一个引用了没装技能的节点,要到运行前才被告知跑不了。
    if (m.requirements?.length) {
      const text = m.requirements
        .map((r) => `${r.kind}:${r.id}${r.capabilities?.length ? `(${r.capabilities.join("+")})` : ""}`)
        .join(", ");
      lines.push(`  依赖:${text}`);
    }
    if (!isNodeRunnable(m)) {
      // **判据必须是 isNodeRunnable,不能只看 kind。** `command` 有两种形状:命令来自
      // 节点参数的(内置 `mcode.command`)已实现,命令来自清单自带脚本的(`entry` 填了)
      // 还没实现。只看 kind 会把内置 command 也说成"跑不了" —— 而模型是**照着这段字
      // 建图的**,说错它就会绕开命令节点、改用又贵又慢的模型节点。
      const why =
        m.runner.kind === "command" && m.runner.entry !== undefined
          ? "脚本型命令(command 自带 runner.entry)尚未实现"
          : `执行方式 ${m.runner.kind} 尚未实现`;
      lines.push(`  ⚠️ 这个类型当前**跑不了**(${why}),只能画进图里。`);
    }
  }
  return lines.join("\n");
}
