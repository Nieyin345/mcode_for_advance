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
 * 整个库**(标题、简介、来源地址、文件路径),拿到条目的绝对路径。
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
    python library.py list --group docs        只看「文档」大类下的(见 collections 查 id)
    python library.py find 关键词               在标题/简介/来源地址/文件路径里搜
    python library.py show 0f3a2c              看一条的完整字段(id 前缀或标题片段)
    python library.py files --group docs       只列文件路径(给"我该读哪个文件"用)
    python library.py notes                    列出所有笔记,连同它挂在哪一条上
    python library.py collections              列出大类与分类树

默认从 Mcode 的记录里找数据根(APPDATA 下的 data-root.json);也可以显式给:
    python library.py --root "D:/destop/work_space/mcode" list

屏蔽规则
========
用户在「设置 → 资料库屏蔽」里可以把某些分类 / 大类设为屏蔽,也可以按文件后缀屏蔽。
被屏蔽的条目**不进这个脚本的任何结果**,判定与界面、与 AI 工具那边是同一套
(主进程的 main/library/suppress.ts)。

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
    # 行按列名取。判定那一层要拿 id / md_path / pdf_path / file_path 四个字段,而每条
    # 命令的 SELECT 顺序都不一样 —— 按下标取的话,加一列就是一次静默错位。名字取就与
    # 顺序无关了。
    conn.row_factory = sqlite3.Row
    return conn


def file_of(root, md_path, pdf_path, file_path=None, sup=None):
    """这一条给模型读哪几份文件 —— 与主进程同一口径(fileImport.ts 的 aiVisibleFilesOf)。

    有 Markdown 转录就先给转录,方括号里带上原件(转录和原件是同一条条目的两份文件,
    一起给;转录拿不准的图表、公式再看原件)。没有转录就给原件,并说清是什么。
    原件:通用文件(file_path)优先,其次 PDF。linked 条目的 file_path 是绝对路径 ——
    pathlib 拼一个绝对路径时直接取它,所以两种都能用同一句 lib / file_path。

    sup 给了就**按份去掉**按文件类型屏蔽的那份(屏蔽只管给 AI 看的,2026-09-26 用户定的):
    屏蔽 pdf → 只给转录;屏蔽 md → 只给原件,而且不说「尚未转」(转录是有的,只是不给)。
    整条挡不挡由 suppress_reason 先判,到这里的都是没被整条挡的。
    """
    lib = root / "library"
    original = None
    if file_path:
        original = str(lib / file_path)
    elif pdf_path:
        original = str(lib / pdf_path)
    md = str(lib / md_path) if md_path else None
    if sup is not None:
        if md and ext_blocked(sup, md):
            md = None
        if original and ext_blocked(sup, original):
            original = None
    if md:
        return md + ("   [原件:" + original + "]" if original else "")
    if original:
        if md_path:
            return original
        if original.lower().endswith(".pdf"):
            return original + "   [PDF,尚未转 Markdown]"
        return original + "   [没有 Markdown 转录,按原格式读]"
    return "(没有文件)"


def ext_blocked(sup, path):
    """这一份文件按文件类型被屏蔽了没有(主进程 suppress.ts 的 isFileSuppressed)。"""
    ext = os.path.splitext(path)[1].lower()
    return bool(ext) and ext in sup["extensions"]


def group_filter(group):
    """按**大类**过滤 —— 条目经它所属的分类挂到大类(「library_collections.group_id」)。

    从前这里是 「AND kind = ?」(按条目的内置类型过滤)。kind 退役(2026-09-24)之后条目
    不再有那个字段,而且大类**不直接落在条目上** —— 要经 「library_collection_items」
    连到 「library_collections」。所以是一条子查询,不是一次改个列名。
    """
    if group:
        return (
            " AND id IN (SELECT ci.item_id FROM library_collection_items ci"
            " JOIN library_collections c ON c.id = ci.collection_id WHERE c.group_id = ?)",
            [group],
        )
    return "", []


# ─────────────────────────────── 屏蔽规则 ───────────────────────────────
# 「哪些资料不进上下文」。规则存在 settings 表里(键 library.suppress),值是一份
# JSON:{"nodes": [...], "extensions": [...]} —— 与契约(@contracts/libraryTypes)
# 里那两个字段一一对应。
#
# 判定与主进程**同一套语义**(main/library/suppress.ts 的 suppressionReasonOfItem):
#
#     条目 → 它所属的全部集合 → 沿 parent_id 往上的每一级父分类 → 各级挂着的大类
#
# 链上任一段命中就挡住;extensions 再按文件后缀挡一层。集合那一层取的是**条目所
# 属的全部集合**,并且沿 parent_id 收到顶 —— 左栏能把分类拖成父子,屏蔽父分类要连
# 子分类里的条目一起挡(与主进程 2026-09-26 的父链修法同步)。任一个被屏蔽都算。
#
# 规矩同主进程:读不出 / JSON 坏 / 形状不对 → **按"什么都没屏蔽"处理**,绝不抛。
# 反过来的那条退路(坏数据当"全挡")会让用户的东西凭空消失,是更坏的一种错。
#
# ⚠️ 这里必须是**同一套判定**,不能"大约相当于":两边结论一旦不一样,用户看到的
# 就是「界面里说屏蔽了、模型这边照读得到」,而这种事不会有人报错。

SUPPRESS_SETTING_KEY = "library.suppress"
GROUPS_SETTING_KEY = "library.groups"

# 出厂的两个大类。与契约的 DEFAULT_LIBRARY_GROUPS 逐字一致 —— 用户没动过大类表
# 时它就是生效的那一份。
#
# ⚠️ **没有 「kinds」 了**(kind 退役,2026-09-24):大类从前是"包含哪几个内置类型",
# 现在分类经 「library_collections.group_id」 直接挂大类。这个脚本读那份 JSON 时也只认
# 「id」 / 「name」 / 「prompt」(见 「parse_groups」)。
DEFAULT_GROUPS = [
    {"id": "templates", "name": "模版"},
    {"id": "docs", "name": "文档"},
]

# 大类的 id 规则(契约里的 ID_RE)。
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


def parse_groups(value):
    """大类表 → [{"id","name"}]。不合法 → None(调用方退回出厂两组)。

    口径照契约的 parseLibraryGroupsJson:id 合法且唯一、名字非空。
    ⚠️ **不看 「kinds」** —— 那个字段随 kind 一起退役了。老库里存着的那份 JSON **仍然
    带着** 「kinds」(代码停写但没删列),这里**忽略**它,而不是因此判整份非法:那样会让
    一个升级上来的库在脚本这边读不到自己的大类名,而界面上一切正常。
    """
    if not isinstance(value, list):
        return None
    out = []
    seen_ids = set()
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
        prompt = entry.get("prompt")
        if prompt is not None and not isinstance(prompt, str):
            return None
        out.append({"id": gid, "name": name.strip()})
    return out


def load_groups(cur):
    """大类表 → {id: name}。

    合并规则与主进程 groupRegistry.loadLibraryGroups() 一致:表取不到 / 坏 → 出厂两组。
    """
    groups = parse_groups(load_json_setting(cur, GROUPS_SETTING_KEY, "大类表"))
    if groups is None:
        groups = DEFAULT_GROUPS
    return {g["id"]: g["name"] for g in groups}


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
            warn("屏蔽规则应该是一个对象,按「什么都没屏蔽」处理")
        return {"nodes": [], "extensions": []}

    raw_nodes = value.get("nodes")
    if raw_nodes is None:
        raw_nodes = []
    if not isinstance(raw_nodes, list):
        warn("屏蔽规则的 nodes 应该是一组键,按「什么都没屏蔽」处理")
        return {"nodes": [], "extensions": []}
    nodes = []
    for n in raw_nodes:
        if not isinstance(n, str):
            continue
        key = n.strip()
        at = key.find(":")
        if at < 0:
            continue
        # ⚠️ **「type:」 那一档随 kind 退役删除**(2026-09-24)—— 与契约的
        # 「parseSuppressNodeKey」 逐字对齐:老数据里存着的 「type:paper」 在这里就**丢掉**,
        # 而不是留着。留着的话它会一路进 「sup["nodes"]」,然后 「suppress_reason」 拿它去
        # 比 「type:xxx」 键 —— 而那一档已经不再生成了,于是这条屏蔽**永远命中不了**:
        # 用户看到设置里勾着"屏蔽 paper 类型",模型这边照读得到,那句注释里警告的
        # "两边结论不一样"就真发生了。
        #
        # 丢掉整条而不是废掉整份,同契约口径:屏蔽是一串独立的勾选,某一条失效不该把
        # 用户其余的屏蔽一起放开。
        if key[:at] not in ("group", "collection"):
            continue
        if at + 1 >= len(key):
            continue
        if key not in nodes:
            nodes.append(key)

    raw_exts = value.get("extensions")
    if raw_exts is None:
        raw_exts = []
    if not isinstance(raw_exts, list):
        warn("屏蔽规则的 extensions 应该是一组字符串,按「什么都没屏蔽」处理")
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
    # ⚠️ 「type:」 那一档随 kind 退役删除 —— 老数据里存着的 「type:paper」 在这里会落到
    # 下面那行"已删除的大类",而不是被说成"类型「paper」"(那会让用户以为它还在生效)。
    name = group_names.get(node_id)
    return "「" + name + "」" if name else "已删除的大类(" + node_id + ")"


def suppress_reason(cur, sup, rec):
    """这条条目被挡的原因(人话);没被挡返回 None。

    rec 是 as_rec 出来的那几列 —— 判定要 id 和条目名下的几份文件。
    这是**整条挡**那一层;按份去掉在 file_of 里。
    """
    if not sup["nodes"] and not sup["extensions"]:
        return None

    keys = []
    # 条目 → 直属集合 → 沿 parent_id 往上的每一级父分类;链上每一级挂着的大类
    # (kind 退役后大类经 group_id 直挂)也都收 —— 与主进程 suppressKeysOfItem 的
    # 父链修法同步(2026-09-26)。UNION(不是 UNION ALL)自带去重,父链上真有环也
    # 不会转圈(同 repositories.ts 里 subtree 那条 CTE 的讲究)。
    for row in cur.execute(
        "WITH RECURSIVE chain(id) AS ("
        " SELECT collection_id FROM library_collection_items WHERE item_id = ?"
        " UNION"
        " SELECT c.parent_id FROM library_collections c"
        "  JOIN chain ON c.id = chain.id WHERE c.parent_id IS NOT NULL"
        ") SELECT chain.id AS cid, c.group_id AS gid"
        " FROM chain LEFT JOIN library_collections c ON c.id = chain.id",
        [rec["id"]],
    ):
        keys.append("collection:" + str(row["cid"]))
        if row["gid"]:
            keys.append("group:" + str(row["gid"]))
    for key in keys:
        if key in sup["nodes"]:
            return describe_node_key(cur, sup["group_names"], key)

    # 扩展名那一层:条目名下的文件**全部**被屏蔽才整条挡 —— 屏蔽按**份**算(2026-09-26
    # 用户定的):屏蔽 .pdf 时转录过的照样列出、只给转录(见 file_of);只有 PDF 的一份不剩,
    # 才整条挡。与主进程 suppress.ts 的 suppressionReasonOfItem 同一条规则。
    # 没有文件的条目(只有元数据)不受扩展名影响;空串当没有。
    files = [p for p in (rec["md"], rec["pdf"], rec["fp"]) if p]
    if files and all(ext_blocked(sup, p) for p in files):
        exts = []
        for p in files:
            e = os.path.splitext(p)[1].lower()
            if e not in exts:
                exts.append(e)
        return "、".join(exts) + " 文件"
    return None


def as_rec(row):
    """判定要用的那几列,从一行里取出来。

    **每条命令都过它** —— 各写一份的话,迟早有一条命令漏带 file_path,于是"按后缀
    屏蔽"在那一路上静静地不生效。
    """
    return {
        "id": row["id"],
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
    print("⚠️ 屏蔽规则挡掉了 " + str(len(reasons)) + " 条(设置 → 资料库屏蔽),它们不在下面:")
    for r in order:
        print("    - " + r + ":" + str(counts[r]) + " 条")


def cmd_list(cur, root, args, sup):
    where, params = group_filter(args.group)
    rows = cur.execute(
        "SELECT id, title, url, md_path, pdf_path, file_path"
        " FROM library_items WHERE 1=1" + where + " ORDER BY added_at DESC, title",
        params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    print("共 " + str(len(kept)) + " 条")
    report_suppressed(reasons)
    for row in kept:
        print("- " + row["title"])
        if row["url"]:
            print("    来源:" + row["url"])
        print("    id=" + row["id"] + "  文件:" + file_of(root, row["md_path"], row["pdf_path"], row["file_path"], sup))


def cmd_find(cur, root, args, sup):
    q = "%" + args.query + "%"
    where, params = group_filter(args.group)
    rows = cur.execute(
        "SELECT id, title, url, md_path, pdf_path, file_path"
        " FROM library_items"
        " WHERE (LOWER(title) LIKE LOWER(?) OR LOWER(IFNULL(abstract,'')) LIKE LOWER(?)"
        "        OR LOWER(IFNULL(url,'')) LIKE LOWER(?) OR LOWER(IFNULL(file_path,'')) LIKE LOWER(?))"
        + where + " ORDER BY added_at DESC, title",
        [q, q, q, q] + params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    print('匹配 "' + args.query + '":' + str(len(kept)) + " 条")
    report_suppressed(reasons)
    for row in kept:
        print("- " + row["title"])
        if row["url"]:
            print("    来源:" + row["url"])
        print("    id=" + row["id"] + "  文件:" + file_of(root, row["md_path"], row["pdf_path"], row["file_path"], sup))
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
    cols = "id, title, abstract, language, url, md_path, pdf_path, file_path"
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
    print("# " + row["title"])
    print("")
    for label, value in [
        ("语言", row["language"] or ""),
        ("来源", row["url"] or ""),
    ]:
        if value:
            print(label + ":" + value)
    print("id:" + row["id"])
    print("文件:" + file_of(root, row["md_path"], row["pdf_path"], row["file_path"], sup))
    if row["abstract"]:
        print("")
        print("## 简介 / 摘要")
        print(row["abstract"])
    notes = cur.execute(
        "SELECT content, origin, created_at FROM library_notes WHERE item_id = ? ORDER BY created_at",
        [row["id"]],
    ).fetchall()
    if notes:
        print("")
        print("## 用户在这一条上记的笔记")
        for content, origin, _ in notes:
            print("- " + " ".join(content.split()) + ("   [来源:" + origin + "]" if origin != "user" else ""))


def cmd_files(cur, root, args, sup):
    where, params = group_filter(args.group)
    if args.missing_md:
        where += " AND (md_path IS NULL OR md_path = '')"
    rows = cur.execute(
        "SELECT id, title, md_path, pdf_path, file_path FROM library_items WHERE 1=1" + where
        + " ORDER BY title",
        params,
    ).fetchall()
    kept, reasons = split_suppressed(cur, sup, rows)
    # 这一路最该说清:它给人的就是**绝对路径**,而被屏蔽的条目正是"不该把路径交出去"
    # 的那些。
    report_suppressed(reasons)
    for row in kept:
        print(file_of(root, row["md_path"], row["pdf_path"], row["file_path"], sup) + "    <- " + row["title"]
              + "  (id=" + row["id"] + ")")


def cmd_notes(cur, root, args, sup):
    rows = cur.execute(
        "SELECT n.content, n.origin, i.title, i.id, i.md_path, i.pdf_path, i.file_path"
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
        "SELECT id, name, parent_id, group_id FROM library_collections"
        " ORDER BY group_id, sort_order, name",
    ).fetchall()
    if not rows:
        print("(还没有分类)")
        return
    # 分类树**按大类分段落**。从前是按 「kind」 分三档(paper / textbook / note),
    # kind 退役后改按 「group_id」 —— 大类才是那段落的归属,而分类自己仍然是棵树。
    by_parent = {}
    for row in rows:
        by_parent.setdefault((row["group_id"] or "", row["parent_id"]), []).append(
            (row["id"], row["name"])
        )

    def walk(gid, parent, depth):
        for iid, name in by_parent.get((gid, parent), []):
            print("  " * depth + "- " + name + "  (id=" + iid + ")")
            walk(gid, iid, depth + 1)

    # 出厂那两组在前(顺序固定),其余按 id 排 —— 用户自建的大类也都要列出来,
    # 漏掉的话模型就看不到它们下面的资料。
    names = sup["group_names"]
    ordered = [g["id"] for g in DEFAULT_GROUPS]
    for row in rows:
        gid = row["group_id"] or ""
        if gid and gid not in ordered:
            ordered.append(gid)
    for gid in ordered:
        kids = by_parent.get((gid, None))
        if not kids and not any(k[0] == gid for k in by_parent):
            continue
        print((names.get(gid) or gid) + ":")
        walk(gid, None, 1)
    # **没挂大类的分类**也要列 —— 它们下面的条目勾任何大类都拿不到,而列出来才看得见。
    orphan = by_parent.get(("", None))
    if orphan or any(k[0] == "" for k in by_parent):
        print("(不属于任何大类):")
        walk("", None, 1)


def main():
    ap = argparse.ArgumentParser(description="Mcode 资料库查询(只读)")
    ap.add_argument("--root", help="数据根绝对路径;省略则自动查找")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出条目")
    p.add_argument("--group", help="只看某个大类下的(大类 id 用 collections 查)")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("find", help="按关键词搜索")
    p.add_argument("query")
    p.add_argument("--group", help="只看某个大类下的(大类 id 用 collections 查)")
    p.set_defaults(fn=cmd_find)

    p = sub.add_parser("show", help="看一条的完整字段")
    p.add_argument("query", help="条目 id 前缀,或标题片段")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("files", help="列出文件路径")
    p.add_argument("--group", help="只看某个大类下的(大类 id 用 collections 查)")
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
        # 规则与大类表每个进程只读一次 —— 一批命令共用同一份判定。
        # ⚠️ 只调**一次** load_suppress_rule:调两次的话,坏 JSON 那条告警会被打两遍
        # (第一遍读 nodes、第二遍读 extensions),看起来像"两个地方都坏了"。
        group_names = load_groups(cur)
        rule = load_suppress_rule(cur)
        sup = {
            "nodes": set(rule["nodes"]),
            "extensions": rule["extensions"],
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
 * 匹配分三档:来源 URL 中的 DOI / arXiv 精确 > 标题相似度(>=0.82) > 对不上。
 * 新库不再有 DOI / arXiv 独立列；本脚本只能核对「是否已收录」，不能证明真实发表。
 */
export const CHECK_CITATIONS_PY = `#!/usr/bin/env python3
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
    text = re.sub(r"[^0-9a-z\\u4e00-\\u9fff]+", " ", text)
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
`;

/**
 * **把一条条目的 PDF 交给 MinerU 的在线解析 API,拿回 Markdown + 配图。**
 *
 * 内置自动化 `wf_auto_convert`「下载完自动转 Markdown」的转录那一步跑它 —— 用户
 * 手上的转录工具五花八门,而这一条是**装都不用装**的那条:走 HTTP。
 *
 * ⚠️ 它要求环境变量 `MINERU_TOKEN`(见脚本头)。**没有就明确失败**,不静默降级去走
 * 「Agent 轻量解析」那条免 token 的路 —— 那条只给一份 Markdown,配图全变占位符,
 * 挂回库里预览全裂,而它看起来是"成功了"。
 *
 * ⚠️ 改这里的 Python 时注意:下面用的是 TS 模板字符串,所以正文里**不能出现反引号和
 * ${**,要强调用「」。
 */
export const MINERU_PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一条条目的 PDF 交给 MinerU 的**在线解析 API**，拿回 Markdown + 配图。

## 为什么是在线 API 而不是本地跑 MinerU

本地跑要下模型（basic 档 ~0.8GB）、要 8GB 以上的内存，而这台机器是老 Xeon 无 GPU。
在线 API 走 HTTP，什么都不用装。

## 走的是「精准解析」那一路（要 token）

MinerU 有两条 API（见 https://mineru.net/apiManage/docs）：

| | 精准解析（这一条） | Agent 轻量 |
|---|---|---|
| token | 要 | 不要 |
| 输出 | **zip：full.md + images/** | 只有 Markdown，图/表/公式**是占位符** |
| 限制 | 200MB / 200 页 | 10MB / 20 页 |

⚠️ **选精准那一路是因为配图。** 轻量那条只给一份 Markdown，图全变成占位符 —— 而
「library_adopt_markdown」 的整包替换语义正是要 「full.md」 配上它引用的那些图。拿轻量那条
转出来的东西挂上去，预览里全是断图，用户会以为导入坏了。

## token 从哪来

两条路，**脚本里那一行优先**：

1. 直接填在下面的 「TOKEN_INLINE」 —— 打开节点的代码编辑器，粘进引号里就行；
2. 留空则回退读 「MINERU_TOKEN」 环境变量（老做法，仍然有效）。

两条都没有就**明确报错退出**，不静默降级去打轻量那条 —— 降级的话用户拿到的是没有
配图的转录，而它看起来"成功了"，比直接报错难查得多。

## 输入 / 输出（工作流 code 节点的约定）

stdin 收一行 JSON：

    {"itemId": "li_xxx", "pdfPath": "papers/ab/cd/<sha>.pdf"}

⚠️ 「pdfPath」 是**库内相对路径**（见 「@contracts/hook」 的 「pdfPath」 那一项）—— 这里自己
把数据根找出来拼成绝对路径（「find_data_root」，与 「workflows/scripts/library.py」 同一条
逻辑：环境变量 > Mcode 的指针文件 > ~/Mcode）。

产物落在 **cwd** 下（「normalizeNodeArtifacts」 按 cwd 解析相对路径）：

    <cwd>/mineru/<itemId>/full.md
    <cwd>/mineru/<itemId>/images/*

stdout 打一行 「@@mcode:result {...}」（见 「orchestration/codeRunner.ts」 的协议解析）。

## 挂回库也是这一步的事（不再交给子代理）

产出的 「outputs.adoptMarkdown」 里每转成一条就报一项 「{itemId, path}」，code 节点跑完后
由**主进程**逐条调 「adoptMarkdownFile」（与 MCP 工具、界面按钮同一个函数）。

为什么不在这里自己写库：文档库的底是 sql.js —— 整个库在主进程内存里、落盘是把
「mcode.db」 整个重写一遍，子进程在旁边写同一个文件会把库覆盖掉。判断留在脚本里
（它才知道哪条转成了），写库留在主进程（只有它能安全地写），中间不经过模型。
详见 「orchestration/adoptFromCode.ts」 的文件头。

## 失败就是失败

code 节点的语义是「非零退出码 = 这一步失败」。所以任何一处走不通都**带着原因退出 1**，
把话写在 「@@mcode:result」 的 summary 里（那才是用户看得到的那个字段）。
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# 输出一律 UTF-8。Windows 上 Python 默认按控制台代码页（简体中文是 GBK）写 stdout，
# 而读它的那一端（Mcode 的 codeRunner）按 UTF-8 解 —— 中文会变成一堆问号。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 协议前缀 + 分段标记，与 「@contracts/nodeType」 的 NODE_STDOUT_PROTOCOL_PREFIX 一致。
PROTOCOL = "@@mcode:result "

BASE_URL = os.environ.get("MINERU_BASE_URL", "https://mineru.net").rstrip("/")

# ─────────────────────────────────────────────────────────────────────
#  ↓↓↓  在这里填 MinerU 的 API token  ↓↓↓
#
#  去 https://mineru.net 的「API 管理」建一个，把它粘到下面这对引号中间。
#  留空 = 回退去读环境变量 「MINERU_TOKEN」。
#
#  ⚠️ 填在这里的 token 会**随这条自动化一起存进数据库**，导出 / 分享这条工作流时
#     会跟着走。要发给别人之前记得先清空这一行。
# ─────────────────────────────────────────────────────────────────────
TOKEN_INLINE = ""

TOKEN = (TOKEN_INLINE or os.environ.get("MINERU_TOKEN") or "").strip()
# vlm 是文档推荐的档（复杂版式明显更好）；pipeline 更快更便宜。给个开关，默认 vlm。
MODEL_VERSION = (os.environ.get("MINERU_MODEL_VERSION") or "vlm").strip()

# 轮询：每 3 秒看一眼，最多等 30 分钟（长论文 + 排队要时间）。
POLL_INTERVAL_S = 3
POLL_TIMEOUT_S = 30 * 60

# 只转这三类:PDF 和 Word。
#
# MinerU 精准解析本身还吃图片 / PPT / Excel / 网页，但那几类在这个库里转出来的东西
# 多半没人看：一张截图转出来是几行 OCR，一个 xlsx 转出来是一张烂掉的表。它们照转的
# 代价是真金白银的额度和几分钟的排队。
#
# ⚠️ 不在这张单子里的**直接跳过，不算失败** —— 往库里拖一张图片不该让这条自动化
# 亮红灯（它没做错什么，只是没什么可做）。
SUPPORTED_EXTS = {".pdf", ".doc", ".docx"}


def source_of(item):
    """条目的源文件路径：linked 是绝对路径，attached 是库内相对路径，旧论文条目是 pdfPath。"""
    return (item or {}).get("filePath") or (item or {}).get("pdfPath") or ""


def emit(summary, outputs=None, artifacts=None):
    """打一行协议。**这是这一步交给下游的唯一通道** —— 别的 stdout 都只是日志。"""
    payload = {"summary": summary}
    if outputs:
        payload["outputs"] = outputs
    if artifacts:
        payload["artifacts"] = artifacts
    # ⚠️ 换行用 chr(10) 拼，不写字面的反斜杠 n —— 整段 Python 是 **TS 模板字面量**，
    # 里面写的反斜杠 n 会被 TS 先解成**真换行**，落成一个跨行的 Python 字符串字面量
    # （语法错，脚本整个起不来）。同文件下面那个 chr(10).join(...) 是同一个理由。
    sys.stdout.write(PROTOCOL + json.dumps(payload, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def die(summary, outputs=None):
    """失败：先把话说给用户（summary 是他在卡片上看到的那一行），再非零退出。"""
    emit(summary, outputs)
    sys.exit(1)


def find_data_root(explicit=None):
    """数据根：显式参数 > 环境变量 > Mcode 的指针文件 > ~/Mcode。

    与 「workflows/scripts/library.py」 同一条顺序 —— 两处不一致的话，会出现
    「查库的脚本找得到、转录的脚本找不到」这种一半好一半坏的状态。
    """
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


def http_json(url, method="GET", body=None, headers=None):
    """发一个 JSON 请求，返回解析后的对象。任何 HTTP/网络错都抛 「RuntimeError」（带人话）。"""
    data = None
    hdrs = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {err.code}（{url}）{detail}") from err
    except Exception as err:
        raise RuntimeError(f"请求失败（{url}）：{err}") from err
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as err:
        raise RuntimeError(f"响应不是 JSON（{url}）：{raw[:200]!r}") from err


def upload(url, path):
    """把文件字节 PUT 到签名链接上。**不设 Content-Type** —— API 文档明说不用设。"""
    body = path.read_bytes()
    req = urllib.request.Request(url, data=body, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f"上传返回 HTTP {resp.status}")
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"上传失败（HTTP {err.code}）") from err
    except Exception as err:
        raise RuntimeError(f"上传失败：{err}") from err


def download(url, dest):
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            dest.write_bytes(resp.read())
    except Exception as err:
        raise RuntimeError(f"下载结果包失败：{err}") from err


def safe_extract(zip_path, dest_dir):
    """解压到 「dest_dir」。**拒绝目录穿越条目**（「../」 / 绝对路径）。

    结果包来自远端，解压前必须过这一道：一个 「../../x」 的条目会把文件写到工作目录之外，
    而那种写坏是**静默**的（用户只看到产物莫名其妙出现在别处）。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    base = dest_dir.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            target = (base / name).resolve()
            try:
                target.relative_to(base)
            except ValueError:
                raise RuntimeError(f"结果包里有越界条目，拒绝解压：{name}")
        zf.extractall(base)


def transcribe_one(item, index):
    """转一条。成功返回产物描述，失败抛 RuntimeError（带人话）。"""
    item_id = (item or {}).get("itemId") or ""
    # 统一文档库：优先读通用文件路径（linked 为绝对路径，attached 为库内相对路径），
    # 兼容论文/下载条目的旧 pdfPath。
    source_rel = (item or {}).get("filePath") or (item or {}).get("pdfPath") or ""
    label = f"第 {index} 条" if index else "那一条"
    if not item_id or not source_rel:
        raise RuntimeError(f"{label}缺 itemId / 文件路径，转不了。")

    # itemId 是结果落点的目录名（见下面的 out_dir）。它来自载荷，而载荷可以被
    # code 节点 / 外部触发器喂进来 —— 含路径分隔符或 "."/".." 的值会把结果目录
    # 写到 cwd/mineru 之外（"../x" 甚至写出工作目录）。目录名只认单个路径分量。
    if "/" in item_id or "\\\\" in item_id or item_id in (".", ".."):
        raise RuntimeError(f"{label}的 itemId 含路径分隔符（{item_id!r}），拒绝用它建结果目录。")

    source_abs = Path(source_rel)
    if not source_abs.is_absolute():
        source_abs = find_data_root() / "library" / source_rel
    if not source_abs.is_file():
        raise RuntimeError(f"{label}的源文件不在了：{source_abs}")

    # 兜底再查一次。正常情况下 main() 已经把不转的挑走了 —— 这一条防的是有人直接
    # 调 transcribe_one（比如以后加一条手动重试的路）。绝不改走本地抽取。
    ext = source_abs.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise RuntimeError(f"{label}不是要转的格式（{ext or '无扩展名'}）；只转 PDF 和 Word。")
    model_version = MODEL_VERSION

    out_dir = Path.cwd() / "mineru" / item_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── 申请上传链接（批量接口，这里一次只放一条：一条失败不该拖垮别的）──
    res = http_json(
        f"{BASE_URL}/api/v4/file-urls/batch",
        method="POST",
        headers={"Authorization": f"Bearer {TOKEN}"},
        body={
            "files": [{"name": source_abs.name, "data_id": item_id}],
            "model_version": model_version,
        },
    )
    if res.get("code") != 0:
        raise RuntimeError(f"MinerU 拒绝了这次提交：{res.get('msg') or res}")
    data = res.get("data") or {}
    batch_id = data.get("batch_id") or ""
    urls = data.get("file_urls") or []
    if not batch_id or not urls:
        raise RuntimeError(f"MinerU 没给回 batch_id / 上传链接：{res}")

    # ── 上传字节（传完服务端会自动开始解析，不用再调一次提交）──
    upload(urls[0], source_abs)

    # ── 轮询到 done / failed ──
    started = time.time()
    zip_url = ""
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            raise RuntimeError(
                f"{label}解析超过 {POLL_TIMEOUT_S // 60} 分钟还没完（batch {batch_id}）。"
                "任务可能还在跑，稍后可以重试这一步。"
            )
        time.sleep(POLL_INTERVAL_S)
        poll = http_json(
            f"{BASE_URL}/api/v4/extract-results/batch/{batch_id}",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        if poll.get("code") != 0:
            raise RuntimeError(f"MinerU 查询被拒：{poll.get('msg') or poll}")
        results = (poll.get("data") or {}).get("extract_result") or []
        if not results:
            continue
        first = results[0]
        state = first.get("state") or ""
        if state == "done":
            zip_url = first.get("full_zip_url") or ""
            if not zip_url:
                raise RuntimeError(f"{label}解析完成了，却没给结果包地址。")
            break
        if state == "failed":
            raise RuntimeError(f"{label}解析失败：{first.get('err_msg') or '没给原因'}")

    # ── 下载结果包并解压 ──
    zip_path = out_dir / "result.zip"
    try:
        download(zip_url, zip_path)
        safe_extract(zip_path, out_dir)
    finally:
        try:
            zip_path.unlink()
        except Exception:
            pass

    md = out_dir / "full.md"
    if not md.is_file():
        raise RuntimeError(f"{label}的结果包里没有 full.md。落点里是：{[p.name for p in out_dir.iterdir()][:20]}")

    images_dir = out_dir / "images"
    image_count = len([p for p in images_dir.iterdir() if p.is_file()]) if images_dir.is_dir() else 0
    chars = len(md.read_text(encoding="utf-8", errors="replace"))
    return {
        "itemId": item_id,
        "itemTitle": (item or {}).get("itemTitle") or "",
        "mdPath": str(md),
        "relMdPath": md.relative_to(Path.cwd()).as_posix(),
        "imageCount": image_count,
        "chars": chars,
    }


def main():
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        die("交给这一步的载荷不是合法 JSON，没法知道要转哪一条。")
        return

    # 载荷可能是单条（触发器的 items 只有一条时就是扁平的那个对象），也可能外面裹着
    # 「trigger」 / 「data」（code 节点不填 Input JSON 时收到的是整个 data 上下文）。
    scope = payload
    if isinstance(payload, dict):
        for key in ("trigger", "data", "item"):
            inner = payload.get(key)
            if isinstance(inner, dict) and (inner.get("itemId") or inner.get("items")):
                scope = inner
                break

    # ⚠️ **要办的是全部条目，不是第一条。** 触发器有合并窗口（默认 2 秒），下载又是
    # 并发跑的 —— 两篇同时下完就攒在同一个窗口里。只取第一条的话，另一篇**再也没人转**，
    # 而且不报错。这正是 「automationPayload.ts」 的 「TriggerPayloadFacts.items」 存在的理由。
    items = []
    if isinstance(scope, dict):
        raw_items = scope.get("items")
        if isinstance(raw_items, list) and raw_items:
            items = [it for it in raw_items if isinstance(it, dict)]
        elif scope.get("itemId"):
            items = [scope]

    if not items:
        die("载荷里没有 itemId / items，没法知道要转哪份文档。")
        return

    # imported 事件也会覆盖 DOI/arXiv 占位记录；那类记录此刻没有本地文件，应留给
    # 下载完成事件稍后再转，而不是把正常导入报成转录失败。
    ready = [it for it in items if source_of(it)]
    if not ready:
        emit("本次导入尚无本地源文件，等待文件到位后再由下载事件转录。",
             outputs={"items": [], "skipped": len(items), "failed": []})
        return

    # ── 只留 PDF / Word，其余的挑出来放一边 ──
    todo = []
    skipped = []
    for it in ready:
        ext = Path(source_of(it)).suffix.lower()
        if ext in SUPPORTED_EXTS:
            todo.append(it)
        else:
            skipped.append(f"{(it or {}).get('itemTitle') or (it or {}).get('itemId') or '?'}（{ext or '无扩展名'}）")

    if not todo:
        # **这是成功，不是失败。** 拖进来的这批里没有要转的东西，说清楚就行。
        emit(
            "这批文件里没有 PDF 或 Word，不转录：" + "、".join(skipped),
            outputs={"items": [], "skipped": skipped, "failed": []},
        )
        return

    if not TOKEN:
        # **不复用轻量那条免 token 的路**：它不给配图，而挂着断图的转录看起来是成功的。
        die(
            "没有 MinerU 的 API token。去 https://mineru.net 的「API 管理」建一个，"
            "然后打开这个节点的代码编辑器，填到顶上的 TOKEN_INLINE 那一行里"
            "（或者设成环境变量 MINERU_TOKEN，设完要重启应用）。"
        )
        return

    # 逐条转：**一条失败不停下**。剩下几条照转，最后把失败原因一并报出来 ——
    # 「两篇一起下来，其中一篇是扫描件抽不出正文」时，另一篇不该跟着遭殃。
    ok = []
    failed = []
    for i, item in enumerate(todo, start=1):
        try:
            ok.append(transcribe_one(item, i if len(todo) > 1 else 0))
        except RuntimeError as err:
            failed.append(f"（{i}）{err}")

    if not ok:
        # 全失败 = 这一步失败（code 节点：非零退出）。
        die("一条都没转成。" + ("；".join(failed) if failed else ""))
        return

    lines = [
        f"已用 MinerU 转出 {len(ok)} 份 Markdown"
        + (f"，另有 {len(failed)} 条没转成。" if failed else "。"),
    ]
    if skipped:
        lines.append(f"跳过 {len(skipped)} 个非 PDF/Word 的文件：" + "、".join(skipped))
    if failed:
        lines.append("没转成的：")
        lines.extend(failed)

    emit(
        chr(10).join(lines),
        # 「adoptMarkdown」 是给**宿主**看的那一项：跑完由主进程逐条挂回文档库
        # （见 「orchestration/adoptFromCode.ts」）。「items」 保留给下游节点当依据。
        outputs={
            "items": ok,
            "failed": failed,
            "skipped": skipped,
            "adoptMarkdown": [{"itemId": r["itemId"], "path": r["mdPath"]} for r in ok],
        },
        artifacts=[
            {"kind": "file", "uri": r["relMdPath"], "name": "full.md", "mimeType": "text/markdown"}
            for r in ok
        ],
    )


if __name__ == "__main__":
    main()
`;

/**
 * 「文献导入(PDF / DOI)」里**收文件**那一步的脚本(见 `orchestration/builtins.ts` 的
 * `AUTO_DOWNLOAD_*`)。同 `MINERU_PY`:正文**直接当 code 参数**,不落文件再调。
 *
 * 它只做判断,不写库 —— 报一句 `outputs.importFiles`,由主进程调 `importAnyFiles`
 * 真去收(界面上那两颗「导入文件」按钮同一个函数)。为什么写库必须在主进程:文档库
 * 的底是 sql.js,子进程在旁边写 `mcode.db` 会把整个库覆盖掉,见
 * `orchestration/adoptFromCode.ts` 的文件头。
 *
 * ⚠️ 与 `MINERU_PY` 同一条纪律:这是 **TS 模板字符串**,正文里不能出现反引号和
 * 美元花括号,换行写 chr(10) 不写字面转义。
 */
export const LIT_IMPORT_PY = `
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「文献导入」表单里选中的文件收进文档库。

## 这一步在整条链的什么位置

    自定义 UI「文献导入(PDF / DOI)」
        → 弹表单:files(选文件) + doi(填编号)
        → 这个 code 节点:把 files 收进库        ← 你在这儿
        → 库发 library.item.imported 事件
        → 「文件到位后在线转 Markdown」自动化接手:MinerU 转录 + 挂回条目
        → (DOI 那半交给下一步的子代理:调外部下载工具取原文)

## 为什么收文件不能在这儿自己干

写库只能在主进程做:文档库的底是 sql.js，整个库在主进程内存里、落盘是把
「mcode.db」整个文件重写一遍 —— 子进程在旁边写同一个文件会把库覆盖掉。

所以这里只**报一句**「收这些文件进库」，由宿主调 「importAnyFiles」（界面上那两颗
「导入文件 / 导入文件夹」按钮同一个函数）真去收。判断在脚本里，写库在主进程。

## 输入

stdin 一行 JSON，是这次运行的数据上下文。要的两样在触发器事实里:

    trigger.input.files  —— 表单里选的文件路径(数组，或逗号分隔的一串)
    trigger.collectionId —— 右键点的那个分类(有就把条目归进去)

没选文件是**正常情况**(用户只填了 DOI) —— 那就什么都不做，说一句，正常退出。
"""

import json
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PROTOCOL = "@@mcode:result "


def emit(summary, outputs=None):
    payload = {"summary": summary}
    if outputs:
        payload["outputs"] = outputs
    sys.stdout.write(PROTOCOL + json.dumps(payload, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def as_list(value):
    """表单的值可能是数组，也可能是一串(逗号/换行/分号分隔)。两种都收。"""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        out = []
        for chunk in value.replace(";", ",").replace(chr(10), ",").split(","):
            chunk = chunk.strip().strip('"')
            if chunk:
                out.append(chunk)
        return out
    return []


def main():
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        emit("交给这一步的载荷不是合法 JSON，没法知道要收哪些文件。")
        sys.exit(1)
        return

    # 触发器事实可能就在顶层，也可能裹在 trigger / data 里(见 MINERU_PY 同样的找法)。
    scope = payload if isinstance(payload, dict) else {}
    for key in ("trigger", "data"):
        inner = scope.get(key) if isinstance(scope, dict) else None
        if isinstance(inner, dict) and ("input" in inner or "collectionId" in inner):
            scope = inner
            break

    form = scope.get("input") if isinstance(scope.get("input"), dict) else {}
    files = as_list(form.get("files"))
    collection_id = scope.get("collectionId") or ""

    if not files:
        # 只填了 DOI 的那条路 —— 这一步没活干，是正常的。
        emit("这次没有选文件（只填了 DOI 的话，取原文交给下一步）。", outputs={"importFiles": None})
        return

    emit(
        f"要收 {len(files)} 个文件进库：" + "、".join(files),
        outputs={
            # ↓ 宿主认的就是这一项(见 orchestration/adoptFromCode.ts)。
            "importFiles": {
                "paths": files,
                "collectionIds": [collection_id] if collection_id else [],
            }
        },
    )


if __name__ == "__main__":
    main()
`;
