"""变异验证:撤掉"隧道掉了要重连",看 tunnel-manager-smoke 真的红。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "providers", "bridge", "tunnelManager.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUT = [
    ('R1 隧道掉了不重连(退回"只标 failed"的老行为)',
     "    if (livePort !== null) {\n      scheduleReconnect(livePort, code);\n      return;\n    }",
     "    // MUTANT: 不重连"),
    # ⚠️ **这里本来还想加一条**「停止时不清 livePort」的变异 —— 撤掉它、看断言是否变红。
    # 但**验不到**:假进程的 `kill()` 只设 exitCode、不 emit `close`(见 FakeProc),
    # 所以 `stopTunnel → killChild` 在测试里压根走不到 close 处理器那条保护路径。
    # 真实 cloudflared 会 emit close,所以生产里那个 `livePort = null` 是必要的 ——
    # 这一点由代码注释与人工审查保证,不由这套 smoke 保证。写在这里免得下一个人
    # 以为是漏测、去硬凑一个假绿的断言。
]

def run():
    p = subprocess.run([BASH, "scripts/tunnel-manager-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8","replace") + p.stderr.decode("utf-8","replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    concluded = "通过" in out and "/" in out
    return len(fails), fails, concluded, out

bad = 0
for name, old, new in MUT:
    src = io.open(SRC, encoding="utf-8").read()
    n = src.count(old)
    if n != 1:
        print(f"!! {name}: 锚点 {n} 次(要 1)"); bad += 1; continue
    bak = SRC + ".mutbak"; shutil.copyfile(SRC, bak)
    try:
        io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(old, new))
        c, f, ok, out = run()
        if not ok: print(f"XX {name}: 没跑出结论\n{out[-220:]}"); bad += 1
        elif c == 0: print(f"XX {name}: 一条没红"); bad += 1
        else:
            print(f"OK {name}: 红了 {c} 条")
            for l in f[:2]: print("     ", l[:110])
    finally:
        shutil.copyfile(bak, SRC); os.remove(bak)
        assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
print(f"\n{'全部被抓' if bad==0 else f'{bad} 个没抓到'}")
sys.exit(1 if bad else 0)
