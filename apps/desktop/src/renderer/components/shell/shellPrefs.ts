/**
 * 【ARC-005 V1】界面外壳偏好 `ui.shell` 的 renderer 侧单一事实源。
 *
 * 与 `ui.chatDensity` 同一条设置流水线,只是把「默认值 + 防卫式解析」收进这个
 * 叶子模块,避免 store 与将来的 `WorkspaceShell` 各写一份:
 *   1. 契约键 / zod schema:`@contracts/ipc` 的 `settings.ts`
 *      (`UI_SHELL_SETTING_KEY` / `ShellPreferenceSchema`);
 *   2. 首屏水合 + setter:`stores/sessionStore.ts`(`init()` 的批量 getMany,
 *      写回走 `setShellPref` → `setting.set`);
 *   3. 设备本地键:`@contracts/ipc/settingsSync` 的 `DEVICE_LOCAL_SETTING_KEYS`
 *      —— 外壳形态跟屏幕走,手机网页壳不会覆盖桌面的选择;
 *   4. 消费端(本文件):默认值 + `parseShellPref`。
 *
 * 本模块只 import 契约(叶子),store 反过来 import 它 —— 没有环。
 *
 * **硬约束**:任何取值都只决定「用哪个壳来摆放」,永远不许卸载工作区子树
 * (终端 PTY / Monaco / 草稿保活);壳切换是重新摆放,不是三元切换。V1 只铺
 * 偏好与 ClassicShell 的抽离,`"workspace"` 壳尚未实装 —— App 目前无论取值
 * 都渲染 ClassicShell。
 */
import {
  ShellPreferenceSchema,
  UI_SHELL_SETTING_KEY,
  type ShellPreference,
} from "@contracts/ipc";

export { UI_SHELL_SETTING_KEY };
export type { ShellPreference };

/** 未设置 / 无法识别时的外壳。`"classic"` 保证老用户升级后外观零变化。 */
export const DEFAULT_SHELL_PREF: ShellPreference = "classic";

/**
 * 把设置表里的原始字符串解析成外壳偏好。缺行、空串、坏值(例如手持设备
 * 写入门户留下的脏数据)一律回落到默认值 —— 与 `parseAutoArchiveConfig`
 * 的「坏值不炸、退回默认」同一规矩。
 */
export function parseShellPref(raw: string | null | undefined): ShellPreference {
  const parsed = ShellPreferenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SHELL_PREF;
}
