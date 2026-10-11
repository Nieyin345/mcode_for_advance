"""MC-028 变异验证:db.ts 的 durable 落盘在真实 fsync/rename 故障下必须 fail-closed。

判据是 `writeSnapshot` 的**原子替换**纪律:写临时文件 → fsync → rename 覆盖目标。
撤掉它(直接截断写目标文件)后,一次被中断的写就**污染磁盘上最后一份完好快照** ——
run-store-smoke 的 MC-028 矩阵会红(磁盘不再逐字节等于旧快照 / 落盘故障没被击中)。

⚠️ 必须用 Git bash 的绝对路径(WSL 的 bash 没有 node,rc=127 会被误当成"红了")。
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
TARGET = os.path.join(DESK, "src", "main", "store", "db.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    (
        "M1 撤掉原子替换:直接截断写目标文件(一次中断写就毁掉最后一份完好快照)",
        "    fd = openSync(staging, \"wx\", 0o600);\n"
        "    ownsStaging = true;\n"
        "    writeFileSync(fd, data);\n"
        "    fsyncSync(fd);\n"
        "    closeSync(fd);\n"
        "    fd = undefined;\n"
        "    renameSync(staging, target);\n"
        "    ownsStaging = false;\n"
        "    return data.length;",
        "    fd = openSync(target, \"w\", 0o600);\n"
        "    writeFileSync(fd, data);\n"
        "    fsyncSync(fd);\n"
        "    closeSync(fd);\n"
        "    fd = undefined;\n"
        "    return data.length;",
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
                for line in fails[:6]:
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
