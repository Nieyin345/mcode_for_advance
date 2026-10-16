/**
 * 会话消息列表的**块级改写**（从 `sessionStoreHelpers.ts` 拆出）。
 *
 * 这一整段干的是同一种活：拿 `ChatMessage[]`，插入 / 改写 / 裁剪某一类**块**
 * —— 计划块、回写文件块、回合卡、工作流节点卡、delta 分段 —— 再返回新数组。
 * 与 `sessionStoreHelpers` 剩下的部分（设置钳位、会话桶、`reduce*` 事件规约）
 * 只共享类型：`ChatMessage` / `Block` / `DeltaEntry`。
 *
 * 原来的三段分隔注释（plan / turn-files / delta）**原样留在下面**，读的人照旧能按主题跳。
 * **纯搬迁，函数体逐字节一致。**
 */
import type { PlanUpdateEvent } from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import type { Block, ChatMessage, DeltaEntry } from "./sessionStore.js";

/** 已经收场的那一步,过程**留一份在卡片上**(`NODE_ARCHIVE_KEEP`)。
 *
 *  两件事一起决定要有它:
 *
 *  1. `workflowNodeTranscripts` 只按会话 id 索引,而**过程是活的**——主进程那边超过
 *     `NODE_TRANSCRIPT_LIMIT` 会把最早的丢掉,渲染端这边也按 `NODE_TRANSCRIPT_KEEP` 裁。
 *     用户在几十步之后回头看第五步,`nodeSessionId` 还在卡片上,过程却查不到了 ——
 *     卡片上摆着一个点开空空的入口。
 *  2. 卡片**落盘**(见 `reduceWorkflowNodeResult` 上面那段),会话重开之后
 *     `workflowNodeTranscripts` 是空的,不落盘的话"每一步的过程"重开一次就全没了。
 *
 *  所以收场那一刻把过程**拷进卡片**(见 `reduceWorkflowNodeResult`)。代价是每步几十 KB
 *  的卡片数据,上限 `NODE_ARCHIVE_KEEP` 条,超了按块数从大到小丢 —— 那是"最占地方的那些"
 *  (一张几百条 transcript 的卡),用户往回翻多半是要看最近那几步。 */
const NODE_ARCHIVE_KEEP = 200;

/* ──────────────── Plan block helpers (inline plan in the message stream) ────────────────
 *
 * The plan is rendered as a `kind: "plan"` block attached to the CURRENT
 * turn's trailing assistant message, rather than a session-global footer card.
 * This keeps each turn's plan frozen in its place in history — different turns
 * produce different plans, none overwriting another.
 *
 * All four plan-aware code paths (plan.update, plan.approval_request,
 * turn.done, submitPlanApproval) funnel through `upsertLivePlanBlock` /
 * `freezeOrPrunePlanBlocks` so the message-array surgery stays in one place.
 */

/** Find the index of the trailing assistant message of the currently-open
 *  turn (the LAST assistant message whose turnMeta has no endedAt), or -1 if
 *  no open-turn assistant message exists. Used to locate where the live plan
 *  block should be attached / removed.
 *
 *  NOTE: only a turn's OPENER carries turnMeta, so this actually resolves to
 *  the opener — the right anchor for plan/turn-files cards (the render layer
 *  re-pins those footers to the turn's end regardless of host message). For
 *  append-order-sensitive content (tool_use fallback) use
 *  {@link findOpenTurnLastAssistant} instead, which returns the turn's
 *  chronologically-LAST assistant message. */
export function findOpenTurnTrailingAssistant(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      return i;
    }
  }
  return -1;
}

/** Find the chronologically-LAST assistant message of the currently-open
 *  turn, or -1 if the turn has no assistant messages yet. Only the opener
 *  carries turnMeta (later messages of the same turn don't), so this walks
 *  forward from the opener to the end of the list — appending here keeps the
 *  flattened message timeline in ARRIVAL order. The tool.use fallback MUST
 *  use this, not the opener: appending a tool to the opener while later
 *  narration messages exist places the tool BEFORE text that had already
 *  streamed, and the renderer's completed-turn split ("everything up to the
 *  last tool call is process") then misclassifies that narration as the
 *  final reply — the "process data leaks below the panel" bug. */
export function findOpenTurnLastAssistant(messages: ChatMessage[]): number {
  const openerIdx = findOpenTurnTrailingAssistant(messages);
  if (openerIdx === -1) return -1;
  for (let i = messages.length - 1; i > openerIdx; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return i;
  }
  return openerIdx;
}

/** The planId used for the single "live" plan block within the current turn.
 *  There is at most one live plan per turn at a time (the model calls
 *  EnterPlanMode once, drafts, then ExitPlanMode). Frozen historical blocks
 *  retain this same id — it only needs to be unique within a message, and a
 *  frozen turn's trailing assistant message carries at most one plan block. */
export const LIVE_PLAN_ID = "current";

/** Upsert (or remove) the live plan block on the current turn's trailing
 *  assistant message. Used while the turn is streaming:
 *  - phase "cleared" → remove any live plan block (plan mode exited / denied).
 *  - empty plan text → same as cleared: the EnterPlanMode placeholder has no
 *    content yet, and a blank plan card is noise — only once real plan text
 *    exists does the card appear (see the guard below).
 *  - otherwise → insert-or-replace the live plan block with the given text /
 *    phase / hasApproval.
 *
 *  If the current turn has no assistant message yet (plan.update often
 *  arrives before any text/tool block), a new trailing assistant message is
 *  created and stamped with the current turn's `turnMeta` — mirroring the
 *  tool.use branch's "new turn" detection so we don't double-open a turn.
 *
 *  Returns the new messages array; pure (no store mutation). */
export function upsertLivePlanBlock(
  messages: ChatMessage[],
  plan: string,
  phase: PlanUpdateEvent["phase"],
  hasApproval: boolean,
  /** Send-time anchor (runningTurnStartedAt) to stamp on a newly-opened
   *  turn's turnMeta, so the real row continues the synthesized pendingTurn
   *  row's timing seamlessly. Omitted on the cleared-phase path. */
  startedAtAnchor?: number,
  /** Send-time model anchor (runningTurnModelBySession) stamped alongside the
   *  timing, so a plan-first turn still records which model ran it. */
  modelAnchor?: string,
): ChatMessage[] {
  if (phase === "cleared") {
    // Remove any live plan block from the current turn's trailing assistant
    // message. Frozen blocks (on closed turns) are untouched.
    return removeLivePlanBlock(messages);
  }
  // No real plan content yet — EnterPlanMode emits a placeholder `plan: ""`
  // in phase "drafting", and an empty plan card (0 字 / "计划为空") is noise.
  // The plan panel only appears once the model has actually produced plan
  // text: the final payload arrives on ExitPlanMode ("ready") and the
  // approval_request re-syncs it. So treat an empty draft like "cleared":
  // drop any live block instead of rendering a blank card.
  if (plan.trim().length === 0) {
    return removeLivePlanBlock(messages);
  }
  const block: Block = {
    kind: "plan",
    planId: LIVE_PLAN_ID,
    plan,
    phase,
    hasApproval,
  };
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // No open-turn assistant message exists yet. Plan events commonly arrive
    // before any text/tool block, so we open the turn here - same heuristic
    // as the tool.use branch: a turn is "open" while any assistant message
    // has turnMeta.endedAt === undefined; if none, this starts a new turn.
    const isNewTurn = !next.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    const msg: ChatMessage = {
      id: `plan_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
      // Prefer the send-time anchor so timing is continuous with the
      // synthesized pendingTurn row; fall back to now if none was passed.
      ...(isNewTurn
        ? { turnMeta: { startedAt: startedAtAnchor ?? Date.now(), model: modelAnchor } }
        : {}),
    };
    next = [...next, msg];
    // A new plan-mode turn is opening → demote any prior latest turn-files
    // card to read-only (mirrors upsertLiveTurnFilesBlock's new-turn branch).
    if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "plan" && b.planId === LIVE_PLAN_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Insert the plan block BEFORE any existing turn-files block so the plan
    // card always renders above the "本轮修改文件" card in the stream,
    // regardless of event arrival order (turn.files can land first when a
    // plan.update arrives after turn.done in edge cases).
    const turnFilesIdx = target.blocks.findIndex((b) => b.kind === "turn-files");
    if (turnFilesIdx >= 0) {
      blocks = [
        ...target.blocks.slice(0, turnFilesIdx),
        block,
        ...target.blocks.slice(turnFilesIdx),
      ];
    } else {
      blocks = [...target.blocks, block];
    }
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  return next;
}

/** Remove the live plan block from the current turn's trailing assistant
 *  message. Drops the assistant message too if it would end up empty (no
 *  other blocks), so a plan-only message doesn't linger as a blank row. */
export function removeLivePlanBlock(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) return next;
  const target = next[targetIndex];
  const filtered = target.blocks.filter(
    (b) => !(b.kind === "plan" && b.planId === LIVE_PLAN_ID),
  );
  if (filtered.length === target.blocks.length) return next; // nothing to remove
  if (filtered.length === 0) {
    // Drop the now-empty assistant message entirely.
    next = next.filter((_, i) => i !== targetIndex);
  } else {
    next = next.map((m, i) => (i === targetIndex ? { ...m, blocks: filtered } : m));
  }
  return next;
}

/** Called from turn.done: freeze or prune plan blocks on the JUST-cLOSED turn.
 *  The closing turn's assistant messages were just stamped with endedAt, so we
 *  can't use the "open turn" heuristic — we key off messages whose turnMeta
 *  endedAt matches `endedAt`.
 *
 *  - A plan block with phase "ready" and non-empty text is KEPT (frozen as a
 *    historical card) — the user approved this plan; it stays in the stream.
 *  - Any other plan block (drafting / cleared / empty) is REMOVED — these are
 *    in-progress or rejected drafts that shouldn't leave a trace.
 *  - An assistant message left with zero blocks after pruning is dropped. */
export function freezeOrPrunePlanBlocks(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  let next = messages.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "plan")) return m;
    const kept = m.blocks.filter((b) => {
      if (b.kind !== "plan") return true;
      return b.phase === "ready" && b.plan.trim().length > 0;
    });
    return { ...m, blocks: kept };
  });
  // Drop any assistant messages that became empty (a plan-only message whose
  // plan was pruned). Keep user / non-empty messages untouched.
  next = next.filter(
    (m) => m.role !== "assistant" || m.blocks.length > 0,
  );
  return next;
}

/* ──────────────── Turn-files block helpers (inline "本轮修改" card) ────────────────
 *
 * Mirrors the plan-block pattern: the per-turn modified-files card renders as
 * a `kind: "turn-files"` block attached to its turn's trailing assistant
 * message, frozen in place when the turn ends. Each turn that touched files
 * keeps its own card in history — new turns add new cards, old cards are
 * never deleted (only demoted to read-only once a newer turn supersedes them
 * as "the latest rewindable turn").
 *
 * Only the LATEST turn's card is rewindable (`isLatestTurn === true`); the
 * rewind itself still goes through the in-memory FileSnapshot (cleared per
 * turn), so older turns are display-only snapshots. Historical cards persist
 * to the messages table via the normal blocks round-trip (toRecords /
 * fromRecords) — no DB schema change.
 */

/** The filesId used for the single "live" turn-files block within the current
 *  turn. Same rationale as LIVE_PLAN_ID: at most one live block per turn. */
export const LIVE_FILES_ID = "current";

/** Upsert the live turn-files block on the current turn's trailing assistant
 *  message. Called from the turn.files handler.
 *
 *  Attach target resolution (in priority order):
 *  1. The trailing assistant message of the currently-OPEN turn (turnMeta with
 *     no endedAt) - the normal end-of-turn case: flushFinal emits turn.files
 *     BEFORE its turn.done, so the turn is still open when the card lands.
 *  2. The most recent assistant message - the interrupted-turn case. After a
 *     user stop, interrupt() stamps endedAt on every open turn locally, and
 *     the aborted turn's flushFinal (running while the SDK generator unwinds)
 *     emits its turn.files only afterwards - the turn is closed by then and
 *     (1) finds nothing. The file list still belongs to that just-stopped
 *     turn, so we attach it to the most recent assistant message WITHOUT
 *     opening a new turn. Opening a new turn here would spawn a phantom
 *     "开始 · 用时 <1s" stat row that never finalizes.
 *  3. A brand-new assistant message (no turnMeta) - defensive fallback when no
 *     assistant message exists at all.
 *
 *  In every case the block becomes the latest rewindable card
 *  (isLatestTurn=true) and every other turn's card is demoted to read-only.
 *
 *  Returns the new messages array; pure (no store mutation). */
export function upsertLiveTurnFilesBlock(messages: ChatMessage[], files: TurnFileEntry[]): ChatMessage[] {
  // Defensive mirror of FileSnapshot.freeze's net-zero filter: entries with
  // no actual change are pure noise on the card, and filtering them at RENDER
  // time instead would break the path-set equality the `turn.rewound` matcher
  // relies on (card files vs echoed targetFiles). No-op for events emitted by
  // the fixed freeze(); keeps the card honest for any other source.
  const visible = files.filter((f) => f.adds > 0 || f.dels > 0);
  if (visible.length === 0) return messages;
  const block: Block = {
    kind: "turn-files",
    filesId: LIVE_FILES_ID,
    files: visible,
    isLatestTurn: true,
  };
  let next = messages;
  let targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // Normal end-of-turn arrival finds the turn still open (flushFinal emits
    // turn.files BEFORE its turn.done). Reaching here means the turn was
    // closed locally already - the interrupted-turn path, where interrupt()
    // stamped endedAt on every open turn while the aborted turn's
    // flushFinal() was still unwinding. The file list still belongs to THAT
    // turn, so fall back to the most recent assistant message and attach the
    // block there - WITHOUT opening a new turn (a phantom "开始 · 用时" stat
    // row would never finalize).
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i];
      if (m && m.role === "assistant") {
        targetIndex = i;
        break;
      }
    }
  }
  if (targetIndex === -1) {
    // Truly no assistant message at all (shouldn't happen for a turn that
    // touched files, but stay defensive): create one WITHOUT a turnMeta so we
    // don't spawn a phantom "开始 · 用时" stat row for an already-ended turn.
    const msg: ChatMessage = {
      id: `files_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
    };
    next = [...next, msg];
    next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "turn-files" && b.filesId === LIVE_FILES_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Always insert the turn-files block at the VERY END of the blocks array
    // so the "本轮修改了 N 个文件" card renders below all text/plan content.
    blocks = [...target.blocks, block];
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  // This turn's card is now the latest → demote every OTHER turn's card to
  // read-only. (Without this, a brief window between turn.files and turn.done
  // would show two cards with the rewind button: the previous turn's frozen
  // card and this turn's new one.) The current turn's block stays true because
  // demotePreviousLatestTurnFiles runs BEFORE we re-stamped it above — but to
  // be safe we re-stamp the target's own block as true after demoting.
  next = demotePreviousLatestTurnFiles(next);
  next = next.map((m, i) => {
    if (i !== targetIndex) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Append a turn-scoped CARD block (compact summary, workflow node result) to the
 *  current turn's trailing assistant message. If no open-turn assistant message
 *  exists yet (the event arrives before any model text), create one WITH a
 *  turnMeta so it opens a proper turn in the stream - mirroring how tool.use
 *  creates a turn opener. Without the turnMeta the card would either attach to
 *  the PREVIOUS turn's message (wrong position) or float as an orphan (no stat
 *  row). */
/**
 * 把某个岔路口那张卡**在原地**换成新的。找不到返回 `null`(由调用方去追加)。
 *
 * 原地而不是"替换最后一张":用户可能在它之后又收到了别的卡片(同一次运行里另一个
 * 分支节点也在问),而那张旧卡还在上面 —— 只动最后一张会把别的卡改掉。
 *
 * 认的是 **`runId + nodeId + attempt`**。只看 `nodeId` 的话,同一张图跑第二轮时会把
 * **上一轮那张旧卡**的内容改掉,而用户看到的是"一张早就点过的卡突然变了"。
 * `attempt` 那一位同理,只是它拦的是**同一次运行里的下一个来回**(回头,见
 * `Block` 里那个字段)。
 */
export function patchBranchChoiceBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
  attempt: number,
  next: Block,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) =>
        b.kind === "workflow-branch-choice" &&
        b.runId === runId &&
        b.nodeId === nodeId &&
        b.attempt === attempt,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    blocks[at] = next;
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

/**
 * **同一格回头绕第二圈:把上一轮那张卡换成这一轮的。**
 *
 * 环回的图(写稿 → 审稿 → 回去改)会让同一个节点反复收场,每张卡都带一大段产出 ——
 * 三圈下来对话里就是三张大差不多的卡,用户要往下滚很久才看得见流程走到哪。留下的是
 * **最后一版**(环回的意义就是"改完之后那一版")。
 *
 * ## 认卡按 `runId + nodeId`
 *
 * **轮次不进认卡的身份**,它是被换上去的内容之一。第一轮先插一张,第二轮换了它,
 * 第三轮再换 —— 三圈下来从头到尾只有一张,带的是最后一轮的轮次。
 *
 * 轮次**不能**当身份:拿它去匹配等于"找一张标着第 N 轮的卡",而每次来的都是 N+1,
 * 于是永远找不着自己上一轮那张,一圈插一张,叠卡这个毛病等于没修。
 *
 * ⚠️ 同一格在同一轮里收场两次(续跑、补花费)会命中同一张卡、原地覆盖一遍 —— 无害,
 * 内容本来就是要覆盖的那个。
 *
 * **找不到返回 `null`**,调用方据此走"插一张新的"。
 */
export function patchWorkflowNodeResultBlock(
  messages: ChatMessage[],
  next: Extract<Block, { kind: "workflow-node-result" }>,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) =>
        b.kind === "workflow-node-result" &&
        b.runId === next.runId &&
        b.nodeId === next.nodeId,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    blocks[at] = next;
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

/**
 * **给一张已经画出来的步骤卡补上花费,别的什么都不动。**
 *
 * 按 `runId + nodeId` 找 —— 和结果卡认卡用的是同一对(见 `workflow-node-result` 里那
 * 两个字段的注释)。**找不到返回 `null`**(调用方据此原样返回 state,不触发重渲染)。
 *
 * 返回**新的数组**(而不是就地改):store 的订阅者比的是引用,就地改的话卡片不会重画。
 */
export function removeWorkflowNodeProgressBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    const blocks = m.blocks.filter(
      (b) => !(b.kind === "workflow-node-progress" && b.runId === runId && b.nodeId === nodeId),
    );
    if (blocks.length !== m.blocks.length) {
      changed = true;
      return { ...m, blocks };
    }
    return m;
  });
  return changed ? out : messages;
}

export function patchWorkflowNodeProgressBlock(
  messages: ChatMessage[],
  next: Extract<Block, { kind: "workflow-node-progress" }>,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) => b.kind === "workflow-node-progress" && b.runId === next.runId && b.nodeId === next.nodeId,
    );
    if (at < 0) continue;
    const blocks = m.blocks.slice();
    blocks[at] = next;
    const out = messages.slice();
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

export function patchNodeUsageBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
  usage: { totalTokens: number; outputTokens: number; costUsd?: number },
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) => b.kind === "workflow-node-result" && b.runId === runId && b.nodeId === nodeId,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    const prev = blocks[at];
    if (!prev || prev.kind !== "workflow-node-result") continue;
    // **只改 `usage` 那一项。** 其他字段一个都不碰 —— 这条事件的全部意思就是"补一个数",
    // 顺手用事件里的别的东西覆盖卡片,等于给"补花费"开了一条能改卡片的暗路。
    blocks[at] = { ...prev, usage };
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

export function appendTurnCardBlock(
  messages: ChatMessage[],
  block: Block,
  startedAt: number,
  /** Send-time model anchor (see upsertLivePlanBlock.modelAnchor). */
  model?: string,
  /** Prefix for the synthesized opener's id - keeps the card kinds apart in
   *  devtools, and makes a reloaded stream readable. */
  idPrefix = "card",
): ChatMessage[] {
  // Look for an OPEN turn's trailing assistant message (turnMeta present,
  // endedAt undefined = turn.done hasn't landed). This is the correct target
  // - the card belongs to the CURRENT turn, not a previous one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      const next = messages.slice();
      next[i] = { ...m, blocks: [...m.blocks, block] };
      return next;
    }
  }
  // No open-turn assistant message yet - create a turn-opener assistant message
  // carrying the card, stamped with turnMeta so it renders as the start of the
  // current turn (with its own stat row, correct grouping, etc.).
  const opener: ChatMessage = {
    id: `${idPrefix}_${Date.now()}`,
    sessionId: "",
    role: "assistant",
    blocks: [block],
    createdAt: Date.now(),
    turnMeta: { startedAt, model },
  };
  return [...messages, opener];
}

/**
 * 给"已经收场的那一步"的过程快照封顶(见 `NODE_ARCHIVE_KEEP`)。
 *
 * 数的是**块数**不是字节数:块的大小差好几个量级(一条 `text` 几百字,一条 `tool_use`
 * 里的 `input` 可以是一整份文件),而这里要挡的是"一张图跑了一整天之后,消息表被这些
 * 快照撑大"。块数是个够用的代理量,而且**不用把数据序列化一遍去数** —— 这个函数在每次
 * 节点收场时都会跑。
 *
 * 超了就丢**块数最多的那些**,保留原本的顺序(`NODE_ARCHIVE_KEEP` 那条注释说了
 * 为什么是按大小而不是按新旧)。
 *
 * 没超的时候返回**原数组**(引用相等)—— 调用方靠它跳过重渲染。
 */
export function capNodeArchives(messages: ChatMessage[]): ChatMessage[] {
  let total = 0;
  const holders: Array<{ messageAt: number; blockAt: number; size: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    for (let j = 0; j < m.blocks.length; j++) {
      const b = m.blocks[j];
      if (b?.kind !== "workflow-node-result" || !b.nodeTranscript) continue;
      total += b.nodeTranscript.length;
      holders.push({ messageAt: i, blockAt: j, size: b.nodeTranscript.length });
    }
  }
  if (total <= NODE_ARCHIVE_KEEP) return messages;

  holders.sort((a, b) => b.size - a.size);
  const drop = new Set<string>();
  let left = total;
  for (const h of holders) {
    if (left <= NODE_ARCHIVE_KEEP) break;
    drop.add(`${h.messageAt}:${h.blockAt}`);
    left -= h.size;
  }
  if (drop.size === 0) return messages;

  return messages.map((m, i) => {
    if (!m.blocks.some((_b, j) => drop.has(`${i}:${j}`))) return m;
    return {
      ...m,
      blocks: m.blocks.map((b, j) =>
        drop.has(`${i}:${j}`) && b.kind === "workflow-node-result"
          ? { ...b, nodeTranscript: undefined }
          : b,
      ),
    };
  });
}

/** Demote EVERY turn-files block's `isLatestTurn` to false. Called when a new
 *  turn opens (the previous "latest" card is no longer the latest — only the
 *  most recent completed turn is rewindable). The new turn's own card, once it
 *  arrives via turn.files, sets isLatestTurn=true on insert. */
export function demotePreviousLatestTurnFiles(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.blocks.some((b) => b.kind === "turn-files" && b.isLatestTurn)) return m;
    changed = true;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" && b.isLatestTurn ? { ...b, isLatestTurn: false } : b,
      ),
    };
  });
  return changed ? next : messages;
}

/** Called from turn.done: finalize the just-closed turn's turn-files block.
 *  The block is already attached (turn.files arrived just before turn.done);
 *  here we only need to ensure it's marked isLatestTurn=true (it IS the latest
 *  completed turn now) and demote all earlier turns' cards to read-only.
 *
 *  Unlike plan blocks, turn-files blocks are NEVER pruned — every turn that
 *  touched files keeps its card in history. (Empty turns never produced a
 *  block in the first place, so there's nothing to clean up.) Keyed off
 *  endedAt so we only touch THIS turn's messages. */
export function freezeLatestTurnFilesBlock(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  // First demote all older turn-files cards to read-only.
  let next = demotePreviousLatestTurnFiles(messages);
  // Then mark this turn's turn-files block(s) as the latest (rewindable).
  // There is at most one live block per turn; a turn's assistant messages all
  // share the same endedAt stamp, so keying off endedAt catches them all.
  next = next.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Append one delta to an entry, preserving order: consecutive chunks of the
 *  same kind merge into the trailing segment; a kind switch opens a new one. */
export function appendDelta(entry: DeltaEntry, k: "text" | "thinking", text: string): void {
  if (!text) return;
  const last = entry.segs[entry.segs.length - 1];
  if (last && last.k === k) last.text += text;
  else entry.segs.push({ k, text });
}
