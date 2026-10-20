/** Convert arbitrary SDK/tool input into text without ever returning undefined.
 * JSON.stringify(undefined / Symbol / function) returns undefined without throwing,
 * so a catch alone is not enough for renderers that use .slice() on the result. */
export function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    const json = JSON.stringify(v, null, 2);
    if (typeof json === "string") return json;
  } catch {
    // Circular data and unsupported values fall through to string conversion.
  }
  try {
    return String(v);
  } catch {
    return "[unserializable tool input]";
  }
}
