# -*- coding: utf-8 -*-
"""变异验证(台账 MC-068 §33.3,反例 B):把「恢复旧目标」从可靠 no-clobber 退回裸
`rename(backup, destination)` —— win32 上对已存在普通文件是**替换语义**,会把第三方
写到 destination 的新内容无声覆盖。必须让反例B 那组断言真红;逐字节还原后转绿。

精确 str.replace + 逐字节 cmp -s 确认还原。绝不 git stash / checkout。
"""
import io, os, shutil, subprocess, sys, filecmp
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "lib", "moveFileSafe.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# 整段替换掉可靠 no-clobber 恢复函数 —— 退回旧的无条件 rename。
OLD = '''/** 恢复旧目标 —— 目标槽位**未被占用**才安全提交;文件走原子 `link`,目录走 `mkdir` 占位。 */
async function restoreBackupNoClobber(backup: string, destination: string): Promise<boolean> {
  const bstat = await fs.lstat(backup).catch(() => null);
  if (!bstat) return false; // 备份都不在了,无从恢复(交人工)。
  if (!bstat.isDirectory()) {
    // 原子 no-clobber:link 目标已存在即 EEXIST → 不覆盖第三方内容(反例 B 的正解)。
    try {
      await fs.link(backup, destination);
    } catch {
      return false;
    }
    await fs.rm(backup, { force: true }).catch(() => {});
    return true;
  }
  return restoreDirNoClobber(backup, destination);
}'''

NEW = '''/** MUTANT:退回无条件的 rename 恢复 —— win32 上会替换掉已存在的第三方内容。 */
async function restoreBackupNoClobber(backup: string, destination: string): Promise<boolean> {
  const bstat = await fs.lstat(backup).catch(() => null);
  if (!bstat) return false;
  try {
    await fs.rename(backup, destination);
    return true;
  } catch {
    return false;
  }
}'''

def run():
    p = subprocess.run([BASH, "scripts/move-file-safe-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    return len(fails), fails, ("通过" in out), out

src = io.open(SRC, encoding="utf-8").read()
n = src.count(OLD)
if n != 1:
    print(f"!! 锚点 {n} 次(要 1) —— 变异锚点随源码漂移了"); sys.exit(2)
bak = SRC + ".mutbak"
shutil.copyfile(SRC, bak)
try:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
    c, f, ok, out = run()
    if not ok:
        print(f"XX 没跑出结论\n{out[-500:]}"); sys.exit(1)
    if c == 0:
        print("XX 一条没红 —— 断言不管用"); sys.exit(1)
    print(f"OK 退回无条件 rename 恢复: 红了 {c} 条")
    for l in f[:8]:
        print("   ", l[:160])
finally:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src)
    if not filecmp.cmp(SRC, bak, shallow=False):
        print("!! 没逐字节还原!"); os.remove(bak); sys.exit(3)
    os.remove(bak)
    print("已逐字节还原 moveFileSafe.ts (cmp 一致)")
