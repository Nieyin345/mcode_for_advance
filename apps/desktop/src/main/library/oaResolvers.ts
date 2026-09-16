/**
 * PDF 直链解析 —— 「同一个 DOI,挨个源问一遍,谁先给出直链就先用谁的」。
 *
 * ## 为什么要单独一个模块
 *
 * `downloader.ts` 原来只解析**一个**地址:问 OpenAlex 要 `best_oa_location.pdf_url`,
 * 没有就按出版商前缀拼一条。够用,但只有一次机会 —— 第一个候选 403 或指向落地页,
 * 这一篇就判"下不了"了。而实际上同一个 DOI 往往在好几个地方都有直链:
 *
 * | 源 | 给出什么 | 特点 |
 * |---|---|---|
 * | arXiv | `arxiv.org/pdf/<id>` | 由 DOI 或 arxivId 直接拼,不用请求 |
 * | 出版商直链模板 | Nature/Science/Wiley/… 的 pdf 路径 | 不用请求;**内嵌浏览器带机构 cookie 时最能下** |
 * | Crossref `link[]` | IEEE 的 xplore 直链、(Elsevier 的 PII) | 一次请求,把"拼不出来"的两家补上 |
 * | OpenAlex | `best_oa_location` / `locations[]` / `open_access.oa_url` | 绿色 OA 副本最全 |
 * | Unpaywall | `best_oa_location.url_for_pdf` + `oa_locations[]` | 与 OpenAlex 同源,但字段更全;**需要一个真邮箱** |
 * | Europe PMC | `pmcid` → 渲染端点 | 生物医学;`europepmc.org/...?pdf=render` 绕开 PMC 的 PoW 拦截 |
 * | Semantic Scholar | `openAccessPdf` + `externalIds` | **桥**:能从 DOI 反查出 arXiv / PMC 编号 |
 * | OpenAIRE | 机构库 / 预印本链接 | 常是付费论文唯一的免费副本 |
 *
 * 本条链路的原型是用户本地的 `模板库/代码/paper-fetch/paper_fetch.py`(引入自
 * obra/paper-fetch)。**刻意没有搬它的 Sci-Hub 支路** —— 那是盗版镜像站,
 * 不接进产品。
 *
 * ## 输出的是**候选列表**,不是单个地址
 *
 * 这是"聪明"的关键:解析完不代表能下。真正的判据是 `verifyPdf` 的 `%PDF` 魔数
 * (见 downloader.ts)。所以这里给出一串按可信度排序的候选,下载器逐个试,
 * 第一个通过校验的就算成功。原来是"问一次 + 试一次",现在是"问一圈 + 试到成为止"。
 *
 * ## 不做任何鉴权
 *
 * 这一层只发**公开元数据**请求,不带 cookie —— 与 `http.ts` 的分工一致。
 * 需要登录态的下载走内嵌浏览器(`downloadViaBrowser`),它自己带会话。
 */
import { fetchJson, LIBRARY_UA, LIBRARY_MAILTO } from "./http.js";
// PDF 直链的两档正则收口在 pdfUrlHeuristics.ts;这里用宽档(排序/过滤要额外认
// PMC 渲染端点与机构库 bitstream)。
import { LOOKS_LIKE_PDF_RE } from "./pdfUrlHeuristics.js";

/** 一个候选直链。`via` 只用于日志/排查 —— 用户不需要看见是谁给的。 */
export interface PdfCandidate {
  url: string;
  via: string;
}

/** Unpaywall 要求一个**真实**邮箱(示例邮箱会被 422 拒掉),所以它是可选项:
 *  没配就跳过 —— OpenAlex 覆盖了同一批数据,只是字段少一点。 */
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL?.trim() || "";

/** 候选上限。够覆盖真实情况,又不至于让一次下载变成十几次 HTTP 尝试。 */
const MAX_CANDIDATES = 8;

/**
 * 从 DOI 里认出 arXiv。
 *
 * arXiv 给每篇预印本注册的 DOI 形如 `10.48550/arXiv.2302.01934` —— 它**就是** arXiv
 * 上的那一篇。检索结果里这种很多(OpenAlex 与 Semantic Scholar 常常只给 DOI、
 * 不给 arxivId),不认它有两个后果:
 *   ① 和「以 arxivId 入库的同一条」变成两条重复记录;
 *   ② 下载器看不出这是 arXiv,只好去 doi.org 的落地页 —— 那是网页不是 PDF,下不了。
 */
export function arxivIdFromDoi(doi: string | undefined): string | undefined {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec((doi ?? "").trim());
  return m ? m[1] : undefined;
}

/** 落地页/解析器站点 —— 它们永远不会直接吐 PDF,出现在仓库类结果里要剔掉。 */
const LANDING_HOST_MARKERS = [
  "doi.org",
  "dx.doi.org",
  "researchgate.net",
  "academia.edu",
  "scispace.com",
  "sciencedirect.com",
  "onlinelibrary.wiley.com",
  "tandfonline.com",
  "academic.oup.com",
];

/* ─────────────────────── 第一梯队:不用联网就能拼出来 ─────────────────────── */

/** 出版商 DOI 前缀 → PDF 直链模板。
 *
 *  **抄自用户本地的 `模板库/代码/paper-fetch/paper_fetch.py`**(引入自 obra/paper-fetch)。
 *  它解决的是 OpenAlex 覆盖不到的那一档:有些出版商的开放获取版本没被 OpenAlex 收录,
 *  但直链是可以按规则拼出来的。
 *
 *  ⚠️ 拼出来的地址**不保证能下**:多数出版商要订阅。但 Mcode 的下载走的是内嵌浏览器
 *  那个会话,用户如果在设置里登录过机构账号,cookie 就在那个会话里 —— 这时这类直链
 *  往往是能下的。拼错也只是多一次失败的尝试,不会更糟。 */
const PUBLISHER_PDF_TEMPLATES: Array<[prefix: string, label: string, build: (doi: string, suffix: string) => string]> = [
  ["10.1038/", "nature", (_d, s) => `https://www.nature.com/articles/${s}.pdf`],
  ["10.1126/", "science", (d) => `https://www.science.org/doi/pdf/${d}`],
  ["10.1002/", "wiley", (d) => `https://onlinelibrary.wiley.com/doi/pdf/${d}`],
  ["10.1007/", "springer", (d) => `https://link.springer.com/content/pdf/${d}.pdf`],
  ["10.1021/", "acs", (d) => `https://pubs.acs.org/doi/pdf/${d}`],
  ["10.1073/", "pnas", (d) => `https://www.pnas.org/doi/pdf/${d}`],
  ["10.1056/", "nejm", (d) => `https://www.nejm.org/doi/pdf/${d}`],
  ["10.1177/", "sage", (d) => `https://journals.sagepub.com/doi/pdf/${d}`],
  ["10.1080/", "tandf", (d) => `https://www.tandfonline.com/doi/pdf/${d}`],
];

/** MDPI 的 DOI 里用短缩写,CDN 路径里用长 slug(`app` → `applsci`)。抄自同一份脚本。
 *  两边都用 CDN(pub.mdpi-res.com)而不是 www.mdpi.com —— 后者被 Akamai 挡着,
 *  对数据中心 IP 和不少非西方网段即使是开放获取也直接 403。 */
const MDPI_SHORT_TO_SLUG: Record<string, string> = {
  app: "applsci", su: "sustainability", ma: "materials", en: "energies",
  ani: "animals", polym: "polymers", antiox: "antioxidants", math: "mathematics",
  sym: "symmetry", nano: "nanomaterials", met: "metals", catal: "catalysts",
  cryst: "crystals", atmos: "atmosphere", info: "information",
  md: "marinedrugs", fi: "futureinternet", f: "forests", w: "water",
  v: "viruses", d: "diversity",
};

/** MDPI 的 DOI 后缀形状:`<短名><年2位><期2位><文章号>`,文章号在 URL 里补到 5 位。 */
const MDPI_DOI_SUFFIX_RE = /^([a-z]+)(\d{2})(\d{2})(\d+)$/;

/** 拼 MDPI 的 CDN 直链。短名有映射时**给两个候选**(映射过的 + 短名原样)——
 *  映射表可能过时,两个都试比猜一个强。 */
function mdpiPdfCandidates(doi: string): PdfCandidate[] {
  if (!doi.startsWith("10.3390/")) return [];
  const m = MDPI_DOI_SUFFIX_RE.exec(doi.slice("10.3390/".length));
  if (!m) return [];
  const [, short, vol, , art] = m;
  const art5 = art!.padStart(5, "0");
  const slugs: string[] = [];
  const mapped = MDPI_SHORT_TO_SLUG[short!];
  if (mapped) slugs.push(mapped);
  if (!slugs.includes(short!)) slugs.push(short!);
  return slugs.map((s) => ({
    url: `https://pub.mdpi-res.com/${s}/${s}-${vol}-${art5}/article_deploy/${s}-${vol}-${art5}.pdf`,
    via: "mdpi",
  }));
}

/* ─────────────────────── 第二梯队:要从 Crossref 记录里挖 ─────────────────────── */

interface CrossrefRecord {
  message?: {
    "alternative-id"?: unknown[];
    link?: Array<{ URL?: string; "content-type"?: string }> | null;
    resource?: { primary?: { URL?: string } | null } | null;
  };
}

/** 取一次 Crossref 记录。Elsevier 与 IEEE 都要从里面挖东西,合并成一次请求。 */
async function crossrefRecord(doi: string): Promise<CrossrefRecord["message"] | null> {
  const res = await fetchJson<CrossrefRecord>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  return res.ok ? (res.data?.message ?? null) : null;
}

/**
 * IEEE(`10.1109/`、`10.23919/`)的直链藏在 Crossref 的 `link[]` 里。
 *
 * Crossref 记录里那条 `xplorestaging.ieee.org` 的链接**就是** PDF 直链,只是挂在
 * 一个 staging 域名下;换成 `ieeexplore.ieee.org` 即可。用户的方向(IEEE 会议/
 * 期刊)重头戏在这里,而 IEEE 又是**没有**通用模板可拼的一家 —— 所以这条路很值。
 *
 * 落地页放最后:它是 HTML,只有直链被挡时才有用(至少能人工点进去)。
 */
function ieeeCandidates(msg: NonNullable<CrossrefRecord["message"]>): PdfCandidate[] {
  const out: PdfCandidate[] = [];
  for (const link of msg.link ?? []) {
    const u = link?.URL ?? "";
    if (!u) continue;
    if (u.includes("xplorestaging.ieee.org") && /\.pdf$/i.test(u.split("?")[0]!)) {
      out.push({ url: u.replace(/^https?:\/\/xplorestaging\.ieee\.org\//, "https://ieeexplore.ieee.org/"), via: "ieee" });
    }
  }
  const landing = msg.resource?.primary?.URL;
  if (landing) out.push({ url: landing, via: "ieee-landing" });
  return out;
}

/** Elsevier / Cell Press(`10.1016/`)的直链**拼不出来**,得先拿 PII。
 *  Elsevier 的文章号是 PII(`S…`),和 DOI 后缀没有换算关系 —— 但 Crossref 的
 *  `alternative-id` 里就带着它。 */
function elsevierCandidates(msg: NonNullable<CrossrefRecord["message"]>): PdfCandidate[] {
  const ids = msg["alternative-id"] ?? [];
  const pii = ids.find(
    (x): x is string => typeof x === "string" && x.startsWith("S") && x.length >= 16,
  );
  return pii
    ? [{ url: `https://www.sciencedirect.com/science/article/pii/${pii}/pdfft`, via: "elsevier" }]
    : [];
}

/* ─────────────────────── 第三梯队:开放获取元数据源 ─────────────────────── */

interface OpenalexWork {
  open_access?: { oa_url?: string | null } | null;
  best_oa_location?: { pdf_url?: string | null } | null;
  locations?: Array<{ pdf_url?: string | null } | null> | null;
}

/** OpenAlex:先 best_oa_location,再**所有** locations,最后 open_access.oa_url。
 *  只看 best_oa_location 会漏掉「best 是落地页、第二个才是 PDF」的情况。 */
async function openalexCandidates(doi: string): Promise<PdfCandidate[]> {
  const res = await fetchJson<OpenalexWork>(
    `https://api.openalex.org/works/doi:${encodeURI(doi)}?mailto=${LIBRARY_MAILTO}`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  if (!res.ok || !res.data) return [];
  const d = res.data;
  const urls = [
    d.best_oa_location?.pdf_url,
    ...(d.locations ?? []).map((l) => l?.pdf_url),
    d.open_access?.oa_url,
  ].filter((u): u is string => Boolean(u));
  return dedupe(urls).map((url) => ({ url, via: "openalex" }));
}

interface UnpaywallRecord {
  best_oa_location?: { url_for_pdf?: string | null } | null;
  oa_locations?: Array<{ url_for_pdf?: string | null }> | null;
}

/** Unpaywall:字段比 OpenAlex 全,但**必须**带一个真实邮箱。没配就整条跳过。 */
async function unpaywallCandidates(doi: string): Promise<PdfCandidate[]> {
  if (!UNPAYWALL_EMAIL) return [];
  const res = await fetchJson<UnpaywallRecord>(
    `https://api.unpaywall.org/v2/${encodeURI(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  if (!res.ok || !res.data) return [];
  const d = res.data;
  const urls = [d.best_oa_location?.url_for_pdf, ...(d.oa_locations ?? []).map((l) => l?.url_for_pdf)]
    .filter((u): u is string => Boolean(u));
  return dedupe(urls).map((url) => ({ url, via: "unpaywall" }));
}

interface S2Record {
  openAccessPdf?: { url?: string | null } | null;
  externalIds?: { ArXiv?: string | null; PubMedCentral?: string | null } | null;
}

/** Semantic Scholar 在这里当**桥**用:它的 `externalIds` 能把一个 DOI 反查成
 *  arXiv 编号或 PMC 编号,于是又能多出两个候选(arXiv 直链、PMC 渲染端点)。
 *  这是 paper-fetch 里最巧的一步 —— S2 不只是"另一个 PDF 源"。 */
async function semanticScholarCandidates(doi: string): Promise<PdfCandidate[]> {
  const res = await fetchJson<S2Record>(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf,externalIds`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  if (!res.ok || !res.data) return [];
  const out: PdfCandidate[] = [];
  const direct = res.data.openAccessPdf?.url;
  if (direct) out.push({ url: direct, via: "semantic" });
  const ax = res.data.externalIds?.ArXiv;
  if (ax) out.push({ url: `https://arxiv.org/pdf/${ax}`, via: "semantic→arxiv" });
  const pmc = res.data.externalIds?.PubMedCentral;
  if (pmc) out.push(...pmcRenderCandidates(pmc));
  return out;
}

interface EpmcRecord {
  pmcid?: string;
  fullTextUrlList?: {
    fullTextUrl?: Array<{ documentStyle?: string; availability?: string; url?: string }>;
  };
}

/** Europe PMC:既给 `fullTextUrlList` 里的 PDF,也给 `pmcid` —— 有 pmcid 就能走
 *  PMC 的两个渲染端点(见 pmcRenderCandidates)。生物医学之外它收预印本,也有用。 */
async function europePmcCandidates(doi: string): Promise<PdfCandidate[]> {
  const params = new URLSearchParams({
    query: `DOI:"${doi}"`,
    format: "json",
    resultType: "core",
    pageSize: "1",
  });
  const res = await fetchJson<{ resultList?: { result?: EpmcRecord[] } }>(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  const r = res.ok ? res.data?.resultList?.result?.[0] : undefined;
  if (!r) return [];
  const out: PdfCandidate[] = [];
  const pdfs = (r.fullTextUrlList?.fullTextUrl ?? []).filter(
    (u) => u.documentStyle?.toLowerCase() === "pdf" && u.url,
  );
  // 订阅墙后面的 pdf 链接不算候选 —— 标成"可下载"只会让下载白跑一次
  const open = pdfs.find((u) => !/subscription/i.test(u.availability ?? ""));
  if (open?.url) out.push({ url: open.url, via: "europepmc" });
  if (r.pmcid) out.push(...pmcRenderCandidates(r.pmcid));
  return out;
}

/** 由 PMCID 构造两个渲染端点。
 *
 *  `europepmc.org/articles/<PMCID>?pdf=render` 排在 NCBI 前面不是随意的:NCBI 的
 *  `/pmc/articles/<PMCID>/pdf/` 现在会返回一个带 JavaScript 工作量证明的
 *  cloudpmc-viewer 页面,下载器拿到的是 HTML 而不是 PDF(于是被判成 needs_login)。
 *  Europe PMC 的渲染端点是同一份内容的镜像,**没有**这道拦截。 */
function pmcRenderCandidates(pmcid: string): PdfCandidate[] {
  const id = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
  return [
    { url: `https://europepmc.org/articles/${id}?pdf=render`, via: "pmc-render" },
    { url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${id}/pdf/`, via: "pmc" },
  ];
}

/** OpenAIRE 的嵌套结构是不定形的(同一个字段可能是字符串、对象或数组),
 *  所以按需取"第一个文本载荷"。 */
function openaireFirstText(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = openaireFirstText(item);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ === "string") return obj.$;
    for (const v of Object.values(obj)) {
      const found = openaireFirstText(v);
      if (found) return found;
    }
  }
  return undefined;
}

/** 从 OpenAIRE 记录里收集所有 fulltext / webresource 地址。 */
function openaireCollectUrls(meta: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const ft = openaireFirstText(meta.fulltext);
  if (ft?.startsWith("http")) urls.push(ft);
  const children = (meta.children ?? {}) as Record<string, unknown>;
  for (const key of ["result", "instance"]) {
    const list = children[key];
    for (const item of Array.isArray(list) ? list : []) {
      const inst = (item as Record<string, unknown>)?.instance;
      if (!inst || typeof inst !== "object") continue;
      const wr = (inst as Record<string, unknown>).webresource;
      for (const one of Array.isArray(wr) ? wr : wr ? [wr] : []) {
        const u = openaireFirstText((one as Record<string, unknown>)?.url);
        if (u?.startsWith("http")) urls.push(u);
      }
    }
  }
  return urls;
}

/** OpenAIRE:聚合机构库与预印本库,常常是**付费论文唯一的免费副本**来源。
 *  它给的多是仓库页,所以这里额外做两件事:
 *   ① 从链接里认 arXiv 编号(预印本是最可靠能下的形态);
 *   ② 其余只留「看着像直链」的,并剔掉落地页站点。 */
async function openaireCandidates(doi: string): Promise<PdfCandidate[]> {
  const res = await fetchJson<Record<string, unknown>>(
    `https://api.openaire.eu/search/publications?doi=${encodeURIComponent(doi)}&format=json`,
    { headers: { "User-Agent": LIBRARY_UA } },
  );
  if (!res.ok || !res.data) return [];
  const response = res.data.response as Record<string, unknown> | undefined;
  const results = (response?.results as Record<string, unknown> | undefined)?.result;
  const first = (Array.isArray(results) ? results[0] : undefined) as Record<string, unknown> | undefined;
  const entity = (first?.metadata as Record<string, unknown> | undefined)?.["oaf:entity"];
  const meta = ((entity as Record<string, unknown> | undefined)?.["oaf:result"] ?? {}) as Record<string, unknown>;
  const urls = openaireCollectUrls(meta);

  const out: PdfCandidate[] = [];
  for (const u of urls) {
    const ax =
      /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})/i.exec(u) ??
      /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i.exec(u);
    if (ax) out.push({ url: `https://arxiv.org/pdf/${ax[1]}`, via: "openaire→arxiv" });
  }
  for (const u of urls) {
    let host = "";
    let path = "";
    try {
      const parsed = new URL(u);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname.toLowerCase();
    } catch {
      continue;
    }
    if (LANDING_HOST_MARKERS.some((m) => host.includes(m))) continue;
    if (host.includes("ieeexplore.ieee.org") && path.startsWith("/document")) continue;
    if (LOOKS_LIKE_PDF_RE.test(u)) out.push({ url: u, via: "openaire" });
  }
  return out;
}

/* ─────────────────────────────── 组装 ─────────────────────────────── */

/** 保序去重(同一个直链常常好几个源都给)。 */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const key = u.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 按 DOI 前缀拼出来的候选(**不联网**)。arXiv 之外最便宜的一档。 */
export function publisherPdfCandidates(doi: string): PdfCandidate[] {
  const d = doi.trim();
  const mdpi = mdpiPdfCandidates(d);
  if (mdpi.length > 0) return mdpi;
  for (const [prefix, label, build] of PUBLISHER_PDF_TEMPLATES) {
    if (d.startsWith(prefix)) return [{ url: build(d, d.slice(prefix.length)), via: label }];
  }
  return [];
}

/**
 * 解析一个 DOI 的所有可下载候选,按**"能不能下成"**排序。
 *
 * 顺序不是按"哪个更权威",而是按**实测的成败率**:
 *
 *   ① **arXiv** —— 由 DOI 直接拼,没有反爬,稳;
 *   ② 其余开放获取元数据源(OpenAlex / Unpaywall / Europe PMC / Semantic Scholar /
 *      OpenAIRE)—— 同样是不需要登录的副本;
 *   ③ 从 Crossref 记录里挖出来的(Elsevier PII / IEEE);
 *   ④ **出版商直链模板** —— 放最后,见下;
 *   ⑤ 落地页 —— 根本下不了,只在前面全败时留个"人工点得进去"的念想。
 *
 * ## 为什么出版商模板排到后面
 *
 * 它原来排在很前面(秒出、看起来最"聪明"),但实测它**几乎必定卡住**:
 * Nature / Wiley / ScienceDirect / TechRxiv 这些站点现在都有 **Cloudflare 之类的
 * 人机检测**,而且 PDF 是**内联打开**的(没有下载按钮,人要"打印"才存得下来)。
 * 结果:`session.downloadURL()` 在这种地址上要么挂到超时、要么被 0 字节中断。
 *
 * 而队列是**串行**的,所以把注定卡住的候选排前面 = 让后面所有任务陪着等。
 * 实测一条 2.4MB 的开放获取 PDF **0.5 秒**下完,而一个挂住的出版商地址能耗掉
 * 20 秒 × 好几个候选。先拿能拿的,再试难的。
 */
export async function resolvePdfCandidates(doi: string): Promise<PdfCandidate[]> {
  const d = doi.trim();
  if (!d) return [];

  const arxivId = arxivIdFromDoi(d);
  const fromArxiv: PdfCandidate[] = arxivId
    ? [{ url: `https://arxiv.org/pdf/${arxivId}`, via: "arxiv" }]
    : [];

  // Elsevier 与 IEEE 的直链要先读一次 Crossref 记录 —— 合并成一次请求。
  const needsCrossref = d.startsWith("10.1016/") || d.startsWith("10.1109/") || d.startsWith("10.23919/");
  const crossrefTask = needsCrossref
    ? crossrefRecord(d).then((msg) => {
        if (!msg) return [] as PdfCandidate[];
        return d.startsWith("10.1016/") ? elsevierCandidates(msg) : ieeeCandidates(msg);
      })
    : Promise.resolve([] as PdfCandidate[]);

  // 各自独立,并行跑;`allSettled` 保证一个源挂了不影响其余。
  const settled = await Promise.allSettled([
    crossrefTask,
    openalexCandidates(d),
    unpaywallCandidates(d),
    europePmcCandidates(d),
    semanticScholarCandidates(d),
    openaireCandidates(d),
  ]);
  const [crossrefResult, ...oaResults] = settled;
  const fromCrossref = crossrefResult?.status === "fulfilled" ? crossrefResult.value : [];
  const fromOa = oaResults.flatMap((s) => (s.status === "fulfilled" ? s.value : []));

  const tiers: PdfCandidate[][] = [
    fromArxiv, // ① 稳
    fromOa, // ② 开放获取副本
    fromCrossref, // ③ 要机构订阅,但至少不卡
    publisherPdfCandidates(d), // ④ 大概率卡在人机检测上
  ];
  const all = tiers.flat();
  // 落地页(doi.org、ieeexplore 的 document 页…)排最后 —— 它们下不了,但留着
  // 当最后一根稻草:用户至少能在那页上手动点开。
  const allOrdered = [
    ...all.filter((c) => LOOKS_LIKE_PDF_RE.test(c.url)),
    ...all.filter((c) => !LOOKS_LIKE_PDF_RE.test(c.url)),
  ];

  const ordered = dedupe(allOrdered.map((c) => c.url));
  // dedupe 丢了 via,按 url 回填(第一个给出该地址的源)
  const viaOf = new Map<string, string>();
  for (const c of allOrdered) if (!viaOf.has(c.url)) viaOf.set(c.url, c.via);
  return ordered.slice(0, MAX_CANDIDATES).map((url) => ({ url, via: viaOf.get(url) ?? "unknown" }));
}
