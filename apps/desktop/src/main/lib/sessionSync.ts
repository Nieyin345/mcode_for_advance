/**
 * sessionSync — broadcast session-list mutations to every connected client.
 *
 * `RuntimeManager.emit` fans out events from INSIDE a turn only. Session-row
 * mutations (create / title / delete / archive / pin / rename) happen in the
 * desktop IPC handlers and the mobile RPC handlers — outside any turn — so
 * without this helper one client's list would go stale the moment the other
 * client mutates a row (mobile-created sessions never appearing on the
 * desktop until restart, and vice versa).
 *
 * The two transport channels mirror `RuntimeManager.emit` exactly:
 *  - `sendToRenderer(IPC.CLAUDE_EVENT, …)` → desktop renderer's `ingestEvent`
 *    (same channel the per-turn stream already uses; no new IPC surface).
 *  - `mobileEventBus.broadcast(e)` → every paired phone over SSE.
 *
 * Only SLIM rows are broadcast (see `SessionListEntry` in contracts/runtime):
 * the heavy per-session payloads (`turnFiles.before` can hold whole file
 * contents) must not ride a list-sync event.
 */
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent, SessionListEntry } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { sendToRenderer } from "@main/window.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";

/** Strip the heavy per-session payloads, keeping only list-visible fields. */
export function toSessionListEntry(s: Session): SessionListEntry {
  const {
    contextSnapshot: _cs,
    todos: _td,
    subagents: _sa,
    planDraft: _pd,
    usageHistory: _uh,
    turnFiles: _tf,
    bookmarks: _bm,
    subagentTranscripts: _st,
    ...entry
  } = s;
  return entry;
}

/** Fan a generic out-of-turn RuntimeEvent out to every client — the desktop
 *  renderer over `claude:event` and every paired phone over the SSE bus.
 *  Out-of-turn here means events NOT flowing through a session runtime's own
 *  `emit` (session-list mutations, pending-request resolutions) — both
 *  transports receive the same envelope the in-turn stream uses. */
export function broadcastRuntimeEvent(e: RuntimeEvent): void {
  sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
  mobileEventBus.broadcast(e);
}

/** A session row was created or mutated — upsert it on every client. */
export function broadcastSessionChanged(session: Session): void {
  broadcastRuntimeEvent({ type: "session.changed", sessionId: session.id, session: toSessionListEntry(session) });
}

/** A session row was hard-deleted — drop it from every client's list. */
export function broadcastSessionDeleted(sessionId: string): void {
  broadcastRuntimeEvent({ type: "session.deleted", sessionId });
}

/** A synced setting was written — every OTHER client applies it live.
 *  Callers filter with `isSyncedSettingKey` first; the device-local /
 *  never-synced keys must not ride this event.
 *
 *  The writer never gets its own echo (a late echo drags a controlled text
 *  field back to the previous keystroke's value):
 *   - `originDeviceId` undefined = the desktop wrote it → phones only;
 *   - a paired device wrote it → desktop + the bus, and the SSE writer in
 *     `MobileHttpServer` skips the frame for that same device. */
export function broadcastSettingChanged(key: string, value: string, originDeviceId?: string): void {
  if (originDeviceId === undefined) {
    mobileEventBus.broadcast({ type: "setting.changed", sessionId: "", key, value });
    return;
  }
  broadcastRuntimeEvent({ type: "setting.changed", sessionId: "", key, value, originDeviceId });
}

/** 写入方**有意**要让**包括本桌面端在内**的所有端都套用这个设置。
 *
 *  ⚠️ **与 {@link broadcastSettingChanged} 的区别正是"发不发桌面本端"。** 那条刻意
 *  不给桌面回声,因为写入者(用户在输入框里敲)已经乐观更新过,晚到的回声会把一个受控
 *  文本字段拽回上一个按键的值。但**导入设置**不是这种情形:桌面端没有"乐观更新"这一说
 *  —— 那些键是刚从文件里读出来的,桌面内存里还是旧值,不推就一直是旧值(语言、强调色、
 *  快捷键要等重启才换)。所以导入这条路要发全景回声。
 *
 *  手机端两种广播都会收到(设置要跟人走)。 */
export function broadcastSettingChangedToAll(key: string, value: string): void {
  broadcastRuntimeEvent({ type: "setting.changed", sessionId: "", key, value });
}

/** The project list changed (create / delete / archive / rename / pin /
 *  group / reorder). Receivers re-fetch `project.list()` and diff. */
export function broadcastProjectsChanged(): void {
  broadcastRuntimeEvent({ type: "projects.changed", sessionId: "" });
}

/** A repo's git state changed (commit / stage / unstage / push / pull /
 *  discard — issued by the desktop panel OR a paired phone). Every client
 *  bumps its per-repo git-change version so its git surfaces (status panel,
 *  commit history) re-fetch instead of going stale until a manual refresh.
 *  The mutating client also receives the echo — harmless, its own refresh is
 *  idempotent. */
export function broadcastGitChanged(repoPath: string): void {
  broadcastRuntimeEvent({ type: "git.changed", sessionId: "", repoPath });
}
