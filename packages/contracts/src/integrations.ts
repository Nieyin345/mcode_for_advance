/**
 * 外部服务集成 —— 「自带 API Key」。
 *
 * ## 为什么是一张目录,而不是一个个写死的设置项
 *
 * 用户明确说了「未来可能会有更多的功能集成进来」。所以这里是一张**供应商目录**
 * (CATALOG) + 一份**加密密钥**:
 *
 *   加一个新集成 = 往 CATALOG 加一条 + 写一个 client 模块 + 补两处 i18n
 *
 * 设置面板从 CATALOG 渲染,不认得当体是哪家 —— 所以加东西不用改界面。
 *
 * ## 密钥怎么存
 *
 * 与自定义模型那条路**完全一致**(见 main/lib/secretStore.ts):
 * 非密钥的元数据(是否启用 / base url / 上次测试结果)存 settings 的一个 JSON 键,
 * 密钥用 safeStorage(Windows DPAPI / macOS Keychain)加密后存另一个键。
 * **明文永不落盘,也永不跨 IPC** —— 出去的一律是打码后的 `keyMasked`。
 */

/**
 * 已接入的集成。加新的往这里加 id —— 类型、目录、界面会跟着走。
 *
 * ⚠️ EasyScholar(期刊分区)不在这里:它的开放接口文档是前端渲染的、第三方封装也
 * 拿不到确切的请求格式,没有把握就不往外发不通的代码。目录结构已经为它留好位置,
 * 拿到文档后加一条即可。
 */
export const INTEGRATION_IDS = ["mineru"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** 这个集成能拿来做的那件事。消费方按用途找集成,而不是按供应商名字。 */
export type IntegrationPurpose = "pdf-to-markdown" | "journal-rank";

export interface IntegrationCatalogEntry {
  id: IntegrationId;
  purpose: IntegrationPurpose;
  /** 默认 API 根地址。用户可在设置里覆盖 —— 自建反代、或者官方换了域名。 */
  defaultBaseUrl: string;
  /** 去哪拿密钥(设置面板里给个链接)。 */
  keyUrl: string;
}

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    id: "mineru",
    purpose: "pdf-to-markdown",
    defaultBaseUrl: "https://mineru.net",
    keyUrl: "https://mineru.net/apiManage/docs",
  },
];

/** 最近一次连通性测试的结果。 */
export interface IntegrationTestResult {
  ok: boolean;
  /** 人话说明(成功/失败原因),直接显示给用户。 */
  message: string;
  at: number;
}

/** 跨 IPC 的投影 —— 不含密钥明文。 */
export interface IntegrationPublic {
  id: IntegrationId;
  /** 是否已存过密钥。 */
  configured: boolean;
  enabled: boolean;
  /** 实际生效的 base url(用户没覆盖就是目录里的默认值)。 */
  baseUrl: string;
  /** 打码后的密钥,仅供展示。 */
  keyMasked: string;
  lastTest: IntegrationTestResult | null;
}

/** 生成设置面板要显示的打码串。和自定义模型那边保持同一种观感。 */
export function maskKey(cleartext: string): string {
  if (!cleartext) return "";
  if (cleartext.length <= 8) return "•".repeat(cleartext.length);
  return `${cleartext.slice(0, 4)}${"•".repeat(Math.min(12, cleartext.length - 8))}${cleartext.slice(-4)}`;
}
