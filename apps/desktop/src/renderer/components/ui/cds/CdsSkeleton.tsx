/**
 * 【ARC-005 V2】**CDS 骨架屏** —— 复用 `open-claude-ui` 的
 * `StatusIndicators.tsx` 里的 `SkeletonBlock`（2.0s / 105° 倾斜扫光），
 * 颜色接 Mcode 语义 token。
 *
 * 上游与 Mcode 现有 `ui/spinner.tsx` 的 `Skeleton` 的区别：
 *  - 现有版是 Tailwind `animate-pulse`（整体透明度呼吸）；
 *  - 上游是**斜向扫光**（105° 线性渐变，RTL 下 255°），更接近 Claude 桌面端；
 *  - 两者都遵守减少动效总闸。
 *
 * 新组件不替换现有 `Skeleton`（它在大量面板里用着），供新壳与新面板使用；
 * 形状仍由调用方用 className 给（`h-4 w-40` 之类）。
 */
import { cn } from "@renderer/lib/cn.js";

export function CdsSkeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden data-cds-skeleton="" className={cn("cds-skeleton", className)} {...props} />;
}

/** 一组等高骨架行（列表加载时用，省得每个调用点写 map）。 */
export function CdsSkeletonRows({
  rows = 3,
  rowClassName,
  className,
}: {
  rows?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <CdsSkeleton key={i} className={cn("h-4 w-full", rowClassName)} />
      ))}
    </div>
  );
}
