import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * useFocusTrap —— 全站共享的 overlay 焦点管理原语:"**顶层面板拥有输入**"。
 *
 * 【MC-046】设置覆盖层从前只是一个铺满窗口的 `<div className="fixed inset-0">`:
 * 鼠标点不进后台,键盘却可以 —— 打开设置后 `document.activeElement` 还是 BODY,
 * 第一下 Tab 就落到覆盖层**外**的后台控件(工作区全程挂载、未 inert)。本 hook 是
 * 修这条缺陷时立的共享件,**不只为设置页写**:后续 BrowserOverlay / CommandPalette /
 * SearchDialog 凡换成自绘的顶层容器,都该接它。判据只有一个 —— 谁是当前**所有权层**,
 * 谁就负责:①接管初始焦点 ②把 Tab 循环关在自己层内 ③退出时把焦点还给打开前的元素。
 *
 * 契约(挂了钩子的这一层必须满足、也只需满足这些):
 * - 挂载(enabled 变 true)时记录 `document.activeElement`,把焦点移入容器:
 *   首个可聚焦元素;容器里一个都没有时容器自身兜底(`tabIndex=-1`,不改布局)。
 * - 卸载(enabled 变 false 或组件卸载)时把焦点还给那个元素 —— 只是"还",
 *   之后焦点去哪不归这里管;被记录的元素已不在文档里(如会话标签关了)就不动。
 * - Tab / Shift+Tab 首尾回绕,焦点不许逃出容器;焦点被浏览器惰性清成 body
 *   (后台刚被设 inert 时的固有行为)后按 Tab 也拉回层内。
 * - 焦点在**别的顶层**里(嵌套的 base-ui 弹窗/下拉 portal)时**让位**:
 *   那些层自己拥有输入,这里不做二次劫持 —— 判据是 activeElement 是否还在本层
 *   (或 body),不是"文档里存不存在弹窗"。
 * - **不处理 Escape。** 设置页的 Escape 归 `SettingsPage` 自己的监听,并与
 *   `escapeClosesSettings`(嵌套弹窗打开时让位)协作;hook 里重复处理会和它打架。
 *   将来若接一个没有自己 Escape 的顶层,再在这里做按下层数判断。
 *
 * 与后台的联动分两半,缺一不可:本 hook 只管"焦点在自己层内循环/归位";
 * **被盖住的后台必须由调用方标 inert**(见 App.tsx 的 WorkspaceInertShell)——
 * 两半合起来才是完整的模态语义:inert 让后台退出 Tab 序与辅助技术,本 hook 让
 * 焦点在层内闭环并记得回家的路。
 *
 * 时序上一处**必须用 useLayoutEffect**:后台标 inert 时,浏览器会在**稍后的宏任务**
 * 里把"到位时仍留在 inert 子树里"的焦点清成 body(真 Chrome 实测:同步/微任务/rAF
 * 都还没清,一个 task 后才清;已移出那棵子树的不抢)。布局副作用与 DOM 变更同一次
 * 提交同步执行,记录原焦点 + 移入新焦点必然赶在清理任务之前 —— 换成 useEffect 就
 * 和那次清理赛跑,可能记录到已被清成 body 的焦点(归还目标莫名丢失,且是偶发)。
 *
 * @example
 *   const rootRef = useRef<HTMLDivElement>(null);
 *   useFocusTrap(rootRef, open);          // open 翻转时才进出
 *   if (!open) return null;
 *   return <div ref={rootRef} className="settings-root ...">…</div>;
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  // 打开前焦点在哪(要归还的目标)。跨 effect 重跑保留 —— 见下面两个时机注释。
  const previousRef = useRef<HTMLElement | null>(null);
  // 尚未执行的"归还焦点"定时器。存在即代表"关闭已发生、归还被推迟"。
  const restoreTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    // 若上一次清理安排过"归还焦点"但还没执行,先取消:同一次提交里 **关→开**
    // 不该真的把焦点还回去 —— 这一回合的设置层继续拥有焦点,previousRef 也原样
    // 保留(不能被重跑覆盖成层内的元素)。React StrictMode 开发期的模拟
    // 卸载/重挂同样走这条:钩子行为对重挂幂等。
    if (restoreTimerRef.current !== null) {
      window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }

    // 记录"打开前焦点在哪"。已经在容器里、或是 body(点击非聚焦区域后的
    // 落点)都不算归还目标 —— 重挂时焦点已在层内,不能把它记进去。
    if (previousRef.current === null) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !container.contains(active)
      ) {
        previousRef.current = active;
      }
    }

    // 焦点移入:首个可聚焦元素;容器里一个都没有时容器自身兜底。在布局副作用
    // 里**同步**把焦点移出后台子树(原因见文件头那段时序说明)。
    const first = focusableElements(container)[0];
    if (first) {
      first.focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      // 同层组件(Monaco 等)已经消费了这次 Tab 就让它走 —— React 的根级
      // 监听在我们之前跑,document 冒泡层拿到时 defaultPrevented 已可见。
      if (e.defaultPrevented) return;
      const active = document.activeElement;
      // "还归我们管"的两种情形:焦点在容器内;或焦点掉到了 body(inert 清
      // 焦、点击非聚焦背景后的残留)。焦点在别的元素上 —— 嵌套弹窗/下拉的
      // portal、别的顶层 —— 一律让位。
      const mine =
        active === document.body ||
        (active instanceof HTMLElement && container.contains(active));
      if (!mine) return;

      const list = focusableElements(container);
      e.preventDefault();
      if (list.length === 0) {
        if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
        container.focus();
        return;
      }
      // idx === -1(容器自身或 body):Tab 去第一个、Shift+Tab 去最后一个 ——
      // 显式定序,不依赖浏览器"下一个可 tab 元素"在 inert/portal 混合下的推断。
      const idx = active instanceof HTMLElement ? list.indexOf(active) : -1;
      const next = e.shiftKey
        ? idx <= 0
          ? list[list.length - 1]
          : list[idx - 1]
        : idx === -1 || idx === list.length - 1
          ? list[0]
          : list[idx + 1];
      next.focus();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // 归还焦点**推迟一个任务**:同一次提交里的"关→开"重挂会在上面的
      // clearTimeout 里取消它,焦点不被中途抢走;真正关闭/卸载时没有重挂,
      // 定时器照常把焦点还给打开前的元素。故意不判断"现在焦点在哪" ——
      // 关闭时焦点最自然的落点就是 body,直接还给记录的元素才是可预测的契约。
      restoreTimerRef.current = window.setTimeout(() => {
        restoreTimerRef.current = null;
        const target = previousRef.current;
        previousRef.current = null;
        if (target && target.isConnected) target.focus();
      }, 0);
    };
  }, [containerRef, enabled]);
}

/** 可聚焦元素的选择器 —— 与主流 focus-trap 一致的惯用集合,不含 `[tabindex="-1"]`
 *  (那类只能程序化聚焦,不参与 Tab 循环)。 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 可见才可聚焦。`getClientRects()` 同时覆盖 display:none 与未挂树;visibility
 *  要单独看(inherited,子元素自己读得到)。 */
function isVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}
