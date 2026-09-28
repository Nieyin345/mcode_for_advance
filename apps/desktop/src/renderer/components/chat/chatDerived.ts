/**
 * Whole-history derivations for ChatPane, made cheap and referentially stable
 * during streaming.
 *
 * ChatPane derives a few values from the ENTIRE message list (`beforeMap` for
 * the Write-card diffs, `planBlocks` for the activity rail, `historyTexts`
 * for composer Up/Down recall). `messages` gets a new array on every delta
 * flush while a turn streams, so recomputing them naïvely meant:
 *
 *  1. walking every block of every message on each flush, and — worse —
 *  2. producing a NEW Map / array each time. `beforeMap` is a dependency of
 *     the list's row renderer and a prop of every memoized `MessageRow`, so a
 *     fresh Map per flush re-rendered every visible row for every token batch.
 *
 * The store updates messages immutably (a changed message is a new object;
 * untouched messages keep their identity — MessageRow's memo already relies
 * on this), so each per-message contribution is cached in a WeakMap keyed by
 * the message object, and the aggregate is only rebuilt — and only gets a new
 * identity — when its inputs actually changed. `useShallowStable` provides the
 * "same contents → same reference" step.
 */
import { useState } from "react";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";
import type { BeforeContentMap } from "./MessageBlocks.js";

type TurnFilesBlock = Extract<Block, { kind: "turn-files" }>;
type PlanBlock = Extract<Block, { kind: "plan" }>;

const NONE: readonly never[] = Object.freeze([]);

const turnFilesByMsg = new WeakMap<ChatMessage, readonly TurnFilesBlock[]>();
const plansByMsg = new WeakMap<ChatMessage, readonly PlanBlock[]>();
/** First non-blank typed text of a user message; `null` = none. */
const historyTextByMsg = new WeakMap<ChatMessage, string | null>();

function msgTurnFiles(msg: ChatMessage): readonly TurnFilesBlock[] {
  let v = turnFilesByMsg.get(msg);
  if (v === undefined) {
    const found = msg.blocks.filter((b): b is TurnFilesBlock => b.kind === "turn-files");
    v = found.length > 0 ? found : NONE;
    turnFilesByMsg.set(msg, v);
  }
  return v;
}

function msgPlans(msg: ChatMessage): readonly PlanBlock[] {
  let v = plansByMsg.get(msg);
  if (v === undefined) {
    const found = msg.blocks.filter((b): b is PlanBlock => b.kind === "plan");
    v = found.length > 0 ? found : NONE;
    plansByMsg.set(msg, v);
  }
  return v;
}

function msgHistoryText(msg: ChatMessage): string | null {
  let v = historyTextByMsg.get(msg);
  if (v === undefined) {
    v = null;
    if (msg.role === "user") {
      for (const b of msg.blocks) {
        if (b.kind === "text" && b.text.trim().length > 0) {
          v = b.text;
          break;
        }
      }
    }
    historyTextByMsg.set(msg, v);
  }
  return v;
}

/** Every `turn-files` block in history, oldest → newest (block references). */
export function collectTurnFileBlocks(messages: readonly ChatMessage[]): TurnFilesBlock[] {
  const out: TurnFilesBlock[] = [];
  for (const m of messages) {
    const t = msgTurnFiles(m);
    if (t.length > 0) out.push(...t);
  }
  return out;
}

/** Pre-turn content per file path; later turns overwrite earlier ones. */
export function buildBeforeMap(turnFileBlocks: readonly TurnFilesBlock[]): BeforeContentMap {
  const m: BeforeContentMap = new Map();
  for (const b of turnFileBlocks) {
    for (const f of b.files) m.set(f.filePath, f.before);
  }
  return m;
}

/** All plan blocks across the history, in order. */
export function collectPlanBlocks(messages: readonly ChatMessage[]): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const m of messages) {
    const p = msgPlans(m);
    if (p.length > 0) out.push(...p);
  }
  return out;
}

/** Typed text of each user message (attachment-only messages skipped). */
export function collectHistoryTexts(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const t = msgHistoryText(m);
    if (t !== null) out.push(t);
  }
  return out;
}

function shallowEqualArrays<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Returns the previously returned array while `next` has the same elements
 * (by identity), so consumers keyed on it don't see a change. Uses React's
 * "adjust state while rendering" pattern (no refs read during render), so it
 * stays React Compiler–friendly.
 */
export function useShallowStable<A extends readonly unknown[]>(next: A): A {
  const [prev, setPrev] = useState(next);
  if (prev !== next && !shallowEqualArrays(prev, next)) {
    setPrev(next);
    return next;
  }
  return prev;
}
