/**
 * 【ARC-005 V2】roving-tabindex 漫游焦点 —— 复用 `open-claude-ui` 的
 * `code-examples/useClaudeRovingFocus.ts`（MIT，REA 对 Claude 桌面端的取证）。
 *
 * 上游规则（逐条）：
 *  - 方向键在组内移动（horizontal / vertical / both 三档）；
 *  - Home / End 跳首尾，PageUp / PageDown 跨页；
 *  - RTL（`dir="rtl"`）时左右镜像；
 *  - **Tab / Shift+Tab 立即退出漫游组**，把焦点交还全局 Tab 流（防键盘死循环）；
 *  - 动态 tabIndex：只有当前项 0，其余 -1。
 *
 * Mcode 此前在浏览器标签条、工作流库等处各写了一份简化版 roving。这里收成
 * 一份共享 hook，新组件使用；旧实现保留（避免大范围改动带来的回归），
 * 迁移由后续逐面板进行。
 */
import { useCallback, useRef, useState } from "react";

export interface RovingFocusOptions {
  orientation?: "horizontal" | "vertical" | "both";
  loop?: boolean;
  dir?: "ltr" | "rtl";
}

export interface RovingFocus {
  /** 当前应带 tabIndex=0 的下标。 */
  activeIndex: number;
  /** 为第 index 项算 tabIndex。 */
  tabIndexFor: (index: number) => number;
  /** 绑到每个可聚焦项上的 keydown。 */
  onKeyDown: (event: React.KeyboardEvent, index: number) => void;
  /** 焦点进入某项时同步 activeIndex。 */
  onFocus: (index: number) => void;
  /** 把元素注册进漫游组（顺序 = DOM 顺序）。 */
  register: (index: number) => (node: HTMLElement | null) => void;
}

export function useRovingFocus(itemCount: number, options: RovingFocusOptions = {}): RovingFocus {
  const { orientation = "vertical", loop = true, dir = "ltr" } = options;
  const [activeIndex, setActiveIndex] = useState(0);
  const items = useRef<(HTMLElement | null)[]>([]);

  const register = useCallback(
    (index: number) => (node: HTMLElement | null) => {
      items.current[index] = node;
    },
    [],
  );

  const focusAt = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(itemCount - 1, index));
    setActiveIndex(clamped);
    items.current[clamped]?.focus();
  }, [itemCount]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number) => {
      // 上游规则 1：Tab 交还全局焦点流，漫游组不拦。
      if (event.key === "Tab") return;
      const forward = orientation === "horizontal" || orientation === "both";
      const vertical = orientation === "vertical" || orientation === "both";
      const rtl = dir === "rtl";
      let target: number | null = null;
      switch (event.key) {
        case "ArrowRight":
          if (forward) target = index + (rtl ? -1 : 1);
          break;
        case "ArrowLeft":
          if (forward) target = index + (rtl ? 1 : -1);
          break;
        case "ArrowDown":
          if (vertical) target = index + 1;
          break;
        case "ArrowUp":
          if (vertical) target = index - 1;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = itemCount - 1;
          break;
        case "PageUp":
          target = index - 10;
          break;
        case "PageDown":
          target = index + 10;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (target === null) return;
      if (!loop) {
        target = Math.max(0, Math.min(itemCount - 1, target));
      } else {
        target = ((target % itemCount) + itemCount) % itemCount;
      }
      focusAt(target);
    },
    [dir, focusAt, itemCount, loop, orientation],
  );

  const onFocus = useCallback((index: number) => setActiveIndex(index), []);
  const tabIndexFor = useCallback((index: number) => (index === activeIndex ? 0 : -1), [activeIndex]);

  return { activeIndex, tabIndexFor, onKeyDown, onFocus, register };
}
