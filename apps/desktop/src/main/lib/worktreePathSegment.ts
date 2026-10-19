import { createHash } from 'node:crypto';

// Portable across Win32/Linux/macOS. Windows treats these names as reserved
// devices or silently strips a trailing dot even when passed in a full path.
function windowsAlias(name: string): boolean {
  return /^\.+$/.test(name) || name.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

/** Safe directory segments for legacy managed worktrees. No filesystem calls. */
export function worktreeRepoSegment(repoBasename: string): string {
  const sanitized = repoBasename.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (sanitized === '' || sanitized === '.' || sanitized === '..') return 'repo';
  if (windowsAlias(sanitized)) {
    // Make a stable, distinct safe path rather than silently alias CON,
    // trailing-dot names or the entire parent directory.
    const shortHash = createHash('sha256').update(repoBasename).digest('hex').slice(0, 8);
    return `repo-${sanitized}-${shortHash}`;
  }
  return sanitized;
}

/** Preserve legacy last-12 format for normal session IDs but refuse names
 * that can escape the repo folder or alias another session through separators.
 * Never repair a malformed identity by silently choosing another directory. */
export function worktreeSessionSegment(sessionId: string): string {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error('无效的 sessionId：工作树会话身份不能包含路径分隔符或特殊字符');
  }
  const suffix = sessionId.slice(-12);
  if (windowsAlias(suffix)) {
    throw new Error('无效的 sessionId：工作树路径不能是当前目录或父目录');
  }
  return suffix;
}
