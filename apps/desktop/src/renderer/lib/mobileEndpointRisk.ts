/**
 * 【MC-004】手机 LAN 端点的**明文传输风险**判据 —— 纯函数,可直测。
 *
 * ## 为什么需要它
 *
 * 手机端(Mcode 的 LAN 入口)在显式启用后仍是**明文 HTTP**:`http://<局域网 IP>:<port>`。
 * 手机经这个地址提交的账号密码与 Bearer 令牌**不加密**,同一网段的其他人可观察。安全默认值
 * (全新安装不自动监听)与「非回环明文凭据闸」(主进程侧 403)已经堵掉了最危险的几处,但
 * **界面从没提示过用户这条连接是明文的** —— 台账 §50.6 三次点名「部署页风险提示文案仍未加」。
 *
 * 本模块把「这个端点该不该显示明文风险提示」提成一个纯判据,界面据此显示/隐藏那一条提示。
 *
 * ## 判据(刻意保守)
 *
 * 只有**同时**满足「协议是明文 `http:`」**且**「主机不是回环」时才提示:
 *   - `https:` / `wss:` → 已加密,不提示(将来接上 TLS 后自动静默);
 *   - 回环主机(`127.0.0.1` / `::1` / `localhost`)→ 只本机可达,不提示(避免无谓惊吓);
 *   - 其余(局域网 IP / 主机名 / 无法解析)→ **提示**(宁可多提示一次,不可漏报一次明文凭据)。
 *
 * 与主进程 `MobileHttpServer.isLoopbackPeer` 同一取向(都只认回环),但各自面向**不同对象**:
 * 那边判「请求对端地址」,这边判「展示给用户的端点 URL」—— 不共用一份实现,因为输入形状根本不同
 * (一个 socket 地址,一个 URL 字符串)。
 */

/** 主机名是不是回环(只认三种写法,不做 DNS 解析 —— 纯字符串判定)。 */
function isLoopbackHostname(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, ""); // 去掉 IPv6 的 []
  if (h === "localhost" || h === "::1") return true;
  // 127.0.0.0/8 整段都算回环。
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * 这个手机端点是不是**非回环的明文 HTTP** —— 是则界面应显示「明文风险」提示。
 *
 * 解析不出协议/主机(畸形字符串)时**判为需要提示**(保守:拿不准就当它可能是明文 LAN 地址)。
 */
export function isPlaintextNonLoopbackEndpoint(endpoint: string): boolean {
  const raw = endpoint.trim();
  if (raw === "") return false; // 空端点不提示(还没起服务)
  // 没有 `://` 的裸地址(如 `192.168.1.5:8787`)按明文 LAN 处理 → 提示。
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (schemeMatch === null) return true;
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== "http") return false; // https / wss / 其它带:// 的都不算"明文 http"
  // 取 host 部分(去 scheme、去 path/userinfo/port)。
  let rest = raw.slice(schemeMatch[0].length);
  const slash = rest.indexOf("/");
  if (slash >= 0) rest = rest.slice(0, slash);
  const at = rest.lastIndexOf("@"); // userinfo(罕见,但别把 host 判错)
  if (at >= 0) rest = rest.slice(at + 1);
  // IPv6 主机形如 [::1]:port。
  let host: string;
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    host = end >= 0 ? rest.slice(0, end + 1) : rest;
  } else {
    const colon = rest.indexOf(":");
    host = colon >= 0 ? rest.slice(0, colon) : rest;
  }
  if (host === "") return true; // `http://` 后面什么都没有 —— 拿不准,提示
  return !isLoopbackHostname(host);
}
