/**
 * 【ARC-005 V2】**滚动边缘羽化容器** —— 直接复用 `open-claude-ui` 的
 * `code-examples/ScrollFadeContainer.tsx`（MIT，REA 对 Claude 桌面端的取证）。
 *
 * 上游的 7 档非线性 alpha 遮罩（28px 羽化、y≈x^1.5 幂律）是逐字节从生产 CSS
 * 提取的；Mcode 这里保留同一组采样，只把实现简化成不需要 framer-motion 的
 * 纯 React + CSS mask（本仓没有该依赖，也不为它增加体积）。
 *
 * 与上游的行为差异（有意）：
 *  - 不引入 `@container` 折叠逻辑：那是 SegmentedControl 的，不属于本组件；
 *  - `fadeSize` 默认 28px（上游 `--cds-scroll-fade-size`），可由调用方覆盖；
 *  - 滚动位置变化用 rAF 合并，避免高频 scroll 事件每帧 setState。
 *
 * 用途：长列表（侧栏会话、工具卡展开体、设置页长面板）的上下边缘。
 * 只在**真的溢出**时才画羽化 —— 不溢出的容器保持完全清晰。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";

export interface ScrollFadeProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both";
  /** 羽化宽度（px），上游默认 28。 */
  fadeSize?: number;
}

export function ScrollFade({
  orientation = "vertical",
  fadeSize = 28,
  className,
  children,
  ...props
}: ScrollFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: fadeSize, bottom: fadeSize, left: fadeSize, right: fadeSize });
  const raf = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const vertical = orientation === "vertical" || orientation === "both";
    const horizontal = orientation === "horizontal" || orientation === "both";
    let next = { top: 0, bottom: 0, left: 0, right: 0 };
    if (vertical) {
      const overflow = el.scrollHeight - el.clientHeight;
      // 不溢出就完全不羽化（否则静止列表的上下两端会无故发虚）。
      next.top = overflow > 2 && el.scrollTop > 2 ? fadeSize : 0;
      next.bottom = overflow > 2 && el.scrollTop + el.clientHeight < el.scrollHeight - 2 ? fadeSize : 0;
    }
    if (horizontal) {
      const overflow = el.scrollWidth - el.clientWidth;
      next.left = overflow > 2 && el.scrollLeft > 2 ? fadeSize : 0;
      next.right = overflow > 2 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? fadeSize : 0;
    }
    setEdges((prev) =>
      prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left && prev.right === next.right
        ? prev
        : next,
    );
  }, [orientation, fadeSize]);

  const schedule = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [measure, schedule]);

  // 上游 7 档采样（15/30/45/60/75/87/100% 处 alpha .15/.30/.45/.60/.75/.87/1），
  // 上下两侧镜像。方向用 to bottom/right；两侧都按各自边缘宽度收放。
  const maskStyle = useMemo<React.CSSProperties>(() => {
    // 上游 7 档采样：15/30/45/60/75/87/100% 处 alpha 0.15/0.30/0.45/0.60/0.75/0.87/1。
    // 写成显式两段（起始侧 → 全不透明 → 结束侧），避免靠字符串反转生成而算错顺序。
    const RAMP: Array<[number, string]> = [
      [0.15, "#0000000d"],
      [0.3, "#00000026"],
      [0.45, "#0000004d"],
      [0.6, "#00000080"],
      [0.75, "#000000b3"],
      [0.87, "#000000d9"],
    ];
    if (orientation === "vertical") {
      const grad = `linear-gradient(to bottom, ${[
        "transparent",
        ...RAMP.map(([k, c]) => `${c} calc(var(--sf-top) * ${k})`),
        "#000 var(--sf-top)",
        "#000 calc(100% - var(--sf-bottom))",
        ...[...RAMP].reverse().map(([k, c]) => `${c} calc(100% - var(--sf-bottom) * ${k})`),
        "transparent",
      ].join(", ")})`;
      return { maskImage: grad, WebkitMaskImage: grad };
    }
    if (orientation === "horizontal") {
      const grad = `linear-gradient(to right, ${[
        "transparent",
        ...RAMP.map(([k, c]) => `${c} calc(var(--sf-left) * ${k})`),
        "#000 var(--sf-left)",
        "#000 calc(100% - var(--sf-right))",
        ...[...RAMP].reverse().map(([k, c]) => `${c} calc(100% - var(--sf-right) * ${k})`),
        "transparent",
      ].join(", ")})`;
      return { maskImage: grad, WebkitMaskImage: grad };
    }
    return {};
  }, [orientation]);

  return (
    <div
      ref={ref}
      onScroll={schedule}
      data-cds-scroll-fade={orientation}
      className={cn("relative overflow-auto transition-[mask-image] duration-150", className)}
      style={{
        ...maskStyle,
        ["--sf-top" as string]: `${edges.top}px`,
        ["--sf-bottom" as string]: `${edges.bottom}px`,
        ["--sf-left" as string]: `${edges.left}px`,
        ["--sf-right" as string]: `${edges.right}px`,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
