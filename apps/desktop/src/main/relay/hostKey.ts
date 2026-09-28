import { createHash, timingSafeEqual } from "node:crypto";

/** Pin an independently obtained OpenSSH SHA256 host-key fingerprint.
 *  No TOFU: an absent pin is never accepted, including old saved configs. */
export function verifyRelayHostKey(key: Buffer, fingerprint: string | undefined): boolean {
  if (!fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) return false;
  const actual = createHash("sha256").update(key).digest();
  const expected = Buffer.from(fingerprint.slice(7), "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
