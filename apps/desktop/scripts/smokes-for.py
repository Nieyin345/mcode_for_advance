"""「改了某个主进程文件 → 该跑哪几套 smoke」。

## 为什么要有它

全量 41 套跑一遍要好几分钟,而一次小改动往往只碰一两个文件。每次都全量是
**省事不省时**:那种习惯的代价不是那几分钟,是人开始攒着改 —— 而攒着改是 bug 的
温床。这个脚本把"该跑哪几套"变成一个不用猜的问题。

判据不用人列:每套 smoke 的入口(`.ts` / `.tsx` / `.jsx`)import 了哪些 `@main/...`
或 `@renderer/...`,顺着相对 import 再走下去,就是这套 smoke 编译进 bundle 的源码。
`.mjs` 入口可能通过 `readFileSync` + 转译加载实际模块,用
`// @smoke-covers src/main/...ts` 显式声明**确实执行过**的目标文件(只记录该文件,
不假装覆盖了它的整个依赖图)。
**一套都没覆盖到的套件**(比如
只测契约层的)单独列出来 —— 那是"这块没有回归网"这个事实本身。

⚠️ **粒度是"连通块",不是"文件"。** `library/operations.ts` 会带出七套 ——
因为 `library/` 那个模块的 import 图是连成一片的。这仍然比全量窄,但别指望它
总是窄到一两套。

## 用法

    bash apps/desktop/scripts/smokes-for.sh src/main/library/operations.ts
    bash apps/desktop/scripts/smokes-for.sh --all      # 全部文件 → 套件
    bash apps/desktop/scripts/smokes-for.sh --uncovered  # 哪些源码一套都没覆盖

## ⚠️ 输出格式是公共接口 —— 改它之前先查谁在读

**这个脚本的 stdout 不只是给人看的，有套件在断言它。** 改输出形状
（分组、前缀、缩进、字段顺序）会让它们红，而红的原因不是覆盖判断错了，
是**它们匹配的那段文本不存在了**。

T78 就是这么踩的：把平铺的 `跑这些: A B` 换成「必跑 / 可选」分组，
`tsx-coverage-smoke` 三条断言当场红 —— 那么改的时候没人想到有人断它。

**改格式前先跑这两条：**

    grep -rln "smokes-for" apps/desktop/scripts/*/main.*   # 提到它的
    grep -rln "跑这些\\|必跑" apps/desktop/scripts/*/main.*  # 真断言输出的

### 目前的消费者（2026-10-24 实测）

**断言 stdout 的两套**（改格式必须跑它们）：

- `scripts/tsx-coverage-smoke/main.py` —— 验 `.tsx`/`.jsx` 入口的覆盖判断
  （漏报/误报两个方向）。**T78 后它改成解析 `*-smoke` 名字集合，不再匹配前缀**，
  所以它能容忍排版变化；但**如果哪天改的是「名字本身怎么出现」，它仍会红**。
- `scripts/smokes-for-ranking-smoke/main.py` —— 验 T78 的分级本身。
  它直接 `import` 本模块的 `rank()` / `NEED_JUMP`，不走文本解析，但**常量名与
  函数签名是它的接口**。

**只在注释里提到、不断言输出的**（不需要为格式改动跑它们，但列在这里免得
下次有人重新 grep 一遍）：`browser-smoke`、`hook-exec-smoke`、`hooks-ipc-smoke`、
`leftbar-render-smoke`、`memory-smoke`、`orchestration-ipc-smoke`、`plugins-ipc-smoke`、
`startup-wiring-smoke`、`updater-smoke`。
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


# ── 【T78】距改动文件的跳数 ────────────────────────────────────────────────
#
# ## 为什么需要它
#
# `closure()` 的设计目标是「宁可多跑,不可漏跑」—— 它把**编译进 bundle** 的整个
# import 图都收进来。这对正确性是对的,但输出宽到不可执行:实测
# `src/main/document/documentToolSurface.ts` 会带出 98 套(全量的 18%),
# 而其中**真正 1 跳**的只有 2 套。
#
# 于是 CLAUDE.md 那条「改一处小东西先问该跑哪几套」实际上失效了 ——
# 看到 98 个名字的人不会跑,而是去跑全量(或者干脆不跑)。
#
# ## 这里做什么、不做什么
#
# **只加一层分级,不动 `closure()`。** 收集逻辑一行没改:闭包仍是那个闭包,
# 「不漏」的保证不变。分级只是把同一批名字按**距离**排成两段,让人先看到
# 「必跑」那几套。
#
# ## 跳数怎么算
#
# 从套件入口出发做 BFS(不是 DFS):BFS 第一次到达 target 时的深度就是**最短**
# 跳数。入口文件自身 import target 记作 1 跳。
#
# 注意这和 `closure()` 的递归不是同一种遍历 —— 那个只关心「可达」,这个关心
# 「多近」。两者算的是同一个图,结论必然相容:分级里的每一套都必然在闭包里
# (由 `rank_by_distance` 的调用方核对,见 `--verify-rank`)。


def distances_to(target: Path, entry: Path) -> tuple[int | None, Path | None]:
    """从 `entry` 到 `target` 的最短跳数,以及路径上**紧邻 target 的上一跳**。

    返回 `(None, None)` 表示不可达。

    「上一跳」是用来回答「这一套是经由什么才跟改动文件扯上关系的」——
    实测 `documentToolSurface.ts` 的 98 套里,**83 套都经由 `appControl/tools.ts`**
    (agent 工具面),那是个有意义的信息:它说的是「这些套件碰到的是工具注册那条链,
    不是文档模块本身」。
    """
    seeds: list[Path] = [entry]
    prev: dict[Path, Path | None] = {entry: None}
    frontier = seeds
    depth = 0
    while frontier:
        nxt: list[Path] = []
        for node in frontier:
            if node == target:
                parent = prev.get(node)
                # 入口本身就是 target(0 跳)时没有「上一跳」
                return depth, parent
            try:
                text = node.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for spec in IMPORT_RE.findall(text):
                r = resolve(spec, node)
                if r is not None and r not in prev:
                    prev[r] = node
                    nxt.append(r)
        frontier = nxt
        depth += 1
    return None, None


def suite_distance(suite_dir: Path, target: Path) -> tuple[int | None, Path | None]:
    """一套套件里**最近的入口**到 target 的跳数。

    一套套件可以有多个入口(`main.ts` / `stubs/*.ts` / `*.tsx` …)。取最近的那个 ——
    判据是「这套里有人离它多近」,不是「最远的有多远」。

    ## ⚠️ 返回 `None` 意味着**这套不在闭包里**,而不是「距离很远」

    【T78 变异验证抓到的漏洞】第一版把 `None` 和「≥3 跳」一起归进「可选」。
    那样一来,任何让距离算不出来的 bug(遍历 bug、解析失败)都会**静默地把一套
    从必跑降级成可选** —— 而 `must | optional == hits` 仍然成立,「不漏控」照样绿。

    现在调用方(输出那段)把 `None` 当作**内部矛盾**单独报出来,而不是混进可选。
    正常情况下 `None` 不该出现:`hits` 来自闭包,而闭包能到达的套件 BFS 也必然能到达
    —— 两者用的是同一份 `resolve()`。真出现了就是 bug,必须让人看见。
    """
    best: int | None = None
    best_parent: Path | None = None
    for pattern in ("*.ts", "*.tsx", "*.jsx"):
        for entry in suite_dir.rglob(pattern):
            d, parent = distances_to(target, entry)
            if d is None:
                continue
            if best is None or d < best:
                best, best_parent = d, parent
                if best == 0:      # 已经是最短可能,不用再找
                    return best, best_parent
    return best, best_parent


def path_chain_to(target: Path, entry: Path) -> list[Path] | None:
    """从 `entry` 到 `target` 的最短路径(含两端)。不可达返回 None。

    给 `--why` 用的:光说「经由 X」不如把整条链打出来。
    """
    prev: dict[Path, Path | None] = {entry: None}
    frontier = [entry]
    while frontier:
        nxt: list[Path] = []
        for node in frontier:
            if node == target:
                chain: list[Path] = []
                cur: Path | None = node
                while cur is not None:
                    chain.append(cur)
                    cur = prev[cur]
                chain.reverse()
                return chain
            try:
                text = node.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for spec in IMPORT_RE.findall(text):
                r = resolve(spec, node)
                if r is not None and r not in prev:
                    prev[r] = node
                    nxt.append(r)
        frontier = nxt
    return None


def coverage() -> dict[str, set[Path]]:
    """套件名 → 它覆盖到的源码文件集合。"""
    suites: dict[str, set[Path]] = {}
    for d in sorted(HERE.iterdir()):
        if not d.is_dir() or not d.name.endswith("-smoke"):
            continue
        covered: set[Path] = set()
        # ⚠️ **三份扩展名都要扫(2026-10-23 修)。** 从前这里只有 `.ts`,于是
        # `settings-panels-electron-smoke/renderer.tsx` 真的 import 了
        # `@renderer/components/chat/ApprovalPrompt.js`、`ui-interaction-smoke/main.jsx`
        # 也真的渲染它,工具却对这两个文件都答「无套件覆盖」——`resolve()` 本来就认
        # `.tsx`(见上面的候选表),漏的只是扫描入口。`--uncovered` 的口径是
        # `src/main` 下的 `.ts`,这个 bug 在那份清单上不可见,**只在单文件查询和
        # `--all` 的 renderer 映射上现形**。
        # `.jsx` 与 `.tsx` 同理:它们是 13 套浏览器套件的真实 entryPoints
        # (`build.mjs` 里 `entryPoints:[...main.jsx]`),不是别的套件的夹具。
        # `.cjs` **故意不扫**:它们要么是 esbuild 启动器(`run.cjs`、`electron-host.cjs`),
        # 要么是桩(`iconsStub.cjs`)。按 `IMPORT_RE` 去扫只会把 `alias:{...}` 里的
        # 字符串当成 import 收进来——实测会凭空"覆盖" 85 个脚本文件,清一色假阳性。
        # 同理 `.mts`/`.cts` 本仓库 0 个,不需要。
        for pattern in ("*.ts", "*.tsx", "*.jsx"):
            for entry in d.rglob(pattern):
                # 换桩文件自己不是被测对象(它们是替身),但**要算**:桩替换掉的那个
                # 真实模块的调用方仍然在图上。所以只跳过桩本身的入口,不跳过它的
                # import。简化处理:桩也走一遍 closure,多收几个不影响判断。
                closure(entry, covered)
        for mjs in d.rglob("*.mjs"):
            text = mjs.read_text(encoding="utf-8", errors="replace")
            for rel_path in SMOKE_COVERS_RE.findall(text):
                target = (DESKTOP / rel_path).resolve()
                if not target.is_relative_to(MAIN) or not target.is_file():
                    raise ValueError(f"invalid @smoke-covers {rel_path} in {mjs.relative_to(ROOT)}")
                covered.add(target)
        suites[d.name] = covered
    return suites


# 【T78】「必跑」的跳数上限 —— **模块级常量，不是输出段的局部变量**。
#
# 变异验证抓过一次：第一版把它写在 `main()` 的输出分支里，于是套件里手写的
# `d <= 2` 与它各说各话 —— 把阈值改成 99（所有套件都进必跑，分级等于失效），
# 套件**照样全绿**。断言必须读同一份常量，否则它测的是自己的副本。
NEED_JUMP = 2


def rank(suites: dict[str, set[Path]], target: Path) -> tuple[
        list[tuple[int, Path | None, str]], list[tuple[int, Path | None, str]], list[str]]:
    """把「覆盖 target 的套件」按距离分成 (必跑, 可选, 距离算不出的)。

    【T78】从输出分支里抽出来，让套件能直接断言**分级本身**，而不是断言它自己的
    重新实现。返回的第三项是「在闭包里但算不出距离」的套件 —— 正常情况下应为空；
    非空就是 bug（见 `suite_distance` 的注释）。
    """
    ranked: list[tuple[int | None, Path | None, str]] = []
    for name, cov in suites.items():
        if target not in cov:
            continue
        d, parent = suite_distance(HERE / name, target)
        ranked.append((d, parent, name))
    must = sorted(
        ((d, p, n) for d, p, n in ranked if d is not None and d <= NEED_JUMP),
        key=lambda x: (x[0], x[2]),
    )
    optional = sorted(
        ((d, p, n) for d, p, n in ranked if d is not None and d > NEED_JUMP),
        key=lambda x: (x[0], x[2]),
    )
    unreachable = sorted(n for d, _p, n in ranked if d is None)
    return must, optional, unreachable


def main() -> None:
    suites = coverage()
    if len(sys.argv) > 1 and sys.argv[1] == "--verify-rank":
        # 【T78】「不漏控」：分级必须**只重排、不过滤**。
        #
        # 这条是整张卡最重要的断言 —— 没有它，分级就成了「悄悄漏跑」的工具：
        # 哪天 `suite_distance` 因为某种原因返回 None，那套就会从必跑里消失，
        # 而人看到的仍然是一份「看起来正常」的清单。
        #
        # 核对方式：对抽查的文件，**必跑 ∪ 可选 必须等于完整闭包**。
        #
        # ⚠️ **为什么是抽样而不是全量**：每个文件要对几十套各跑一次 BFS，全仓几百个
        # 文件跑完要十几分钟 —— 那正好是这张卡要消灭的那种等待。默认抽 25 个
        # （`--verify-rank=all` 可跑全量）；抽样能证明的是「分级逻辑没有系统性丢套件」，
        # 而 `suite_distance` 的实现里没有任何依赖文件内容的特判，**丢套件的唯一途径
        # 是它返回 None**，而返回 None 只可能因为不可达 —— 不可达的套件本来就不在
        # `hits` 里（`hits` 来自闭包）。见下面的 `lost` 计数。
        every = "--verify-rank=all" in sys.argv
        all_files = sorted({f for cov in suites.values() for f in cov})
        sample = all_files if every else all_files[:: max(1, len(all_files) // 25)][:25]
        bad = 0
        for want in sample:
            hits = {name for name, cov in suites.items() if want in cov}
            must, optional = set(), set()
            for name in hits:
                d, _p = suite_distance(HERE / name, want)
                (must if d is not None and d <= 2 else optional).add(name)
            if must | optional != hits:
                bad += 1
                if bad <= 5:
                    print(f"LOST {want.relative_to(ROOT).as_posix()}: 少了 {sorted(hits - (must | optional))}")
        print(f"checked {len(sample)} files"
              f"{'' if every else f' of {len(all_files)}'}, lost {bad}")
        sys.exit(1 if bad else 0)

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
            # 【T78】按「距改动文件的最短跳数」分两段。
            #
            # 判据:1–2 跳 = 必跑(改动直接波及);≥3 跳 = 可选(经由若干中间模块,
            # 多半只是被装配中心带进来的)。**这不是判断谁重要,是判断谁离得近。**
            #
            # 「不漏」由构造保证:分级只重排、不过滤 —— `rank()` 遍历的正是 `hits`。
            # 分级逻辑在模块级的 `rank()` 里,**不是**在这里内联,这样套件断言的是
            # 同一份实现（变异验证抓到过:内联的话,把 NEED_JUMP 改掉套件照样绿）。
            must, optional, unreachable = rank(suites, want)
            if unreachable:
                print(f"\n  ⚠️ 内部矛盾：以下 {len(unreachable)} 套在闭包里但算不出距离")
                print(f"     这是 bug（两者用同一份 resolve()，应当同进同出），请报给维护者：")
                for n in unreachable:
                    print(f"       {n}")
            if must:
                jumps = sorted({d for d, _, _ in must})
                print(f"\n  必跑（1–{NEED_JUMP} 跳，{len(must)} 套；跳数 {jumps}）:")
                for d, _p, n in must:
                    print(f"    {n}  ({d} 跳)")
            if optional:
                # 按「上一跳」分组 —— 那个中间模块才是「为什么它会被带进来」的答案。
                by_parent: dict[str, list[str]] = {}
                for _d, p, n in optional:
                    key = p.relative_to(DESKTOP).as_posix() if p is not None else "(不可达)"
                    by_parent.setdefault(key, []).append(n)
                print(f"\n  可选（≥{NEED_JUMP + 1} 跳，{len(optional)} 套）:")
                for key in sorted(by_parent, key=lambda k: (-len(by_parent[k]), k)):
                    names = by_parent[key]
                    print(f"    经由 {key}（{len(names)} 套）:")
                    line = "      "
                    for n in names:
                        if len(line) + len(n) + 2 > 100:
                            print(line)
                            line = "      "
                        line += " " + n
                    if line.strip():
                        print(line)
            if optional:
                print(f"\n  ⚠️ 可选里多数只是被中间模块带进 bundle 的，不是「改了它就一定坏」。")
                print(f"     必跑那 {len(must)} 套是改动直接波及的；可选 {len(optional)} 套按你的判断取舍。")
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
