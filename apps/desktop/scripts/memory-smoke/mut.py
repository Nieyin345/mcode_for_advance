"""变异验证:撤掉「注入记忆」的改动,确认 memory-smoke 的场景 5b 真的红。

⚠️ **必须用 Git bash 的绝对路径。** 这台机器上 `subprocess.run(["bash", ...])` 会挑到
WSL 那个 bash,它看不见 node,rc=127、输出是 `/usr/bin/env: 'node': No such file…`。
第一版就是这么跑的,而当时脚本把"没跑出结论"也当成"红了 1 条",于是**五个变异全报 OK**
—— 那是最坏的一种假绿:它让整套变异验证看起来通过了,实际上一次都没跑起来。

两处防线,缺一不可:
  1. 走 Git bash 绝对路径;
  2. `run_suite` 把「没跑出结论」**单独报出来**,绝不算成红。

⚠️ 每次变异后必须逐字节还原并断言,`finally` 里也要验。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
TYPES = os.path.join(DESK, "src", "main", "orchestration", "nodeTypes.ts")

# `shutil.which("bash")` 在这台机器上给的是 WSL 的 —— 那条路上没有 node。
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        "M1 子 agent 那一份不摆这一格(等于回到修复前)",
        "    ...ioParams(),\n    ...memoryParam(),\n    ...returnToChatParam(),",
        "    ...ioParams(),\n    ...returnToChatParam(),",
    ),
    (
        "M2 主代理那一份不摆(它跑在主对话里,最容易漏)",
        "    criteriaParam(),\n    ...ioParams(),\n    ...memoryParam(),",
        "    criteriaParam(),\n    ...ioParams(),",
    ),
    (
        # ⚠️ 锚点要取**那一行本身**。第一版取的是它上面那两行注释 + `...ioParams(),`,
        # 于是变异删掉的是 `ioParams()`、`memoryParam()` 原样留着 —— 断言当然一条不红。
        # 那是锚点选错,不是断言不管用;两者在输出里长得一模一样。
        "M3 对话节点那一份不摆",
        '      // 真生效的 —— 跟「回到主对话」那种"本来就在那儿、配了不算数"不是一回事。\n      ...memoryParam(),',
        '      // 真生效的 —— 跟「回到主对话」那种"本来就在那儿、配了不算数"不是一回事。',
    ),
    (
        "M4 摆错了种类(做成文本框 —— 用户填不出 \"on\",等于还是个死功能)",
        '      key: MEMORY_PARAM_KEY,\n      kind: "boolean",',
        '      key: MEMORY_PARAM_KEY,\n      kind: "longtext",',
    ),
    (
        # 锚点带 `outputs: [{ key: "exitCode"` —— 光 `...outputVarsParam(),` 在源文件里
        # 出现两次(code 与 command 各一次),count != 1 变异就做不成。
        "M5 顺手给 code 也摆上(填了不生效的控件)",
        '      ...outputVarsParam(),\n    ],\n    outputs: [{ key: "exitCode"',
        '      ...outputVarsParam(),\n      ...memoryParam(),\n    ],\n    outputs: [{ key: "exitCode"',
    ),
]


def run_suite():
    """→ (红的条数, 红的那些行, 有没有跑出结论)。"""
    proc = subprocess.run([BASH, "scripts/memory-smoke/run.sh"],
                          cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("FAIL")]
    concluded = "passed" in out
    return len(fails), fails, concluded, out


def main() -> int:
    bad = 0
    for name, old, new in MUTATIONS:
        with io.open(TYPES, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {name}: 锚点在源文件里出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = TYPES + ".mutbak"
        shutil.copyfile(TYPES, bak)
        try:
            with io.open(TYPES, "w", encoding="utf-8", newline="") as f:
                f.write(src.replace(old, new))
            count, fails, concluded, out = run_suite()
            if not concluded:
                # **这一条最要紧。** 套件没跑起来时报"红了"是最坏的假绿。
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
            shutil.copyfile(bak, TYPES)
            os.remove(bak)
            with io.open(TYPES, encoding="utf-8") as f:
                assert f.read() == src, f"{TYPES} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
