/**
 * 「这次会话属于哪个项目」—— 项目级配置(项目插件开关等)按会话的 cwd 找项目。
 *
 * 会话 cwd 通常就是项目目录;也可能是项目里的子目录。所以按**路径前缀**匹配,多个
 * 候选时取最长的那个(嵌套项目:里面那个赢)。Windows 路径大小写不敏感,比较前统一
 * 小写;存储时保留原样(界面上要显示)。
 */
import path from "node:path";

/** Comparison form of a project path (resolved, no trailing separator,
 *  lower-cased on Windows). Never stored — only compared. */
export function projectKey(p: string): string {
  let r = path.resolve(p);
  if (process.platform === "win32") r = r.toLowerCase();
  return r.length > 1 ? r.replace(/[\\/]+$/, "") : r;
}

/** The stored key (one of `keys`) whose project contains `cwd` — longest
 *  match wins. Undefined when none does. */
export function matchProjectKey(cwd: string | undefined, keys: readonly string[]): string | undefined {
  if (!cwd) return undefined;
  const c = projectKey(cwd);
  let best: string | undefined;
  let bestLen = -1;
  for (const k of keys) {
    const kk = projectKey(k);
    if ((c === kk || c.startsWith(kk + path.sep)) && kk.length > bestLen) {
      best = k;
      bestLen = kk.length;
    }
  }
  return best;
}

/** The stored key equal to `projectPath` (same project), if any. */
export function sameProjectKey(projectPath: string, keys: readonly string[]): string | undefined {
  const p = projectKey(projectPath);
  return keys.find((k) => projectKey(k) === p);
}
