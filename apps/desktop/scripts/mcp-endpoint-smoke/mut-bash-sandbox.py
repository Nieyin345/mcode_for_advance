"""变异验证:撤掉 agent_bash 的重定向目标检查,看重定向到沙箱外那条断言真的红。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "mcp", "agentTools.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

OLD = "                const denial = sandboxBashWriteDenial(args.command, sandbox);"
NEW = "                const denial = null; // MUTANT"

def run():
    p = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8","replace") + p.stderr.decode("utf-8","replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    concluded = "通过" in out and "/" in out
    return len(fails), fails, concluded, out

src = io.open(SRC, encoding="utf-8").read()
n = src.count(OLD)
if n != 1:
    print(f"!! 锚点 {n} 次(要 1)"); sys.exit(1)
bak = SRC + ".mutbak"; shutil.copyfile(SRC, bak)
try:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
    c, f, ok, out = run()
    if not ok:
        print(f"XX 没跑出结论\n{out[-250:]}"); sys.exit(1)
    if c == 0:
        print("XX 一条没红"); sys.exit(1)
    print(f"OK 撤掉 bash 写目标检查: 红了 {c} 条")
    for l in f[:3]: print("   ", l[:120])
    print("\n全部被抓")
finally:
    shutil.copyfile(bak, SRC); os.remove(bak)
    assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
