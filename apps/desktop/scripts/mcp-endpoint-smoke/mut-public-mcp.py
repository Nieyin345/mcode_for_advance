"""变异验证:撤掉公网 MCP 端点那几个关键判定,确认 mcp-endpoint-smoke 真的红。

⚠️ **必须用 Git bash 的绝对路径。** 这台机器上 `subprocess.run(["bash", ...])` 会挑到
WSL 那个 bash,它看不见 node,rc=127、输出是 `/usr/bin/env: 'node': No such file…`。
`run_suite` 把「没跑出结论」**单独报出来**,绝不算成红 —— 否则"五个变异全报 OK"是最坏的
假绿。

⚠️ 每次变异后必须逐字节还原并断言,`finally` 里也要验。

这一套的输出格式与 memory-smoke 不同(它打 `N/M 通过` 与 `✗ 名字 — {…}`,不是 FAIL/passed),
所以红的判据是「没看到 `全部通过` 那一行、且 ✗ 有增加」。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
PUBLIC = os.path.join(DESK, "src", "main", "providers", "bridge", "publicMcpServer.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        # 密钥比较形同虚设:任何非空密钥都放行。这条不红 = 鉴权没被测到。
        "M1 密钥比较永远为真",
        "  return timingSafeEqual(a, b);",
        "  return true; // MUTANT",
    ),
    (
        # 密钥不对时回 401 而不是 404 —— 等于告诉扫描者"这里有端点"。
        "M2 密钥不对回 401(泄露端点存在)",
        '    res.writeHead(404, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ error: "not found" }));\n    return;',
        '    res.writeHead(401, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ error: "no" }));\n    return;',
    ),
    (
        # 不注入合成会话:ChatGPT 不带会话头,结果每次调用都会被闸门拒 ——
        # 这是整条通路的命门,撤掉它必须红。
        "M3 不注入合成会话头",
        "  req.headers[MCODE_SESSION_HEADER] = sessionId;",
        "  // MUTANT: 不注入",
    ),
    (
        # 会话没备好时不再拦,直接放行 —— 等于放一次没有闸门的调用。
        "M4 没有合成会话时仍放行",
        '    res.writeHead(503, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ error: "mcode is still starting up; retry shortly" }));\n    return;',
        "    // MUTANT: 不拦",
    ),
]


def run_suite():
    """→ (✗ 的条数, ✗ 的那些行, 有没有跑出结论)。"""
    proc = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"],
                          cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("✗")]
    # 这套跑完会打 `N/M 通过`,N==M 时没有失败块。看"有没有出现 通过 那一行"。
    concluded = "通过" in out and "/" in out
    return len(fails), fails, concluded, out


def main() -> int:
    bad = 0
    for name, old, new in MUTATIONS:
        with io.open(PUBLIC, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {name}: 锚点在源文件里出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = PUBLIC + ".mutbak"
        shutil.copyfile(PUBLIC, bak)
        try:
            with io.open(PUBLIC, "w", encoding="utf-8", newline="") as f:
                f.write(src.replace(old, new))
            count, fails, concluded, out = run_suite()
            if not concluded:
                print(f"XX {name}: 套件没跑出结论 —— 变异验证无效")
                print(f"      {out.strip().splitlines()[-3:]}")
                bad += 1
            elif count == 0:
                print(f"XX {name}: 一条都没红 —— 断言不管用")
                bad += 1
            else:
                print(f"OK {name}: 红了 {count} 条")
                for line in fails[:3]:
                    print(f"      {line[:130]}")
        finally:
            shutil.copyfile(bak, PUBLIC)
            os.remove(bak)
            with io.open(PUBLIC, encoding="utf-8") as f:
                assert f.read() == src, f"{PUBLIC} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
