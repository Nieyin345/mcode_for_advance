"""变异验证：逐条撤掉 fileSnapshot.ts 的修复，确认 file-snapshot-smoke 真的变红。

仓规：新写的断言必须先撤掉修复、看它真的红，再装回去 —— 否则"绿着"可能只是
断言测的是别人的职责、或者根本没覆盖到被改的那段。

每次变异：备份 → 精确 str.replace（并数出现次数）→ 跑套件 → 逐字节还原。
"""
import io, os, subprocess, sys, shutil

# 本脚本住在 apps/desktop/scripts/file-snapshot-smoke/ 下。所有路径都从 HERE 推出来，
# 与调用时的 cwd 无关（上一版吃了这个亏：从别的目录跑时就找不到源文件）。
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))            # → apps/desktop
SRC = os.path.join(APP, "src/main/lib/fileSnapshot.ts")
BAK = os.path.join(APP, ".tmp/fileSnapshot.ts.mutbak")
RUN = os.path.join(APP, "scripts/file-snapshot-smoke/run.sh")

MUTATIONS = [
    ("MC-006 revert to startsWith('..')",
     '  if (rel === "..") return false;\n'
     '  if (rel.startsWith(`..${sep}`)) return false;',
     '  if (rel.startsWith("..")) return false;'),

    ("MC-001 drop physical containment",
     "  return pathWithin(cwd, abs);",
     "  return true;"),

    ("MC-005 revert net-zero to adds===0&&dels===0",
     "      if (after === null) {\n"
     "        if (!rec.exists) {\n"
     "          this.originals.delete(path);\n"
     "          continue;\n"
     "        }\n"
     "      } else if (after === before) {\n"
     "        this.originals.delete(path);\n"
     "        continue;\n"
     "      }",
     "      // (mutation: old net-zero rule)"),

    ("MC-002 disable conflict detection",
     "      if (current !== null && hashText(current) !== entry.afterHash) {",
     "      if (false && current !== null && hashText(current) !== entry.afterHash) {"),

    ("MC-003 drop the diff cell cap",
     "  if ((m + 1) * (n + 1) > MAX_DIFF_CELLS) {",
     "  if (false) {"),

    ("MC-008 drop the in-flight placeholder",
     "    const pending = this.inflight.get(abs);\n    if (pending) {",
     "    const pending = this.inflight.get(abs);\n    if (false && pending) {"),
]


def git_bash():
    # Use Git Bash, not bare `bash`: a python-inherited PATH on Windows can hit
    # the WSL bash.exe first (observed), whose PATH has no node, making the
    # esbuild `#!/usr/bin/env node` launcher exit 127 with zero red -- a false
    # green.
    cand = os.environ.get("MCODE_TEST_BASH") or r"C:\Program Files\Git\bin\bash.exe"
    return cand if os.path.exists(cand) else "bash"


BASH = git_bash()


def run_suite():
    # Capture BYTES then decode: the suite output has Chinese and the Windows
    # console codepage is GBK, so text=True can blow up in the reader thread
    # and leave the source in its mutated state.
    r = subprocess.run([BASH, RUN], capture_output=True, cwd=APP)
    raw = (r.stdout or b"") + (r.stderr or b"")
    out = raw.decode("utf-8", errors="replace")
    fails = [l for l in out.splitlines() if l.strip().startswith("FAIL")]
    return r.returncode, fails, out


os.makedirs(os.path.dirname(BAK), exist_ok=True)
orig = io.open(SRC, encoding="utf-8", newline="").read()
shutil.copyfile(SRC, BAK)

ok = True
for name, old, new in MUTATIONS:
    s = io.open(SRC, encoding="utf-8", newline="").read()
    n = s.count(old)
    if n != 1:
        print("!! %s: anchor appears %d time(s), mutation ineffective" % (name, n))
        ok = False
        io.open(SRC, "w", encoding="utf-8", newline="").write(orig)
        continue
    io.open(SRC, "w", encoding="utf-8", newline="").write(s.replace(old, new))
    code, fails, out = run_suite()
    io.open(SRC, "w", encoding="utf-8", newline="").write(orig)
    restored = io.open(SRC, encoding="utf-8", newline="").read() == orig
    red = len(fails) > 0
    print("%s %s: red=%d restored=%s rc=%d" % ("OK " if (red and restored) else "BAD", name, len(fails), restored, code))
    for f in fails[:3]:
        print("      " + f.strip()[:110])
    if not (red and restored):
        ok = False

print("=== all mutations red and byte-restored:", ok)
sys.exit(0 if ok else 1)
