/**
 * 设置导入 / 导出(R39)。
 *
 * 导出的是 settings 表里「跟着人走的偏好」—— 外观、快捷键、手势、自定义 UI、通知、
 * 标题生成、提交信息模板、工作流并发……换一台电脑导进去就是熟悉的样子。
 *
 * **绝不导出的**:
 *  - 密钥类:API Key、令牌、密码、cookie、公网 MCP 密钥、手机配对设备、隧道 token。
 *    按 key 名拦,再对 JSON 值做一遍深度清洗(值里嵌着 `apiKey` / `env.OPENAI_API_KEY`
 *    这类字段的整条删掉)。模型供应商配置(含 Key)根本不在这张表里,也不会带上。
 *  - 本机状态:数据目录、上次打开的会话 / 文件、浏览历史、按项目 id 存的东西(换台电脑
 *    项目 id 对不上)、资料库内部结构、更新状态、自动化运行链路。
 *
 * 导入时同一套规则再过一遍(文件可能是手改的),只写允许的键;写之前先把当前设置
 * 备份一份到 `<userData>/settings-backups/`,导坏了能找回来。
 *
 * 这个文件不碰 Electron,方便单测;对话框和写盘在 `ipc/settingsTransfer.ts`。
 */

import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";

export const SETTINGS_EXPORT_FORMAT = "mcode-settings";
export const SETTINGS_EXPORT_VERSION = 1;

/** key 名里出现这些片段就当密钥,不导出也不导入。 */
const SECRET_KEY_RE =
  /(api[-_.]?key|apikey|token|secret|password|passwd|credential|cookie|authorization|private[-_.]?key|paireddevices|passwordlogin|\.enc$)/i;

/** 精确排除的键(本机路径 / 运行状态 / 含密钥的整块配置)。 */
const EXCLUDED_KEYS = new Set<string>([
  "app.dataRoot",
  "browser.dataDir",
  "browser.screenshotDir",
  "browser.addressHistory",
  "browser.persistLogin",
  "ui.voiceModelDir",
  "ui.voiceDownloadedModels",
  "ui.voiceMicPermission",
  "worktree.root",
  "worktree.names",
  "update.state",
  "ui.lastProjectId",
  "ui.lastSessionId",
  "ui.ideOpenFiles",
  "ui.ideActiveFile",
  "ui.ideExpandedDirs",
  "ui.gitCollapsedRepos",
  "ui.customCommandsByProject",
  "ui.projectGroups",
  "project.colors",
  "relay.vpsConfig",
  "onlyoffice.config",
  "mobile.enabled",
  "mobile.port",
  "mobile.tunnel.autostart",
  "mobile.tunnel.hostname",
  "mobile.tunnel.mode",
  "publicMcp.enabled",
  "publicMcp.fixedPort",
  "publicMcp.projectId",
  "publicMcp.sessionId",
  "publicMcp.projectLinks",
  "publicMcp.agentDelegate",
  "publicMcp.delegateSessionId",
  "publicMcp.delegateSessions",
  "publicMcp.mobileHostname",
  "publicMcp.tunnelHostname",
  "publicMcp.tunnelMode",
]);

/** 按前缀排除(一族状态键)。 */
const EXCLUDED_PREFIXES = [
  "library.",
  "automation.eventChain.",
  "automation.state.",
  "mobile.",
  "publicMcp.",
  "relay.",
  "browser.cookieVault",
  "session.lastModel.",
  "migration.",
  "internal.",
];

export function isTransferableSettingKey(key: string): boolean {
  if (!key || key.length > 200) return false;
  if (SECRET_KEY_RE.test(key)) return false;
  if (EXCLUDED_KEYS.has(key)) return false;
  return !EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
}

const SECRET_FIELD_RE =
  /^(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|auth[-_]?token|secret|client[-_]?secret|password|passwd|authorization|cookie|cookies|private[-_]?key)$|(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

/** 深度去掉值里像密钥的字段。返回 [清洗后的值, 删了几处]。 */
export function scrubSecrets(value: unknown, depth = 0): [unknown, number] {
  if (depth > 20 || value === null || typeof value !== "object") return [value, 0];
  if (Array.isArray(value)) {
    let n = 0;
    const out = value.map((v) => {
      const [c, k] = scrubSecrets(v, depth + 1);
      n += k;
      return c;
    });
    return [out, n];
  }
  let n = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(k)) {
      n += 1;
      continue;
    }
    const [c, m] = scrubSecrets(v, depth + 1);
    n += m;
    out[k] = c;
  }
  return [out, n];
}

/** 值是 JSON 就清洗后再序列化;不是 JSON 原样返回。 */
function scrubValue(raw: string): { value: string; scrubbed: number } {
  const t = raw.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return { value: raw, scrubbed: 0 };
  try {
    const [clean, n] = scrubSecrets(JSON.parse(t));
    return n > 0 ? { value: JSON.stringify(clean), scrubbed: n } : { value: raw, scrubbed: 0 };
  } catch {
    return { value: raw, scrubbed: 0 };
  }
}

export interface SettingsExportDoc {
  format: typeof SETTINGS_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  appVersion?: string;
  settings: Record<string, string>;
}

export function buildSettingsExport(
  all: Record<string, string | null>,
  meta: { appVersion?: string; now?: Date } = {},
): { doc: SettingsExportDoc; count: number; skipped: number; scrubbed: number } {
  const settings: Record<string, string> = {};
  let skipped = 0;
  let scrubbed = 0;
  for (const key of Object.keys(all).sort()) {
    const raw = all[key];
    if (raw === null || raw === undefined) continue;
    if (!isTransferableSettingKey(key)) {
      skipped += 1;
      continue;
    }
    const r = scrubValue(raw);
    scrubbed += r.scrubbed;
    settings[key] = r.value;
  }
  return {
    doc: {
      format: SETTINGS_EXPORT_FORMAT,
      version: SETTINGS_EXPORT_VERSION,
      exportedAt: (meta.now ?? new Date()).toISOString(),
      ...(meta.appVersion ? { appVersion: meta.appVersion } : {}),
      settings,
    },
    count: Object.keys(settings).length,
    skipped,
    scrubbed,
  };
}

/**
 * 别人给的设置文件里,自定义 UI 的「运行终端命令」项一律改回「运行前确认」—— 否则导入一份
 * 设置就等于多了几个点一下就静默跑命令的按钮。只动 `action.type === "shell"` 的 `confirm`,
 * 其余原样;解析不了就原样返回(读配置那一侧本来就会 coerce / 丢弃坏数据)。
 */
export function forceShellConfirm(raw: string): string {
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!cfg || typeof cfg !== "object") return raw;
  const items = (cfg as { items?: unknown }).items;
  if (!Array.isArray(items)) return raw;
  let changed = false;
  for (const it of items) {
    const action = it && typeof it === "object" ? (it as { action?: unknown }).action : undefined;
    if (action && typeof action === "object" && (action as { type?: unknown }).type === "shell" && "confirm" in action) {
      delete (action as { confirm?: unknown }).confirm;
      changed = true;
    }
  }
  return changed ? JSON.stringify(cfg) : raw;
}

export type ParsedSettingsImport =
  | { ok: true; entries: Array<[string, string]>; skipped: string[] }
  | { ok: false; error: string };

/** 解析 + 校验导入文件。只返回允许写的键;被挡下的键名放在 skipped 里给界面看。 */
export function parseSettingsImport(text: string): ParsedSettingsImport {
  let obj: unknown;
  try {
    obj = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { ok: false, error: `不是有效的 JSON:${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "文件内容不是 Mcode 设置导出文件" };
  const o = obj as Partial<SettingsExportDoc>;
  if (o.format !== SETTINGS_EXPORT_FORMAT) return { ok: false, error: "文件内容不是 Mcode 设置导出文件(缺少 format 标记)" };
  if (typeof o.version !== "number" || o.version > SETTINGS_EXPORT_VERSION) {
    return { ok: false, error: `导出文件版本(${String(o.version)})比当前 Mcode 支持的新,请先升级 Mcode` };
  }
  if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) {
    return { ok: false, error: "文件里没有 settings 字段" };
  }
  const entries: Array<[string, string]> = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(o.settings as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length > 2_000_000 || !isTransferableSettingKey(k)) {
      skipped.push(k);
      continue;
    }
    const clean = scrubValue(v).value;
    entries.push([k, k === CUSTOM_UI_SETTING_KEY ? forceShellConfirm(clean) : clean]);
  }
  if (entries.length > 5000) return { ok: false, error: "设置项数量异常(超过 5000 条)" };
  return { ok: true, entries, skipped };
}
