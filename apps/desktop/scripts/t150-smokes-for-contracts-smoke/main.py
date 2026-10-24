#!/usr/bin/env python3
"""【T150】`smokes-for.py` 对 `packages/contracts/` 的答复，必须能用。

## 为什么需要这一套

`smokes-for.sh` 存在的唯一理由是回答「改这个文件该跑哪几套」。它在
`packages/contracts/` 上给的两个答案都不能用：

1. **崩**（症状 B）。`packages/contracts/src/modules.ts` 一查就 traceback：
   依赖图**能**到达 contracts（`capability-smoke` 用
   `"../../../../packages/contracts/src/capability.js"` 这种**相对 import**，
   `resolve()` 走 `.` 分支解析成功——这是对的）。漏的是显示基准：
   「上一跳」落在 `packages/contracts` 下时 `p.relative_to(DESKTOP)` 抛
   `ValueError`，整个脚本退出，连「覆盖了哪些」都打不出来。
   **为什么崩在 `moduleCapability.ts` 而不是 `modules.ts`**：`modules.ts:4` 有
   `import type ... from "./moduleCapability.js"`，`closure()` 顺着再走一跳。

2. **看不见声明型读取**（症状 A）。`app-control-smoke` 用
   `readFileSync` + `ts.createSourceFile` 读 `rpcMap.ts`——**那根本不是 import**，
   任何依赖图都追不到。而加一个 RPC 的人动的正是那个文件。
   修法是显式声明：`// @smoke-covers packages/contracts/src/ipc/rpcMap.ts`。

## 钉住什么（每条都有变异依据）

- **B1 不崩**：`modules.ts` 的退出码是 0，且 stdout 里没有 `Traceback`。
- **B2 退化路径仍然有信息**：输出里有 `经由 packages/contracts/` —— 证明它是
  「换了个基准显示」，不是被 `try/except` 吞掉。**这条是 B 的真正判据**：
  只断言「不崩」的话，把整段 `by_parent` 删掉也能过。
- **A1 声明生效**：`rpcMap.ts` 的输出里有 `app-control-smoke`，**且不在**
  「没有套件覆盖它」那句下面。后者是关键——现状就是「打印一句话、`rc == 0` 退出」，
  所以 `rc == 0` 是恒绿的，不能当判据。
- **A2 跳数是 0**：声明型依赖在距离上也该是最短的，否则会出现
  「在闭包里但算不出距离」那条内部矛盾告警。
- **A3 不谎报**：一个指向不存在文件的声明必须 `raise`，不能静默加覆盖。

## 变异（撤掉修复，看它红不红）

| 变异 | 应红 |
|---|---|
| `display_path` 换回 `p.relative_to(DESKTOP)` | B1 + B2 |
| 正则改回只认 `src/main/` | A1 |
| `suite_distance` 不看声明 | A2 |
| 删掉 `is_relative_to(MAIN)` 那道守卫 | A3（因为夹具会凭空加覆盖） |

Run: scripts/t150-smokes-for-contracts-smoke/run.sh
"""
import re
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
DESKTOP = SCRIPTS.parent
REPO = DESKTOP.parent.parent
SMOKES_FOR = SCRIPTS / "smokes-for.py"

# **Windows 控制台是 GBK**（`smokes-for.py` 自己也有这段）。子进程侧用
# `encoding="utf-8"` 解码，否则中文输出会变成替换字符，断言永远匹配不上。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

total = 0
failures = 0


def check(name: str, good: bool, detail: object = None) -> None:
    global total, failures
    total += 1
    if good:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}" + ("" if detail is None else f" — {detail!r}"))


def run(*args: str, cwd: Path | None = None, script: Path | None = None) -> subprocess.CompletedProcess[str]:
    # -I：隔离模式，别让夹具目录里的文件影响解释器 sys.path。
    # `script` 可以替换成夹具里那份副本 —— 夹具的 ROOT 是临时目录，
    # 而 `SMOKES_FOR` 的 __file__ 决定 ROOT，两者必须一致。
    return subprocess.run(
        [sys.executable, "-I", str(script or SMOKES_FOR), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=600, cwd=str(cwd or REPO),
    )


def suites_in(stdout: str) -> set[str]:
    """输出里出现的 `*-smoke` 名字集合。

    故意宽松（和 `tsx-coverage-smoke` 同一手法）：排版变了不影响，而
    「哪几套被列为覆盖」仍然钉死。
    """
    return set(re.findall(r"[A-Za-z0-9][A-Za-z0-9_.-]*-smoke\b", stdout))


def main() -> None:
    if not SMOKES_FOR.is_file():
        print(f"FAIL 找不到 {SMOKES_FOR}")
        sys.exit(1)

    # ── 症状 B：查询 packages/contracts 下的文件 ──────────────────────────
    print("\n[B] 查询 packages/contracts 下的文件不再崩，且退化路径仍给出「经由谁」")

    b = run("packages/contracts/src/modules.ts")
    check("B1 modules.ts 退出码是 0（不是 traceback 退出）", b.returncode == 0, b.returncode)
    check("B1 stdout 里没有 Traceback", "Traceback" not in (b.stdout + b.stderr),
          (b.stdout + b.stderr)[:400])
    # ★ 真正的判据：路径基准换了之后，「经由 X」那一行仍然存在，且指向
    #   contracts 下的那个**真实中间模块**。try/except 吞掉的话这行会消失。
    check("B2 仍然给出「经由 X」分组（不是被吞掉）", "经由 " in b.stdout, b.stdout[:400])
    check("B2 那一行指向 packages/contracts/ 下的真实中间模块",
          "经由 packages/contracts/src/moduleCapability.ts" in b.stdout, b.stdout[:400])
    check("B2 覆盖判断本身没丢：capability-smoke 仍在列表里",
          "capability-smoke" in suites_in(b.stdout), sorted(suites_in(b.stdout)))

    # ── 症状 A：声明型读取 ───────────────────────────────────────────────
    print("\n[A] readFileSync 读的 contracts 文件，靠显式声明出现在「必跑」里")

    a = run("packages/contracts/src/ipc/rpcMap.ts")
    out = a.stdout
    check("A1 rpcMap.ts 的输出里有 app-control-smoke", "app-control-smoke" in out, out[:400])
    # ★ 关键：现状是「打印一句『没有套件覆盖』然后 rc=0 退出」。所以必须断言
    #   它**不在**那句话的管辖下，否则 `rc == 0` 恒绿。
    check("A1 且不在「没有套件覆盖它」那句下面（rc==0 是恒绿的，不能当判据）",
          "没有套件覆盖它" not in out, out[:400])
    check("A2 声明型依赖算 0 跳（不触发「内部矛盾」告警）",
          "内部矛盾" not in out, out[:400])
    check("A2 它出现在「必跑」段里", "必跑" in out, out[:400])

    # ── 声明不能谎报：指向不存在文件的声明必须 raise ──────────────────────
    print("\n[C] 声明指向不存在的文件 → raise，不静默加覆盖")
    tmp = Path(tempfile.mkdtemp(prefix="mcode-t150-"))
    try:
        # 造一个最小仓库：scripts/<name>-smoke/main.ts 里写一条坏声明。
        fake_desktop = tmp / "apps" / "desktop"
        fake_scripts = fake_desktop / "scripts"
        suite = fake_scripts / "bogus-smoke"
        suite.mkdir(parents=True)
        (fake_scripts / "smokes-for.py").write_text(
            SMOKES_FOR.read_text(encoding="utf-8"), encoding="utf-8")
        (suite / "main.ts").write_text(
            '// @smoke-covers packages/contracts/src/does-not-exist.ts\n'
            'export const x = 1;\n', encoding="utf-8")
        (tmp / "apps" / "desktop" / "src" / "main").mkdir(parents=True)
        # ⚠️ 查询的文件必须真的存在 —— 否则 `main()` 在 `coverage()` 之前就
        # 报「找不到 X」退出，`@smoke-covers` 的校验根本走不到，这条断言
        # 会变成「验证一个从未执行的分支」（CLAUDE.md 第八条第 8 种）。
        (fake_desktop / "src" / "main" / "real.ts").write_text(
            "export const y = 1;\n", encoding="utf-8")

        # ⚠️ 用夹具里那份副本：`ROOT` 由脚本自身的 `__file__` 推出，
        # 跑真实那份的话 ROOT 仍是真仓库，夹具里的声明就落在真仓库的相对路径上。
        bad = run("src/main/real.ts", cwd=tmp, script=fake_scripts / "smokes-for.py")
        combined = bad.stdout + bad.stderr
        check("C1 坏声明让脚本失败（不是静默加覆盖）",
              bad.returncode != 0 or "invalid @smoke-covers" in combined,
              {"rc": bad.returncode, "out": combined[:300]})
        check("C1 报错里点名了那条声明",
              "does-not-exist.ts" in combined, combined[:300])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ── 覆盖性正控：本套确实在验真身，不是空转 ────────────────────────────
    print("\n[D] 覆盖性正控")
    sanity = run("src/main/appControl/policy.ts")
    check("D1 普通 src/main 文件仍然答得出来（没有把工具整体弄坏）",
          "必跑" in sanity.stdout and "app-control-smoke" in sanity.stdout,
          sanity.stdout[:300])
    check("D2 普通查询不出现「内部矛盾」（0 跳逻辑没有把别的路径带坏）",
          "内部矛盾" not in sanity.stdout, sanity.stdout[:300])

    print(f"\nt150-smokes-for-contracts-smoke: {total - failures}/{total} 通过")
    sys.exit(0 if failures == 0 else 1)


if __name__ == "__main__":
    main()
