#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机构认证浏览器下载器（browser-context institutional downloader）。

为什么需要它：
- scripts/fetch.py 的机构模式用 urllib + 已保存的 cookie jar 直连出版商；
  但 IEEE Xplore 的 AWS WAF 会对非浏览器客户端（TLS/JS 指纹不符）返回 418，
  即使 cookie 完全有效也下载不了。
- 本脚本复用 institutional_login.py 导出的 Netscape cookie jar，在
  CloakBrowser 的浏览器上下文里用 context.request 发起请求：指纹一致 + 会话
  有效 -> 可正常下载被 WAF 保护的付费墙 PDF。

用法：
  python scripts/institutional_download.py --dois doi清单.txt --out 输出目录 [--headful] [--timeout 90]
  python scripts/institutional_download.py --urls doi<TAB>url清单.txt --out 输出目录
  （--dois / --urls 传 "-" 表示从 stdin 逐行读取）

  --dois FILE    每行一个 DOI；脚本经 Crossref 自动解析出版商直链（IEEE ielx8 等）
  --urls FILE    每行 `doi<TAB>pdf_url`；已确定直链时用，跳过 Crossref 解析
  --out DIR      输出目录（默认 ./pdfs_institutional）
  --headful      显示浏览器窗口（默认 headless；WAF 严格时可加此参数）
  --timeout SEC  单请求超时（默认 90）
  --cookie-jar   指定 cookie jar（默认 <skill_dir>/.scholar_institutional/cookies.txt）

输出（stdout，JSON envelope）：
  {
    "ok": "ok" | "partial" | "fail",
    "meta": { "cli_version", "cookie_jar", "headless", "total" },
    "data": { "summary": { "total", "succeeded", "failed" },
              "results": [ { "doi", "success", "source", "file", "error" } ] }
  }
退出码：0 全部成功 / 2 部分成功 / 1 全部失败 / 3 用法错误 / 4 依赖或会话缺失。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import re
import sys
import time
import urllib.request
from pathlib import Path
from _cloak_env import CLOAK_HINT, resolve_cloak_python

CLI_VERSION = "0.1.0"
_SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_JAR = _SKILL_DIR / ".scholar_institutional" / "cookies.txt"
DEFAULT_OUT = Path("pdfs_institutional")
CROSSREF_UA = "scholar-institutional-downloader/0.1 (mailto:none)"


def _load_jar(path: Path) -> list[dict]:
    """Parse a Netscape-format cookie jar into Playwright add_cookies dicts."""
    cookies: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _include_sub, cpath, secure, expires, name, value = parts[:7]
        cookies.append({
            "name": name,
            "value": value,
            "domain": domain.lstrip("."),
            "path": cpath or "/",
            "secure": secure == "TRUE",
            "expires": int(expires) if expires.isdigit() and int(expires) > 0 else -1,
        })
    return cookies


def _slug(value: str, max_len: int = 40) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-")
    return value[:max_len].rstrip("-") or "paper"


def _crossref(doi: str) -> dict | None:
    """Resolve Crossref metadata; return pdf links + landing page."""
    url = f"https://api.crossref.org/works/{urllib.request.quote(doi)}"
    req = urllib.request.Request(url, headers={"User-Agent": CROSSREF_UA})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            msg = json.load(resp).get("message") or {}
    except Exception:
        return None
    links: list[str] = []
    for link in msg.get("link") or []:
        u = (link.get("URL") or "").strip()
        if not u:
            continue
        if "xplorestaging.ieee.org" in u:
            u = u.replace("xplorestaging.ieee.org", "ieeexplore.ieee.org")
        if ".pdf" in u.lower() or "ielx8" in u.lower() or "content/pdf" in u.lower():
            links.append(u)
    primary = (msg.get("resource") or {}).get("primary", {}).get("URL", "")
    title = (msg.get("title") or [""])[0]
    author = ""
    for a in msg.get("author") or []:
        fam = a.get("family") or a.get("name") or ""
        if fam:
            author = fam
            break
    year = None
    for k in ("published-print", "published-online", "issued", "created"):
        parts = (msg.get(k) or {}).get("date-parts") or [[]]
        if parts and parts[0]:
            year = parts[0][0]
            break
    return {"links": links, "landing": primary, "title": title,
            "author": author, "year": year}


def _filename(meta: dict | None, doi: str) -> str:
    if meta and meta.get("author") and meta.get("title"):
        author = _slug(meta["author"], 20)
        year = str(meta.get("year") or "xxxx")
        title = _slug(meta["title"], 48)
        return f"{author}_{year}_{title}.pdf"
    return _slug(doi, 60) + ".pdf"


def _emit(envelope: dict) -> None:
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False))
    sys.stdout.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="机构认证浏览器下载器")
    ap.add_argument("--dois", metavar="FILE", help="DOI 清单（每行一个；'-'=stdin）")
    ap.add_argument("--urls", metavar="FILE", help="doi<TAB>pdf_url 清单（'-'=stdin）")
    ap.add_argument("--out", default=str(DEFAULT_OUT), metavar="DIR", help="输出目录")
    ap.add_argument("--headful", action="store_true", help="显示浏览器窗口")
    ap.add_argument("--timeout", type=int, default=90, metavar="SEC", help="单请求超时（秒）")
    ap.add_argument("--cookie-jar", default=str(DEFAULT_JAR), metavar="PATH", help="cookie jar 路径")
    ap.add_argument("--version", action="version", version=f"institutional-download {CLI_VERSION}")
    args = ap.parse_args()

    if bool(args.dois) == bool(args.urls):
        print("必须且只能指定 --dois 或 --urls 之一", file=sys.stderr)
        return 3
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    jar_path = Path(args.cookie_jar)

    # ---- load items ----
    items: list[dict] = []
    if args.urls:
        src = sys.stdin if args.urls == "-" else open(args.urls, encoding="utf-8")
        for line in src:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "\t" in line:
                doi, _, url = line.partition("\t")
                items.append({"doi": doi.strip(), "url": url.strip()})
            else:
                items.append({"doi": line, "url": ""})
        if src is not sys.stdin:
            src.close()
    else:
        src = sys.stdin if args.dois == "-" else open(args.dois, encoding="utf-8")
        for line in src:
            line = line.strip()
            if line and not line.startswith("#"):
                items.append({"doi": line, "url": ""})
        if src is not sys.stdin:
            src.close()
    if not items:
        print("未读取到任何 DOI/URL", file=sys.stderr)
        return 3

    if not jar_path.exists():
        print(
            f"cookie jar 不存在: {jar_path}\n"
            "请先运行登录向导生成会话 cookie:\n"
            "  python scripts/institutional_login.py <EZproxy/机构SSO登录URL> <额外域名...>",
            file=sys.stderr,
        )
        return 4

    # ---- CloakBrowser 依赖：自动选择装有 cloakbrowser 的解释器 ----
    py, tried = resolve_cloak_python()
    if py is None:
        print(f"[inst-dl] 未找到能 import cloakbrowser 的 Python 解释器。已探测: {', '.join(tried) or '无'}", file=sys.stderr)
        print(CLOAK_HINT, file=sys.stderr)
        return 4
    if os.path.normcase(os.path.abspath(py)) != os.path.normcase(os.path.abspath(sys.executable)):
        print(f"[inst-dl] 当前解释器缺少 cloakbrowser，自动改用: {py}", file=sys.stderr)
        return subprocess.call([py, str(Path(__file__).resolve())] + sys.argv[1:])
    from cloakbrowser import launch

    # ---- resolve Crossref ----
    if args.dois:
        print(f"[inst-dl] 正在经 Crossref 解析 {len(items)} 个 DOI 的出版商直链 ...", file=sys.stderr)
        for it in items:
            meta = _crossref(it["doi"])
            it["meta"] = meta
            it["urls"] = ((meta or {}).get("links") or []) + ([(meta or {}).get("landing")] if (meta or {}).get("landing") else [])
            it["url"] = it["urls"][0] if it["urls"] else ""
    else:
        for it in items:
            it["meta"] = None
            it["urls"] = [it["url"]] if it["url"] else []

    results: list[dict] = []
    browser = None
    try:
        print(f"[inst-dl] 启动 CloakBrowser（{'headful' if args.headful else 'headless'}）...", file=sys.stderr)
        browser = launch(headless=not args.headful)
        ctx = browser.new_context(accept_downloads=True)
        cookies = _load_jar(jar_path)
        if not cookies:
            print(f"[inst-dl] cookie jar 为空: {jar_path}", file=sys.stderr)
            return 4
        ctx.add_cookies(cookies)
        print(f"[inst-dl] 已加载 {len(cookies)} 条会话 cookie", file=sys.stderr)

        for idx, it in enumerate(items, 1):
            doi = it["doi"]
            entry: dict = {"doi": doi, "success": False, "source": "browser_context",
                           "file": None, "error": None}
            if not it["url"]:
                entry["error"] = "crossref_no_pdf_link"
                results.append(entry)
                print(f"[inst-dl] [{idx}/{len(items)}] {doi} -> 无直链", file=sys.stderr)
                continue
            saved = False
            for u in it["urls"]:
                try:
                    resp = ctx.request.get(u, timeout=args.timeout * 1000, max_redirects=10)
                    status = resp.status
                    body = resp.body()
                    if body[:4] == b"%PDF":
                        dest = out_dir / _filename(it.get("meta"), doi)
                        dest.write_bytes(body)
                        entry["success"] = True
                        entry["file"] = str(dest)
                        entry["error"] = None
                        saved = True
                        print(f"[inst-dl] [{idx}/{len(items)}] {doi} -> OK {dest.name}", file=sys.stderr)
                        break
                    ct = (resp.headers.get("content-type") or "")
                    entry["error"] = f"http_{status}_not_pdf (ct={ct})"
                    print(f"[inst-dl] [{idx}/{len(items)}] {doi} -> {u} 返回 {status}，非 PDF", file=sys.stderr)
                    if status == 200 and "html" in ct.lower():
                        print(f"[inst-dl]   提示: 返回 HTML = 登录页/无权限页（机构可能无该刊订阅）；确无权限请直接标记失败，勿反复重试。", file=sys.stderr)
                except Exception as e:
                    entry["error"] = f"request_error: {type(e).__name__}: {str(e)[:160]}"
                    print(f"[inst-dl] [{idx}/{len(items)}] {doi} -> {u} 请求失败: {entry['error']}", file=sys.stderr)
                if saved:
                    break
                time.sleep(1.0)
            if not saved and entry["error"] and "418" in str(entry["error"]):
                entry["error"] += " (WAF 拦截；会话可能过期，重跑 institutional_login.py)"
            results.append(entry)
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass

    succeeded = sum(1 for r in results if r["success"])
    total = len(results)
    failed = total - succeeded
    ok = "ok" if failed == 0 else ("partial" if succeeded > 0 else "fail")
    envelope = {
        "ok": ok,
        "meta": {
            "cli_version": CLI_VERSION,
            "cookie_jar": str(jar_path),
            "headless": not args.headful,
            "total": total,
        },
        "data": {
            "summary": {"total": total, "succeeded": succeeded, "failed": failed},
            "results": results,
        },
    }
    _emit(envelope)
    return 0 if failed == 0 else (2 if succeeded > 0 else 1)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
