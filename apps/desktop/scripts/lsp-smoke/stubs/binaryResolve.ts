/**
 * `@main/lib/binaryResolve.js` 的替身 —— 真的那个跑 `where.exe` / 扫 PATH。
 *
 * ⚠️ **为什么非换不可**:被测代码的「找得到 / 找不到」完全取决于跑这套脚本的这台
 * 机器上装没装 language server。这台机器上**真的装了**
 * `typescript-language-server` 和 `basedpyright-langserver` —— 不换桩的话,
 * 「找不到 server 必须显式报错」那一整段断言在这台机器上会走另一条分支
 * (报告里会看到 `installed=true`),而在 CI 那台机器上又走回来。那不是回归网。
 *
 * 这个桩把「哪条路能解析出可执行文件」变成脚本里自己摆的一件事:
 *   - 默认**什么都找不到**(返回 null)—— 和一台干净机器上的行为一致;
 *   - 用例按需 `setBinaries({ typescript: GOOD_SERVER })`;
 *   - 顺序也照真的那个(`whichAny` 是「第一个命中的赢」),所以「pyright 两个
 *     binary 名的优先级」也能钉住。
 *
 * ⚠️ **不是空实现**:没登记的名字一律返回 null(拒绝),而不是"默认放行"。
 */
const found = new Map<string, string>();

/** 这台机器上「装了」哪些可执行名(LspManager 之外的东西问也不会有)。 */
export function setBinaries(map: Record<string, string>): void {
  found.clear();
  for (const [k, v] of Object.entries(map)) found.set(k, v);
}

/** 清空(用例之间互不影响)。 */
export function clearBinaries(): void {
  found.clear();
}

/** 被问过的名字(按顺序)—— 用来钉「优先 which 哪一个」这种顺序决定。 */
export const probed: Array<{ name: string; hit: string | null }> = [];

function probe(name: string): string | null {
  const hit = found.get(name) ?? null;
  probed.push({ name, hit });
  return hit;
}

/** 与真的一致:名字里带路径分隔符时只做存在性检查,不查 PATH。 */
export function which(name: string): string | null {
  if (name.includes("/") || name.includes("\\")) return null; // 桩里不做文件系统检查
  return probe(name);
}

/** 与真的一致:第一个命中的赢。 */
export function whichAny(names: string[]): string | null {
  for (const n of names) {
    const hit = probe(n);
    if (hit) return hit;
  }
  return null;
}

/** 本套不走 shell 解析那条路;真被调到了要立刻显形。 */
export function resolveGitBash(): never {
  throw new Error("lsp-smoke 不该走到 resolveGitBash");
}
