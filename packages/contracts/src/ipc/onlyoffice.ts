/**
 * OnlyOffice Document Server 集成 —— Office 文档（docx / xlsx / pptx…）的**可视化编辑**。
 *
 * ## 为什么是它（2026-09-27 用户拍板）
 *
 * 用户要「和在 Office 里打开一样的效果」。纯前端方案里没有一个能做到（pptx 尤其），
 * 而 OnlyOffice Docs 是开源（AGPL）里保真度唯一到 Office 级的，三种格式一套引擎。
 * 代价是它是一个**独立服务**（Document Server），要用户在本机装一份（Windows 安装包
 * 或 Docker），Mcode 只负责把编辑器嵌进来、把文件递给它、把它存回来的文件写回磁盘。
 *
 * ## 数据怎么流
 *
 *   渲染端 ──onlyoffice.open──▶ 主进程：起一个本机 HTTP 桥（随机端口），发一条
 *   一次性令牌，拼好 DocEditor 的 config（带 JWT）
 *   渲染端加载 `<serverUrl>/web-apps/apps/api/documents/api.js`，`new DocsAPI.DocEditor`
 *   Document Server ──GET  /file/<token>────▶ 主进程：交出文件字节
 *   Document Server ──POST /callback/<token>▶ 主进程：status 2/6 时下载它给的 url，
 *                                              原子写回原路径
 *
 * 所以 Document Server **必须能访问到这台机器**：本机安装的用 `127.0.0.1` 就行；
 * Docker 里的要走宿主机的局域网 IP（或 `host.docker.internal`），并且 DS 默认**拒绝
 * 请求私网地址**（`allowPrivateIPAddress`），得在它那边放开 —— 见 `docs/onlyoffice.md`。
 */
import { z } from "zod";

/** 设置表里的 key。值是 `OnlyOfficeConfig` 的 JSON。 */
export const ONLYOFFICE_CONFIG_SETTING_KEY = "onlyoffice.config";

export const OnlyOfficeConfigSchema = z.object({
  /** Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。 */
  serverUrl: z.string().default(""),
  /** JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。 */
  jwtSecret: z.string().default(""),
  /**
   * DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是本机地址就用 `127.0.0.1`，
   * 否则取第一块非内部 IPv4 网卡地址。Docker Desktop 里的 DS 常需要手填 `host.docker.internal`。
   */
  callbackHost: z.string().default(""),
});
export type OnlyOfficeConfig = z.infer<typeof OnlyOfficeConfigSchema>;

export const DEFAULT_ONLYOFFICE_CONFIG: OnlyOfficeConfig = {
  serverUrl: "",
  jwtSecret: "",
  callbackHost: "",
};

/** 解析设置表里存的 JSON；坏的 / 缺的一律回默认值（显式报出来没有意义 —— 它只是"没配"）。 */
export function parseOnlyOfficeConfig(raw: string | null | undefined): OnlyOfficeConfig {
  if (!raw) return { ...DEFAULT_ONLYOFFICE_CONFIG };
  try {
    return OnlyOfficeConfigSchema.parse(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ONLYOFFICE_CONFIG };
  }
}

/**
 * DS 能**编辑**的扩展名 → 它的 `documentType`。
 *
 * 老格式（doc / xls / ppt / rtf）DS 只能转换后**查看**，不在这张表里 —— 那些仍走
 * "不支持"提示。要编辑先另存为 OOXML。
 */
export const ONLYOFFICE_EDITABLE: Readonly<Record<string, "word" | "cell" | "slide">> = {
  docx: "word",
  docm: "word",
  dotx: "word",
  odt: "word",
  xlsx: "cell",
  xlsm: "cell",
  xltx: "cell",
  ods: "cell",
  pptx: "slide",
  pptm: "slide",
  potx: "slide",
  odp: "slide",
};

/** 路径是否是 DS 能编辑的 Office 文档（按扩展名，大小写不敏感）。 */
export function isOnlyOfficeEditablePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return filePath.slice(dot + 1).toLowerCase() in ONLYOFFICE_EDITABLE;
}

/* ── IPC 输入 / 输出 ── */

export const OnlyOfficeOpenSchema = z.object({
  /** 绝对路径。必须落在某个已知工作区根内（与 `file:readFile` 同一道闸）。 */
  filePath: z.string(),
});
export type OnlyOfficeOpenInput = z.infer<typeof OnlyOfficeOpenSchema>;

export interface OnlyOfficeOpenResult {
  ok: boolean;
  /** 失败原因（未配置 / 路径越界 / 不支持的类型 / 桥起不来）。 */
  error?: string;
  /** 未配置 DS 时为 true —— 渲染端据此画"去设置"而不是"出错了"。 */
  notConfigured?: boolean;
  /** `<serverUrl>/web-apps/apps/api/documents/api.js` */
  apiScriptUrl?: string;
  /** 本次编辑会话的 id（= document.key）。forceSave / close / state 都按它寻址。 */
  sessionKey?: string;
  /** 直接交给 `new DocsAPI.DocEditor(el, config)` 的对象（已带 token）。 */
  config?: Record<string, unknown>;
}

export const OnlyOfficeSessionSchema = z.object({ sessionKey: z.string() });
export type OnlyOfficeSessionInput = z.infer<typeof OnlyOfficeSessionSchema>;

export interface OnlyOfficeSessionState {
  /** 会话还在（关掉后主进程会把它清掉）。 */
  alive: boolean;
  /** 最近一次成功写回磁盘的时间（ms）。null = 这次会话还没存过。 */
  lastSavedAt: number | null;
  /** 最近一次回调 / 写回失败的原因。成功一次就清掉。 */
  lastError: string | null;
  /** DS 最近一次回调的 status 码（1 编辑中 / 2 待保存 / 4 无改动关闭 / 6 强制保存…）。 */
  lastStatus: number | null;
}

export interface OnlyOfficeStatusResult {
  configured: boolean;
  /** 能否 GET 到 `<serverUrl>/healthcheck`（DS 返回字面量 `true`）。 */
  reachable: boolean;
  error?: string;
  serverUrl: string;
}

export const OnlyOfficeSetConfigSchema = OnlyOfficeConfigSchema;
export type OnlyOfficeSetConfigInput = z.infer<typeof OnlyOfficeSetConfigSchema>;

/* ───────────── 本机安装（Windows 安装包，不走 Docker）───────────── */

/** `onlyoffice:detectLocal`：本机有没有装 OnlyOffice Docs、跑没跑、密钥是什么。 */
export interface OnlyOfficeLocalDetectResult {
  /** 只有 Windows 有官方安装包；其他平台一律 false（面板隐藏"一键安装"）。 */
  supported: boolean;
  installed: boolean;
  installDir: string | null;
  version: string | null;
  serviceState: "running" | "stopped" | "unknown";
  /** healthcheck 探通的端口；服务没跑 / 探不到 = null。 */
  port: number | null;
  /** `config\local.json` 里的 inbox 密钥（安装器随机生成）。 */
  jwtSecret: string | null;
  tokenEnabled: boolean | null;
  /** `request-filtering-agent.allowPrivateIPAddress` —— false 时 DS 回连不到本机桥。 */
  privateIpAllowed: boolean | null;
  suggestedServerUrl: string | null;
}

export type OnlyOfficeInstallPhase =
  | "idle"
  | "downloading"
  | "installing"
  | "configuring"
  | "waiting"
  | "done"
  | "error"
  | "cancelled";

export interface OnlyOfficeInstallProgress {
  phase: OnlyOfficeInstallPhase;
  receivedBytes: number;
  totalBytes: number | null;
  /** error 时的原因码/文本（`UAC_DENIED` / `CANCELLED` / `DS_NOT_RESPONDING` / 其他）。 */
  message: string | null;
  startedAt: number | null;
}

export const OnlyOfficeInstallSchema = z.object({
  /** 安装器 `/DS_PORT`。默认 8080（80 常被 IIS / 其他东西占着）。 */
  port: z.number().int().min(1).max(65535).default(8080),
});
export type OnlyOfficeInstallInput = z.infer<typeof OnlyOfficeInstallSchema>;
