/**
 * Message → render-row grouping for ChatPane's virtualized stream.
 *
 * Pure data transforms (no React state, no store access), split out of
 * ChatPane.tsx so the 5000-line component file stays manageable and so the
 * grouping can be exercised without dragging the whole chat UI along.
 * Behaviour is unchanged — this is a verbatim move.
 */
import type { Block, ChatMessage, TurnMeta } from "@renderer/stores/sessionStore.js";
import { isFoldableBlock, type ProceduralBlock, type ToolUseBlock } from "./MessageBlocks.js";
import { isAgentMailTool } from "@renderer/lib/agentMail.js";

/** Newest RUNNING tool among the given blocks — what the live summary row's
 *  operation ticker shows. Reverse scan so the newest wins; thinking blocks
 *  never qualify (no execution status). Shared by every surface that renders a
 *  live turn summary (spine rows, ops cards, pending rows). */
export function newestRunningTool(blocks: readonly Block[]): ToolUseBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "tool_use" && b.status === "running") return b;
  }
  return null;
}

/** Placeholder message for the pre-rendered live-segment row (see RenderItem's
 *  `liveSpine`). Shared as one constant so every accumulated segment row
 *  reuses the same object identity — it is never rendered. */
export const LIVE_SPINE_SENTINEL_MESSAGE: ChatMessage = {
  id: "__live_spine__",
  sessionId: "",
  role: "assistant",
  blocks: [],
  createdAt: 0,
};

/** Whether a block is "procedural" (model process: thinking / tool calls) —
 *  the surface that gets hidden inside a TurnPanel — vs "display" (text /
 *  plan / turn-files / error / attachment) which stays visible to the user.
 *  NOTE: this predicate describes PANEL MEMBERSHIP, not the process/reply
 *  boundary — the boundary anchors only on real tool calls (see
 *  groupMessagesForRender); a post-tool thinking block must not swallow the
 *  reply text that preceded it. */
function isProceduralBlock(b: Block): b is ProceduralBlock {
  return b.kind === "thinking" || b.kind === "tool_use";
}

/** Meta / bookkeeping tools update the model's own task list. They get invoked
 *  any time the model ticks a todo item — frequently as the LAST action of a
 *  turn, right as it finishes writing its answer — so they must not anchor the
 *  process/reply split (see groupMessagesForRender): treating TaskUpdate as the
 *  boundary would fold everything before it, often the bulk of the reply, into
 *  the hidden TurnPanel and leave only the text after it visible. They still
 *  belong to the process surface, so they're routed into the panel explicitly. */
const META_TOOL_NAMES = new Set(["TaskUpdate", "TaskCreate", "TodoWrite"]);

function isMetaToolBlock(b: Block): boolean {
  return b.kind === "tool_use" && META_TOOL_NAMES.has(b.toolName);
}

/** Render item after turn-level grouping. A `turnGroup` bundles a whole
 *  turn: its process blocks (hidden behind a TurnPanel header) plus any
 *  reply text that should stay visible below the panel. The precomputed
 *  isStreamingTail / isTurnTail flags carry per-message semantics into the
 *  grouped dimension:
 *  - isStreamingTail: this item is the live streaming end of the running turn.
 *  - isTurnTail: this item is the LAST assistant item of a COMPLETED turn
 *    (the turn ended, and the next item is a user message or the stream end).
 *    Drives the copy button - we only show copy on a finished turn's final
 *    assistant message, not on every intermediate assistant message. */
export type RenderItem =
  | {
      kind: "single";
      msg: ChatMessage;
      isStreamingTail: boolean;
      isTurnTail: boolean;
      /** Live-turn flat row that is NOT the turn's first visible row. Renders
       *  with the block-gap top margin instead of the full assistant row gap:
       *  a mid-turn seam (tool card → next narration) then measures the same
       *  as the intra-row text→card gap (card pb + row mt == block gap +
       *  card pt) instead of jumping up a tier every other row. The turn's
       *  opener keeps the full row gap so turn-to-turn separation is
       *  unchanged. */
      tightTop?: boolean;
      /** Precomputed unique list key for LIVE-turn rows. One message can
       *  legitimately split into several single rows (display → foldable →
       *  display interleaving), so the bare msg.id collides; the live branch
       *  disambiguates occurrences with an #n suffix. Absent everywhere else
       *  — keyExtractor falls back to msg.id. */
      liveKey?: string;
      /** True on rows emitted by the LIVE streaming partition (assistant
       *  narration / display rows of the running turn). Drives the 方案A
       *  entrance animation (.chat-enter): new rows float in as they arrive
       *  mid-stream, while historical rows mount statically. */
      live?: boolean;
      /** 方案A live segment: the whole bracketed run (its rows + the
       *  streaming caret) pre-rendered as ONE element. Set by the accumulation
       *  pass right before the list — rows carrying it skip MessageRow
       *  entirely. `msg` is then an unused placeholder (see
       *  LIVE_SPINE_SENTINEL_MESSAGE) kept only to satisfy the single-item
       *  shape. */
      liveSpine?: React.ReactNode;
    }
  | {
      // Live-turn cross-message fold run: contiguous FOLDABLE blocks
      // (batch tools / MCP / skills) merged ACROSS assistant
      // messages into ONE ops card while the turn streams. The agent loop
      // emits one assistant message per think→act cycle, so per-message
      // grouping spawns a tiny card per cycle; this kind renders the whole
      // run as a single BatchToolGroup. Exists only in the live layout —
      // the completed turn folds everything into a turnGroup/TurnPanel.
      kind: "opsGroup";
      blocks: ProceduralBlock[];
      /** Display blocks the anchoring message emitted BEFORE its first
       *  foldable block (e.g. a narration line whose tool_use landed a beat
       *  later). Rendered above the ops card, inside the same spine node. */
      leading?: Block[];
      /** Id of the first contributing message. Stable across re-runs while
       *  the run grows (runs only append), so LegendList recycling keeps the
       *  group's expand/collapse state alive during streaming. */
      anchorId: string;
      /** Unique list key — two runs can share one anchor message (tool →
       *  narration → tool inside one message), so the bare `ops:${anchorId}`
       *  collides; occurrences get an #n suffix. See the live partition in
       *  groupMessagesForRender. */
      liveKey?: string;
      /** True only on the stream's LAST live row (drives the tail loader
       *  spinner). Exactly one live row carries it — a fold run can absorb
       *  the tail message's blocks, so flagging by message id would leave
       *  the stream with no spinner (or two, when a message splits). */
      isStreamingTail: boolean;
      /** The turn's meta when this group is the turn's FIRST live row (the
       *  opener message contributed only foldable blocks, so no single row
       *  would render the "开始 · 用时" stat). */
      turnMeta?: TurnMeta;
      tightTop?: boolean;
    }
  | {
      kind: "turnGroup";
      /** The turn's process surface, in order: thinking, tool calls, AND any
       *  text the model emitted between tools (e.g. "let me read this first").
       *  Everything up to and including the LAST tool call goes here, plus
       *  thinking blocks wherever they land (they never anchor the split).
       *  Fed to TurnPanel (hidden behind the header). Empty for turns with
       *  neither tools nor thinking. */
      panelBlocks: Block[];
      /** Messages carrying the turn's DISPLAY blocks — only what comes AFTER
       *  the last tool call (the final reply text, plus plan / turn-files /
       *  error / attachment). Rendered below the panel, always visible.
       *  Empty for pure-tool turns (plan mode, interrupts). */
      textMsgs: ChatMessage[];
      turnMeta?: TurnMeta;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | {
      // Synthesized turn-separator pill shown between send and the first
      // assistant content block. Not a real message - it's derived in
      // groupMessagesForRender from runningTurnStartedAt so the user sees
      // immediate running feedback (the pill carries its own accent pulse
      // dot while live) before any token lands. Disappears the moment a
      // real assistant turnMeta appears.
      kind: "pendingTurn";
      turnMeta: TurnMeta;
    }
  | {
      // 方案A live segment bookends. The LIVE partition brackets the turn's
      // step rows with these two zero-height sentinels; the list renderer
      // accumulates every row between them into ONE `.chat-turn` wrapper so
      // the running turn carries the same two-state root as the completed
      // shape. 全程卡内（2026-09-11）：支架覆盖回合全部行（工具、思考、模型
      // 叙述与流式中的最终回复），不再有平铺在卡外的尾随行。Sentinels are
      // consumed by the accumulation pass and never reach a renderer.
      kind: "liveSpineStart";
      turnMeta?: TurnMeta;
    }
  | {
      kind: "liveSpineEnd";
    };

/** Whether the assistant message at index `i` is the tail of a COMPLETED turn:
 *  the turn is not still running (either because a later user message started
 *  a new turn, or because the stream ended and isRunning is false), AND the
 *  next message is not another assistant message of the same turn. In
 *  practice: it's an assistant message followed by a user message, or the
 *  last assistant message when no turn is running. */
function isCompletedTurnTail(
  messages: ChatMessage[],
  i: number,
  isRunning: boolean,
): boolean {
  const m = messages[i];
  if (!m || m.role !== "assistant") return false;
  // If this is the very last message, the turn is completed only when nothing
  // is running.
  if (i === messages.length - 1) return !isRunning;
  // Otherwise the turn is completed when the next message starts a new turn
  // (a user prompt) - the assistant run that ended here is finalized.
  const next = messages[i + 1];
  return next?.role === "user";
}

/** Pull every per-turn "footer card" block out of the given messages and
 *  return them separately. Two kinds qualify:
 *   - `turn-files` ("本轮修改了 N 个文件") — strictly a per-turn summary footer
 *     and must ALWAYS render as the turn's LAST visible item, after all the
 *     model's reply text;
 *   - `plan` (approved plan card) — belongs at the turn's end too, ABOVE the
 *     turn-files card ("本轮修改" sits below the plan), and still at the very
 *     bottom when the turn has no modified-files card.
 *
 *  The store attaches these blocks to whatever assistant message was current
 *  at the time their events landed (array-last at turn.files / the trailing
 *  open-turn message at plan.update), but a turn's reply can span multiple
 *  assistant messages and a carrying message may also hold earlier reply text
 *  or tool calls. A plan block in particular almost always sits BEFORE the
 *  last tool call in the timeline (plan mode = research → plan → execute), so
 *  without extraction it would fold into the process panel and vanish. This
 *  helper is the single source of truth for the extraction: the completed-turn
 *  branch and the orphan branch call it, so both cards stay pinned to the
 *  turn's end in the FROZEN (post-turn) view regardless of event ordering.
 *  The LIVE streaming branch deliberately does NOT call it — footer cards stay
 *  inline on their host message while the turn runs (see the isStreamingTail
 *  branch below for why). Returns the cleaned messages (dropping any left
 *  empty by the extraction) plus the extracted blocks in their original order,
 *  plans and files kept separate so callers can order plan → files. Pure — no
 *  mutation of the input array. */
function extractFooterBlocks(msgs: ChatMessage[]): {
  cleaned: ChatMessage[];
  plans: Block[];
  files: Block[];
} {
  const plans: Block[] = [];
  const files: Block[] = [];
  const cleaned = msgs
    .map((msg) => {
      const planBlocks = msg.blocks.filter((b) => b.kind === "plan");
      const fileBlocks = msg.blocks.filter((b) => b.kind === "turn-files");
      if (planBlocks.length === 0 && fileBlocks.length === 0) return msg;
      plans.push(...planBlocks);
      files.push(...fileBlocks);
      return {
        ...msg,
        blocks: msg.blocks.filter((b) => b.kind !== "plan" && b.kind !== "turn-files"),
      };
    })
    .filter((msg) => msg.blocks.length > 0); // drop messages left empty by the extraction
  return { cleaned, plans, files };
}

/** Group the raw message stream into render items at the TURN level. Every
 *  assistant message belonging to one turn (from the turn-opener carrying
 *  `turnMeta` up to the next turn-opener or a user message) is merged into a
 *  single `turnGroup`: all thinking/tool_use blocks fold into the TurnPanel
 *  (process, hidden by default), while text/plan/turn-files reply blocks stay
 *  visible below it.
 *
 *  Turn boundaries follow the same heuristic the store uses: a message that
 *  carries a fresh `turnMeta` (the opener) starts a new turn. Pure function
 *  over the message list — no store mutation. */
export function groupMessagesForRender(
  messages: ChatMessage[],
  isRunning: boolean,
  /** Send-time anchor (runningTurnStartedAt[sid]) used to synthesize a
   *  pendingTurn row before the first assistant block arrives. Undefined
   *  when no turn is in flight or the anchor wasn't stamped. */
  runningTurnStartedAt?: number,
  /** Send-time model anchor (runningTurnModelBySession[sid]) carried onto the
   *  synthesized pendingTurn row, so the model is visible from the first frame
   *  after send — before any assistant block has landed. */
  runningTurnModel?: string,
): RenderItem[] {
  const items: RenderItem[] = [];

  // Per-turn accumulator: the turn's blocks in arrival order, each tagged
  // with its source message. We keep the full timeline (procedural + text)
  // and only decide the process/reply split at flush time — once we know
  // where the LAST tool call landed. Everything up to and including that
  // last tool (and any text woven between tools) is process → panel;
  // anything after it is the final reply → visible below the panel.
  type TimedBlock = { block: Block; msg: ChatMessage };
  let turnBlocks: TimedBlock[] = [];
  let turnMeta: TurnMeta | undefined;
  /** Index (into `messages`) of the last raw message added to the open turn
   *  — used to derive isStreamingTail / isTurnTail. */
  let lastTurnMsgIndex = -1;
  let hasOpenTurn = false;

  const flush = () => {
    if (!hasOpenTurn) return;
    const lastMsg = messages[lastTurnMsgIndex];
    const isStreamingTail =
      isRunning && !!lastMsg && lastMsg.role === "assistant" && lastTurnMsgIndex === messages.length - 1;
    const isTurnTail =
      !!lastMsg && lastMsg.role === "assistant" && isCompletedTurnTail(messages, lastTurnMsgIndex, isRunning);

    // LIVE turn → flat output. While the turn is still streaming we do NOT
    // group its messages into a turnGroup — the user watches the RAW stream
    // in arrival order (narration text, tool cards, reply text all inline),
    // and the process/result split is applied only once the turn completes
    // (the regroup below folds the process into the panel and leaves the
    // post-last-tool reply visible). A narration text and its tool_use also
    // arrive as SEPARATE events (claude sends text and tool_use as
    // independent assistant messages; the tool attaches to the narration
    // message only when its tool.use lands), so grouping during streaming
    // would briefly classify the narration as the final reply (it sits after
    // the previous tool), then yank it back into the panel when its tool
    // arrives — a visible flicker. Emit every message of the live turn as
    // its own single item instead; each message's own MessageBlocks still
    // folds consecutive batch tools into one card.
    if (isStreamingTail) {
      // LIVE turn → block-level grouping. The turn's blocks are partitioned
      // in arrival order into two row kinds: contiguous FOLDABLE runs
      // (batch tools / MCP / skills — see isFoldableBlock) merge
      // ACROSS assistant messages into a single opsGroup card, while display
      // blocks (narration text, images, plan / turn-files / error,
      // AskUserQuestion …) emit as per-message single items. The agent loop
      // emits one assistant message per think→act cycle, so per-message
      // grouping spawns a tiny "N 个操作" card per cycle; merging at the
      // block level turns the whole burst into ONE card (broken only by the
      // model's narration, which must stay readable).
      //
      // Footer cards (plan / turn-files) are NOT extracted to the stream's
      // end here: re-pinning a live plan card to the bottom meant every
      // newly streamed message landed ABOVE it, pushing it further down
      // while maintainScrollAtEnd kept re-snapping scroll to the moving end
      // — the card visibly jumped on each delta ("闪烁"), especially during
      // post-approval execution and plan revision, where output keeps
      // flowing long after the card appeared. Keeping the card inline on
      // its host message gives it a stable position: new content appends
      // BELOW it and scrolls past naturally. When the turn completes, the
      // branch below re-runs the footer extraction and pins the frozen
      // cards to the turn's end in one coherent re-layout (the turn
      // collapses into a panel at that moment anyway).
      //
      // Classification is per-BLOCK, so a narration message never changes
      // identity when its tool_use lands (the tool joins the adjacent run;
      // the text row stays put) — the flicker the old all-flat layout
      // guarded against cannot reappear.
      type LiveRow =
        | {
            kind: "ops";
            blocks: ProceduralBlock[];
            anchorId: string;
            key: string;
            /** Display blocks this same message contributed BEFORE the run
             *  opened (e.g. a narration line whose tool_use landed later).
             *  They stay visible directly above the ops card instead of
             *  being dropped, which also makes the message land in the
             *  opsGroup branch — where the 方案A spine lives. */
            leading?: Block[];
          }
        | { kind: "msg"; msg: ChatMessage; blocks: Block[]; key: string };
      const rows: LiveRow[] = [];
      let openOps: { blocks: ProceduralBlock[]; anchorId: string; leading: Block[] } | null = null;
      let curMsg: ChatMessage | null = null;
      let curBlocks: Block[] = [];
      // Occurrence counters for unique row keys. One message CAN split into
      // several runs (display → foldable → display → foldable …), so keys are
      // disambiguated with an #n suffix; the first occurrence keeps the bare
      // id so the tail msg row's key still survives the live→completed
      // re-layout. LegendList recycles cells by key, and duplicate keys drove
      // one recycled cell with two different block kinds — the 2026-09-08
      // black screen.
      const opsSeq = new Map<string, number>();
      const msgSeq = new Map<string, number>();
      const flushOps = () => {
        if (openOps && (openOps.blocks.length > 0 || openOps.leading.length > 0)) {
          const n = opsSeq.get(openOps.anchorId) ?? 0;
          opsSeq.set(openOps.anchorId, n + 1);
          rows.push({
            kind: "ops",
            blocks: openOps.blocks,
            anchorId: openOps.anchorId,
            key: n === 0 ? `ops:${openOps.anchorId}` : `ops:${openOps.anchorId}#${n}`,
            ...(openOps.leading.length > 0 ? { leading: openOps.leading } : {}),
          });
        }
        openOps = null;
      };
      const flushMsg = (force = false) => {
        // `force` (end of turn): always emit the buffered display-only message
        // so a trailing segment isn't swallowed as an ops run's leading row.
        if ((force || curBlocks.length > 0) && curMsg && (curBlocks.length > 0 || force)) {
          const n = msgSeq.get(curMsg.id) ?? 0;
          msgSeq.set(curMsg.id, n + 1);
          rows.push({
            kind: "msg",
            msg: curMsg,
            blocks: curBlocks,
            key: n === 0 ? curMsg.id : `${curMsg.id}#${n}`,
          });
        }
        curMsg = null;
        curBlocks = [];
      };
      for (const { block, msg } of turnBlocks) {
        if (isFoldableBlock(block)) {
          // Foldable blocks merge ACROSS assistant messages: the agent loop
          // emits one message per think→act cycle, so per-message grouping
          // would spawn a tiny card per cycle. They also absorb any display
          // blocks already buffered for their own message as `leading`, so a
          // narration + tool pair stays one row (and one live-segment node).
          if (!openOps) {
            openOps = { blocks: [], anchorId: msg.id, leading: [] };
            if (curMsg === msg) {
              openOps.leading = curBlocks;
              curMsg = null;
              curBlocks = [];
            }
          } else if (curMsg) {
            // A display message was buffered when this run opened without
            // absorbing it (different message) — it is its own row.
            flushMsg();
          }
          openOps.blocks.push(block);
        } else {
          // Display block: flush the open run, then buffer under its message.
          flushOps();
          if (curMsg !== msg) {
            flushMsg();
            curMsg = msg;
          }
          curBlocks.push(block);
        }
      }
      flushOps();
      flushMsg(true);

      // A turn whose opener is foldable-only (e.g. it starts with a glob or
      // bash burst) has an opsGroup as its first live row, and no single row
      // would render the "开始 · 用时" stat — carry the meta on the group
      // explicitly. A thinking / Read opener is a msg row now (2026-09-11, see
      // isFoldableBlock), so either shape has to be handled.
      const liveTurnMeta = turnMeta;
      // 全程卡内（2026-09-11）：支架覆盖回合的全部行——工具、思考与模型的
      // 叙述/最终回复在流式期间一律留在台账体内。旧设计把"最后一个过程行
      // 之后"的文本预设为最终回复、平铺在卡外，等下一个工具落地时再收回卡
      // 内——每个叙述→工具周期都伴随一次行迁移（列表项消失 + DOM 子树重挂载
      // + Markdown 重解析）和一次可见的内容跳动。完成后仍由 turnGroup 分支
      // 做过程/回复切分（回复移到面板下方），那次位移与面板折叠动画重合，
      // 一次性且可预期。
      for (let k = 0; k < rows.length; k++) {
        const row = rows[k];
        // 卡内行间距只有一档（2026-09-11）：支架里的每一行——含首行——都是块
        // 间距。台头就在首行正上方，"首行保留回合级间距以免两个回合粘连"的老
        // 规则会在同一张卡里留下两种间隔（台头下 12px、其余行 8px）；回合之间
        // 的分离由 .chat-turn 外层的 assistant 行间距负责，卡内不需要第二套节奏。
        if (k === 0) {
          items.push({ kind: "liveSpineStart", turnMeta: liveTurnMeta });
        }
        if (row.kind === "ops") {
          items.push({
            kind: "opsGroup",
            blocks: row.blocks,
            leading: row.leading,
            anchorId: row.anchorId,
            liveKey: row.key,
            isStreamingTail: false,
            ...(k === 0 ? { turnMeta: liveTurnMeta } : {}),
            tightTop: true,
          });
        } else {
          items.push({
            kind: "single",
            msg: { ...row.msg, blocks: row.blocks },
            liveKey: row.key,
            live: true,
            isStreamingTail: false,
            isTurnTail: false,
            tightTop: true,
          });
        }
        if (k === rows.length - 1) {
          items.push({ kind: "liveSpineEnd" });
        }
      }
      // 流式尾光标由 spine 统一绘制（支架覆盖全部行，tailInsideSegment 恒
      // 为真）；这里不再给任何行打 isStreamingTail——行内 caret 与 spine 的
      // caret 会在正文末尾叠出两枚闪烁光标。
      turnBlocks = [];
      turnMeta = undefined;
      lastTurnMsgIndex = -1;
      hasOpenTurn = false;
      return;
    }

    // Find the index of the LAST real TOOL CALL (excluding meta tools) — the
    // process/reply boundary. Everything at or before it is "process" —
    // including any text the model wove between tool calls ("let me read
    // this first", "tests passed, now…"). Thinking blocks deliberately do
    // NOT anchor the boundary: with interleaved thinking the model can emit
    // text → think → more text as ONE final answer, and anchoring on the
    // thinking block would fold the earlier segment into the panel, leaving
    // only the last segment as the visible reply. Thinking (and meta tools)
    // are instead re-routed into the panel wherever they land, so EVERY
    // post-tool text segment stays in the reply.
    let lastToolIdx = -1;
    for (let j = 0; j < turnBlocks.length; j++) {
      const b = turnBlocks[j].block;
      // 信件工具同 meta 工具:不当分界锚点 —— 模型常常先写完答复、最后才给别的
      // 代理捎一句,拿它当锚会把整段答复折进面板。它自己下面会被捞出来单独显示。
      if (b.kind === "tool_use" && !isMetaToolBlock(b) && !isAgentMailTool(b.toolName)) {
        lastToolIdx = j;
      }
    }

    let panelBlocks: Block[] = [];
    const textMsgs: ChatMessage[] = [];

    // Completed turn (isStreamingTail false): every tool is attached by now,
    // so narration text sits before the last tool (inside the panel) and the
    // true final reply after it (outside). Pure-text turns have no procedural
    // block at all and render as plain messages.
    const replyByMsg = new Map<ChatMessage, Block[]>();
    for (let j = 0; j < turnBlocks.length; j++) {
      const { block, msg } = turnBlocks[j];
      // Process surface: blocks at-or-before the last real tool (procedural +
      // woven text), plus any thinking / meta-tool blocks wherever they
      // landed — those never anchor the boundary but must not leak into the
      // reply, so re-route them here: a mid-answer thinking pause or a
      // trailing task-list update stays in the panel while the text around
      // it remains visible.
      if (j <= lastToolIdx || isProceduralBlock(block)) {
        panelBlocks.push(block);
      } else {
        // Reply surface: blocks after the last real tool, regrouped by source
        // message so each textMsg renders with its original identity (id, role).
        const arr = replyByMsg.get(msg);
        if (arr) arr.push(block);
        else replyByMsg.set(msg, [block]);
      }
    }
    for (const [msg, blocks] of replyByMsg) {
      textMsgs.push({ ...msg, blocks });
    }

    // Pull approved plan cards out of the PROCESS surface. A plan block almost
    // always sits BEFORE the last tool call in the timeline (plan mode =
    // research tools → EnterPlanMode → ExitPlanMode → execution tools), so the
    // slice above folds it into panelBlocks — hidden behind the collapsed
    // panel. The approved plan card must stay visible: extract it here and
    // re-emit it below the reply, above the modified-files card.
    const panelPlans: Block[] = [];
    if (panelBlocks.some((b) => b.kind === "plan")) {
      panelPlans.push(...panelBlocks.filter((b) => b.kind === "plan"));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "plan");
    }

    // Pull the "本轮修改了 N 个文件" turn-files card out of the PROCESS
    // surface. turn.files is emitted at the very end of the turn (flushFinal)
    // and attached to the current turn's trailing assistant message. When that
    // message ALSO carries the turn's LAST tool_use (pure-tool turns, or a
    // turn whose only text precedes the last edit), the slice above folds the
    // turn-files block into panelBlocks — hiding it behind the collapsed
    // TurnPanel ("开始用时" surface). Rescue it here (mirroring the plan +
    // image rescues below) so the footer extraction picks it up and pins it
    // to the turn's end. Without this, the card would intermittently appear
    // inside the panel instead of at the turn's bottom.
    const panelTurnFiles: Block[] = [];
    if (panelBlocks.some((b) => b.kind === "turn-files")) {
      panelTurnFiles.push(...panelBlocks.filter((b) => b.kind === "turn-files"));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "turn-files");
    }

    // Pull ALL screenshot image blocks out of the PROCESS surface too. Images
    // are user-facing RESULTS, not process: they're attached right after their
    // tool_use (which sits inside the panel), so the slice above would fold
    // them behind the collapsed TurnPanel and the user would never see the
    // screenshots. Extract every image (from both panelBlocks and the reply
    // textMsgs, in case one landed after the last tool) into a single
    // gallery, re-emitted as one trailing message — the render layer's
    // groupBlocks merges consecutive image blocks into a swipeable gallery.
    const panelImages: Extract<Block, { kind: "image" }>[] = [];
    if (panelBlocks.some((b) => b.kind === "image")) {
      panelImages.push(...(panelBlocks.filter((b) => b.kind === "image") as Extract<Block, { kind: "image" }>[]));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "image");
    }
    // Images that landed after the last tool (rare, but possible when a
    // screenshot is the very last action) sit in textMsgs; sweep them out of
    // their host message and into the gallery.
    if (textMsgs.some((m) => m.blocks.some((b) => b.kind === "image"))) {
      const swept: ChatMessage[] = [];
      for (const m of textMsgs) {
        const imgs = m.blocks.filter((b) => b.kind === "image") as Extract<Block, { kind: "image" }>[];
        if (imgs.length > 0) {
          panelImages.push(...imgs);
          const rest = m.blocks.filter((b) => b.kind !== "image");
          if (rest.length > 0) swept.push({ ...m, blocks: rest });
        } else {
          swept.push(m);
        }
      }
      textMsgs.length = 0;
      textMsgs.push(...swept);
    }

    // 代理之间的信(agent_notify / agent_ask)从过程面板里捞出来:那段话是用户要
    // 看的内容,不是过程。作为一条尾随消息接在答复后面、页脚卡(计划/改动文件)
    // 前面;每条信渲染成一张信件卡(MessageBlocks → ToolCard → AgentMailOutCard)。
    if (panelBlocks.some((b) => b.kind === "tool_use" && isAgentMailTool(b.toolName))) {
      const mail = panelBlocks.filter((b) => b.kind === "tool_use" && isAgentMailTool(b.toolName));
      panelBlocks = panelBlocks.filter((b) => !(b.kind === "tool_use" && isAgentMailTool(b.toolName)));
      const tail = textMsgs.length > 0 ? textMsgs[textMsgs.length - 1] : null;
      textMsgs.push(
        tail
          ? { ...tail, id: `mail_tail_${tail.id}`, turnMeta: undefined, blocks: mail }
          : {
              id: `mail_tail_${turnMeta?.startedAt ?? Date.now()}`,
              sessionId: "",
              role: "assistant",
              blocks: mail,
              createdAt: Date.now(),
            },
      );
    }

    // Per-turn footer cards (plan + turn-files) must ALWAYS render at the very
    // end of the visible reply: the plan card above, the "本轮修改了 N 个文件"
    // card below it. The store attaches them to whatever assistant message was
    // current when their events landed (the array-last one at turn.files, the
    // trailing open-turn message at plan.update), but a turn's reply can span
    // multiple assistant messages, and the textMsgs order follows each
    // message's FIRST reply-block position in the timeline. So if a carrying
    // message also holds earlier reply text, its card would end up above
    // subsequent reply text ("card in the middle").
    //
    // Enforce the invariant at the render boundary: extractFooterBlocks pulls
    // every plan/turn-files block out of its host message; here we re-emit the
    // extracted cards as standalone trailing textMsgs in the order plan → files.
    // (Errors / compact-summary blocks are NOT moved - only plan and turn-files,
    // which are strictly per-turn footers.) The same helper runs in the LIVE
    // branch so the cards' positions are stable across the streaming→completed
    // transition. Runs whenever there is a footer candidate (including a plan
    // card rescued from panelBlocks on a pure-plan turn) so none is dropped.
    // panelTurnFiles (rescued above from the process surface) merges into the
    // files list so the modified-files card always pins to the turn's end too.
    if (textMsgs.length > 0 || panelPlans.length > 0 || panelTurnFiles.length > 0) {
      const { cleaned, plans, files } = extractFooterBlocks(textMsgs);
      const allPlans = [...panelPlans, ...plans];
      const allFiles = [...panelTurnFiles, ...files];
      if (allPlans.length > 0 || allFiles.length > 0) {
        textMsgs.length = 0;
        textMsgs.push(...cleaned);
        // Attach each extracted card to the LAST reply message's identity (so
        // copy/identity semantics stay sane), or synthesize a trailing message
        // if every reply was footer-only. STRIP turnMeta from the trailing
        // message: it's a synthetic split-off carrying only the card, and
        // keeping turnMeta would render a duplicate "开始 · 用时" stat row in
        // pure-text turns (where hideTurnStat is false because there's no panel).
        const tail = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
        if (allPlans.length > 0) {
          textMsgs.push(
            tail
              ? { ...tail, id: `plan_tail_${tail.id}`, turnMeta: undefined, blocks: allPlans }
              : {
                  id: `plan_tail_${turnMeta?.startedAt ?? Date.now()}`,
                  sessionId: "",
                  role: "assistant",
                  blocks: allPlans,
                  createdAt: Date.now(),
                },
          );
        }
        if (allFiles.length > 0) {
          textMsgs.push(
            tail
              ? { ...tail, id: `files_tail_${tail.id}`, turnMeta: undefined, blocks: allFiles }
              : {
                  id: `files_tail_${turnMeta?.startedAt ?? Date.now()}`,
                  sessionId: "",
                  role: "assistant",
                  blocks: allFiles,
                  createdAt: Date.now(),
                },
          );
        }
      }
    }

    // Re-emit the turn's screenshots as ONE trailing gallery message (the
    // render layer's groupBlocks merges the consecutive image blocks into a
    // swipeable ImageGallery). Appended AFTER the footer cards so the visible
    // order is: reply text → plan/files cards → screenshots. A screenshot-only
    // turn (no reply text) still gets its gallery via the synthesized carrier.
    if (panelImages.length > 0) {
      const tail = textMsgs.length > 0 ? textMsgs[textMsgs.length - 1] : null;
      textMsgs.push(
        tail
          ? { ...tail, id: `images_tail_${tail.id}`, turnMeta: undefined, blocks: panelImages }
          : {
              id: `images_tail_${turnMeta?.startedAt ?? Date.now()}`,
              sessionId: "",
              role: "assistant",
              blocks: panelImages,
              createdAt: Date.now(),
            },
      );
    }

    items.push({
      kind: "turnGroup",
      panelBlocks,
      textMsgs,
      turnMeta,
      isStreamingTail,
      isTurnTail,
    });
    turnBlocks = [];
    turnMeta = undefined;
    lastTurnMsgIndex = -1;
    hasOpenTurn = false;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "user") {
      // A user prompt ends any open turn and emits as its own single item.
      flush();
      items.push({ kind: "single", msg: m, isStreamingTail: false, isTurnTail: false });
      continue;
    }

    // Assistant message. A turn-opener is the FIRST assistant message of a
    // turn — the only one that carries a turnMeta (the store stamps it at
    // turn creation, both for live turns and completed ones). Its presence
    // alone marks a new turn boundary; we don't check endedAt because a
    // completed (historical) turn's opener also has endedAt set, and it must
    // still group its turn's messages into one panel. Flush any open turn
    // first.
    const isOpener = !!m.turnMeta;
    if (isOpener) {
      flush();
      hasOpenTurn = true;
      turnMeta = m.turnMeta;
    }

    if (hasOpenTurn) {
      lastTurnMsgIndex = i;
      // Collect the full block timeline (procedural + display), preserving
      // order and source message. The process/reply split happens at flush.
      for (const b of m.blocks) {
        turnBlocks.push({ block: b, msg: m });
      }
    } else {
      // Assistant message with no open turn (e.g. legacy / orphaned data
      // without turnMeta). Render as a standalone single item so it isn't
      // lost — its own MessageBlocks will still fold any procedural run. Apply
      // the same footer-card extraction as the other branches for consistency:
      // a plan / turn-files card sitting on such a message would otherwise
      // render inline. The cards are re-emitted as trailing singles right after
      // this message, plan before turn-files.
      const isStreamingTail = isRunning && i === messages.length - 1;
      const isTurnTail = isCompletedTurnTail(messages, i, isRunning);
      const { cleaned, plans, files } = extractFooterBlocks([m]);
      for (const msg of cleaned) {
        items.push({ kind: "single", msg, isStreamingTail, isTurnTail });
      }
      const emitFooter = (prefix: string, blocks: Block[]) => {
        for (let k = 0; k < blocks.length; k++) {
          items.push({
            kind: "single",
            msg: {
              id: `${prefix}_${m.id}_${k}`,
              sessionId: m.sessionId,
              role: "assistant",
              blocks: [blocks[k]!],
              createdAt: m.createdAt,
            },
            isStreamingTail: false,
            isTurnTail: false,
          });
        }
      };
      emitFooter("plan_tail", plans);
      emitFooter("files_tail", files);
    }
  }
  flush();

  // Synthesize a pendingTurn row when a turn is in flight but no real
  // assistant content has arrived yet (no open turnMeta exists). This gives
  // the user immediate "开始 · 用时" + spinner feedback right after send,
  // instead of a blank gap until the first token lands. The moment a real
  // assistant message is created (with its own turnMeta), the open-turn
  // check above consumes it into a turnGroup and this row stops rendering.
  if (isRunning && runningTurnStartedAt != null) {
    const openTurnExists = messages.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    if (!openTurnExists) {
      items.push({
        kind: "pendingTurn",
        // The model anchor is stamped at send time, so the very first frame
        // after sending already shows which model is about to answer.
        turnMeta: { startedAt: runningTurnStartedAt, model: runningTurnModel },
      });
    }
  }

  return items;
}
