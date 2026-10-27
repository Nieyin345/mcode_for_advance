"""从本机安装的 Claude Desktop 抽取 UI 外观事实（完整版）。

只读 Claude 安装目录；输出到 Mcode 的 .tmp/claude-ui-extract/。

产出：
  tokens.json      全部 --cds-* 定义（含各自的选择器作用域）
  density.json     随 data-density 切换的 token
  scopes.json      所有 data-* 作用域及出现次数
  tiles.json       Code 页 pane tile 模型（类型、布局、尺寸）
  chat-columns.json  data-chat-column 的列覆盖模型
  rules/*.json     关键组件（sidebar/composer/message/pane/diff/terminal）的 CSS 规则

用法：
    python -I .scratch/claude-ui-extract/extract.py
"""
import io
import json
import os
import re
import sys
from collections import defaultdict

CLAUDE_ION = r"C:/Program Files/WindowsApps/Claude_3.1623.4.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist"
ASSETS = os.path.join(CLAUDE_ION, "assets", "v1")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), ".tmp", "claude-ui-extract")

# 主样式表：1027 个 --cds-* token 所在
MAIN_CSS = "c6a992d55-Bt_TAkxU.css"


def read(p):
    with io.open(p, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def iter_rules(css):
    """摊平 CSS 规则，返回 (选择器, 正文)。支持一层 at-rule 包裹。"""
    i, n, depth = 0, len(css), 0
    sel_start = 0
    body_start = None
    stack = []
    while i < n:
        ch = css[i]
        if ch == "{":
            if depth == 0:
                sel = css[sel_start:i].strip()
                body_start = i + 1
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and body_start is not None:
                yield sel, css[body_start:i]
                body_start = None
                sel_start = i + 1
        elif ch == ";" and depth == 0:
            sel_start = i + 1
        i += 1


def main():
    os.makedirs(OUT, exist_ok=True)
    css = read(os.path.join(ASSETS, MAIN_CSS))
    print("主样式表 %.2f MB" % (len(css) / 1e6))

    rules = list(iter_rules(css))
    print("规则数:", len(rules))

    # ── 1. 全部 token ──
    defs = defaultdict(list)
    for sel, body in rules:
        for m in re.finditer(r"(--cds-[a-z0-9-]+)\s*:\s*([^;]+)", body):
            defs[m.group(1)].append({"sel": sel[:180], "val": m.group(2).strip()[:180]})
    with io.open(os.path.join(OUT, "tokens.json"), "w", encoding="utf-8") as f:
        json.dump(dict(sorted(defs.items())), f, ensure_ascii=False, indent=1)
    print("token:", len(defs))

    # ── 2. 密度切换 ──
    # `data-density` 出现在 `:where([data-density=compact], [data-density=compact] *)`
    # 这种**函数内部**，不是选择器前缀。所以按子串匹配选择器整体，不按前缀。
    dens = {}
    for name, entries in defs.items():
        c = [e["val"] for e in entries if "data-density=compact" in e["sel"]]
        f_ = [e["val"] for e in entries if "data-density=comfortable" in e["sel"]]
        if c or f_:
            dens[name] = {"compact": c, "comfortable": f_}
    with io.open(os.path.join(OUT, "density.json"), "w", encoding="utf-8") as f:
        json.dump(dens, f, ensure_ascii=False, indent=1)
    print("密度相关 token:", len(dens))

    # ── 3. data-* 作用域 ──
    scopes = defaultdict(int)
    for sel, _ in rules:
        for m in re.finditer(r"\[data-([a-z-]+)(?:=([a-z0-9-]+))?\]", sel):
            scopes[(m.group(1), m.group(2) or "*")] += 1
    with io.open(os.path.join(OUT, "scopes.json"), "w", encoding="utf-8") as f:
        json.dump([{"attr": a, "value": v, "n": c} for (a, v), c in
                   sorted(scopes.items(), key=lambda x: -x[1])],
                  f, ensure_ascii=False, indent=1)
    print("data-* 作用域:", len(scopes))

    # ── 4. 关键组件规则 ──
    KEYS = ["sidebar", "session-row", "composer", "message", "transcript",
            "pane", "tile", "diff", "terminal", "worktree", "project",
            "chat-column", "header", "nav"]
    os.makedirs(os.path.join(OUT, "rules"), exist_ok=True)
    for k in KEYS:
        hit = [{"sel": sel[:400], "body": body[:900]}
               for sel, body in rules if k in sel.lower()]
        if hit:
            with io.open(os.path.join(OUT, "rules", k + ".json"), "w", encoding="utf-8") as f:
                json.dump(hit, f, ensure_ascii=False, indent=1)
            print("  规则 %-14s %d" % (k, len(hit)))

    # ── 5. JS 侧的 tile 模型与列覆盖（只取结构常量，不取业务逻辑）──
    js_facts = {"tileTypes": [], "chatColumns": [], "paneViews": [], "popoutTypes": []}
    tile_types = set()
    chat_cols = set()
    pane_views = set()
    popout = set()
    for fn in sorted(os.listdir(ASSETS)):
        if not fn.endswith(".js"):
            continue
        try:
            js = read(os.path.join(ASSETS, fn))
        except Exception:
            continue
        tile_types.update(re.findall(r'new Set\(\[((?:"[a-z]+",?)+)\]\)', js))
        chat_cols.update(re.findall(r'"data-chat-column":"([a-z]+)"', js))
        pane_views.update(re.findall(
            r'\b(previewServerId|artifactView|fileView|fileTabs|browserView|'
            r'subagentView|sessionView|prView|crView)\b', js))
        popout.update(re.findall(r'type==="([a-z-]+)"|type:"([a-z-]+)"', js)[:0] or
                      re.findall(r'type:"(epitaxy-[a-z-]+)"', js))
    js_facts["chatColumns"] = sorted(chat_cols)
    js_facts["paneViews"] = sorted(pane_views)
    js_facts["popoutTypes"] = sorted(popout)
    js_facts["tileTypes"] = sorted(tile_types)
    with io.open(os.path.join(OUT, "tiles.json"), "w", encoding="utf-8") as f:
        json.dump(js_facts, f, ensure_ascii=False, indent=1)
    print("列覆盖:", js_facts["chatColumns"])
    print("pane 视图:", js_facts["paneViews"])
    print("tile 类型集:", js_facts["tileTypes"][:3])

    print("\n输出:", OUT)


if __name__ == "__main__":
    main()
