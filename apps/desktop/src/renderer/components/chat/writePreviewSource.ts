/** Resolve a Write tool's pre-turn content without confusing similarly named
 * files. Some tool inputs are relative paths while turn.files uses absolute
 * paths. The old endsWith(filePath) matched data.ts for a.ts, and if multiple
 * project folders had src/index.ts it silently picked whichever Map entry
 * happened to come first. In both cases a false diff is worse than a plain
 * new-content preview.
 *
 * A qualified suffix must begin at a complete path segment. Ambiguous
 * relative suffixes intentionally return undefined. */
export function writePreviewBefore(
  snapshots: ReadonlyMap<string, string> | undefined,
  toolPath: string,
): string | undefined {
  if (!snapshots?.size || !toolPath.trim()) return undefined;
  const normalized = (path: string) => {
    const slash = path.replace(/\\/g, "/");
    const networkShare = slash.startsWith("//");
    const clean = slash.replace(/\/+/g, "/").replace(/(^|\/)\.\//g, "$1").replace(/\/$/, "");
    // Keep a UNC root distinct from a POSIX absolute path.
    return networkShare ? "/" + clean : clean;
  };
  const target = normalized(toolPath);
  const windowsPath = /^[a-z]:\//i.test(target) || target.startsWith("//");
  const isAbsolute = windowsPath || target.startsWith("/");
  let match: string | undefined;
  let matches = 0;
  for (const [absolute, content] of snapshots) {
    const source = normalized(absolute);
    const caseInsensitive = windowsPath || /^[a-z]:\//i.test(source) || source.startsWith("//");
    const left = caseInsensitive ? source.toLowerCase() : source;
    const right = caseInsensitive ? target.toLowerCase() : target;
    const same = left === right;
    const suffix = left.endsWith("/" + right);
    if (same || (!isAbsolute && suffix)) {
      match = content;
      matches++;
      if (matches > 1) return undefined;
    }
  }
  return matches === 1 ? match : undefined;
}
