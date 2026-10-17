#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""引用核对:把稿件引用的文献逐条拿到 Mcode 资料库里对。

用法:
    python check_citations.py refs.bib
    python check_citations.py refs.bib --manuscript 稿件.tex
    python check_citations.py refs.bib --root "D:/destop/work_space/mcode"

输出四段:
    1. 库里有对应的来源链接 —— 仍需核实链接与原文的真实性
    2. 库里没有,但疑似同一条 —— 标题很像,可能是元数据写法不同,人工看一眼
    3. 库里没有,也对不上 —— 只能说明尚未在本地核实,请外部核实后再引用
    4. 稿件引用但 .bib 里没有 —— 用了不存在的 key

这个脚本只读,绝不写 mcode.db(理由见 library.py 开头)。
"""

import argparse
import difflib
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from library import connect, find_data_root  # noqa: E402  (同目录的兄弟脚本)

# 输出一律 UTF-8 —— 理由见 library.py 顶部(Windows 的代码页会把中文标题写坏)。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 标题相似的阈值。低于它的不报 —— 宁可漏报"疑似",也不要拿一堆噪声淹没真正对不上的。
TITLE_SIMILARITY = 0.82


def norm(text):
    """归一化标题:小写、去掉标点与多余空白。中英文都适用。"""
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", " ", text)
    return " ".join(text.split())


def ids_from_url(url):
    """只从用户/外部工具填写的来源 URL 中识别标识符，不依赖已退役的学术列。"""
    if not url:
        return "", ""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return "", ""
    part = unquote(parsed.path).strip("/")
    if host in ("doi.org", "dx.doi.org") and part.lower().startswith("10."):
        return part.lower(), ""
    if host in ("arxiv.org", "export.arxiv.org") and part.startswith(("abs/", "pdf/")):
        arxiv = part.split("/", 1)[1]
        return "", arxiv.removesuffix(".pdf").lower()
    return "", ""


def parse_bib(text):
    """极简 BibTeX 解析。只取我们真正会用的字段,不追求完备。"""
    entries = []
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,]+),", text):
        typ, key = m.group(1).lower(), m.group(2).strip()
        if typ in ("comment", "preamble", "string"):
            continue
        # 从这条的起始括号开始配平,切出正文
        start = m.end()
        depth = 1
        i = start
        while i < len(text) and depth > 0:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
            i += 1
        body = text[start:i - 1]
        fields = {}
        for fm in re.finditer(r"(\w+)\s*=\s*\{", body):
            name = fm.group(1).lower()
            j = fm.end()
            d = 1
            while j < len(body) and d > 0:
                if body[j] == "{":
                    d += 1
                elif body[j] == "}":
                    d -= 1
                j += 1
            fields[name] = " ".join(body[fm.end():j - 1].split())
        for fm in re.finditer(r"(\w+)\s*=\s*\"([^\"]*)\"", body):
            fields.setdefault(fm.group(1).lower(), fm.group(2))
        entries.append({"key": key, "type": typ, "fields": fields})
    return entries


def cited_keys(manuscript):
    r"""稿件里出现过的引用键(LaTeX 的 cite{a,b} 与 Pandoc 的 [@a; @b] 两种写法)。"""
    text = manuscript.read_text(encoding="utf-8", errors="replace")
    keys = set()
    for m in re.finditer(r"\\?cite[a-zA-Z]*\*?(?:\[[^\]]*\])?\{([^}]*)\}", text):
        keys.update(k.strip() for k in m.group(1).split(",") if k.strip())
    for m in re.finditer(r"@([A-Za-z0-9_:.+-]+)", text):
        keys.add(m.group(1))
    return keys


def main():
    ap = argparse.ArgumentParser(description="把 .bib 逐条拿到 Mcode 资料库里核对")
    ap.add_argument("bib", help=".bib 文件路径")
    ap.add_argument("--manuscript", help="稿件文件;给了就顺便查有没有引用 .bib 里没有的 key")
    ap.add_argument("--root", help="数据根绝对路径;省略则自动查找")
    args = ap.parse_args()

    bib = Path(args.bib)
    if not bib.exists():
        sys.exit("找不到 " + str(bib))
    entries = parse_bib(bib.read_text(encoding="utf-8", errors="replace"))
    if not entries:
        sys.exit("这个 .bib 里没解析出任何条目")

    root = find_data_root(args.root)
    conn = connect(root)
    cur = conn.cursor()
    rows = cur.execute(
        "SELECT id, title, url FROM library_items",
    ).fetchall()
    conn.close()

    by_doi = {}
    by_arxiv = {}
    by_title = []
    for iid, title, url in rows:
        doi, arxiv = ids_from_url(url)
        if doi:
            by_doi[doi] = (iid, title, "", "")
        if arxiv:
            by_arxiv[arxiv] = (iid, title, "", "")
        by_title.append((iid, norm(title), title, "", ""))

    found, near, missing = [], [], []
    for e in entries:
        f = e["fields"]
        doi = (f.get("doi") or "").strip().lower()
        arxiv = (f.get("eprint") or "").strip().lower()
        title = f.get("title") or ""
        hit = None
        if doi and doi in by_doi:
            hit = by_doi[doi]
        elif arxiv and arxiv in by_arxiv:
            hit = by_arxiv[arxiv]
        if hit:
            found.append((e["key"], title, hit))
            continue
        nt = norm(title)
        best, score = None, 0.0
        if nt:
            for iid, ntitle, raw, year, venue in by_title:
                if not ntitle:
                    continue
                r = difflib.SequenceMatcher(None, nt, ntitle).ratio()
                if r > score:
                    best, score = (iid, raw, year, venue), r
        if best and score >= TITLE_SIMILARITY:
            near.append((e["key"], title, best, score))
        else:
            missing.append((e["key"], title, f.get("year") or "", f.get("author") or "", score, best))

    print("库里有 " + str(len(found)) + " 条:")
    for key, title, hit in found:
        print("  [OK] " + key + "  ->  库中:" + (hit[1] or "") + "  (id=" + hit[0] + ")")

    if near:
        print("")
        print("库里没有,但标题很像 " + str(len(near)) + " 条(人工看一眼):")
        for key, title, best, score in near:
            print("  [~] " + key + "  " + title)
            print("      最像的是:" + (best[1] or "") + "  (id=" + best[0] + ",相似度 " + ("%.2f" % score) + ")")

    if missing:
        print("")
        print("!! 库里没有,也对不上 " + str(len(missing)) + " 条 —— 仅凭本地库无法断定真伪,请外部核实后再引用:")
        for key, title, year, author, score, best in missing:
            print("  [X] " + key + "  " + (title or "(无标题)"))
            detail = ", ".join(x for x in [author, year] if x)
            if detail:
                print("      著录:" + detail)
            if best:
                print("      库里最接近的也只是:" + (best[1] or "") + "  (相似度 " + ("%.2f" % score) + ")")

    if args.manuscript:
        ms = Path(args.manuscript)
        if not ms.exists():
            sys.exit("找不到 " + str(ms))
        used = cited_keys(ms)
        known = {e["key"] for e in entries}
        ghosts = sorted(k for k in used if k not in known)
        print("")
        if ghosts:
            print("稿件引用了 .bib 里没有的 key " + str(len(ghosts)) + " 个:")
            for k in ghosts:
                print("  [X] " + k)
        else:
            print("稿件里引用的 key 都在 .bib 里。")

    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
