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

屏蔽规则
========
用户在「设置 → 资料库类型」里可以把某些分类 / 类型 / 大类设为屏蔽,也可以按文件
后缀屏蔽。被屏蔽的条目**不进这个脚本的任何结果**,判定与界面、与 AI 工具那边是同
一套(主进程的 main/library/suppress.ts)。

⚠️ 挡掉的条数会**显式写在结果开头**。看不到那几行就把"剩下的这些"当成整个库去向
用户汇报,是错的 —— 用户设的屏蔽确实起了作用,而你以为库里就这些。
"""

import argparse
import json
import os
import re
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
    conn = sqlite3.connect(db.absolute().as_uri() + "?mode=ro", uri=True)
    # 行按列名取。判定那一层要拿 id / kind / md_path / pdf_path / file_path 五个
    # 字段,而每条命令的 SELECT 顺序都不一样 —— 按下标取的话,加一列就是一次静默
    # 错位。名字取就与顺序无关了。
    conn.row_factory = sqlite3.Row
    return conn


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


# ─────────────────────────────── 屏蔽规则 ───────────────────────────────
# 「哪些资料不进上下文」。规则存在 settings 表里(键 library.suppress),值是一份
# JSON:{"nodes": [...], "extensions": [...]} —— 与契约(@contracts/libraryTypes)
# 里那两个字段一一对应。
#
# 判定与主进程**同一套语义**(main/library/suppress.ts 的 suppressionReasonOfItem):
#
#     条目 → 它所属的全部集合 → 它的 kind → kind 所属的大类(可能不止一个)
#
# 链上任一段命中就挡住;extensions 再按文件后缀挡一层。集合那一层取的是**条目所
# 属的全部集合** —— 一个条目可以同时在多个集合里,任一个被屏蔽都算。
#
# 规矩同主进程:读不出 / JSON 坏 / 形状不对 → **按"什么都没屏蔽"处理**,绝不抛。
# 反过来的那条退路(坏数据当"全挡")会让用户的东西凭空消失,是更坏的一种错。
#
# ⚠️ 这里必须是**同一套判定**,不能"大约相当于":两边结论一旦不一样,用户看到的
# 就是「界面里说屏蔽了、模型这边照读得到」,而这种事不会有人报错。

SUPPRESS_SETTING_KEY = "library.suppress"
GROUPS_SETTING_KEY = "library.groups"
TYPES_SETTING_KEY = "library.types"

# 出厂的两个大类。与契约的 DEFAULT_LIBRARY_GROUPS 逐字一致 —— 用户没动过大类表
# 时它就是生效的那一份。
DEFAULT_GROUPS = [
    {"id": "docs", "name": "文档", "kinds": ["paper", "textbook", "note"]},
    {"id": "templates", "name": "模版",
     "kinds": ["document", "slides", "latex", "code", "image"]},
]

# 出厂类型的内置 id(契约 BUILTIN_LIBRARY_TYPES 的 id 集合)。
BUILTIN_TYPE_IDS = ["paper", "textbook", "note", "document", "slides", "latex", "code", "image"]

# 类型 / 大类的 id 规则(契约里的 ID_RE)。
ID_RE = re.compile("^[a-z][a-z0-9-]*$")

# 「这个设置键没存过」的哨兵。与 None(存了但值是 JSON 的 null)分开 —— 两者的处置
# 都是退回出厂值,但只有后者该打印告警。
_MISSING = object()


def read_setting(cur, key):
    """settings 表里的一行。老库没有 settings 表 / 查不动 → None(同"没存过")。"""
    try:
        row = cur.execute("SELECT value FROM settings WHERE key = ?", [key]).fetchone()
    except sqlite3.Error:
        return None
    if row is None or row[0] is None:
        return None
    return str(row[0])


def warn(text):
    """坏数据的告警写 stderr,**不写 stdout** —— stdout 是给模型看的查询结果,在那里
    插一句话会让它以为这次查询本身出了问题。写 stderr 则进得了对话记录(log.warn
    在界面上的对应物)。"""
    try:
        print("[library.py] " + text, file=sys.stderr)
    except Exception:
        pass


def load_json_setting(cur, key, what):
    """读一个存 JSON 的设置键。没存过 → 哨兵;坏 JSON → None(并告警)。"""
    raw = read_setting(cur, key)
    if raw is None:
        return _MISSING
    try:
        return json.loads(raw)
    except Exception:
        warn(what + "不是合法 JSON,这一层退回出厂值(键 " + key + ")")
        return None


def parse_registry_ids(value):
    """类型注册表里的全部 kind id;不合法 → None(调用方退回出厂表)。

    校验口径照契约的 parseLibraryTypesJson:**整份形状**任何一处不对就整份不认。
    连 icon / prompt 那种"跟判定无关"的字段也看,是因为主进程那份校验器会因此整份
    退回出厂表 —— 于是某个自定义 kind 就不再"注册表认得",引用它的组跟着被过滤掉。
    这里跟着一起拒,两边的 known 集合才对得上。
    """
    if not isinstance(value, list):
        return None
    seen = []
    for entry in value:
        if not isinstance(entry, dict):
            return None
        tid = entry.get("id")
        if not isinstance(tid, str) or not ID_RE.match(tid) or tid in seen:
            return None
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        if entry.get("purpose") not in ("material", "format"):
            return None
        for k in ("prompt", "icon"):
            v = entry.get(k)
            if v is not None and not isinstance(v, str):
                return None
        seen.append(tid)
    # 内置类必须还在 —— 少了就是"注册表不完整",主进程同样整份拒绝。
    for b in BUILTIN_TYPE_IDS:
        if b not in seen:
            return None
    return seen


def parse_groups(value):
    """大类表;不合法 → None(调用方退回出厂两组)。口径照 parseLibraryGroupsJson:
    id 合法且唯一、名字非空、kinds 是一组类型 id、**一个类型只能出现在一个组里**。"""
    if not isinstance(value, list):
        return None
    out = []
    seen_ids = set()
    seen_kinds = set()
    for entry in value:
        if not isinstance(entry, dict):
            return None
        gid = entry.get("id")
        if not isinstance(gid, str) or not ID_RE.match(gid) or gid in seen_ids:
            return None
        seen_ids.add(gid)
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        kinds = entry.get("kinds")
        if not isinstance(kinds, list):
            return None
        for k in kinds:
            if not isinstance(k, str) or not k:
                return None
            if k in seen_kinds:
                return None
            seen_kinds.add(k)
        prompt = entry.get("prompt")
        if prompt is not None and not isinstance(prompt, str):
            return None
        out.append({"id": gid, "name": name.strip(), "kinds": list(kinds)})
    return out


def load_kind_groups(cur):
    """kind → 它所属的大类([{"id":..., "name":...}]),以及按 id 的反查表。

    合并规则与主进程 kindRegistry.loadLibraryGroups() 一致:表取不到 / 坏 → 出厂
    两组;组里那些**注册表不认识的 kind 过滤掉**(删一个类型不该被"还有组在引用它"
    挡住);过滤空了整组丢掉。
    """
    known = parse_registry_ids(load_json_setting(cur, TYPES_SETTING_KEY, "类型注册表"))
    if known is None:
        known = list(BUILTIN_TYPE_IDS)
    known_set = set(known)

    groups = parse_groups(load_json_setting(cur, GROUPS_SETTING_KEY, "大类表"))
    if groups is None:
        groups = DEFAULT_GROUPS

    by_kind = {}
    by_id = {}
    for g in groups:
        kinds = [k for k in g["kinds"] if k in known_set]
        if not kinds:
            continue
        by_id[g["id"]] = g["name"]
        for k in kinds:
            by_kind.setdefault(k, []).append(g)
    return by_kind, by_id


def load_suppress_rule(cur):
    """当前屏蔽规则 → {"nodes": [...], "extensions": [...]}。

    没存过 / JSON 坏 / 形状不对 → 空规则(什么都不挡),同主进程 loadSuppress。
    单条坏(前缀认不出、类型不对)**只丢那一条**,不废掉整份 —— 那是契约
    parseSuppressJson 的口径:屏蔽是一串独立的勾选,某一条失效不该偷偷把用户其余
    的屏蔽一起放开。例外只有顶层形状(nodes / extensions 不是数组)时整份作废。
    """
    value = load_json_setting(cur, SUPPRESS_SETTING_KEY, "屏蔽规则")
    if not isinstance(value, dict):
        if value is not _MISSING and value is not None:
            warn("屏蔽规则应该是一个对象,按\"什么都没屏蔽\"处理")
        return {"nodes": [], "extensions": []}

    raw_nodes = value.get("nodes")
    if raw_nodes is None:
        raw_nodes = []
    if not isinstance(raw_nodes, list):
        warn("屏蔽规则的 nodes 应该是一组键,按\"什么都没屏蔽\"处理")
        return {"nodes": [], "extensions": []}
    nodes = []
    for n in raw_nodes:
        if not isinstance(n, str):
            continue
        key = n.strip()
        at = key.find(":")
        if at < 0:
            continue
        if key[:at] not in ("group", "type", "collection"):
            continue
        if at + 1 >= len(key):
            continue
        if key not in nodes:
            nodes.append(key)

    raw_exts = value.get("extensions")
    if raw_exts is None:
        raw_exts = []
    if not isinstance(raw_exts, list):
        warn("屏蔽规则的 extensions 应该是一组字符串,按\"什么都没屏蔽\"处理")
        return {"nodes": [], "extensions": []}
    extensions = []
    for x in raw_exts:
        if not isinstance(x, str):
            continue
        ext = x.strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = "." + ext
        if ext not in extensions:
            extensions.append(ext)

    return {"nodes": nodes, "extensions": extensions}


def describe_node_key(cur, group_names, key):
    """一个节点键 → 用户看得懂的名字。都查不到就退回键本身 —— 那说明这一条指向的
    东西已经被删了,说清"是哪一条"比说一个空字符串有用。"""
    at = key.find(":")
    level, node_id = key[:at], key[at + 1:]
    if level == "collection":
        row = cur.execute("SELECT name FROM library_collections WHERE id = ?", [node_id]).fetchone()
        return "「" + str(row[0]) + "」" if row else "已删除的分类(" + node_id + ")"
    if level == "type":
        return "类型「" + node_id + "」"
    name = group_names.get(node_id)
    return "「" + name + "」" if name else "已删除的大类(" + node_id + ")"


def suppress_reason(cur, sup, rec):
    """这条条目被挡的原因(人话);没被挡返回 None。

    rec 是 as_rec 出来的那几列 —— 判定要 id / kind 和"实际会被读的那份文件"。
    """
    if not sup["nodes"] and not sup["extensions"]:
        return None

    # kind 那一列的 NULL 按 paper 读(主进程 rowToLibraryItem 的「?? "paper"」)。
    # 空串**不**走这条退路 —— 两边对 NULL 与空串的处置必须一致。
    kind = rec["kind"] if rec["kind"] is not None else "paper"
    keys = []
    # 条目 → 它所属的**全部**集合
    for row in cur.execute(
        "SELECT collection_id FROM library_collection_items WHERE item_id = ?", [rec["id"]]
    ):
        keys.append("collection:" + str(row[0]))
    # 集合 → 类型:条目自己的 kind(不在任何集合里的条目靠它)
    keys.append("type:" + kind)
    # 类型 → 大类:反查哪些大类的 kinds 里有它。没进任何大类的类型到这儿为止。
    for g in sup["kind_groups"].get(kind, []):
        keys.append("group:" + g["id"])
    for key in keys:
        if key in sup["nodes"]:
            return describe_node_key(cur, sup["group_names"], key)

    # 扩展名那一层。看的是**条目实际会被读的那个文件** —— 与清单给模型的路径同源:
    # 有 markdown 就按 markdown(那才是会被读的),否则 PDF,否则通用文件路径。
    # ⚠️ 判据是"值是不是 None",与主进程的「??」**逐字同义**(空串不往下走)。
    # 写成「rec["md"] or rec["pdf"]」的话,一条 md_path 为空串的条目会掉到 PDF 上去,
    # 于是"屏蔽 .md"在它身上不生效 —— 而空串这一列真的存在(见 db.ts 的兼容列)。
    p = rec["md"]
    if p is None:
        p = rec["pdf"]
    if p is None:
        p = rec["fp"]
    if p:
        ext = os.path.splitext(p)[1].lower()
        if ext and ext in sup["extensions"]:
            return ext + " 文件"
    return None


def as_rec(row):
    """判定要用的那几列,从一行里取出来。

    **每条命令都过它** —— 各写一份的话,迟早有一条命令漏带 file_path,于是"按后缀
    屏蔽"在那一路上静静地不生效。
    """
    return {
        "id": row["id"],
        "kind": row["kind"],
        "md": row["md_path"],
        "pdf": row["pdf_path"],
        "fp": row["file_path"],
        "row": row,
    }


def split_suppressed(cur, sup, rows):
    """把一批行分成「留下的」与「被挡的原因」。**各命令共用这一个**。

    分成两份判定就等于有两个真相,迟早分叉 —— 而分叉的表现是"同一个库,list 里有、
    files 里没有"。
    """
    kept = []
    reasons = []
    for row in rows:
        reason = suppress_reason(cur, sup, as_rec(row))
        if reason:
            reasons.append(reason)
        else:
            kept.append(row)
    return kept, reasons


def report_suppressed(reasons):
    """挡掉了几条、因为什么 —— **必须说出来**。

    仓库的硬规矩:坏东西(这里是被挡掉的东西)要显式报出来,不静默跳过。模型看不见
    这几行,就会拿"剩下这些"当整个库向用户汇报;而那是它给不出正确答案,不是它偷懒。
    按原因归并成几行:挡掉五百条而原因只有一个时,逐条列出来只是噪声。
    """
    if not reasons:
        return
    order = []
    counts = {}
    for r in reasons:
        if r not in counts:
            counts[r] = 0
            order.append(r)
        counts[r] += 1
    print("⚠️ 屏蔽规则挡掉了 " + str(len(reasons)) + " 条(设置 → 资料库类型),它们不在下面:")
    for r in order:
        print("    - " + r + ":" + str(counts[r]) + " 条")


def cmd_list(cur, root, args, sup):
    where, params = kind_filter(args.kind)
    rows = cur.execute(
        "SELECT id, title, authors, year, venue, md_path, pdf_path, file_path, kind"
        " FROM library_items WHERE 1=1" + where + " ORDER BY year DESC, title",
        params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    print("共 " + str(len(kept)) + " 条")
    report_suppressed(reasons)
    for row in kept:
        iid, title, authors, year, venue, md, pdf =(
            row["id"], row["title"], row["authors"], row["year"], row["venue"],
            row["md_path"], row["pdf_path"],
        )
        print("- " + title)
        bits = [author_names(authors), str(year) if year else "", venue or ""]
        head = " · ".join([b for b in bits if b])
        if head:
            print("    " + head)
        print("    id=" + iid + "  文件:" + file_of(root, md, pdf))


def cmd_find(cur, root, args, sup):
    q = "%" + args.query + "%"
    where, params = kind_filter(args.kind)
    rows = cur.execute(
        "SELECT id, title, authors, year, venue, md_path, pdf_path, file_path, kind"
        " FROM library_items"
        " WHERE (LOWER(title) LIKE LOWER(?) OR LOWER(IFNULL(authors,'')) LIKE LOWER(?)"
        "        OR LOWER(IFNULL(abstract,'')) LIKE LOWER(?) OR LOWER(IFNULL(venue,'')) LIKE LOWER(?))"
        + where + " ORDER BY year DESC, title",
        [q, q, q, q] + params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    print('匹配 "' + args.query + '":' + str(len(kept)) + " 条")
    report_suppressed(reasons)
    for row in kept:
        iid, title, authors, year, venue, md, pdf =(
            row["id"], row["title"], row["authors"], row["year"], row["venue"],
            row["md_path"], row["pdf_path"],
        )
        print("- " + title)
        bits = [author_names(authors), str(year) if year else "", venue or ""]
        head = " · ".join([b for b in bits if b])
        if head:
            print("    " + head)
        print("    id=" + iid + "  文件:" + file_of(root, md, pdf))
    if not kept:
        if reasons:
            # **"被屏蔽了"与"库里没有"是两句话。** 混成一句的话,模型会据此回答用户
            # "库里没有这一篇" —— 而它在设置里明明留着。
            print("(匹配的都在这几行屏蔽里,不在上面。如实告诉用户「被屏蔽了」,不要当它不存在,"
                  "也不要凭空引用。)")
        else:
            print("(库里没有匹配的条目。不要因此凭记忆引用 —— 要么换关键词再找,要么如实说库里没有。)")


def resolve_one(cur, query):
    """id 前缀优先,其次标题片段。返回匹配到的行(可能多条)。"""
    cols = ("id, title, authors, year, venue, doi, arxiv_id, volume, issue, page, publisher,"
            " abstract, type, url, md_path, pdf_path, file_path, kind")
    rows = cur.execute(
        "SELECT " + cols + " FROM library_items WHERE id LIKE ?",
        [query + "%"],
    ).fetchall()
    if not rows:
        rows = cur.execute(
            "SELECT " + cols + " FROM library_items WHERE LOWER(title) LIKE LOWER(?)",
            ["%" + query + "%"],
        ).fetchall()
    return rows


def cmd_show(cur, root, args, sup):
    rows = resolve_one(cur, args.query)
    if not rows:
        sys.exit("库里没有匹配 " + args.query + " 的条目")
    # 被屏蔽的**不能**当作"找不到"糊过去,也不能照常显示 —— 后者会把绝对路径交出去,
    # 而"挂不上"这件事用户设的就是不让他上手。所以说清是屏蔽,并把原因点名。
    kept = []
    reasons = []
    for row in rows:
        reason = suppress_reason(cur, sup, as_rec(row))
        if reason:
            reasons.append(reason)
        else:
            kept.append(row)
    if not kept:
        sys.exit("匹配 " + args.query + " 的 " + str(len(reasons)) + " 条被屏蔽规则挡下了("
                 + "、".join(dict.fromkeys(reasons)) + ")。要去掉屏蔽:设置 → 资料库类型。")
    rows = kept
    if len(rows) > 1:
        print("匹配到 " + str(len(rows)) + " 条,请用更精确的 id 或标题:")
        for r in rows:
            print("  " + r["id"] + "  " + r["title"])
        return
    row = rows[0]
    iid, title, authors, year, venue, doi, arxiv, volume, issue, page =(
        row["id"], row["title"], row["authors"], row["year"], row["venue"], row["doi"],
        row["arxiv_id"], row["volume"], row["issue"], row["page"],
    )
    publisher, abstract, typ, url, md, pdf =(
        row["publisher"], row["abstract"], row["type"], row["url"],
        row["md_path"], row["pdf_path"],
    )
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


def cmd_files(cur, root, args, sup):
    where, params = kind_filter(args.kind)
    if args.missing_md:
        where += " AND (md_path IS NULL OR md_path = '')"
    rows = cur.execute(
        "SELECT id, title, md_path, pdf_path, file_path, kind FROM library_items WHERE 1=1" + where
        + " ORDER BY title",
        params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    # 这一路最该说清:它给人的就是**绝对路径**,而被屏蔽的条目正是"不该把路径交出去"
    # 的那些。
    report_suppressed(reasons)
    for row in kept:
        print(file_of(root, row["md_path"], row["pdf_path"]) + "    <- " + row["title"]
              + "  (id=" + row["id"] + ")")


def cmd_notes(cur, root, args, sup):
    rows = cur.execute(
        "SELECT n.content, n.origin, i.title, i.id, i.kind, i.md_path, i.pdf_path, i.file_path"
        " FROM library_notes n"
        " LEFT JOIN library_items i ON i.id = n.item_id ORDER BY n.created_at",
    ).fetchall()
    if not rows:
        print("(还没有任何笔记)")
        return
    kept = []
    reasons = []
    for row in rows:
        # 条目已经不在了(LEFT JOIN 出 NULL)时**不挡** —— 判定不了的东西由"找不到"
        # 去说,不该在这儿被说成"被屏蔽了",那是两句不同的话(同主进程的处置)。
        if row["id"] is not None:
            reason = suppress_reason(cur, sup, as_rec(row))
            if reason:
                reasons.append(reason)
                continue
        kept.append(row)
    report_suppressed(reasons)
    for row in kept:
        print("- [" + (row["title"] or "?") + "] " + " ".join(row["content"].split()))
        if row["origin"] != "user":
            print("    来源:" + row["origin"])
        if row["id"]:
            print("    条目 id:" + row["id"])


def cmd_collections(cur, root, args, sup):
    """分类树本身**不过屏蔽** —— 它是目录,不是资料。

    用户屏蔽一个分类,意思是"里面的条目不进上下文";分类自己还得显示得出来,否则
    他在设置页里根本找不到刚才屏蔽的那个。
    """
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
        cur = conn.cursor()
        # 规则与大类映射每个进程只读一次 —— 一批命令共用同一份判定。
        # ⚠️ 只调**一次** load_suppress_rule:调两次的话,坏 JSON 那条告警会被打两遍
        # (第一遍读 nodes、第二遍读 extensions),看起来像"两个地方都坏了"。
        kind_groups, group_names = load_kind_groups(cur)
        rule = load_suppress_rule(cur)
        sup = {
            "nodes": set(rule["nodes"]),
            "extensions": rule["extensions"],
            "kind_groups": kind_groups,
            "group_names": group_names,
        }
        args.fn(cur, root, args, sup)
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
