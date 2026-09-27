/**
 * 设置在「桌面 ⇄ 手机浏览器」之间怎么同步 —— 三张表,各管一件事。
 *
 * 设置表只有一份(桌面那台机器上的 sqlite),手机网页壳经 RPC 读写同一份表。
 * 不分类的话:手机上换个字号 / 打开一个对话,桌面下次启动就跟着变 —— 用户
 * 要的是(2026-09-27)「账号级的偏好两边实时同步,和屏幕有关的偏好各管各的」。
 *
 *  - {@link DEVICE_LOCAL_SETTING_KEYS}:**跟着屏幕走**。网页壳把这些键存在
 *    手机浏览器自己的 localStorage 里,根本不发给桌面(见 `renderer/lib/webApi.ts`
 *    的 setting 实现);桌面照旧写设置表。两边互不覆盖。
 *  - {@link SYNCED_SETTING_KEYS}:**跟着人走**。任一端写入后,主进程广播一条
 *    `setting.changed`,另一端的 store 当场套用(见 sessionStore 的
 *    `applySyncedSetting`)。不在表里的共享键仍然存同一份表,只是不实时推
 *    (例如 `ui.composerModel`:另一端正在选模型时被推过来改掉反而添乱)。
 *  - {@link isMobileAccessibleSettingKey}:**手机能碰哪些键**。设置表里还躺着
 *    配对令牌、中继 VPS 配置、公网 MCP 密钥、浏览器 cookie 库、MCP / LSP /
 *    终端 shell 配置、工作流安全审查记录……一个配对过的手机不该读到也不该改到。
 *    手机 RPC 的 `setting:*` 只放行白名单(见 `main/mobile/mobileRpc.ts`)。
 */
import {
  AUTO_ARCHIVE_SETTING_KEY,
  DISPLAY_MODE_SETTING_KEY,
  LEFTBAR_MODE_SETTING_KEY,
  PROJECT_COLORS_SETTING_KEY,
  SEARCH_FILE_TYPES_SETTING_KEY,
  SESSION_WORKTREE_DEFAULT_SETTING_KEY,
  TAB_BAR_MULTI_ROW_SETTING_KEY,
  THEME_STYLE_SETTING_KEY,
  UI_ACCENT_COLOR_SETTING_KEY,
  UI_CHAT_DENSITY_SETTING_KEY,
  UI_CHAT_FONT_SIZE_SETTING_KEY,
  UI_COMMIT_GEN_MODEL_SETTING_KEY,
  UI_COMMIT_GEN_PROMPT_SETTING_KEY,
  UI_COMPOSER_MODEL_SETTING_KEY,
  UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
  UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
  UI_EDITOR_THEME_SETTING_KEY,
  UI_GESTURES_SETTING_KEY,
  UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
  UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
  UI_IDE_ACTIVE_FILE_SETTING_KEY,
  UI_IDE_EDITOR_MODE_SETTING_KEY,
  UI_IDE_EXPANDED_DIRS_SETTING_KEY,
  UI_IDE_OPEN_FILES_SETTING_KEY,
  UI_LAST_PROJECT_SETTING_KEY,
  UI_LAST_SESSION_SETTING_KEY,
  UI_LOCALE_SETTING_KEY,
  UI_PANE_WIDTHS_SETTING_KEY,
  UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
  UI_PROJECT_GROUPS_SETTING_KEY,
  UI_PROJECT_VIEW_SETTING_KEY,
  UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
  UI_RIGHT_PANEL_TAB_SETTING_KEY,
  UI_SHORTCUTS_SETTING_KEY,
  UI_STREAM_SCOPE_SETTING_KEY,
  UI_TITLE_GEN_ENABLED_SETTING_KEY,
  UI_TITLE_GEN_MODEL_SETTING_KEY,
  UI_USER_MSG_COLOR_SETTING_KEY,
  UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY,
  UI_VOICE_ENGINE_SETTING_KEY,
  UI_VOICE_LANG_SETTING_KEY,
  UI_VOICE_MIC_PERMISSION_SETTING_KEY,
  UI_VOICE_MODEL_DIR_SETTING_KEY,
  UI_VOICE_MODEL_SETTING_KEY,
  WORKFLOW_MAX_PARALLEL_SETTING_KEY,
  WORKFLOW_NODE_PREFS_SETTING_PREFIX,
  WORKTREE_NAMES_SETTING_KEY,
} from "./settings.js";
import { AGENT_OUTPUT_STYLE_SETTING_KEY } from "./skills.js";

/** 工作流看板上流程图区域的高度(`WorkflowBoardPanel` 拖出来的那条分隔线)。
 *  原先只在那个组件里当局部常量;挪到这里是因为它要进「跟着屏幕走」的表。 */
export const UI_WORKFLOW_BOARD_FLOW_HEIGHT_SETTING_KEY = "ui.workflowBoard.flowHeight";

/** 跟着屏幕走:显示模式、布局、字号、密度、「上次打开的是哪个」、编辑器
 *  打开的文件、语音(麦克风权限 / 本地模型本来就是每台设备各自的)。 */
export const DEVICE_LOCAL_SETTING_KEYS: readonly string[] = [
  DISPLAY_MODE_SETTING_KEY,
  TAB_BAR_MULTI_ROW_SETTING_KEY,
  LEFTBAR_MODE_SETTING_KEY,
  UI_CHAT_FONT_SIZE_SETTING_KEY,
  UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
  UI_CHAT_DENSITY_SETTING_KEY,
  UI_PANE_WIDTHS_SETTING_KEY,
  UI_LAST_PROJECT_SETTING_KEY,
  UI_LAST_SESSION_SETTING_KEY,
  UI_STREAM_SCOPE_SETTING_KEY,
  UI_RIGHT_PANEL_TAB_SETTING_KEY,
  UI_IDE_OPEN_FILES_SETTING_KEY,
  UI_IDE_ACTIVE_FILE_SETTING_KEY,
  UI_IDE_EXPANDED_DIRS_SETTING_KEY,
  UI_IDE_EDITOR_MODE_SETTING_KEY,
  UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
  UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
  UI_VOICE_LANG_SETTING_KEY,
  UI_VOICE_ENGINE_SETTING_KEY,
  UI_VOICE_MIC_PERMISSION_SETTING_KEY,
  UI_VOICE_MODEL_SETTING_KEY,
  UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY,
  UI_VOICE_MODEL_DIR_SETTING_KEY,
  UI_WORKFLOW_BOARD_FLOW_HEIGHT_SETTING_KEY,
];

/** 跟着人走、并且**写了就实时推给另一端**的键。 */
export const SYNCED_SETTING_KEYS: readonly string[] = [
  UI_LOCALE_SETTING_KEY,
  THEME_STYLE_SETTING_KEY,
  UI_ACCENT_COLOR_SETTING_KEY,
  UI_USER_MSG_COLOR_SETTING_KEY,
  UI_EDITOR_THEME_SETTING_KEY,
  AGENT_OUTPUT_STYLE_SETTING_KEY,
  UI_TITLE_GEN_ENABLED_SETTING_KEY,
  UI_TITLE_GEN_MODEL_SETTING_KEY,
  UI_COMMIT_GEN_MODEL_SETTING_KEY,
  UI_COMMIT_GEN_PROMPT_SETTING_KEY,
  UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
  WORKFLOW_MAX_PARALLEL_SETTING_KEY,
  UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
  PROJECT_COLORS_SETTING_KEY,
  UI_PROJECT_GROUPS_SETTING_KEY,
  UI_PROJECT_VIEW_SETTING_KEY,
  WORKTREE_NAMES_SETTING_KEY,
  UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
  AUTO_ARCHIVE_SETTING_KEY,
  UI_GESTURES_SETTING_KEY,
  UI_SHORTCUTS_SETTING_KEY,
  SESSION_WORKTREE_DEFAULT_SETTING_KEY,
];

const DEVICE_LOCAL_SET: ReadonlySet<string> = new Set(DEVICE_LOCAL_SETTING_KEYS);
const SYNCED_SET: ReadonlySet<string> = new Set(SYNCED_SETTING_KEYS);

export function isDeviceLocalSettingKey(key: string): boolean {
  return DEVICE_LOCAL_SET.has(key);
}

export function isSyncedSettingKey(key: string): boolean {
  return SYNCED_SET.has(key);
}

/** 手机 RPC 额外放行、但不实时推的共享键(另一端下次读取时自然拿到)。 */
const MOBILE_EXTRA_KEYS: ReadonlySet<string> = new Set([
  UI_COMPOSER_MODEL_SETTING_KEY,
  SEARCH_FILE_TYPES_SETTING_KEY,
]);

/** 手机 RPC 放行的键前缀 —— 只有「按 id 分键」的那几族,且逐族点名。
 *  ⚠️ 别图省事放宽成 `workflow.` / `ui.`:`workflow.review.v1.<id>` 是工作流
 *  安全审查记录(`main/orchestration/workflowTrust.ts`),能写它就能把没审过的
 *  流程标成已审。 */
const MOBILE_KEY_PREFIXES: readonly string[] = [WORKFLOW_NODE_PREFS_SETTING_PREFIX];

/**
 * 手机(网页壳,经配对令牌)能不能读写这个设置键。
 *
 * 放行 = 同步表 ∪ 少数共享键 ∪ `workflow.nodePrefs.<id>`。设备本地表**不**
 * 放行:网页壳把它们存在 localStorage,正常路径根本不会发过来;语音模型目录
 * 这类键在主进程里还连着文件下载路径,更不能让手机改。
 */
export function isMobileAccessibleSettingKey(key: string): boolean {
  if (SYNCED_SET.has(key) || MOBILE_EXTRA_KEYS.has(key)) return true;
  return MOBILE_KEY_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}
