"""「改了某个主进程文件 → 该跑哪几套 smoke」。

## 为什么要有它

全量 41 套跑一遍要好几分钟,而一次小改动往往只碰一两个文件。每次都全量是
**省事不省时**:那种习惯的代价不是那几分钟,是人开始攒着改 —— 而攒着改是 bug 的
温床。这个脚本把"该跑哪几套"变成一个不用猜的问题。

判据不用人列:每套 smoke 的 TypeScript 入口 import 了哪些 `@main/...`,顺着相对
import 再走下去,就是这套 smoke 真正覆盖到的源码。`.mjs` 入口可能通过
`readFileSync` + 转译加载实际模块,用 `// @smoke-covers src/main/...ts` 显式声明
**确实执行过**的目标文件(只记录该文件,不假装覆盖了它的整个依赖图)。
**一套都没覆盖到的套件**(比如
只测契约层的)单独列出来 —— 那是"这块没有回归网"这个事实本身。

⚠️ **粒度是"连通块",不是"文件"。** `library/operations.ts` 会带出七套 ——
因为 `library/` 那个模块的 import 图是连成一片的。这仍然比全量窄,但别指望它
总是窄到一两套。

## 用法

    bash apps/desktop/scripts/smokes-for.sh src/main/library/operations.ts
    bash apps/desktop/scripts/smokes-for.sh --all      # 全部文件 → 套件
    bash apps/desktop/scripts/smokes-for.sh --uncovered  # 哪些源码一套都没覆盖
"""
import re
import sys
from pathlib import Path

# **Windows 控制台是 GBK**(仓库里记过这个坑),而这份输出里有中文和 `⚠️` ——
# 不显式改编码的话,遇到 GBK 编不出的字符直接 `UnicodeEncodeError` 崩掉,
# 而崩的位置恰好是"这块没有回归网"那句最该被看见的警告。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent      # apps/desktop/scripts
DESKTOP = HERE.parent                       # apps/desktop
ROOT = DESKTOP.parent.parent                # 仓库根
MAIN = DESKTOP / "src" / "main"
RENDERER = DESKTOP / "src" / "renderer"

# `from "x"` / `import("x")` / `import "x"` 都收。`import type` 也一样 —— 类型
# 依赖也算依赖:契约改了这边也会跟着变。
IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")
# .mjs 的测试可能动态转译源文件;逐个明确声明真实执行过的模块。
SMOKE_COVERS_RE = re.compile(r"^\s*//\s*@smoke-covers\s+(src/main/[\w./-]+\.ts)\s*$", re.MULTILINE)


def resolve(spec: str, from_file: Path) -> Path | None:
    """把一条 import 说明符解析成磁盘上的 .ts / .tsx 文件。解析不出返回 None。

    ⚠️ `@renderer/` **要解析**(2026-09-26 修)。从前它和 `@contracts/` 一起被当成
    "别的包"丢掉,于是**任何渲染端文件**问下来都是「没有套件覆盖它」—— 哪怕
    `workflow-view-smoke` 明明 import 了它、断言也在跑。前端改动按 CLAUDE.md 先问
    这个脚本,得到的永远是一句假警告。`@contracts/` 仍然不收:它是另一个包。
    """
    if spec.startswith("@main/"):
        base = MAIN / spec[len("@main/"):]
    elif spec.startswith("@renderer/"):
        base = RENDERER / spec[len("@renderer/"):]
    elif spec.startswith("@contracts/"):
        return None  # 别的包,不算"主进程文件"
    elif spec.startswith("."):
        base = (from_file.parent / spec).resolve()
    else:
        return None
    for cand in (base.with_suffix(".ts"), base.with_suffix(".tsx"), base / "index.ts", base / "index.tsx"):
        if cand.exists():
            return cand
    if base.suffix == ".js":
        for ext in (".ts", ".tsx"):
            if base.with_suffix(ext).exists():
                return base.with_suffix(ext)
    return None


def closure(entry: Path, seen: set[Path]) -> None:
    """从 entry 出发,把 import 得到的主进程文件都收进 seen。"""
    if entry in seen or not entry.exists():
        return
    seen.add(entry)
    try:
        text = entry.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for spec in IMPORT_RE.findall(text):
        nxt = resolve(spec, entry)
        if nxt is not None:
            closure(nxt, seen)


def coverage() -> dict[str, set[Path]]:
    """套件名 → 它覆盖到的源码文件集合。"""
    suites: dict[str, set[Path]] = {}
    for d in sorted(HERE.iterdir()):
        if not d.is_dir() or not d.name.endswith("-smoke"):
            continue
        covered: set[Path] = set()
        for ts in d.rglob("*.ts"):
            # 换桩文件自己不是被测对象(它们是替身),但**要算**:桩替换掉的那个
            # 真实模块的调用方仍然在图上。所以只跳过桩本身的入口,不跳过它的
            # import。简化处理:桩也走一遍 closure,多收几个不影响判断。
            closure(ts, covered)
        for mjs in d.rglob("*.mjs"):
            text = mjs.read_text(encoding="utf-8", errors="replace")
            for rel_path in SMOKE_COVERS_RE.findall(text):
                target = (DESKTOP / rel_path).resolve()
                if not target.is_relative_to(MAIN) or not target.is_file():
                    raise ValueError(f"invalid @smoke-covers {rel_path} in {mjs.relative_to(ROOT)}")
                covered.add(target)
        suites[d.name] = covered
    return suites


def main() -> None:
    suites = coverage()
    if len(sys.argv) > 1 and sys.argv[1] == "--uncovered":
        # ⚠️ **这里原来是反的(2026-09-20 修)。** 旧实现把 `by_file` 建成"被覆盖过的
        # 文件 → 0",然后把它当未覆盖的列出来 —— 于是 `--uncovered` 打印的是 `--all`
        # 的同一份文件集合(实测:332 行 vs 331 行,差的只是标题那一行),而**真正零
        # 覆盖的文件一个都不在里面**。这个模式的全部用处就是回答"哪里没有回归网",
        # 答反了比没有更坏:它会让人以为 `src/main/index.ts`、`ipc/library.ts` 这些
        # 都已经有人守着。
        covered: set[Path] = set()
        for cov in suites.values():
            covered |= cov
        # 判据:主进程目录下的 `.ts`,没有任何套件 import 到。用 rglob 走全树而不是
        # 只看顶层 —— 这个仓库的代码都住在子目录里,只看顶层会得到一份空名单,而那
        # 看起来跟"全都有覆盖"一模一样。
        #
        # ⚠️ 两个数**要在同一个口径里**,否则加起来对不上:`covered` 里还混着
        # `src/main` **之外**的文件(某条相对 import 会跑到 `../renderer/` 或
        # `../../packages/` 去)。所以下面报的"覆盖到几个"是 `main_files ∩ covered`,
        # 不是 `len(covered)`。
        main_files = set(MAIN.rglob("*.ts"))
        uncovered = sorted(main_files - covered, key=lambda p: str(p))
        print("# 没有任何套件覆盖到的源码文件(改这里没有回归网):")
        if not uncovered:
            print("  (一个都没有 —— 主进程下每个 .ts 都至少被一套套件 import 到)")
            return
        for f in uncovered:
            print(f"  {f.relative_to(ROOT).as_posix()}")
        print(f"\n  共 {len(uncovered)} 个;主进程下覆盖到的 {len(main_files) - len(uncovered)} 个。")
        return

    if len(sys.argv) > 1 and sys.argv[1] != "--all":
        arg = sys.argv[1]
        if arg.startswith("apps/") or arg.startswith("src/"):
            want = (DESKTOP / arg).resolve()
        else:
            want = (ROOT / arg).resolve()
        if not want.exists():
            print(f"找不到 {arg}")
            sys.exit(1)
        hits = sorted(name for name, cov in suites.items() if want in cov)
        print(f"{want.relative_to(ROOT).as_posix()}")
        if hits:
            print("  跑这些: " + " ".join(hits))
            print("\n  bash apps/desktop/scripts/<名字>/run.sh")
        else:
            print("  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。")
            print("     要么补一套,要么改完自己写一次性探针验一遍然后删掉。")
        return

    by_file: dict[Path, list[str]] = {}
    for name, cov in suites.items():
        for f in cov:
            by_file.setdefault(f, []).append(name)
    for f in sorted(by_file, key=lambda p: str(p)):
        print(f"{f.relative_to(ROOT).as_posix()}\t{','.join(sorted(by_file[f]))}")

    empty = [n for n, cov in suites.items() if not cov]
    if empty:
        print("\n# 一套主进程文件都没覆盖的套件(多半只测契约层):")
        for n in empty:
            print(f"#   {n}")


if __name__ == "__main__":
    main()
