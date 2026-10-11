/**
 * 自定义面板的「读回」注册表(报告 E10)。
 *
 * ## 为什么需要它
 *
 * 面板跑在 `mcode-panel://` 的**沙箱 iframe** 里(`sandbox` 故意不给 `allow-same-origin`,
 * 见 `PanelFrame`),于是它是 opaque origin —— **外面的窗口读不到它的 DOM**。想知道它
 * 渲染成了什么样,只能由**面板自己**读自己的 `document` 回话(那段在 `@contracts/customUiPanel`
 * 的 SDK 里,见 `PanelProbeReply`)。
 *
 * 谁在渲染面板、谁手里有那个 iframe?`PanelFrame`(设置页预览、右键浮窗、右栏页签都用它)。
 * 它挂载时把一个 `probe` 能力登记到这里,agent 经 `app_ui action:read_panel` → 渲染端
 * `appControlHost` → 这里,挑一个**当前该读的**面板去问一句。
 *
 * ## 为什么是模块级、不退订的 Map
 *
 * 与 `askQueue` / `chatElementQueueBySession` 同一类:同一时刻**可能**有多个面板挂着
 * (草稿预览 + 用户右键开的浮窗 + 右栏页签)。读哪一个要有个确定的口径,而这口径得在
 * "谁在渲染"之外单独存在 —— 所以登记表活在模块级,`PanelFrame` 挂载即登记、卸载即注销。
 *
 * 纯模块(不 import electron / DOM / react),smoke 直接 bundle 测选择逻辑。
 */
import type { PanelProbeReply } from "@contracts/customUiPanel";

/** 一个正在渲染的面板 —— `PanelFrame` 挂载时登记。 */
export interface PanelProbeHandle {
  /** 面板项 id(`customUi.config.v1` 里的条目 id)。 */
  itemId: string;
  /** 面板显示名(确认是哪一个)。 */
  label: string;
  /**
   * 它在哪儿渲染的:
   *   - `float`:用户从菜单/右键点开的浮窗(`CustomUiHost`);
   *   - `preview`:设置页编辑器里那格「预览」(作者迭代用的);
   *   - `tab`:右栏常驻页签(`CustomTabView`)。
   */
  mode: "float" | "preview" | "tab";
  /** 问这个面板「你现在渲染成什么样」。超时 / 还没加载好 → 抛。 */
  probe: () => Promise<PanelProbeReply>;
}

/** 登记表:插入顺序 = 挂载顺序,注销即移除。 */
const handles = new Map<PanelProbeHandle, true>();

/** 读哪个模式优先 —— 浮窗(用户显式开的)> 预览(作者迭代)> 页签(常驻)。 */
const MODE_PRIORITY: Record<PanelProbeHandle["mode"], number> = { float: 0, preview: 1, tab: 2 };

/** `PanelFrame` 挂载即调,返回**注销函数**(放 `useEffect` 的 cleanup 里)。 */
export function registerPanelProbe(handle: PanelProbeHandle): () => void {
  handles.set(handle, true);
  return () => {
    handles.delete(handle);
  };
}

/** 当前挂着的所有面板(给 agent「还有哪些可读」)。 */
export function listPanelProbes(): Array<{ itemId: string; label: string; mode: PanelProbeHandle["mode"] }> {
  return [...handles.keys()].map((h) => ({ itemId: h.itemId, label: h.label, mode: h.mode }));
}

/**
 * 挑一个**当前该读的**面板。
 *
 *   - 给了 `itemId`:同 id 的里取优先级最高(浮窗 > 预览 > 页签);
 *   - 没给:整体取优先级最高的那个(并列时取**最后挂载**的 —— 刚打开的更可能是用户
 *     现在看着的)。
 *
 * 挑不出来返回 `undefined`,调用方**如实说**「现在没有面板可以读」,别静默。
 */
export function pickPanelProbe(itemId?: string): PanelProbeHandle | undefined {
  let best: PanelProbeHandle | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const h of handles.keys()) {
    if (itemId && h.itemId !== itemId) continue;
    const rank = MODE_PRIORITY[h.mode];
    // `<=`:并列取后面的(后挂载的)。
    if (rank <= bestRank) {
      best = h;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * `read_panel` 取不到面板时,在等它出现之前允许的**上限窗口**(报告 R7)。
 *
 * 短:read_panel 是只读、agent 会连发,不能把它拖住。1.2s 只够补"挂载晚一拍"那道缝
 * —— 面板真要开起来远超这个数时照旧如实报错,不假装等到了。
 */
export const READ_PANEL_WAIT_MS = 1200;

/**
 * 挑一个该读的面板;**当下挑不到就在 `ms` 窗口内轮询**(报告 R7)。
 *
 * 与纯函数 `pickPanelProbe` 分开,是因为"等"这件事要有个确定口径:
 *   - `PanelFrame` 的 probe 是**挂载时**才登记的,而 `openPanel` 只改 store —— 从那次
 *     setState 到 React 提交、`PanelFrame` 挂上,中间隔一(或几)拍;
 *   - `open_panel` 自己 `await waitFor(...)` 把这道缝补上了,但那份保护**只在它自己的
 *     promise 里**。若 agent 把 `open_panel` 与 `read_panel` **并发**发下,或读的这拍
 *     正逢组件重挂的空窗,`read_panel` 这一刻 pick 就会扑空,报"没有正在渲染的面板"
 *     —— 正是报告里"开完立刻读没读到"的窗口。
 *
 * 窗口耗尽仍挑不到 → 返回 `undefined`,调用方**照旧如实报错**(列出当前挂着的面板)。
 * 带时间,所以与 `pickPanelProbe` 分家:`pickPanelProbe` 只看当下,这一支会等。
 */
export async function waitForPanelProbe(itemId?: string, ms = READ_PANEL_WAIT_MS): Promise<PanelProbeHandle | undefined> {
  const first = pickPanelProbe(itemId);
  if (first) return first;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    const hit = pickPanelProbe(itemId);
    if (hit) return hit;
  }
  // 最后再挑一次:窗口边界上刚好挂上的也算数(与 `waitFor` 的收尾 pred() 同一规矩)。
  return pickPanelProbe(itemId);
}
