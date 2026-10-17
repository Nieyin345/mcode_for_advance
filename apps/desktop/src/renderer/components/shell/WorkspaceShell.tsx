/**
 * 【ARC-005 V2】**WorkspaceShell** —— 会话优先的 Claude 桌面风格外壳。
 *
 * ## 它和 ClassicShell 的关系(最关键的一条)
 *
 * **不是另一棵树。** `WorkspaceShell` 是 ClassicShell 的一个**变体摆放**:
 * 同一棵子树(左栏内容 + Titlebar + ThreePaneLayout + 终端 + 右栏 + Monaco)
 * 只换外层的尺寸/分隔线/圆角 class。
 *
 * ## 为什么必须是同一棵树
 *
 * 硬约束(见 ClassicShell 与 App 主注释):**终端 PTY / Monaco / Tiptap 草稿
 * 必须全程挂载**。如果 App 写成 `shell === "workspace" ? <WorkspaceShell/> :
 * <ClassicShell/>`,React 会把两个不同组件类型的子树整个卸载重建 ——
 * 所有 TerminalView 的 cleanup 会调 `api.terminal.kill`,Windows 上批量 kill
 * 偶发把主进程带崩;Monaco 与草稿也全部丢失。
 *
 * 所以切换点必须在**元素内部**:App 永远渲染同一个 `<ClassicShell variant=…>`。
 * `variant` 只影响 class 与 `hideLine`,组件实例、hook 顺序、store 订阅、
 * 子元素身份全部不变 —— 切壳是重排,不是切换树。
 *
 * ## V2 的视觉差异(全部落在 class 上)
 *
 * | 维度 | classic | workspace |
 * |---|---|---|
 * | 左栏宽度下限 | 无 | 240px(会话标题可读) |
 * | 左栏/主列分隔线 | 画线 | 不画线(`hideLine`,靠色阶差与圆角缺口分隔) |
 * | 左栏圆角 | `rounded-tl-3xl`(24px) | `rounded-tl-[10px]`(CDS 面板圆角) |
 *
 * 拖动热区、双击重置、宽度持久化在两个变体里走**同一组 props**(见
 * `ClassicShellProps`),不存在第二份实现。
 *
 * ## 本文件导出什么
 *
 * - `shellVariantOf(pref)` —— `ui.shell` 偏好 → 变体名(未知值回落 classic,
 *   真正的防御解析在 `shellPrefs.parseShellPref`,这里只做映射);
 * - `WorkspaceShell` —— 同义包装,便于测试/未来在没有 classic 的上下文里
 *   直接挂载;生产入口是 `ClassicShell` 的 `variant` prop。
 */
import { ClassicShell, type ClassicShellProps } from "./ClassicShell.js";
import type { ShellVariant } from "./shellPrefs.js";
import type { ShellPreference } from "@contracts/ipc";

export type { ShellVariant };

/**
 * `ui.shell` 偏好 → 布局变体。`"workspace"` 之外的一切(含坏值)都走 classic ——
 * 与 `DEFAULT_SHELL_PREF` 同一条"升级后外观零变化"的取舍。
 */
export function shellVariantOf(pref: ShellPreference | null | undefined): ShellVariant {
  return pref === "workspace" ? "workspace" : "classic";
}

/** 会话优先外壳的同义包装(生产由 `ClassicShell variant="workspace"` 承担;
 *  这个包装给测试与将来独立挂载用,仍共用同一份实现)。 */
export function WorkspaceShell(props: ClassicShellProps) {
  return <ClassicShell {...props} variant="workspace" />;
}
