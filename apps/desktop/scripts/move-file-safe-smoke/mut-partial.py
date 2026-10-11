# -*- coding: utf-8 -*-
"""变异验证(台账 MC-068 §33.2,反例 A):把「目标已就位但删源失败」重新退回旧行为
—— committed:false / recoverable:false / phase:PREPARED,即把部分提交误报成完全失败。
必须让反例A / 反例A-跨卷 那组断言真红;逐字节还原后转绿。

精确 str.replace + 逐字节 cmp -s 确认还原。绝不 git stash / checkout。
"""
import io, os, shutil, subprocess, sys, filecmp
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "lib", "moveFileSafe.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

OLD = '''  return mk(base, "PARTIALLY_APPLIED", {
    committed: true,
    sourcePreserved: true,
    destinationPreserved: true,
    recoverable: true,
    reason: "PARTIALLY_APPLIED",
    message: `目标内容已就位,但删除源失败(${error.code ?? error.message});源仍在:${source},请确认目标无误后删除源,不要重跑整次移动`,
  });'''

NEW = '''  return mk(base, "PREPARED", {
    committed: false,
    sourcePreserved: true,
    destinationPreserved: true,
    recoverable: false,
    reason: error.code ?? "RENAME_FAILED",
    message: `移动失败(${error.code ?? error.message});源未改动`,
  });'''

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
    print(f"OK 退回「部分提交误报完全失败」: 红了 {c} 条")
    for l in f[:8]:
        print("   ", l[:150])
finally:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src)
    if not filecmp.cmp(SRC, bak, shallow=False):
        print("!! 没逐字节还原!"); os.remove(bak); sys.exit(3)
    os.remove(bak)
    print("已逐字节还原 moveFileSafe.ts (cmp 一致)")
