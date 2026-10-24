import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive, type LiveNode } from "@renderer/lib/workflowLive.js";
import { MessageBlocks } from "@renderer/components/chat/MessageBlocks.js";
import { mapTranscriptBlock } from "@renderer/components/chat/transcriptBlocks.js";
import { SUBAGENT_STATUS_META, fmtUsage } from "@renderer/components/chat/activityShared.js";
import {
  IconArrowLeft,
  IconListTree,
  IconLoader2,
  IconRefresh,
  IconRobot,
  IconTerminal2,
  IconX,
} from "@renderer/lib/icons.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { InfoHint } from "@renderer/components/ui/index.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { SubagentSnapshot, TranscriptBlock } from "@contracts/runtime";
import type { TerminalInfo, TerminalOrigin } from "@contracts/ipc";

/** 刷新间隔。终端是**这个进程里的活物**,它什么时候被开出来不由这边决定
 *  (另一个项目、另一个会话那边也能开),所以只能轮询。2 秒足够"我这边刚点新建
 *  就出现在列表里",而 `terminal:list` 只读一张 Map,不碰磁盘。
 *
 *  子代理与工作流节点**不用轮询** —— 它们本来就在渲染端的 store 里,事件一到就重渲染。 */
const POLL_MS = 2_000;

// xterm 只在点开一条终端时才加载(和终端面板一样懒加载)。
const ReadonlyTerminal = lazy(() =>
  import("./ReadonlyTerminal.js").then((m) => ({ default: m.ReadonlyTerminal })),
);

/**
 * 关掉一条终端(结束它的进程)。以前这个列表只能看、不能关 —— 代理开出来的终端
 * 没有别的入口能结束。手机端 `terminal.kill` 返回 ok:false + 原因,照样提示出来。
 */
async function killTerminal(terminalId: string, failTitle: string): Promise<boolean> {
  try {
    const res = await api.terminal.kill({ terminalId });
    if (res.ok) return true;
    useToastStore.getState().push({ kind: "error", title: failTitle, body: res.error });
  } catch (err) {
    useToastStore.getState().push({ kind: "error", title: failTitle, body: err instanceof Error ? err.message : String(err) });
  }
  return false;
}

/** 稳定空引用(避免每次渲染造新数组,把下游选择器打穿 —— 见 AGENTS.md 那条)。 */
const EMPTY_TERMINALS: TerminalInfo[] = [];
const EMPTY_AGENTS: SubagentSnapshot[] = [];

/** 每组最多列几行,超出的用一句"还有 n 个"收口。列表是**用来看正在跑什么**的,
 *  不是档案 —— 几十行会把这一页撑成一面墙,真正想看的那几个反而淹了。 */
const GROUP_CAP = 8;

/**
 * **正在跑的** —— 右栏的一个页面,一个地方看得见这台机器上此刻在干什么。
 *
 * ## 为什么三样放在同一页
 *
 * 它们回答的是同一个问题,只是层次不同:
 *
 *   1. **终端** —— 用户开的、将来代理开的 shell。进程活着,能打字。
 *   2. **子代理** —— 某个会话里正在跑的 Task(模型自己派出去的分身)。
 *   3. **工作流节点** —— 某张图上的某一步,跑在一个隐藏子会话里。
 *
 * 分开做三个地方的话,用户得先判断"我刚才那个东西属于哪一种"才能找到它。放一起之后
 * **只有一个入口**,三类各带分组标题,而每一行都能点开看**里面发生了什么** —— 那才是
 * 这一页真正的价值:不是"列出名字",是**看得见代理想在干什么**。
 *
 * ## 点开就在这一页看,不跳走
 *
 * 点某一行 → 这一页切成那一条的详情(顶部留一个"返回列表")。终端的详情是它此刻的
 * 输出尾巴 + 之后的实时推送;子代理与工作流节点是它自己的过程转录。
 *
 * ⚠️ 终端的详情是**只读**的,而且刻意不去 `resize` —— 一条终端只有**一个**尺寸,
 * 两个客户端各按自己的窗口去 resize 会让 shell 的换行彻底乱掉。要打字得切到这条终端
 * 真正所在的那个面板(它有 xterm 和真实尺寸),那句话就写在详情顶上。
 *
 * ## 只列还没定案的
 *
 * 子代理只列 `running`、节点只列 `queued`/`running`,终端的记录本来就在退出时被删掉。
 * 跑完的**不在这里** —— 它们已经收场了,该去对话流里那张卡上看(卡自己带一份快照)。
 * 混进来的话,"正在跑"这个判断就得靠用户自己从每一行的小字里去分辨。
 *
 * ## 诚实的边界
 *
 * 子代理与节点的两份账都是**内存里的**,各有容量上限(见 `sessionStore` 里
 * `NODE_ARCHIVE_KEEP` / `NODE_TRANSCRIPT_LIMIT` 那两段)。所以某一步点开来可能是空的,
 * 而那不是"它没干活" —— 详情里那句话会**分开说**这两种情况(还没开始 / 过程已被裁掉)。
 */
export function TaskListPanel() {
  const { t } = useI18n();
  const [terminals, setTerminals] = useState<TerminalInfo[]>(EMPTY_TERMINALS);
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  // ── 子代理 / 工作流节点:都在 store 里,不需要轮询 ──
  const sessions = useSessionStore((s) => s.streamSessions);
  const subagentsBySession = useSessionStore((s) => s.subagentsBySession);
  const clearFinishedSubagents = useSessionStore((s) => s.clearFinishedSubagents);
  const stopSubagent = useSessionStore((s) => s.stopSubagent);
  const nodeTranscripts = useSessionStore((s) => s.workflowNodeTranscripts);
  const live = useWorkflowLive();

  /** 会话 id → **真实的**标题,**查不到返回 null**。
   *
   *  ⚠️ 这里刻意**不**兜底成 id 前几位。「谁开的」那一行要分得清两种情况:
   *  ① 那个会话还在列表里,直接报它的名字;② 那个会话**已经不在**了(别的窗口开的、
   *  会话删了、是另一个项目里跑的)—— 那时候该说「会话 s9 开的」,而不是把 id 前几位
   *  当成一个名字硬安上去(读起来像"有个叫 s9 的会话")。
   *
   *  之前这里直接兜底了,于是下面 `originSessionUnknown` 那一支**永远走不到** ——
   *  那句措辞和那个 key 都是死的。真浏览器里点出来才看见。 */
  const titleOrNull = useCallback(
    (sessionId: string) => sessions.find((s) => s.id === sessionId)?.title?.trim() || null,
    [sessions],
  );

  /** 会话 id → 一行小字里用的名字。查不到就拿 id 前几位顶上 —— 子代理/节点那两栏的
   *  第二行总要有点东西,**和「谁开的」不是一回事**(那边用 `titleOrNull`)。 */
  const titleOf = useCallback(
    (sessionId: string) => titleOrNull(sessionId) ?? sessionId.slice(0, 8),
    [titleOrNull],
  );

  // 单调序号:只有最新一次在飞的 `terminal.list` 能写 state。这个面板按固定间隔轮询,
  // 弱网/慢机器下一次的请求可以盖在上一次还没回来的时候发出 —— 没有它的话,先发后回的
  // 那一次会把新列表盖成旧的(刚关掉的终端又冒出来 / 刚开的没出现)。仓库里同类轮询
  // 都补了 *Seq 守卫(GitPanel.scanSeqRef / UsagePanel.loadSeqRef),这里补齐同一份。
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    // ⚠️ **必须包 try/catch,而且必须兜住整个调用。** 手机端(`webApi.ts`)虽然也实现了
    // `terminal.list`,但网络断、没配对、电脑端刚重启都会让这个 promise 直接 reject;而
    // 这个函数跑在 `useEffect` 的定时器里,一个没被接住的拒绝在 React 19 下会把整棵渲染
    // 树卸掉(这个仓库实测过)。
    const seq = ++refreshSeqRef.current;
    try {
      const res = await api.terminal.list({});
      if (seq !== refreshSeqRef.current) return; // 有更新的一次在飞,这次作废
      setTerminals(res?.terminals ?? EMPTY_TERMINALS);
    } catch {
      if (seq !== refreshSeqRef.current) return;
      setTerminals(EMPTY_TERMINALS);
    }
  }, []);

  // 这一页开着就一直在,没有"关着的时候" —— 所以固定间隔轮询即可。
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void refresh();
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  /**
   * 子代理:**列全部**,不只是 running（2026-10-10 改）。
   *
   * 从前这里带 `status === "running"` 的过滤。改成列全部有两个理由:
   *
   *  1. 这一页现在**也**是原生子代理唯一的列表(2026-10-10 从 `SideChatPanel` 移过来) ——
   *     那边一直是"跑完的留在下面可回看"。若这边只列 running,那些跑完的就**哪儿都看不到**
   *     了(它们的转录还在 store 里,只是没有入口)。
   *  2. 跑完的那几条本来就**一直在** store 的名册里(主进程刻意按会话保留,
   *     见 `RuntimeManager` 那句 `rt.lastSubagents`),藏起来并没有让它们消失,
   *     只是让用户看不到。既然收不掉,就显示出来 —— 再给一个「清空已结束」让用户能收。
   *
   * running 排前面(稳定排序保留到达顺序):正在跑的是用户此刻要盯的。
   */
  const orderedAgents = useMemo(() => {
    const out: Array<{ sessionId: string; agent: SubagentSnapshot }> = [];
    for (const [sessionId, list] of Object.entries(subagentsBySession)) {
      for (const agent of list ?? EMPTY_AGENTS) {
        // ⚠️ 判空要**在这里**,不能等渲染时再用可选链兜:`agents` 那个字段真的可能是
        //    undefined(见 store 里 `subagentsBySession` 的写入路径),而 `[]` 之外的
        //    任何假值放进去,下面 `agent.status` 就是一次当场崩。
        if (agent) out.push({ sessionId, agent });
      }
    }
    return out.sort((a, b) => (a.agent.status === "running" ? 0 : 1) - (b.agent.status === "running" ? 0 : 1));
  }, [subagentsBySession]);

  const runningAgents = useMemo(
    () => orderedAgents.filter((x) => x.agent.status === "running"),
    [orderedAgents],
  );

  /**
   * **按类型分两组**（2026-10-11，与 Claude Code 桌面端一致）。
   *
   * 用户的要求：「能够显示出来任务类型，是 agent 还是 bash」。分两组的理由与 cc 桌面端
   * 一样：这两类的**点开内容**根本不是一回事 —— agent 点开是「主代理交给它的任务 +
   * 它的对话过程」，bash 点开是「那行命令 + 它的输出」。混在一列里，用户得先看名字猜。
   *
   * 判据是 `taskType`（SDK 的 `task_type`）。**认不出的类型归到 agent 那组**：
   * `local_agent` 是绝大多数，而且认不出时把一条模型任务塞进「Bash」组里读着是错的；
   * 反过来（一条 bash 混进 Agent 组）至少不会说假话。老 CLI 不发 `taskType`，
   * 那时所有条目都落进 Agent 组 —— 与这一页从前只有 agent 的样子一致。
   */
  const agentTasks = useMemo(
    () => orderedAgents.filter((x) => x.agent.taskType !== "local_bash"),
    [orderedAgents],
  );
  const bashTasks = useMemo(
    () => orderedAgents.filter((x) => x.agent.taskType === "local_bash"),
    [orderedAgents],
  );

  /** 已结束的那几条 —— 「清空已结束」按钮按这个数决定显不显示。 */
  const finishedAgentKeys = useMemo(
    () => orderedAgents.filter((x) => x.agent.status !== "running").map((x) => `${x.sessionId}:${x.agent.taskId}`),
    [orderedAgents],
  );

  /** 工作流节点:只看没定案的(queued / running)。 */
  const activeNodes = useMemo(() => {
    const out: Array<{ sessionId: string; node: LiveNode }> = [];
    for (const run of Object.values(live.runs)) {
      for (const nodeId of run.order) {
        const node = run.nodes[nodeId];
        if (!node || node.phase === "settled") continue;
        out.push({ sessionId: run.sessionId, node });
      }
    }
    return out;
  }, [live.runs]);

  const count = terminals.length + runningAgents.length + activeNodes.length;

  if (detail) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailHeader
          target={detail}
          titleOf={titleOf}
          onKill={
            detail.kind === "terminal" && isElectron
              ? () => {
                  void killTerminal(detail.info.terminalId, t("ide.task.killFailed")).then((ok) => {
                    if (!ok) return;
                    setDetail(null);
                    void refresh();
                  });
                }
              : undefined
          }
          onBack={() => {
            setDetail(null);
            // 返回时顺手刷一次:查看期间这条终端可能已经退出了,列表得跟上。
            void refresh();
          }}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          {detail.kind === "terminal" ? (
            <TerminalOutputPanel info={detail.info} />
          ) : detail.kind === "subagent" ? (
            // 两个子组件分开挂,而不是在这里按 kind 调不同的 hook —— 条件调 hook 会在
            // 换一个条目查看时改变 hook 顺序,那是 React 直接报错的形状。
            <SubagentTranscript sessionId={detail.sessionId} agent={detail.agent} />
          ) : (
            <NodeTranscript node={detail.node} nodeTranscripts={nodeTranscripts} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标题条:这一页是什么 + 一共几个在跑 + 手动刷新。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1.5">
        <span className="text-[11px] font-medium text-content">{t("ide.task.pageTitle")}</span>
        <span className="text-[10px] tabular-nums text-content-subtle">{count}</span>
        <InfoHint side="bottom">{t("ide.task.pageDesc")}</InfoHint>
        <button
          type="button"
          title={t("ide.task.refresh")}
          onClick={() => void refresh()}
          className="cds-hover-ghost ml-auto shrink-0 rounded p-1 text-content-subtle hover:text-content"
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {count === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-content-subtle">
            <IconListTree size={20} />
          </div>
          <p className="text-code font-medium text-content-muted">{t("ide.task.empty")}</p>
          <p className="text-[11px] leading-relaxed text-content-subtle">{t("ide.task.emptyHint")}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {/* ── 终端:进程活着、能打字 ── */}
          <Group label={t("ide.task.groupTerminals")} total={terminals.length} />
          {terminals.slice(0, GROUP_CAP).map((info) => (
            <Row
              key={info.terminalId}
              icon={<IconTerminal2 size={12} />}
              lit={info.pid > 0}
              title={originLabel(info.origin, t, titleOrNull)}
              sub={info.cwd}
              full={info.cwd}
              actionTitle={t("ide.task.view")}
              onOpen={() => setDetail({ kind: "terminal", info })}
              trailing={isElectron ? {
                title: t("ide.task.killTerminal"),
                onClick: () => {
                  void killTerminal(info.terminalId, t("ide.task.killFailed")).then((ok) => {
                    if (ok) void refresh();
                  });
                },
              } : undefined}
            />
          ))}
          <More total={terminals.length} />

          {/* ── 任务:Agent 与 Bash 分两组（2026-10-11，对标 cc 桌面端） ──
              类别的徽标在 `TaskRow` 里画（`Agent` / `Bash`），不是只靠分组标题 ——
              用户扫一行时就该看出它是哪一类。 */}
          <Group
            label={t("ide.task.groupAgentTasks")}
            total={agentTasks.length}
            action={
              finishedAgentKeys.length > 0
                ? {
                    title: t("ide.task.clearFinishedHint"),
                    label: t("ide.task.clearFinished", { n: finishedAgentKeys.length }),
                    onClick: () => clearFinishedSubagents(),
                  }
                : undefined
            }
          />
          {agentTasks.slice(0, GROUP_CAP).map((entry) => (
            <TaskRow
              key={`${entry.sessionId}:${entry.agent.taskId}`}
              entry={entry}
              titleOf={titleOf}
              onOpen={(sessionId, agent) => setDetail({ kind: "subagent", sessionId, agent })}
            />
          ))}
          <More total={agentTasks.length} />

          <Group label={t("ide.task.groupBashTasks")} total={bashTasks.length} />
          {bashTasks.slice(0, GROUP_CAP).map((entry) => (
            <TaskRow
              key={`${entry.sessionId}:${entry.agent.taskId}`}
              entry={entry}
              titleOf={titleOf}
              onOpen={(sessionId, agent) => setDetail({ kind: "subagent", sessionId, agent })}
            />
          ))}
          <More total={bashTasks.length} />

          {/* ── 工作流节点:图上的某一步 ── */}
          <Group label={t("ide.task.groupNodes")} total={activeNodes.length} />
          {activeNodes.slice(0, GROUP_CAP).map(({ sessionId, node }) => (
            <Row
              key={`${node.runId}:${node.nodeId}`}
              icon={<IconLoader2 size={12} className="animate-spin" />}
              lit
              // ⚠️ 排队的节点**两样都可能没有**:`workflow.node.queued` 事件只带 id
              //    三件套,标题和类型都要等 progress/result 才到(见 `@contracts/runtime`
              //    的 `WorkflowNodeQueuedEvent`)。不加这层兜底的话,这一行就是**空白**的
              //    —— 一行什么都没有,看起来像列表坏了。
              title={node.title || node.nodeType || t("ide.task.groupNodes")}
              sub={[titleOf(sessionId), node.nodeType].filter(Boolean).join(" · ")}
              actionTitle={t("ide.task.view")}
              onOpen={() => setDetail({ kind: "node", sessionId, node })}
            />
          ))}
          <More total={activeNodes.length} />
        </div>
      )}
    </div>
  );
}

/* ────────────────────────── 分组标题 / 溢出收口 ────────────────────────── */

/**
 * 分组标题 + 计数。右边可挂**一个**小动作（目前只有子代理那一组用：
 * 「清空已结束」）。做成可选槽而不是每种分组各写一段，是因为这几个分组标题
 * 必须长得一样 —— 多一个动作不该让那行标题变形。
 */
function Group({
  label,
  total,
  action,
}: {
  label: string;
  total: number;
  action?: { title: string; label: string; onClick: () => void };
}) {
  if (total === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5 px-2 py-0.5">
      <span className="text-[9px] uppercase tracking-wide text-content-subtle">{label}</span>
      <span className="text-[9px] tabular-nums text-content-subtle/70">{total}</span>
      {action && (
        <button
          type="button"
          title={action.title}
          onClick={action.onClick}
          className="cds-hover-ghost ml-auto shrink-0 rounded px-1 text-[9px] text-content-subtle hover:text-content"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function More({ total }: { total: number }) {
  const { t } = useI18n();
  if (total <= GROUP_CAP) return null;
  return (
    <div className="px-2 pb-1 text-[10px] leading-relaxed text-content-subtle">
      {t("ide.task.listMore", { n: total - GROUP_CAP })}
    </div>
  );
}

/**
 * 一个**任务**行（Agent 或 Bash）—— 与终端行共用 `Row`，只多两样:
 *
 *  1. **类别徽标**（`Agent` / `Bash`）—— 用户要求「显示出来任务类型，是 agent 还是 bash」。
 *     徽标样式照抄仓里既有的"类型胶囊"（`SideChatPanel.SubagentRow` 那个 `subagent_type`
 *     小标签），不再造第二套。
 *  2. **图标分两类**：Agent 用 `IconRobot`，Bash 用 `IconTerminal2` —— 两个图标本文件
 *     已经在别的行上用了。
 *
 * 点开走的是**外层那一个** `detail` 机制（`onOpen` 回调）—— 不在这里自建第二个详情态，
 * 否则同一个面板里会有两套"点开"、两份状态，其中一套迟早忘记清理。
 *
 * 停止按钮只给正在跑的（与终端行的"关闭"同一个 `trailing` 槽）。bash 任务**同样点得开** ——
 * 那是用户明确要的。
 */
function TaskRow({
  entry,
  titleOf,
  onOpen,
}: {
  entry: { sessionId: string; agent: SubagentSnapshot };
  titleOf: (sessionId: string) => string;
  onOpen: (sessionId: string, agent: SubagentSnapshot) => void;
}) {
  const { t } = useI18n();
  const stopSubagent = useSessionStore((s) => s.stopSubagent);
  const { sessionId, agent } = entry;
  const isBash = agent.taskType === "local_bash";
  const running = agent.status === "running";
  const statusMeta = SUBAGENT_STATUS_META[agent.status];
  const usage = fmtUsage(agent, t);
  return (
    <Row
      icon={isBash ? <IconTerminal2 size={12} /> : <IconRobot size={12} />}
      lit={running}
      badge={<TaskKindBadge kind={isBash ? "bash" : "agent"} />}
      title={agent.description || t("ide.task.agentUntitled")}
      // 状态与用量摆第二列 —— 与 cc 桌面端一样:一眼看得出在跑还是跑完了、跑了多久。
      sub={[t(statusMeta.labelKey), titleOf(sessionId), agent.subagentType, usage]
        .filter(Boolean)
        .join(" · ")}
      actionTitle={t("ide.task.view")}
      onOpen={() => onOpen(sessionId, agent)}
      trailing={
        running
          ? { title: t("ide.task.stopAgent"), onClick: () => void stopSubagent(sessionId, agent.taskId) }
          : undefined
      }
    />
  );
}

/** 类别胶囊。样式与 `SideChatPanel` 那个 `subagent_type` 标签同款（类型徽标已有实现，
 *  不再造第二套配色）。两类各一个色:Agent 用 info,Bash 用 warning —— 与 `activityShared`
 *  里给"子代理"那份配色同一个语汇。 */
function TaskKindBadge({ kind }: { kind: "agent" | "bash" }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide",
        kind === "bash" ? "bg-warning/20 text-warning" : "bg-info/20 text-info",
      )}
    >
      {t(kind === "bash" ? "ide.task.kindBash" : "ide.task.kindAgent")}
    </span>
  );
}

/**
 * 一行 = 一整块可点区域(不是只有右边那个小图标能点)。这一页是**拿来点的**,
 * 把命中区做成一整行,用户不用瞄准。
 */
function Row({
  icon,
  lit,
  badge,
  title,
  sub,
  full,
  actionTitle,
  onOpen,
  trailing,
}: {
  icon: React.ReactNode;
  /** 还活着 —— 图标高亮。已退出的终端也照样列(它仍占着一个面板),只是暗一点。 */
  lit: boolean;
  /** 标题前的小徽标（目前只有任务行用：`Agent` / `Bash` 那个类别胶囊）。 */
  badge?: React.ReactNode;
  title: string;
  sub: string;
  /** 悬停时给的完整文本(列表里那一行是截断的)。 */
  full?: string;
  actionTitle: string;
  onOpen: () => void;
  /** 行尾的小按钮(终端行:关闭)。和整行的「查看」分开,不嵌套 button。 */
  trailing?: { title: string; onClick: () => void };
}) {
  return (
    <div className="group flex w-full items-start hover:bg-surface-muted/50">
    <button
      type="button"
      title={actionTitle}
      onClick={onOpen}
      className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
    >
      <span className={cn("mt-0.5 shrink-0", lit ? "text-accent" : "text-content-subtle")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {badge}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-content" title={title}>
            {title}
          </span>
        </span>
        <span className="block truncate font-mono text-[10px] text-content-subtle" title={full ?? sub}>
          {sub}
        </span>
      </span>
    </button>
    {trailing && (
      <button
        type="button"
        title={trailing.title}
        aria-label={trailing.title}
        onClick={trailing.onClick}
        className="cds-hover-ghost mr-1 mt-1 shrink-0 rounded p-1 text-content-subtle opacity-60 hover:text-danger group-hover:opacity-100"
      >
        <IconX size={12} />
      </button>
    )}
    </div>
  );
}

/* ────────────────────────── 详情顶栏 ────────────────────────── */

type DetailTarget =
  | { kind: "terminal"; info: TerminalInfo }
  | { kind: "subagent"; sessionId: string; agent: SubagentSnapshot }
  | { kind: "node"; sessionId: string; node: LiveNode };

function DetailHeader({
  target,
  titleOf,
  onBack,
  onKill,
}: {
  target: DetailTarget;
  titleOf: (sessionId: string) => string;
  onBack: () => void;
  /** 只有终端有:结束这条终端的进程。 */
  onKill?: () => void;
}) {
  const { t } = useI18n();

  const title =
    target.kind === "terminal"
      ? t("ide.task.detailTerminal")
      : target.kind === "subagent"
        ? target.agent.description || t("ide.task.agentUntitled")
        : target.node.title || target.node.nodeType;

  const sub =
    target.kind === "terminal"
      ? target.info.cwd
      : target.kind === "subagent"
        ? [titleOf(target.sessionId), target.agent.subagentType].filter(Boolean).join(" · ")
        : [titleOf(target.sessionId), target.node.nodeType].filter(Boolean).join(" · ");

  return (
    <div className="flex shrink-0 items-start gap-1.5 border-b border-edge px-2 py-1.5">
      <button
        type="button"
        title={t("ide.task.back")}
        onClick={onBack}
        className="cds-hover-ghost mt-0.5 shrink-0 rounded p-1 text-content-subtle hover:text-content"
      >
        <IconArrowLeft size={13} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-content" title={title}>
          {title}
        </div>
        <div className="truncate font-mono text-[10px] text-content-subtle" title={sub}>
          {sub}
        </div>
      </div>
      {onKill && (
        <button
          type="button"
          title={t("ide.task.killTerminal")}
          onClick={onKill}
          className="cds-hover-ghost mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] text-content-subtle hover:text-danger"
        >
          <IconX size={12} />
          {t("ide.task.killTerminalShort")}
        </button>
      )}
    </div>
  );
}

/* ── 终端:尾巴 + 实时推送 ── */

/**
 * 接入一条终端的输出。
 *
 * ## 为什么要先要一次尾巴
 *
 * 渲染端拿到的输出是**纯推送**(`terminal:data`):一条不是这个页面创建的终端,我们
 * 手上什么都没有。所以这里把主进程留着的那段尾巴取回来(`terminal.list` 的
 * `bufferFor`,环的容量见 `TERMINAL_BUFFER_CHARS`),先把它打进去,再挂上后续的实时
 * 推送 —— 于是点开看到的是它**现在**的样子,而不是从点击那一刻起才有内容。
 *
 * ## 只读,而且刻意不 resize
 *
 * 要打字得切到这条终端真正所在的那个面板(它有自己的 xterm 和真实尺寸)。这里只订阅、
 * 不写、也不去 `resize`:一条终端只有**一个**尺寸,两个客户端各按自己的窗口去 resize
 * 会让 shell 的换行彻底乱掉。
 */
function TerminalOutputPanel({ info }: { info: TerminalInfo }) {
  const { t } = useI18n();
  const preRef = useRef<HTMLPreElement | null>(null);
  const [text, setText] = useState("");
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let buffer = "";

    // 订阅**先挂上**再取尾巴:反过来的话,取尾巴那次 IPC 往返期间吐出来的输出会两边
    // 都不在(尾巴里没有,推送也没人接)。
    const unsub = api.on.terminalData((msg) => {
      if (cancelled || msg.terminalId !== info.terminalId) return;
      buffer += msg.data;
      setText(buffer);
    });
    const unsubExit = api.on.terminalExit((msg) => {
      if (cancelled || msg.terminalId !== info.terminalId) return;
      setGone(true);
    });

    void (async () => {
      try {
        const res = await api.terminal.list({ bufferFor: info.terminalId });
        if (cancelled) return;
        const found = (res?.terminals ?? []).find((x) => x.terminalId === info.terminalId);
        if (!found) {
          // 打开的这一瞬它刚好退出/被杀 —— 说清楚,别装作是空的。
          setGone(true);
          return;
        }
        buffer = found.buffer ?? "";
        setText(buffer);
      } catch {
        // 拿不到尾巴就只显示之后的实时输出 —— 不抛(同上面 refresh 那条)。
      }
    })();

    return () => {
      cancelled = true;
      unsub();
      unsubExit();
    };
  }, [info.terminalId]);

  // 跟着尾巴走:新内容到了就滚到底。
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1 text-[10px] text-content-subtle">
        <span className="truncate">{t("ide.task.readOnly")}</span>
        <span className="ml-auto shrink-0">{gone ? t("ide.task.gone") : t("ide.task.following")}</span>
      </div>
      {text.length > 0 ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <ReadonlyTerminal text={text} />
          </Suspense>
        </div>
      ) : (
      <pre
        ref={preRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-surface-muted/30 p-2 font-mono text-[11px] leading-tight text-content"
      >
        {/* 没有输出时说一句（用户 2026-09-21 点名要的：「如果没有内容输出就显示
            还没有输出」）。**不能留空白** —— 一片空的 `<pre>` 和"终端卡住了/没接上"
            在用户眼里长得一模一样，而他没有任何线索能分辨这两件事。 */}
        <span className="text-content-subtle">{t("ide.task.terminalNoOutput")}</span>
      </pre>
      )}
    </div>
  );
}

/* ── 子代理 / 工作流节点:只读转录 ── */

/**
 * 一个任务的过程详情 —— **两类共用这一个**（2026-10-11，对标 cc 桌面端）。
 *
 * 两类各自的"内容"是不同的东西，但**外壳一样**（上面一段"这是什么任务"，下面一段正文）：
 *
 *  - **Agent**：上面是**主代理交给它的任务原文**（`agent.prompt`），下面是它的对话过程
 *    （`subagent.transcript` 事件流）。用户点开一行最想看的就是"你让它干什么"——
 *    从前它只在提示词里，界面上根本看不到。
 *  - **Bash**：上面是那行命令（`description` 就是命令），下面是 CLI 写进 `outputFile`
 *    的输出（经 `claude.readTaskOutput` 读回来 —— 那条 IPC 会**校验路径前缀**）。
 *
 * `source` 缺省（老 CLI 不发、或过程被容量裁掉）时那句空态**分开说**：
 * "这个任务还没有输出" 与 "读不到它" 不是一回事，混成一句会让人以为任务没干活。
 */
function SubagentTranscript({ sessionId, agent }: { sessionId: string; agent: SubagentSnapshot }) {
  const { t } = useI18n();
  const isBash = agent.taskType === "local_bash";
  const source = useSessionStore(
    (s) => s.subagentTranscriptsBySession[sessionId]?.[agent.toolUseId ?? ""],
  );

  // bash 的输出不在事件流里 —— 它是一个文件。按需读一次（点开才读，不在列表里读）。
  const [bashOut, setBashOut] = useState<{ text: string; truncated: boolean } | null>(null);
  const [bashErr, setBashErr] = useState<string | null>(null);
  useEffect(() => {
    if (!isBash) return undefined;
    let cancelled = false;
    setBashOut(null);
    setBashErr(null);
    void api.claude
      .readTaskOutput({ sessionId, taskId: agent.taskId })
      .then((res) => {
        if (!cancelled) setBashOut(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBashErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isBash, sessionId, agent.taskId]);

  /** 上面那一段"这是什么任务"。两类都显示 —— 这正是用户要的"点开能看到交给它的任务"。 */
  const brief = isBash ? agent.description : agent.prompt;

  return (
    <div className="flex h-full flex-col">
      {brief !== undefined && brief.trim() !== "" && (
        <div className="shrink-0 border-b border-edge px-3 py-2">
          <div className="mb-1 text-[9px] uppercase tracking-wide text-content-subtle">
            {t(isBash ? "ide.task.bashCommand" : "ide.task.agentBrief")}
          </div>
          {/* 任务原文可能很长且带换行（子代理的 brief 就是一整段提示词）——
              限高 + 可滚，别把它撑成一屏把下面的过程挤没。 */}
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-content">
            {brief}
          </pre>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {isBash ? (
          bashErr !== null ? (
            <p className="px-3 py-4 text-[11px] text-danger">{t("ide.task.taskOutputUnreadable", { error: bashErr })}</p>
          ) : (
            <ReadonlyTranscript
              source={
                bashOut === null
                  ? undefined
                  : // 复用同一套只读转录外观：把纯文本包成一条 text 块，与 agent 那一侧的
                    // 观感一致（不新造一个"纯文本查看器"）。
                    [{ kind: "text", text: bashOut.text } as TranscriptBlock]
              }
              emptyHint={t("ide.task.transcriptWaiting")}
            />
          )
        ) : (
          <ReadonlyTranscript source={source} emptyHint={t("ide.task.transcriptWaiting")} />
        )}
      </div>
    </div>
  );
}

function NodeTranscript({
  node,
  nodeTranscripts,
}: {
  node: LiveNode;
  nodeTranscripts: Record<string, TranscriptBlock[]>;
}) {
  const { t } = useI18n();
  // 活的优先,查不到退回收场快照 —— 与看板详情面板同一套取法。
  const source = nodeTranscripts[node.nodeSessionId ?? ""] ?? node.nodeTranscript;
  // 空的时候**一句都不许含糊**:三种原因,三句话,不能说成一句。
  const emptyHint = node.nodeSessionId
    ? // ① 有会话 id 却查不到 —— 过程被容量裁掉了(它确实跑过)。
      t("ide.task.transcriptTrimmed")
    : node.phase === "running"
      ? // ② 正在跑但还没会话 id。⚠️ 真实情况:`workflowLive` 只在**收场**
        //    (result 事件)时写 `nodeSessionId`,跑着的节点身上没有它(见
        //    `lib/workflowLive.ts` 的 `workflow.node.progress` 那一支)。说
        //    "还没开始跑"就是个谎 —— 上面那行还转着圈呢。
        t("ide.task.transcriptRunning")
      : // ③ 排着队,真没跑过。
        t("ide.task.transcriptNotStarted");
  return <ReadonlyTranscript source={source} emptyHint={emptyHint} />;
}

/**
 * 只读转录。与侧栏那个子代理查看器是**同一份数据、同一个渲染组件**
 * (`mapTranscriptBlock` + `MessageBlocks`)—— 这里没有第二条渲染路。
 */
function ReadonlyTranscript({
  source,
  emptyHint,
}: {
  source: TranscriptBlock[] | undefined;
  emptyHint: string;
}) {
  const blocks: Block[] = useMemo(() => (source ?? []).map(mapTranscriptBlock), [source]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-2">
      {blocks.length === 0 ? (
        <p className="py-4 text-[11px] text-content-subtle">{emptyHint}</p>
      ) : (
        <MessageBlocks blocks={blocks} />
      )}
    </div>
  );
}

/* ────────────────────────── 「谁开的」那一行字 ────────────────────────── */

/**
 * 三档,与 `TerminalOrigin` 的判别式一一对应(`kind` 是**穷尽**的 —— 以后加一档时
 * typecheck 会在这里报缺分支,而不是静默落成"用户开的")。
 */
function originLabel(
  origin: TerminalOrigin,
  t: (key: MessageId, params?: Record<string, string | number>) => string,
  /** 会话表里**当前**的标题;**查不到等于 null**(不是拿 id 顶上)。 */
  titleOrNull: (sessionId: string) => string | null,
): string {
  if (origin.kind === "user") return t("ide.task.originUser");
  // 名字优先取会话表里**当前**的标题(用户可能刚改过名),建终端时捕获的那个兜底。
  const name = titleOrNull(origin.sessionId) ?? origin.title?.trim() ?? "";
  const node = origin.nodeSessionId ? ` · ${t("ide.task.originNode")}` : "";
  return (
    (name
      ? t("ide.task.originSession", { name })
      : t("ide.task.originSessionUnknown", { name: origin.sessionId.slice(0, 8) })) + node
  );
}
