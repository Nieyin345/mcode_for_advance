"""变异验证:撤掉长任务那两处关键改动,确认 mcp-endpoint-smoke 真的红。

⚠️ 必须用 Git bash 的绝对路径(WSL 的 bash 看不见 node,会假绿)。
⚠️ 输出格式:`N/M 通过` + `✗ 名字 — {…}`。没跑出结论要单独报。

两处改动各一个变异:
  M1 把等待上限改回 5 秒 —— 阻塞读那条断言应红(它就是钉这个的);
  M2 把 read 的默认 wait_ms 改回 0 —— 同上(默认值那一路)。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SESSIONS = os.path.join(DESK, "src", "main", "mcp", "agentProcessSessions.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        "M1 等待上限改回 5 秒(空轮询的老上限)",
        "export const MAX_PROCESS_WAIT_MS = 55_000;",
        "export const MAX_PROCESS_WAIT_MS = 5_000;",
    ),
    (
        "M2 read 的默认 wait_ms 改回 0(立刻返回,不阻塞)",
        "      await waitForOutput(session, cursor, input.waitMs ?? MAX_PROCESS_WAIT_MS, input.maxChars ?? DEFAULT_READ_CHARS);",
        "      await waitForOutput(session, cursor, input.waitMs ?? 0, input.maxChars ?? DEFAULT_READ_CHARS);",
    ),
]


def run_suite():
    proc = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"],
                          cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("✗")]
    concluded = "通过" in out and "/" in out
    return len(fails), fails, concluded, out


def main() -> int:
    bad = 0
    for name, old, new in MUTATIONS:
        with io.open(SESSIONS, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {name}: 锚点在源文件里出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = SESSIONS + ".mutbak"
        shutil.copyfile(SESSIONS, bak)
        try:
            with io.open(SESSIONS, "w", encoding="utf-8", newline="") as f:
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
            shutil.copyfile(bak, SESSIONS)
            os.remove(bak)
            with io.open(SESSIONS, encoding="utf-8") as f:
                assert f.read() == src, f"{SESSIONS} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
