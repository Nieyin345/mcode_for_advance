/**
 * Stable per-file native-view identity (not a content fingerprint).
 *
 * Two differently seeded 64-bit FNV-1a streams, each over the exact UTF-16
 * code units encoded as two bytes, give a bounded 128-bit identity while
 * remaining synchronous in the sandboxed renderer. This is not an
 * authorization mechanism: the host must still validate the requested path.
 */
export function stableDocId(filePath: string): string {
  const mask = 0xffff_ffff_ffff_ffffn;
  const prime = 0x100000001b3n;
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (let i = 0; i < filePath.length; i++) {
    const code = filePath.charCodeAt(i);
    const lo = BigInt(code & 0xff);
    const hi = BigInt(code >>> 8);
    first = ((first ^ lo) * prime) & mask;
    first = ((first ^ hi) * prime) & mask;
    second = ((second ^ lo) * prime) & mask;
    second = ((second ^ hi) * prime) & mask;
  }
  const hex = (value: bigint): string => value.toString(16).padStart(16, "0");
  return `genoffice-view-${hex(first)}${hex(second)}-${filePath.length}`;
}
