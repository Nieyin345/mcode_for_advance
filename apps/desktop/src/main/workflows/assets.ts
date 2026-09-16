/**
 * 流程脚本的**正文**,以字符串形式随应用发布,首次使用时写到 `<数据根>/workflows/scripts/`。
 *
 * ## 为什么内嵌成字符串,而不是放 resources/ 再复制
 *
 * 放 `resources/` 需要一个 electron-vite 插件在构建时把它们拷到产物里(renderer 的
 * pdfjs 资源就是这么做的),而它有两条路径要同时照顾:开发时跑源码、打包后跑 asar。
 * 这两条路径一旦有一条没对上,表现是"脚本不存在",而那正是流程依赖的东西 —— 失败
 * 得又远又难查。内嵌成字符串只有一条路径:主进程知道正文,写到哪就是哪。
 *
 * 代价是改脚本要重新构建应用。对一个**每次都要重新构建**的开发期功能来说,这个代价
 * 比路径写错小得多。
 *
 * ## ⚠️ 改这里的 Python 时注意
 *
 * 下面用的是 TS 模板字符串,所以 Python 正文里**不能出现反引号和 `${`**。
 * 需要强调的地方用 「」 或引号,别用 Markdown 的反引号。
 */

/**
 * 资料库查询(只读)。
 *
 * 存在的理由:模式提示词反复要求"只引用库里实际存在的条目",而模型手上没有查库的
 * 工具 —— 它只能去读清单文件,清单又只覆盖某一个分类。这个脚本让它能**按条件查
 * 整个库**(标题、作者、年份、摘要、全文 Markdown),拿到条目的绝对路径。
 */
export const LIBRARY_PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""资料库查询(只读)。

Mcode 的资料库布局:
    <数据根>/library/papers/     PDF(内容寻址,文件名是 sha256,靠人眼认不出来)
    <数据根>/library/markdown/   转换出的 Markdown(优先读这个)
    <数据根>/library/notes/      笔记
    <数据根>/mcode.db            数据库 —— 条目、分类、笔记都在这里

!!! 绝对不要写 mcode.db !!!
Mcode 把整个数据库放在内存里,任何一次变更都会把整份文件重写一遍。从外面写进去的
东西会在应用下一次保存时被无声地覆盖 —— 看起来写成功了,其实没有。所以这个脚本
只读。要改库,走 Mcode 的界面(或者在对话里把内容交给用户,让他自己存)。

用法:
    python library.py list                     列出全部条目
    python library.py list --kind paper        只看论文(paper / textbook / note)
    python library.py find 关键词               在标题/作者/期刊/摘要里搜
    python library.py show 0f3a2c              看一条的完整字段(id 前缀或标题片段)
    python library.py files --kind paper       只列文件路径(给"我该读哪个文件"用)
    python library.py notes                    列出所有笔记,连同它挂在哪一条上
    python library.py collections              列出分类树

默认从 Mcode 的记录里找数据根(APPDATA 下的 data-root.json);也可以显式给:
    python library.py --root "D:/destop/work_space/mcode" list
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

# 输出一律 UTF-8。
# Windows 上 Python 默认按控制台代码页(简体中文是 GBK)写 stdout,而读它的那一端
# (agent 的 Bash 工具、编辑器、管道)按 UTF-8 解 —— 中文标题会变成一堆问号,模型
# 就没法按标题匹配了。这里显式把三个流定死成 UTF-8,与平台无关。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def find_data_root(explicit):
    """数据根:显式参数 > 环境变量 > Mcode 的指针文件 > ~/Mcode。"""
    if explicit:
        return Path(explicit)
    env = os.environ.get("MCODE_DATA_ROOT")
    if env:
        return Path(env)
    home = Path.home()
    candidates = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "@mcode" / "desktop" / "data-root.json")
    candidates.append(home / "Library" / "Application Support" / "@mcode" / "desktop" / "data-root.json")
    candidates.append(home / ".config" / "@mcode" / "desktop" / "data-root.json")
    for c in candidates:
        try:
            return Path(json.loads(c.read_text(encoding="utf-8"))["root"])
        except Exception:
            continue
    return home / "Mcode"


def connect(root):
    db = root / "mcode.db"
    if not db.exists():
        sys.exit("找不到数据库:" + str(db))
    # 只读方式打开。应用正在跑的时候也一样安全 —— 读不会打断它,写才会被覆盖。
    return sqlite3.connect(db.absolute().as_uri() + "?mode=ro", uri=True)


def author_names(raw):
    """authors 列是 JSON 数组,元素形如 {"family":..., "given":...} 或 {"literal":...}。"""
    try:
        arr = json.loads(raw) if raw else []
    except Exception:
        return ""
    out = []
    for a in arr:
        if not isinstance(a, dict):
            continue
        name = a.get("literal") or " ".join(x for x in [a.get("given"), a.get("family")] if x)
        if name:
            out.append(name)
    return ", ".join(out)


def file_of(root, md_path, pdf_path):
    """这一条该读哪个文件。Markdown 优先,没有才退回 PDF —— 并说清那是 PDF。"""
    lib = root / "library"
    if md_path:
        return str(lib / md_path)
    if pdf_path:
        return str(lib / pdf_path) + "   [PDF,尚未转 Markdown]"
    return "(没有文件)"


def kind_filter(kind):
    if kind:
        return " AND kind = ?", [kind]
    return "", []


def cmd_list(cur, root, args):
    where, params = kind_filter(args.kind)
    rows = cur.execute(
        "SELECT id, title, authors, year, venue, md_path, pdf_path FROM library_items"
        " WHERE 1=1" + where + " ORDER BY year DESC, title",
        params,
    ).fetchall()
    print("共 " + str(len(rows)) + " 条")
    for iid, title, authors, year, venue, md, pdf in rows:
        print("- " + title)
        bits = [author_names(authors), str(year) if year else "", venue or ""]
        head = " · ".join([b for b in bits if b])
        if head:
            print("    " + head)
        print("    id=" + iid + "  文件:" + file_of(root, md, pdf))


def cmd_find(cur, root, args):
    q = "%" + args.query + "%"
    where, params = kind_filter(args.kind)
    rows = cur.execute(
        "SELECT id, title, authors, year, venue, md_path, pdf_path FROM library_items"
        " WHERE (LOWER(title) LIKE LOWER(?) OR LOWER(IFNULL(authors,'')) LIKE LOWER(?)"
        "        OR LOWER(IFNULL(abstract,'')) LIKE LOWER(?) OR LOWER(IFNULL(venue,'')) LIKE LOWER(?))"
        + where + " ORDER BY year DESC, title",
        [q, q, q, q] + params,
    ).fetchall()
    print('匹配 "' + args.query + '":' + str(len(rows)) + " 条")
    for iid, title, authors, year, venue, md, pdf in rows:
        print("- " + title)
        bits = [author_names(authors), str(year) if year else "", venue or ""]
        head = " · ".join([b for b in bits if b])
        if head:
            print("    " + head)
        print("    id=" + iid + "  文件:" + file_of(root, md, pdf))
    if not rows:
        print("(库里没有匹配的条目。不要因此凭记忆引用 —— 要么换关键词再找,要么如实说库里没有。)")


def resolve_one(cur, query):
    """id 前缀优先,其次标题片段。返回匹配到的行(可能多条)。"""
    rows = cur.execute(
        "SELECT id, title, authors, year, venue, doi, arxiv_id, volume, issue, page, publisher,"
        " abstract, type, url, md_path, pdf_path FROM library_items WHERE id LIKE ?",
        [query + "%"],
    ).fetchall()
    if not rows:
        rows = cur.execute(
            "SELECT id, title, authors, year, venue, doi, arxiv_id, volume, issue, page, publisher,"
            " abstract, type, url, md_path, pdf_path FROM library_items"
            " WHERE LOWER(title) LIKE LOWER(?)",
            ["%" + query + "%"],
        ).fetchall()
    return rows


def cmd_show(cur, root, args):
    rows = resolve_one(cur, args.query)
    if not rows:
        sys.exit("库里没有匹配 " + args.query + " 的条目")
    if len(rows) > 1:
        print("匹配到 " + str(len(rows)) + " 条,请用更精确的 id 或标题:")
        for r in rows:
            print("  " + r[0] + "  " + r[1])
        return
    (iid, title, authors, year, venue, doi, arxiv, volume, issue, page,
     publisher, abstract, typ, url, md, pdf) = rows[0]
    print("# " + title)
    print("")
    for label, value in [
        ("作者", author_names(authors)),
        ("年份", str(year) if year else ""),
        ("期刊/会议", venue or ""),
        ("类型", typ or ""),
        ("卷期页", " ".join(x for x in [volume, issue, page] if x)),
        ("出版商", publisher or ""),
        ("DOI", doi or ""),
        ("arXiv", arxiv or ""),
        ("URL", url or ""),
    ]:
        if value:
            print(label + ":" + value)
    print("id:" + iid)
    print("文件:" + file_of(root, md, pdf))
    if abstract:
        print("")
        print("## 摘要")
        print(abstract)
    notes = cur.execute(
        "SELECT content, origin, created_at FROM library_notes WHERE item_id = ? ORDER BY created_at",
        [iid],
    ).fetchall()
    if notes:
        print("")
        print("## 用户在这一条上记的笔记")
        for content, origin, _ in notes:
            print("- " + " ".join(content.split()) + ("   [来源:" + origin + "]" if origin != "user" else ""))


def cmd_files(cur, root, args):
    where, params = kind_filter(args.kind)
    if args.missing_md:
        where += " AND (md_path IS NULL OR md_path = '')"
    rows = cur.execute(
        "SELECT id, title, md_path, pdf_path FROM library_items WHERE 1=1" + where
        + " ORDER BY title",
        params,
    ).fetchall()
    for iid, title, md, pdf in rows:
        print(file_of(root, md, pdf) + "    <- " + title + "  (id=" + iid + ")")


def cmd_notes(cur, root, args):
    rows = cur.execute(
        "SELECT n.content, n.origin, i.title, i.id FROM library_notes n"
        " LEFT JOIN library_items i ON i.id = n.item_id ORDER BY n.created_at",
    ).fetchall()
    if not rows:
        print("(还没有任何笔记)")
        return
    for content, origin, title, iid in rows:
        print("- [" + (title or "?") + "] " + " ".join(content.split()))
        if origin != "user":
            print("    来源:" + origin)
        if iid:
            print("    条目 id:" + iid)


def cmd_collections(cur, root, args):
    rows = cur.execute(
        "SELECT id, name, kind, parent_id FROM library_collections ORDER BY kind, sort_order, name",
    ).fetchall()
    if not rows:
        print("(还没有分类)")
        return
    by_parent = {}
    for iid, name, kind, parent in rows:
        by_parent.setdefault((kind, parent), []).append((iid, name))

    def walk(kind, parent, depth):
        for iid, name in by_parent.get((kind, parent), []):
            print("  " * depth + "- " + name + "  (id=" + iid + ")")
            walk(kind, iid, depth + 1)

    for kind in ["paper", "textbook", "note"]:
        if by_parent.get((kind, None)) or any(k[0] == kind for k in by_parent):
            print(kind + ":")
            walk(kind, None, 1)


def main():
    ap = argparse.ArgumentParser(description="Mcode 资料库查询(只读)")
    ap.add_argument("--root", help="数据根绝对路径;省略则自动查找")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出条目")
    p.add_argument("--kind", choices=["paper", "textbook", "note"])
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("find", help="按关键词搜索")
    p.add_argument("query")
    p.add_argument("--kind", choices=["paper", "textbook", "note"])
    p.set_defaults(fn=cmd_find)

    p = sub.add_parser("show", help="看一条的完整字段")
    p.add_argument("query", help="条目 id 前缀,或标题片段")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("files", help="列出文件路径")
    p.add_argument("--kind", choices=["paper", "textbook", "note"])
    p.add_argument("--missing-md", action="store_true", help="只看还没有 Markdown 的")
    p.set_defaults(fn=cmd_files)

    p = sub.add_parser("notes", help="列出笔记")
    p.set_defaults(fn=cmd_notes)

    p = sub.add_parser("collections", help="列出分类树")
    p.set_defaults(fn=cmd_collections)

    args = ap.parse_args()
    root = find_data_root(args.root)
    conn = connect(root)
    try:
        args.fn(conn.cursor(), root, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
`;

/**
 * 引用核对。
 *
 * 存在的理由:「引用必须真实可核,绝不编造文献」是写作与评审模式里最硬的一条要求,
 * 而它是**可以被机械检查的** —— 把稿件引用的 .bib 逐条拿到库里对,对不上的挑出来。
 * 靠模型自己"注意别编"是自律;靠这个脚本是事实。
 *
 * 匹配分三档:DOI 精确 > 标题相似度(>=0.82) > 对不上。第三档最要紧 —— 那是最可能
 * 编出来的东西,必须让用户看见。
 */
export const CHECK_CITATIONS_PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""引用核对:把稿件引用的文献逐条拿到 Mcode 资料库里对。

用法:
    python check_citations.py refs.bib
    python check_citations.py refs.bib --manuscript 稿件.tex
    python check_citations.py refs.bib --root "D:/destop/work_space/mcode"

输出四段:
    1. 库里有 —— 这些可以放心引
    2. 库里没有,但疑似同一条 —— 标题很像,可能是元数据写法不同,人工看一眼
    3. 库里没有,也对不上 —— **最要紧的一档**:很可能是编造的,不要引
    4. 稿件引用但 .bib 里没有 —— 用了不存在的 key

这个脚本只读,绝不写 mcode.db(理由见 library.py 开头)。
"""

import argparse
import difflib
import re
import sys
from pathlib import Path

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
    text = re.sub(r"[^0-9a-z\\u4e00-\\u9fff]+", " ", text)
    return " ".join(text.split())


def parse_bib(text):
    """极简 BibTeX 解析。只取我们真正会用的字段,不追求完备。"""
    entries = []
    for m in re.finditer(r"@(\\w+)\\s*\\{\\s*([^,]+),", text):
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
        for fm in re.finditer(r"(\\w+)\\s*=\\s*\\{", body):
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
        for fm in re.finditer(r"(\\w+)\\s*=\\s*\\"([^\\"]*)\\"", body):
            fields.setdefault(fm.group(1).lower(), fm.group(2))
        entries.append({"key": key, "type": typ, "fields": fields})
    return entries


def cited_keys(manuscript):
    r"""稿件里出现过的引用键(LaTeX 的 \cite{a,b} 与 Pandoc 的 [@a; @b] 两种写法)。"""
    text = manuscript.read_text(encoding="utf-8", errors="replace")
    keys = set()
    for m in re.finditer(r"\\\\?cite[a-zA-Z]*\\*?(?:\\[[^\\]]*\\])?\\{([^}]*)\\}", text):
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
        "SELECT id, title, doi, arxiv_id, year, venue FROM library_items",
    ).fetchall()
    conn.close()

    by_doi = {}
    by_arxiv = {}
    by_title = []
    for iid, title, doi, arxiv, year, venue in rows:
        if doi:
            by_doi[doi.strip().lower()] = (iid, title, year, venue)
        if arxiv:
            by_arxiv[arxiv.strip().lower()] = (iid, title, year, venue)
        by_title.append((iid, norm(title), title, year, venue))

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
        print("!! 库里没有,也对不上 " + str(len(missing)) + " 条 —— 这几条很可能是编造的,不要引:")
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
`;
