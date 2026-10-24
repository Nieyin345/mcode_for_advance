/**
 * cn() — Tailwind class merging utility.
 *
 * Combines clsx (conditional class joining) with tailwind-merge
 * (conflict resolution). Always use this instead of raw template
 * literal className concatenation.
 *
 * @example
 *   cn("px-2 py-1", isActive && "bg-accent", "px-4") // → "py-1 bg-accent px-4"
 */
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import type { ClassValue } from "clsx";

/**
 * 【T140】把 CDS 七档登记给 twMerge。
 *
 * ## 不登记会发生什么
 *
 * `tailwind.config.js` 的 `fontSize` 是**扩展**出来的档位名，而 `twMerge`
 * 只认识 Tailwind 内置的 `text-xs` / `text-sm` / …。见到 `text-caption`
 * 它无法判断这是字号还是颜色，于是归进**文字颜色**组 —— 与同一次 `cn()`
 * 里的 `text-content` 同组冲突，先出现的被丢掉：
 *
 *     twMerge("text-caption text-content")  →  "text-content"
 *
 * 字号于是静默回落到根继承值（`html/body` 没设 `font-size` → 浏览器 16px）。
 *
 * **这不是假设**：T138 把 `FilterChip` 的 `text-[11px]` 改成 `text-caption`
 * 之后筛选条从两行变三行 —— 11px 变 16px。全仓 27 处同型（`text-code` 24 处
 * 最重，含 `ui/input` / `select` / `dialog` / `textarea` 这些共享控件）。
 *
 * ## 为什么登记七个名字就够
 *
 * 内置档位（`xs` / `sm` / …）本来就在 `font-size` 组里，登记自定义档位等于
 * 把它们并入同一组 —— 于是「档位互相覆盖」和「档位与颜色共存」同时成立。
 * 颜色 / 背景 / 间距的冲突解决完全不受影响（套件有三条负控守着）。
 *
 * ## ⚠️ 这个列表必须与 tailwind.config.js 的 fontSize 保持一致
 *
 * 加档位时两处一起改。`t140-cn-tier-smoke` 有一条断言直接读
 * `tailwind.config.js` 对比两边集合，漏改会红。
 */
const CDS_TIERS = [
  "caption",
  "footnote",
  "code",
  "body",
  "prose",
  "heading",
  "title",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": CDS_TIERS.map((tier) => `text-${tier}`),
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
