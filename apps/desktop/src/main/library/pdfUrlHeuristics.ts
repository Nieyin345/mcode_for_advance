/**
 * PDF 直链形状的两档判定 —— **全仓库就这一份**,别再各处手抄正则。
 *
 * 不只看 `.pdf` 结尾 —— 好几个大出版商的直链根本不以 `.pdf` 收尾:
 *   Nature     https://www.nature.com/articles/s41567-...-.pdf        (.pdf)
 *   Wiley      https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/...
 *   TechRxiv   https://www.techrxiv.org/doi/pdf/10.36227/...
 *   arXiv      https://arxiv.org/pdf/2302.01934
 *   MDPI       https://www.mdpi.com/2076-3417/15/3/1308/pdf?version=...
 *   Elsevier   https://www.sciencedirect.com/science/article/pii/S.../pdfft
 * 这些 URL 是**开放获取解析器或出版商模板给的**,本来就保证是 PDF 而不是落地页 ——
 * 所以按形状放行,不要再要求 `.pdf` 后缀把它们全挡掉。
 * (实测:只用 `.pdf$` 时,Wiley / TechRxiv / arXiv / MDPI / Elsevier 那几个明明拿到了
 * 直链,却依然被判成"落地页"下不了。)
 *
 * ## 为什么是两档而不是一份
 *
 * 以前这两个正则在 downloader.ts 和 oaResolvers.ts 各持一份,注释里互相指认
 * ("同源,这里更宽一点")—— 改一处忘另一处必然漂移。收口到这里,宽窄之别写在
 * 各自的 doc 里,谁要动形状就动这一个文件。
 */

/** 窄档:**下载器放行**用 —— 判断「这个地址可以直接当 PDF 试」。
 *  (原 downloader.ts 的 PDF_URL_RE,downloader 从这里 re-export。) */
export const PDF_URL_RE = /\.pdf(\?|$)|\/pdf\/|\/pdfdirect\/|\/pdf\?|\/pdfft/i;

/** 宽档:**OA 候选排序/过滤**用 —— 在窄档之外还认 PMC 的渲染端点、机构库的
 *  bitstream 路径这类"看起来就是 PDF"的地址,排序时把最像 PDF 的排前面。
 *  (原 oaResolvers.ts 的 LOOKS_LIKE_PDF_RE。) */
export const LOOKS_LIKE_PDF_RE =
  /\.pdf(\?|$)|\.pdf\/|\/pdf\/|\/pdfdirect\/|\/pdf\?|\/pdfft|\/pdf$|pdf=render|\/bitstream\/|\/download(\?|$)/i;
