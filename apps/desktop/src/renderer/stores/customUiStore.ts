/**
 * 自定义 UI 的渲染端状态:配置本体 + 运行时要弹的那两种浮层(视图 / 批量确认)。
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
  type CustomUiSlot,
} from "@contracts/customUi";
import { api } from "@renderer/lib/api.js";
import { translate } from "@renderer/lib/i18n/core.js";
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
        const res = await api.setting.get({ key: CUSTOM_UI_SETTING_KEY });
        set({ config: parseCustomUiConfig(res.value), loaded: true });
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
}));

/** 菜单末尾「自定义 UI…」:记下挂载位,打开设置页的「自定义 UI」。 */
export function openCustomUiSettings(slot: CustomUiSlot): void {
  useCustomUiStore.getState().setFocusSlot(slot);
  useSessionStore.getState().setSettingsOpen(true, "custom-ui");
}
