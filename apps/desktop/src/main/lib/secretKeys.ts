/**
 * 【MC-004】「这个设置键是不是密钥本体」的**唯一判据** —— 全仓一份。
 *
 * ## 这里收的是什么
 *
 * 设置表(`mcode.db` 的 settings 键值)里躺着好几类**凭据本体**:自定义模型的 API Key
 * (safeStorage 密文或降级后的明文 base64)、SSH 中继的密码、OnlyOffice 的 JWT 签名
 * 密钥、公网 MCP 的路径密钥、手机配对令牌……
 *
 * ## 为什么必须是"一份"
 *
 * 同一件事从前在**三处**各写了一遍,而且**已经漂开**:
 *
 *  - `appControl/tools.ts` 的 `SECRET_SETTING_KEYS` + 两条正则(agent 读设置时按名拦);
 *  - `settings/settingsTransfer.ts` 的 `EXCLUDED_KEYS` + 两条正则(导出设置时按名剔);
 *  - `mobile/MobileHttpServer.ts` 的 `LAN_UNREADABLE_SETTING_KEYS`(局域网手机端不给读)。
 *
 * 实测的漂移:`tools.ts` 那条正则认 `cookieVault` 而 `settingsTransfer.ts` 那条认
 * `paireddevices` / `passwordlogin`;手机那份是两张硬编码的键集合。同一个键在这三处
 * **判据不一致**,加一个新密钥键就得记得改三处 —— 漏一处就是一条路能读、另一条路不给
 * 的怪状态(或者反过来:一条路漏出去了)。违反 README 硬规矩 5「共享实现只有一份」。
 *
 * ## 判据分三层(与 `secretSettingRefusal` 的同名注释一致)
 *
 *  1. **显式名单** {@link SECRET_SETTING_KEYS}:键名**完全不含**密钥词、但值里嵌着凭据的
 *     整块 JSON(`relay.vpsConfig`、`mcp.management` 这些)。按名兜底认不出它们,只能点名。
 *  2. **通用词** {@link SECRET_WORD_RE}:名字里带 `apiKey`/`token`/`secret`/`password`/
 *     `cookie` 这类词的键。宁可多拦一个,也不漏一个。
 *  3. **结构形状** {@link SECRET_STORE_RE}:`<某个东西>Keys/Tokens/Secrets/Credentials/
 *     Passwords` 结尾 —— 加密凭据 map 全仓都是这个形状(`customModelKeys`、`piProviderKeys`、
 *     `codexProviderKeys`、`publicMcp.*Secret`)。逐个往名单里加是追着漏,按形状一次挡住。
 *
 * ⚠️ **正则末尾的 `/i` 不能省**:名字是大小写敏感的字面量,但**判据**不该被大小写
 * 骗过去 —— 一个 `providerkeys` / `PROVIDERTOKENS` 得在三条路上被同样地拦住。
 *
 * ⚠️ **新增密钥键必须走这里**:如果你的键名恰好命中第 2 / 3 层就不必单列;否则加进
 * {@link SECRET_SETTING_KEYS}。三个消费方(`tools.ts` / `settingsTransfer.ts` /
 * `MobileHttpServer.ts`)全部从这里 import —— 改了这里就等于三处一起改。
 *
 * ## 哪些**不算**(别误伤)
 *
 * 「有没有配 / 连没连上 / 地址是什么」这类**摘要**不是密钥本体:`onlyoffice.status`、
 * `mobile.getStatus`、`git.status` 这些**方法**的返回体不含凭据(与 {@link SECRET_SETTING_KEYS}
 * 无关);设置键里 `app.dataRoot` / `ui.*` 这些是路径与偏好,照常可读可导出。
 *
 * 纯模块:不 import Electron、不读数据库 —— `tools.ts`(主进程)、`settingsTransfer.ts`
 * (无头可测)、`MobileHttpServer.ts`(HTTP 桥)与无头 smoke 都喂得进。
 */

/** 第 1 层:键名不含密钥词、但值是**整块含凭据的 JSON** 的设置键。 */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  // ── 加密凭据 map(键名是 `xxxKeys`,第 3 层也认;列在这里是**不许删**的显式保证)──
  /** 自定义模型的 `id → safeStorage 密文` 表。safeStorage 不可用的机器上是明文 base64。 */
  "customModelKeys",
  // ── 名字里一个密钥词都没有、值里却嵌着凭据的(2026-10-09 补的那批)──
  /** SSH 主机 + 用户 + **password**(见 `@contracts/relay` 的 `RelayVpsConfig`)。 */
  "relay.vpsConfig",
  /** 服务地址 + **JWT 签名密钥**(`jwtSecret`,能签发/伪造 OnlyOffice 令牌)。 */
  "onlyoffice.config",
  /** 每条项目链接的 `/mcp/<secret>` 明文密钥(见 `publicMcpSession.ts`)。 */
  "publicMcp.projectLinks",
  /** 已配对手机的 `{ deviceToken }`(bearer 令牌)。值现在恰好是 64 位十六进制、被
   *  "值的形态"那道偶然拦下,但那条判据依赖令牌恰好是这种编码 —— 按名钉死才稳。 */
  "mobile.pairedDevices",
  /** MCP 服务器的配置(每个 server 的 `env` / `headers`,常放 API key / Authorization)。 */
  "mcp.management",
  /** 手机远程登录的口令(scrypt 哈希 + 盐;哈希也是凭据材料,不给)。 */
  "mobile.passwordLogin",
]);

/** Case-fold the explicit list once, too: unlike /i regexes, Set.has does not
 * match e.g. ONLYOFFICE.CONFIG / PUBLICMCP.PROJECTLINKS. Those names carry
 * credentials but have none of the generic secret-key words. */
const CASE_FOLDED_SECRET_SETTING_KEYS = new Set(
  [...SECRET_SETTING_KEYS].map((key) => key.toLowerCase()),
);

/**
 * 判据只收**真密钥**。个别消费方可以在此基础上**更严**(这是策略分歧,不是判据漂移,
 * 但必须在消费方写明理由):
 *  - agent 读设置那条(`appControl/tools.ts`)还把 `customModels` 一起挡住 —— 它的值是
 *    公开元数据,**但**每条记录带的 `customHeaders` 常常就是网关鉴权头,而 read 侧的
 *    `redactValue` 只按字段名打码(脆弱);导出侧可以保持可导出,因为那边有深度清洗。
 */

/** 第 2 层:名字里带这些词就是密钥键。 */
const SECRET_WORD_RE =
  /(api[-_.]?keys?|apikeys?|tokens?|secrets?|passw(or)?ds?|credentials?|cookies?|cookievault|authorization|private[-_.]?keys?|paireddevices|passwordlogin|\.enc$)/i;

/** 第 3 层:`<某个东西>+Keys/Tokens/Secrets/Credentials/Passwords` 收尾的结构性名字。 */
const SECRET_STORE_RE = /(Keys|Tokens|Secrets|Credentials|Passwords)$/i;

/**
 * 这个设置键是不是「密钥本体」—— 不许经 `setting.get*` 读给模型、不许随设置导出 /
 * 导入、不许经局域网 HTTP 桥读写。
 *
 * 三层任一命中即真;空串与非字符串一律 false(调用方自己判输入合法性)。
 */
export function isSecretSettingKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return (
    CASE_FOLDED_SECRET_SETTING_KEYS.has(key.toLowerCase()) ||
    SECRET_WORD_RE.test(key) ||
    SECRET_STORE_RE.test(key)
  );
}
