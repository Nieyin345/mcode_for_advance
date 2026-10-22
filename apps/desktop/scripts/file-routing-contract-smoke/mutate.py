"""T17 变异验证：把契约层某条判定改错，回归必须**真红**，然后逐字节还原。

三个变异，各自打在不同判据面上：
  1. `documentKind.ts` 的 `OFFICE_FAMILY.pptx` 从 "slides" 改成 "docs"
     —— 模拟"把 .pptx 判成 docx"（卡面点名的那条）。
     必须红：第 4 节 `pptx → slides` / `PPTX 同样 → slides`，以及第 3 节 `.pptx`
     不是二进制预览档的反向正控（家族与种类对账）。
  2. `documentKind.ts` 的 `MARKDOWN` 集合里去掉 "markdown"
     —— 模拟"漏掉一个格式别名"。
     必须红：第 1 节 `a.Markdown → markdown`、第 3 节 `isMarkdownDocumentPath(a.markdown)`。
  3. `documentKind.ts` 的 `IMAGE` 集合里去掉 "svg"
     —— 模拟"图片表漏项"。
     必须红：第 1 节 `a.svg → image`、第 3 节 `isImageDocumentPath(a.svg)`、
     以及第 6 节的**行为等价**断言（生产薄封装与旧实现分家）。

每个变异都：
  - 用 `str.replace` 精确改（锚点必须恰好出现 1 次，否则判为锚点漂移）；
  - 跑套件，要求 grep 得到预期断言的 FAIL；
  - `finally` 还原并**逐字节比较**（`open(rb).read() == original`）。

用法（Git Bash / 任意 PATH 有 bash 的环境）：
    python apps/desktop/scripts/file-routing-contract-smoke/mutate.py
退出码 0 = 全部变异真红且逐字节还原。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
CONTRACT = os.path.join(DESK, "..", "..", "packages", "contracts", "src", "documentKind.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

MUTATIONS = [
    ("契约层把 .pptx 判成 docs（家族表）",
     '  pptx: "slides", pptm: "slides", potx: "slides", odp: "slides",',
     '  pptx: "docs", pptm: "docs", potx: "docs", odp: "docs",',
     ["pptx → slides", "PPTX 同样 → slides"]),
    ("契约层漏掉 markdown 别名",
     'const MARKDOWN: ReadonlySet<string> = new Set(["md", "markdown"]);',
     'const MARKDOWN: ReadonlySet<string> = new Set(["md"]);',
     ["a.Markdown → markdown", "isMarkdownDocumentPath(\"a.markdown\")"]),
    ("契约层图片表漏掉 svg",
     '"png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "tif", "tiff", "avif",',
     '"png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "avif",',
     ["a.svg → image", "isImageDocumentPath(\"a.svg\")", "★ 行为等价"]),
]


def run():
    p = subprocess.run(
        [BASH, "scripts/file-routing-contract-smoke/run.sh"],
        cwd=DESK, capture_output=True,
    )
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip()[:200] for l in out.splitlines() if l.strip().startswith("FAIL")})
    summary = [l for l in out.splitlines() if "file-routing-contract-smoke:" in l and "/" in l]
    tail = summary[-1].strip() if summary else (
        "崩溃/构建失败:" + (out.strip().splitlines()[-1][:200] if out.strip() else "?"))
    return len(fails), fails, tail


def main() -> None:
    bad = 0
    for label, old, new, must_fail in MUTATIONS:
        src = io.open(CONTRACT, encoding="utf-8").read()
        occurrences = src.count(old)
        if occurrences != 1:
            print(f"XX {label}: 锚点 {occurrences} 次（要 1），变异锚点漂了")
            bad += 1
            continue
        bak = CONTRACT + ".mutbak"
        shutil.copyfile(CONTRACT, bak)
        original = src.encode("utf-8")
        try:
            io.open(CONTRACT, "w", encoding="utf-8", newline="").write(src.replace(old, new))
            count, fails, tail = run()
            missing = [m for m in must_fail if not any(m in f for f in fails)]
            if count == 0:
                print(f"XX {label}: 一条没红 —— 断言不管用（{tail}）")
                bad += 1
            elif missing:
                print(f"XX {label}: 红了 {count} 条，但目标断言未红: {missing}")
                for l in fails[:8]:
                    print("     ", l)
                bad += 1
            else:
                print(f"OK {label}: 红了 {count} 条（{tail}）")
                for l in fails[:3]:
                    print("     ", l)
        finally:
            shutil.copyfile(bak, CONTRACT)
            os.remove(bak)
            restored = io.open(CONTRACT, "rb").read()
            if restored != original:
                print(f"XX {label}: 还原后字节不一致（cmp 失败）")
                bad += 1
            else:
                print("   还原逐字节一致（cmp ok）")

    if bad == 0:
        print("\nmutate: 全部变异验出真红且逐字节还原")
    else:
        print(f"\nmutate: {bad} 项有问题")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
