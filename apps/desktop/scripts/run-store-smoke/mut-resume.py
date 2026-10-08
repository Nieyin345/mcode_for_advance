"""变异验证:「从任一步接着往下跑」这条路上,那几道门真的还被守着吗。

判据是 `retryableRun` 的两处改动:
  - 摘掉 `row.status !== "failed"`  → "跑成功的运行"那一条该红;
  - 摘掉 `outcome === undefined`    → "存档里没有的节点"那一条该红。

⚠️ 必须用 Git bash 的绝对路径(见 memory-smoke/mut.py 里那段:WSL 的 bash 没有 node,
rc=127 会被误当成"红了")。而且**没跑出结论**要单独报,绝不算成捕获。

每次变异后逐字节还原并断言。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
TARGET = os.path.join(DESK, "src", "main", "orchestration", "runStore.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        "M1 门3 复活:要求那次运行必须是 failed(等于回到改造前)",
        '  if (row === null || row.sessionId !== sessionId) return null;\n  const snapshot',
        '  if (row === null || row.sessionId !== sessionId) return null;\n  if (row.status !== "failed") return null;\n  const snapshot',
    ),
    (
        "M2 门4 复活:要求那一步必须是 failed 的",
        '  const outcome = snapshot.state.outcomes.find(([id]) => id === nodeId)?.[1];\n  const interruptedStep = row.status === "interrupted" &&\n    (snapshot.inFlightNodeIds?.includes(nodeId) === true || snapshot.state.awaiting.includes(nodeId));\n  if (outcome === undefined && !interruptedStep) return null;',
        '  const outcome = snapshot.state.outcomes.find(([id]) => id === nodeId)?.[1];\n  const interruptedStep = row.status === "interrupted" &&\n    (snapshot.inFlightNodeIds?.includes(nodeId) === true || snapshot.state.awaiting.includes(nodeId));\n  if (outcome?.status !== "failed") return null;',
    ),
    (
        "M3 结局不交出来(调用方分不清两种重跑)",
        "  return { runId: row.id, workflowId: row.workflowId, snapshot, outcome };",
        "  return { runId: row.id, workflowId: row.workflowId, snapshot, outcome: { status: \"failed\", summary: \"\" } };",
    ),
]


def run_suite():
    proc = subprocess.run([BASH, "scripts/run-store-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("FAIL")]
    concluded = "passed" in out
    return len(fails), fails, concluded, out


def main() -> int:
    bad = 0
    for name, old, new in MUTATIONS:
        with io.open(TARGET, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {name}: 锚点在源文件里出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = TARGET + ".mutbak"
        shutil.copyfile(TARGET, bak)
        try:
            with io.open(TARGET, "w", encoding="utf-8", newline="") as f:
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
                for line in fails[:4]:
                    print(f"      {line[:130]}")
        finally:
            shutil.copyfile(bak, TARGET)
            os.remove(bak)
            with io.open(TARGET, encoding="utf-8") as f:
                assert f.read() == src, f"{TARGET} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
