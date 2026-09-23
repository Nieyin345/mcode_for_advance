"""变异验证:撤掉远端日志的阻塞等待,确认 remote-ssh-smoke 真的红。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "mcp", "agentRemoteSsh.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUT = ('日志等待退化成「等到期也不等」(等于没有阻塞语义)',
       '  ...(waitMs > 0\n      ? [',
       '  ...(false\n      ? [')

def run():
    p = subprocess.run([BASH, "scripts/remote-ssh-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8","replace") + p.stderr.decode("utf-8","replace")
    # 这套 smoke 失败时会把同一条打两遍(check 里一次、结尾汇总一次)——去重再数。
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    return len(fails), fails, ("passed" in out), out

name, old, new = MUT
src = io.open(SRC, encoding="utf-8").read()
n = src.count(old)
if n != 1:
    print(f"!! 锚点出现 {n} 次(要 1 次)—— 变异没做成"); sys.exit(1)
bak = SRC + ".mutbak"; shutil.copyfile(SRC, bak)
try:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(old, new))
    c, f, ok, out = run()
    if not ok: print(f"XX 套件没跑出结论\n{out[-300:]}"); sys.exit(1)
    print(f"OK {name}: 红了 {c} 条" if c else f"XX {name}: 一条都没红")
    for l in f[:2]: print("     ", l[:120])
finally:
    shutil.copyfile(bak, SRC); os.remove(bak)
    assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
