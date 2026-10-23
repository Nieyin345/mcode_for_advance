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
  constructor(role: string | null, label: string) { this.role = role; this.label = label; }
  getAttribute(name: string) { return name === "role" ? this.role : null; }
  focus(opts?: unknown) { this.focused = true; (this as any)._focusOpts = opts; }
  scrollIntoView(opts?: unknown) { this.scrolledIntoView = opts; }
  click() { this.clicked++; }
}
globals.HTMLElement = FakeHTMLElement;

/** 造一次按键：默认 ArrowRight、不修饰、非 IME。 */
function press(key: string, overrides: Record<string, unknown> = {}) {
  const tabs = [
    new FakeHTMLElement("tab", "t0"),
    new FakeHTMLElement("tab", "t1"),
    new FakeHTMLElement("tab", "t2"),
  ];
  const target = tabs[0];
  const event = {
    key,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 39 },
    target,
    currentTarget: { querySelectorAll: (sel: string) => (sel === '[role="tab"]' ? tabs : []) },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
  handleTabListKeyDown(event as never);
  return { tabs, target, event };
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
  const { tabs } = press("ArrowRight");
  check("★ 导航后对目标 tab 调了 scrollIntoView(nearest/nearest)",
    JSON.stringify(tabs[1]!.scrolledIntoView) === JSON.stringify({ block: "nearest", inline: "nearest" }),
    tabs.map(t => t.scrolledIntoView));
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
