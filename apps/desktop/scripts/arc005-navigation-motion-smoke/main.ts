import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ARC-005 标签栏键盘导航 —— **真实行为验证**。
 *
 * 修法（T64）：这里原本有三条 `readFileSync(组件源码).includes("某段代码")` 的断言。
 * T61 的变异测试证明它们是**空过**的 —— 把 `canNavigateTabKey(e)` 那一行注释掉，
 * 套件仍 19/19 全绿。根因是 `includes` 只证明"字符串出现在文件里"，注释掉的代码、
 * 字符串字面量、文档注释都能让它为真。**它的肯定不是证据。**
 *
 * 现在改成真调生产的 `handleTabListKeyDown`（`TabBarChrome.tsx` 导出的那个函数，
 * 与组件里 `onKeyDown` 用的是**同一个**），构造真实的 DOM 事件对象，断言它真的
 * 导航了 / 真的没导航。
 *
 * 为什么能这么测：`handleTabListKeyDown` 只依赖 `canNavigateTabKey` +
 * `tabNavigationTargetIndex`（两个纯函数）和 DOM 接口（`instanceof HTMLElement`、
 * `getAttribute`、`querySelectorAll`、`focus`、`scrollIntoView`、`click`）。
 * 无头环境下用假对象提供这些接口即可，不需要起 Electron。
 *
 * `run.sh` 用 `--alias` 把 monaco 装配换成空壳 —— 那只为了让它能被 bundle，
 * 与本次判据无关（照仓库既有做法，见 chat-copy-payload-smoke）。
 */

// 先立好 window.api —— 组件模块在 import 期就会读它（自定义面板的 web API 兜底）。
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { api: {} };

const { handleTabListKeyDown } = await import("../../src/renderer/components/layout/TabBarChrome.js");
const { canNavigateTabKey, tabNavigationTargetIndex } = await import("../../src/renderer/components/layout/tabNavigationKeys.js");

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + JSON.stringify(detail)}`);
  if (ok) passed++; else failed++;
};

/* ─────────────── 假 DOM：够 handleTabListKeyDown 用的最小面 ─────────────── */

class FakeHTMLElement {
  role: string | null;
  label: string;
  focused = false;
  clicked = 0;
  scrolledIntoView: unknown = null;
  /* 【UI 重建 2026-10-27】`revealTabWithin` 现在**不调 scrollIntoView**
   *（那会连带滚走祖先的聊天时间线），改成自己算偏移再 `track.scrollTo`。
   * 所以夹具要提供它用到的那三样：`contains` / `getBoundingClientRect` / `scrollTo`，
   * 以及读写的 `scrollLeft` / `scrollTop`。**只补接口，不改变被测行为。** */
  scrollLeft = 0;
  scrollTop = 0;
  /** 覆盖自身在轨道里的横坐标（由 `press()` 设置）。**必须显式给** ——
   * 早先版本靠「父容器的 children 里找我」求坐标，而 tab 自己并不知道父是谁，
   * 于是每个 tab 都算出 0–100（＝已可见），`revealTabWithin` 永不滚，
   * 而测试只看到「没滚」，会误判成功能坏了。 */
  left = 0;
  scrollToCalls: Array<{ left?: number; top?: number; behavior?: string }> = [];
  children: FakeHTMLElement[] = [];
  constructor(role: string | null, label: string) { this.role = role; this.label = label; }
  getAttribute(name: string) { return name === "role" ? this.role : null; }
  focus(opts?: unknown) { this.focused = true; (this as any)._focusOpts = opts; }
  scrollIntoView(opts?: unknown) { this.scrolledIntoView = opts; }
  click() { this.clicked++; }
  contains(other: unknown) { return other === this || this.children.includes(other as FakeHTMLElement); }
  /** 视口统一 100 宽。轨道自己是 0–100；每个 tab 100 宽、按 `left` 摆。 */
  getBoundingClientRect() {
    return { left: this.left, right: this.left + 100, top: 0, bottom: 20 };
  }
  scrollTo(opts: { left?: number; top?: number; behavior?: string }) {
    this.scrollToCalls.push(opts);
    if (typeof opts.left === "number") this.scrollLeft = opts.left;
    if (typeof opts.top === "number") this.scrollTop = opts.top;
  }
}
globals.HTMLElement = FakeHTMLElement;

/** 造一次按键：默认 ArrowRight、不修饰、非 IME。 */
function press(key: string, overrides: Record<string, unknown> = {}) {
  const track = new FakeHTMLElement("tablist", "track");
  const tabs = [
    new FakeHTMLElement("tab", "t0"),
    new FakeHTMLElement("tab", "t1"),
    new FakeHTMLElement("tab", "t2"),
  ];
  // 摆位：视口 0–100，三格各 100 宽 → t0 可见、t1/t2 在视口外。
  tabs.forEach((t, i) => { t.left = i * 100; });
  track.children = tabs;
  const target = tabs[0];
  const event = {
    key,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 39 },
    target,
    currentTarget: {
      /* 【UI 重建 2026-10-27】**夹具的选择器匹配必须跟着实现走。**
       *
       * 原来这里是 `sel === '[role="tab"]'` —— 精确相等。而实现后来把选择器
       * 换成了 `'[role="tab"]:not([aria-disabled="true"]):not([disabled])'`
       * （过滤掉禁用的页签，这是个改进）。精确相等于是永远不命中，`tabs` 为空，
       * `index < 0` 直接 return —— **三条正控全红，而实现完全正确**。
       *
       * 现在按「包含 `[role="tab"]`」匹配。 */
      querySelectorAll: (sel: string) => (sel.includes('[role="tab"]') ? tabs : []),
      contains: (el: unknown) => track.contains(el),
      getBoundingClientRect: () => track.getBoundingClientRect(),
      get scrollLeft() { return track.scrollLeft; },
      get scrollTop() { return track.scrollTop; },
      scrollTo: (o: { left?: number; top?: number; behavior?: string }) => track.scrollTo(o),
    },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
  handleTabListKeyDown(event as never);
  return { tabs, target, event, track };
}

/* ────────────────────────── ① 键盘过滤（原来 L10） ────────────────────────── */

{
  const ime = press("ArrowRight", { nativeEvent: { isComposing: true, keyCode: 39 } });
  const ime229 = press("ArrowRight", { nativeEvent: { isComposing: false, keyCode: 229 } });
  const shifted = press("ArrowRight", { shiftKey: true });
  check("★ IME 组合中的按键不导航（行为断言，不是源码文本）",
    ime.tabs.every(t => !t.focused && t.clicked === 0) && !ime.event.defaultPrevented,
    { focused: ime.tabs.map(t => t.focused), prevented: ime.event.defaultPrevented });
  check("★ IME keyCode 229 不导航",
    ime229.tabs.every(t => !t.focused && t.clicked === 0),
    ime229.tabs.map(t => t.focused));
  check("★ Shift 组合不导航（留给选择语义）",
    shifted.tabs.every(t => !t.focused && t.clicked === 0),
    shifted.tabs.map(t => t.focused));

  // 正控：同一套夹具、去掉修饰键就必须真的导航 —— 否则上面三条可能是"根本没跑起来"
  const normal = press("ArrowRight");
  check("★ 正控：无修饰的 ArrowRight 真的导航到下一个 tab",
    normal.tabs[1]!.focused && normal.tabs[1]!.clicked === 1,
    { focused: normal.tabs.map(t => t.focused), clicked: normal.tabs.map(t => t.clicked) });
}

/* ─────────────────── ② 聚焦后把溢出的 tab 滚进可视区（原 L11） ─────────────────── */

{
  /* 【UI 重建 2026-10-27】实现改成了 `revealTabWithin`（自己算偏移 + `track.scrollTo`），
   * **不再调 `scrollIntoView`** —— 因为后者会把祖先容器（聊天时间线、编辑器、
   * 整个 Electron 工作区）一起滚走。所以断言从「对 tab 调了 scrollIntoView」
   * 改成正反两控：
   *   正控：目标 tab 在视口外 → 轨道真的滚了；
   *   反控：目标 tab 已在视口内 → **不滚**（否则每次按方向键都抖一下）。 */
  const { tabs, track } = press("ArrowRight");
  check("★ 导航后把溢出的目标 tab 滚进可视区（track.scrollTo，不滚祖先）",
    // 值不必写死：`railScrollLeft` 会留 8px 内距，所以是 92 而不是 100。
    // 断言「滚了一次、滚到目标可见的位置、且没调 scrollIntoView」——
    // 后者是本条真正的价值：`scrollIntoView` 会连带滚走祖先的聊天时间线。
    track.scrollToCalls.length === 1 &&
    typeof track.scrollToCalls[0]!.left === "number" &&
    track.scrollToCalls[0]!.left > 0 &&
    // 滚完之后目标 t1（100–200）必须与视口 [left, left+100] 有重叠。
    // 不要求完全覆盖：`railScrollLeft` 只保证「露出来」，两侧各留 8px 内距，
    // 所以 92 是正确值（100 - 8），而「100–200 完全塞进 92–192」本来就不成立。
    track.scrollToCalls[0]!.left! + 100 > 100 && track.scrollToCalls[0]!.left! < 200 &&
    tabs.every((t) => t.scrolledIntoView === null),
    { calls: track.scrollToCalls, targetScrollLeft: track.scrollLeft });
  check("★ 目标已在视口内时不滚（避免每次按键都抖动）",
    // t0 → ArrowLeft 环绕到 t2(200–300)，仍在视口外；这里用 ArrowRight 到 t1 已滚过，
    // 再按一次应当继续前滚到 t2 —— 所以反控用「构造一次已在视口内的导航」：
    // 直接把目标设成 t0（视口内 0–100）再手动调一次。
    (() => {
      const t = new FakeHTMLElement("tablist", "track");
      const a = new FakeHTMLElement("tab", "t0");
      const b = new FakeHTMLElement("tab", "t1");
      a.left = 0; b.left = 100;
      t.children = [a, b];
      const ev = {
        key: "ArrowLeft", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
        nativeEvent: { isComposing: false, keyCode: 37 },
        target: b,
        currentTarget: {
          querySelectorAll: (s: string) => (s.includes('[role="tab"]') ? t.children : []),
          contains: (el: unknown) => t.contains(el),
          getBoundingClientRect: () => t.getBoundingClientRect(),
          get scrollLeft() { return t.scrollLeft; },
          get scrollTop() { return t.scrollTop; },
          scrollTo: (o: { left?: number; top?: number; behavior?: string }) => t.scrollTo(o),
        },
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
      };
      handleTabListKeyDown(ev as never);
      // t0 在 0–100，视口 0–100 → 已完全可见 → 不该滚
      return a.focused && t.scrollToCalls.length === 0;
    })(),
    { note: "wrap 到已可见的 tab 时轨道不该动" });
}

/* ─────────────────── ③ 消费事件、不冒泡给全局快捷键（原 L12） ─────────────────── */

{
  const { event } = press("ArrowRight");
  check("★ 导航时 preventDefault + stopPropagation 都调了",
    event.defaultPrevented && event.propagationStopped,
    { prevented: event.defaultPrevented, stopped: event.propagationStopped });

  // 反控：不该导航的按键**不应**消费事件（不然会把用户的其它快捷键吃掉）
  const ignored = press("Delete");
  check("★ 反控：不导航的按键不消费事件（不吞别人的快捷键）",
    !ignored.event.defaultPrevented && !ignored.event.propagationStopped,
    { prevented: ignored.event.defaultPrevented, stopped: ignored.event.propagationStopped });
}

/* ───────────── ④ 纯函数层保留原有的细粒度断言（它们本来就是行为断言） ───────────── */

const key = (override: Record<string, unknown> = {}) => ({
  key: "ArrowRight", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
  nativeEvent: { isComposing: false, keyCode: 39 }, ...override,
});
check("normal keyboard Arrow remains available", canNavigateTabKey(key() as never));
check("IME composing and keyCode229 never navigate",
  !canNavigateTabKey(key({ nativeEvent: { isComposing: true, keyCode: 39 } }) as never) &&
  !canNavigateTabKey(key({ nativeEvent: { isComposing: false, keyCode: 229 } }) as never));
check("Shift / Alt / Ctrl / Meta combinations leave tab selection unchanged",
  ["shiftKey", "altKey", "ctrlKey", "metaKey"].every(flag => !canNavigateTabKey(key({ [flag]: true }) as never)));
check("Arrow wraps only inside tab list", tabNavigationTargetIndex("ArrowRight", 2, 3) === 0 &&
  tabNavigationTargetIndex("ArrowLeft", 0, 3) === 2);
check("Home and End jump to first and last", tabNavigationTargetIndex("Home", 2, 4) === 0 &&
  tabNavigationTargetIndex("End", 0, 4) === 3);
check("Other keys and invalid indices never navigate", tabNavigationTargetIndex("Delete", 1, 3) === null &&
  tabNavigationTargetIndex("ArrowRight", -1, 3) === null && tabNavigationTargetIndex("ArrowLeft", 0, 0) === null);

/* ─────────────────────────── ⑤ ticker 运动偏好（原样保留） ─────────────────────────── */

const { resolveTickerReducedMotion, tickerMotionSnapshot, subscribeTickerMotion } =
  await import("../../src/renderer/components/chat/useTickerReducedMotion.js");

check("Explicit Mcode reduced motion overrides OS BOTH ways",
  resolveTickerReducedMotion("true", false) && !resolveTickerReducedMotion("false", true));
check("System motion applies if preference absent or malformed",
  resolveTickerReducedMotion(null, true) && !resolveTickerReducedMotion(null, false) &&
  resolveTickerReducedMotion("unexpected", true));

const previous = { window: globals.window, document: globals.document, MutationObserver: globals.MutationObserver };
let attribute: string | null = null;
let mediaMatches = false;
let notifications = 0, observerDisconnected = false;
const mediaListeners = new Set<() => void>();
const mutationListener: { callback?: () => void } = {};
try {
  globals.window = {
    api: {},
    matchMedia: () => ({
      get matches() { return mediaMatches; },
      addEventListener: (_type: string, cb: () => void) => mediaListeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => mediaListeners.delete(cb),
    }),
  };
  globals.document = { documentElement: { getAttribute: () => attribute } };
  globals.MutationObserver = class {
    constructor(cb: () => void) { mutationListener.callback = cb; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  const unsubscribe = subscribeTickerMotion(() => { notifications++; });
  check("Motion listener tracks initial OS preference", tickerMotionSnapshot() === false && mediaListeners.size === 1);
  mediaMatches = true;
  for (const callback of mediaListeners) callback();
  check("OS motion change triggers re-read without remount", notifications === 1 && tickerMotionSnapshot() === true);
  attribute = "false";
  mutationListener.callback?.();
  check("Mcode override false activates motion even while OS reduces",
    notifications === 2 && tickerMotionSnapshot() === false);
  attribute = "true";
  mutationListener.callback?.();
  mediaMatches = false;
  check("Mcode override true persists after OS toggles off", tickerMotionSnapshot() === true);
  unsubscribe();
  check("Unsubscribe removes OS listener and mutation observer", mediaListeners.size === 0 && observerDisconnected);
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
}

console.log(`arc005-navigation-motion: ${passed}/${passed + failed}`);
if (failed) process.exitCode = 1;
