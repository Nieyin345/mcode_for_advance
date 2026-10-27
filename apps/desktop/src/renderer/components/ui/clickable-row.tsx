/**
 * 【MC-049】可点击**行**的键盘激活包装 —— 一处分发，多处复用。
 *
 * ## 它补的是哪条洞
 *
 * 名单/历史/流程节点这类"整行可点"的地方常用 `<div onClick={…}>`:鼠标能用,
 * **键盘不行** —— div 不可聚焦、没有 Enter/Space 激活语义,屏幕阅读器也不知道
 * 它是个控件。给每处手填 `tabIndex/role/onKeyDown` 三件套最容易漏、也最容易
 * 各自漂开(仓库硬规矩 2),所以收成一个组件。
 *
 * ## 为什么不用 `<button>`
 *
 * 这些行里有**嵌套子操作**(删除按钮、开关)与自定义内部布局;`<button>` 嵌
 * `<button>` 是非法 HTML,点击还会冒到外层。这里用 `role="button"` +
 * `tabIndex=0` + Enter/Space 映射,并把嵌套子控件保持为独立可聚焦点 —— 外层
 * 只在自己**就是事件目标**时激活(`e.target === e.currentTarget` 只在子控件
 * 不吞事件时成立;更可靠的是子控件自己在 click 上 stopPropagation)。
 *
 * ## 用法
 *
 * ```tsx
 * <ClickableRow onClick={open} className="flex …">
 *   …内容…
 *   <button onClick={(e) => { e.stopPropagation(); remove(); }}>删</button>
 * </ClickableRow>
 * ```
 *
 * 嵌套子控件**必须**在自己的 onClick 里 `stopPropagation()`,否则点删除会连带
 * 触发整行打开 —— 有测试守着这条(见各调用点所在的 smoke)。
 */
import type { CSSProperties, FocusEventHandler, MouseEventHandler, ReactNode } from "react";

export function ClickableRow({
  onClick,
  children,
  className,
  title,
  style,
  disabled = false,
  /** Override sequential keyboard focus order for virtualized roving-focus lists. */
  tabIndex = 0,
  /** 渲染成什么标签。默认 `div`;列表行用 `li` 保住 `ul > li` 结构。 */
  as: Tag = "div",
  /** 输入框 blur 保持(`onMouseDown preventDefault`)这类宿主行为原样透传。 */
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  /** 焦点事件也透传 —— hover 卡这类"聚焦要等价于悬停"的宿主行为需要它。 */
  onFocus,
  onBlur,
  /** 无障碍名。整行内容可读时可省(子文本即名字);纯图标行必须给。 */
  "aria-label": ariaLabel,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
  style?: CSSProperties;
  disabled?: boolean;
  tabIndex?: number;
  as?: "div" | "li";
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
  "aria-label"?: string;
}) {
  return (
    <Tag
      role="button"
      tabIndex={disabled ? -1 : tabIndex}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      title={title}
      style={style}
      className={className}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (disabled) return;
        // Enter 与 Space 都激活 —— 与原生 button 同一条语义(Space 要吞掉默认滚动)。
        if (e.key === "Enter" || e.key === " ") {
          if (e.target !== e.currentTarget) return; // 焦点在嵌套子控件上时不动它
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </Tag>
  );
}
