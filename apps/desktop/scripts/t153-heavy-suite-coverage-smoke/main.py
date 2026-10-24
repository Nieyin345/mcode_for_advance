#!/usr/bin/env python3
"""【T153】`smokes-for.py` 必须收「重型套件」—— 不带 `-smoke` 但有真实覆盖的那类。

## 为什么需要这一套

`coverage()` 从前只 `d.name.endswith("-smoke")`。磁盘上有 9 个不叫 `-smoke` 的
目录，其中 **至少 4 个有真实 import 覆盖 `apps/desktop/src/**`**：

| 目录 | 真实 import |
|---|---|
| `t96-probe` | 5 |
| `arc005-visual-baseline` | 4 |
| `electron-u1` | 3 |
| `flow-preview` | 3 |
| `mc035-egress-probe` | 1 |
| `md-preview` | 1 |

对它们覆盖的文件，工具从前答「没有套件覆盖它」—— 和 T152 那类**假否定**同族，
只是方向相反：T152 是「路径不在图上」，本条是「套件名不合命名约定」。

## `flow-preview` / `md-preview` 是**真套件**，不是预览台（变异实测）

按 Office 总控的判据「预览台和套件的区别不是有没有 import，是改坏了会不会红」：

- 往 `WorkflowFlowMini` 插一行 `throw` → `flow-preview/run.sh` `EXIT=1`，`0/2 通过`
  （FAIL「SVG 画出来了」+ FAIL「控制台没有异常」）；
- 往 `Markdown` 插一行 `throw` → `md-preview/run.sh` `EXIT=1`，`2/10 通过`。

两者都还原并 `cmp` 逐字节核对。**所以它们进覆盖集是对的。**

## `electron-u1` 的 `entryPoints` 边

它通过 `build.mjs:215` 的 esbuild `entryPoints` 直接打包 `src/preload/index.ts`，
那条边**不是 import**，图看不见。用 `@smoke-covers src/preload/index.ts` 声明补上（0 跳）。

## 排除表只剩三个（它们不产生任何覆盖边）

- `preset-scripts-sync` —— 普通脚本，不 import src/；
- `o3-packaged-u1` —— 跑打包产物，覆盖 `resources/genoffice/**`；
- `vscode-api-census` —— 普查工具。

**加进来说会得到「认了但覆盖集合是空的」—— 比「不认」更难排查。**

## 钉住什么

- S1：`flow-preview` / `md-preview` 各自出现在它覆盖的文件的必跑里；
- S2：`electron-u1` 出现在 `src/preload/index.ts` 的必跑里，且 0 跳；
- S3：排除表三个目录**不出现**在任何查询结果里（负控）；
- S4：输出里标了「重型」；
- S5：覆盖性正控 —— 断言确实读到了有内容的输出。
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent.parent  # apps/desktop/scripts/<x> -> mcode
SMOKES_FOR = REPO / "apps" / "desktop" / "scripts" / "smokes-for.py"

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
    # 否则中文输出变成替换字符，断言永远匹配不上（T150/T152 同一处理）。
    return subprocess.run(
        [sys.executable, "-I", str(SMOKES_FOR), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=600, cwd=str(REPO),
    )


def must_section(out: str) -> str:
    """截出「必跑」那一段的正文（到「可选」或「⚠️」或结尾）。

    ⚠️ **不能对整段 stdout 做子串匹配** —— 一个套件名可能同时出现在「必跑」
    和「可选」里（经由不同路径进来的另一套）。第一版就是这么写的，M-1 变异
    只红了一条，`md-preview` / `flow-preview` 因为出现在可选段里而蒙混过关。
    """
    lines = out.splitlines()
    got: list[str] = []
    inside = False
    for ln in lines:
        if "必跑（" in ln:
            inside = True
            continue
        if inside and ("可选（" in ln or ln.strip().startswith("⚠️") or ln.strip().startswith("bash ")):
            break
        if inside:
            got.append(ln)
    return "\n".join(got)


def main() -> None:
    if not SMOKES_FOR.is_file():
        print(f"FAIL 找不到 {SMOKES_FOR}")
        sys.exit(1)

    # ── S1：预览台其实是真套件，必须被收录 ────────────────────────────
    print("\n[S1] flow-preview / md-preview 是真套件（变异实测会红），必须出现在必跑里")

    r = run("src/renderer/components/chat/Markdown.tsx")
    out = r.stdout
    must = must_section(out)
    check("S1 ★ md-preview 出现在 Markdown.tsx 的必跑里",
          "md-preview" in must, must[:600])
    check("S1 ★ arc005-visual-baseline 也出现在必跑里（它 import 了 Markdown）",
          "arc005-visual-baseline" in must, must[:600])

    r2 = run("src/renderer/components/chat/WorkflowFlowMini.tsx")
    out2 = r2.stdout
    must2 = must_section(out2)
    check("S1 ★ flow-preview 出现在 WorkflowFlowMini.tsx 的必跑里",
          "flow-preview" in must2, must2[:600])

    # ── S2：electron-u1 的 entryPoints 边（声明型，0 跳）────────────────
    print("\n[S2] electron-u1 通过 @smoke-covers 覆盖 src/preload/index.ts（0 跳）")

    r3 = run("src/preload/index.ts")
    out3 = r3.stdout
    must3 = must_section(out3)
    check("S2 ★ electron-u1 出现在 src/preload/index.ts 的必跑里",
          "electron-u1" in must3, must3[:600])
    check("S2 ★ 且是 0 跳（声明型依赖，不是绕远路找到的）",
          "electron-u1  (0 跳)" in must3, must3[:600])

    # ── S3：排除表不产生空覆盖集（负控，防过度收录）────────────────────
    print("\n[S3] 排除表三个目录不出现在任何查询结果里（负控）")

    r4 = run("--all")
    out4 = r4.stdout
    # ⚠️ 必须按「逗号分隔的完整名字」匹配，不能用子串 ——
    # 仓库里存在 `preset-scripts-sync-smoke`（带 -smoke 后缀，是另一套），
    # 子串匹配会把它误判成被排除的 `preset-scripts-sync`。
    listed = set()
    for line in out4.splitlines():
        if "\t" not in line:
            continue
        names = line.split("\t", 1)[1]
        for n in names.split(","):
            n = n.strip()
            if n:
                listed.add(n)
    for excluded in ("preset-scripts-sync", "o3-packaged-u1", "vscode-api-census"):
        check(f"S3 ★ {excluded} 不出现在 --all 的套件里",
              excluded not in listed, f"listed={sorted(n for n in listed if excluded in n)[:5]}")

    # ── S4：输出能区分「重型」───────────────────────────────────────
    print("\n[S4] 输出里标了「重型」，让读者知道这一跑要几十秒")

    check("S4 ★ 必跑段里出现「重型」标注", "重型" in out, out[:600])
    check("S4 汇总行也说清有几套重型", "其中" in out and "套重型" in out, out[:600])

    # ── S5：覆盖性正控 ──────────────────────────────────────────────
    print("\n[S5] 覆盖性正控：断言确实读到了有内容的输出")

    check("S5 md-preview 查询的必跑段不是空的（否则 S1 是恒绿）",
          "必跑" in out and "套" in out, out[:300])
    check("S5 --all 输出不是空的（否则 S3 在测空气）",
          len(out4) > 1000, f"len={len(out4)}")

    print(f"\nt153-heavy-suite-coverage-smoke: {total - failures}/{total} 通过")
    sys.exit(0 if failures == 0 else 1)


if __name__ == "__main__":
    main()
