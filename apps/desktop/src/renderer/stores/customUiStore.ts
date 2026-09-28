/**
 * 自定义 UI 的渲染端状态:配置本体 + 运行时要弹的那两种浮层(视图 / 批量确认)
 * + 右栏当前是不是在显示一个**自定义页签** + 竖向工具栏收没收起。
 *
 * 配置存在设置表的一个键里(`CUSTOM_UI_SETTING_KEY`),读的时候过
 * `parseCustomUiConfig`(坏了当默认、坏条目逐条丢)。整个应用只读一次,之后以这里为准;
 * 设置页保存时先改这里再落盘 —— 菜单立刻跟上,不用等一次往返。
 *
 * ⚠️ 选择器要返回**稳定引用**(AGENTS.md):`config` 整份替换、不原地改,所以
 * `useCustomUiStore((s) => s.config)` 在没保存过的时候永远是同一个对象。
 */
import { create } from "zustand";
import {
  CUSTOM_UI_SETTING_KEY,
  DEFAULT_CUSTOM_UI_CONFIG,
  parseCustomUiConfig,
  type CustomUiConfig,
  type CustomUiInput,
  type CustomUiSlot,
} from "@contracts/customUi";
import { RightPanelTabSchema } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { buildDefaultLibraryItems, type SeedNote } from "@renderer/components/customUi/seedDefaults.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

export interface CustomUiView {
  title: string;
  body: string;
}

export interface CustomUiConfirm {
  title: string;
  description: string;
  confirmText: string;
  onConfirm: () => void;
}

/** automation 动作「运行前输入」的表单(见 `@contracts/customUi` 的 inputs)。 */
export interface CustomUiForm {
  title: string;
  inputs: readonly CustomUiInput[];
  onSubmit: (values: Readonly<Record<string, string | string[]>>) => void;
}

interface CustomUiState {
  config: CustomUiConfig;
  loaded: boolean;
  /** 读一次设置表。重复调用只有第一次真读。 */
  load: () => Promise<void>;
  /** 整份替换并落盘。落盘失败会推一条 toast,内存里的新配置保留(用户能再点一次保存)。 */
  save: (next: CustomUiConfig) => Promise<boolean>;

  /** 从菜单「自定义 UI…」进设置页时,设置页先选中的挂载位。 */
  focusSlot: CustomUiSlot | null;
  setFocusSlot: (slot: CustomUiSlot | null) => void;

  view: CustomUiView | null;
  openView: (view: CustomUiView) => void;
  closeView: () => void;

  confirm: CustomUiConfirm | null;
  openConfirm: (c: CustomUiConfirm) => void;
  closeConfirm: () => void;

  form: CustomUiForm | null;
  openForm: (f: CustomUiForm) => void;
  closeForm: () => void;

  /**
   * 右栏正在显示的**自定义页签**(自定义项 id);`null` = 显示内置页签(`rightPanelTab`)。
   * 只在本次运行里记:自定义页签可能读文件,开机就自动去读一个上次停在那儿的文件没必要。
   */
  activeTab: string | null;
  setActiveTab: (id: string | null) => void;

  /** 竖向工具栏收起了(只剩一条窄边)。每台机器各自记(设置表里的一个键)。 */
  toolbarCollapsed: boolean;
  setToolbarCollapsed: (collapsed: boolean) => void;
}

/** 工具栏收起状态存的键。 */
export const CUSTOM_UI_TOOLBAR_COLLAPSED_KEY = "customUi.toolbar.collapsed";

/** 首启预置:拿自动化清单 → 构建默认项 → 落盘,并把绑定结果 toast 出来。 */
async function seedDefaults(save: (next: CustomUiConfig) => Promise<boolean>): Promise<void> {
  const { locale } = useSessionStore.getState();
  try {
    const [wf, facts] = await Promise.all([api.workflow.list(), api.automation.statusAll()]);
    const { items, notes } = buildDefaultLibraryItems(
      (wf.workflows ?? []).map((w) => ({ id: w.id, name: w.name, hasTrigger: w.trigger !== undefined })),
      (facts ?? []).map((f) => ({ workflowId: f.workflowId, nodeId: f.nodeId, title: f.title, kind: f.kind })),
    );
    if (items.length === 0) return;
    const ok = await save({ version: 1, items, layout: {} });
    if (!ok) return;
    const line = (n: SeedNote): string =>
      n.kind === "transcribe"
        ? translate(locale, "customUi.seed.bindTranscribe", { name: n.workflowName })
        : n.kind === "import"
          ? translate(locale, "customUi.seed.bindImport", { name: n.workflowName })
          : n.kind === "missingTranscribe"
            ? translate(locale, "customUi.seed.missingTranscribe")
            : translate(locale, "customUi.seed.missingImport");
    useToastStore.getState().push({
      kind: "info",
      title: translate(locale, "customUi.seed.done"),
      body: notes.map(line).join("\n"),
    });
  } catch (err) {
    useToastStore.getState().push({
      kind: "error",
      title: translate(locale, "customUi.seed.failed"),
      body: err instanceof Error ? err.message : String(err),
    });
  }
}

let loading: Promise<void> | null = null;

export const useCustomUiStore = create<CustomUiState>((set, get) => ({
  config: DEFAULT_CUSTOM_UI_CONFIG,
  loaded: false,
  load: () => {
    if (get().loaded) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const [res, collapsed] = await Promise.all([
          api.setting.get({ key: CUSTOM_UI_SETTING_KEY }),
          api.setting.get({ key: CUSTOM_UI_TOOLBAR_COLLAPSED_KEY }).catch(() => ({ value: null })),
        ]);
        const parsed = parseCustomUiConfig(res.value);
        set({ config: parsed, loaded: true, toolbarCollapsed: collapsed.value === "1" });
        // 首启预置(2026-09-28):从没配置过(一个自定义项都没有)时,按现有自动化
        // 自动搭出文献菜单(seedDefaults 的绑定规则,冒烟钉住)。失败要说出来,
        // 不静默 —— "没预置"读起来会像"功能不存在"。
        if (parsed.items.length === 0) void seedDefaults(get().save);
      } catch {
        // 读不到(手机端 shim、库还没就绪)就当默认:菜单照常显示全部内置项
        set({ loaded: true });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  save: async (next) => {
    set({ config: next, loaded: true });
    try {
      await api.setting.set({ key: CUSTOM_UI_SETTING_KEY, value: JSON.stringify(next) });
      return true;
    } catch (err) {
      const { locale } = useSessionStore.getState();
      useToastStore.getState().push({
        kind: "error",
        title: translate(locale, "customUi.saveFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  focusSlot: null,
  setFocusSlot: (slot) => set({ focusSlot: slot }),

  view: null,
  openView: (view) => set({ view }),
  closeView: () => set({ view: null }),

  confirm: null,
  openConfirm: (c) => set({ confirm: c }),
  closeConfirm: () => set({ confirm: null }),

  form: null,
  openForm: (f) => set({ form: f }),
  closeForm: () => set({ form: null }),

  activeTab: null,
  setActiveTab: (id) => set({ activeTab: id }),

  toolbarCollapsed: false,
  setToolbarCollapsed: (collapsed) => {
    set({ toolbarCollapsed: collapsed });
    void api.setting.set({ key: CUSTOM_UI_TOOLBAR_COLLAPSED_KEY, value: collapsed ? "1" : "0" }).catch((err: unknown) => {
      console.error("setting.set(customUi.toolbar.collapsed) failed:", err);
    });
  },
}));

/** 菜单末尾「自定义 UI…」:记下挂载位,打开设置页的「自定义 UI」。 */
export function openCustomUiSettings(slot: CustomUiSlot): void {
  useCustomUiStore.getState().setFocusSlot(slot);
  useSessionStore.getState().setSettingsOpen(true, "custom-ui");
}

/**
 * 切到右栏的某个页签(条目键:`builtin:<RightPanelTab>` / `custom:<自定义项 id>`)。
 *
 * 右栏收着 → 展开并切过去;右栏开着且**正显示这一个** → 收起(`toggle` 时,工具栏按钮
 * 的手感:点一下开、再点一下关)。认不出的键什么也不做,返回 `false`。
 */
export function openRightPanelTab(key: string, opts: { toggle?: boolean } = {}): boolean {
  const session = useSessionStore.getState();
  const ui = useCustomUiStore.getState();
  const showing =
    session.rightOpen &&
    (key.startsWith("custom:")
      ? ui.activeTab === key.slice("custom:".length)
      : ui.activeTab === null && `builtin:${session.rightPanelTab}` === key);
  if (opts.toggle && showing) {
    session.setRightOpen(false);
    return true;
  }
  if (key.startsWith("custom:")) {
    const id = key.slice("custom:".length);
    if (!ui.config.items.some((i) => i.id === id && i.slot === "rightPanel.tab")) return false;
    ui.setActiveTab(id);
  } else if (key.startsWith("builtin:")) {
    const tab = RightPanelTabSchema.safeParse(key.slice("builtin:".length));
    if (!tab.success) return false;
    ui.setActiveTab(null);
    session.setRightPanelTab(tab.data);
  } else {
    return false;
  }
  if (!session.rightOpen) session.setRightOpen(true);
  return true;
}

// 别处代码「要求」一个内置页签(`setRightPanelTab`)→ 自定义页签让位。见 sessionStore 的
// `rightPanelTabSeq`。模块级订阅,整个应用一份,不退订。
useSessionStore.subscribe((s, prev) => {
  if (s.rightPanelTabSeq !== prev.rightPanelTabSeq && useCustomUiStore.getState().activeTab !== null) {
    useCustomUiStore.getState().setActiveTab(null);
  }
});
