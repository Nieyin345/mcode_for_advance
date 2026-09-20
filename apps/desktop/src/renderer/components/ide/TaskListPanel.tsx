import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive, type LiveNode } from "@renderer/lib/workflowLive.js";
import { MessageBlocks } from "@renderer/components/chat/MessageBlocks.js";
import { mapTranscriptBlock } from "@renderer/components/chat/transcriptBlocks.js";
import {
  IconArrowLeft,
  IconListTree,
  IconLoader2,
  IconRefresh,
  IconRobot,
  IconTerminal2,
} from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { SubagentSnapshot, TranscriptBlock } from "@contracts/runtime";
import type { TerminalInfo, TerminalOrigin } from "@contracts/ipc";

/** 刷新间隔。终端是**这个进程里的活物**,它什么时候被开出来不由这边决定
 *  (另一个项目、另一个会话那边也能开),所以只能轮询。2 秒足够"我这边刚点新建
 *  就出现在列表里",而 `terminal:list` 只读一张 Map,不碰磁盘。
 *
 *  子代理与工作流节点**不用轮询** —— 它们本来就在渲染端的 store 里,事件一到就重渲染。 */
const POLL_MS = 2_000;

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

  const refresh = useCallback(async () => {
    // ⚠️ **必须包 try/catch,而且必须兜住整个调用。** 手机端(`webApi.ts`)虽然也实现了
    // `terminal.list`,但网络断、没配对、电脑端刚重启都会让这个 promise 直接 reject;而
    // 这个函数跑在 `useEffect` 的定时器里,一个没被接住的拒绝在 React 19 下会把整棵渲染
    // 树卸掉(这个仓库实测过)。
    try {
      const res = await api.terminal.list({});
      setTerminals(res?.terminals ?? EMPTY_TERMINALS);
    } catch {
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

  /** 子代理:只看 `running` 的。 */
  const runningAgents = useMemo(() => {
    const out: Array<{ sessionId: string; agent: SubagentSnapshot }> = [];
    for (const [sessionId, list] of Object.entries(subagentsBySession)) {
      for (const agent of list ?? EMPTY_AGENTS) {
        // ⚠️ 判空要**在这里**,不能等渲染时再用可选链兜:`agents` 那个字段真的可能是
        //    undefined(见 store 里 `subagentsBySession` 的写入路径),而 `[]` 之外的
        //    任何假值放进去,下面 `agent.status` 就是一次当场崩。
        if (agent && agent.status === "running") out.push({ sessionId, agent });
      }
    }
    return out;
  }, [subagentsBySession]);

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
        <button
          type="button"
          title={t("ide.task.refresh")}
          onClick={() => void refresh()}
          className="ml-auto shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconRefresh size={12} />
        </button>
      </div>
      <p className="shrink-0 border-b border-edge px-2 py-1 text-[10px] leading-relaxed text-content-subtle">
        {t("ide.task.pageDesc")}
      </p>

      {count === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-content-subtle">
            <IconListTree size={20} />
          </div>
          <p className="text-xs font-medium text-content-muted">{t("ide.task.empty")}</p>
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
            />
          ))}
          <More total={terminals.length} />

          {/* ── 子代理:模型派出去的分身 ── */}
          <Group label={t("ide.task.groupAgents")} total={runningAgents.length} />
          {runningAgents.slice(0, GROUP_CAP).map(({ sessionId, agent }) => (
            <Row
              key={`${sessionId}:${agent.taskId}`}
              icon={<IconRobot size={12} />}
              lit
              title={agent.description || t("ide.task.agentUntitled")}
              sub={[titleOf(sessionId), agent.subagentType, agent.lastToolName]
                .filter(Boolean)
                .join(" · ")}
              actionTitle={t("ide.task.view")}
              onOpen={() => setDetail({ kind: "subagent", sessionId, agent })}
            />
          ))}
          <More total={runningAgents.length} />

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

function Group({ label, total }: { label: string; total: number }) {
  if (total === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5 px-2 py-0.5">
      <span className="text-[9px] uppercase tracking-wide text-content-subtle">{label}</span>
      <span className="text-[9px] tabular-nums text-content-subtle/70">{total}</span>
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

/* ────────────────────────── 一行 ────────────────────────── */

/**
 * 一行 = 一整块可点区域(不是只有右边那个小图标能点)。这一页是**拿来点的**,
 * 把命中区做成一整行,用户不用瞄准。
 */
function Row({
  icon,
  lit,
  title,
  sub,
  full,
  actionTitle,
  onOpen,
}: {
  icon: React.ReactNode;
  /** 还活着 —— 图标高亮。已退出的终端也照样列(它仍占着一个面板),只是暗一点。 */
  lit: boolean;
  title: string;
  sub: string;
  /** 悬停时给的完整文本(列表里那一行是截断的)。 */
  full?: string;
  actionTitle: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={actionTitle}
      onClick={onOpen}
      className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-surface-muted/50"
    >
      <span className={cn("mt-0.5 shrink-0", lit ? "text-accent" : "text-content-subtle")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-content" title={title}>
          {title}
        </span>
        <span className="block truncate font-mono text-[10px] text-content-subtle" title={full ?? sub}>
          {sub}
        </span>
      </span>
    </button>
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
}: {
  target: DetailTarget;
  titleOf: (sessionId: string) => string;
  onBack: () => void;
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
        className="mt-0.5 shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
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
      <pre
        ref={preRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-surface-muted/30 p-2 font-mono text-[11px] leading-tight text-content"
      >
        {/* 没有输出时说一句（用户 2026-09-21 点名要的：「如果没有内容输出就显示
            还没有输出」）。**不能留空白** —— 一片空的 `<pre>` 和"终端卡住了/没接上"
            在用户眼里长得一模一样，而他没有任何线索能分辨这两件事。 */}
        {text.length > 0 ? text : <span className="text-content-subtle">{t("ide.task.terminalNoOutput")}</span>}
      </pre>
    </div>
  );
}

/* ── 子代理 / 工作流节点:只读转录 ── */

function SubagentTranscript({ sessionId, agent }: { sessionId: string; agent: SubagentSnapshot }) {
  const { t } = useI18n();
  const source = useSessionStore(
    (s) => s.subagentTranscriptsBySession[sessionId]?.[agent.toolUseId ?? ""],
  );
  return <ReadonlyTranscript source={source} emptyHint={t("ide.task.transcriptWaiting")} />;
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
