/**
 * 自定义 UI 的渲染端状态:配置本体 + 运行时要弹的那两种浮层(视图 / 批量确认)
 * + 右栏当前是不是在显示一个**自定义页签** + 竖向工具栏收没收起。
 *
 * 配置存在设置表的一个键里(`CUSTOM_UI_SETTING_KEY`),读的时候过
 * `parseCustomUiConfig`(坏了当默认、坏条目逐条丢)。首屏只加载一次;外部写入通知会重新读取;
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
  CustomUiConfigSchema,
  type CustomUiConfig,
  type CustomUiInput,
  type CustomUiItem,
  type CustomUiSlot,
  type CustomUiTarget,
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
  /** 用户关掉 / 取消时调(自定义面板等着一个结果,不能让它的 Promise 永远挂着)。
   *  ⚠️ 确认那条路上也可能紧跟着被调一次 —— 调用方自己做「先到先得」。 */
  onCancel?: () => void;
}

/** 浮窗里正在跑的自定义面板(R41)。`id` 每次打开都不一样,宿主拿它当 `key`。 */
export interface CustomUiPanelOpen {
  id: string;
  item: CustomUiItem;
  target: CustomUiTarget;
}

/** automation 动作「运行前输入」的表单(见 `@contracts/customUi` 的 inputs)。 */
export interface CustomUiForm {
  /** 每次打开都不一样 —— 宿主拿它当 `key`,换一个表单时上一份填的值不会留在框里。 */
  id: string;
  title: string;
  inputs: readonly CustomUiInput[];
  onSubmit: (values: Readonly<Record<string, string | string[]>>) => void;
}

interface CustomUiState {
  config: CustomUiConfig;
  loaded: boolean;
  /** 读一次设置表。重复调用只有第一次真读。 */
  load: () => Promise<void>;
  /** Re-read an externally updated configuration, retaining the old UI on error. */
  refresh: () => Promise<void>;
  /**
   * 整份替换并落盘。**落盘失败会退回落盘前那一份**并推一条 toast。
   *
   * 从前失败时把新配置留在内存里:菜单看起来是保存成功的样子,之后每一次局部改动又以
   * 这一份为基准写回去,而磁盘上一直是旧的 —— 用户要等到下次重启才发现全没了,那时也
   * 没人说得清是哪一次没存上。退回去难看,但它说的是真话。
   */
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
  openForm: (f: Omit<CustomUiForm, "id">) => void;
  closeForm: () => void;

  panel: CustomUiPanelOpen | null;
  openPanel: (p: Omit<CustomUiPanelOpen, "id">) => void;
  closePanel: () => void;

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

/**
 * **已经预置过**的标记键。
 *
 * 从前的判据是"一个自定义项都没有",于是一个**刻意把菜单清空**的用户每次开应用都会被
 * 重新塞回一整套默认项(还附带一条 toast)。判据改成这个标记:预置**一台机器只做一次**,
 * 成功与否都记(失败也记 —— 否则下次启动又来一遍,而失败的原因多半不会自己好)。
 */
export const CUSTOM_UI_SEEDED_KEY = "customUi.seeded.v1";

/** 首启预置:拿自动化清单 → 构建默认项 → 落盘,并把绑定结果 toast 出来。 */
async function seedDefaults(save: (next: CustomUiConfig) => Promise<boolean>, current: () => CustomUiConfig): Promise<void> {
  const { locale } = useSessionStore.getState();
  // **先立标记再干活**:这一趟无论成败都不该在下次启动时重来(见 CUSTOM_UI_SEEDED_KEY)。
  void api.setting.set({ key: CUSTOM_UI_SEEDED_KEY, value: "1" }).catch(() => {});
  try {
    const [wf, facts] = await Promise.all([api.workflow.list(), api.automation.statusAll()]);
    const { items, notes } = buildDefaultLibraryItems(
      (wf.workflows ?? []).map((w) => ({ id: w.id, name: w.name, hasTrigger: w.trigger !== undefined })),
      (facts ?? []).map((f) => ({ workflowId: f.workflowId, nodeId: f.nodeId, title: f.title, kind: f.kind })),
      locale,
    );
    if (items.length === 0) return;
    // **合进现在这一份,不整份覆盖。** 取清单是异步的,这几百毫秒里用户完全可能已经在
    // 设置页建了一项、排过序 —— 整份覆盖会把那些连同 layout 一起吃掉。
    const now = current();
    const taken = new Set(now.items.map((i) => i.id));
    const merged = [...now.items, ...items.filter((i) => !taken.has(i.id))];
    const ok = await save({ version: 1, items: merged, layout: now.layout });
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
// A late read must never roll back a newer refresh or optimistic local save.
let configEpoch = 0;
// Serialize local writes: neither completion order nor rollback may resurrect
// an optimistic configuration that was never persisted.
let saveSeq = 0;
let writeTail: Promise<void> = Promise.resolve();
let confirmedConfig: CustomUiConfig | null = null;
/** 表单序号(见 `CustomUiForm.id`)。 */
let formSeq = 0;

function configurationView(current: CustomUiState, config: CustomUiConfig) {
  const item = current.panel && config.items.find((i) => i.id === current.panel!.item.id);
  const panel = !current.panel ? null : !item || item.action.type !== "panel" || item.slot !== current.panel.item.slot ? null
    : JSON.stringify(item) === JSON.stringify(current.panel.item) ? current.panel
    : { ...current.panel, item, id: `p${++formSeq}` };
  return { config, panel, activeTab: current.activeTab && config.items.some((i) => i.id === current.activeTab && i.slot === "rightPanel.tab") ? current.activeTab : null };
}

export const useCustomUiStore = create<CustomUiState>((set, get) => ({
  config: DEFAULT_CUSTOM_UI_CONFIG,
  loaded: false,
  load: () => {
    if (get().loaded) return Promise.resolve();
    if (loading) return loading;
    const epoch = configEpoch;
    loading = (async () => {
      try {
        const [res, collapsed, seeded] = await Promise.all([
          api.setting.get({ key: CUSTOM_UI_SETTING_KEY }),
          api.setting.get({ key: CUSTOM_UI_TOOLBAR_COLLAPSED_KEY }).catch(() => ({ value: null })),
          api.setting.get({ key: CUSTOM_UI_SEEDED_KEY }).catch(() => ({ value: null })),
        ]);
        const parsed = parseCustomUiConfig(res.value);
        if (epoch === configEpoch) confirmedConfig = parsed;
        set({ ...(epoch === configEpoch ? { config: parsed } : {}), loaded: true, toolbarCollapsed: collapsed.value === "1" });
        // 首启预置(2026-09-28):从没配置过(一个自定义项都没有)时,按现有自动化
        // 自动搭出文献菜单(seedDefaults 的绑定规则,冒烟钉住)。失败要说出来,
        // 不静默 —— "没预置"读起来会像"功能不存在"。
        // **只在从没预置过的机器上做**(见 CUSTOM_UI_SEEDED_KEY):清空过菜单的用户
        // 不该每次开应用都被塞回默认项。
        if (epoch === configEpoch && parsed.items.length === 0 && seeded.value !== "1") {
          void seedDefaults(get().save, () => get().config);
        }
      } catch {
        // 读不到(手机端 shim、库还没就绪)就当默认:菜单照常显示全部内置项
        set({ loaded: true });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  refresh: async () => {
    const epoch = ++configEpoch;
    await writeTail;
    if (epoch !== configEpoch) return;
    const res = await api.setting.get({ key: CUSTOM_UI_SETTING_KEY });
    if (epoch !== configEpoch) return;
    // Unlike startup recovery, a malformed external write must not erase a live UI.
    const config = CustomUiConfigSchema.parse(JSON.parse(res.value ?? "null"));
    confirmedConfig = config;
    set(configurationView(get(), config));
  },
  save: (next) => {
    const saveId = ++saveSeq;
    ++configEpoch;
    confirmedConfig ??= get().config;
    set({ config: next, loaded: true });
    const task = writeTail.then(async () => {
      try {
        await api.setting.set({ key: CUSTOM_UI_SETTING_KEY, value: JSON.stringify(next) });
        confirmedConfig = next;
        if (saveId === saveSeq && get().config === next) set(configurationView(get(), next));
        return true;
      } catch (err) {
        if (saveId === saveSeq && get().config === next) set(configurationView(get(), confirmedConfig!));
        const { locale } = useSessionStore.getState();
        useToastStore.getState().push({
          kind: "error",
          title: translate(locale, "customUi.saveFailed"),
          body: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    });
    writeTail = task.then(() => {}, () => {});
    return task;
  },

  focusSlot: null,
  setFocusSlot: (slot) => set({ focusSlot: slot }),

  view: null,
  openView: (view) => set({ view }),
  closeView: () => set({ view: null }),

  confirm: null,
  // 新确认框顶掉旧的那个时,旧的算「取消」—— 等着它的面板调用才能收到结果。
  openConfirm: (c) => {
    get().confirm?.onCancel?.();
    set({ confirm: c });
  },
  closeConfirm: () => set({ confirm: null }),

  form: null,
  openForm: (f) => set({ form: { ...f, id: `f${++formSeq}` } }),
  closeForm: () => set({ form: null }),

  panel: null,
  openPanel: (p) => set({ panel: { ...p, id: `p${++formSeq}` } }),
  closePanel: () => set({ panel: null }),

  activeTab: null,
  setActiveTab: (id) => set({ activeTab: id }),

  toolbarCollapsed: false,
  setToolbarCollapsed: (collapsed) => {
    // 先乐观改内存、再落盘(与 `save` 同一套)。**落盘失败要说出来** —— 从前这里只
    // `console.error`:界面上工具栏已经收起了,用户看到的是"改动生效了",直到重启才
    // **静默**弹回收起前的样子(数据根磁盘写满 / 被占用 / sql.js 导出失败都会走到)。
    // 与 sessionStore / uiPrefs 那两批外观 setter 走同一个共享出口
    // (`store.toast.settingSaveFailed`,toastStore 按标题去重)。
    set({ toolbarCollapsed: collapsed });
    void api.setting.set({ key: CUSTOM_UI_TOOLBAR_COLLAPSED_KEY, value: collapsed ? "1" : "0" }).catch((err: unknown) => {
      console.error("setting.set(customUi.toolbar.collapsed) failed:", err);
      useToastStore.getState().push({
        kind: "error",
        title: translate(useSessionStore.getState().locale, "store.toast.settingSaveFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
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
