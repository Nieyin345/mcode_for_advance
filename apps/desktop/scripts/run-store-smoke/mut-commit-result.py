"""ARC-005 步② 变异验证:CommitResult 的三态 + 「成功信号只在 durable 后发」。

判据两条:
  A. `commitNow()` 必须把"内存已应用、写盘失败"报成 APPLIED_NOT_DURABLE,**不是** DURABLE;
  B. `saveRun` 的「运行已提交」成功信号**只在 durable 后发**。

各自撤掉后,run-store-smoke 的 ARC-005 块必须真红;逐字节还原后回到全绿。

⚠️ 用 Git bash 的绝对路径(WSL 的 bash 没 node,rc=127 会被误当成"红了")。
⚠️ 每次变异后逐字节还原并断言。锚点必须唯一,否则静默不生效。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
DB_TS = os.path.join(DESK, "src", "main", "store", "db.ts")
RSTORE_TS = os.path.join(DESK, "src", "main", "orchestration", "runStore.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# (标签, 目标文件, 旧文本, 新文本)
MUTATIONS = [
    (
        "M1 把 fsync 失败谎报成 DURABLE(APPLIED_NOT_DURABLE → DURABLE)",
        DB_TS,
        '  } catch (error) {\n'
        '    const err = error instanceof Error ? error : new Error(String(error));\n'
        '    recordPersistenceFailure(err);\n'
        '    return { outcome: "APPLIED_NOT_DURABLE", reason: err.message };\n'
        '  }\n',
        '  } catch (error) {\n'
        '    const err = error instanceof Error ? error : new Error(String(error));\n'
        '    recordPersistenceFailure(err);\n'
        '    return { outcome: "DURABLE" };\n'
        '  }\n',
    ),
    (
        "M2 非 durable 也发「运行已提交」成功信号(回退到混淆内存/磁盘的旧行为)",
        RSTORE_TS,
        '      if (commit.outcome !== "DURABLE") {',
        '      if (false) {',
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
    for name, target, old, new in MUTATIONS:
        with io.open(target, encoding="utf-8") as f:
            src = f.read()
        n = src.count(old)
        if n != 1:
            print(f"!! {name}: 锚点在 {os.path.basename(target)} 出现 {n} 次(要 1 次)—— 变异没做成")
            bad += 1
            continue
        bak = target + ".mutbak"
        shutil.copyfile(target, bak)
        try:
            with io.open(target, "w", encoding="utf-8", newline="") as f:
                f.write(src.replace(old, new))
            count, fails, concluded, out = run_suite()
            if not concluded:
                print(f"XX {name}: 套件没跑出结论 —— 变异验证无效")
                print(f"      {out.strip().splitlines()[-4:]}")
                bad += 1
            elif count == 0:
                print(f"XX {name}: 一条都没红 —— 断言不管用")
                bad += 1
            else:
                print(f"OK {name}: 红了 {count} 条")
                for line in fails[:8]:
                    print(f"      {line[:150]}")
        finally:
            shutil.copyfile(bak, target)
            os.remove(bak)
            with io.open(target, encoding="utf-8") as f:
                assert f.read() == src, f"{target} 没有逐字节还原!"
    print(f"\n{'全部被抓' if bad == 0 else f'{bad} 个变异没被抓到'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
