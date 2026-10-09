import { createHash, timingSafeEqual } from "node:crypto";

/**
 * OpenSSH `SHA256:` 指纹的**形状**判据("SHA256:" + 43 个 base64 字符)。
 *
 * 这条规则在三个地方各写了一遍:`hostKey.ts`(比对时)、`RelayManager.connect()`
 * (连接前先拒空/坏指纹)、`contracts/relay.ts` 的 zod schema(保存时)。三份**必须**逐字
 * 同形,否则会出现"存得下、连不上"或"连得上、存不下"的错位。这个常量是唯一真源,
 * 那两处都该从它出发(契约层不能反向 import 主进程模块,故 zod 那边仍是文本同形的正则,
 * 改动本常量时记得同步)。
 */
export const RELAY_HOST_KEY_FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** 形状对不对(不做哈希比对)。给"连接前先拒明显坏的指纹"那种守卫用。 */
export function isWellFormedHostKeyFingerprint(fingerprint: string | undefined): boolean {
  return typeof fingerprint === "string" && RELAY_HOST_KEY_FP_RE.test(fingerprint);
}

/** Pin an independently obtained OpenSSH SHA256 host-key fingerprint.
 *  No TOFU: an absent pin is never accepted, including old saved configs. */
export function verifyRelayHostKey(key: Buffer, fingerprint: string | undefined): boolean {
  if (!isWellFormedHostKeyFingerprint(fingerprint)) return false;
  const actual = createHash("sha256").update(key).digest();
  const expected = Buffer.from(fingerprint!.slice(7), "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
