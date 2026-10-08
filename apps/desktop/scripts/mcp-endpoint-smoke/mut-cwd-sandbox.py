"""变异验证:把"相对路径按沙箱解析"退回去,看 cwd/沙箱不一致那条断言真的红。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "mcp", "agentTools.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUT = [
    ("C1 相对路径退回按过期的 cwd 解析(用户报的那个 bug)",
     "    const sandbox = sandboxOf(ctx);\n    const abs = resolveAgainstCwd(sandbox ?? cwdOf(ctx), p, sandbox);",
     "    const abs = resolveAgainstCwd(cwdOf(ctx), p, sandboxOf(ctx));"),
    ("C2 agent_context 的当前项目退回 cwd(不报沙箱)",
     "          const sandbox = sandboxOf(ctx);\n          const snap = readEnvSnapshot(sandbox ?? cwdOf(ctx), { includeLibrary: args.include_library === true });",
     "          const snap = readEnvSnapshot(cwdOf(ctx), { includeLibrary: args.include_library === true });"),
]

def run():
    p = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8","replace") + p.stderr.decode("utf-8","replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    return len(fails), fails, ("通过" in out and "/" in out), out

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
        if not ok: print(f"XX {name}: 没跑出结论\n{out[-250:]}"); bad += 1
        elif c == 0: print(f"XX {name}: 一条没红"); bad += 1
        else:
            print(f"OK {name}: 红了 {c} 条")
            for l in f[:2]: print("     ", l[:110])
    finally:
        shutil.copyfile(bak, SRC); os.remove(bak)
        assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
print(f"\n{'全部被抓' if bad==0 else f'{bad} 个没抓到'}")
sys.exit(1 if bad else 0)
