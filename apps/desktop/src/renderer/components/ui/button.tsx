/**
 * Button — reusable button component.
 *
 * Built on @base-ui/react Button primitive + cva() variant management.
 *
 * @example
 *   <Button>Default</Button>
 *   <Button variant="primary" size="sm">Save</Button>
 *   <Button variant="danger" disabled>Delete</Button>
 */
import { forwardRef } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn.js";

const buttonVariants = cva(
  // Base styles
  // 【ARC-005】焦点可见环不在组件里写散装 ring 工具类：styles.css 的
  // `:where(button, …):focus-visible` 统一消费 `--focus-ring` 三层 token。
  // 组件自带的 ring 类特异性更高(0,2,0 > 0,1,0)，会静默盖掉 token 环。
  // 圆角也按 size 走角色档（--radius-btn-xs 6px / --radius-btn-md 8px，值来自
  // 上游 open-claude-ui，见 styles.css）；不再写 Tailwind 裸 `rounded`(4px) —
  // 那是与上游按钮档不一致的旧值。className 透传仍可覆盖（twMerge 后写赢）。
  // 【T128】基类不再写 `transition-colors`：`.cds-hover-ghost` 自带一条更完整的
  // 过渡（颜色 + 时长走 token + 按下时含 transform）。两处并存时后者会盖掉前者，
  // 而谁赢取决于类名在 class 串里的位置 —— 这种"隐式覆盖"正是要消掉的那类东西。
  "inline-flex items-center justify-center gap-1 font-medium select-none outline-none",
  {
    variants: {
      variant: {
        primary:
          "bg-accent-strong text-surface transition-colors hover:brightness-95 active:brightness-90 disabled:opacity-50 disabled:cursor-not-allowed",
        // 【T128】secondary / ghost / outline 三个变体走可复用的
        // `.cds-hover-ghost`（hover 与 active 分档），不再各写
        // `hover:bg-surface-hover`。那个类只做表现，尺寸与圆角仍由下面的
        // size 变体决定 —— 所以这里的类名合并顺序不影响形状。
        secondary:
          "cds-hover-ghost bg-surface-muted text-content-muted hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
        ghost:
          "cds-hover-ghost text-content-muted hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
        danger:
          "text-danger transition-colors hover:bg-danger/10 active:bg-danger/20 disabled:opacity-50 disabled:cursor-not-allowed",
        outline:
          "cds-hover-ghost border border-edge bg-surface text-content-muted hover:text-content disabled:opacity-50 disabled:cursor-not-allowed",
      },
      size: {
        sm: "h-6 rounded-[var(--radius-btn-xs)] px-2 text-[11px]",
        md: "h-8 rounded-[var(--radius-btn-md)] px-3 text-xs",
        icon: "h-6 w-6 rounded-[var(--radius-btn-xs)] p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  },
);

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<typeof BaseButton>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <BaseButton
        ref={ref}
        // 【ARC-005】variant 落到 DOM：styles.css 的危险焦点环选择器是
        // `button[data-variant="danger"]` —— 不写这个属性它永远匹配不到。
        data-variant={variant ?? "secondary"}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
