/**
 * 自定义面板(R41)的**桥**:面板里 `window.mcode.xxx()` → postMessage → 这里 → 应用的 API。
 *
 * ## 边界
 *
 * - 面板跑在 `mcode-panel://` 的沙箱 iframe 里(不同源、没有 `window.api`),它能做的事
 *   **只有**下面 `handlePanelCall` 里列的这些 —— 这张表就是权限清单。
 * - 读(上下文、文件、资料库、自动化列表、问模型)不打扰用户;**有副作用的**(跑自动化、
 *   写文件、跑终端命令)默认每次弹确认,和「运行终端命令」动作同一个 `confirm` 开关。
 *   「放进输入框」不确认:它不替用户发送。
 * - 文件读写走 `file.*` —— 主进程那边本来就只认已知项目根下的路径,面板不会比文件树
 *   多出任何能力。
 * - 设置导入会把面板的 `confirm` / `network` 一律去掉(`forceShellConfirm`)。
 */
import {
  customUiLabel,
  resolveWorkspacePath,
  templateVarsOf,
  type CustomUiItem,
  type CustomUiTarget,
} from "@contracts/customUi";
import {
  isSafePanelUrl,
  PANEL_STORAGE_MAX,
  PANEL_THEME_VARS,
  type PanelMethod,
  type PanelTheme,
} from "@contracts/customUiPanel";
import { api } from "@renderer/lib/api.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore, type ToastKind } from "@renderer/stores/toastStore.js";
import { requestTerminalRun } from "@renderer/lib/terminalRunBus.js";
import { copyText, deliverToComposer } from "./runCustomItem.js";

export type PanelAction = Extract<CustomUiItem["action"], { type: "panel" }>;

/** 一个正在显示的面板:是哪一项、它的动作、它被打开时的目标(工具栏 / 右键的那个东西)。 */
export interface PanelHost {
  item: CustomUiItem;
  action: PanelAction;
  target: CustomUiTarget;
}

/** 面板调用失败:消息原样交回面板(`await mcode.xxx()` 抛出的 Error)。 */
export class PanelCallError extends Error {}

function tr(key: MessageId, params?: Record<string, string | number>): string {
  return translate(useSessionStore.getState().locale, key, params);
}

/** 主窗口当前的主题 → 面板(颜色是 `rgb(R G B)`,SDK 设成 `--mc-<键>`)。 */
export function readPanelTheme(): PanelTheme {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const colors: Record<string, string> = {};
  for (const k of PANEL_THEME_VARS) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v.length > 0) colors[k] = /^[\d.\s/%]+$/.test(v) ? `rgb(${v})` : v;
  }
  const fontSize = getComputedStyle(document.body ?? root).fontSize;
  return {
    mode: root.classList.contains("dark") ? "dark" : "light",
    colors,
    ...(fontSize ? { fontSize } : {}),
  };
}

/** 目标所在的项目(相对路径相对它解析)。工具栏 / 右栏页签没有明确项目时,用当前环境。 */
export function panelProjectPath(target: CustomUiTarget): string | undefined {
  const active = (): string | undefined => selectActiveEnvPath(useSessionStore.getState()) ?? undefined;
  switch (target.kind) {
    case "file":
      return target.projectPath ?? active();
    case "workspace":
    case "message":
    case "selection":
    case "session":
    case "project":
      return target.project?.path ?? active();
    case "item":
    case "collection":
    case "group":
      return active();
  }
}

/** `mcode.context()` / `context` 事件的内容。 */
export function panelContextOf(host: PanelHost): Record<string, unknown> {
  const locale = useSessionStore.getState().locale;
  return {
    itemId: host.item.id,
    title: customUiLabel(host.item.label, locale),
    locale,
    target: host.target.kind,
    vars: templateVarsOf(host.target),
    projectPath: panelProjectPath(host.target) ?? null,
    theme: readPanelTheme(),
  };
}

// ── 参数小工具:面板传来的是任意 JSON,一律当不可信输入。──

function obj(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
}

function str(p: Record<string, unknown>, key: string, max = 100_000): string {
  const v = p[key];
  if (typeof v !== "string") throw new PanelCallError(`${key}: string expected`);
  if (v.length > max) throw new PanelCallError(`${key}: too long (max ${max})`);
  return v;
}

function optStr(p: Record<string, unknown>, key: string, max = 1000): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new PanelCallError(`${key}: string expected`);
  return v.slice(0, max);
}

function optInt(p: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new PanelCallError(`${key}: number expected`);
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** 面板给的路径 → 绝对路径(相对的按目标项目解析)。 */
function absPath(host: PanelHost, path: string): string {
  const abs = resolveWorkspacePath(path, panelProjectPath(host.target));
  if (abs === null) throw new PanelCallError(tr("customUi.run.noProject"));
  return abs;
}

/**
 * 确认框 → Promise。用户取消 / 关掉 / 被下一个确认框顶掉都算 `false`;
 * `onConfirm` 和 `onCancel` 可能先后都被调(确认按钮会顺手关框),先到先得。
 */
export function confirmAsync(title: string, description: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    useCustomUiStore.getState().openConfirm({
      title,
      description,
      confirmText,
      onConfirm: () => settle(true),
      onCancel: () => settle(false),
    });
  });
}

/** 有副作用的调用先过这一关(动作上 `confirm: false` 的跳过)。 */
async function gate(host: PanelHost, description: string, confirmKey: MessageId): Promise<void> {
  if (host.action.confirm === false) return;
  const name = customUiLabel(host.item.label, useSessionStore.getState().locale);
  const ok = await confirmAsync(tr("customUi.panel.confirmTitle", { name }), description, tr(confirmKey));
  if (!ok) throw new PanelCallError(tr("customUi.panel.cancelled"));
}

const storageKey = (itemId: string) => `mcode.panel.v1.${itemId}`;

function readStore(itemId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(storageKey(itemId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeStore(itemId: string, data: Record<string, unknown>): void {
  const raw = JSON.stringify(data);
  if (raw.length > PANEL_STORAGE_MAX) throw new PanelCallError(tr("customUi.panel.storageFull"));
  try {
    if (Object.keys(data).length === 0) localStorage.removeItem(storageKey(itemId));
    else localStorage.setItem(storageKey(itemId), raw);
  } catch (err) {
    throw new PanelCallError(err instanceof Error ? err.message : String(err));
  }
}

const TOAST_KINDS: readonly ToastKind[] = ["info", "warning", "error"];

/**
 * 执行面板的一次调用。返回值原样(结构化克隆)回给面板;抛出的错误消息交给面板。
 *
 * `switch` 是穷举的:`PANEL_METHODS` 加了方法而这里没实现,类型检查就过不去。
 */
export async function handlePanelCall(host: PanelHost, method: PanelMethod, params: unknown): Promise<unknown> {
  const p = obj(params);
  switch (method) {
    case "context":
      return panelContextOf(host);

    case "prompt": {
      const text = str(p, "text").trim();
      if (text.length === 0) return { ok: false };
      if (!deliverToComposer(text)) throw new PanelCallError(tr("customUi.run.noSession"));
      useToastStore.getState().push({ kind: "info", title: tr("customUi.run.promptDelivered") });
      return { ok: true };
    }

    case "ask": {
      const prompt = str(p, "prompt", 200_000);
      if (prompt.trim().length === 0) throw new PanelCallError("prompt: empty");
      const system = optStr(p, "system", 20_000);
      const model = optStr(p, "model", 200);
      const res = await api.customUi.panelAsk({ prompt, ...(system ? { system } : {}), ...(model ? { model } : {}) });
      if (!res.ok) throw new PanelCallError(res.error ?? "ask failed");
      return { text: res.text ?? "" };
    }

    case "automations": {
      const [{ workflows }, facts] = await Promise.all([api.workflow.list(), api.automation.statusAll()]);
      return workflows
        .filter((w) => w.trigger !== undefined || facts.some((f) => f.workflowId === w.id))
        .map((w) => ({
          id: w.id,
          name: w.name,
          ...(w.description ? { description: w.description } : {}),
          triggers: facts
            .filter((f) => f.workflowId === w.id)
            .map((f) => ({ nodeId: f.nodeId, title: f.title, kind: f.kind, armed: f.armed })),
        }));
    }

    case "runAutomation": {
      const workflowId = str(p, "workflowId", 200);
      let triggerNodeId = optStr(p, "triggerNodeId", 200);
      const [{ workflows }, facts] = await Promise.all([api.workflow.list(), api.automation.statusAll()]);
      const wf = workflows.find((w) => w.id === workflowId);
      if (!wf) throw new PanelCallError(tr("customUi.panel.noWorkflow", { id: workflowId }));
      if (triggerNodeId === undefined) triggerNodeId = facts.find((f) => f.workflowId === workflowId)?.nodeId;
      if (triggerNodeId === undefined) throw new PanelCallError(tr("customUi.panel.noTrigger", { name: wf.name }));
      await gate(host, tr("customUi.panel.confirmRun", { name: wf.name }), "customUi.run.confirm");
      const res = await api.automation.run({ workflowId, triggerNodeId });
      if (!res.ok) throw new PanelCallError(res.error ?? "run failed");
      return { ok: true };
    }

    case "files.read": {
      const abs = absPath(host, str(p, "path", 4000));
      const { content } = await api.file.readFile({ filePath: abs });
      return { content, path: abs };
    }

    case "files.list": {
      const projectPath = panelProjectPath(host.target);
      if (!projectPath) throw new PanelCallError(tr("customUi.run.noProject"));
      const raw = (optStr(p, "path", 4000) ?? "").replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (/^(?:[a-zA-Z]:)?\//.test(raw)) throw new PanelCallError(tr("customUi.panel.relativeOnly"));
      const { entries } = await api.file.listDir({ projectPath, dirPath: raw });
      return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir, ...(e.size !== undefined ? { size: e.size } : {}) }));
    }

    case "files.write": {
      const abs = absPath(host, str(p, "path", 4000));
      const content = str(p, "content", 5_000_000);
      await gate(host, tr("customUi.panel.confirmWrite", { path: abs, chars: content.length }), "customUi.panel.write");
      const res = await api.file.writeFile({ filePath: abs, content });
      if (!res.ok) throw new PanelCallError(tr("customUi.panel.writeFailed"));
      return { ok: true, path: abs };
    }

    case "library.list": {
      const query = optStr(p, "query", 500);
      const collectionId = optStr(p, "collectionId", 200);
      const limit = optInt(p, "limit", 1, 200) ?? 50;
      const offset = optInt(p, "offset", 0, 1_000_000);
      const { items, total } = await api.library.list({
        ...(query ? { query } : {}),
        ...(collectionId ? { collectionId } : {}),
        limit,
        ...(offset ? { offset } : {}),
      });
      return {
        total,
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          ...(i.abstract ? { abstract: i.abstract } : {}),
          ...(i.url ? { url: i.url } : {}),
          hasMarkdown: Boolean(i.mdPath),
          addedAt: i.addedAt,
          updatedAt: i.updatedAt,
        })),
      };
    }

    case "library.search": {
      const query = str(p, "query", 500).trim();
      if (query.length === 0) return [];
      const limit = optInt(p, "limit", 1, 100) ?? 30;
      const { matches } = await api.library.fullTextSearch({ query, limit });
      return matches;
    }

    case "library.read": {
      const res = await api.library.readMarkdown({ id: str(p, "id", 200) });
      if (!res.ok) throw new PanelCallError(res.error ?? "read failed");
      return { markdown: res.markdown, fileName: res.fileName };
    }

    case "storage.get": {
      const key = str(p, "key", 200);
      return readStore(host.item.id)[key] ?? null;
    }

    case "storage.set": {
      const key = str(p, "key", 200);
      const data = readStore(host.item.id);
      // 过一遍 JSON:函数 / undefined / 循环引用在这里就挡掉,别存一份读不回来的东西。
      let value: unknown;
      try {
        value = JSON.parse(JSON.stringify(p.value ?? null)) as unknown;
      } catch {
        throw new PanelCallError("value: not JSON-serializable");
      }
      data[key] = value;
      writeStore(host.item.id, data);
      return { ok: true };
    }

    case "storage.remove": {
      const key = str(p, "key", 200);
      const data = readStore(host.item.id);
      if (key in data) {
        delete data[key];
        writeStore(host.item.id, data);
      }
      return { ok: true };
    }

    case "copy": {
      const res = await copyText(str(p, "text", 5_000_000));
      if (!res.ok) throw new PanelCallError(res.error);
      useToastStore.getState().push({ kind: "info", title: tr("customUi.run.copied") });
      return { ok: true };
    }

    case "openUrl": {
      const url = str(p, "url", 8000).trim();
      if (!isSafePanelUrl(url)) throw new PanelCallError(tr("customUi.run.badUrl"));
      window.open(url, "_blank", "noopener,noreferrer");
      return { ok: true };
    }

    case "openFile": {
      const abs = absPath(host, str(p, "path", 4000));
      useSessionStore.getState().openFileInIde(abs);
      return { ok: true };
    }

    case "shell": {
      const command = str(p, "command", 8000).trim();
      if (command.length === 0) throw new PanelCallError("command: empty");
      // 同「运行终端命令」动作:在底部终端里跑(用户看得见、能 Ctrl+C),不在后台静默执行。
      if (!selectActiveEnvPath(useSessionStore.getState())) throw new PanelCallError(tr("customUi.run.shellNoProject"));
      await gate(host, command, "customUi.run.shellConfirm");
      useSessionStore.getState().setBottomTerminalOpen(true);
      requestTerminalRun(command);
      return { ok: true };
    }

    case "toast": {
      const message = str(p, "message", 500);
      const kind = TOAST_KINDS.find((k) => k === p.kind) ?? "info";
      useToastStore.getState().push({
        kind,
        title: customUiLabel(host.item.label, useSessionStore.getState().locale),
        body: message,
      });
      return { ok: true };
    }
  }
}
