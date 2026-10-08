"""变异验证:撤掉沙箱判定 / 域名抠取,确认对应断言真的红。

⚠️ 必须用 Git bash 的绝对路径(WSL 的 bash 看不见 node,会假绿)。
⚠️ 没跑出结论要单独报 —— 否则"全 OK"可能是假绿。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
AGENT = os.path.join(DESK, "src", "main", "mcp", "agentTools.ts")
TUNNEL = os.path.join(DESK, "src", "main", "providers", "bridge", "tunnelManager.ts")
RULES = os.path.join(DESK, "src", "main", "mcp", "toolRules.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# (名字, 文件, old, new, 套件)
MUTATIONS = [
    (
        "S1 沙箱判定永远放行(等于没有沙箱)",
        AGENT,
        "  if (root && !pathWithin(root, abs)) {",
        "  if (false && root && !pathWithin(root, abs)) {",
        "mcp-endpoint-smoke",
    ),
    (
        # `pathWithin` 的核心是 `path.relative` 那段。退化成纯字符串前缀比较,
        # 就会把"同前缀的兄弟目录"(`CWD-sibling`)误判成在内部 —— 经典漏洞。
        "S2 pathWithin 退化成纯字符串前缀比较(吃掉兄弟目录)",
        AGENT,
        "  const rel = path.relative(r, a);\n  return rel === \"\" || (!rel.startsWith(\"..\") && !path.isAbsolute(rel));",
        "  return a.startsWith(r);",
        "mcp-endpoint-smoke",
    ),
    (
        # 放宽成"任何 https 主机名" —— 预检块里有 `https://developers.cloudflare.com/...`
        # 之类的链接行吗?没有。所以真正的等价变异是:让它在**云端点那张表**里乱认
        # (预检块里那几个 argotunnel host 不带 scheme,得先允许无 scheme 的匹配)。
        'T1 域名正则退化成「日志里第一个像主机名的东西」(会认错成预检里的地址)',
        TUNNEL,
        "const QUICK_TUNNEL_RE = /https:\\/\\/[a-z0-9][a-z0-9-]*\\.trycloudflare\\.com/i;",
        "const QUICK_TUNNEL_RE = /[a-z0-9][a-z0-9-]*\\.(?:trycloudflare\\.com|argotunnel\\.com)/i;",
        "tunnel-manager-smoke",
    ),
    (
        # ⚠️ **这条 2026-10-08 重写过。** 原锚点盯着超时块里那句
        # `status = { phase: "failed", … reason }`,而隧道自愈改造之后超时也走
        # `scheduleReconnect`(不再直接落 failed)—— 那句话没了,锚点失配 0 次,
        # 于是这条变异静默失效。重写成盯**超时守卫本身**:拿掉它就是"起不来就干等
        # 到用户手动点",正是这条变异要抓的退化。
        "T2 超时守卫失效(起不来就干等,不退避重连)",
        TUNNEL,
        '    readyTimer = setTimeout(() => {\n      if (status.phase !== "starting") return;',
        '    readyTimer = setTimeout(() => {\n      if (true) return;',
        "tunnel-manager-smoke",
    ),
    (
        "T3 close 处理器不认自己的进程(旧进程迟到会打死新隧道)",
        TUNNEL,
        '    proc.on("close", (code) => {\n      // ⚠️ **先认这是不是当前那个进程。** 用户"停 → 立刻重开"时,旧进程的 close\n      // 会**迟到**(killTree 发信号到真正退出有时间差),那时全局 status 说的已经是\n      // **新隧道**的事 —— 不看这一眼就会把刚起来的新隧道误判成 failed。\n      if (child !== proc) return;\n      clearTimer();',
        '    proc.on("close", (code) => {\n      clearTimer();',
        "tunnel-manager-smoke",
    ),
    (
        # 最经典的退化:所有工具都标成写工具(等于没标,只读工具每次弹框)。
        "A1 所有工具都当成写工具(readOnlyHint 恒 false)",
        RULES,
        "  const readOnly = isReadOnlyToolName(bareName);\n  return {\n    readOnlyHint: readOnly,",
        "  const readOnly = false;\n  return {\n    readOnlyHint: readOnly,",
        "mcp-endpoint-smoke",
    ),
    (
        # openWorldHint 恒 false —— 把"触网"说成"纯本地",客户端于是不设防。
        "A2 openWorldHint 恒 false(触网工具被说成纯本地)",
        RULES,
        "    openWorldHint: touchesOpenWorld(bareName),",
        "    openWorldHint: false,",
        "mcp-endpoint-smoke",
    ),
]


def run_suite(name):
    proc = subprocess.run([BASH, f"scripts/{name}/run.sh"], cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("✗")]
    concluded = ("通过" in out) and ("/" in out)
    return len(fails), fails, concluded, out


def main() -> int:
    bad = 0
    for label, path, old, new, suite in MUTATIONS:
        with io.open(path, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {label}: 锚点在源文件里出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = path + ".mutbak"
        shutil.copyfile(path, bak)
        try:
            with io.open(path, "w", encoding="utf-8", newline="") as f:
                f.write(src.replace(old, new))
            count, fails_, concluded, out = run_suite(suite)
            if not concluded:
                print(f"XX {label}: 套件没跑出结论 —— 变异验证无效")
                print(f"      {out.strip().splitlines()[-3:]}")
                bad += 1
            elif count == 0:
                print(f"XX {label}: 一条都没红 —— 断言不管用")
                bad += 1
            else:
                print(f"OK {label}: 红了 {count} 条")
                for line in fails_[:2]:
                    print(f"      {line[:130]}")
        finally:
            shutil.copyfile(bak, path)
            os.remove(bak)
            with io.open(path, encoding="utf-8") as f:
                assert f.read() == src, f"{path} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
