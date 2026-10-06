import type { PermissionMode } from "@contracts/runtime";
import type { PermissionModeOption } from "@contracts/provider";

/** Pi's read-only built-in tools — safe to auto-approve in every mode. */
const PI_READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Pi 的权限模式,composer 下拉里展示的就是这几档。
 *
 * Pi 没有原生权限系统 —— 这些档位由 inline extension 的 `tool_call` 处理器在运行时
 * 解释(见下面的 {@link shouldAutoApproveForPi})。
 *
 * 放在这个叶模块而不是 provider 里,是为了让回归测试能只引这一份常量:引 provider
 * 会把 Pi SDK、扩展、模型仓库整串拖进无头 smoke。
 *
 * `dontAsk` 有实现(只读 + 「始终允许」放行,其余由扩展 block),所以暴露。
 * `auto` **不暴露** —— Claude 的那个 auto 是把模式交给 SDK,由 CLI 的模型分类器判定;
 * Pi 没有这套东西,真报了只会让用户选到一个"看着智能、实际退化成更保守"的档,正是
 * supportsFork 注释警告的那类假菜单项。
 */
export const PI_PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
  { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
  { value: "dontAsk", label: "Don't Ask", icon: "shieldHalf", color: "text-warning", hint: "不弹审批:只跑已批准(「始终允许」)与只读操作,其余直接拒绝" },
  { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
];

/**
 * Decide whether a Pi tool may skip host approval. `planModeActive` is
 * provided separately from the persisted permission mode because EnterPlanMode
 * updates it synchronously; the UI-backed permission value can lag one tool
 * call behind. `alwaysAllowed` is a per-session user decision, but plan mode
 * deliberately requires fresh approval for each mutating operation.
 */
export function shouldAutoApproveForPi(
  mode: PermissionMode | undefined,
  toolName: string,
  planModeActive = false,
  alwaysAllowed = false,
): boolean {
  if (PI_READONLY_TOOLS.has(toolName)) return true;
  // EnterPlanMode flips this synchronous per-turn flag before the next tool
  // call. It overrides stale UI permission state and saved allow rules so
  // every mutation still receives a fresh host approval.
  if (planModeActive) return false;
  if (!mode) return alwaysAllowed;
  if (mode === "bypassPermissions") return true;
  // dontAsk 不是放行档:只读(上面已放行)与「alwaysAllowed」之外的都不自动放行,
  // 由调用方在弹审批之前拒掉(见 mcodeExtension.ts ⑥ 之前那一段)。
  if (mode === "acceptEdits") return toolName === "write" || toolName === "edit";
  return alwaysAllowed;
}
