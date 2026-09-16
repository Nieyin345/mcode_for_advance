# paper-fetch（整装引入）

来源：**obra** 的 `paper-fetch`。纯标准库。

> 这个 README 是 `00_引入规范.md` §4 要求的：**引入了什么、为什么、改了什么**。
> 本目录 2026-09-13 之前没有它，是同批收口时补的。

## 为什么引入

「按 DOI 拿 PDF」这件事别人做过十年了，而且**难在回退链**——OA 拿不到要走机构订阅，
机构订阅还要过出版商 WAF。自己写一遍必然在某一环翻车。

## 引入了什么

| 文件 | 干什么 |
|------|--------|
| `paper_fetch.py` | 主程序（约 118 KB）。按 DOI 下载 PDF，**回退链** Unpaywall→S2→arXiv→EuropePMC→PMC→bioRxiv；带 SSRF 防御、50 MB 上限、`%PDF` 校验 |
| `institutional_login.py` | 机构登录向导：开**可见的隐身浏览器**，用户手动登录（含 MFA），回终端回车后导出**会话 cookie** |
| `institutional_download.py` | 带会话 cookie、在浏览器上下文里请求出版商直链——指纹与会话都对，能过 IEEE Xplore 那种 WAF（`urllib` 会被 418 拦） |
| `cloak_pdf.py` + `_cloak_env.py` | Cloudflare 拦截时的隐身浏览器回退；`_cloak_env` 探测哪个解释器装了 `cloakbrowser` |
| `edge_cdp.ps1` + `cdp_download.mjs` | 另一条路径：独立 profile 的 Edge + CDP，让用户登录一次后由脚本驱动下载 |
| `convert_pdf_to_md.py` | **PDF → Markdown**。封装 MinerU 在线 API，见下 |

## 改了什么

**代码一字未改。**改动全在**调用方式**（环境变量），符合规范 §4「整装引入 + 只改配置」。

| 开关 | 值 | 为什么 |
|------|-----|--------|
| `PAPER_FETCH_NO_SCIHUB` | **必须 `=1`** | ⚠️ **`paper_fetch.py` 默认会落到 Sci-Hub。** 本项目只走合法渠道，见 `记忆库/02_决策记录.md` §11 |
| `PAPER_FETCH_INSTITUTIONAL` | `=1` 启用 | 机构订阅渠道（校园网 / VPN）|

## `convert_pdf_to_md.py` 为什么留着（曾被认为是「同一件事的第二个实现」）

2026-09-13 收口时核查，**这个判断是错的**。它**不是**本地模型转换器（不涉 GPU、不涉权重），
而是 **MinerU 在线 API 的健壮性封装**，解决一个真问题：

> 官方 CLI（`mineru-open-api`）的 `http.Client` 写死单请求 **60s 超时**，
> 而到阿里云上海 OSS 的上传常只有 **40–50 KB/s**，**3 MB 以上的 PDF 必然超时**。

它多出来的能力：

| 能力 | 说明 |
|------|------|
| 长超时上传兜底 | 默认 900s（官方 60s）|
| **URL 模式** | 服务端抓取，**完全不经本机上传**——大文件首选 |
| `--pages` / `--ocr` | 只转指定页 / 扫描版先 OCR |
| `--md-name` | 直接落成规范短名 |
| 自动安装 | 找不到 `mineru-open-api` 时尝试运行内置安装脚本 |

所以 `sci-lit-intake` 的「生成转换稿」一步**指向这个脚本**，而不是裸调 `mineru-open-api`。

**已知小瑕疵**：`SKILL_DIR` 按 `Path(__file__).parent.parent` 推算，期望自己住在
`<skill>/scripts/`。本目录下它算出的 `scripts/mineru/install.ps1` 不存在——
好在代码有 `.exists()` 守卫，只是**跳过自动安装**，走 PATH 上的 `mineru-open-api`。
（那个安装脚本本来也没抄进来。）

## 怎么用

```bash
# 下载（必须带 NO_SCIHUB）
PAPER_FETCH_NO_SCIHUB=1 python 模板库/代码/paper-fetch/paper_fetch.py \
    --batch dois.txt --out <目标目录> --format json

# 机构订阅（校园网/VPN 下）
PAPER_FETCH_INSTITUTIONAL=1 PAPER_FETCH_NO_SCIHUB=1 ...

# 转 markdown（入库用 extract 档，flash 档不出图片）
python 模板库/代码/paper-fetch/convert_pdf_to_md.py <pdf|URL> --out <目录> \
    --mode extract --model vlm --md-name <短名>
```

机构会话 cookie 的完整流程（含安全约定：只存 cookie、绝不存账号密码、cookie jar 必须在
gitignore 的位置）见 `记忆库/02_决策记录.md` §11。
