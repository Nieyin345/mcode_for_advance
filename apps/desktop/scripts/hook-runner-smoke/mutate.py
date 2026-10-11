"""变异验证(ARC-007 交付策略切片):逐条撤掉修复,确认 hook-runner-smoke 真变红,再逐字节还原。

仓规:新断言必须先撤掉修复、看它真的红,再装回去 —— 用**精确 str.replace(数出现次数)**,
绝不用 sed 跨行;还原后必须逐字节确认。变异 0 红要显式报出,不能当成功。
"""
import io, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))     # scripts/hook-runner-smoke
APP = os.path.dirname(os.path.dirname(HERE))           # apps/desktop
ROOT = os.path.dirname(os.path.dirname(APP))           # repo root (mcode)

POLICY = os.path.join(ROOT, "packages", "contracts", "src", "hook.ts")
RUNNER = os.path.join(APP, "src", "main", "hooks", "HookRunner.ts")
assert os.path.exists(POLICY), "missing hook.ts: " + POLICY
assert os.path.exists(RUNNER), "missing HookRunner.ts: " + RUNNER
PRISTINE = os.path.join(HERE, ".mutpristine")


def git_bash():
    cand = os.environ.get("MCODE_TEST_BASH") or r"C:\Program Files\Git\bin\bash.exe"
    return cand if os.path.exists(cand) else "bash"


BASH = git_bash()


def run_suite():
    r = subprocess.run([BASH, os.path.join(APP, "scripts/hook-runner-smoke/run.sh")],
                       capture_output=True, cwd=APP)
    txt = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")
    fails = [l for l in txt.splitlines() if l.strip().startswith("FAIL")]
    return len(fails), txt


# (label, file, old, new)
MUTATIONS = [
    # 并发:把 maxConcurrency 无视掉(退化成旧的"永远 1")—— mx-conc2 断言必红。
    ("maxConcurrency 被无视(退化回旧 Set=1)", POLICY,
     "  const cap = policy.maxConcurrency ?? 1;\n  // 速率只作",
     "  const cap = 1;\n  // 速率只作"),
    # DURABLE:假装支持(当 accept)—— DURABLE 那组断言必红。
    ("DURABLE 假装支持(当 accept)", POLICY,
     '      action: "unsupported",\n      reason:\n        "DURABLE_AT_LEAST_ONCE 尚未支持',
     '      action: "accept",\n      reason:\n        "DURABLE_AT_LEAST_ONCE 尚未支持'),
    # COALESCE:去掉合并兑现 —— 有界运行从 2 退回 1,断言必红。
    ("COALESCE 不兑现合并批次", RUNNER,
     "      const pending = this.coalescePending.get(spec.id);\n      if (pending !== undefined) {",
     "      const pending = undefined as HookPayload | undefined;\n      if (pending !== undefined) {"),
]


def mutate_and_run(label, path, old, new):
    orig = io.open(path, encoding="utf-8", newline="").read()
    try:
        n = orig.count(old)
        if n != 1:
            print("!! %s: anchor appears %d time(s), ineffective" % (label, n))
            return False
        io.open(path, "w", encoding="utf-8", newline="").write(orig.replace(old, new))
        red, txt = run_suite()
        print("%s %s: red=%d" % ("OK " if red > 0 else "BAD", label, red))
        if red > 0:
            for l in [x for x in txt.splitlines() if x.strip().startswith("FAIL")][:3]:
                print("      " + l.strip()[:120])
        return red > 0
    finally:
        io.open(path, "w", encoding="utf-8", newline="").write(orig)


# 先存一份 pristine 快照(逐字节还原的基准)
os.makedirs(PRISTINE, exist_ok=True)
for path in (POLICY, RUNNER):
    shutil.copyfile(path, os.path.join(PRISTINE, os.path.basename(path)))

allok = True
for label, path, old, new in MUTATIONS:
    try:
        ok = mutate_and_run(label, path, old, new)
    except Exception as e:  # noqa: BLE001
        print("!! %s: %s" % (label, e))
        ok = False
    allok = allok and ok

# 还原必须逐字节一致
for path in (POLICY, RUNNER):
    same = subprocess.run(["cmp", "-s", path, os.path.join(PRISTINE, os.path.basename(path))]).returncode == 0
    print("restore-check %s: %s" % (os.path.basename(path), "byte-identical" if same else "DIFFERS"))
    allok = allok and same

shutil.rmtree(PRISTINE, ignore_errors=True)
print("=== all mutations red and restored:", allok)
sys.exit(0 if allok else 1)
