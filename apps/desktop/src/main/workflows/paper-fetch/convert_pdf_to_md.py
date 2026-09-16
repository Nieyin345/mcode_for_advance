#!/usr/bin/env python3
"""PDF -> Markdown 转换（MinerU Open API CLI + 内置长超时上传兜底）。

使用 MinerU Open API 将 PDF 转换为 Markdown。优先使用官方 CLI
（mineru-open-api）；当文件较大或官方 CLI 上传超时（官方 CLI 写死
http.Client 单请求 60s 超时，而到阿里云上海 OSS 的上传常仅 40-50KB/s，
3MB 以上必然超时）时，自动改用内置 API 通道：上传用 curl 长超时
（默认 900s），并支持 URL 模式（服务器端抓取，完全不经本机上传）。

转换档位（精度从低到高）：
  - flash（默认，免认证）：轻量 pipeline 模型，Markdown only；限制 <= 10MB / <= 20 页；
    速度快但版面/公式/表格还原一般，适合快速预览与草稿（**不提取图片，无 images/ 图床**）。
  - extract + pipeline：精提取传统高精度模型，保留布局 + 图片/表格/公式资产；需 MINERU_TOKEN。
  - extract + vlm（推荐，--model vlm 默认）：精提取最高精度模型，复杂版面/公式/表格还原最好；
    需 MINERU_TOKEN。
  - 扫描版 PDF：extract 模式加 --ocr，先 OCR 再解析；可加 --pages 只转指定页（如 "1-10"）。

用法：
  python convert_pdf_to_md.py <pdf路径|URL> --out <输出文件夹> [--mode flash|extract]
       [--model vlm|pipeline] [--ocr] [--pages <页范围>] [--md-name <规范短名>]
       [--language en] [--timeout 300] [--upload-timeout 900] [--bin <cli路径>]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
BUNDLED_INSTALLER = SKILL_DIR / "scripts" / "mineru" / "install.ps1"

FLASH_BASE = "https://mineru.net/api/v1/agent"
V4_BASE = "https://mineru.net/api/v4"

# 官方 CLI 的 http.Client 单请求超时写死为 60s（DefaultRequestTimeout）；
# 慢速网络下到阿里云上海 OSS 的上传约 40-50KB/s，3MB 以上必然超时。
# 超过该阈值的文件直接走内置 API 通道，不再浪费一次必然失败的 CLI 尝试。
CLI_UPLOAD_CEILING = 3 * 1024 * 1024


def _default_bin() -> str:
    candidates = []
    env_bin = os.environ.get("MINERU_BIN", "").strip()
    if env_bin:
        candidates.append(env_bin)
    home = str(Path.home())
    candidates.append(str(Path(home) / ".mineru" / "bin" / "mineru-open-api.exe"))
    which = shutil.which("mineru-open-api")
    if which:
        candidates.append(which)
    for c in candidates:
        if c and Path(c).exists():
            return c
    return candidates[0] if candidates else "mineru-open-api"


def _env_value(key: str) -> str:
    env_file = SKILL_DIR / ".env"
    if not env_file.exists():
        return ""
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def ensure_bin(bin_path: str) -> str:
    """确保 mineru-open-api 可用；缺失时尝试用打包的安装脚本安装。"""
    if Path(bin_path).exists() or shutil.which(bin_path):
        return bin_path
    if os.name == "nt" and BUNDLED_INSTALLER.exists():
        print(
            f"[convert] mineru-open-api 未找到，尝试运行内置安装脚本: {BUNDLED_INSTALLER}",
            file=sys.stderr,
        )
        pwsh = shutil.which("pwsh") or shutil.which("powershell")
        if pwsh:
            proc = subprocess.run(
                [pwsh, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(BUNDLED_INSTALLER)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    "MinerU CLI 安装失败:\n"
                    + proc.stdout
                    + "\n"
                    + proc.stderr
                    + "\n请手动运行安装命令后再试。"
                )
            installed = str(Path.home() / ".mineru" / "bin" / "mineru-open-api.exe")
            if Path(installed).exists():
                return installed
    raise RuntimeError(
        "未找到 mineru-open-api。请先安装：\n"
        "  Windows: irm https://cdn-mineru.openxlab.org.cn/open-api-cli/install.ps1 | iex\n"
        "  或运行本 skill 内置安装脚本: scripts/mineru/install.ps1\n"
        "  安装完成后如命令仍不可用，请重启终端或设置 MINERU_BIN 环境变量指向可执行文件。"
    )


def _attach_pdf_link(md_path, pdf_path, source):
    """在转换产物 md 顶部插入「原文 PDF」链接（Obsidian wikilink；PDF 与 md 同目录）。

    pdf_path 为本地 PDF 时用 wikilink [[文件名.pdf]]（Obsidian 内可点击跳转）；
    source 为 http(s) URL 时放 Markdown 链接（服务器端抓取，无本地文件）。
    幂等：md 顶部已含「原文 PDF」标记则跳过，避免重复插入。
    """
    target = Path(md_path)
    if not target.exists():
        return
    text = target.read_text(encoding="utf-8", errors="replace")
    if "原文 PDF" in text[:500]:
        return
    if pdf_path is not None and Path(pdf_path).exists():
        block = "> [!note] 原文 PDF：[[{}]]\n\n---\n\n".format(Path(pdf_path).name)
    elif str(source).startswith(("http://", "https://")):
        block = "> [!note] 原文 PDF（URL）：[{}]({})\n\n---\n\n".format(source, source)
    else:
        return
    target.write_text(block + text.lstrip("\ufeff"), encoding="utf-8")


# ---------------------------------------------------------------------------
# 内置 API 通道（长超时上传，绕开官方 CLI 的 60s 单请求硬超时）
# ---------------------------------------------------------------------------

def _is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _find_curl() -> str:
    for cand in (shutil.which("curl"), shutil.which("curl.exe"), r"C:\Windows\System32\curl.exe"):
        if cand and Path(cand).exists():
            return cand
    raise RuntimeError("未找到 curl.exe：长超时上传需要 curl，请安装或改用 --bin 指定官方 CLI")


def _json_req(method: str, url: str, headers=None, body=None, timeout: int = 60):
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _raw_get(url: str, timeout: int = 180) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def _put_via_curl(pdf: Path, url: str, upload_timeout: int) -> bool:
    """与 Zotero 插件同款上传：curl -s -f -T <file> --max-time <N>，无 Content-Type。"""
    curl = _find_curl()
    cmd = [curl, "-s", "-f", "-T", str(pdf), "--max-time", str(upload_timeout), "--url", url]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=upload_timeout + 30,
        )
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def _upload_with_retry(pdf: Path, file_url: str, upload_timeout: int) -> None:
    print(f"[convert] 长超时上传（单次最多 {upload_timeout}s）: {pdf.name}", file=sys.stderr)
    for attempt in range(1, 4):
        if _put_via_curl(pdf, file_url, upload_timeout):
            return
        print(f"[convert] 上传失败（第 {attempt} 次），5 秒后重试...", file=sys.stderr)
        time.sleep(5)
    raise RuntimeError("上传到 MinerU OSS 失败（curl 多次尝试未成功，可能网络被限速/阻断）")


def _poll(poll_fn, timeout: int, interval: int = 5) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = poll_fn()
        state = r.get("state")
        if state == "done":
            return r
        if state == "failed":
            raise RuntimeError("MinerU 任务失败: " + str(r.get("err_msg") or r.get("err_code") or "未知错误"))
        time.sleep(interval)
    raise RuntimeError(f"MinerU 任务轮询超时（>{timeout}s）")


def api_flash_convert(source: str, out_dir: Path, language: str, upload_timeout: int, md_name: str = "") -> str:
    """flash（agent）API：URL 模式服务器端抓取 / 本地文件长超时上传。返回 .md 路径。"""
    if _is_url(source):
        payload = {"url": source, "language": language}
        data = _json_req(
            "POST", FLASH_BASE + "/parse/url",
            headers={"Content-Type": "application/json"},
            body=json.dumps(payload).encode("utf-8"),
        )
        task_id = data["data"]["task_id"]
        stem = Path(urllib.request.urlparse(source).path).stem or "paper"
    else:
        pdf = Path(source)
        payload = {"file_name": pdf.name, "language": language}
        data = _json_req(
            "POST", FLASH_BASE + "/parse/file",
            headers={"Content-Type": "application/json"},
            body=json.dumps(payload).encode("utf-8"),
        )
        d = data["data"]
        task_id = d["task_id"]
        file_url = d["file_url"]
        stem = pdf.stem
        _upload_with_retry(pdf, file_url, upload_timeout)

    def poll():
        d = _json_req("GET", FLASH_BASE + "/parse/" + task_id)["data"]
        return {
            "state": d.get("state"),
            "markdown_url": d.get("markdown_url"),
            "err_msg": d.get("err_msg"),
            "err_code": d.get("err_code"),
        }

    r = _poll(poll, upload_timeout + 300)
    md_url = r.get("markdown_url")
    if not md_url:
        raise RuntimeError("任务完成但未返回 markdown_url")
    md_text = _raw_get(md_url, timeout=180).decode("utf-8", errors="replace")
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / ((md_name or stem) + ".md")
    target.write_text(md_text, encoding="utf-8")
    print(
        "[convert] 提示：flash 模式不提取图片（无 images/ 图床），正式入库请用 --mode extract --model vlm",
        file=sys.stderr,
    )
    return str(target)


def api_extract_convert(source: str, out_dir: Path, language: str, upload_timeout: int, token: str, model: str = "vlm", ocr: bool = False, pages: str = "", md_name: str = "") -> str:
    """extract（v4）API：精提取，返回 .md 路径，图片写入 out_dir/images/。"""
    auth = {"Authorization": "Bearer " + token}
    if _is_url(source):
        file_entry: dict = {"url": source, "is_ocr": ocr}
        if pages:
            file_entry["page_ranges"] = pages
        payload = {
            "model_version": model,
            "language": language,
            "enable_formula": True,
            "enable_table": True,
            "files": [file_entry],
        }
        data = _json_req(
            "POST", V4_BASE + "/extract/task/batch",
            headers={**auth, "Content-Type": "application/json"},
            body=json.dumps(payload).encode("utf-8"),
        )
        batch_id = data["data"]["batch_id"]
        stem = Path(urllib.request.urlparse(source).path).stem or "paper"
    else:
        pdf = Path(source)
        file_entry: dict = {"name": pdf.name, "is_ocr": ocr}
        if pages:
            file_entry["page_ranges"] = pages
        payload = {
            "model_version": model,
            "language": language,
            "enable_formula": True,
            "enable_table": True,
            "files": [file_entry],
        }
        data = _json_req(
            "POST", V4_BASE + "/file-urls/batch",
            headers={**auth, "Content-Type": "application/json"},
            body=json.dumps(payload).encode("utf-8"),
        )
        d = data["data"]
        batch_id = d["batch_id"]
        file_url = d["file_urls"][0]
        stem = pdf.stem
        _upload_with_retry(pdf, file_url, upload_timeout)

    def poll():
        d = _json_req("GET", V4_BASE + "/extract-results/batch/" + batch_id, headers=auth)["data"]
        er = (d.get("extract_result") or [{}])[0]
        return {
            "state": er.get("state"),
            "zip_url": er.get("full_zip_url"),
            "err_msg": er.get("err_msg"),
            "err_code": er.get("err_code"),
        }

    r = _poll(poll, upload_timeout + 300)
    zip_url = r.get("zip_url")
    if not zip_url:
        raise RuntimeError("任务完成但未返回 full_zip_url")
    print("[convert] 下载解析结果 zip...", file=sys.stderr)
    zip_bytes = _raw_get(zip_url, timeout=300)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / ((md_name or stem) + ".md")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = z.namelist()
        zip_md_name = next((n for n in names if n.endswith("full.md")), None)
        if zip_md_name is None:
            zip_md_name = next((n for n in names if n.endswith(".md") and not n.startswith("_")), None)
        if zip_md_name is None:
            raise RuntimeError("结果 zip 中未找到 full.md")
        target.write_bytes(z.read(zip_md_name))
        img_dir = out_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        for n in names:
            if n.startswith("images/") and not n.endswith("/"):
                (img_dir / Path(n).name).write_bytes(z.read(n))
    return str(target)


def _convert_via_api(pdf_path: Path, out_dir: Path, mode: str, language: str, upload_timeout: int, model: str = "vlm", ocr: bool = False, pages: str = "", md_name: str = "") -> dict:
    try:
        if mode == "extract":
            token = os.environ.get("MINERU_TOKEN", "").strip() or _env_value("MINERU_TOKEN")
            if not token:
                return {
                    "ok": False,
                    "pdf": str(pdf_path),
                    "error": "extract 模式需要 MinerU API Token（python scripts/manage_keys.py set MINERU_TOKEN <token>）",
                }
            md = api_extract_convert(str(pdf_path), out_dir, language, upload_timeout, token, model, ocr, pages, md_name)
        else:
            md = api_flash_convert(str(pdf_path), out_dir, language, upload_timeout, md_name)
        return {"ok": True, "pdf": str(pdf_path), "md": md, "mode": mode, "via": "api"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "pdf": str(pdf_path), "error": str(e)}


# ---------------------------------------------------------------------------
# 官方 CLI 路径（小文件优先）
# ---------------------------------------------------------------------------

def _convert_via_cli(pdf: Path, out_dir: Path, mode: str, language: str, timeout: int, bin_path: str, model: str = "vlm", ocr: bool = False, pages: str = "", md_name: str = "") -> dict:
    token = os.environ.get("MINERU_TOKEN", "").strip() or _env_value("MINERU_TOKEN")
    cmd = [bin_path]
    if mode == "extract":
        if not token:
            return {
                "ok": False,
                "pdf": str(pdf),
                "error": "extract 模式需要 MinerU API Token：请先运行 mineru-open-api auth，或保存密钥（python scripts/manage_keys.py set MINERU_TOKEN <token>）",
            }
        cmd += ["extract", str(pdf), "-o", str(out_dir), "-f", "md", "--language", language, "--timeout", str(timeout), "--token", token, "--model", model]
        if ocr:
            cmd += ["--ocr"]
        if pages:
            cmd += ["--pages", pages]
    else:
        cmd += ["flash-extract", str(pdf), "-o", str(out_dir), "--language", language, "--timeout", str(timeout)]

    shown = [c if "token" not in c.lower() else "***" for c in cmd]
    print(f"[convert] 运行: {' '.join(shown)}", file=sys.stderr)
    hard_timeout = timeout + 120
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=hard_timeout,
        )
    except subprocess.TimeoutExpired:
        print(f"[convert] 转换超时（>{hard_timeout}s），已终止进程: {pdf}", file=sys.stderr)
        return {
            "ok": False,
            "pdf": str(pdf),
            "error": (
                f"转换超时（超过 {hard_timeout}s）：MinerU CLI 无响应。"
                "常见原因：PDF 过大或网络到 MinerU 云端不稳定（上传/轮询挂起）。"
            ),
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "pdf": str(pdf),
            "error": proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}",
        }

    produced = list(out_dir.glob("*.md"))
    if not produced:
        return {
            "ok": False,
            "pdf": str(pdf),
            "error": "转换完成但未在输出目录找到 .md 文件",
        }
    produced.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    target = out_dir / ((md_name or pdf.stem) + ".md")
    if produced[0].resolve() != target.resolve():
        shutil.move(str(produced[0]), str(target))
    if mode != "extract":
        print(
            "[convert] 提示：flash 模式不提取图片（无 images/ 图床），正式入库请用 --mode extract --model vlm",
            file=sys.stderr,
        )
    return {"ok": True, "pdf": str(pdf), "md": str(target), "mode": mode, "via": "cli"}


def convert(pdf: str, out_dir: Path, mode: str, language: str, timeout: int, bin_path: str, upload_timeout: int, model: str = "vlm", ocr: bool = False, pages: str = "", md_name: str = "") -> dict:
    if _is_url(pdf):
        try:
            if mode == "extract":
                token = os.environ.get("MINERU_TOKEN", "").strip() or _env_value("MINERU_TOKEN")
                if not token:
                    return {"ok": False, "pdf": pdf, "error": "extract 模式需要 MinerU API Token"}
                md = api_extract_convert(pdf, out_dir, language, upload_timeout, token, model, ocr, pages, md_name)
            else:
                md = api_flash_convert(pdf, out_dir, language, upload_timeout, md_name)
            _attach_pdf_link(md, None, pdf)
            return {"ok": True, "pdf": pdf, "md": md, "mode": mode, "via": "api-url"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "pdf": pdf, "error": str(e)}

    pdf_path = Path(pdf)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF 不存在: {pdf}")
    out_dir.mkdir(parents=True, exist_ok=True)

    if pdf_path.stat().st_size > CLI_UPLOAD_CEILING:
        print("[convert] 文件较大，直接使用内置长超时上传通道（绕开官方 CLI 60s 硬超时）...", file=sys.stderr)
        result = _convert_via_api(pdf_path, out_dir, mode, language, upload_timeout, model, ocr, pages, md_name)
        if result.get("ok"):
            _attach_pdf_link(result["md"], pdf_path, pdf)
        return result

    result = _convert_via_cli(pdf_path, out_dir, mode, language, timeout, bin_path, model, ocr, pages, md_name)
    if result.get("ok"):
        _attach_pdf_link(result["md"], pdf_path, pdf)
        return result
    err = (result.get("error") or "").lower()
    if any(k in err for k in ("context deadline exceeded", "client.timeout", "tls handshake timeout", "upload")):
        print("[convert] 官方 CLI 上传超时，改用内置长超时上传通道...", file=sys.stderr)
        return _convert_via_api(pdf_path, out_dir, mode, language, upload_timeout, model, ocr, pages, md_name)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="PDF -> Markdown（MinerU，官方 CLI + 长超时上传兜底）")
    ap.add_argument("pdf", help="PDF 文件路径或 http(s) URL（URL 走服务器端抓取）")
    ap.add_argument("--out", default=".", help="输出文件夹（论文文件夹）")
    ap.add_argument(
        "--mode", choices=["flash", "extract"], default="flash",
        help="flash=免认证快速提取（默认，轻量模型，限 10MB/20 页）；extract=精提取（需 token）",
    )
    ap.add_argument(
        "--model", choices=["vlm", "pipeline"], default="vlm",
        help="extract 精提取模型：vlm=最高精度（默认，公式/表格/复杂版面最好）；pipeline=传统高精度",
    )
    ap.add_argument("--ocr", action="store_true", help="extract 模式启用 OCR（扫描版 PDF 用；flash 不支持）")
    ap.add_argument("--pages", default="", help="extract 模式只转指定页范围，如 '1-10,15'（flash 不支持）")
    ap.add_argument("--md-name", default="", help="输出 md 的规范文件名（不含扩展名，如论文短名 <短名>.md；默认用 PDF 原名）")
    ap.add_argument("--language", default="en", help="文档语言，默认 en")
    ap.add_argument("--timeout", type=int, default=300, help="CLI 内部超时秒数（默认 300）；外层硬超时为其 +120s")
    ap.add_argument("--upload-timeout", type=int, default=900, help="内置长超时上传单次上限秒数（默认 900，重试 3 次）")
    ap.add_argument("--bin", default="", help="mineru-open-api 可执行文件路径（默认自动查找）")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    try:
        pdf = args.pdf
        out_dir = Path(args.out)
        need_cli = (not _is_url(pdf)) and Path(pdf).exists() and Path(pdf).stat().st_size <= CLI_UPLOAD_CEILING
        bin_path = ""
        if need_cli:
            bin_path = args.bin or _default_bin()
            bin_path = ensure_bin(bin_path)
        result = convert(pdf, out_dir, args.mode, args.language, args.timeout, bin_path, args.upload_timeout, args.model, args.ocr, args.pages, args.md_name)
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "pdf": args.pdf, "error": str(e)}

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
