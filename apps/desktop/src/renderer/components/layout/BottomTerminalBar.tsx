import { cn } from "@renderer/lib/cn.js";
import { TerminalPanel } from "@renderer/components/ide/TerminalPanel.js";

/**
 * Bottom-bar terminal host.
 *
 * Replaces the terminal that used to be a tab in the right panel — the fixed
 * 360px sidebar was too narrow for a usable terminal, so it moved to a wider
 * bottom bar scoped to the center pane's width.
 *
 * This component is always mounted (the parent keep-alives it by collapsing
 * its height to 0 instead of unmounting). `active` flows down to TerminalPanel
 * → TerminalView, which uses it to decide whether to fit/focus: when the bar
 * is collapsed the PTYs and scrollback stay alive but fit calls are skipped
 * (TerminalView guards on `active` and swallows fit errors from a zero-size
 * host); when it expands again, the `active` flip re-fits and focuses.
 */
export function BottomTerminalBar({ active }: { active: boolean }) {
  return (
    <div
      data-cds="BottomTerminalBar"
      className={cn(
        "flex h-full min-h-0 flex-col border-t border-edge bg-surface",
        // Keep the DOM mounted even when collapsed so PTYs survive, but hide
        // visually so nothing bleeds into the chat area above while hidden.
        // ⚠️ 折叠靠**父级给 0 高度**（见 ThreePaneLayout / ClaudeShell 的包装层），
        // 本组件始终 `h-full` —— 直接放进 flex-col 会吃掉全部剩余高度。
        !active && "invisible",
      )}
      aria-hidden={!active}
      inert={!active}
    >
      <TerminalPanel active={active} />
    </div>
  );
}
