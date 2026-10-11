"""变异验证:撤掉 automationRunner/runner 的修复,确认 automation-smoke / maint-m28-smoke 变红。

仓规:新断言必须先撤掉修复、看它真的红,再装回去。这些源文件是**上一个(被叫停的)子代理**
写的,它的断言没做过变异验证 —— 这里补上。
"""
import io, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))  # apps/desktop
ROOT = os.path.dirname(APP)

AUTO = os.path.join(APP, "src/main/orchestration/automationRunner.ts")
RUNNER = os.path.join(APP, "src/main/orchestration/runner.ts")


def git_bash():
    cand = os.environ.get("MCODE_TEST_BASH") or r"C:\Program Files\Git\bin\bash.exe"
    return cand if os.path.exists(cand) else "bash"


BASH = git_bash()


def run_suite(name):
    r = subprocess.run([BASH, os.path.join(APP, "scripts", name, "run.sh")], capture_output=True, cwd=APP)
    out = (r.stdout or b"") + (r.stderr or b"")
    txt = out.decode("utf-8", errors="replace")
    fails = [l for l in txt.splitlines() if l.strip().startswith("FAIL")]
    return len(fails), txt


# (label, file, old, new, suite)
MUTATIONS = [
    # MC-021: 去掉"启动即 tick" —— 那条断言(start 之后同分钟不再多跑)会红
    ("MC-021 去掉启动即 tick", AUTO,
     "    this.onTick();\n    // **先把\"睡过去的那几天\"结算掉",
     "    // (mutation: boot tick removed)\n    // **先把\"睡过去的那几天\"结算掉",
     "automation-smoke"),
    # MC-022: 空批也照跑 —— "收口时整批都不在了 → 这一次不跑" 会红
    ("MC-022 空批照跑", AUTO,
     '        if (files.length === 0) {\n          // 这一格刚在计时器回调开头被删掉(见上一行 `pendingFires.delete`),不重建\n          // —— 下一次 `onFsChange` 会按需建新的一格。只记一行,别静默。\n          log.info(`[automation] 「${trigger.title}」攒着的文件在收口前都不在了,这一次不跑`);\n          return;\n        }',
     '        // (mutation: empty batch still fires)',
     "automation-smoke"),
    # MC-020: 去掉退避记录 —— MC-020 的断言会红
    ("MC-020 去掉退避重挂", AUTO,
     "      this.scheduleWatchRetry(entry);\n    }\n  }\n\n  /**\n   * 给一个**没挂上**的目录排下一次重挂",
     "      // (mutation: no retry scheduled)\n    }\n  }\n\n  /**\n   * 给一个**没挂上**的目录排下一次重挂",
     "automation-smoke"),
    # MC-028: 忽略收口 writeRun 的返回值 —— maint-m28 的源级断言会红
    ("MC-028 收口忽略存盘返回值", RUNNER,
     '    if (!writeRun(settled, result?.state ?? latest.state, true)) {',
     '    writeRun(settled, result?.state ?? latest.state, true);\n    if (false) {',
     "maint-m28-smoke"),
]


def mutate_and_run(label, path, old, new, suite):
    orig = io.open(path, encoding="utf-8", newline="").read()
    bak = path + ".mutbak"
    shutil.copyfile(path, bak)
    try:
        n = orig.count(old)
        if n != 1:
            print("!! %s: anchor appears %d time(s), ineffective" % (label, n))
            return False
        io.open(path, "w", encoding="utf-8", newline="").write(orig.replace(old, new))
        red, txt = run_suite(suite)
        print("%s %s [%s]: red=%d" % ("OK " if red > 0 else "BAD", label, suite, red))
        if red > 0:
            for l in [x for x in txt.splitlines() if x.strip().startswith("FAIL")][:2]:
                print("      " + l.strip()[:110])
        return red > 0
    finally:
        io.open(path, "w", encoding="utf-8", newline="").write(orig)
        os.remove(bak)


allok = True
for label, path, old, new, suite in MUTATIONS:
    try:
        ok = mutate_and_run(label, path, old, new, suite)
    except Exception as e:  # noqa: BLE001
        print("!! %s: %s" % (label, e))
        ok = False
    allok = allok and ok

# 源文件必须逐字节还原
for p in (AUTO, RUNNER):
    r = subprocess.run(["git", "diff", "--quiet", "--", p], cwd=ROOT)
    print("restored %s: %s" % (os.path.basename(p), "clean-vs-HEAD?" ))
print("=== all mutations red and restored:", allok)
sys.exit(0 if allok else 1)
