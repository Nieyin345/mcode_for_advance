/**
 * NotificationManager - OS-level desktop notifications for background session
 * activity.
 *
 * Subscribes to the RuntimeManager's event observer and fires an OS
 * Notification when a noteworthy event arrives for a session while the main
 * window is NOT focused (the user has switched away / minimized). When the
 * window IS focused, no OS notification is shown - the in-app badge + toast
 * layer (renderer) handles surfacing instead.
 *
 * Notification categories (configurable via NotificationPrefs):
 *  - blocking:   approval.request / question.ask / plan.approval_request
 *                (the agent is stalled until the user responds)
 *  - turnComplete: turn.done (non-interrupted, non-tool_use)
 *  - errors:     error
 *  - backgroundTasks: subagent.update where a backgrounded task just finished
 *
 * Clicking a notification shows + focuses the window and pushes
 * `notification:focusSession` so the renderer navigates to that session.
 */
import { Notification } from "electron";
import { join } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import { IPC, DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_PREFS_SETTING_KEY, UI_LOCALE_SETTING_KEY, isInQuietHours, normalizeNotificationPrefs, type NotificationPrefs } from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { getMainWindow, sendToRenderer } from "@main/window.js";
import { SettingRepo } from "@main/store/repositories.js";
import { SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";

/** Path to the app icon for OS notifications. Same source image as the
 *  taskbar/window icon (build/icon.png); resolves relative to the compiled
 *  main output (out/main → ../../build/icon.png). On packaged builds the icon
 *  is embedded in the executable and the OS uses that, but passing it
 *  explicitly guarantees the notification card shows the logo in dev too. */
const NOTIFICATION_ICON = join(__dirname, "../../build/icon.png");

/** JSON-parse with a typed fallback. Returns defaults on any parse error. */
function parsePrefs(raw: string | null): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  try {
    const obj = JSON.parse(raw) as Partial<NotificationPrefs>;
    return normalizeNotificationPrefs(obj);
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

class NotificationManager {
  private prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  private started = false;
  /** Tracks the previous subagent roster per session so we can detect
   *  running -> completed/failed transitions (background task finished). */
  private prevSubagents = new Map<string, Map<string, "running" | "completed" | "failed" | "killed">>();

  /** Load prefs from the DB and attach the event observer. Called once at
   *  boot (after DB init). Safe to call multiple times - only starts once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reloadPrefs();
    runtimeManager.subscribe((e) => this.onEvent(e));
    log.info("NotificationManager started");
  }

  /** Reload prefs from the settings table. Called on boot and after the user
   *  changes notification settings in the panel. */
  reloadPrefs(): void {
    try {
      const raw = SettingRepo.get(NOTIFICATION_PREFS_SETTING_KEY);
      this.prefs = parsePrefs(raw);
    } catch (err) {
      log.error(`NotificationManager: failed to load prefs: ${(err as Error).message}`);
    }
  }

  getPrefs(): NotificationPrefs {
    return { ...this.prefs };
  }

  setPrefs(prefs: NotificationPrefs): void {
    this.prefs = { ...prefs };
  }

  /** The main event observer. Decides whether an OS notification is warranted. */
  private onEvent(e: RuntimeEvent): void {
    // Observe roster state before the focus gate, not only when notifying.
    const rosterResult = e.type === "subagent.update" ? this.evaluate(e) : null;
    // Only notify when the window is unfocused. When focused, the renderer's
    // in-app layer (badges + toasts) handles surfacing.
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    // 窗口在前台:默认交给渲染层的应用内提示;用户打开「前台时也发系统通知」才继续。
    if (win.isFocused() && !win.isMinimized() && !this.prefs.alsoWhenFocused) return;

    const result = e.type === "subagent.update" ? rosterResult : this.evaluate(e);
    if (!result) return;
    // 免打扰时段 / 静音项目:只在真要发通知时才查(这里每条流事件都会进来)。
    if (isInQuietHours(this.prefs)) return;
    if (this.isMutedProject(e.sessionId)) return;

    this.showNotification(result.title, result.body, e.sessionId);
  }

  /** Read the current UI language when a notification is actually produced,
   *  rather than caching it at startup (the user may switch language live). */
  private t(key: MessageId): string {
    let locale: "zh" | "en" = "zh";
    try { if (SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en") locale = "en"; }
    catch { /* DB may be unavailable during startup: use the default locale. */ }
    return translate(locale, key);
  }

  /** Map a RuntimeEvent to a notification {title, body} or null (no notify). */
  private evaluate(e: RuntimeEvent): { title: string; body: string } | null {
    // Blocking events - the agent is stalled waiting for the user.
    if (e.type === "approval.request") {
      if (!this.prefs.blocking) return null;
      return {
        title: this.t("store.toast.toolApprovalNeeded"),
        body: `${this.sessionTitle(e.sessionId)}: ${e.toolName}`,
      };
    }
    if (e.type === "question.ask") {
      if (!this.prefs.blocking) return null;
      const firstQ = e.questions[0];
      return {
        title: this.t("store.toast.agentQuestion"),
        body: `${this.sessionTitle(e.sessionId)}${firstQ ? `: ${firstQ.question}` : ""}`,
      };
    }
    if (e.type === "plan.approval_request") {
      if (!this.prefs.blocking) return null;
      return {
        title: this.t("store.toast.planApprovalPending"),
        body: `${this.sessionTitle(e.sessionId)}: ${this.t("store.toast.planApprovalPendingBody")}`,
      };
    }

    // Turn completion.
    if (e.type === "turn.done") {
      if (!this.prefs.turnComplete) return null;
      // Skip interrupted (user-initiated) and tool_use (intermediate) turns.
      if (e.reason === "interrupted" || e.reason === "tool_use") return null;
      // **`error` 不在这里弹出「已完成本轮任务」。** 工作流整张图定案为 failed 时,
      // 收口发的就是 `turn.done reason:"error"`(见 `orchestration/runner.ts` 里
      // `settled` 那一段)——那个 reason 从前一路掉到下面那句写死的文案上,用户离开
      // 电脑回来看见的是「Agent 已完成本轮任务」,而图其实炸了。失败被当成成功报出去,
      // 这不是措辞问题。
      //
      // **挡在这里、而不是给它换一句「本轮失败」**:同一件事上面已经有一条 `error`
      // 事件的通知了(标题「发生错误」、正文带 message,信息也更全)。两条事件都弹,
      // 用户一次失败会收到**两条**通知 —— 那是把一个错换成了另一个错。
      //
      // ⚠️ 这条挡的是**已经有一条 `error` 事件在它前面**的那条路。三家引擎与工作流
      // 收口都是成对发的(见 `PiAgentSdkProvider`、`CodexAgentSdkProvider`、
      // `runner.ts`),所以今天没有漏报。以后谁想出**只发 `turn.done reason:"error"`、
      // 不发 `error` 事件**的收场,失败就会变成一声不响 —— 那时候要做的不是把这里
      // 放开,而是在那条路上把 `error` 事件补齐。
      if (e.reason === "error") return null;
      // 工作流节点是隐藏会话:一次运行会给每个节点弹一条「回合完成」,而用户既看不见
      // 那些会话、也管不着它们。**只挡"完成"与"报错"这两类** —— 节点的审批与提问
      // 在主进程里已经被改写成父对话的事件了(`setInteractiveProxy`),标题也对,
      // 那两类必须照常弹。
      if (this.isNodeSession(e.sessionId)) return null;
      // 「对话节点」跑在主对话那个会话上(`runner.kind === "conversation"`),所以上面
      // 那条挡不住它。它跑完的那一条 `turn.done` 是**图内部的一步**,不是用户这一轮
      // 的结束 —— 图可能还有五步没跑,而这一条会弹一句「回合完成」。调度器把整张图
      // 的收口扣住了(见 `RuntimeManager.holdTurnEnd`),这里照着那条判据挡一下。
      if (runtimeManager.isTurnEndHeld(e.sessionId)) return null;
      // A length-limited turn has ended, but its answer may be partial. Keep
      // the notification (under the turnComplete preference), without claiming
      // that the agent finished the task. No error event accompanies this case.
      if (e.reason === "max_tokens") {
        return {
          title: this.t("store.toast.outputTruncated"),
          body: `${this.sessionTitle(e.sessionId)}: ${this.t("store.toast.outputTruncatedBody")}`,
        };
      }
      return {
        title: this.t("store.toast.turnComplete"),
        body: `${this.sessionTitle(e.sessionId)}: ${this.t("store.toast.turnCompleteBody")}`,
      };
    }

    // Errors.
    if (e.type === "error") {
      if (!this.prefs.errors) return null;
      // 同 turn.done:节点的报错已经由调度器变成对话里的一张卡了(见上)。
      if (this.isNodeSession(e.sessionId)) return null;
      return {
        title: this.t("store.toast.errorOccurred"),
        body: `${this.sessionTitle(e.sessionId)}: ${e.message}`,
      };
    }

    // Backgrounded subagent completion.
    if (e.type === "subagent.update") {
      // Always track the roster so the transition map stays fresh (even when
      // backgroundTasks pref is off, so it's correct when toggled back on).
      const prev = this.prevSubagents.get(e.sessionId);
      const next = new Map<string, "running" | "completed" | "failed" | "killed">();
      let justFinished = false;
      // Full snapshots replace the roster. A short-circuiting some() would
      // leave later agents stale and replay or lose their completion.
      for (const a of e.agents) {
        next.set(a.taskId, a.status);
        if (prev?.get(a.taskId) === "running" && (a.status === "completed" || a.status === "failed")) {
          justFinished = true;
        }
      }
      if (next.size === 0) this.prevSubagents.delete(e.sessionId);
      else this.prevSubagents.set(e.sessionId, next);
      if (!this.prefs.backgroundTasks || !justFinished) return null;
      // 同 turn.done / error:工作流节点是隐藏会话,它的后台子代理跑完了也不该
      // 打扰用户(节点自己的结果会以卡片的形式回到对话里)。
      if (this.isNodeSession(e.sessionId)) return null;
      return {
        title: this.t("store.toast.backgroundTaskDone"),
        body: `${this.sessionTitle(e.sessionId)}: ${this.t("store.toast.backgroundTaskDoneBody")}`,
      };
    }

    return null;
  }

  /** Resolve a session title for the notification body. Falls back to a
   *  generic label if the session isn't in the DB (e.g. race with delete). */
  private sessionTitle(sessionId: string): string {
    try {
      const s = SessionRepo.get(sessionId);
      return s?.title || this.t("store.toast.sessionLabel");
    } catch {
      return this.t("store.toast.sessionLabel");
    }
  }

  /** 是不是工作流节点会话(`kind: "node"`,见 `main/orchestration/runner.ts`)。
   *  这类会话是隐藏的:它们的完成与报错不该打扰用户。 */
  private isMutedProject(sessionId: string): boolean {
    const muted = this.prefs.mutedProjectIds;
    if (muted.length === 0) return false;
    try {
      const pid = SessionRepo.get(sessionId)?.projectId;
      return pid !== undefined && muted.includes(pid);
    } catch {
      return false;
    }
  }

  private isNodeSession(sessionId: string): boolean {
    try {
      return SessionRepo.get(sessionId)?.kind === "node";
    } catch {
      return false;
    }
  }

  /** Show an OS notification. Clicking it focuses the window + navigates the
   *  renderer to the session. */
  private showNotification(title: string, body: string, sessionId: string): void {
    if (!this.prefs.osEnabled) return;
    if (!Notification.isSupported()) return;

    const notif = new Notification({ title, body, icon: NOTIFICATION_ICON, silent: !this.prefs.sound });
    notif.on("click", () => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      // Show + focus the window (show is essential - the window may be hidden
      // to tray / minimized). On macOS, focus() alone doesn't un-minimize.
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // Tell the renderer to navigate to this session.
      sendToRenderer(IPC.NOTIFICATION_FOCUS_SESSION, {
        channel: IPC.NOTIFICATION_FOCUS_SESSION,
        sessionId,
      });
    });
    notif.show();
  }
}

/** Singleton. Started in index.ts after DB init. */
export const notificationManager = new NotificationManager();
