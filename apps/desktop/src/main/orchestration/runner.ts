/**
 * 一个节点在界面上叫什么:**用户起的标题 > 清单里的名字 > 类型 id**。
 *
 * 与画布上的卡片、检查器里的标题**是同一条链**(渲染端那份在
 * `components/settings/workflows/workflowView.ts`)。这里再写一遍是因为那份在渲染端 ——
 * 但**链本身必须一样**:不一样的话,一个没起标题的节点在画布上叫「子 agent」、在对话
 * 的结果卡上却叫 `mcode.agent`。
 *
 * (调度器里还有第三份,只有 `title || type` 两级 —— 它拿不到清单:`manifestOf` 是异步的,
 * 而调度器刻意保持"不看清单也能走完"。那里的回退少一级是诚实的。)
 */
function displayTitle(node: WorkflowNode, manifest: NodeTypeManifest | undefined): string {
  if (node.title.trim().length > 0) return node.title;
  return manifest?.name ?? node.type;
}

/**
 * 工作流节点的**真实执行器** —— 把调度器的 {@link RunPorts} 接到会话与回合上。
 *
 * ## 一个节点 = 一个隐藏子会话(`kind: "node"`)
 *
 * 这不是新机制。`SideChatPanel` 的文件头记着同构的做法已经在跑:side chat 是完整
 * 会话、与父会话**完全并发**地跑回合与审批、不进左栏、历史跨重启保留。节点要的
 * 正是这四件事(并发 / 隐藏 / 审批路由 / 持久化),所以复用它而不是另造一套。
 * 左侧列表那几个查询本来就按 `kind = 'chat'` 过滤,节点**不需要额外做什么**就不会
 * 进去 —— 前提是 `repositories.ts` 里那个 row→对象的三值转换没漏(那里曾经是二值)。
 *
 * ## 交互事件代父对话提问
 *
 * 节点跑在自己的子会话里,所以它的 `AskUserQuestion` 默认会弹在一个用户看不到的
 * 地方。修法是**改写事件的目的地**(`runtimeManager.setInteractiveProxy`),而不是
 * 发明暂停/恢复协议:审批池是按 `requestId` 全局扁平索引的,所以用户点选项之后
 * `resolveApproval(requestId, …)` 精确唤醒的是**节点会话**里那个 pending promise,
 * 不需要任何回程改造。由此 "always allow" 的书签也留在节点会话上 —— **per-node
 * 权限因此白拿**。
 *
 * ⚠️ 这一版**不做写隔离**:所有节点跑在父会话的 cwd。并行的写节点会互相踩,这是
 * 方案里写明的已知限制(`env_mode='worktree'` 是将来 per-node 隔离的现成挂点)。
 *
 * ## 进程死了怎么办
 *
 * 上面那一整套**全在内存里** —— 节点会话、流程记录、用户点过的岔路口。应用一关就
 * 什么都不剩,包括一张已经停在岔路口等了半天的图。而那张卡片**还在对话记录里**
 * (`messages` 表是持久化的),按钮也还在,点下去却只会得到一句"这条选择已经不适用了"。
 *
 * 所以每次状态真的变了就写一份**存档**(见 `runStore.ts`):
 *
 *  - 开跑、某一步定案、停在岔路口、收尾 —— 四个时刻,不是每个 token;
 *  - 下一次启动时,上一次还在跑的那些会被标成 `interrupted`(见 `db.ts` 的 `migrate`);
 *  - 用户点那张旧卡片 → {@link resolveWorkflowChoice} 找不到活着的等待,就去查存档,
 *    查到就**把那次运行接回来**(见 {@link resumeRun})。
 *
 * 节点会话是回不来的(它们随进程一起没了),所以**跑到一半的那一步会重跑**。已经定过案
 * 的一律不重跑,也不重判 —— 见 `RunResume`。
 */
import type { Session } from "@contracts/session";
import { WORKFLOW_MAX_PARALLEL_SETTING_KEY } from "@contracts/ipc";
import {
  ASK_EXIT_CHOICE,
  injectModeOf,
  injectTargetOf,
  isAskChoice,
  isModelDecider,
  returnModeOf,
  type NodeOutcome,
  type NodeReturnMode,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import { checkOutput, outputValueText, outputVarsFor, outputVarsOf, pickOutputs, type OutputVar } from "@contracts/outputConstraint";
import type { PermissionMode, WorkflowChoiceOption } from "@contracts/runtime";
import {
  edgeOptionNameOf,
  outgoingEdgesOf,
  workflowNodeRefName,
  type WorkflowCapability,
  type WorkflowNode,
} from "@contracts/workflow";
import { injectEntryCriteria } from "./criteriaInject.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { transcriptText } from "@main/claude/nodeTranscript.js";
import { ExecutionEngine } from "./executionEngine.js";
import { CodeExecutor } from "./codeExecutor.js";
import { CommandExecutor } from "./commandExecutor.js";
import { libraryRoot } from "@main/library/paths.js";
import { broadcastRuntimeEvent } from "@main/lib/sessionSync.js";
import { queueBackflow } from "@main/lib/pendingBackflow.js";
import { log } from "@main/lib/logger.js";
import { providerRegistry } from "@main/providers/registry.js";
import { CollectionRepo, LibraryRepo, MessageRepo, SessionRepo, SettingRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import { templatesRoot } from "@main/templates/store.js";
import { uid } from "@main/utils.js";
import {
  inheritContextLines,
  kindLabel,
  type ContextLookup,
} from "./contextInherit.js";

/**
 * 一张图默认**同时最多几个节点在跑**。
 *
 * 4 是个务实的起点:宽图(检索那种一个主题一路的)够用,而本机不会同时起太多 CLI
 * 子进程。用户可以在设置里改(见 `@contracts/ipc` 的 `WORKFLOW_MAX_PARALLEL_SETTING_KEY`)。
 */
export const WORKFLOW_MAX_PARALLEL_DEFAULT = 4;

/**
 * 节点跑着的时候,主进程**多久检查一次**卡片上那行字该不该换。
 *
 * 这是「检查」的节拍,不是「发言」的节拍 —— 真正发出去多少由下面那两道闸门决定。
 * 检查只是在内存里算一个字符串,比一次 IPC 便宜得多,所以它可以密。
 */
export const NODE_PROGRESS_TICK_MS = 1_000;

/**
 * 一步都不动的时候(没有新工具、没有新子代理),卡片上那行字**最少隔多久**动一次。
 *
 * ## 为什么必须有这道闸门
 *
 * 这一类的节点(模型轮)跑 20~40 分钟是常事,而这期间引擎可能很久不吐一条流水:
 * 工具调用之间往往隔着好几分钟,子代理派出去之后主代理更是一个字都不发。**那段静默
 * 恰恰是最像卡死的时候**,所以秒表得自己走 —— 用户的原话是「转圈转了四十分钟,看起来
 * 和卡死没有区别」。
 *
 * 但「自己走」不能变成「一秒一条」:40 分钟就是两千多条,每一条都要走一遍
 * `ingestEvent` → 折叠进卡片 → React 重渲染。渲染端扛得住这个量,可拿消息流倒这么
 * 多条只承载「又一个秒过去了」的东西,就是把信噪比做没了 —— 而**内容真变了**(换了
 * 工具、换了子代理)的那几条,恰恰会被淹在里面看不见。
 *
 * ## 5 秒是怎么定的
 *
 * 用户盯着看的是一串在变的数字,5 秒一跳足够让人确信它活着(再快也只是让同一句话
 * 重复得更密)。稳态下 40 分钟最多 480 条,比「一秒一条」少一个数量级,而「有没有在动」
 * 这件事一个字都没减。
 *
 * **信息量不受这个窗口约束**:工具 / 子代理换了按 {@link NODE_PROGRESS_TICK_MS} 那道
 * 更短的闸门走 —— 那是内容,不是节拍。
 */
export const NODE_PROGRESS_HEARTBEAT_MS = 5_000;

/**
 * 节点收场之后**过多久再回来问一次花费**。
 *
 * 用量是那个回合结束之后异步推上来、再结算落库的,而结算有一个**宽限计时器**
 * (`RuntimeManager` 的 `TURN_END_SETTLE_GRACE_MS = 4s`)—— 比它短就等于白问一次,
 * 而且**只有一次机会**(补发只排一次,见 `scheduleUsageBackfill`)。
 *
 * 所以取 6 秒:盖过那个宽限,又短到用户还看着这张卡片。代价是那 6 秒里卡片上少一行
 * 花费 —— 它本来也不影响任何别的事。
 */
const USAGE_BACKFILL_DELAY_MS = 6_000;
import { getWorkflow } from "./library.js";
import { loadNodeTypes } from "./nodeTypes.js";
import {
  decodeSnapshot,
  pruneRuns,
  resumableRun,
  retryableRun,
  saveRun,
  type RunSnapshot,
} from "./runStore.js";
import {
  runWorkflow,
  type BranchChoice,
  type CapabilityPreflight,
  type NodeRunInput,
  type RunPorts,
  type RunResult,
  type RunState,
} from "./scheduler.js";
// 能力预检的清单装配(G4/CAP):纯函数翻译层在 `capabilityResolver.ts`,已启用插件的
// 清单来自 pluginManager(异步读盘,所以端口做成 Promise,并按次运行缓存)。
import { collectCapabilityInventory } from "./capabilityResolver.js";
import { getEnabledPlugins } from "@main/plugins/pluginManager.js";

/**
 * 能力 → 权限模式的映射(方案「能力」那张表)。粗粒度是**刻意的**:v1 只到
 * "这一步大概会做什么",按工具名的白/黑名单留到以后。
 *
 * `read` 映射到 `plan` 不是"禁止写",而是**让写变得可见**:写类工具一律弹审批,
 * 用户看得见就不算悄悄发生。项目边界的硬拒是另一套,始终生效、不受这里影响。
 */
export function permissionModeForCapability(capability: WorkflowCapability): PermissionMode {
  switch (capability) {
    case "read":
      return "plan";
    case "write":
      return "acceptEdits";
    case "exec":
    case "net":
      return "default";
  }
}

/** 这个工作流是一张**图**吗(有节点)。提示词型工作流不走调度器。 */
export function isGraphWorkflow(workflowId: string): boolean {
  const doc = getWorkflow(workflowId);
  return doc !== null && doc.nodes.length > 0;
}

/**
 * 发送一条消息时,这个会话该怎么走。
 *
 * **两个传输层共用这一处判断** —— 桌面 IPC 与手机 RPC 各写一遍的话,下一次改行为
 * (比如起跑时多广播一个事件)只会改到一边,两端就悄悄分家了。调用方只负责把
 * `"busy"` 翻成自己那种错误(`Error` / `RpcError`)。
 *
 * `"busy"` 是有意**报错**而不是静默丢消息:图跑到一半通常是卡在某个节点的问题上
 * 等着回答,这时用户又发了一条 —— 吞掉它等于让人对着空气说话。
 */
export function graphRunIntent(session: Session): "none" | "start" | "busy" {
  // **只有对话会跑图。** 节点会话现在继承父对话的 `workflowId`(理由见
  // `createNodeSession`),所以不拦这一道的话,将来任何一条"往节点会话发消息"的路径
  // 都会**递归地再起一张图** —— 而那种坏法要跑一遍才看得见。
  if (session.kind !== "chat") return "none";
  if (!isGraphWorkflow(session.workflowId)) return "none";
  return hasActiveRun(session.id) ? "busy" : "start";
}

interface ActiveRun {
  runId: string;
  /** 哪个对话。它本来可以从 `runs` 的键推出来,但 `parkedRunTeardown` 那一头要按
   *  它筛等待池里的条目,而那张池子的键是 `runId:nodeId`。 */
  sessionId: string;
  abort: AbortController;
  /** 这次运行建出来的节点会话。收尾时要按它们放掉运行时。 */
  nodeSessionIds: Set<string>;
  /** 图上的节点 id → 跑它的那个会话 id。
   *
   *  卡片要靠它去取"这一步的过程"(`workflow.node.transcript` 按会话 id 索引,见
   *  `@contracts/runtime`)。**调度器不知道这件事** —— 它只认 `WorkflowNode` ——
   *  所以对应关系在这里记,广播结果事件时补上去。 */
  nodeSessionOf: Map<string, string>;
  /** 此刻**有几个节点正在跑**。0 且有人在等 = 整张图停着等人,见 `parkedRunTeardown`。 */
  executing: number;
  /** 这次运行**彻底收干净了**(节点会话放掉、地图条目删掉)。见 `parkedRunTeardown`。 */
  settled: Promise<void>;
  /** 落地 {@link ActiveRun.settled} 的那一下。 */
  finish: () => void;
}

/** 一个对话同一时刻只跑一次图。`sessionId → run`。 */
const runs = new Map<string, ActiveRun>();

/* ────────────────────────── 岔路口 ────────────────────────── */

/**
 * 正在等用户拍板的一次选择。
 *
 * **key 是 `runId:nodeId`,不是 `nodeId`。** 同一张图跑第二次时,节点 id 和第一次
 * 一模一样 —— 只按 `nodeId` 索引的话,用户在**上一轮那张旧卡**上点一下,会去唤醒
 * 这一轮的等待,而这一轮问的根本不是同一件事。`runId` 每次运行都是新的(见
 * `ActiveRun.runId`),带上它就分得开。
 *
 * 为什么一个会话里会有多条同时挂着:两个分支节点可以**同时就绪**(它们互不依赖),
 * 于是两条都在等人。用户先点哪条都行。
 */
interface PendingChoice {
  sessionId: string;
  /** 落地这一次等待。**调用方保证幂等**(见 `resolveWorkflowChoice`)。 */
  done: (choice: BranchChoice) => void;
}

const pendingChoices = new Map<string, PendingChoice>();

function choiceKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

/**
 * 用户在界面上点了某个岔路口的一个选项。
 *
 * 返回"这一下**起作用了**" —— 要么唤醒了一条活着的等待,要么接回了一次上次被中断的
 * 运行。返回 `false` 的那个含义是"这张卡已经不适用了",而它**不是错误**:用户点一张
 * 早就跑完的旧卡是正常会发生的事(见 `BranchChoiceCard`)。
 *
 * ## 两条来源,一条出路
 *
 *  - **活着的等待**:这次运行还挂在调度器的一个 promise 上(见 `RunPorts.choose`),
 *    直接唤醒它,图从那个节点接着往下跑。
 *  - **上一次进程留下的**:应用被关掉过,那时正停在这一格等人。那一行存档还在
 *    (见 `runStore.ts`),把那次运行**接回来** —— 已经成功过的步骤不重跑。
 *
 * 两条路都归到这里,是因为**界面上的那个点击是同一个动作**:用户在回答"这一步怎么走",
 * 而"那次运行还活着吗"是他看不见的、也不该知道的事。
 */
export function resolveWorkflowChoice(args: {
  sessionId: string;
  runId: string;
  nodeId: string;
  edgeId: string;
  comment?: string;
}): boolean {
  const key = choiceKey(args.runId, args.nodeId);
  const pending = pendingChoices.get(key);
  // **会话要对得上。** `runId` 已经是全局唯一的,这一道是防"另一个对话拿着一个
  // 拼错的 runId 把这次等待点掉" —— 那种事不该发生,但真发生了会表现为"图莫名其妙
  // 往下跑了",而没有任何地方看得出是谁点的。
  if (pending && pending.sessionId === args.sessionId) {
    const comment = (args.comment ?? "").trim();
    pending.done({ edgeId: args.edgeId, ...(comment.length > 0 ? { comment } : {}) });
    return true;
  }
  return resumeRun(args);
}

/**
 * 用户点的是一张**上一次留下的卡片** —— 把那次运行接回来。
 *
 * ## 为什么凭据是"会话 + 节点",不是"最近一次运行"
 *
 * 见 `WorkflowRunRepo.resumableFor`:一个对话里跑过两轮之后,点第一轮那张旧卡不该去
 * 续第二轮 —— 它们问的根本不是同一件事。
 *
 * ## 找不到就静静地返回 false
 *
 * 那张卡片属于一次已经跑完 / 被取消 / 被别人续过的运行,或者存档读不回来了。三种都
 * 是"这张卡过期了",而界面上那句话正是这么写的。**不抛错** —— 弹一个错误框只会让
 * 用户以为自己做错了什么。
 */
function resumeRun(args: {
  sessionId: string;
  nodeId: string;
  edgeId: string;
  comment?: string;
}): boolean {
  const found = resumableRun(args.sessionId, args.nodeId);
  if (found === null) return false;
  // 会话可能已经被删了(存档那一行的外键是 `ON DELETE CASCADE`,但渲染端手上那张
  // 卡片是更早读进来的)。
  const session = SessionRepo.get(args.sessionId);
  if (session === undefined) return false;
  // **这个对话换过工作流了。** 存档里那份状态是按**当时那张图**记的(nodeId、边的 id、
  // 流程记录都对着它),拿着去跑现在这张图,结果是随机的 —— 而且不报错。当作那张卡
  // 过期,用户重新发一条消息就是了。
  if (session.workflowId !== found.workflowId) {
    log.warn(
      `workflow run ${found.runId}: 会话现在用的是 ${session.workflowId},不是当时的 ` +
        `${found.workflowId} —— 这张卡片按过期处理`,
    );
    return false;
  }
  const comment = (args.comment ?? "").trim();
  log.info(
    `workflow run ${found.runId} resumed: node ${args.nodeId} chose ${args.edgeId} (${args.sessionId})`,
  );
  // **不 await**:一次运行可能几分钟,而这是从 IPC handler 里同步回来的 —— 让它
  // 立刻返回,和 `startWorkflowRun` 在别处的用法一致(见那里的注释)。
  void startWorkflowRun({
    session,
    cwd: found.snapshot.cwd,
    prompt: found.snapshot.prompt,
    resume: {
      runId: found.runId,
      snapshot: found.snapshot,
      nodeId: args.nodeId,
      answer: { edgeId: args.edgeId, ...(comment.length > 0 ? { comment } : {}) },
    },
  });
  return true;
}

export function hasActiveRun(sessionId: string): boolean {
  return runs.has(sessionId);
}

/**
 * 用户**在某一步上**点了「从这儿接着跑」—— 可能是一张失败卡上的「再试一次」,也可能是
 * 在图上挑了一步说"从这儿往下走"。
 *
 * ## 和「接着上次跑」是同一条路,只多一个 `rewind`
 *
 * 存档里 `state.outcomes` 是**整张图的完整结局表**(哪一步成功、哪一步失败、哪一步
 * 没走,全在)。所以 `settled` 本来就够用 —— 要做的只有一件事:**告诉调度器从哪一步
 * 开始重跑**(见 `RunResume.rewind`),由它把那一步连同全部前进后代从结局表里抹掉。
 *
 * 展开闭包是**调度器**的事(它是唯一知道"谁是谁的后代"的地方),这里只给出起点。
 *
 * ## 两种起点,区别只在那一句提示词
 *
 * 判据是那一步上次的结局({@link RetryableRun.outcome}):
 *
 *  - `failed` —— 用户点的是失败卡片,他多半还写了「上次哪里不对」。那句话要带上
 *    ({@link RunResume.note}),而且**只给被点名的那一步看**。
 *  - 别的 —— 用户在图上挑的起点。**不带 `note`**:他没写,而且"从这一步往下"这句话
 *    本身已经由调度器那边补上了(见它 `init` 里 `presetChoices` 那一段)。
 *
 * 两条后面走的是**同一份代码**。分开写的话,"重跑一段"这件事迟早会有两种行为。
 *
 * ## 几种"这张卡不适用了",全都**不是错误**
 *
 * 找不到那次运行 / 那一步不在存档里 / 存档读不回来 —— 与
 * {@link resolveWorkflowChoice} 同一个口径:用户点一张旧卡是正常会发生的事,该得到
 * 一句"已经不适用了",而不是一个错误框。
 *
 * 返回 `false` 的另一个理由更实在:**这个对话正有运行在跑**。`startWorkflowRun` 那句
 * `runs.has` 的守卫会**静静地返回 null**(见那里的注释),而调用方照样会拿到 true ——
 * 于是用户点了按钮、卡片变了、什么都没发生。所以这里**先查一次**,查到了就照实回 false。
 */
export function resolveWorkflowRetry(args: {
  sessionId: string;
  runId: string;
  nodeId: string;
  /** 用户写的那句话。空串 = 没写(那就只重跑,不往提示词里加东西)。 */
  note?: string;
}): boolean {
  const session = SessionRepo.get(args.sessionId);
  if (session === undefined) return false;
  // **正有运行在跑** —— 见上面那段注释:`startWorkflowRun` 撞上这个会静静地不做事,
  // 而调用方照样拿到 true。所以先查一次,查到了就照实回 false。
  if (runs.has(args.sessionId)) return false;
  // 三道门(找不到 / 存档坏了 / 那一步不在结局表里)全在 `retryableRun` 里,与岔路口
  // 续跑的 `resumableRun` 并列 —— 那些判据值得单独测,不该埋在 IPC 后面。
  const found = retryableRun(args.sessionId, args.runId, args.nodeId);
  if (found === null) return false;
  // 这个对话换过工作流了 —— 存档里那份状态是按**当时那张图**记的,拿去跑现在这张图
  // 结果是随机的(同 `resumeRun` 里那一段)。
  if (session.workflowId !== found.workflowId) {
    log.warn(
      `workflow run ${found.runId}: 会话现在用的是 ${session.workflowId},不是当时的 ` +
        `${found.workflowId} —— 这张卡片按过期处理`,
    );
    return false;
  }

  /**
   * **用户写的那句话,只在"上一次真的失败过"时才带。**
   *
   * 从图上挑起点时他压根没写过 —— 而界面那一头调的是同一条 RPC,`note` 缺席。真按
   * "有没有 note"判的话,一次普通的"从这儿往下"会被当成重试,而提示词里会多出一段
   * 「用户选择的是「再试一次」」—— 说的是他没做过的事。
   */
  const note = found.outcome.status === "failed" ? (args.note ?? "").trim() : "";
  log.info(
    `workflow run ${found.runId}: 从 ${args.nodeId} 重跑(${found.outcome.status}) (${args.sessionId})`,
  );
  // **不 await** —— 同 `resumeRun`:这是一次可能跑几分钟的运行,IPC handler 该立刻返回。
  void startWorkflowRun({
    session,
    resume: {
      runId: found.runId,
      snapshot: found.snapshot,
      nodeId: args.nodeId,
      // 起点只有这一步;闭包由调度器展开(见 `RunResume.rewind`)。
      rewind: [args.nodeId],
      ...(note.length > 0 ? { note: { nodeId: args.nodeId, text: note } } : {}),
    },
  });
  return true;
}

/**
 * 这个对话的图**停着等人**吗 —— 没有任何节点在跑,只有几处岔路口挂着等人拍板。
 *
 * 这是"用户能不能直接说话"的判据。停着等人的时候,整张图唯一在做的事就是等他,而他
 * 完全可以不听那一套、直接把话说出来 —— 那一头的 `parkedRunTeardown` 会把这次运行
 * 让开,按他刚说的重来。
 *
 * **有一个节点真在跑就不算**。半路掐掉一个正在干活的步骤是另一件事(那是「停止」
 * 按钮,见 `cancelWorkflowRun`),不该由"我发了条消息"顺手做掉。
 */
export function isRunParked(sessionId: string): boolean {
  const active = runs.get(sessionId);
  if (!active || active.executing > 0) return false;
  for (const pending of pendingChoices.values()) {
    if (pending.sessionId === sessionId) return true;
  }
  return false;
}

/**
 * 用户又发了一条消息,而图正停在原地等人 —— **放弃那一次,等他收干净**。
 *
 * 返回 null 表示"没有可以放弃的"(有节点在跑,或者压根没有运行)—— 调用方据此决定
 * 是照旧报"这个工作流还在跑",还是让它过去。
 *
 * ## 为什么要等它收干净,而不是删掉条目就走
 *
 * 那次运行的收尾会做两件**和下一次运行抢同一块地方**的事:补一个 `turn.done`
 * (渲染端靠它收掉当前回合),以及 `runs.delete(sessionId)`。所以:
 *
 *  - 先删条目再起新的、又不认身份 → 旧的收尾会把**新的**那次从地图上删掉,而新的还在
 *    跑 —— 于是这个对话从此谁都拦不住了(再发消息会叠第二张图)。身份校验在收尾里
 *    (见那里),所以这里先删是安全的。
 *  - 不等它收完就起新的 → 旧的 `turn.done` 落在新的那次中间,把它的回合提前关掉。
 *
 * 所以返回的是**它收干净的那个 promise**(`settled`),调用方 `await` 之后再起新的。
 * "收干净"的定义就是收尾里 `active.finish()` 之前那几行 —— 包括那个 `turn.done`。
 */
export function parkedRunTeardown(sessionId: string): Promise<void> | null {
  if (!isRunParked(sessionId)) return null;
  const active = runs.get(sessionId) as ActiveRun;
  log.info(`workflow run ${active.runId}: 用户在它等人时又说话了 —— 让开 (${sessionId})`);
  runs.delete(sessionId);
  active.abort.abort();
  return active.settled;
}

/**
 * 让一个正在跑的图停下来。**"停"的定义是"不再派发新的"** —— 已经跑起来的那些节点
 * 会被逐个 interrupt(它们的回合会以 `interrupted` 收场),它们的下游因为依赖没满足
 * 而不会启动(见 `scheduler.ts`)。
 */
export function cancelWorkflowRun(sessionId: string): boolean {
  const active = runs.get(sessionId);
  if (!active) return false;
  active.abort.abort();
  return true;
}

/**
 * 按图跑一轮。**调用方不要 await 整个跑完** —— 一次运行可能几分钟(用户在中间回答
 * 节点的问题),IPC handler 该立刻返回。返回的 promise 是"整张图跑完",只给测试和
 * 日志用。
 */
export async function startWorkflowRun(args: {
  session: Session;
  /** 节点回合的工作目录。v1 与父会话相同(见文件头"不做写隔离")。
   *  **续跑可以不传** —— 那时以存档里的为准(见下)。 */
  cwd?: string;
  /** 用户这次发的消息。只注入根节点(见 `scheduler.composeNodePrompt`)。
   *  **续跑可以不传** —— 那时以存档里的为准(见下)。 */
  prompt?: string;
  /** 发起方的用户消息原文,用于跨客户端回声(手机 ⇄ 桌面)。普通回合在
   *  `RuntimeManager.sendTurn` 里回声,**图型工作流没有那个回合**,不在这里补的话
   *  另一台设备只会看到一串结果卡、上面没有那句提问。 */
  userMessage?: { id: string; createdAt: number; blocks: unknown[]; editedMessageId?: string };
  /**
   * **从上次停下的地方接着跑。** 两条来源:
   *
   *  - {@link resolveWorkflowChoice} —— 用户在一张上一轮留下的岔路口卡片上点了一下
   *    (见 `runStore.resumableRun`)。这条路给 `nodeId` + `answer`。
   *  - {@link resolveWorkflowRetry} —— 用户在一张**失败**的卡片上点了「再试一次」。
   *    这条路给 `nodeId` + `rewind`(+ 可选的 `note`),**不给 `answer`** —— 重试
   *    没有"在选项里挑一条"这回事。
   *
   * 两者共用同一个 `runId`:它是**同一次运行**的两次尝试(见下面那句注释 —— 卡片是按
   * `runId + nodeId + attempt` 认的)。
   */
  resume?: {
    /** **沿用上一次那个 runId**,不是新生成一个。理由见下面的注释。 */
    runId: string;
    snapshot: RunSnapshot;
    /** 用户点的是哪一格。 */
    nodeId: string;
    /** 岔路口那一下选了什么。**重试那条路不给**(它没有选项)。 */
    answer?: BranchChoice;
    /** 要抹掉重跑的**起点** —— 失败那一步。展开成"它 + 全部前进后代"由调度器做
     *  (见 `RunResume.rewind`)。重试那条路给,岔路口续跑不给。 */
    rewind?: readonly string[];
    /** 只给 `nodeId` 那一步看的一段话(用户写「上次哪里不对」)。见 `RunResume.note`。 */
    note?: { nodeId: string; text: string };
  };
  /**
   * **这次是哪个触发器起的**(见 `scheduler.runWorkflow` 的 `entry`)。自动化执行器给 ——
   * 手动跑一张图 / 续跑时不给。
   *
   * 载荷文本要跟着一起走,因为它就是**触发器那一步的产出**:下游读到的是"上游交了什么"。
   */
  entry?: {
    nodeId: string;
    summary: string;
    /**
     * 触发器载荷的**事实键值**(G3/VAR-06,见 `automationPayload.ts` 的
     * `payloadFactsOf`:kind / at / files / event / toolName / subjects)。它会:
     * ① 随 entry 落进存档(续跑时变量还解得出来);② 被递进每个节点的
     * `data.trigger`,节点参数里的 `{{trigger.<key>}}` 从这里取;③ 随节点结果事件
     * 的 `input.trigger` 亮给界面。手动跑一张图没有这回事 —— 缺席就是没有。
     */
    payload?: Record<string, unknown>;
  };
}): Promise<RunResult | null> {
  const { session, userMessage } = args;
  const resumed = args.resume;
  const doc = getWorkflow(session.workflowId);
  if (!doc || doc.nodes.length === 0) return null;
  if (runs.has(session.id)) {
    // 兜底:调用方(`ipc/claude.ts` / `mobileRpc.ts`)已经先查过 `hasActiveRun` 并
    // 抛出可见的错误了 —— 那条路才会让用户看见"这个工作流还在跑"。走到这里说明有
    // 新的调用方漏了那一步,记一行日志,别让消息悄悄消失。
    log.warn(`workflow: run already active for ${session.id}, ignoring`);
    return null;
  }

  // **续跑时这两样以存档为准。** 点卡片的那一下手上只有一张卡片 —— 用户最初说了什么、
  // 那次是在哪个目录里跑的,都在存档里。以调用方给的为准的话,这里就多了一种"两边
  // 不一样"的坏法,而它不报错。
  let prompt = resumed !== undefined ? resumed.snapshot.prompt : (args.prompt ?? "");
  const cwd = resumed !== undefined ? resumed.snapshot.cwd : (args.cwd ?? "");
  // **「这次是哪个触发器起的」续跑时以存档为准** —— 同 `prompt` / `cwd` 那两样:点卡片
  // 的那一下手上只有一张卡片,而"这次是哪条自动化入口起的"在存档里。
  const entry = resumed?.snapshot.state.entry ?? args.entry;

  // **主对话节点上「固定条件」的注入** —— 随**运行的最初那条提示词**进主节点;渲染端
  // 见 `chat/SearchFilterBar.tsx`,选择落在 `WORKFLOW_NODE_PREFS_SETTING_PREFIX` +
  // workflowId。三道门(续跑不注 / 不是这个对话的第一轮不注 / 值为「不限」的跳过)与
  // 拼装都在 `criteriaInject.ts` —— 那边一行桩都不用打就能无头验,而"只注一次"这条
  // 正是最该被钉住的。这里只负责把两个判据算出来:**第一条判据**是这次运行是不是点卡片
  // 接回来的,和上面 `prompt` / `cwd` / `entry` 那三样同源;**第二条**是消息表里有没有
  // 任何一条 —— 有就说明这不是这个对话的第一轮,条件已经在上下文里了,再注就是同一段
  // 话反复出现。自动化会话同样按这条走:它的会话是复用的,第一轮之后也只该注那一次。
  if (resumed === undefined) {
    try {
      prompt = injectEntryCriteria({
        doc,
        workflowId: session.workflowId,
        prompt,
        resumed: false,
        firstTurn: !MessageRepo.hasAny(session.id),
      });
    } catch (err) {
      log.warn(`workflow: node criteria unread, skipping injection: ${String(err)}`);
    }
  }

  // **runId 沿用上一次那个。** 那张卡片是按 `runId + nodeId + attempt` 认的
  // (见 `sessionStore.patchBranchChoiceBlock`),换了 id 的话,"你选了 X"那一下会被
  // 认成一张**新卡**再摆一张出来 —— 对话里于是有两条一模一样的岔路口,其中一条还
  // 摆着已经点过的按钮。
  const runId = resumed !== undefined ? resumed.runId : uid("run_");
  /** 落地 `settled` 的那一下(见 `ActiveRun.settled`)。 */
  let finishRun!: () => void;
  const active: ActiveRun = {
    runId,
    sessionId: session.id,
    abort: new AbortController(),
    nodeSessionIds: new Set(),
    nodeSessionOf: new Map(),
    executing: 0,
    settled: new Promise<void>((resolve) => {
      finishRun = resolve;
    }),
    finish: () => finishRun(),
  };
  runs.set(session.id, active);

  /**
   * 分支节点 → 被问过几次。只有**回头**会让它超过 1(见 `WorkflowNodeChoiceEvent.attempt`)。
   *
   * 续跑时接着数:报错轮次会把**上一轮那张卡**改掉(见 `runStore.RunSnapshot.attempts`)。
   */
  const choiceAttempts = new Map<string, number>(resumed?.snapshot.attempts ?? []);

  /**
   * 「退出流程」时用户在框里写的那段话 —— 等整张图收口之后,它要作为**下一条用户
   * 消息**发进主对话(见 `@contracts/nodeType` 的 `ASK_EXIT_CHOICE`)。
   *
   * 为什么攒着而不是当场发:选那一下整张图还在跑,而主对话是**被这次运行占住**的 ——
   * 当场 `sendTurn` 只会得到 null。所以这里只接住,等下面 `turn.done` 发完之后再发。
   */
  let exitText: string | null = null;

  /**
   * 这次运行**此刻的样子**。每次状态变了就整份写一遍(见 {@link writeRun})。
   *
   * 续跑时它从存档起手,所以**第一下写出去的就是完整的**:万一刚接回来又断了,
   * 下一份存档不会比上一份更少。
   */
  let latest: RunSnapshot = resumed?.snapshot ?? {
    prompt,
    cwd,
    attempts: [],
    // `entry` 必须在**第一份**存档里:它是"这次由哪个触发器起"的唯一记录,而下面那句
    // `writeRun("running", ...)` 是紧接着就写出去的(`stateOf` 之后每次都会带上它,
    // 但那时已经过了开跑那一刻)。
    state: { record: [], rounds: [], picks: [], outcomes: [], awaiting: [], ...(entry !== undefined ? { entry } : {}) },
  };

  /** 落一次盘。**写失败不抛** —— 见 `runStore.saveRun`。 */
  const writeRun = (status: "running" | "success" | "failed" | "cancelled", state: RunState): void => {
    latest = { prompt, cwd, state, attempts: [...choiceAttempts] };
    saveRun({ runId, sessionId: session.id, workflowId: session.workflowId, status, snapshot: latest });
  };

  // 旧的那些运行行清一清(见 `pruneRuns`)。**放在开跑这一刻**,而不是收尾 ——
  // 收尾那一刻多一个"这次运行还活着"之外的写操作,而它没有任何好处。
  pruneRuns(session.id);
  // **先落行,再跑第一个节点。** 反过来的话,应用在第一步跑完之前被杀掉,这次运行
  // 就一点痕迹都没有 —— 而"它跑过"恰恰是下次要用的信息。续跑时这一下也顺带把上一份
  // `interrupted` 收回成 `running`。
  writeRun("running", latest.state);

  // 先把用户那句回声出去(和普通回合一样,发在第一个节点事件之前),再起跑。
  // **续跑不回声** —— 那条消息已经在对话里了,再发一遍就是两条一样的。
  //
  // ⚠️ 这三行**必须在 `runs` 条目已经挂上之后、并且在 `try` 之外**,所以它们自己带
  // 一个兜底:**抛了就把条目摘掉再抛**。不摘的话 `runs.has` 从此为真,这个对话里发
  // 什么都只会得到"这个工作流还在跑" —— 一个用户自己走不出来的状态。
  // (`pruneRuns` 和 `writeRun` 各自吞掉自己的错,所以真正可能抛的只有广播那一下。)
  try {
    if (userMessage && resumed === undefined) runtimeManager.echoUserMessage(session.id, userMessage);
    log.info(
      resumed !== undefined
        ? `workflow run ${runId} resumed: ${doc.nodes.length} 个节点 (${session.id})`
        : `workflow run ${runId} started: ${doc.nodes.length} 个节点 (${session.id})`,
    );
  } catch (err) {
    runs.delete(session.id);
    active.finish();
    throw err;
  }

  /** 这次运行用到的节点类型清单。懒加载一次(见 `manifestOf`)。 */
  let manifests: Map<string, NodeTypeManifest> | null = null;
  /** 节点类型 id → 清单文件所在目录。只有第三方自带脚本的节点要用(见 `manifestOf`)。 */
  let manifestDirs: Map<string, string> | null = null;
  /** 把两张表一次建起来。`manifestOf` 与 `manifestDirOf` 共用 —— 各读一遍就是同一批
   *  文件读两遍(见 `manifestOf` 那段"按节点调 = 读 N 遍"的注释)。 */
  const ensureCatalogs = async (): Promise<void> => {
    if (manifests !== null) return;
    const catalogs = await loadNodeTypes();
    manifests = new Map(catalogs.entries.map((e) => [e.id, e.manifest]));
    manifestDirs = new Map(
      catalogs.entries.flatMap((e) => (e.manifestDir !== undefined ? [[e.id, e.manifestDir] as const] : [])),
    );
  };

  // 每个节点这一轮的产出。**主进程里没有别的地方留着它** —— 消息是渲染端持久化的
  // (main 只存会话行上的几个 blob),所以"下游要的上游结果"只能在这里边听边攒。
  const text = new Map<string, string>();
  const endReason = new Map<string, string>();
  const failure = new Map<string, string>();
  /**
   * 节点会话**此刻在干什么** —— 最后一个工具名,或者正在跑的那个子代理。
   *
   * 这是卡片上那行字里唯一"具体"的那半截(另外半截是已跑时长,见 `runInNodeSession`)。
   * 它只是个**近似的当前状态**,不是流水:工具调完了也不清(清了会退回"没有信息"),
   * 下一次 `tool.use` 直接盖掉。这样卡片上永远写着**最近一次**发生的事,而不是闪回空白。
   */
  const activity = new Map<string, string>();
  /**
   * 这次运行里还活着的**进度心跳**(每个正在跑的节点各一个)。
   *
   * `runInNodeSession` 自己的 `finally` 会清掉自己那一个,所以正常路径上这里是空的。
   * 留这一份是为了"运行以别的方式死掉"那一类(收尾那段 `finally` 里也扫一遍)——
   * **一个还在走的时间戳计时器是个最坏的幽灵**:卡片早换成结果卡了,它还在每秒算一遍
   * 时长,一旦哪个分支漏了清,现象是"跑完的卡片上秒数还在跳",而那种 bug 一旦漏出去
   * 极难查。两份都清,代价是一行。
   */
  const heartbeats = new Set<ReturnType<typeof setInterval>>();
  /**
   * **要收产出的那几段会话。**
   *
   * 和 `active.nodeSessionIds` 分开是必须的:后者还有一个用途是**收尾时放掉运行时**,
   * 而「对话节点」跑在主对话那个会话上 —— 它的产出要收,但主对话的运行时**绝不能**
   * 在这里被放掉(那是用户自己的对话)。
   */
  const observed = new Set<string>();
  /** 这一轮里,选了「并回主对话」的那几步各攒一段(见 `NODE_RETURN_PARAM_KEY`)。收尾时
   *  一次挂上去 —— 取用它的是"主对话下一轮的话",而那一轮必然在这张图跑完之后。 */
  const backflow: string[] = [];

  /**
   * 从运行时的用量历史里,把一条**折成事件要的那个形状**(见
   * `WorkflowNodeResultEvent.usage`)。
   *
   * ⚠️ **`undefined` 是常事,不是错**:用量是那个回合结束之后异步推上来、再结算落库的
   * (见 `RuntimeManager.usageOf` 的注释),而节点刚收场那一刻多半还没到。所以调用方
   * 要能接受"这一下发不出花费",并在稍后补一次。
   */
  const usageOfSession = (
    nodeSessionId: string,
  ): { totalTokens: number; outputTokens: number; costUsd?: number } | undefined => {
    const record = runtimeManager.usageOf(nodeSessionId);
    if (!record) return undefined;
    return {
      totalTokens: record.totalProcessedTokens,
      outputTokens: record.outputTokens,
      // 引擎没报花费时**不带这个字段**,而不是带 0 —— 渲染端要能区分"免费"和"不知道"。
      ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    };
  };

  /** 已经排过一次补发的节点会话 —— 一个会话只补一次,别因为重试/回头排一堆定时器。 */
  const usageBackfilled = new Set<string>();

  /**
   * **补发一次花费。** 节点收场时那次广播多半还没拿到用量(见上),所以过一会儿再问
   * 一遍;有数就发一条 {@link WorkflowNodeUsageEvent}。
   *
   * ⚠️ **不能重发 `workflow.node.result`** —— 那个事件在渲染端的意思是"插一张卡"
   * (`appendTurnCardBlock`),重发会在对话里出现**两张**卡片,用户看到的是"这一步做了
   * 两次"。结果卡没有"原地更新"这条路,所以才单开了 `workflow.node.usage` 那条通道:
   * 渲染端按 `runId + nodeId` 找到那张卡,**只改花费那一项**。
   *
   * 三条刻意的选择:
   * - **只补一次。** 宽限计时器(`TURN_END_SETTLE_GRACE_MS`)一到就会结算,所以一个稍长
   *   的延时足够覆盖;轮询等着它出现是白烧定时器。
   * - **`unref()`。** 不吊住进程 —— 用户关掉应用时不该因为一个"补花费"的定时器卡住退出。
   * - **取消之后不补。** 那次运行已经收场了,再往对话里插一条会显得莫名其妙。
   *
   * 补不上也没关系:卡片上只是不显示花费那一行,别的什么都没有影响。
   */
  const scheduleUsageBackfill = (nodeSessionId: string, nodeId: string): void => {
    if (usageBackfilled.has(nodeSessionId)) return;
    usageBackfilled.add(nodeSessionId);
    setTimeout(() => {
      try {
        if (active.abort.signal.aborted) return;
        const usage = usageOfSession(nodeSessionId);
        if (!usage) return;
        broadcastRuntimeEvent({
          type: "workflow.node.usage",
          sessionId: session.id,
          runId,
          nodeId,
          usage,
        });
      } catch {
        // 补花费是**附加**的:它失败不该影响任何别的东西。这里能撞上的都是"没赶上"
        // 这类正常情况(收尾时那次运行已经拆干净了),不值得记一行日志。
      }
    }, USAGE_BACKFILL_DELAY_MS).unref();
  };

  const unsubscribe = runtimeManager.subscribe((e) => {
    if (!observed.has(e.sessionId)) return;
    if (e.type === "text.delta") {
      text.set(e.sessionId, (text.get(e.sessionId) ?? "") + e.text);
    } else if (e.type === "turn.done") {
      endReason.set(e.sessionId, e.reason);
    } else if (e.type === "error") {
      failure.set(e.sessionId, e.message);
    } else if (e.type === "tool.use") {
      // 记下"这一步此刻在干什么"给卡片用(见 `activity` 那张表)。**`observed` 里的是节点
      // 自己的会话**(订阅者拿到的那条事件带的是节点会话的 id,见 `runInNodeSession`
      // 里那段注释),`conversation` 那种跑在主对话上的节点也在 `observed` 里 —— 它
      // 的工具名同样是实话,不必再分一道。
      activity.set(e.sessionId, e.toolName);
    } else if (e.type === "subagent.update") {
      // 子代理是**这一轮里最长的静默期**:主代理派出去等着的时候,它自己一个字都不发。
      // 拿名单上那个还在跑的代理名报出去,比停在最后一个工具名上准确得多 —— 用户看到
      // 的「正在跑 Explore」正是"它在干嘛"。
      //
      // `agents` 是**全量替换**语义(见 `SubagentUpdateEvent` 的注释):名单空了就是
      // "都回来了",这时清掉而不是留着上一批,否则卡片会一直挂着一个早就结束的代理。
      //
      // 显示名取 `subagentType`(「Explore」这种),没有再退到 `description` —— 描述
      // 可能是一整句话,塞进那行小字里会把"已跑多久"挤没影。
      const busy = e.agents.find((a) => a.status === "running");
      if (busy) activity.set(e.sessionId, `子代理 ${busy.subagentType ?? busy.description}`);
      else activity.delete(e.sessionId);
    }
  });

  const outcomeOf = (nodeSessionId: string): NodeOutcome => {
    const summary = (text.get(nodeSessionId) ?? "").trim();
    const error = failure.get(nodeSessionId);
    if (error) return { status: "failed", summary, error };
    const reason = endReason.get(nodeSessionId);
    if (reason === "interrupted") return { status: "cancelled", summary, error: "运行被取消" };
    if (reason === "error") return { status: "failed", summary, error: "这一轮以错误结束" };
    return { status: "success", summary };
  };

  /**
   * 上下文继承要的几样东西(见 `contextInherit.ts`)。
   *
   * 分类表**一次建好重复用**:`CollectionRepo.list()` 是全表扫描,而主提示词里可能
   * 挂着好几份附件、每个节点又各问一次,乘起来很可观。条目那个不用缓存 ——
   * `LibraryRepo.get` 是按主键查一行。
   */
  const collections = new Map(CollectionRepo.list().map((c) => [c.id, c]));
  const lookup: ContextLookup = {
    libraryRoot: libraryRoot(),
    templatesRoot: templatesRoot(),
    // 分类 → 它挂着的大类。**查不到返回 `undefined`(不是 `[]`)** —— 那是本模块
    // 用来区分"这是一条分类清单"与"这是一条条目清单"的信号(见 `ContextLookup`)。
    groupsOfCollection: (id) => {
      const c = collections.get(id);
      return c ? (c.groupId ? [c.groupId] : []) : undefined;
    },
    // 条目 → 它所属分类挂着的大类,去重。一条可以同时在多个分类里,而那些分类未必
    // 挂在同一个大类下 —— 那时它确实同时属于两个类目。
    groupsOfItem: (id) => {
      const item = LibraryRepo.get(id);
      if (!item) return undefined;
      const out = new Set<string>();
      for (const cid of CollectionRepo.collectionsOfItem(id)) {
        const gid = collections.get(cid)?.groupId;
        if (gid) out.add(gid);
      }
      return [...out];
    },
  };

  /**
   * 「跑在主对话里」那一种(`runner.kind === "conversation"`):把这一步的指令
   * **当作一条用户消息**发出去,等目标对话回完。
   *
   * 用它的有两种节点:**入口节点**(主代理 `mcode.main`,图的第一格,它就是用户
   * 正在说话的那个对话框)与**对话节点**(流程中段"需要用到之前聊过的东西"的那一步)。
   * 两者的跑法一字不差,差别只有两处参数与一处回声 —— 入口那一段 `prompt` 是代码拼的
   * 脚手架,所以它把 `echoUserMessage` 置 `false`(见下面那一段的注释)。
   *
   * ## 两个新参数(见 `@contracts/nodeType` 的注入那一段)
   *
   * - **投递目标**(`injectTargetOf`):`self`(默认)发进正在跑这张图的那条会话,是
   *   现状;`origin` 发进**发起会话** —— 通过会话界面的「守望」按钮起跑的自动化,把
   *   按下按钮时的那条会话记在了 automation 会话的 `parentSessionId` 上。解析不到
   *   **明确失败**(手动从设置里跑的自动化没有发起会话),而不是悄悄发进自己 —— 那种
   *   "发到了,但发错了地方"比失败难查得多。
   * - **注入模式**(`injectModeOf`):`ask`(默认)等这一轮说完再继续(现状);`auto`
   *   是"自动注入" —— **发完即走**:消息投出去、那一轮在目标对话里自己跑,这一步立刻
   *   记成成功往下走。它是"长任务守望"的最后一步:命令跑完了替你说一句话,没人(也不
   *   需要)在这里等回答。⚠️ 代价:这一步拿不到那轮的产出 —— 需要它的流程别用 `auto`。
   */
  const runInConversation = async (
    node: WorkflowNode,
    manifest: NodeTypeManifest,
    input: NodeRunInput,
  ): Promise<NodeOutcome> => {
    const auto = injectModeOf(node.params) === "auto";
    // **解析投递目标。** 只在要真发的那一刻解析 —— parentSessionId 是起跑时记下的,
    // 这里改不了它;但会话行是每次现查的(重启之后对象表是空的,按 id 重取)。
    let target = session;
    if (injectTargetOf(node.params) === "origin") {
      const originId = session.parentSessionId;
      if (originId === undefined || originId === null || originId.length === 0) {
        return {
          status: "failed",
          summary: "",
          error:
            "这一步要注入到「发起会话」,但这次运行不是从某个对话里起的(没有记录发起人)—— 把它配成发进本会话,或用会话输入区的「守望」按钮起跑",
        };
      }
      const origin = SessionRepo.get(originId);
      if (origin === undefined) {
        return {
          status: "failed",
          summary: "",
          error: `发起会话(${originId})已经不在了 —— 它可能被删除了`,
        };
      }
      target = origin;
    }

    if (auto) {
      // **发完即走。** 不扣 `turn.done`(那一轮对目标对话来说是条**正常消息**,该几点收
      // 就几点收)、不等回答、拿不到产出。取消也追不回已经发出去的消息 —— 中止信号拦住
      // 的是"还没发的",不是"正在别人对话里跑的"。
      observed.add(target.id);
      log.info(
        `workflow run ${runId}: 对话节点「${node.title || node.id}」自动注入到 ${target.id}`,
      );
      runtimeManager.bindSession(target);
      runtimeManager.echoUserMessage(target.id, {
        id: uid("u_"),
        createdAt: Date.now(),
        blocks: [
          { kind: "text", text: input.prompt },
          { kind: "text", text: "*—— 由自动化注入*" },
        ],
      });
      const handle = await runtimeManager.sendTurn(target, { prompt: input.prompt, cwd });
      if (!handle) {
        return { status: "failed", summary: "", error: "目标对话没能接上(它正忙)—— 稍后再试一次" };
      }
      return {
        status: "success",
        summary: "已注入,不等回答(自动注入模式:那一轮在目标对话里自己跑)",
      };
    }

    // 产出是往 `text` 里**累加**的,而同一个会话会被好几个对话节点依次用到 —— 每开一次
    // 先把上一步留下的那几笔清掉,否则第二个节点拿到的是"两次说的话拼在一起"。
    observed.add(target.id);
    text.delete(target.id);
    endReason.delete(target.id);
    failure.delete(target.id);
    // 这一行是给排查用的:**主对话突然多出一段自己没说过的话**时,日志里得看得出是
    // 哪张图的哪一步干的。
    log.info(`workflow run ${runId}: 对话节点「${node.title || node.id}」跑在 ${target.id}`);

    // 聊天框里要**看得见这一步说了什么** —— 一条和用户自己发的同一种形状的用户消息。
    // 这就是"代替用户在主对话里说话"的字面意思(见 `contracts/nodeType` 的
    // `runner.kind === "conversation"` 那一段)。
    //
    // ⚠️ **入口节点不回这一步**(见 `NodeRunInput.echoUserMessage`)。它同样跑在主对话
    // 里,但手上那段 `prompt` 是**代码拼的脚手架** —— 流程位置、上游产出、产出要求,
    // 一大段用户没打过的字。原样贴进聊天框,他看到的是一屏莫名其妙的话;而他自己那句
    // 原话 `startWorkflowRun` 已经回声过了(跨客户端同步、编辑标记、本机乐观追加的
    // 去重都挂在那一台上),所以这里让开,聊天框里正好一条。
    //
    // 顺带:发起方自己发的那条消息**已经被渲染端乐观追加过**了,而 `echoUserMessage`
    // 走的是 `emitExternal` —— 它只 fanOut / notify,**不经过 `sendTurn` 里那个按 id
    // 去重的分支**(见 `RuntimeManager.sendTurn` 的 `if (input.userMessage)`)。所以
    // "谁来回声"必须是一个明确的答案,不能两边都发:这边也发就是聊天里两条一样的提问。
    if (input.echoUserMessage !== false) {
      runtimeManager.echoUserMessage(target.id, {
        id: uid("u_"),
        createdAt: Date.now(),
        blocks: [{ kind: "text", text: input.prompt }],
      });
    }

    // **这一步跑完的 `turn.done` 先别推给界面。** 那一条在界面上是"用户这一轮结束了"
    // —— 图可能还有五步没跑(见 `RuntimeManager.holdTurnEnd`)。整张图真正的收口由下面
    // 收尾那一段补,不走这里。落盘与订阅者不受影响,所以这一步的产出照样收得到。
    // ⚠️ 只对 `self` 扣:发进发起会话的那轮是**用户自己对话里的正常消息**,它的收尾
    // 本来就该正常显示(扣了反而让那边"说了话却没下文")。
    const releaseEnd = target.id === session.id ? runtimeManager.holdTurnEnd(target.id) : null;
    // **声明过产出变量时,它这一轮的话也先扣住。** 那种情况下它交出来的是一段结构化的
    // 东西(一个 JSON 对象),逐字滚给用户看的话,聊天框里就是一屏花括号 —— 而那正是
    // 他明确说过不想看到的。跑完之后在下面解成一张清单,一次性发出去(见 `holdTurnText`)。
    const vars = outputVarsOf(manifest, node.params);
    const releaseText =
      target.id === session.id && vars.length > 0 ? runtimeManager.holdTurnText(target.id) : null;
    /** 扣住之后要补发的那段。没扣就是 null(照常流式,不补)。 */
    let held: string | null = null;
    // 取消要打断**这一个回合**,和隔离节点同一个道理(见上面那段注释)。
    const onAbort = (): void => runtimeManager.interrupt(target.id);
    input.signal.addEventListener("abort", onAbort, { once: true });
    active.executing += 1;
    try {
      // 目标的运行时**正常路径上早就绑好了**(self 是发消息那一下绑的;origin 是用户
      // 在那边聊过天)。这里补一次是为了**续跑**:用户点一张旧卡片时没有"发消息"那一下,
      // 而重启之后运行时表是空的。`bindSession` 是幂等的,已经绑过就是一句空操作。
      runtimeManager.bindSession(target);
      const handle = await runtimeManager.sendTurn(target, { prompt: input.prompt, cwd });
      if (!handle) {
        // 目标正忙(上一轮还没收干净)时 `sendTurn` 返回 null。**如实说**,不要让这一步
        // 假装成功 —— 下游拿不到产出时,原因得看得出来。
        return { status: "failed", summary: "", error: "目标对话没能接上(它正忙)" };
      }
      if (input.signal.aborted) onAbort();
      await handle.done;
      // 这一轮说了什么,已经攒在 `text` 里了(订阅者照收,只是没推给界面)。
      if (releaseText !== null) {
        held = structuredReplyText((text.get(target.id) ?? "").trim(), vars);
      }
    } catch (err) {
      return { status: "failed", summary: "", error: (err as Error).message };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      // **补发要排在解除之前。** 反过来的话,后面任何一条 `text.delta` 又会推给界面,
      // 而那一段本该是"解完之后的一句话"。
      if (held !== null && held.length > 0) {
        runtimeManager.emitExternal({
          type: "text.delta",
          sessionId: target.id,
          messageId: uid("m_"),
          text: held,
        });
      }
      releaseText?.();
      active.executing -= 1;
      releaseEnd?.();
    }
    // 这一步的产出 = 目标对话这一轮说的话(和其他节点同一个口径,见 `outcomeOf`)。
    // ⚠️ **拿到的是原文,不是补发出去的那张清单** —— 下游取的是产出变量,而变量是从
    // 原文里解出来的(`withOutputCheck` 也在查原文)。清单只是给人看的。
    return outcomeOf(target.id);
  };

  /**
   * 「隔离的模型轮」—— 绝大多数节点(普通 agent 节点、模型选的分支)的跑法:开一条
   * 独立的节点会话,把指令发进去,等那一轮收完。
   *
   * 这一路原来是 `ports.execute` 里的一段内联代码,前面用 `kind === "conversation"`
   * 和"注册表里有没有"两次分岔隔开。现在它是**兜底执行器**的本体(见下面的
   * `runEngine`):分派链上不再有 kind 判断,注册表里没有专用执行器的 kind 全部落到
   * 这里 —— 与"新增执行器只注册、调度器不加分支"是同一条规矩的另一半。
   */
  /** 报一条**这一步**的粗进度。执行器拿到的 `emitProgress` 和模型轮开头那一条
   *  走的是这里 —— 同一件事(节点进度事件)只有一个出口,不然两边的字段迟早对不上。 */
  const emitNodeProgress = (
    node: WorkflowNode,
    manifest: NodeTypeManifest | undefined,
    progress: { percent?: number; message?: string; phase?: string },
  ): void => {
    broadcastRuntimeEvent({
      type: "workflow.node.progress",
      sessionId: session.id,
      runId,
      nodeId: node.id,
      nodeType: node.type,
      title: displayTitle(node, manifest),
      ...(progress.percent !== undefined ? { percent: progress.percent } : {}),
      ...(progress.message ? { message: progress.message } : {}),
      ...(progress.phase ? { phase: progress.phase } : {}),
    });
  };

  const runInNodeSession = async (
    node: WorkflowNode,
    manifest: NodeTypeManifest,
    input: NodeRunInput,
  ): Promise<NodeOutcome> => {
    // 这一步换引擎时,先确认这台机器上真有那家。**在这里拦而不是在参数校验里**:参数
    // 校验只看值的形状,而"装了没有"是这台机器的状态 —— 一份分享来的图在别人机器上
    // 引用一个没装的引擎是正常的,它该在**跑的时候**说清楚为什么跑不了。
    const engine = input.providerId;
    if (engine !== undefined && !providerRegistry.get(engine)) {
      return { status: "failed", summary: "", error: `这一步指定的引擎「${engine}」没有安装` };
    }
    const nodeSession = nodeSessionOf(session, node, manifest, engine);
    active.nodeSessionIds.add(nodeSession.id);
    observed.add(nodeSession.id);
    active.nodeSessionOf.set(node.id, nodeSession.id);
    // 先绑运行时**再**挂代理:反过来的话,`bindSession` 万一抛了,代理表里会留下
    // 一条指向不存在运行时的记录,而 `dispose()` 对没有运行时的会话是直接返回的
    // (那条记录就再也清不掉了)。
    runtimeManager.bindSession(nodeSession);
    runtimeManager.setInteractiveProxy(nodeSession.id, session.id);

    // **先报一条粗进度:它现在在起跑。**
    //
    // 卡片上那一行小字(`message`)只有 `emitProgress` 能写,而内置执行器里只有
    // command / code 那两种会调它 —— 模型轮这一路(也就是**绝大多数节点**)从头到尾
    // 一条都不发。于是"跑得久"的那些卡片上就只有「执行中」三个字,而用户的原话是
    // 「看不出它具体在干嘛」。过程(工具调用)要等模型真的开始调工具才有,开头这段
    // 静默期恰恰是最让人怀疑"是不是死了"的时候。
    //
    // 报的是**这一步的标题**而不是"正在思考"这种空话 —— 看板上并排跑着好几格时,
    // 用户要的是"我点开的是哪一格"。**故意不带 `percent`**:这一步的总量无从估算,
    // 编一个数字出来只会让进度条走到 99% 然后停住。
    emitNodeProgress(node, manifest, { message: displayTitle(node, manifest) });

    /* ── 跑起来之后:让卡片上那行字**一直有东西在动** ──
     *
     * 前面那一条报完之后,这里开始定期把"已跑多久 + 此刻在干嘛"报出去。**这是这段
     * 代码存在的全部理由**:没有它,一个跑 40 分钟的节点在界面上和卡死完全一样。
     *
     * ## 那行字是怎么拼的
     *
     * `已跑 3 分 12 秒 · Bash`(还没调过工具时只有前半截)。分两半是刻意的:
     * **时长是"它还活着"的证据**,工具名是"它在干嘛"的答案 —— 用户问的正是后者,
     * 而前者是唯一能在毫无流水时也继续往前走的东西。
     *
     * ## 两道闸门(见上面两个常量的注释)
     *
     * - 内容变了(新工具 / 新子代理)→ 最快 {@link NODE_PROGRESS_TICK_MS} 一条;
     * - 内容没变 → 最快 {@link NODE_PROGRESS_HEARTBEAT_MS} 一条,纯粹是给秒表出声。
     *
     * 合起来:一秒看一次有没有新东西,没有就等够 5 秒再说一遍。两道闸门都记在
     * **`sentAt`(上一次真发出去的时刻)**上,所以"刚报完工具名"和"该报秒数了"不会
     * 各自算一套。
     *
     * ## 为什么不用 `setTimeout` 排一串
     *
     * 这个函数**必须能被打断** —— 节点收场(正常 / 失败 / 取消)之后一次都不许再发。
     * 一个拿得住、清得掉的句柄是唯一稳的写法(见下面 `finally` 里的 `clearInterval`)。
     */
    let lastLine: string | null = null;
    let lastActivity: string | undefined;
    const startedAt = Date.now();
    let sentAt = startedAt;
    const tick = (): void => {
      const now = Date.now();
      const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
      const doing = activity.get(nodeSession.id);
      const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
      const line = doing ? `已跑 ${elapsed} · ${doing}` : `已跑 ${elapsed}`;
      if (line === lastLine) return;
      // 内容变了可以快报,没变就得等够心跳那一档。**两道闸门都要看** —— 少了后一道,
      // 内容不变的话 `line !== lastLine` 那一关本来就挡住了;真正靠它挡的是"分钟数
      // 一分钟才跳一格,而秒针每 5 秒都在催"这条:催出来的重复句由它吞掉。
      const changed = doing !== undefined && doing !== lastActivity;
      if (now - sentAt < (changed ? NODE_PROGRESS_TICK_MS : NODE_PROGRESS_HEARTBEAT_MS)) return;
      lastLine = line;
      lastActivity = doing;
      sentAt = now;
      emitNodeProgress(node, manifest, { message: line });
    };
    const heartbeat = setInterval(tick, NODE_PROGRESS_TICK_MS);
    heartbeats.add(heartbeat);
    // **别吊住进程。** 用户关掉应用时不该因为卡片上那行秒数卡住退出(同
    // `scheduleUsageBackfill` 那次 `unref()`)。
    heartbeat.unref?.();

    // 取消要**打断正在跑的那个回合**,不能只做到"不再派发新的" —— 否则用户按了
    // 停止之后它还会继续烧 token 直到模型自己收尾。监听先挂上再发起,中间那一瞬
    // 的取消由 `if (signal.aborted)` 补齐。
    const onAbort = (): void => runtimeManager.interrupt(nodeSession.id);
    input.signal.addEventListener("abort", onAbort, { once: true });
    // **从这一刻起整张图不再"停着等人"了**(见 `isRunParked`)。计数放在这里而不是
    // 函数开头:上面那几行还没真正开始干活,而 `createNodeSession` 万一抛了,加在
    // 开头的那一次就减不回来 —— 那个对话会永远显示"有节点在跑"。
    active.executing += 1;
    try {
      const handle = await runtimeManager.sendTurn(nodeSession, {
        prompt: input.prompt,
        cwd,
        // 这一步要用的技能 → 这一轮的技能允许清单(`@contracts/nodeType` 的
        // `NODE_SKILLS_PARAM_KEY`)。**空数组是"不限制"而不是"一个都不许"** ——
        // 契约那一头就是空的走 `skills: "all"`(见 `StartTurnRequest.skills`),
        // 所以这里传 undefined 而不是空数组,把那个默认值留给提供方。
        //
        // 下面两个同理,而且是**同一句话的三个宾语**(技能 / MCP 服务器 / 插件):
        // 不填 = 不限制。它们的差别只在"限制下去省的是什么" —— 技能省的是模型的选择
        // 面,MCP 与插件省的是**上下文**(整份工具定义 + 每个组件各自的说明)。
        ...(input.skills.length > 0 ? { skills: input.skills } : {}),
        ...(input.mcpServerNames.length > 0 ? { mcpServerNames: input.mcpServerNames } : {}),
        ...(input.pluginNames.length > 0 ? { pluginNames: input.pluginNames } : {}),
      });
      if (!handle) {
        return { status: "failed", summary: "", error: "节点会话没能启动(运行时没绑上)" };
      }
      if (input.signal.aborted) onAbort();
      await handle.done;
    } catch (err) {
      return { status: "failed", summary: "", error: (err as Error).message };
    } finally {
      // **收场第一件事:让那张卡片停下来。**
      //
      // 卡片这一刻已经换成结果卡了(渲染端 `patchWorkflowNodeProgressBlock` 跟着
      // `workflow.node.result` 走),再发一条就是幽灵事件 —— 而且 `runs` 里那条也删了,
      // 发出去的东西**没有任何一处认领**。这个计时器是这一路唯一"活着"的东西,所以
      // 它必须在最前面清掉,不能等到下面那几行(它们中间任何一处抛了都轮不到)。
      clearInterval(heartbeat);
      heartbeats.delete(heartbeat);
      input.signal.removeEventListener("abort", onAbort);
      active.executing -= 1;
    }
    return outcomeOf(nodeSession.id);
  };

  /**
   * **这一次运行自己的执行分派。** 本机的 ExecutionEngine 实例:内置本机执行器
   * (code / command)每次现建 —— 它们无状态,按次建和共享单例等价,却让"每次运行
   * 注册运行期执行器"成为可能:conversation(发进主对话)与兜底的模型轮都带着
   * **这次运行的**会话与状态闭包,注册进共享单例会互相覆盖。
   *
   * 分派规则只有一条:`manifest.runner.kind` 在注册表里就交给它,没有就落兜底。
   * **这里没有、也不允许再长出 `kind === xxx` 分支** —— 新增一种执行方式 = 在某个
   * Registry(输入 builder 或这里的执行器)里注册,分派链一行不改。
   */
  const runEngine = new ExecutionEngine()
    .register(new CommandExecutor())
    .register(new CodeExecutor())
    .register({
      kind: "conversation",
      // **不隔离的那一种**:它不发新的会话,指令直接进主对话(见 `runInConversation`
      // —— 主对话本来就有运行时,也没有"代理到自己"这回事,上面那条模型轮的路对它
      // 每一行都是反的)。
      execute: ({ node, manifest, input }) => runInConversation(node, manifest, input),
    })
    .setDefault({
      execute: ({ node, manifest, input }) => runInNodeSession(node, manifest, input),
    });

  const ports: RunPorts = {
    // 清单**一次读完**再按 id 查:`loadNodeTypes()` 是刻意不缓存的(每次都要扫插件
    // 目录、读并解析每一个清单文件,而它底下还会把每个启用的插件的技能/命令/agent
    // 文件再读一遍)。按节点调 = 同一批文件读 N 遍,而这里 N 就是图的大小。
    manifestOf: async (typeId) => {
      await ensureCatalogs();
      return manifests!.get(typeId);
    },

    /** 清单目录 —— 第三方自带脚本的节点拿它当 `entry` 的解析基准。 */
    manifestDirOf: async (typeId) => {
      await ensureCatalogs();
      return manifestDirs!.get(typeId);
    },

    // 这一步要继承的上下文:**从这次运行的提示词里筛**,不查库、不生成新清单 ——
    // 子代理读到的就是主对话读到的那份文件(见 `contextInherit.ts`)。
    contextLines: (kinds) => {
      if (kinds.length === 0) return [];
      const lines = inheritContextLines(prompt, kinds, lookup);
      log.info(
        `workflow run ${runId}: 这一步要 ${kinds.map((k) => kindLabel(k)).join("/")},` +
          `主对话里有 ${lines.length} 份`,
      );
      return lines;
    },

    // **执行分派只有一个入口**(见上面 `runEngine` 的注释):注册表里有这个 kind 就
    // 交给它,没有落兜底的模型轮。`cwd` 用这次运行的项目目录;超时与中止都由具体
    // 执行器处理。
    execute: async (node, manifest, input) => {
      // **触发器载荷进 `data.trigger`(G3/VAR-06)的兜底注入。** 调度器那边已经把
      // `entry.payload` 递给了输入构造层(见 scheduler 的 scope 注入);这里再保证
      // 一次"执行器拿到的 `NodeRunInput.data.trigger` 一定就位" —— 就算某个专用
      // 输入 builder 没把 scope 里的 trigger 带进 data,合同也不破。`input` 是
      // buildNodeInput 现建的对象,改它不影响别人。
      if (entry?.payload !== undefined) input.data.trigger = entry.payload;
      // `manifestDirOf` 要等 `manifestOf` 先跑过(它建那两张表)—— 而上面 `input`
      // 正是 `buildNodeInput` 的产物,它内部已经调过 `manifestOf` 了。这里再调一次
      // 是幂等的(表已经在了),不用额外加顺序假设。
      const dir = await ports.manifestDirOf(node.type);
      return runEngine.execute({
        node,
        manifest,
        input,
        cwd,
        metadata: { runId, sessionId: session.id, nodeId: node.id },
        emitProgress: (progress) => emitNodeProgress(node, manifest, progress),
        ...(dir !== undefined ? { manifestDir: dir } : {}),
      });
    },

    /**
     * 岔路口:发一张"选一条"的卡,然后**等**。
     *
     * ## 等待的那一半才是重点
     *
     * 这次运行的 `runWorkflow` 就停在这个 promise 上 —— 不建会话、不烧 token,只是等。
     * 所以它**必须一定能落地**:用户点了、运行被取消、用户按了停止,三条路都要走到。
     * 落不了地的话那次运行永远收不了尾,`runs` 里那条记录清不掉,用户从此在这个对话
     * 里发什么都只会得到"这个工作流还在跑"。
     *
     * ## 广播放在注册**之后**
     *
     * 反过来的话,卡片比记录先出现,而用户在那一瞬点了 —— 回答落到一个还不存在的记录
     * 上,被静默丢掉,图从此停在那儿(而且没有任何地方看得出是谁点的、点了什么)。
     * 本机 IPC 是毫秒级的,这个窗口小,但它存在。
     *
     * ## `preset`:答案已经有了,别再问
     *
     * 续跑时用户在**那张旧卡片**上点了一下(见 `startWorkflowRun` 的 `resume`)。这一支
     * 不等、不摆"等你选"的卡,**只把"选完了"那一下补上** —— 少了它,界面上那张卡会
     * 永远停在按钮状态,而用户明明已经点过了。
     *
     * ⚠️ **`attempt` 不能加一。** 这不是新的一问,是给上一问补答案;加一的话
     * `patchBranchChoiceBlock` 认不出原来那张卡,于是**另开一张**,对话里出现两条
     * 一模一样的岔路口。
     */
    choose: async (
      node,
      options: WorkflowChoiceOption[],
      signal: AbortSignal,
      preset?: BranchChoice,
    ) => {
      const key = choiceKey(runId, node.id);
      // 这个分支**被问过几次**。第二次起带着 `attempt > 1` 走 —— 渲染端靠它把这一轮
      // 的卡和上一轮的**分开摆**(见 `WorkflowNodeChoiceEvent.attempt`)。只有回头
      // 才会问到第二次。
      const seen = choiceAttempts.get(node.id) ?? 0;
      const attempt = preset !== undefined ? Math.max(seen, 1) : seen + 1;
      choiceAttempts.set(node.id, attempt);
      // 取标题要在**广播之前** —— `manifests` 是懒加载的,调度器开跑前已经取过一轮,
      // 所以这里基本一定有;真没有也只是标题回落成类型 id,不影响流程。
      const title = displayTitle(node, manifests?.get(node.type));
      // **这一次问是不是「运行前先问我」那一问。** 判据就是"选项里有没有那四个哨兵"
      // —— 边上的岔路不可能有:边的 id 是生成的,撞不上 `__ask_*__`。这样就不用在这里
      // 把调度器那条 `isAskBeforeRun` 再写一遍(两处各写一遍迟早会分家)。
      const ask = options.some((o) => isAskChoice(o.id));
      const emit = (extra: { chosen?: string; comment?: string }): void => {
        broadcastRuntimeEvent({
          type: "workflow.node.choice",
          sessionId: session.id,
          runId,
          nodeId: node.id,
          nodeType: node.type,
          title,
          attempt,
          options,
          ...(ask ? { ask: true } : {}),
          ...extra,
        });
      };

      // **「退出流程」那一条要顺手接住。** 它是调度器认的哨兵(见 `ASK_EXIT_CHOICE`),
      // 但它带来的副作用 —— "用户那段话要变成主对话的下一条消息" —— 得由**这一层**做,
      // 因为只有这里碰得到 `runtimeManager`。见上面 `exitText` 的声明。
      const remember = (pick: BranchChoice): void => {
        if (pick.edgeId !== ASK_EXIT_CHOICE) return;
        exitText = (pick.comment ?? "").trim();
      };

      // **续跑时补的那一下。** 见上面那段:只广播"选完了",不进等待。
      if (preset !== undefined) {
        remember(preset);
        emit({
          chosen: preset.edgeId,
          ...(preset.comment !== undefined ? { comment: preset.comment } : {}),
        });
        return preset;
      }

      // **已经取消了就别摆一张点了没用的卡。** 调度器那一头会看到 `aborted` 并把这个
      // 节点标成 cancelled。
      if (signal.aborted) return { edgeId: "" };

      const choice = await new Promise<BranchChoice>((resolve) => {
        const done = (value: BranchChoice): void => {
          pendingChoices.delete(key);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        // 取消也要落地 —— 见上面那段:落不了地,这次运行就永远收不了尾。
        const onAbort = (): void => done({ edgeId: "" });
        pendingChoices.set(key, { sessionId: session.id, done });
        signal.addEventListener("abort", onAbort, { once: true });
        emit({});
      });

      if (choice.edgeId.length === 0) return choice; // 被取消了,不补第二张卡
      log.info(`workflow run ${runId}: node ${node.id} 选了 ${choice.edgeId}`);
      remember(choice);
      // 第二张卡:**同一张,换成"你选了 X"**。带它是因为别的客户端(手机)也得知道
      // 这条选择已经落地了,否则它会一直摆着一个点了没反应的按钮。
      emit({
        chosen: choice.edgeId,
        ...(choice.comment !== undefined ? { comment: choice.comment } : {}),
      });
      return choice;
    },

    report: (e) => {
      // **起跑不出卡片,只记一行日志。** 一次运行会起好几个节点,每个都插一张"开始了"
      // 的卡会把对话刷屏,而用户关心的是结果;但"哪几个节点同时被派发了"恰恰是排查
      // 并发问题时唯一想知道的,所以留给日志。
      if (e.kind === "node.started") {
        // **入队即报一嗓子(G3)**:`workflow.node.queued` —— 监控/看板要的是"派发
        // 那一刻"的事实,而 progress 要到 execute 才有、result 更要等收场。起跑依然
        // 不出卡片(下面那行日志的理由不变),这条只进事件流,渲染端要不要画是它的事。
        broadcastRuntimeEvent({
          type: "workflow.node.queued",
          sessionId: session.id,
          workflowId: session.workflowId,
          runId,
          nodeId: e.node.id,
        });
        log.info(`workflow run ${runId}: node ${e.node.id} (${e.node.type}) dispatched`);
        return;
      }
      log.info(`workflow run ${runId}: node ${e.node.id} settled: ${e.outcome.status}`);
      // 没跑过的节点(skipped / 还没轮到就取消)没有会话,也就没有过程可看 —— 那种
      // 情况下这个字段干脆不带,卡片便不会摆一个点开是空的入口。
      const nodeSessionId = active.nodeSessionOf.get(e.node.id);
      // 这一步的**产出变量名**(给人看还是给下游取,由它决定 —— 见
      // `WorkflowNodeResultEvent.outputKeys`)。取的是**存下来的参数**:调度器那边
      // 已经按同一份参数查过产出了,这里只借名字,不参与判定。
      const manifest = manifests?.get(e.node.type);
      // **模型选的分支的「出路」是 `outputVarsFor` 追加的那一项**,它不在用户的变量表里
      // —— 追加的判据是"这条出边有没有名字",所以这里要把它那几条出路算出来。
      //
      // ⚠️ **名字和调度器共用一份**(`edgeOptionNameOf`,2026-09-19)。这里原来自己写
      // 了一遍、而且**和调度器算的不是同一个词**:这一头给的是标题 ‖ **清单名**
      // (`子 agent`),调度器给的是标题 ‖ **类型 id**(`mcode.agent`)。
      //
      // 下面马上 `.map(v => v.name)`、把 `example` 丢了,所以**今天还没炸**:提示词里那
      // 句"交出「出路」"与它列出的一串名字,是调度器拿**同一个 `edgeOptionNameOf`** 现
      // 拼的(`branchOptionsOf` → `decisionSection`),一直是对的。但 `example` 在接口上
      // 的用途就是"给模型当样板",谁哪天不再丢它,这一步就会教模型一个调度器不认识的值
      // —— 于是必定失败且看不出为什么。一份实现没有这个面。
      const options =
        manifest !== undefined && isModelDecider(manifest, e.node.params)
          ? outgoingEdgesOf(doc, e.node.id).map((edge) =>
              edgeOptionNameOf(edge, doc, workflowNodeRefName),
            )
          : [];
      const outputKeys = manifest
        ? outputVarsFor(manifest, e.node.params, options).map((v) => v.name)
        : [];
      // **这一步花了多少。** 尽量当场带上,但 ⚠️ **多半带不上** —— 用量是那个回合结束
      // 之后由适配器异步推上来、再经 `settlePendingTurnEnd` 落库的(见
      // `RuntimeManager.usageOf` 的注释),而这里是节点刚收场的那一刻。
      //
      // 所以下面还有一条**补发**:过一小会儿再问一次,有数就再发一条同 id 的结果事件
      // (渲染端按 `runId + nodeId` 原地换掉那张卡,见 `sessionStore` 的 `workflow-node-result`
      // 分支 —— 那次是**不换卡、只补字段**)。没补上的话卡片上只是不显示花费,不影响别的。
      const usage = nodeSessionId ? usageOfSession(nodeSessionId) : undefined;
      // **过程快照跟着结果事件一起走。** 卡片要"跑完还能看见这一步干了什么",而活的那
      // 一份(渲染端按 `nodeSessionId` 索引的那张表)会随容量被裁、重开应用也没了 ——
      // 拷一份进卡片是唯一能跨这两件事的路(见 `WorkflowNodeResultEvent.transcript`)。
      //
      // 放在结果事件上而不是另发一条:两者是**同一刻的同一件事**,分开走的话中间那一
      // 瞬界面会拿到"卡片已经有了、过程还没到"的空档。
      //
      // ⚠️ 这里读到的是**此刻**那一份。`turn.done` 已经把最终文本折进去了(`text` 那一路
      // 在 `turn.done` 时收口),而 `message.complete` 折出来的中间态也在 —— 所以拿到的
      // 不是半截。
      const transcript = nodeSessionId ? runtimeManager.transcriptOf(nodeSessionId) : undefined;
      // ⚠️ **走 `emitExternal`,不能走 `broadcastRuntimeEvent`。** 两者对界面是一回事
      // (都 `fanOutToClients`),但只有 `emitExternal` 会 `notifySubscribers` ——
      // 而钩子(`HookRunner`)与自动化的「事件发生时」触发器**正是挂在订阅上**的。
      //
      // 这一条踩过:工作流的四个节点事件里,**只有这一个**在 `HOOK_EVENT_OF` 里给了
      // 钩子事件名(`workflow.node.result`),另外三个是 `null`。于是设置里它被当成一个
      // 正常事件列出来、还配了提示语,用户挂上去**永远不会响** —— 而"挂上了却不响"正是
      // 仓库规矩第 3 条要禁的那种坏东西。同一处坑还有 `request.resolved`
      // (`RuntimeManager.notifyRequestResolved`),那条另算。
      runtimeManager.emitExternal({
        type: "workflow.node.result",
        sessionId: session.id,
        runId,
        ...(nodeSessionId ? { nodeSessionId } : {}),
        // 拷成可变数组:通道那一头是 `readonly`(主进程的那份不许别人改),
        // 而事件要过 IPC 序列化,合同上是可变的。
        ...(transcript && transcript.length > 0 ? { transcript: [...transcript] } : {}),
        // **回头绕上来的第二圈起才带。** 第 1 轮不带,是因为没有环的图永远是第 1 轮 ——
        // 字段不占地方,老行为一个字不改(见 `WorkflowNodeResultEvent.round`)。
        ...(e.round > 1 ? { round: e.round } : {}),
        nodeId: e.node.id,
        nodeType: e.node.type,
        title: displayTitle(e.node, manifests?.get(e.node.type)),
        status: e.outcome.status,
        summary: e.outcome.summary,
        ...(outputKeys.length > 0 ? { outputKeys } : {}),
        ...(e.outcome.error ? { error: e.outcome.error } : {}),
        ...(e.outcome.execution ? { execution: e.outcome.execution } : {}),
        ...(e.outcome.artifacts && e.outcome.artifacts.length > 0 ? { artifacts: e.outcome.artifacts } : {}),
        // **这次运行是触发器起的,就把载荷事实亮出来(G3)**:结果卡说得出"它是被
        // 什么触发的"。手动跑的图没有 entry.payload,这个字段就缺席。
        ...(entry?.payload !== undefined ? { input: { trigger: entry.payload } } : {}),
        ...(usage ? { usage } : {}),
      });
      if (nodeSessionId && usage === undefined) scheduleUsageBackfill(nodeSessionId, e.node.id);

      // 「并回主对话」—— 见 `@contracts/nodeType` 的 `NODE_RETURN_PARAM_KEY`。攒在这里、
      // 整张图跑完时一次挂上去(见收尾那一段):**中途挂没有意义**,因为取用它的是"主对话
      // 下一轮的话",而那一轮必然在图跑完之后。
      //
      // 只并**跑过的**那几步。`skipped` / `unselected` 是"这条路没走",报给主对话只会
      // 让它以为那一步做了点什么 —— 而它恰恰什么都没做。
      const mode = returnModeOf(e.node.params);
      if (mode !== "none" && (e.outcome.status === "success" || e.outcome.status === "failed")) {
        backflow.push(backflowSectionOf(mode, e.node, e.outcome, nodeSessionId));
      }
    },

    // 调度器说"我这儿的状态变了一下"。**它是唯一知道流程记录长什么样的地方**
    // (记录、轮次、谁跑过,全在它的闭包里),所以它不交出来就没有第二个人能落盘。
    //
    // 调用点只有四个:某一步定案、停在岔路口、抹环、收尾(见 `scheduler.ts` 的
    // `publish`)。**不是每来一个 token 一次** —— 一次写盘就是重写整个数据库文件。
    snapshot: (state) => writeRun("running", state),
    // **同时最多几个节点在跑。** 每次派发现读 —— 用户可能正开着设置页改它(照
    // `AutoArchiver` 读设置那个做法:改完下一批就生效,不需要推送同步)。
    //
    // 只有在这一层才碰得到 `SettingRepo`:调度器不知道设置存哪儿,也不该知道(和
    // `execute` / `snapshot` 那几个端口同一个理由)。
    maxParallel: () => {
      try {
        const raw = SettingRepo.get(WORKFLOW_MAX_PARALLEL_SETTING_KEY);
        const n = raw === null ? NaN : Number.parseInt(raw, 10);
        return Number.isFinite(n) ? n : WORKFLOW_MAX_PARALLEL_DEFAULT;
      } catch {
        // 读设置抛了(库坏了)也不该让整张图停摆 —— 退回默认值,和读不到一个待遇。
        return WORKFLOW_MAX_PARALLEL_DEFAULT;
      }
    },

    // **能力预检的清单(G4/CAP)**:这台机器的 descriptor 全集,一次算好、这次运行
    // 内复用(每次派发现读插件清单 = 把磁盘读 N 遍)。装配失败缓存住 undefined =
    // 这次运行不预检 —— 检查本身不能变成新的故障源(见 `RunPorts.capabilityInventory`)。
    //
    // ⚠️ `executorKinds` 必须与上面 `runEngine` 的注册保持一致:只有真的会经
    // Executor Registry 派发的 kind 才有资格当"executor 需求"(prompt 走兜底的
    // 模型轮,不在此列 —— 见 `requirementsForNode` 那条规则)。
    capabilityInventory: (() => {
      let cache: Promise<CapabilityPreflight | undefined> | undefined;
      return (): Promise<CapabilityPreflight | undefined> => {
        cache ??= (async (): Promise<CapabilityPreflight | undefined> => {
          try {
            const plugins = (await getEnabledPlugins()).map((p) => ({ name: p.name, manifest: p.manifest }));
            const executorKinds = ["command", "code", "conversation"] as const;
            return {
              inventory: collectCapabilityInventory({
                providers: providerRegistry.list(),
                plugins,
                executorKinds: [...executorKinds],
              }),
              executorKinds,
            };
          } catch (err) {
            log.warn(`workflow run ${runId}: 能力清单装配失败,这次运行跳过预检:${(err as Error).message}`);
            return undefined;
          }
        })();
        return cache;
      };
    })(),
  };

  let result: RunResult | null = null;
  try {
    result = await runWorkflow({
      doc,
      prompt,
      ports,
      signal: active.abort.signal,
      // 这次由哪个触发器起(自动化执行器给的)。续跑时上面已经把它从存档里接回来了。
      ...(entry !== undefined ? { entry } : {}),
      ...(resumed !== undefined
        ? {
            resume: {
              record: resumed.snapshot.state.record,
              rounds: resumed.snapshot.state.rounds,
              picks: resumed.snapshot.state.picks,
              // **已经定过案的一律不重跑,也不重判**(见 `RunResume.settled`)。
              // 真正会重跑的只有"跑到一半被打断的那一个" —— 它压根没有结局。
              settled: resumed.snapshot.state.outcomes,
              // 岔路口那一下(存在才给)。重试那条路没有 `answer`。
              ...(resumed.answer !== undefined
                ? { answer: { nodeId: resumed.nodeId, choice: resumed.answer } }
                : {}),
              // **失败重试**:要抹掉重跑的那一段(见 `RunResume.rewind`)。
              ...(resumed.rewind !== undefined ? { rewind: resumed.rewind } : {}),
              ...(resumed.note !== undefined ? { note: resumed.note } : {}),
              // 存档里有就以它为准(见 `runWorkflow` 里那一行:续跑是"同一次运行")。
              ...(resumed.snapshot.state.entry !== undefined
                ? { entry: resumed.snapshot.state.entry }
                : {}),
            },
          }
        : {}),
    });
    log.info(`workflow run ${runId} finished: ${result.status} (${session.id})`);
  } catch (err) {
    // 调度器内部已经把"一个节点炸了"降级成那个节点的 failed,走到这里说明是它自己
    // 出了问题。**不能让渲染端一直转圈**,所以照常收口(下面的 turn.done)。
    log.error(`workflow run ${runId} crashed: ${(err as Error).message}`);
  } finally {
    unsubscribe();
    // 兜底清一遍进度心跳(见 `heartbeats` 的注释)。正常路径上 `runInNodeSession`
    // 自己的 `finally` 已经清过了,这里扫到的只可能是"运行以别的方式死掉"留下的。
    for (const timer of heartbeats) clearInterval(timer);
    heartbeats.clear();
    // ⚠️ **认身份再删。** "用户在它等人时又说话了"那条路会**先**把条目摘掉、再等这里
    // 收完(见 `parkedRunTeardown`);不认身份的话,这一句会把**新那一次**从地图上
    // 抹掉 —— 而新的还在跑,于是这个对话再发消息会叠第二张图。
    if (runs.get(session.id) === active) runs.delete(session.id);
    // 还挂着的岔路口(正常路径走不到这里 —— 取消会让那个等待自己落地;这是给
    // "运行以别的方式死掉"兜底的)。留着的话那张卡片上的按钮会一直可点,而点了
    // 只是往一个没人听的 promise 里塞一个值。
    for (const [key, pending] of pendingChoices) {
      if (pending.sessionId === session.id) pendingChoices.delete(key);
    }
    // 节点会话的行留着(v1 的取舍:可查、以后加保留策略),但运行时没必要留着 ——
    // 它握着 provider 会话 id、文件快照和审批池。
    for (const id of active.nodeSessionIds) runtimeManager.dispose(id);
    // **「并回主对话」的内容在这里挂上去。** 时机是要紧的:它得在下面那句 `turn.done`
    // **之前** —— 那一句一落地,渲染端就把这一轮收了,用户接着说的话会立刻去取这段内容,
    // 晚一步就赶不上那一轮(而"晚一轮"的表现是助手答"我不知道",查都没处查)。
    if (backflow.length > 0) {
      queueBackflow(session.id, [`**${doc.name}** 各步的产出:`, ...backflow].join("\n\n"));
    }
    // **收尾这一下要写。** 它把这一行从 `running` 收成一个**终态** —— 而那是"能不能
    // 续跑"的唯一判据(`resumableFor` 只认 `interrupted`)。漏了它的话,一次跑完的
    // 图会永远停在 `running`,而用户点它任何一张旧卡片都会把**一次已经结束的运行**
    // 接起来重跑。
    //
    // 调度器自己抛了的话 `result` 是 null —— 那时最后一次 `snapshot` 端口调用的内容
    // 就是最新的,照实报 `failed` 即可。
    //
    // ⚠️ **算一次,下面那条收口的 reason 也读它。** 那两处曾经各算各的(这里是
    // `result === null ? "failed" : result.status`,那里是 `result?.status === "cancelled" ? …`),
    // 而"图定案为 failed、发出去的却是 end_turn"正是两处判据分家的那半截。收成一个
    // 变量之后,以后谁改了其中一处,另一处不会悄悄漂走。
    const settled: RunResult["status"] = result === null ? "failed" : result.status;
    writeRun(settled, result?.state ?? latest.state);

    // 这一轮对用户来说结束了。**用既有的 `turn.done` 收口**,不另发明一个事件:
    // 渲染端的"运行中"状态、这一轮消息的落盘、其他客户端的同步、以及系统通知全都挂在
    // 这个事件上(见 `sessionStore.ingestEvent` 的 turn.done 分支)。
    //
    // ⚠️ 走 `emitExternal` 而**不是** `broadcastRuntimeEvent`:后者不发观察者,图跑完了
    // 永远不弹通知(用户切走了就再也等不到)。父会话没有 provider 回合,所以这里不能
    // 借它的 `emit` 闭包 —— 这也正是 `emitExternal` 存在的原因。
    //
    // **三种收场,三个不同的 reason。** 从前只有两种:`cancelled → interrupted` 和
    // **"其余全部 → end_turn"** —— 而那张图失败的次数比成功多得多(一个节点炸了整张图
    // 就定案 failed),于是用户离开电脑回来看到的是「Agent 已完成本轮任务」。通知那头
    // 说的是一句谎话,而它恰恰是用户唯一能看到的信号。这不是措辞不好,是**失败被当成
    // 了成功报出去**。
    //
    // 收成 `error` 而不是新造一个取值:`TurnDoneReason` 里本来就有它(见
    // `@contracts/runtime`),三家适配器在轮末失败时发的就是它(Claude 的
    // `SdkMessageAdapter` 那条 error 结果、Codex 的 `CodexMessageAdapter`、Pi 的
    // `PiAgentSdkProvider`),`runner.ts` 自己读节点的收场也在读它(见 `outcomeOf`
    // 的 `reason === "error"`)。新增一个只给工作流用的取值会让每个消费方都要多认一个
    // 分支,而**没有任何一处**会因为"这是工作流失败"而做出与"这一轮失败"不同的反应。
    // 语义上它就是同一件事。
    //
    // ⚠️ **别顺手再补一条 `error` 事件。** 那条路看起来"更明确",但它是**第二条**
    // 终态:渲染端在 `error` 分支里既 `bumpUnread()` 又落一次盘、还会把
    // `runningBySession` 关掉 —— 同一个收场发两条,未读会加两次,而且那两处各自
    // 做一遍的清理会互相打架。`turn.done` 的 reason 才是"这一轮怎么了"的唯一出口,
    // 失败也一样。
    //
    // 回退链不受影响:`rt.fallbackModels` 对工作流会话是空的(见 `RuntimeManager`
    // 里那条 `!session.workflowId` 的判据),而且 `emitExternal` 绕开了 `emit` 闭包、
    // 那条链压根挂不上 —— 不会有"发个 error 就自动换个模型重跑一遍图"这回事。
    //
    // 取消收成 `interrupted` 而不是 `end_turn`:渲染端靠这个 reason 区分"正常跑完"和
    // "用户按了停止"(它据此决定要不要弹「回合完成」、要不要记未读)。
    //
    // ⚠️ **它必须在 `active.finish()` 之前。** 等那一下的人是"用户在它等人时又说话了"
    // 那条路(见 `parkedRunTeardown`)—— 它等到了就会立刻起新的一次运行,而新的会
    // 回声用户消息、开一个新回合。收口落在那之后的话,前一次的 `turn.done` 会把
    // **新的**那个回合提前关掉,现象是"图明明在跑,界面上却像已经结束了"。
    runtimeManager.emitExternal({
      type: "turn.done",
      sessionId: session.id,
      reason: settled === "cancelled" ? "interrupted" : settled === "failed" ? "error" : "end_turn",
      endedAt: Date.now(),
    });

    // **收干净了。** 等在这里的那个人可以往下走了 —— 上面这几行(地图条目、等待池、
    // 节点运行时、落盘、收口)**就是它等的全部内容**。这一句放在最后,是因为放在
    // 前面就等于在还没拆完的时候放行。
    active.finish();

    // **「退出流程」时用户写的那段话:作为下一条用户消息发进主对话。**
    //
    // 排在 `active.finish()` **之后**是刻意的:到这一刻这次运行才真的拆干净了 ——
    // 上面那句 `turn.done` 只是告诉界面"这一轮结束",而 `runs` 表、等待池、节点运行时
    // 是在 `finish()` 里放的。在这之前发,会撞上"主对话还占着"。
    //
    // 走的是和对话节点同一条路(回声 + 起一个正常回合,见 `runInConversation`)——
    // 用户在聊天里看到的就该是"我发了一句话,助手回了一轮",而不是一张工作流卡片。
    if (exitText !== null) {
      const text = exitText;
      try {
        runtimeManager.bindSession(session);
        runtimeManager.echoUserMessage(session.id, {
          id: uid("u_"),
          createdAt: Date.now(),
          blocks: [{ kind: "text", text }],
        });
        const handle = await runtimeManager.sendTurn(session, { prompt: text, cwd });
        // 主对话正忙时 `sendTurn` 返回 null(见 `runInConversation` 里同一条)。这一段
        // 已经发过回声了,所以那句话在聊天里看得见、用户可以自己重发 —— 只需要留一行。
        if (!handle) log.warn(`workflow run ${runId}: 退出后那句话没能发出去,主对话正忙`);
      } catch (err) {
        log.warn(`workflow run ${runId}: 退出后那句话没发出去: ${(err as Error).message}`);
      }
    }
  }

  return result;
}

/**
 * 给一个节点开一个隐藏子会话。
 *
 * 四处刻意:
 *  - **`claudeSessionId` 是 `null`**:节点开的是**一段全新的对话**,不是父会话的延续 ——
 *    主对话里聊过的任何东西都进不来(见 `workflowId` 那一条,那是唯一一条通路,而且
 *    只带得动全局条件,带不动对话)。
 *  - **`permissionMode` 由节点的能力推出**(见 `permissionModeForCapability`)。
 *  - **引擎可以按节点覆盖**(`provider` 参数),留空则跟着对话走。
 *  - **模型可以按节点覆盖**(`model` 参数),留空则跟着对话走。
 *
 * ⚠️ **换了引擎就不再继承模型。** 模型 id 不跨引擎通用(`claude-*` 的 id 递给 Codex 只
 * 会报错),所以一个换了引擎、又没自己指定模型的节点继承父会话的模型是**必错**的。这时
 * 留空、让那家引擎用它自己的默认模型,是唯一说得通的默认值。
 */
/**
 * 一步并回主对话的那一段(见 `@contracts/nodeType` 的 `NODE_RETURN_PARAM_KEY`)。
 *
 * 两种档的差别就是**要不要过程**:
 *
 * - `result`:标题 + 它交出来的东西(失败的那一步就是失败原因 —— 那条往往比成功更有用);
 * - `full`:再加上它这一轮**干了什么**(说了什么、调了哪些工具,见 `transcriptText`)。
 *
 * ⚠️ **没有会话就没有过程** —— 被取消的那一步、或者过程已经老到被容量上限裁掉时,
 * `full` 在这里悄悄退化成 `result`。不退化的做法是让整段并回失败,而"少了过程"远没有
 * "这一步的产出整个没告诉主对话"严重。
 */
function backflowSectionOf(
  mode: NodeReturnMode,
  node: WorkflowNode,
  outcome: NodeOutcome,
  nodeSessionId: string | undefined,
): string {
  const title = node.title.trim() || node.id;
  const body =
    outcome.status === "failed"
      ? `**这一步失败了**:${outcome.error ?? "(没说原因)"}`
      : outcome.summary.trim() || "(没有产出文本)";
  const head = `### ${title}\n${body}`;
  if (mode === "result" || nodeSessionId === undefined) return head;
  const process = transcriptText(runtimeManager.transcriptOf(nodeSessionId));
  return process.length > 0 ? `${head}\n\n**它这一轮做了什么**\n${process}` : head;
}

/**
 * 对话节点交出来的那段结构化文本 → **给人看的一张清单**。
 *
 * 用户明确说过不想在聊天框里看见 JSON,而对话节点的产出**就长在聊天框里** —— 所以这里
 * 把它解成「名字:值」逐条摊开(见 `RuntimeManager.holdTurnText`:原文先扣住,这一张
 * 才是推给界面的那一份)。
 *
 * **解不出来就原样返回。** 那一步接下来会因为"没按表交"而失败,而那种时候用户恰恰需要
 * 看见它到底交了什么 —— 和卡片上"提不出变量就退回原文"是同一条规矩。空着不给的话,
 * 那一轮在界面上就是**一片空白**,比看见一段不合规矩的 JSON 更没法排查。
 *
 * ⚠️ 换掉的只是**界面看到的**那一份:`NodeOutcome.summary` 仍然是原文,下游取的产出
 * 变量、`withOutputCheck` 查的东西,全都对的是原文。
 */
function structuredReplyText(text: string, vars: readonly OutputVar[]): string {
  const check = checkOutput(text, vars);
  if (!check.ok || check.value === undefined) return text;
  const picked = pickOutputs(check.value, vars);
  return vars
    .map((v) => {
      // 与 scheduler 的流程记录同一条转换规则(收口在 outputValueText)
      const shown = outputValueText(picked[v.name]);
      return `**${v.name}**:${shown.length > 0 ? shown : "(空)"}`;
    })
    .join("\n\n");
}

/**
 * 这一步的会话,**按 (对话, 节点) 复用,不是每次新建**。
 *
 * ## 为什么要复用
 *
 * 以前这里无条件 `SessionRepo.create(...)`,于是每跑一次图就在库里堆一个新会话行 ——
 * 那些行**没有任何东西指向它们来自哪一格**(`parent_session_id` 只说得出"属于哪个
 * 对话",而一个对话里有很多格)。后果是重启之后没有入口能找回"那一步的会话":
 * 看板数据跟着进程活,进程一关就空,而库里那几十行孤儿谁也认不出来。
 *
 * 复用之后形状就对了:一个对话里**每一步留下一个会话**,里面是它的历史轮次。
 * 和 `automationRunner.sessionOf` 是同一个思路(那边一条自动化一个会话)。
 *
 * ## 复用时**不覆盖**任何东西
 *
 * 认回来就直接交还,一个字段都不动 —— 会话是可对话的对象,它记着用户跟这一步说过什么、
 * 用的是哪家引擎。后来改图把这一步换成别的引擎,**不该**把这个会话的引擎改掉:那等于把
 * 这段对话搬到另一个模型上重读。引擎在新回合上生效(`sendTurn` 的入参),不落在会话行上。
 *
 * 标题同理**不跟着图上的格子名走**:图上改名是"这一步的说明变了",而标题是**这条会话
 * 自己的**(用户可能自己改过,见 `session.rename`)。每次跑图按图重写一遍,等于把他改的
 * 名字抹掉。(建新行时当然取格子名 —— 那是排查时唯一能认出"这是哪一步"的线索。)
 *
 * 老行(加 `node_id` 之前建的)是 `node_id IS NULL` 的孤儿,认不回来,留着不删。
 */
function nodeSessionOf(
  conversation: Session,
  node: WorkflowNode,
  manifest: NodeTypeManifest,
  engine: string | undefined,
): Session {
  const existing = SessionRepo.findNodeByNodeId(conversation.id, node.id);
  if (existing !== undefined) return existing;

  const now = Date.now();
  const override = node.params.model;
  const model =
    typeof override === "string" && override.trim().length > 0 ? override.trim() : conversation.model;
  const providerId = engine ?? conversation.providerId;
  const sameEngine = providerId === conversation.providerId;
  const session: Session = {
    id: uid("sess_"),
    projectId: conversation.projectId,
    providerId,
    claudeSessionId: null,
    kind: "node",
    parentSessionId: conversation.id,
    // 图上哪一格 —— (对话, 节点) 是这一行的身份,见 `Session.nodeId`。
    nodeId: node.id,
    // 标题是**给排查用的**(节点会话不进任何列表):图上的标题比 "节点" 有用得多。
    title: displayTitle(node, manifest),
    status: "idle",
    model: sameEngine ? model : "",
    effort: conversation.effort,
    permissionMode: permissionModeForCapability(node.capability ?? manifest.capability),
    // ⚠️ **继承父对话选的流程,不是 `"default"`。** 节点会话带着同一张流程的 id,
    // 任何按"这个会话属于哪张流程"读的东西(续跑、运行上下文)才不会认错。注意
    // 「固定条件」**不**走这条路:它在 `startWorkflowRun` 里拼进运行最初那条提示词、
    // 只进主节点一次(见上面注入那段),节点会话的系统提示词不再携带条件。
    workflowId: conversation.workflowId,
    customModelId: sameEngine ? conversation.customModelId : null,
    // **继承父会话的工作环境**,哪怕节点自己不隔离(v1 所有节点跑在父会话的 cwd)。
    // `removeWorktree` 那条"别把目录从正在跑的回合底下抽走"的判断,是拿
    // `listByWorktreePath` 与会话运行状态求交的 —— 节点行的 `worktree_path` 为空时
    // 它看不见节点,于是图还在跑、工作树却被删掉了。
    envMode: conversation.envMode,
    worktreePath: conversation.worktreePath ?? null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(session);
  return session;
}
