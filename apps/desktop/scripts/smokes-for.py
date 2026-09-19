"""「改了某个主进程文件 → 该跑哪几套 smoke」。

## 为什么要有它

全量 41 套跑一遍要好几分钟,而一次小改动往往只碰一两个文件。每次都全量是
**省事不省时**:那种习惯的代价不是那几分钟,是人开始攒着改 —— 而攒着改是 bug 的
温床。这个脚本把"该跑哪几套"变成一个不用猜的问题。

判据不用人列:每套 smoke 的 `main.ts` 自己 import 了哪些 `@main/...`,顺着相对
import 再走下去,就是这套 smoke 真正覆盖到的源码。**一套都没覆盖到的套件**(比如
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

# `from "x"` / `import("x")` / `import "x"` 都收。`import type` 也一样 —— 类型
# 依赖也算依赖:契约改了这边也会跟着变。
IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")


def resolve(spec: str, from_file: Path) -> Path | None:
    """把一条 import 说明符解析成磁盘上的 .ts 文件。解析不出返回 None。"""
    if spec.startswith("@main/"):
        base = MAIN / spec[len("@main/"):]
    elif spec.startswith("@contracts/") or spec.startswith("@renderer/"):
        return None  # 别的包,不算"主进程文件"
    elif spec.startswith("."):
        base = (from_file.parent / spec).resolve()
    else:
        return None
    for cand in (base.with_suffix(".ts"), base / "index.ts"):
        if cand.exists():
            return cand
    if base.suffix == ".js" and base.with_suffix(".ts").exists():
        return base.with_suffix(".ts")
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
        suites[d.name] = covered
    return suites


def main() -> None:
    suites = coverage()
    if len(sys.argv) > 1 and sys.argv[1] == "--uncovered":
        by_file: dict[Path, int] = {}
        for cov in suites.values():
            for f in cov:
                by_file[f] = 0
        print("# 没有任何套件覆盖到的源码文件(改这里没有回归网):")
        for f in sorted(by_file, key=lambda p: str(p)):
            print(f"  {f.relative_to(ROOT).as_posix()}")
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
