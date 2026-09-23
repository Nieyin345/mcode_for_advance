"""变异验证:把"续轮崩了要收尾"退回"不收尾",看 longtask-smoke 真的红。

⚠️ 变异必须**语法仍然正确** —— 第一版把 `try {` 换成 `if (false) {` 导致 catch 语法错、
打包就失败(脚本报"没跑出结论")。那是变异方式不对,不是断言不管用。
现在改成"去掉 active.delete 那一句":语法没问题,但任务不会被收尾。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "longtask", "taskRunner.ts")

GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# 让"收尾"不生效 —— 锚点取 `finish(...)` 那段里**唯一**的一句("续轮出错"只在
# 我新加的那个 catch 里出现)。去掉它,任务就没人标 blocked,永远停在 running。
OLD = """          const done = LongTaskRepo.finish(
            entry.id,
            "blocked",
            `续轮出错(${(err as Error).message})—— 可在对话里发「继续」接上`,
          );"""
NEW = "          // MUTANT: 不收尾"


def run_suite():
    proc = subprocess.run([BASH, "scripts/longtask-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("FAIL") or ln.strip().startswith("✗")]
    concluded = "checks," in out
    return len(fails), fails, concluded, out


def main() -> int:
    src = io.open(SRC, encoding="utf-8").read()
    n = src.count(OLD)
    if n != 1:
        print(f"!! 锚点在源文件里出现 {n} 次(要 1)—— 变异没做成")
        return 1
    bak = SRC + ".mutbak"
    shutil.copyfile(SRC, bak)
    try:
        io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
        count, fails, concluded, out = run_suite()
        if not concluded:
            print("XX 套件没跑出结论 —— 变异验证无效")
            print(f"   {out.strip().splitlines()[-3:]}")
            return 1
        if count == 0:
            print("XX 一条都没红 —— 断言不管用")
            return 1
        print(f"OK 续轮崩了不收尾: 红了 {count} 条")
        for line in fails[:3]:
            print(f"   {line[:120]}")
        print("\n全部被抓")
        return 0
    finally:
        shutil.copyfile(bak, SRC)
        os.remove(bak)
        assert io.open(SRC, encoding="utf-8").read() == src, f"{SRC} 没有逐字节还原!"


if __name__ == "__main__":
    raise SystemExit(main())
