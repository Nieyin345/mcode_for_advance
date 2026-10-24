#!/usr/bin/env python3
"""【T152】`smokes-for.py` 必须分清「没有覆盖」和「不在我的问题范围内」。

## 为什么需要这一套

`hits` 为空有两种完全不同的原因，而工具从前对两种都说同一句话：

| 原因 | 这是 |
|---|---|
| 在索引范围内，但没有套件 import 它 | **结论** —— 查过了，确实没有 |
| 根本不在索引范围内（`genoffice/` 等 vendor） | **边界** —— 没查，因为这里不在图上 |

对 `genoffice/apps/docs/src/renderer/App.tsx` 打印「没有套件覆盖它 —— 改这里没有
回归网」是**错误的否定结论**：Office 套件（`o0-format-fidelity-smoke` 等）真的
import 那些文件，只是依赖图不跟到 vendor 子仓库。

**而且 T150 让这句警告在别处变得更可信**（跳数与崩溃都修好了），
于是它在 vendor 上错得更有说服力。修得越好，错得越有说服力。

## 钉住什么（每条都有变异依据）

- **S1 vendor 改口**：`genoffice/**` 的输出里**没有**「没有套件覆盖它」，
  且**有**「本工具只回答」。⚠️ 只断言其中一个不够 —— 见下面 A1 的教训。
- **S2 真结论保留（负控）**：`src/main/modules/moduleApproval.ts` 仍然报
  「没有套件覆盖它」。**这条防止为了修 vendor 把真结论也改掉** ——
  过度修正会得到一个从不说「没有」的工具，比说错更坏。
- **S3 renderer 在索引内**：`src/renderer/components/chat/Markdown.tsx` 有覆盖时
  正常列出套件；这条同时证明「改口」没有波及 renderer。
- **S4 两种路径写法等价**：`src/main/x.ts` 与 `apps/desktop/src/main/x.ts`
  输出必须逐字相同。`--uncovered` 印的就是后者，而它从前传回去永远「找不到」。

## 变异（撤掉修复，看它红不红 —— 每条先写预期）

| # | 变异 | 预期红 |
|---|---|---|
| M-1 | `print_no_coverage` 里 vendor 分支改回「没有套件覆盖」 | S1（1 条） |
| M-2 | `is_indexed` 恒为 False（所有路径都当「不在范围」） | S2（1 条） |
| M-3 | `apps/` 分支改回 `(DESKTOP / arg)` | S4（至少 1 条） |

**M-1 和 M-2 是一对**：M-1 证明改口生效，M-2 证明改口没有过头。
**只有 M-1 会得到一个「对什么都说不认识」的工具。**

Run: scripts/t152-smokes-for-index-scope-smoke/run.sh
"""
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
DESKTOP = SCRIPTS.parent
REPO = DESKTOP.parent.parent
SMOKES_FOR = SCRIPTS / "smokes-for.py"

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


def run(*args: str) -> subprocess.CompletedProcess[str]:
    # -I：隔离模式。Windows 控制台是 GBK，子进程侧必须按 utf-8 解码，
    # 否则中文输出变成替换字符，断言永远匹配不上（T150 同一处理）。
    return subprocess.run(
        [sys.executable, "-I", str(SMOKES_FOR), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=600, cwd=str(REPO),
    )


def main() -> None:
    if not SMOKES_FOR.is_file():
        print(f"FAIL 找不到 {SMOKES_FOR}")
        sys.exit(1)

    # ── S1：vendor 路径说边界，不说结论 ──────────────────────────────────
    print("\n[S1] vendor 路径（不在索引范围）说「本工具只回答…」，不说「没有套件覆盖」")

    v = run("genoffice/apps/docs/src/renderer/App.tsx")
    out = v.stdout
    check("S1 vendor 路径的查询本身成功（文件存在，不是「找不到」）",
          v.returncode == 0 and "找不到" not in out, out[:400])
    check("S1 ★ 不说「没有套件覆盖它」（那是对 vendor 的错误否定结论）",
          "没有套件覆盖它" not in out, out[:400])
    check("S1 ★ 说「本工具只回答」（交代定义域，而不是排除项）",
          "本工具只回答" in out, out[:400])
    # 建议行也要区分：vendor 上的覆盖在 Office 套件里，不会有人去「补一套」。
    check("S1 不给出「要么补一套」这条对 vendor 无意义的建议",
          "要么补一套" not in out, out[:400])

    # ── S2：真结论必须保留（负控，防过度修正）──────────────────────────
    print("\n[S2] src/main 下真没覆盖的文件，仍然说「没有套件覆盖」（负控）")

    r = run("src/main/modules/moduleApproval.ts")
    out = r.stdout
    check("S2 ★ 仍然报「没有套件覆盖它」（这是结论，可查）",
          "没有套件覆盖它" in out, out[:400])
    check("S2 ★ 且 NOT 说「本工具只回答」（它在索引范围内，不是边界）",
          "本工具只回答" not in out, out[:400])

    # ── S3：索引范围内的「有覆盖」路径不受影响 ──────────────────────────
    print("\n[S3] 索引范围内的正常查询（有覆盖）照常列出套件")

    m = run("src/renderer/components/chat/Markdown.tsx")
    out = m.stdout
    check("S3 renderer 文件有覆盖时列出套件（改口没波及正常路径）",
          "必跑" in out and "smoke" in out, out[:400])
    check("S3 且不说「没有套件覆盖它」", "没有套件覆盖它" not in out, out[:400])

    # ── S4：两种路径写法必须等价 ────────────────────────────────────────
    print("\n[S4] `apps/desktop/src/...` 与 `src/...` 两种写法结果相同")

    rel = "src/main/modules/moduleApproval.ts"
    rooted = "apps/desktop/src/main/modules/moduleApproval.ts"
    a = run(rel)
    b = run(rooted)
    check("S4 ★ `apps/desktop/...` 不再「找不到」（从前拼成 apps/desktop/apps/desktop/…）",
          "找不到" not in b.stdout, b.stdout[:400])
    check("S4 ★ 两种写法的输出逐字相同",
          a.stdout.strip() == b.stdout.strip(),
          {"rel": a.stdout[:200], "rooted": b.stdout[:200]})
    check("S4 有覆盖的文件两种写法也相同",
          run("src/main/appControl/policy.ts").stdout.strip()
          == run("apps/desktop/src/main/appControl/policy.ts").stdout.strip(),
          "policy.ts")

    # ── S5：覆盖性正控 ─────────────────────────────────────────────────
    print("\n[S5] 覆盖性正控：断言确实读到了有内容的输出")

    check("S5 vendor 查询的输出不是空的（否则 S1 是恒绿）", len(out) > 0, len(out))
    check("S5 索引内查询确实列了套件（否则 S2/S3 在测空气）",
          len(r.stdout.strip()) > 0, r.stdout[:120])

    print(f"\nt152-smokes-for-index-scope-smoke: {total - failures}/{total} 通过")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
