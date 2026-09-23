"""变异验证:撤掉 canUseTool 里那条「库只读」显式规则,确认断言真的红。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "providers", "claude-sdk", "ClaudeAgentSdkProvider.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUT = [
    ('L1 整条库只读规则删掉(退回恰好靠项目边界的老状态)',
     SRC,
     "            if (isInsideLibrary(norm.absPath)) {",
     "            if (false && isInsideLibrary(norm.absPath)) {"),
]

def run():
    p = subprocess.run([BASH, "scripts/library-paths-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8","replace") + p.stderr.decode("utf-8","replace")
    fails = sorted({l.strip() for l in out.splitlines() if "FAIL" in l or l.strip().startswith("✗")})
    return len(fails), fails, ("passed" in out), out

bad = 0
for name, path, old, new in MUT:
    src = io.open(path, encoding="utf-8").read()
    n = src.count(old)
    if n != 1:
        print(f"!! {name}: 锚点 {n} 次(要 1)"); bad += 1; continue
    bak = path + ".mutbak"; shutil.copyfile(path, bak)
    try:
        io.open(path, "w", encoding="utf-8", newline="").write(src.replace(old, new))
        c, f, ok, out = run()
        if not ok: print(f"XX {name}: 没跑出结论\n{out[-300:]}"); bad += 1
        elif c == 0: print(f"XX {name}: 一条没红"); bad += 1
        else:
            print(f"OK {name}: 红了 {c} 条")
            for l in f[:3]: print("     ", l[:110])
    finally:
        shutil.copyfile(bak, path); os.remove(bak)
        assert io.open(path, encoding="utf-8").read() == src, "没逐字节还原!"
print(f"\n{'全部被抓' if bad==0 else f'{bad} 个没抓到'}")
sys.exit(1 if bad else 0)
