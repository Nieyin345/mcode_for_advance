"""MC-029 读侧修复的变异验证 —— 逐条撤掉守卫,确认对应断言真变红,再逐字节还原。

判据(与台账验收一致):
  M1 撤写侧守卫:commit 的 corrupt 拒绝失效 → 「原字节一字未动」类断言必须红。
  M2 撤读侧报告:isArchiveCorrupt() 恒 false → list/resume/run/approve/abandon 的
     区分断言必须红(run 的断言还会逐字暴露「会话已建、进度回写失败」)。
  M3 撤空串分类:空串被当 corrupt → 「空串 → absent,不误报损坏」必须红。

全程只动 unattendedPlanStore.ts 一个源文件;每个变异跑完立即还原,最后逐字节确认。
"""
import io, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))  # apps/desktop
STORE = os.path.join(APP, "src", "main", "appServices", "unattendedPlanStore.ts")

# Git Bash 只认 /d/... 形式的路径 —— 直接喂 Windows 反斜杠路径会被吞掉分隔符。
# 且必须显式找 git-bash.exe:PATH 上的 `bash` 可能是 WSL 的,看不到 /d/ 盘。
def sh_path(p):
    pp = os.path.abspath(p).replace("\\", "/")
    if len(pp) > 1 and pp[1] == ":":
        pp = "/" + pp[0].lower() + pp[2:]
    return pp

RUN_SH = sh_path(os.path.join(HERE, "run.sh"))

_cand = os.environ.get("MCODE_TEST_BASH") or r"C:\Program Files\Git\bin\bash.exe"
BASH = _cand if os.path.exists(_cand) else "bash"

MUTATIONS = [
    ("M1 撤写侧守卫(commit 的 corrupt 拒绝)", STORE,
     "    if (this.corrupt) {",
     "    if (this.corrupt && false) {"),
    ("M2 撤读侧报告(isArchiveCorrupt 恒 false)", STORE,
     "  isArchiveCorrupt(): boolean {\n    return this.corrupt;\n  }",
     "  isArchiveCorrupt(): boolean {\n    return false;\n  }"),
    ("M3 撤空串分类(空串不再判 absent)", STORE,
     '  if (json == null || json === "") return "absent";',
     '  if (json == null) return "absent";'),
]


def run_suite():
    r = subprocess.run([BASH, RUN_SH], capture_output=True, cwd=APP, timeout=600)
    out = (r.stdout or b"") + (r.stderr or b"")
    txt = out.decode("utf-8", errors="replace")
    fails = [l for l in txt.splitlines() if l.strip().startswith("FAIL")]
    return len(fails), fails, txt


def main():
    bak = STORE + ".mutbak"
    orig = io.open(STORE, encoding="utf-8", newline="").read()
    io.open(bak, "w", encoding="utf-8", newline="").write(orig)
    allok = True
    try:
        for label, path, old, new in MUTATIONS:
            cur = io.open(path, encoding="utf-8", newline="").read()
            n = cur.count(old)
            if n != 1:
                print("!! %s: anchor appears %d time(s), ineffective" % (label, n))
                allok = False
                continue
            io.open(path, "w", encoding="utf-8", newline="").write(cur.replace(old, new))
            red, fails, txt = run_suite()
            summary = [l for l in txt.splitlines() if "通过" in l]
            print("== %s: red=%d  (%s)" % (label, red, summary[-1].strip() if summary else "?"))
            for l in fails[:12]:
                print("     " + l.strip()[:150])
            if red == 0:
                print("!! %s: 变异未生效(0 条红)—— 断言没有真正钉住这个守卫" % label)
                allok = False
            # 还原
            io.open(path, "w", encoding="utf-8", newline="").write(orig)
    finally:
        io.open(STORE, "w", encoding="utf-8", newline="").write(orig)
        if os.path.exists(bak):
            os.remove(bak)

    # 逐字节还原确认
    same = io.open(STORE, encoding="utf-8", newline="").read() == orig
    print("restored byte-identical:", same)
    allok = allok and same
    print("=== all mutations red and restored:", allok)
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
