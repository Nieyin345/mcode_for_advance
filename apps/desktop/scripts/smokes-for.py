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

# 【T152】依赖图只从这两个根出发 —— `closure()` 的入口全在 `scripts/*` 里，
# 而它们 import 的是 `@main/` / `@renderer/` / 相对路径，所以覆盖集合里只可能
# 出现这两个目录下的文件。
#
# **这个元组是「本工具能回答什么问题」的定义域，不是「它排除了什么」。**
# 用它区分「查过没有」和「根本不在我的问题范围内」—— 见 `explain_no_coverage()`。
INDEXED_ROOTS: tuple[Path, ...] = (MAIN, RENDERER)

# `from "x"` / `import("x")` / `import "x"` 都收。`import type` 也一样 —— 类型
# 依赖也算依赖:契约改了这边也会跟着变。
IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")
# .mjs 的测试可能动态转译源文件;逐个明确声明真实执行过的模块。
#
# 【T150】路径从「只能是 src/main/」放宽成「仓库相对路径」。原因：
# `app-control-smoke` 用 `readFileSync` + `ts.createSourceFile` 读
# `packages/contracts/src/ipc/rpcMap.ts` —— **那不是 import，解析器永远看不见它**。
# 而加一个 RPC 的人，动的正是那个文件。它问「改这里该跑哪几套」得到的
# 是一句「没有套件覆盖」，于是那条「先问该跑哪几套」的规矩在最需要的
# 地方失效。显式声明是这里唯一可靠的路。
#
# 路径形状收得仍然紧:必须是仓库内 `apps/desktop/src/` 或 `packages/` 下的
# `.ts`。放开成任意路径会让声明变成「什么都能写」，那时它守不住任何东西
# —— 而它是 `covered` 集合的唯一来源之一，误写等于谎报回归网。
#
# 【T153】`src/preload/` 也放进来：`electron-u1` 通过 esbuild `entryPoints`
# 直接打包 `src/preload/index.ts`（build.mjs:215），那条边不是 import，图看不见。
# 声明是它唯一能被记录的途径。校验侧（见 `coverage()` 的 `is_relative_to(MAIN)`）
# 也要跟着认 PRELOAD。
SMOKE_COVERS_RE = re.compile(
    r"^\s*//\s*@smoke-covers\s+((?:src/main/|src/renderer/|src/preload/|packages/)[\w./-]+\.ts)\s*$",
    re.MULTILINE)


def display_path(p: Path | None) -> str:
    """把路径显示成**相对 apps/desktop**，退到相对仓库根，都不行就给绝对路径。

    ## 【T150】为什么不是一句 `p.relative_to(DESKTOP)`

    `resolve()` 明确放过**相对 import 越过包边界**：`@contracts/` 被丢掉（对），
    但 `"../../../../packages/contracts/src/capability.js"` 走 `.` 分支解析成功
    —— 于是 `packages/contracts/` 下的文件会进入依赖图。这是**正确的行为**
    （套件真的 import 了它们，改契约就该跑那些套件），漏的是这里的显示基准。

    在此之前这里写的是 `p.relative_to(DESKTOP)`。只要「上一跳」落在
    `packages/contracts/` 下（`closure()` 顺着 `modules.ts → moduleCapability.ts`
    这种边走一跳就会），`relative_to` 抛 `ValueError`，整个脚本 traceback 退出
    —— **连「这套覆盖了哪些」都打印不出来**，而那正是它唯一该回答的问题。

    ## 为什么不 try/except 吞掉

    吞掉会让「上一跳到底是谁」这个信息消失，而那是「可选」分组的全部价值
    （`经由 X（N 套）` 那一行就是在回答「这套为什么被带进来」）。所以退化路径
    必须**仍然给出可读的路径**，只是换一个基准。
    """
    if p is None:
        return "(不可达)"
    for base in (DESKTOP, ROOT):
        try:
            return p.relative_to(base).as_posix()
        except ValueError:
            continue
    return p.as_posix()


def is_indexed(p: Path) -> bool:
    """这个路径在不在依赖图能回答的范围内（见 `INDEXED_ROOTS`）。"""
    return any(p.is_relative_to(root) for root in INDEXED_ROOTS)


def print_no_coverage(want: Path) -> None:
    """在「没有任何套件覆盖它」的那一刻，说清这是结论还是边界。

    ## 【T152】为什么这不是一句话的事

    `hits` 为空有两种完全不同的原因：

    | 原因 | 这是 |
    |---|---|
    | 在索引范围内，但没有套件 import 它 | **结论** —— 查过了，确实没有 |
    | 根本不在索引范围内（`genoffice/` 等） | **边界** —— 没查，因为这里不在图上 |

    从前两种情况都打印「没有套件覆盖它 —— 改这里没有回归网」。对 vendor 路径
    来说那是**错误的否定结论**：Office 套件（`o0-format-fidelity-smoke` 等）真的
    覆盖 `genoffice/apps/*/src/renderer/`，只是依赖图不跟到那个子仓库。

    **而且它会被「修得更好」放大**：T150 把跳数与崩溃修好之后，这句警告在别处
    变得更可信，于是它在 vendor 上错得更有说服力。

    ## 为什么第三句不是「不在索引范围内」而是这句

    「不在索引范围内」描述的是工具的**排除项**；下面这句话描述的是工具的
    **定义域** —— 读者拿到的是「这个问题本身问错了」，而不是「这里被特殊对待了」。
    """
    if is_indexed(want):
        print("  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。")
        print("     要么补一套,要么改完自己写一次性探针验一遍然后删掉。")
        return
    print("  ⚠️ 本工具只回答「有没有套件覆盖 apps/desktop/src/**」。")
    print(f"     这个路径不在那个问题能回答的范围内（{display_path(want)}）。")
    print("     「不在图上」不等于「没有套件覆盖」—— 覆盖情况见对应任务卡。")


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

    ## 【T150】`@smoke-covers` 声明的文件算 **0 跳**

    `readFileSync` + 文本解析这种读法不在 import 图上（见 `coverage()` 那段注释），
    所以 `closure()` 能凭声明把它收进覆盖集，而 BFS 找不到任何一条边 —— 于是
    「在闭包里但算不出距离」那条内部矛盾告警会为每一套声明型覆盖亮起来。

    声明本身就是「这一套直接读了这个文件」的最强形式，所以它在距离上也该是
    最短的：**入口声明了 target，就是 0 跳**，和「入口文件自身就是 target」同义。
    这里按**入口文件**逐个检查它的声明行，而不是全目录扫一遍后再取并集 ——
    否则一套里任何一个文件声明了 target，整组入口都会被当成 0 跳。
    """
    best: int | None = None
    best_parent: Path | None = None
    for pattern in ("*.ts", "*.tsx", "*.jsx", "*.mjs"):
        for entry in suite_dir.rglob(pattern):
            # 【T150】入口自己声明了 target → 0 跳（声明读它 = 直接依赖）。
            if entry.suffix in (".ts", ".tsx", ".jsx", ".mjs"):
                try:
                    entry_text = entry.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    entry_text = ""
                declared = {
                    _resolve_declared(rel) for rel in SMOKE_COVERS_RE.findall(entry_text)
                }
                declared.discard(None)
                if target in declared:
                    return 0, None
            d, parent = distances_to(target, entry)
            if d is None:
                continue
            if best is None or d < best:
                best, best_parent = d, parent
                if best == 0:      # 已经是最短可能,不用再找
                    return best, best_parent
    return best, best_parent


def _resolve_declared(rel_path: str) -> Path | None:
    """把一条 `@smoke-covers` 声明解析成绝对路径（两个基准都试）。

    抽成函数是因为 `coverage()` 与 `suite_distance()` 必须**用同一份解析规则** ——
    两处各写一遍的话，声明在覆盖侧被记录、在距离侧被判成不可达，就会出现
    「在闭包里但算不出距离」的内部矛盾告警（T150 第一版正是这样）。
    """
    for base in (DESKTOP, ROOT):
        cand = (base / rel_path).resolve()
        if cand.is_file():
            return cand
    return None


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
    """套件名 → 它覆盖到的源码文件集合。

    【T153】不只 `-smoke`：`suite_kind()` 决定收谁（见它的注释）。
    """
    suites: dict[str, set[Path]] = {}
    for d in sorted(HERE.iterdir()):
        if not d.is_dir():
            continue
        if suite_kind(d.name, d) is None:
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
        # 【T150】`.ts` 入口也要认 `@smoke-covers`，不只是 `.mjs`。
        # 原来只扫 `.mjs`，因为当初这条机制是为「`.mjs` 动态转译源文件」做的。
        # 但 `readFileSync` + 解析文本这种读法同样不在 import 图上，而它很常见：
        # 实测 54 套 `.ts` 入口用 `readFileSync(join(process.cwd(), ...))` 读源码
        # （源码文本断言那一类）。只认 `.mjs` 等于那 54 套里凡是没被别的边覆盖到的
        # 文件，问下来都是「没有套件覆盖」。
        # `.ts` 本身走 `closure()`，所以这里只额外读一遍声明行 —— 幂等，不影响覆盖集合。
        for pattern in ("*.mjs", "*.ts", "*.tsx", "*.jsx"):
            for mjs in d.rglob(pattern):
                text = mjs.read_text(encoding="utf-8", errors="replace")
                for rel_path in SMOKE_COVERS_RE.findall(text):
                    # 【T150】两个基准都要试，因为声明的两种形状基准不同：
                    #   `src/main/...` / `src/renderer/...`  → 相对 apps/desktop（历史形状）
                    #   `packages/...`                        → 相对仓库根
                    # 只换成 ROOT 会把**所有既有的** `src/main/...` 声明拼成
                    # `mcode/src/main/...`（不存在）→ 全部 raise。反过来只留 DESKTOP
                    # 则 `packages/...` 拼成 `apps/desktop/packages/...`（也不存在）。
                    # 【T150】解析规则抽到 `_resolve_declared()` —— `suite_distance()`
                    # 也用它，两处必须同源（否则会出现「在闭包里但算不出距离」）。
                    target = _resolve_declared(rel_path)
                    # 守「声明不能谎报」:文件必须真的存在,且必须落在已知源码根之一。
                    # 不然一个笔误的声明会**凭空给套件加覆盖** —— 那正是「改了不用跑」的来源。
                    # 【T153】`src/preload/` 也算已知源码根（见 SMOKE_COVERS_RE 的注释）。
                    if target is None or not (
                        target.is_relative_to(MAIN)
                        or target.is_relative_to(RENDERER)
                        or target.is_relative_to(DESKTOP / "src" / "preload")
                        or target.is_relative_to(ROOT / "packages")
                    ):
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


# 【T153】除了 `*-smoke`，还有一类「重型套件」也覆盖 `apps/desktop/src/**` ——
# 它们起真 Electron / 真 Chrome，跑一次几十秒到几分钟，所以按本仓的命名约定
# 不带 `-smoke` 后缀（那个后缀承诺「无头、秒级」）。
#
# 从前 `coverage()` 只认 `-smoke`，于是这些套件的覆盖完全不计入 ——
# 对它们覆盖的文件，工具答「没有套件覆盖它」，而那是**结论式的假否定**。
#
# ## 判据：有「跑一次给结论」的入口文件 → 是套件
#
# 不按名字判（名字是约定，不是能力）。实测这九个非 `-smoke` 目录：
#
#   t96-probe              5 条真实 import      重型
#   arc005-visual-baseline 4 条                 重型（真 Electron 截图）
#   electron-u1            3 条                 重型（真 Electron U1）
#   flow-preview           3 条                 重型（真 Chrome，有 13 条 probe.check 断言）
#   mc035-egress-probe     1 条                 重型
#   md-preview             1 条                 重型（真 Chrome，有 10 条 probe.check 断言）
#   preset-scripts-sync    0 条                 普通脚本
#   o3-packaged-u1         0 条                 跑打包产物，不碰 src/
#   vscode-api-census      0 条                 普查工具
#
# **`flow-preview` / `md-preview` 是真套件，不是纯预览台** —— 这一条是变异实测出来的，
# 不是推的：把 `WorkflowFlowMini` / `Markdown` 各插一行 `throw`，两者都 `EXIT=1`
# （分别 0/2 和 2/10 通过）。按「改坏了会不会红」判，它们合格。
#
# 所以排除表只留三个**没有覆盖边、且加进来只会产生空覆盖集**的：
SUITE_EXCLUDED: dict[str, str] = {
    "preset-scripts-sync": "普通脚本（同步 preset 文件），不 import src/，不产生覆盖边",
    "o3-packaged-u1": "跑打包后的产物；覆盖 resources/genoffice/**，不碰 apps/desktop/src/**",
    "vscode-api-census": "普查工具（统计 VS Code API 使用面），不 import src/",
}

# 入口文件的判据。有其中之一就认为「这套能跑并给结论」。
SUITE_ENTRY_NAMES = ("run.sh", "run.mjs", "main.ts", "main.mjs", "main.mts")


def suite_kind(name: str, d: Path) -> str | None:
    """返回 "smoke" / "heavy" / None（不是套件）。

    - `*-smoke` 结尾 → "smoke"（历史约定，611 套）
    - 在 SUITE_EXCLUDED 里 → None
    - 有入口文件 → "heavy"
    - 否则 → None
    """
    if name.endswith("-smoke"):
        return "smoke"
    if name in SUITE_EXCLUDED:
        return None
    if any((d / cand).is_file() for cand in SUITE_ENTRY_NAMES):
        return "heavy"
    return None


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
        # 【T152】`--uncovered` 印的是 `apps/desktop/src/...`，而原来的分支把
        # `apps/` 前缀拼到 DESKTOP 上 → `apps/desktop/apps/desktop/src/...`，永远
        # 找不到。于是「照它给的清单再查一个」这条最自然的用法是死的。
        #
        # 两种写法现在都收，结果必须相同：
        #   `src/main/x.ts`            （相对 apps/desktop，历史用法）
        #   `apps/desktop/src/main/x.ts`（相对仓库根，`--uncovered` 的输出形状）
        if arg.startswith("apps/"):
            want = (ROOT / arg).resolve()
        elif arg.startswith("src/"):
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
                heavy = [n for _, _, n in must if suite_kind(n, HERE / n) == "heavy"]
                tail = f"，其中 {len(heavy)} 套重型" if heavy else ""
                print(f"\n  必跑（1–{NEED_JUMP} 跳，{len(must)} 套{tail}；跳数 {jumps}）:")
                for d, _p, n in must:
                    mark = "  ⚠️ 重型（起真 Electron/Chrome，几十秒起）" if suite_kind(n, HERE / n) == "heavy" else ""
                    print(f"    {n}  ({d} 跳){mark}")
            if optional:
                # 按「上一跳」分组 —— 那个中间模块才是「为什么它会被带进来」的答案。
                by_parent: dict[str, list[str]] = {}
                for _d, p, n in optional:
                    key = display_path(p)
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
            # 【T145】从前这里是 `bash apps/desktop/scripts/<名字>/run.sh` —— 从仓库根调
            # **会挂**：那些 run.sh 里 `cd "$(dirname "$0")/../.."` 之后还用相对路径的
            # `$0` 去 source esbuild-path.sh，拼出来是 apps/desktop/apps/desktop/...。
            # 用绝对路径调就不受调用者 cwd 影响，无论你在哪个目录都能贴。
            print("\n  bash " + (DESKTOP / "scripts" / "<名字>" / "run.sh").as_posix())
        else:
            print_no_coverage(want)
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
