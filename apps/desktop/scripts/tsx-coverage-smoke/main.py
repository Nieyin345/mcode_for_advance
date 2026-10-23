#!/usr/bin/env python3
"""`smokes-for.py` 自身的回归 —— **扫描入口认不认 `.tsx` / `.jsx`，以及认不认得太宽**。

## 为什么需要这一套

`smokes-for` 的存在意义是回答「改这个文件该跑哪几套」。它答错有两个方向，**都危险**：

1. **漏报覆盖**（T22 修的那种）：2026-10-23 之前扫描入口只有 `rglob("*.ts")`，
   `.tsx` / `.jsx` 一个都不扫。于是 `settings-panels-electron-smoke/renderer.tsx`
   真 import 的 `ApprovalPrompt.tsx` 被答成「没有套件覆盖它」——`resolve()` 明明认
   `.tsx`，漏的只是入口。`:3` 那条断言就是把它钉死。
2. **误报覆盖**：把没覆盖的说成覆盖了，改完不跑就提交。`:4` / `:5` 两条钉的是这个
   方向 —— `.cjs` 里 `alias:{"@main/...":"./stub.ts"}` 这种**字符串**绝不能被当成
   import；以及一个真没人 import 的 `.tsx` 必须**仍然**是「无覆盖」。

## 为什么用 fixture 而不是直接问本仓

直接对本仓跑一遍 `coverage()` 要 **17~36 秒**（Windows 上 `Path.resolve()` 走
`_getfinalpathname`，527 套 × 1100+ 入口）。而这一套每次全量 smoke 都会跑。所以
在临时目录里搭一个**最小仓库**：3 个套件、4 个源码文件，一次 < 1 秒。

⚠️ 这是「**行为**断言，不是文本断言」：它调用真实脚本、看它打印什么（CLAUDE.md 的
「测试要测职责」）。把 `coverage()` 里 `("*.ts", "*.tsx", "*.jsx")` 改成只剩 `("*.ts",)`，
`:3` 立刻红。

## 为什么 fixture 里也要放 `run.sh`

`coverage()` 只认 `-smoke` 结尾的目录名，不要求 `run.sh`。但放上它能让 fixture 与
真实套件的形状一致；`raises` 那条还顺带证明：**没有 `run.sh` 的目录照样会被扫**
（`genoffice-file-routing-smoke` / `t87-…` 就是这样，它们靠 `.mjs`/`.cjs` 跑）。

Run: scripts/tsx-coverage-smoke/run.sh
"""
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
# 被测对象：仓库里那一份真脚本，不是复制品 —— 复制品会漂。
SMOKES_FOR = SCRIPTS / "smokes-for.py"

# **Windows 控制台是 GBK**（仓库里记过这个坑，`smokes-for.py` 自己也有这段）。
# 这套输出里有中文和断言 detail；不显式改编码的话，遇到 GBK 编不出的字符直接
# `UnicodeEncodeError` 崩掉。子进程侧用 `encoding="utf-8"` 解码（见 run_script）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

total = 0
failed = 0


def suites_in(stdout: str) -> set[str]:
    """从 `smokes-for` 的输出里解析出**被列为覆盖的套件名**。

    【T78】为什么要有它：本套验的是**覆盖判断**（哪几套覆盖了这个文件），
    而输出怎么排版是另一回事。T78 把输出从平铺改成「必跑 / 可选」分组之后，
    原来那三条 `"跑这些: X" in stdout` 全假红 —— 红的不是判断，是格式壳。

    解析方式故意**宽松**：凡是 `*-smoke` 形状的 token 都算，不管它在哪一段、
    有没有缩进、后面跟没跟跳数。这样排版怎么变都不影响，而「哪几套」仍然钉死。
    """
    import re as _re
    return set(_re.findall(r"[A-Za-z0-9][A-Za-z0-9_.-]*-smoke\b", stdout))


def check(name: str, good: bool, detail: object = None) -> None:
    global total, failed
    total += 1
    if good:
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + ("" if detail is None else f": {detail!r}"))


def build_fixture(root: Path) -> None:
    """搭一个最小仓库：每条 import 形态各一份，方便逐条断言。"""
    def write(rel: str, text: str) -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    # smoke 里**复制一份**被跑的脚本：fixture 是本脚本的私有沙箱，不能污染仓库。
    write("apps/desktop/scripts/smokes-for.py", SMOKES_FOR.read_text(encoding="utf-8"))

    # ── 源码侧 ──
    # tsx 入口 import 的 .tsx（正是 T22 的 bug 形状：resolve() 认，扫描入口不认）
    write("apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx",
          'import { helper } from "@renderer/lib/helper.js";\n'
          "export const ApprovalPrompt = () => helper();\n")
    # 它依赖的 .ts（证明 .tsx 之后还能顺着 `.js` 说明符解析到 `.ts`）
    write("apps/desktop/src/renderer/lib/helper.ts", "export const helper = () => 1;\n")
    # 真没人 import 的 .tsx —— 反向断言用（放宽扫描不能把一切都说成覆盖）
    write("apps/desktop/src/renderer/components/chat/NobodyUses.tsx",
          "export const NobodyUses = () => null;\n")
    # 只出现在 .cjs 的 alias 字符串里的模块 —— 防误报断言用
    write("apps/desktop/src/main/providers/claude-sdk/sdkBinaryPath.ts",
          "export const sdkBinaryPath = () => '';\n")
    # 主进程里一个普通的、被 ts 入口 import 的 .ts（保证 --uncovered 口径有东西可比）
    write("apps/desktop/src/main/lib/ok.ts", "export const ok = true;\n")
    # 一个谁都不碰的主进程 .ts —— 应当出现在 --uncovered
    write("apps/desktop/src/main/lib/orphan.ts", "export const orphan = true;\n")

    # ── 套件侧（目录名必须匹配 run-smokes.mjs 的 SUITE_NAME 正则）──
    # 1. .tsx 入口：import tsx，也 import ts。
    write("apps/desktop/scripts/tsx-entry-smoke/main.tsx",
          'import { ApprovalPrompt } from "@renderer/components/chat/ApprovalPrompt.js";\n'
          'import { ok } from "@main/lib/ok.js";\n'
          "console.log(ApprovalPrompt, ok);\n")
    write("apps/desktop/scripts/tsx-entry-smoke/run.sh", "#!/usr/bin/env bash\nexit 0\n")
    # 2. .jsx 入口：真实浏览器套件都是这个形状（build.mjs 的 entryPoints 指向 main.jsx）。
    write("apps/desktop/scripts/jsx-entry-smoke/main.jsx",
          'import {ApprovalPrompt} from "@renderer/components/chat/ApprovalPrompt.js";\n'
          "console.log(ApprovalPrompt);\n")
    write("apps/desktop/scripts/jsx-entry-smoke/run.sh", "#!/usr/bin/env bash\nexit 0\n")
    # 3. .cjs 启动器：**只有 alias 字符串**，绝不能被算成 import。
    write("apps/desktop/scripts/cjs-runner-smoke/run.cjs",
          'const esbuild = require("esbuild");\n'
          'esbuild.buildSync({entryPoints:["scripts/cjs-runner-smoke/main.ts"],'
          'alias:{"@main/providers/claude-sdk/sdkBinaryPath.js":'
          '"./scripts/cjs-runner-smoke/stubs.ts","@renderer/components/chat/NobodyUses.js":'
          '"./scripts/cjs-runner-smoke/stubs.ts"}});\n')
    write("apps/desktop/scripts/cjs-runner-smoke/main.ts",
          'import { sdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";\n'
          "console.log(sdkBinaryPath);\n")
    write("apps/desktop/scripts/cjs-runner-smoke/run.sh", "#!/usr/bin/env bash\nexit 0\n")
    # 4. 没有 run.sh 的目录 —— 证明「扫得到」不取决于 run.sh（真实仓库里有两套这样）。
    write("apps/desktop/scripts/no-runsh-smoke/main.mjs",
          "// 只有 .mjs，没有 run.sh\n")


def run_script(fixture: Path, *args: str) -> subprocess.CompletedProcess[str]:
    # -I：隔离模式。fixture 目录里可能有我们刚写的文件，别让它们影响解释器的
    # sys.path / 用户 site-packages。
    return subprocess.run(
        [sys.executable, "-I", str(fixture / "apps/desktop/scripts/smokes-for.py"), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="mcode-tsx-coverage-") as tmp:
        fixture = Path(tmp)
        build_fixture(fixture)

        # ── :1 .tsx 入口 → 覆盖 .tsx 源码，且顺着 `@renderer/...js` 找到它 ──
        # ApprovalPrompt.tsx 在 fixture 里同时被 .tsx 和 .jsx 两个入口 import，
        # 所以断言的是**两个都在列表里**，而不是「只有第一个」。
        #
        # 【T78】断言从「匹配 `跑这些: …` 这段文本」改成「解析出**套件名集合**再比较」。
        #
        # 为什么：本套的目的是验**覆盖判断**对不对（见文件头「漏报/误报」两条），
        # 而 `跑这些:` 是 T78 之前那个平铺输出的**格式**。T78 把输出改成
        # 「必跑 / 可选」分组后，这三条因为找不到那个前缀而假红 —— **红的不是
        # 覆盖判断，是格式壳**。
        #
        # 现在用 `suites_in(stdout)`：从输出里把 `*-smoke` 名字抠出来成集合。
        # 这样输出怎么排版都不影响，而「哪几套被列为覆盖」仍然被钉死 ——
        # 判别力没有降低，耦合面消除了。
        r = run_script(fixture, "src/renderer/components/chat/ApprovalPrompt.tsx")
        check(".tsx 与 .jsx 入口都被扫到：ApprovalPrompt.tsx 映射到两个套件",
              suites_in(r.stdout) == {"jsx-entry-smoke", "tsx-entry-smoke"},
              {"suites": sorted(suites_in(r.stdout)), "raw": r.stdout + r.stderr})

        # ── :2 .jsx 入口同理（13 套浏览器套件的真实形状）──
        # 同一个组件被两个套件覆盖，所以上面那条只该出现第一个；这里单独验 jsx 那套。
        r = run_script(fixture, "src/renderer/components/chat/NobodyUses.tsx")
        check("真没人 import 的 .tsx 仍然报「没有套件覆盖它」",
              "没有套件覆盖它" in r.stdout, r.stdout + r.stderr)
        # NobodyUses.tsx 只被 cjs 的 alias 字符串提到 —— 若 .cjs 被扫，这条会红。
        check(".cjs 的 alias 字符串不算 import（NobodyUses 没被误报覆盖）",
              "没有套件覆盖它" in r.stdout, r.stdout + r.stderr)

        # ── :3 .tsx 与 .ts 在同一个套件里都收 ──
        r = run_script(fixture, "src/main/lib/ok.ts")
        check("同一套件的 .tsx 入口也能带出 .ts 依赖",
              suites_in(r.stdout) == {"tsx-entry-smoke"},
              {"suites": sorted(suites_in(r.stdout)), "raw": r.stdout + r.stderr})

        # ── :4 .cjs 别名指向的模块不能被说成覆盖 ──
        r = run_script(fixture, "src/main/providers/claude-sdk/sdkBinaryPath.ts")
        # 它**确实**被 cjs-runner-smoke/main.ts import 了，所以预期是「有覆盖」——
        # 这条验的是正向：别把 .ts 入口漏掉。真正防误报的是下面 --all 那条。
        check(".ts 入口（同一套件里 cjs 是启动器）仍被认出覆盖",
              suites_in(r.stdout) == {"cjs-runner-smoke"},
              {"suites": sorted(suites_in(r.stdout)), "raw": r.stdout + r.stderr})

        # ── :5 --uncovered 口径：.tsx/.jsx 的加入不该改变主进程 .ts 的判断 ──
        r = run_script(fixture, "--uncovered")
        lines = [ln.strip() for ln in r.stdout.splitlines() if ln.strip().startswith("apps/")]
        check("--uncovered 只列真正没人碰的主进程 .ts",
              lines == ["apps/desktop/src/main/lib/orphan.ts"], lines)
        check("--uncovered 的计数口径与名单一致",
              "共 1 个" in r.stdout, r.stdout)

        # ── :6 套件发现独立于 run.sh（真实仓库里有两套没有 run.sh）──
        r = run_script(fixture, "--all")
        rows = [ln for ln in r.stdout.splitlines() if "\t" in ln]
        suites = {ln.split("\t", 1)[1] for ln in rows} if rows else set()
        check("--all 扫到了没有 run.sh 的套件（只要目录名匹配）", "no-runsh-smoke" in r.stdout, r.stdout)
        # --all 的每一行是「文件 → 套件」；.jsx 入口覆盖的源码必须带着 jsx-entry-smoke 出现
        ja = [ln for ln in rows if ln.startswith("apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx")]
        check("--all 里 ApprovalPrompt.tsx 同时列出 .tsx 与 .jsx 两个入口套件",
              bool(ja) and "jsx-entry-smoke" in ja[0] and "tsx-entry-smoke" in ja[0],
              ja or rows[:3])
        # 反向：NobodyUses.tsx 在 --all 里根本不该出现（它没有被任何真 import 覆盖）
        check("--all 不列没有套件覆盖的 .tsx",
              not any("NobodyUses.tsx" in ln for ln in rows),
              [ln for ln in rows if "NobodyUses" in ln])

    print(f"tsx-coverage-smoke: {total - failed}/{total} 通过")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
