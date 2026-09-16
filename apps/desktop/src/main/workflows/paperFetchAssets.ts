/**
 * paper-fetch 的源码正文,以 **Vite `?raw` 导入**随应用发布。
 *
 * ## 为什么用 `?raw` 而不是像 `assets.ts` 那样写成 TS 模板字符串
 *
 * `assets.ts` 里那两个脚本是手写内嵌的模板字符串,代价是正文里**不能出现反引号和
 * `${`**。paper-fetch 是 2700 行的现成工具,注释里到处是 Markdown 代码段(反引号),
 * 靠转义搬进来一定会出错,而且以后也没法跟上游同步。
 *
 * `?raw` 是构建期的纯文本内联:**磁盘上的文件逐字不动**,由 Vite 负责把它变成字符串
 * 常量。所以这里搬的是原文件本身,不是改写版。
 *
 * ## 为什么整份搬
 *
 * 这几个文件互相引用(`paper_fetch.py` 会调 `convert_pdf_to_md.py` 做 PDF→Markdown,
 * 会调 `institutional_download.py` 走机构订阅,`cloak_pdf.py` / `_cloak_env.py` 是它的
 * 可选依赖)。只搬一个会让整条链路在运行到某一步时才断 —— 那比不搬更难查。
 */
import paperFetchPy from "./paper-fetch/paper_fetch.py?raw";
import convertPdfToMdPy from "./paper-fetch/convert_pdf_to_md.py?raw";
import institutionalDownloadPy from "./paper-fetch/institutional_download.py?raw";
import institutionalLoginPy from "./paper-fetch/institutional_login.py?raw";
import cloakPdfPy from "./paper-fetch/cloak_pdf.py?raw";
import cloakEnvPy from "./paper-fetch/_cloak_env.py?raw";
import cdpDownloadMjs from "./paper-fetch/cdp_download.mjs?raw";
import edgeCdpPs1 from "./paper-fetch/edge_cdp.ps1?raw";
import readmeMd from "./paper-fetch/README.md?raw";

/** 相对 `<数据根>/workflows/scripts/paper-fetch/` 的文件名 → 正文。 */
export const PAPER_FETCH_FILES: ReadonlyArray<[name: string, body: string]> = [
  ["README.md", readmeMd],
  ["paper_fetch.py", paperFetchPy],
  ["convert_pdf_to_md.py", convertPdfToMdPy],
  ["institutional_download.py", institutionalDownloadPy],
  ["institutional_login.py", institutionalLoginPy],
  ["cloak_pdf.py", cloakPdfPy],
  ["_cloak_env.py", cloakEnvPy],
  ["cdp_download.mjs", cdpDownloadMjs],
  ["edge_cdp.ps1", edgeCdpPs1],
];
