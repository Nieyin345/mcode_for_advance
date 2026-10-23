"""【T78】`smokes-for.py` 的距离分级回归。

## 钉住什么

`smokes-for.sh <文件>` 原来只打一份平铺的套件清单。实测
`src/main/document/documentToolSurface.ts` 会出 98 套（全量的 18%），
**而真正 1 跳的只有 2 套**。宽到没人跑，那条「改一处先问该跑哪几套」的规矩就失效了。

T78 加了一层**距离分级**：按「距改动文件的最短 import 跳数」分成
「必跑（1–2 跳）」与「可选（≥3 跳，按中间模块分组）」。

## 本套钉三条

1. **正控**：只在 1 跳内的套件，必须在「必跑」里 —— 且 `suite_distance` 真的返回 1。
2. **负控**：只有经由 `appControl/tools.ts` 才相关的套件，必须**不在**「必跑」里。
   这条防的是「分级根本没生效，全部进了必跑」。
3. **不漏控**：`必跑 ∪ 可选` 必须等于**完整闭包**。

第 3 条是这张卡的核心：**分级只重排、不过滤**。没有它，分级就成了
「悄悄漏跑」的工具 —— 哪天距离算出 None，那套会从必跑里消失，
而人看到的仍是一份「看起来正常」的清单。

## 为什么不跑 `smokes-for.sh` 子进程

直接 import `smokes-for.py`（它没有 `main()` 之外的副作用），用它的
`coverage()` / `suite_distance()` / `path_chain_to()`。这样断言能拿到
**内部判定**（跳数、上一跳是谁），而不只是解析出来的文本 ——
文本断言会在改输出格式时假红。

## 边界

只读 + 在 OS temp 里造夹具；不改任何产品文件、不改 `smokes-for.py`。
"""

import importlib.util
import sys
import tempfile
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent      # apps/desktop/scripts/smokes-for-ranking-smoke
SCRIPTS = HERE.parent                       # apps/desktop/scripts
DESKTOP = SCRIPTS.parent                    # apps/desktop
REPO = DESKTOP.parent.parent                # 仓库根（apps/desktop → apps → 根）
SMOKES_FOR = SCRIPTS / "smokes-for.py"

if not SMOKES_FOR.is_file():
    print(f"FAIL 找不到 {SMOKES_FOR}")
    sys.exit(1)

spec = importlib.util.spec_from_file_location("smokes_for", SMOKES_FOR)
sf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sf)

total = 0
failures = 0


def check(name: str, cond: bool, detail: object = None) -> None:
    global total, failures
    total += 1
    if cond:
        print(f"  ok   {name}")
    else:
        failures += 1
        print(f"  FAIL {name}{'' if detail is None else ' — ' + repr(detail)}")


print("\n前提:smokes-for.py 可导入且能算出覆盖")
suites = sf.coverage()
check("coverage() 返回的套件数 > 400", len(suites) > 400, len(suites))

# ── 正控:入口直接 import 的文件 ────────────────────────────────────────────
print("\n① 正控:1 跳 = 必跑")
TARGET = (sf.MAIN / "document" / "documentToolSurface.ts").resolve()
check("被测文件存在", TARGET.is_file(), str(TARGET))

must_l, optional_l, unreachable_l = sf.rank(suites, TARGET)
must = {n for _d, _p, n in must_l}
optional = {n for _d, _p, n in optional_l}
unreachable = set(unreachable_l)
hop_of = {n: d for d, _p, n in must_l}
hop_of.update({n: d for d, _p, n in optional_l})

# 【T78 变异验证抓到的第二个漏洞】第一版套件在这里自己重算了 `d <= 2`，
# 而 `NEED_JUMP` 当时只是 `main()` 输出分支里的局部变量 —— 把阈值改成 99
# （所有套件都进必跑，分级等于失效），套件**照样全绿**。
# 断言必须读**同一份实现**，不能测自己的副本。
check("套件断言的是 smokes-for.py 的 rank()，不是自己重算的分级",
      hasattr(sf, "rank") and hasattr(sf, "NEED_JUMP"),
      (hasattr(sf, "rank"), hasattr(sf, "NEED_JUMP")))
check("必跑上限是 2 跳(常量唯一来源)",
      sf.NEED_JUMP == 2, sf.NEED_JUMP)

# 【T78 变异验证抓到的漏洞】第一版把「距离算不出来」和「≥3 跳」一起归进可选。
# 那样任何 BFS 的 bug 都会把一套从必跑静默降级成可选，而 must|optional==hits
# 仍然成立 ——「不漏控」照样绿。这条断言把那种形态挡在门外。
check("闭包里每一套都算得出距离(否则分级会静默降级)",
      not unreachable, sorted(unreachable)[:5])

check("t24 在必跑里，且跳数为 1",
      "t24-document-tool-surface-smoke" in must
      and hop_of.get("t24-document-tool-surface-smoke") == 1,
      hop_of.get("t24-document-tool-surface-smoke"))
check("t43 在必跑里，且跳数为 1",
      "t43-document-ai-design-pipeline-smoke" in must
      and hop_of.get("t43-document-ai-design-pipeline-smoke") == 1,
      hop_of.get("t43-document-ai-design-pipeline-smoke"))

# ── 负控:经由 tools.ts 的必须在可选里 ──────────────────────────────────────
print("\n② 负控:只经由 appControl/tools.ts 的套件不得进必跑")
# agent-guide-smoke 是实测出来的「main.ts → tools.ts → target」形态（2 跳）。
# 它**在**必跑里是当前阈值（≤2）的结果 —— 这条负控要盯的是**更远**的那些。
FAR = "mobile-pairing-smoke"
check(f"{FAR} 在闭包里", FAR in (must | optional), FAR in suites)
check(f"{FAR} 不在必跑里", FAR not in must, sorted(must)[:5])
check(f"{FAR} 在可选里", FAR in optional)
chain = None
for pat in ("*.ts", "*.tsx", "*.jsx"):
    for entry in (sf.HERE / FAR).rglob(pat):
        c = sf.path_chain_to(TARGET, entry)
        if c and (chain is None or len(c) < len(chain)):
            chain = c
check(f"{FAR} 的距离 ≥ 3 跳", chain is not None and len(chain) - 1 >= 3,
      None if chain is None else len(chain) - 1)

# ── 不漏控 ────────────────────────────────────────────────────────────────
print("\n③ 不漏控:必跑 ∪ 可选 = 完整闭包")
hits = {n for n, cov in suites.items() if TARGET in cov}
check("没有套件在两个集合之外", (must | optional) == hits,
      sorted(hits - (must | optional))[:5])
check("两个集合不重叠", not (must & optional), sorted(must & optional)[:5])
check("分级后的总数 = 闭包总数", len(must) + len(optional) == len(hits),
      (len(must), len(optional), len(hits)))
print(f"      必跑 {len(must)} / 可选 {len(optional)} / 闭包 {len(hits)}")

# ── 分级对别的文件也有效（不是只对这一个文件） ─────────────────────────────
print("\n④ 换两个文件，分级同样成立")
for rel in ("src/main/library/operations.ts", "src/main/appControl/policy.ts"):
    f = (DESKTOP / rel).resolve()
    if not f.is_file():
        check(f"{rel} 存在", False)
        continue
    for name, cov in suites.items():
        pass
    m_l, o_l, u_l = sf.rank(suites, f)
    m = {n for _d, _p, n in m_l}
    o = {n for _d, _p, n in o_l}
    h = {n for n, cov in suites.items() if f in cov}
    check(f"{rel}: 分级不丢套件", (m | o) == h, sorted(h - (m | o))[:5])
    check(f"{rel}: 没有算不出距离的套件", not u_l, u_l[:5])
    check(f"{rel}: 必跑非空", len(m) > 0, len(m))
    print(f"      必跑 {len(m)} / 可选 {len(o)} / 闭包 {len(h)}")

# ── 距离函数本身：造一个确定形状的图来验 BFS 的最短性 ──────────────────────
print("\n⑤ 距离函数是最短跳数(用临时图验证，不碰仓库)")
tmp = Path(tempfile.mkdtemp(prefix="t78-hop-"))
try:
    # a.ts(入口) → b.ts → c.ts → target
    #             ↘─────────↗  (b 也直接指向 target，所以最短是 2)
    (tmp / "a.ts").write_text('import { x } from "./b.js";\n', encoding="utf-8")
    (tmp / "b.ts").write_text(
        'import { y } from "./c.js";\nimport { z } from "./target.js";\n', encoding="utf-8")
    (tmp / "c.ts").write_text('import { w } from "./target.js";\n', encoding="utf-8")
    target = (tmp / "target.ts").write_text("export const t = 1;\n", encoding="utf-8")
    tpath = (tmp / "target.ts").resolve()
    d, parent = sf.distances_to(tpath, (tmp / "a.ts").resolve())
    check("BFS 取的是**最短**路径(2 跳，不是 3)", d == 2, d)
    check("上一跳是 b.ts(最短路径上的那一跳)", parent is not None and parent.name == "b.ts",
          None if parent is None else parent.name)
    d2, _ = sf.distances_to(tpath, (tmp / "b.ts").resolve())
    check("从 b 出发是 1 跳", d2 == 1, d2)
    d3, _ = sf.distances_to(tpath, (tmp / "target.ts").resolve())
    check("从 target 自身出发是 0 跳", d3 == 0, d3)
    (tmp / "isolated.ts").write_text("export const q = 1;\n", encoding="utf-8")
    d4, p4 = sf.distances_to(tpath, (tmp / "isolated.ts").resolve())
    check("不可达返回 (None, None)", d4 is None and p4 is None, (d4, p4))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\nsmokes-for-ranking-smoke: {total - failures}/{total} 通过")
sys.exit(0 if failures == 0 else 1)
