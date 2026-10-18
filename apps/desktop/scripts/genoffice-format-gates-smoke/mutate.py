"""变异验证（ARC-007 G2 逐格式编辑往返）：逐条撤掉修复，看新断言真红，再逐字节还原。

覆盖（每项只改一处，精确 str.replace 且锚点必须恰好 1 次）：
  1. ipc/document.ts  pptx 路由退回 docsApply  —— `document.edit` 曾无条件走 docs apply，
     pptx 编辑会报 "document.xml has no <w:body>"；撤掉 slides 分支后
     G2 pptx「editByKind → slides apply 成功」与「再 read 看得到文本」必须红。
  2. ipc/document.ts  xlsx 路由退回 docsApply  —— 同上，sheet 分支撤掉后
     G2 xlsx 两条编辑断言必须红。
  3. genofficeCli.ts  slidesApply 撤围栏      —— 把 requireWorkspacePath 换成 null，
     G4「slides apply：工作区外文件 → refused」与「字节未动」必须红。
  4. genofficeCli.ts  sheetApply 撤围栏       —— 同上，G4 sheet 两条必须红。
  5. genofficeCli.ts  slidesApply 丢 dryRun  —— 不向 CLI 传 --dry-run，
     G5「slides dry-run 不改文件」必须红。
  6. genofficeCli.ts  sheetApply 丢 dryRun   —— 同上，G5 sheet 那条必须红。

用法（Git Bash / 任意 PATH 有 bash 的环境）：
    python apps/desktop/scripts/genoffice-format-gates-smoke/mutate.py
退出码 0 = 所有变异都验证出「真红且逐字节还原」。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
IPC = os.path.join(DESK, "src", "main", "ipc", "document.ts")
CLI = os.path.join(DESK, "src", "main", "document", "genofficeCli.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# (文件, 说明, OLD, NEW, [必须变红的断言片段])
MUTATIONS = [
    (IPC, "document.ts pptx 路由退回 docsApply",
     '''    if (ext === "pptx" || ext === "pptm" || ext === "potx" || ext === "odp") {
      return slidesApply(p, filePath, ops, { ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}) });
    }
''', '', ["G2 pptx：editByKind → slides apply 成功", "G2 pptx ★ 再 read 看得到 apply 插入的文本"]),

    (IPC, "document.ts xlsx 路由退回 docsApply",
     '''    if (ext === "xlsx" || ext === "xlsm" || ext === "xltx" || ext === "ods") {
      return sheetApply(p, filePath, ops, { ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}) });
    }
''', '', ["G2 xlsx：editByKind → sheet apply 成功", "G2 xlsx ★ 编辑后再 check 看得到新单元格"]),

    (CLI, "genofficeCli.ts slidesApply 撤围栏",
     '''  const refusal = requireWorkspacePath(ports, file, "演示文稿路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["slides", "apply", file, "--ops", "-", "--json"];''',
     '''  const refusal = null as string | null;
  const args = ["slides", "apply", file, "--ops", "-", "--json"];''',
     ["G4 slides apply：工作区外文件 → refused", "G4 slides apply：拒绝后工作区外文件字节未动"]),

    (CLI, "genofficeCli.ts sheetApply 撤围栏",
     '''  const refusal = requireWorkspacePath(ports, file, "表格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["sheet", "apply", file, "--ops", "-", "--json"];''',
     '''  const refusal = null as string | null;
  const args = ["sheet", "apply", file, "--ops", "-", "--json"];''',
     ["G4 sheet apply：工作区外文件 → refused", "G4 sheet apply：拒绝后工作区外文件字节未动"]),

    (CLI, "genofficeCli.ts slidesApply 丢 dryRun",
     '''  const args = ["slides", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");''',
     '''  const args = ["slides", "apply", file, "--ops", "-", "--json"];''',
     ["G5 ★ slides dry-run 不改文件"]),

    (CLI, "genofficeCli.ts sheetApply 丢 dryRun",
     '''  const args = ["sheet", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");''',
     '''  const args = ["sheet", "apply", file, "--ops", "-", "--json"];''',
     ["G5 ★ sheet dry-run 不改文件"]),
]


def run() -> tuple[int, list[str], str]:
    p = subprocess.run(
        [BASH, "scripts/genoffice-format-gates-smoke/run.sh"],
        cwd=DESK, capture_output=True,
    )
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip()[:160] for l in out.splitlines() if l.strip().startswith("FAIL")})
    summary = [l for l in out.splitlines() if "genoffice-format-gates-smoke:" in l and "/" in l]
    tail = summary[-1].strip() if summary else ("SKIP/构建失败:" + out.strip().splitlines()[-1][:160] if out.strip() else "?")
    return len(fails), fails, tail


def main() -> None:
    bad = 0
    for path, label, old, new, must_fail in MUTATIONS:
        src = io.open(path, encoding="utf-8").read()
        if src.count(old) != 1:
            print(f"XX {label}: 锚点 {src.count(old)} 次（要 1），变异锚点漂了")
            bad += 1
            continue
        bak = path + ".mutbak"
        shutil.copyfile(path, bak)
        original = src.encode("utf-8")
        try:
            io.open(path, "w", encoding="utf-8", newline="").write(src.replace(old, new))
            count, fails, tail = run()
            missing = [m for m in must_fail if not any(m in f for f in fails)]
            if count == 0:
                print(f"XX {label}: 一条没红 —— 断言不管用（{tail}）")
                bad += 1
            elif missing:
                print(f"XX {label}: 红了 {count} 条，但目标断言未红: {missing}")
                for l in fails[:6]:
                    print("     ", l)
                bad += 1
            else:
                print(f"OK {label}: 红了 {count} 条（{tail}）")
                for l in fails[:3]:
                    print("     ", l)
        finally:
            shutil.copyfile(bak, path)
            os.remove(bak)
            restored = io.open(path, "rb").read()
            if restored != original:
                print(f"XX {label}: 还原后字节不一致（cmp 失败）")
                bad += 1
            else:
                print(f"   还原逐字节一致（cmp ok）")

    if bad == 0:
        print("\nmutate: 全部变异验出真红且逐字节还原")
    else:
        print(f"\nmutate: {bad} 项有问题")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
