/**
 * Stable cross-process + renderer identity key for a filesystem path.
 * No Node, Electron or browser globals: both surfaces must compare identically.
 * Never erase the root separator: "/" != "" and "C:/" != "C:".
 */
export function canonicalPathKey(input: string, caseInsensitive: boolean): string {
  const slashes = input.replace(/\\/g, "/");
  let key = slashes.replace(/\/+$/, "");
  if (key === "" && slashes.startsWith("/")) key = "/";
  // Drive-relative "C:" must stay distinct from the absolute volume root "C:/".
  if (/^[A-Za-z]:$/.test(key) && slashes.endsWith("/")) key += "/";
  // UNC share roots have no additional path after the share. Keep both
  // "\\server\share" and "\\server\share\" equal, but distinct from children.
  if (/^\/\/[^/]+\/[^/]+$/.test(key)) key += "/";
  return caseInsensitive ? key.toLowerCase() : key;
}
