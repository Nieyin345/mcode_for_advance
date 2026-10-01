/**
 * **界面那半的 mcode-app** —— 主进程经 `executeJavaScript` 调进来,在这里用 store 的
 * 同一批动作执行(切对话、开文件、开面板、像用户一样发消息……)。
 *
 * 入参 / 返回都是 JSON 字符串(见 `main/appControl/uiBridge.ts`)。权限在主进程那头已经
 * 过完了 —— 这里只负责"照做",以及把做不到的原因说清楚。
 */
import {
  APP_CONTROL_RENDERER_GLOBAL,
  type AppUiCommand,
  type AppUiReply,
} from "@contracts/appControl";
import { ChatDensitySchema, DisplayModeSchema, LocaleSchema } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

type Store = ReturnType<typeof useSessionStore.getState>;

function sessionTitle(st: Store, id: string | null): string | null {
  if (!id) return null;
  for (const list of Object.values(st.sessionsByProject)) {
    const hit = list.find((s) => s.id === id);
    if (hit) return hit.title;
  }
  return st.streamSessions.find((s) => s.id === id)?.title ?? null;
}

function snapshot(st: Store): unknown {
  const project = st.projects.find((p) => p.id === st.activeProjectId) ?? null;
  return {
    activeProject: project ? { id: project.id, name: project.name, path: project.path } : null,
    activeSession: st.activeSessionId ? { id: st.activeSessionId, title: sessionTitle(st, st.activeSessionId) } : null,
    openTabs: st.openTabs.map((id) => ({ id, title: sessionTitle(st, id) })),
    runningSessions: Object.entries(st.runningBySession)
      .filter(([, on]) => on)
      .map(([id]) => ({ id, title: sessionTitle(st, id) })),
    projects: st.projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    panels: {
      left: st.leftOpen,
      right: st.rightOpen,
      rightTab: st.rightPanelTab,
      terminal: st.bottomTerminalOpen,
      browser: st.browserPanelOpen,
    },
    settings: { open: st.settingsOpen, section: st.settingsSection },
    composer: { permissionMode: st.permissionMode, workflowId: st.workflowId },
    prefs: { locale: st.locale, themeStyle: st.themeStyle, displayMode: st.displayMode },
  };
}

/** 等某个条件成立(store 的异步动作有时晚一拍才落地)。 */
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

/** 发一条消息:目标在跑就插话,否则正常发送。可临时切工作流,发完换回来。 */
async function sendTo(sessionId: string, prompt: string, workflowId?: string): Promise<AppUiReply> {
  const st = useSessionStore.getState();
  if (st.runningBySession[sessionId]) {
    const delivered = await st.injectPrompt(sessionId, prompt);
    return delivered ? { ok: true, data: { sessionId, mode: "injected" } } : { ok: false, error: "对方正在运行,且这条没能插进去" };
  }
  const prevWorkflow = st.workflowId;
  const switchWf = workflowId !== undefined && workflowId !== prevWorkflow;
  if (switchWf) st.setWorkflowId(workflowId);
  try {
    const ok = await useSessionStore.getState().sendPrompt(prompt, undefined, undefined, undefined, undefined, undefined, sessionId);
    return ok
      ? { ok: true, data: { sessionId, mode: "sent" } }
      : { ok: false, error: "没有发出去(对话正在运行、内容为空,或还没配置模型)" };
  } finally {
    if (switchWf) useSessionStore.getState().setWorkflowId(prevWorkflow);
  }
}

async function execute(cmd: AppUiCommand): Promise<AppUiReply> {
  const st = useSessionStore.getState();
  switch (cmd.op) {
    case "state":
      return { ok: true, data: snapshot(st) };
    case "open_session":
      await st.selectSession(cmd.sessionId);
      return useSessionStore.getState().activeSessionId === cmd.sessionId
        ? { ok: true }
        : { ok: false, error: "没有切过去(对话不存在或已删除)" };
    case "select_project":
      if (!st.projects.some((p) => p.id === cmd.projectId)) return { ok: false, error: "没有这个项目" };
      await st.selectProject(cmd.projectId);
      return { ok: true };
    case "new_session": {
      const prev = st.activeSessionId;
      const projectId = cmd.projectId ?? st.activeProjectId ?? undefined;
      if (!projectId) return { ok: false, error: "没有当前项目,请给 project_id" };
      if (!st.projects.some((p) => p.id === projectId)) return { ok: false, error: "没有这个项目" };
      await st.startSession(projectId, { providerId: cmd.providerId, model: cmd.model });
      const created = useSessionStore.getState().activeSessionId;
      if (!created || created === prev) return { ok: false, error: "新对话没有建起来" };
      let sent: AppUiReply | null = null;
      if (cmd.prompt?.trim()) sent = await sendTo(created, cmd.prompt, cmd.workflowId);
      if (cmd.background && prev && prev !== created) await useSessionStore.getState().selectSession(prev);
      if (sent && !sent.ok) return { ok: false, error: `对话已建好(${created}),但第一条消息${sent.error}` };
      return { ok: true, data: { sessionId: created, sent: Boolean(sent) } };
    }
    case "send": {
      const prev = st.activeSessionId;
      if (prev !== cmd.sessionId) {
        // 先切过去:sendPrompt 依赖这个对话已经在 store 里(历史、项目、引擎)。
        await st.selectSession(cmd.sessionId);
        const ok = await waitFor(() => useSessionStore.getState().activeSessionId === cmd.sessionId);
        if (!ok) return { ok: false, error: "找不到这个对话" };
        await waitFor(() => useSessionStore.getState().historyLoadedBySession[cmd.sessionId] === true);
      }
      const r = await sendTo(cmd.sessionId, cmd.prompt, cmd.workflowId);
      if (cmd.background && prev && prev !== cmd.sessionId) await useSessionStore.getState().selectSession(prev);
      return r;
    }
    case "interrupt":
      if (!st.runningBySession[cmd.sessionId]) return { ok: true, data: "它本来就没在运行" };
      await st.interrupt(cmd.sessionId);
      return { ok: true };
    case "open_file": {
      if (!st.activeProjectId) return { ok: false, error: "没有当前项目" };
      st.openFileInIde(cmd.path, cmd.line ? { line: cmd.line } : undefined);
      st.setCenterTabFocus("editor");
      return { ok: true };
    }
    case "open_settings":
      st.setSettingsOpen(true, cmd.section);
      return { ok: true };
    case "close_settings":
      st.setSettingsOpen(false);
      return { ok: true };
    case "panel":
      if (cmd.panel === "left") st.setLeftOpen(cmd.open);
      else if (cmd.panel === "right") {
        st.setRightOpen(cmd.open);
        if (cmd.open && cmd.tab) st.setRightPanelTab(cmd.tab);
      } else if (cmd.panel === "terminal") st.setBottomTerminalOpen(cmd.open);
      else st.setBrowserPanelOpen(cmd.open);
      return { ok: true };
    case "open_url":
      st.openUrlInBrowser(cmd.url);
      return { ok: true };
    case "notify":
      useToastStore.getState().push({ kind: cmd.kind ?? "info", title: cmd.title, body: cmd.body });
      return { ok: true };
    case "set_pref":
      return setPref(st, cmd.key, cmd.value);
  }
}

async function setPref(st: Store, key: string, value: string | number): Promise<AppUiReply> {
  const s = String(value);
  switch (key) {
    case "locale": {
      const r = LocaleSchema.safeParse(s);
      if (!r.success) return { ok: false, error: "locale 只能是 zh / en" };
      await st.setLocale(r.data);
      return { ok: true };
    }
    case "themeStyle":
      if (s !== "classic" && s !== "sketch") return { ok: false, error: "themeStyle 只能是 classic / sketch" };
      st.setThemeStyle(s);
      return { ok: true };
    case "displayMode": {
      const r = DisplayModeSchema.safeParse(s);
      if (!r.success) return { ok: false, error: `displayMode 不合法:${s}` };
      await st.setDisplayMode(r.data);
      return { ok: true };
    }
    case "chatDensity": {
      const r = ChatDensitySchema.safeParse(s);
      if (!r.success) return { ok: false, error: `chatDensity 不合法:${s}` };
      await st.setChatDensity(r.data);
      return { ok: true };
    }
    case "chatFontSize": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 10 || n > 32) return { ok: false, error: "chatFontSize 应在 10–32 之间" };
      await st.setChatFontSize(n);
      return { ok: true };
    }
    case "workflowId":
      st.setWorkflowId(s);
      return { ok: true };
    case "permissionMode":
      st.setPermissionMode(s);
      return { ok: true };
    default:
      return { ok: false, error: `不支持的偏好:${key}` };
  }
}

let installed = false;

/** 挂到 `window` 上。只在桌面端(Electron)调用一次。 */
export function installAppControlHost(): void {
  if (installed) return;
  installed = true;
  (window as unknown as Record<string, unknown>)[APP_CONTROL_RENDERER_GLOBAL] = async (raw: string): Promise<string> => {
    let reply: AppUiReply;
    try {
      reply = await execute(JSON.parse(raw) as AppUiCommand);
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      return JSON.stringify(reply);
    } catch {
      return JSON.stringify({ ok: reply.ok, error: reply.error });
    }
  };
}
