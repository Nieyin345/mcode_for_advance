/**
 * `@main/lib/secretStore.js` 的替身 —— 真的那个 import 了 electron 的 `safeStorage`。
 *
 * `integrations/store.ts`(MinerU 的密钥就存在那儿)拿它加解密。本套不验加密,
 * 只验"没配 MinerU 时转换**如实退回本地抽取**"这条降级路 —— 所以需要一个能存
 * 明文的替身。
 *
 * 明文是**故意的**:真那份的密文在没有 safeStorage 的环境里也解不开,拿它当替身
 * 会让"配了密钥"和"没配"长得一样,而这两条路的结果完全不同(见 main.ts 第 3 段)。
 */
export function encrypt(plain: string): string {
  return `plain:${plain}`;
}

export function decrypt(cipher: string): string {
  return cipher.startsWith("plain:") ? cipher.slice("plain:".length) : cipher;
}
