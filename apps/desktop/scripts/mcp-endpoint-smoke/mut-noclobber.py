# -*- coding: utf-8 -*-
"""变异验证(台账 MC-068 §28.2 残余):把 moveNoClobber 的文件分支退回「裸 rename」,
验证 ★ 并发断言真的红(win32 上裸 rename 会静默覆盖,两个都报成功)。逐字节还原后转绿。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "lib", "moveFileSafe.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

OLD = """async function noClobberFile(src: string, dst: string): Promise<NoClobberOutcome> {
  try {
    // link 是本机原子 no-clobber(win32/NTFS 与 POSIX 均已验目标已存在抛 EEXIST)。
    await fs.link(src, dst);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { status: "exists" };
    if (e.code !== "EXDEV") return { status: "failed", error: e };
    return noClobberFileCrossDevice(src, dst);
  }
  // 硬链接已建成:目标真的出现了。此刻删源失败也绝不能报「什么都没发生」。
  try {
    await fs.rm(src, { force: true });
    return { status: "ok" };
  } catch (err) {
    return { status: "partial", error: err as NodeJS.ErrnoException };
  }
}"""

NEW = """async function noClobberFile(src: string, dst: string): Promise<NoClobberOutcome> {
  // MUTANT: 退回裸 rename —— win32 上静默覆盖,不做 no-clobber。
  await fs.rename(src, dst);
  return { status: "ok" };
}"""

def run():
    p = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    return len(fails), fails, ("通过" in out and "/" in out), out

src = io.open(SRC, encoding="utf-8").read()
n = src.count(OLD)
if n != 1:
    print(f"!! 锚点 {n} 次(要 1) —— 变异锚点随源码漂移了"); sys.exit(2)
bak = SRC + ".mutbak"; shutil.copyfile(SRC, bak)
try:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
    c, f, ok, out = run()
    if not ok:
        print(f"XX 没跑出结论\n{out[-400:]}"); sys.exit(1)
    if c == 0:
        print("XX 一条没红 —— no-clobber 断言不管用"); sys.exit(1)
    print(f"OK 退回裸 rename: 红了 {c} 条")
    for l in f[:6]:
        print("   ", l[:150])
finally:
    shutil.copyfile(bak, SRC); os.remove(bak)
    assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
    print("已逐字节还原 moveFileSafe.ts")
