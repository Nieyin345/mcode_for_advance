/**
 * R39 新挂载位的宿主组件:消息「⋯」菜单、选中文字浮条按钮、输入框工具栏按钮、左栏对话 /
 * 项目右键菜单里的自定义项,以及代码编辑器右键菜单(Monaco action)的注册。
 *
 * 各宿主只需要放一个组件 / 调一个函数,目标(模板变量)在这里拼好。内置项仍由宿主自己画,
 * 这里只负责用户加的自定义项 —— 没有自定义项时什么都不渲染(右键菜单里只多一条「自定义…」)。
 */
import { useMemo } from "react";
import { Menu } from "@base-ui/react/menu";
import type { editor } from "monaco-editor";
import {
  arrangeSlotEntries,
  customKey,
  customUiLabel,
  localDateString,
  matchesWhen,
  type CustomUiItem,
  type CustomUiSlot,
  type CustomUiTarget,
} from "@contracts/customUi";
import type { Project, Session } from "@contracts/session";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconDots } from "@renderer/lib/icons.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";
import { CustomUiCustomizeItem, CustomUiMenuEntries } from "./CustomUiMenuItems.js";
import { CUSTOM_ICONS, DEFAULT_ACTION_ICON } from "./registry.js";
import { runCustomItem } from "./runCustomItem.js";
import { useWorkspaceTarget } from "./useWorkspaceTarget.js";

/** 某挂载位下、对这个目标可见的自定义项(按用户排好的顺序,去掉隐藏的)。 */
function visibleItems(
  slot: CustomUiSlot,
  target: CustomUiTarget,
  items: readonly CustomUiItem[],
  layout: Parameters<typeof arrangeSlotEntries>[1],
): CustomUiItem[] {
  const byKey = new Map<string, CustomUiItem>();
  for (const item of items) {
    if (item.slot === slot && matchesWhen(item.when, target)) byKey.set(customKey(item.id), item);
  }
  return arrangeSlotEntries([...byKey.keys()], layout).flatMap((k) => {
    const it = byKey.get(k);
    return it ? [it] : [];
  });
}

function useSlotItems(slot: CustomUiSlot, target: CustomUiTarget | null): CustomUiItem[] {
  const items = useCustomUiStore((s) => s.config.items);
  const layout = useCustomUiStore((s) => s.config.layout[slot]);
  return useMemo(() => (target ? visibleItems(slot, target, items, layout) : []), [slot, target, items, layout]);
}

function iconOf(item: CustomUiItem) {
  return item.icon ? CUSTOM_ICONS[item.icon] : DEFAULT_ACTION_ICON[item.action.type];
}

const MENU_SEPARATOR = <Menu.Separator className="my-1 h-px bg-edge" />;

/** 这个挂载位有没有自定义项 —— 便宜的选择器,宿主(尤其是每条消息)先过这一关,没有就不挂
 *  任何订阅。 */
function useHasSlotItems(slot: CustomUiSlot): boolean {
  return useCustomUiStore((s) => s.config.items.some((i) => i.slot === slot));
}

/** 点击那一刻的工作区(项目 / 对话 / 今天)。不订阅 store —— 消息列表里每一行都订阅的话,
 *  流式输出时每个 delta 都要把所有行的选择器跑一遍。 */
function workspaceNow(): { project?: { path: string; name: string }; session?: { id: string; title: string }; today: string } {
  const s = useSessionStore.getState();
  const path = selectActiveEnvPath(s);
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const sid = s.activeSessionId;
  const sess = sid
    ? (s.sessions.find((x) => x.id === sid) ??
      s.pinnedSessions.find((x) => x.id === sid) ??
      Object.values(s.sessionsByProject)
        .flatMap((l) => l ?? [])
        .find((x) => x.id === sid))
    : undefined;
  return {
    ...(path ? { project: { path, name: project?.name ?? "" } } : {}),
    ...(sid ? { session: { id: sid, title: sess?.title ?? "" } } : {}),
    today: localDateString(new Date()),
  };
}

/* ── 左栏:对话右键 / 项目右键 ── */

export function SessionMenuCustomEntries({
  session,
  itemClass,
  onClose,
}: {
  session: Session | undefined;
  itemClass: string;
  onClose?: () => void;
}) {
  const project = useSessionStore((s) => (session ? s.projects.find((p) => p.id === session.projectId) : undefined));
  const target = useMemo<CustomUiTarget | null>(
    () =>
      session
        ? {
            kind: "session",
            session: { id: session.id, title: session.title },
            ...(project ? { project: { path: session.worktreePath || project.path, name: project.name } } : {}),
            today: localDateString(new Date()),
          }
        : null,
    [session, project],
  );
  if (!session) return null;
  return (
    <>
      <CustomUiMenuEntries slot="session.context" target={target} itemClass={itemClass} onClose={onClose} before={MENU_SEPARATOR} />
      <CustomUiCustomizeItem slot="session.context" itemClass={itemClass} onClose={onClose} before={MENU_SEPARATOR} />
    </>
  );
}

export function ProjectMenuCustomEntries({
  project,
  itemClass,
  onClose,
}: {
  project: Project | undefined;
  itemClass: string;
  onClose?: () => void;
}) {
  const target = useMemo<CustomUiTarget | null>(
    () =>
      project
        ? {
            kind: "project",
            project: { id: project.id, path: project.path, name: project.name },
            today: localDateString(new Date()),
          }
        : null,
    [project],
  );
  if (!project) return null;
  return (
    <>
      <CustomUiMenuEntries slot="project.context" target={target} itemClass={itemClass} onClose={onClose} before={MENU_SEPARATOR} />
      <CustomUiCustomizeItem slot="project.context" itemClass={itemClass} onClose={onClose} before={MENU_SEPARATOR} />
    </>
  );
}

/* ── 聊天:一条消息的「⋯」菜单 ── */

const MENU_ITEM_CLASS = cn(
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
  "text-content-muted data-[highlighted]:bg-surface-muted",
);

export function MessageCustomMenu(props: { id: string; role: "user" | "assistant"; text: string }) {
  const has = useHasSlotItems("chat.message");
  return has ? <MessageCustomMenuInner {...props} /> : null;
}

function MessageCustomMenuInner({ id, role, text }: { id: string; role: "user" | "assistant"; text: string }) {
  const { t, locale } = useI18n();
  const items = useCustomUiStore((s) => s.config.items);
  const layout = useCustomUiStore((s) => s.config.layout["chat.message"]);
  // 消息挂载位没有「条件」(见 whenKeysForSlot),目标只在点击时拼。
  const visible = useMemo(
    () => visibleItems("chat.message", { kind: "message", message: { id, role, text }, today: "" }, items, layout),
    [items, layout, id, role, text],
  );
  if (visible.length === 0) return null;
  const run = (item: CustomUiItem) =>
    void runCustomItem(item, { ...workspaceNow(), kind: "message", message: { id, role, text } });
  return (
    <Menu.Root>
      <Menu.Trigger
        title={t("customUi.host.more")}
        aria-label={t("customUi.host.more")}
        className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
      >
        <IconDots size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align={role === "user" ? "end" : "start"} sideOffset={4}>
          <Menu.Popup className="z-50 min-w-[160px] rounded-md border border-edge bg-surface py-1 shadow-2xl">
            {visible.map((item) => {
              const Icon = iconOf(item);
              return (
                <Menu.Item key={item.id} onClick={() => run(item)} className={MENU_ITEM_CLASS}>
                  <Icon size={12} className="shrink-0" />
                  <span className="truncate">{customUiLabel(item.label, locale)}</span>
                </Menu.Item>
              );
            })}
            <CustomUiCustomizeItem slot="chat.message" itemClass={MENU_ITEM_CLASS} before={MENU_SEPARATOR} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── 聊天:选中文字浮条上的自定义按钮 ── */

export function SelectionCustomButtons(props: { text: string; onDone?: () => void }) {
  const has = useHasSlotItems("text.selection");
  return has ? <SelectionCustomButtonsInner {...props} /> : null;
}

function SelectionCustomButtonsInner({ text, onDone }: { text: string; onDone?: () => void }) {
  const { locale } = useI18n();
  const target = useMemo<CustomUiTarget>(() => ({ ...workspaceNow(), kind: "selection", text, source: "chat" }), [text]);
  const items = useSlotItems("text.selection", target);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => {
        const Icon = iconOf(item);
        const label = customUiLabel(item.label, locale);
        return (
          <span key={item.id} className="flex items-center">
            <span className="h-3 w-px bg-edge/60" />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void runCustomItem(item, target);
                onDone?.();
              }}
              title={label}
              aria-label={label}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent"
            >
              <Icon size={12} />
            </button>
          </span>
        );
      })}
    </>
  );
}

/* ── 输入框工具栏上的自定义按钮 ── */

export function ComposerCustomButtons() {
  const has = useHasSlotItems("composer.toolbar");
  return has ? <ComposerCustomButtonsInner /> : null;
}

function ComposerCustomButtonsInner() {
  const { locale } = useI18n();
  const target = useWorkspaceTarget();
  const items = useSlotItems("composer.toolbar", target);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => {
        const Icon = iconOf(item);
        const label = customUiLabel(item.label, locale);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => void runCustomItem(item, target)}
            title={label}
            aria-label={label}
            data-testid="composer-custom-button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <Icon size={14} />
          </button>
        );
      })}
    </>
  );
}

/* ── 代码编辑器(Monaco)右键菜单 ── */

/**
 * 把 `text.selection` 的自定义项注册成 Monaco 右键菜单项(有选区时才出现)。配置变了就
 * 重注册。返回清理函数(宿主在编辑器卸载时调)。
 */
export function registerEditorSelectionActions(
  ed: editor.IStandaloneCodeEditor,
  getContext: () => { path?: string; projectPath?: string },
): () => void {
  let disposables: Array<{ dispose: () => void }> = [];
  const register = () => {
    for (const d of disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* 已拆 */
      }
    }
    const st = useCustomUiStore.getState();
    const locale = useSessionStore.getState().locale;
    const slotItems = st.config.items.filter((i) => i.slot === "text.selection");
    if (slotItems.length === 0) return;
    const order = arrangeSlotEntries(
      slotItems.map((i) => customKey(i.id)),
      st.config.layout["text.selection"],
    );
    order.forEach((key, idx) => {
      const item = slotItems.find((i) => customKey(i.id) === key);
      if (!item) return;
      disposables.push(
        ed.addAction({
          id: `mcode.customUi.${item.id}`,
          label: customUiLabel(item.label, locale),
          contextMenuGroupId: "9_mcode_custom",
          contextMenuOrder: idx,
          precondition: "editorHasSelection",
          run: (e) => {
            const sel = e.getSelection();
            const model = e.getModel();
            const text = sel && model ? model.getValueInRange(sel) : "";
            if (!text) return;
            const ctx = getContext();
            const s = useSessionStore.getState();
            const project = ctx.projectPath ? s.projects.find((p) => p.path === ctx.projectPath) : undefined;
            const target: CustomUiTarget = {
              kind: "selection",
              text,
              source: "editor",
              ...(ctx.path ? { path: ctx.path } : {}),
              ...(ctx.projectPath ? { project: { path: ctx.projectPath, name: project?.name ?? "" } } : {}),
              today: localDateString(new Date()),
            };
            // 条件(扩展名)不满足就不跑 —— Monaco 的菜单项没法按文件动态隐藏,在这里兜住。
            if (!matchesWhen(item.when, target)) return;
            void runCustomItem(item, target);
          },
        }),
      );
    });
  };
  register();
  const unsub = useCustomUiStore.subscribe((s, prev) => {
    if (s.config !== prev.config) register();
  });
  return () => {
    unsub();
    for (const d of disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* 已拆 */
      }
    }
    disposables = [];
  };
}
