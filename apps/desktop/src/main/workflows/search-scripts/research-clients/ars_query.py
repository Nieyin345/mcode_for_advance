#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检索客户端的命令行入口。

## 为什么有这个文件

同目录下的 `crossref_client.py` / `openalex_client.py` / `semantic_scholar_client.py`
/ `arxiv_client.py` / `chinese_literature_client.py` 是从 **academic-research-skills**
原样搬过来的**库** —— 它们没有命令行界面。这个文件只做一件事:给它们套一个统一入口,
让 Mcode 的 agent 和脚本能直接用,不必每次现写一段导入代码。

**它不含任何检索逻辑**:每个子命令就是调用对应客户端的一个方法。想改行为,改那些
客户端本身。

## 用法

    python ars_query.py ra <doi>                这个 DOI 由哪个注册机构负责
    python ars_query.py exists <doi>            DOI 在 Handle 系统里存在吗
    python ars_query.py lookup <doi> [标题]     多源查这条记录(带标题交叉核对)

    python ars_query.py cn <doi> [中文标题]     中文文献专用(见下)

## 为什么需要 `ra`

`api.crossref.org` **只是一个注册机构(RA),不是 DOI 系统本身**。中文期刊的 DOI 大多
注册在 ISTIC 或 CNKI 名下,Crossref 对它们一律 404,而同一个 DOI 在 doi.org 上解析得
好好的。所以「Crossref 查不到」对中文文献**不构成"这篇不存在"的证据** —— 先用 `ra`
看清楚是谁在管,再决定要不要下结论。

输出一律 JSON(UTF-8)。退出码:0 成功 / 1 没查到 / 2 上游不可用(可重试)。
"""
from __future__ import annotations

import argparse
import json
import sys

# Windows 上 Python 默认按控制台代码页(简体中文是 GBK)写 stdout,而读它的那一端按
# UTF-8 解 —— 中文标题会变成一堆问号。定死成 UTF-8,与平台无关。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

EXIT_OK = 0
EXIT_MISS = 1
EXIT_UNAVAILABLE = 2


def _emit(obj: object) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser(prog="ars_query", description="检索客户端统一入口")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ra = sub.add_parser("ra", help="这个 DOI 由哪个注册机构负责")
    p_ra.add_argument("doi")

    p_ex = sub.add_parser("exists", help="DOI 在 Handle 系统里存在吗")
    p_ex.add_argument("doi")

    p_lk = sub.add_parser("lookup", help="多源查这条记录")
    p_lk.add_argument("doi")
    p_lk.add_argument("title", nargs="?", default="")

    p_cn = sub.add_parser("cn", help="中文文献专用解析")
    p_cn.add_argument("doi")
    p_cn.add_argument("title", nargs="?", default="")

    args = ap.parse_args()

    if args.cmd in ("ra", "exists", "cn"):
        # 中文客户端是唯一提供 RA / Handle 这两个能力的地方;它不依赖标题,所以
        # 即使手上没有标题也能先做这两步判断。
        from chinese_literature_client import (  # noqa: PLC0415
            ChineseLiteratureClient,
            ChineseLiteratureUnavailable,
        )

        client = ChineseLiteratureClient()
        try:
            if args.cmd == "ra":
                _emit({"doi": args.doi, "ra": client.ra_for(args.doi)})
                return EXIT_OK
            if args.cmd == "exists":
                exists = client.handle_exists(args.doi)
                _emit({"doi": args.doi, "exists": exists})
                return EXIT_OK if exists else EXIT_MISS
            out = client.doi_lookup_with_title_check(args.doi, args.title)
            _emit(
                {
                    "doi": args.doi,
                    "state": str(out.state),
                    "title": out.title,
                    "matched": out.matched,
                    "meta": out.meta,
                }
            )
            return EXIT_OK if out.matched else EXIT_MISS
        except ChineseLiteratureUnavailable as exc:
            _emit({"doi": args.doi, "error": str(exc)})
            return EXIT_UNAVAILABLE

    # ── lookup:多源依次试,返回第一个拿到的 ──────────────────────────────
    doi, title = args.doi, args.title
    tried: list[dict] = []

    from crossref_client import CrossrefClient, CrossrefUnavailable  # noqa: PLC0415

    try:
        hit = CrossrefClient().doi_lookup_with_title_check(doi, title) if title else None
        if hit:
            _emit({"doi": doi, "source": "crossref", "record": hit})
            return EXIT_OK
        tried.append({"source": "crossref", "result": "miss-or-title-mismatch"})
    except CrossrefUnavailable as exc:
        tried.append({"source": "crossref", "result": "unavailable", "detail": str(exc)})

    from openalex_client import OpenAlexClient, OpenAlexUnavailable  # noqa: PLC0415

    try:
        hit = OpenAlexClient().doi_lookup_with_title_check(doi, title) if title else None
        if hit:
            _emit({"doi": doi, "source": "openalex", "record": hit})
            return EXIT_OK
        tried.append({"source": "openalex", "result": "miss-or-title-mismatch"})
    except OpenAlexUnavailable as exc:
        tried.append({"source": "openalex", "result": "unavailable", "detail": str(exc)})

    # 前两个都没中 → 交给中文解析器做 RA / 存在性判断,好解释「为什么查不到」
    from chinese_literature_client import ChineseLiteratureClient  # noqa: PLC0415

    cn = ChineseLiteratureClient()
    ra = None
    try:
        ra = cn.ra_for(doi)
    except Exception as exc:  # noqa: BLE001 - 这一步只是补充信息
        tried.append({"source": "doiRA", "result": "unavailable", "detail": str(exc)})

    _emit({"doi": doi, "source": None, "ra": ra, "tried": tried})
    return EXIT_MISS


if __name__ == "__main__":
    raise SystemExit(main())
