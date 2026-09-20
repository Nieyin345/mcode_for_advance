"""变异验证:「从图上挑一步往下走」这一片的新行为真的被断言钉住了吗。

四处,每一处对应一条会**静默错一整天**的失效(界面上什么都看不出来):

  M1 `isAskBeforeRun` 那道闸没了    → 以分支为入口的图一开跑就整张失败
  M2 不替换标签                     → 模型读到"用这一步的指令"(说的是另一件事)
  M3 `chosen` 不清                → 重跑的那一片照抄上一轮的选择,用户没得重选
  M4 入口预置整段没了               → 用户点过的板又被问一遍(答"跳过"则一步不跑)

⚠️ 必须用 Git bash 的绝对路径(WSL 的 bash 没有 node,rc=127 会被误当成"红了")。
而且**没跑出结论**要单独报,绝不算成捕获。每次变异后逐字节还原并断言。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
TARGET = os.path.join(DESK, "src", "main", "orchestration", "scheduler.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        "M1 入口预置的闸没了(分支也会被预置)",
        "    entryNode !== undefined &&\n    this.isAskBeforeRun(entryNode.id) &&\n",
        "    entryNode !== undefined &&\n",
    ),
    (
        "M2 不替换标签(退回选项自己的文案)",
        "      pick.edgeId === ASK_RUN_CHOICE && this.restartFromStep?.has(node.id) === true\n"
        "        ? RESTART_FROM_STEP_LABEL\n"
        "        : (options.find((o) => o.id === pick.edgeId)?.label ?? \"\");",
        "      (options.find((o) => o.id === pick.edgeId)?.label ?? \"\");",
    ),
    (
        "M3 重跑的分支不清 chosen(照抄上一轮)",
        "  for (const id of voidedByRewind ?? []) {\n    if (this.choosesEdge(id)) this.chosen.delete(id);\n  }",
        "  for (const id of voidedByRewind ?? []) {\n    if (false && this.choosesEdge(id)) this.chosen.delete(id);\n  }",
    ),
    (
        "M4 入口预置整段没了",
        "    this.presetChoices.set(entryNode.id, { edgeId: ASK_RUN_CHOICE });\n    this.restartFromStep.add(entryNode.id);",
        "    this.restartFromStep.add(entryNode.id);",
    ),
]


def run_suite():
    proc = subprocess.run([BASH, "scripts/scheduler-smoke/run.sh"], cwd=DESK, capture_output=True)
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
                print("      " + " | ".join(out.strip().splitlines()[-3:])[:400])
                bad += 1
            elif count == 0:
                print(f"XX {name}: 一条都没红 —— 断言不管用")
                bad += 1
            else:
                print(f"OK {name}: 红了 {count} 条")
                for line in fails[:3]:
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
