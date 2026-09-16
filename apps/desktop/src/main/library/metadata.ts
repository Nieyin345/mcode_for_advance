/**
 * 元数据解析与外部检索。
 *
 * ## 数据源选型
 *
 * 只依赖**无需密钥**的源,这样开箱可用:
 *   - DOI      → Crossref(`api.crossref.org`,无密钥,礼貌池靠 User-Agent 里的 mailto)
 *                Crossref 查不到时回退 **doi.org 内容协商** —— 中文文献的 DOI 大多
 *                注册在 ISTIC / CNKI 名下,Crossref 看不见它们(见 fetchByDoi)。
 *   - arXiv ID → arXiv Atom API(`export.arxiv.org`,无密钥)
 *   - 关键词   → Crossref / arXiv / OpenAlex / Semantic Scholar / Europe PMC
 *
 * OpenAlex 与 Semantic Scholar 都**不需要 key 也能用**,只是额度更紧;配了
 * `OPENALEX_API_KEY` / `S2_API_KEY` 环境变量就自动用上(前者 10 倍额度,后者 10 倍速率)。
 * 没有 key 时两源都按"失败即静默跳过"处理,绝不让一个源拖垮整次检索。
 *
 * 所有这些调用都走 `http.ts` 的 curl-优先策略 —— undici 的 fetch 不读代理环境变量。
 */
import type { LibraryAuthor, ExternalSearchResult } from "@contracts/library";
import { spawn } from "node:child_process";
import { fetchJson, LIBRARY_MAILTO, LIBRARY_UA } from "./http.js";
import { resolvePdfCandidates } from "./oaResolvers.js";

/** 对外请求的身份(UA 里带礼貌池邮箱)定义在 `http.ts`,与 `oaResolvers.ts` 共用。 */
const CROSSREF_MAILTO = LIBRARY_MAILTO;
const UA = LIBRARY_UA;

/** 可选的免费 key。配了就用,没配照常跑 —— 两源都不强制要密钥。 */
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY?.trim() || "";
const S2_API_KEY = process.env.S2_API_KEY?.trim() || "";

/** 各源共用的解析结果。刻意与 `LibraryItem` 解耦 —— 这里只产出「元数据」,
 *  入库策略(查重/只补空字段)由 repo 决定。 */
export interface ResolvedMetadata {
  doi?: string;
  arxivId?: string;
  title?: string;
  authors?: LibraryAuthor[];
  year?: number;
  venue?: string;
  /** 卷 / 期 / 页码 / 出版商 —— 引用格式(GB/T 7714、APA、BibTeX)要用。
   *  arXiv 不给这几个字段(预印本本来就没有卷期),所以都是可选的。 */
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  abstract?: string;
  url?: string;
  source: string;
}

/* ────────────────────────────── Crossref ───────────────────────────── */

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  /** `issued` 是规范字段,但**不少记录没有它** —— 老的印刷版期刊、部分会议记录
   *  只填了这两个。缺失时不回退就会得到一条「没有年份」的条目(而且年份是
   *  期刊分区/时间范围过滤的依据,缺了会连带影响筛选)。 */
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  abstract?: string;
  URL?: string;
  type?: string;
  /** 被引数。判断一篇重不重要最直接的免费信号,而且这里**不用额外请求**。 */
  "is-referenced-by-count"?: number;
}

/** 取 Crossref 记录里的出版年,按 `issued → published-print → published-online`
 *  依次回退(协议文档给的规范顺序)。 */
function crossrefYear(w: CrossrefWork): number | undefined {
  for (const key of ["issued", "published-print", "published-online"] as const) {
    const y = w[key]?.["date-parts"]?.[0]?.[0];
    if (typeof y === "number") return y;
  }
  return undefined;
}

/** 引用格式要用的那四个字段,三个源里只有 Crossref 给得全。
 *  抽出来是因为 fetchByDoi 与 searchCrossref 两条路都要映射同一批字段。 */
function crossrefExtras(w: CrossrefWork): Pick<
  ResolvedMetadata,
  "volume" | "issue" | "page" | "publisher"
> {
  return {
    volume: w.volume || undefined,
    issue: w.issue || undefined,
    page: w.page || undefined,
    publisher: w.publisher || undefined,
  };
}

/** 把 Crossref 的作者数组转成 CSL 风格。
 *  机构作者在 Crossref 里只有 `name`(没有 given/family),落到 `literal`。 */
function crossrefAuthors(work: CrossrefWork): LibraryAuthor[] {
  return (work.author ?? []).map((a) => {
    if (a.name && !a.family && !a.given) return { literal: a.name };
    return { given: a.given ?? undefined, family: a.family ?? undefined };
  });
}

/** Crossref 的摘要带 JATS 标签(`<jats:p>`),剥掉才是一段可读文本。 */
function stripJats(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** CSL JSON(doi.org 内容协商返回的引用格式)。字段比 Crossref 更宽松 ——
 *  `title` 可能是字符串也可能是单元素数组,作者常常整段塞在 `literal` 里。 */
interface CslItem {
  DOI?: string;
  title?: string | string[];
  author?: Array<{ given?: string; family?: string; literal?: string }>;
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string | string[];
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  abstract?: string;
}

/** 把可能是「字符串 or 单元素数组」的 CSL 字段归一成一个字符串。 */
function cslText(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

/**
 * 通过 **doi.org 的内容协商**取元数据 —— 给**中文文献**准备的那条路。
 *
 * `api.crossref.org` 不是"DOI 系统",它只是**一个注册机构(RA)**。中文期刊的 DOI
 * 大多注册在 **ISTIC** 或 **CNKI** 名下,Crossref 对它们一律 404,而同一个 DOI 在
 * `doi.org` 上解析得好好的。少了这条路,用户粘一个中文期刊的 DOI 进来只会得到
 * 「查不到」—— 条目只剩一个光秃秃的 DOI,标题/作者/年份/期刊全空,下载也必然失败。
 *
 * doi.org 按 `Accept` 头返回不同引用格式,`csl+json` 是唯一结构化的那个。免费、无密钥。
 *
 * 校验只要求「是 JSON 且标题非空」:CNKI 那类 DOI 会 302 到第三方站点(实测见过
 * 明文 HTTP + 裸 IP 的跳转),内容可靠性不由我们判断 —— 解析不出标题就当没查到,
 * 宁可留空让用户补,也不把莫名其妙的字段写进库。
 */
async function fetchByDoiViaContentNegotiation(doi: string): Promise<ResolvedMetadata | null> {
  const res = await fetchJson<CslItem>(`https://doi.org/${encodeURI(doi)}`, {
    headers: { "User-Agent": UA },
    accept: "application/vnd.citationstyles.csl+json",
    // ⚠️ 单独给一个**短**超时。这条路只在 Crossref 查不到时才走,而它恰好也是
    // 最容易挂的那条:ISTIC/CNKI 注册的 DOI 会被 doi.org 转发到第三方站点,实测
    // 在本机网络下**一个字节都不回**,一直挂到超时为止。默认的 30 秒会让每次导入
    // 这种 DOI 都白等半分钟 —— 而这个调用只是"多试一下",不值得那个代价。
    timeoutMs: 10_000,
  });
  if (!res.ok || !res.data) return null;
  const c = res.data;
  const title = cslText(c.title);
  if (!title) return null;
  const year = c.issued?.["date-parts"]?.[0]?.[0];
  return {
    doi: c.DOI ?? doi,
    title,
    authors: (c.author ?? []).map((a) =>
      a.literal && !a.family && !a.given
        ? { literal: a.literal }
        : { given: a.given ?? undefined, family: a.family ?? undefined },
    ),
    year: typeof year === "number" ? year : undefined,
    venue: cslText(c["container-title"]),
    volume: c.volume || undefined,
    issue: c.issue || undefined,
    page: c.page || undefined,
    publisher: c.publisher || undefined,
    abstract: c.abstract ?? undefined,
    source: "doi.org",
  };
}

export async function fetchByDoi(doi: string): Promise<ResolvedMetadata | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetchJson<{ message?: CrossrefWork }>(url, { headers: { "User-Agent": UA } });
  const w = res.ok ? res.data?.message : undefined;

  if (w) {
    return {
      doi: w.DOI,
      title: w.title?.[0],
      authors: crossrefAuthors(w),
      year: crossrefYear(w),
      venue: w["container-title"]?.[0],
      ...crossrefExtras(w),
      abstract: stripJats(w.abstract),
      url: w.URL,
      source: "crossref",
    };
  }

  // Crossref 查不到**不等于**这个 DOI 不存在 —— 见上面那条注释:它可能只是注册在
  // 别的机构(ISTIC / CNKI)。所以再去 doi.org 问一次。
  return fetchByDoiViaContentNegotiation(doi);
}

/* ─────────────────────────────── arXiv ─────────────────────────────── */

/** 从 Atom XML 里取一个标签的文本。arXiv 的 Atom 结构极稳定,且我们只取几个
 *  叶子节点 —— 引一个 XML 解析库不值得(还多一个依赖)。 */
function atomTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, " ").trim() : undefined;
}

/** 取**全部**同名标签(作者有多个)。 */
function atomTags(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function parseArxivEntry(entry: string): ResolvedMetadata {
  // 作者形如 <author><name>Jane Doe</name></author>
  const authors: LibraryAuthor[] = atomTags(entry, "author").map((a) => {
    const name = atomTag(a, "name") ?? "";
    // arXiv 不给姓/名切分;西文名按最后一个空格切,中日韩整体存 literal
    const isCjk = /[㐀-鿿぀-ヿ가-힯]/.test(name);
    if (isCjk || !name.includes(" ")) return { literal: name };
    const idx = name.lastIndexOf(" ");
    return { given: name.slice(0, idx), family: name.slice(idx + 1) };
  });

  const published = atomTag(entry, "published");
  const year = published ? Number(published.slice(0, 4)) : undefined;

  return {
    arxivId: atomTag(entry, "id")?.match(/abs\/(.+?)(v\d+)?$/)?.[1],
    title: atomTag(entry, "title"),
    authors,
    year: Number.isFinite(year) ? year : undefined,
    // arXiv 没有期刊名,但 comment 里常写会议/期刊信息;这里不臆测,留空
    abstract: atomTag(entry, "summary"),
    url: atomTag(entry, "id"),
    source: "arxiv",
  };
}

export async function fetchByArxivId(arxivId: string): Promise<ResolvedMetadata | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  // arXiv 只提供 Atom XML,没有 JSON 端点 —— 所以走 fetchText 取原文自行解析,
  // 不能走 fetchJson。
  const text = await fetchText(url);
  if (!text) return null;
  const entry = text.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const parsed = parseArxivEntry(entry);
  // arXiv 对不存在的 id 会返回一个空 entry;标题为空即视为未命中
  return parsed.title ? parsed : null;
}

/* ───────────────────────────── 纯文本取数 ──────────────────────────── */

/** 用与 fetchJson 相同的 curl-优先策略取纯文本(arXiv 的 Atom、BibTeX 等)。
 *  失败返回 null —— 调用方按「源不可用」处理,不视为致命错误。 */
export async function fetchText(url: string): Promise<string | null> {
  // 与 http.ts 的 fetchJson 同策略(curl 优先、代理被拒时剥代理重试),
  // 区别只是要原文而不是解析后的 JSON —— arXiv 的 Atom、BibTeX 端点都要原文。
  const runCurl = (stripProxy: boolean) =>
    new Promise<{ ok: boolean; out: string; err: string }>((resolve) => {
      let env = process.env;
      if (stripProxy) {
        env = { ...process.env };
        for (const k of Object.keys(env)) {
          if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k];
        }
      }
      const child = spawn(
        "curl",
        ["-sSL", "--fail-with-body", "--max-time", "30", "-H", `User-Agent: ${UA}`, url],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (r: { ok: boolean; out: string; err: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, out: "", err: "超时" });
      }, 35_000);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", () => finish({ ok: false, out: "", err: "curl 无法启动" }));
      child.on("close", (code) =>
        finish({
          ok: code === 0,
          out: Buffer.concat(out).toString("utf8"),
          err: Buffer.concat(err).toString("utf8"),
        }),
      );
    });

  let r = await runCurl(false);
  if (!r.ok && /Failed to connect to (?:127\.0\.0\.1|localhost)/i.test(r.err)) {
    r = await runCurl(true);
  }
  return r.ok && r.out ? r.out : null;
}

/* ──────────────────────────── 外部检索 ─────────────────────────────── */

interface CrossrefSearchResponse {
  message?: { items?: CrossrefWork[] };
}

/**
 * 单源的墙钟上限。
 *
 * 搜索是交互式的,而 `Promise.allSettled` 等的是**最慢**的那个 —— 一个源卡住,
 * 整次检索就陪着等。实测 OpenAlex 偶发 504 会一路拖到 curl 的 30 秒超时,而
 * arXiv 更糟:它在空结果后会重试一次,最坏是「两个 30 秒 + 3 秒等待」。
 *
 * 但**不能为了快就把源砍掉** —— 用户的诉求是"抓得到文献",少一个源就是实打实的
 * 召回损失。所以这里给的是一个**宽容的上限**:只掐掉病态的长尾,正常的慢源
 * (实测 1~10 秒)照常等到。
 */
const SOURCE_DEADLINE_MS = 20_000;

/** 给一个源的请求套上截止时间。按时返回用它自己的结果,超时/抛错都退化成空数组。 */
function withDeadline<T>(p: Promise<T[]>, ms: number): Promise<T[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve([]);
      },
    );
  });
}

/** 多源关键词检索。返回候选,不入库 —— 挑选是用户或 AI 的事。 */
export async function searchExternal(input: {
  query: string;
  sources?: Array<"arxiv" | "crossref" | "openalex" | "europepmc" | "semantic">;
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
}): Promise<ExternalSearchResult[]> {
  const sources = input.sources?.length
    ? input.sources
    : (["crossref", "arxiv", "openalex", "europepmc", "semantic"] as const);
  const limit = input.limit ?? 20;
  const tasks: Array<Promise<ExternalSearchResult[]>> = [];

  for (const source of sources) {
    if (source === "crossref") {
      tasks.push(withDeadline(searchCrossref(input.query, limit, input.yearFrom, input.yearTo), SOURCE_DEADLINE_MS));
    } else if (source === "arxiv") {
      tasks.push(withDeadline(searchArxiv(input.query, limit), SOURCE_DEADLINE_MS));
    } else if (source === "openalex") {
      tasks.push(withDeadline(searchOpenalex(input.query, limit, input.yearFrom, input.yearTo), SOURCE_DEADLINE_MS));
    } else if (source === "europepmc") {
      tasks.push(withDeadline(searchEuropePmc(input.query, limit, input.yearFrom, input.yearTo), SOURCE_DEADLINE_MS));
    } else if (source === "semantic") {
      tasks.push(withDeadline(searchSemanticScholar(input.query, limit), SOURCE_DEADLINE_MS));
    }
  }

  const settled = await Promise.allSettled(tasks);
  // 每个源各自一批,顺序与 sources 一致;失败的那个是空数组。
  const perSource: ExternalSearchResult[][] = settled.map((s) =>
    s.status === "fulfilled" ? s.value : [],
  );

  // 跨源去重:DOI 优先,其次标题(小写去标点)
  const seen = new Set<string>();
  const out: ExternalSearchResult[] = [];
  // `limit` 是**每源**多少条(界面上的「每源条数」就是这个),所以总量上限是它乘源数。
  const cap = limit * sources.length;

  /*
   * **轮流取**,不是把各源拼成一个大数组再从头上截。
   *
   * 老写法是 `merged = [源1的全部, 源2的全部, ...]` 然后 `if (out.length >= limit) break`
   * —— 第一个源(Crossref)自己就凑够了 limit 条,后面几个源**一条都进不来**。
   * 于是"多加几个源"完全不起作用,表现就是「抓不到文献」:换了源、看起来还是只从一个
   * 地方找,而且找到的都是同一个源排在最前面的那几条。
   *
   * 轮流取之后,列表头部天然是几个源的混合 —— 用户翻前几条看到的是各源的好东西,
   * 而不是某个源的一整页。
   */
  for (let rank = 0; rank < limit; rank++) {
    for (const list of perSource) {
      const r = list[rank];
      if (!r) continue;
      const key = r.doi
        ? `doi:${r.doi.toLowerCase()}`
        : `t:${(r.title ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * 把「概念块 AND/OR」写法的检索式翻成 **arXiv 自己的语法**。
 *
 * arXiv 的 `search_query` 只认 `all:` / `ti:` / `abs:` 这类字段前缀加 `AND`/`OR`/
 * `ANDNOT`,**不支持括号分组**。而我们在提示词里教模型写的是 `(a OR b) AND (c OR d)`
 * —— 那一串直接丢给 arXiv 会**一条都匹配不到**(实测过:同样的词,arXiv 返回 0 条,
 * 而 Crossref 返回 20 条)。所以这里做一次降级翻译。
 *
 * 策略:先把括号里的分组**整个丢掉**,只取最外层 AND 链上的短语 —— 那些才是这篇的
 * 概念核心。用户那句
 *   `"Fourier neural operator" AND (metasurface OR "meta-surface") AND ("field distribution" OR "field prediction")`
 * 会翻成 `all:"Fourier neural operator"`。这是**故意放宽**的:arXiv 在整条链里只是
 * 补充源(预印本),宁可多给几条让用户和模型自己筛,也不要因为翻不精确而一条不给。
 *
 * 外层一个短语都没有时,退而取括号里的短语 OR 起来 —— 总比空手而归强。
 */
function toArxivQuery(query: string): string {
  const stripGroups = (s: string) => {
    // 逐层剥掉最内层的括号,直到没有括号为止
    let prev = s;
    for (let i = 0; i < 10; i++) {
      const next = prev.replace(/\([^()]*\)/g, " ");
      if (next === prev) break;
      prev = next;
    }
    return prev;
  };

  const phrases = (s: string) =>
    [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean);

  const outer = phrases(stripGroups(query));
  const all = phrases(query);
  const picked = outer.length > 0 ? outer : all;
  if (picked.length > 0) {
    return picked.map((p) => `all:"${p}"`).join(" AND ");
  }

  // 一个引号都没有:取 AND/OR 之外的前三个实词
  const words = stripGroups(query)
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((w) => w && !/^(and|or|not|andnot)$/i.test(w));
  return words
    .slice(0, 3)
    .map((w) => `all:${w}`)
    .join(" AND ");
}

async function searchCrossref(
  query: string,
  limit: number,
  yearFrom?: number,
  yearTo?: number,
): Promise<ExternalSearchResult[]> {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: String(limit),
    // `select` 里必须带上 `published-print` / `published-online`:年份的规范字段
    // `issued` 在不少记录上是空的,回退靠的就是这两个(见 crossrefYear)。
    select:
      "DOI,title,author,issued,published-print,published-online,container-title,volume,issue,page,publisher,abstract,URL,is-referenced-by-count",
  });
  if (yearFrom || yearTo) {
    params.set("filter", `from-pub-date:${yearFrom ?? 1000}-01-01,until-pub-date:${yearTo ?? 2999}-12-31`);
  }
  const res = await fetchJson<CrossrefSearchResponse>(
    `https://api.crossref.org/works?${params.toString()}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) return [];
  return (res.data?.message?.items ?? []).map((w) => ({
    source: "crossref" as const,
    doi: w.DOI,
    title: w.title?.[0] ?? "(无标题)",
    authors: crossrefAuthors(w),
    year: crossrefYear(w),
    venue: w["container-title"]?.[0],
    ...crossrefExtras(w),
    abstract: stripJats(w.abstract),
    citationCount: w["is-referenced-by-count"] ?? undefined,
    url: w.URL,
  }));
}

/* ──────────────────────── Semantic Scholar ────────────────────────
 *
 * 为什么再加这一源:Crossref 只收注册了 DOI 的正式出版物,arXiv 只有预印本,OpenAlex
 * 覆盖广但对**会议论文**的收录不如它。而计算机/通信这一类研究方向,重头戏恰恰在会议
 * (INFOCOM / ICC / GLOBECOM / NeurIPS…),只靠前三个源会成片地漏。
 *
 * 它还额外给三样很有用的东西:
 *   - **摘要**(比 OpenAlex 稳,不依赖出版社授权);
 *   - **被引数** —— 判断一篇重不重要最直接的信号;
 *   - **开放获取 PDF 直链** —— 决定这篇能不能自动下载。
 *
 * ⚠️ 免费额度很紧(约 1 请求/秒,无 key 时容易 429)。所以它**失败就静默返回空**,
 * 绝不因为一个源被限流就让整次检索失败 —— 其余几个源的结果照常返回。
 */

interface S2Paper {
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  authors?: Array<{ name?: string | null }> | null;
  citationCount?: number | null;
  externalIds?: { DOI?: string | null; ArXiv?: string | null } | null;
  openAccessPdf?: { url?: string | null } | null;
}

async function searchSemanticScholar(query: string, limit: number): Promise<ExternalSearchResult[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: "title,abstract,year,venue,authors,citationCount,externalIds,openAccessPdf",
  });
  // key 走**请求头** `x-api-key`,不是查询参数。无 key 时是 1 req/s 的共享池,
  // 很容易 429;有 key 是 10 req/s。所以配了就用,没配照常降级。
  const headers: Record<string, string> = { "User-Agent": UA };
  if (S2_API_KEY) headers["x-api-key"] = S2_API_KEY;
  const res = await fetchJson<{ data?: S2Paper[] }>(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`,
    { headers },
  );
  // 429(限流)与网络失败都走这里 —— 静默降级,不拖垮整次检索
  if (!res.ok) return [];

  return (res.data?.data ?? [])
    .map((p): ExternalSearchResult | null => {
      if (!p.title) return null;
      const pdf = p.openAccessPdf?.url ?? undefined;
      const doi = p.externalIds?.DOI ?? undefined;
      return {
        source: "semantic" as const,
        doi: doi || undefined,
        arxivId: p.externalIds?.ArXiv ?? undefined,
        title: p.title,
        authors: (p.authors ?? [])
          .map((a) => a?.name)
          .filter((n): n is string => Boolean(n))
          .map((n) => ({ literal: n })),
        year: p.year ?? undefined,
        venue: p.venue ?? undefined,
        abstract: p.abstract ?? undefined,
        citationCount: p.citationCount ?? undefined,
        hasOpenAccessPdf: Boolean(pdf),
        url: pdf ?? (doi ? `https://doi.org/${doi}` : undefined),
      };
    })
    .filter((r): r is ExternalSearchResult => r !== null);
}

async function searchArxiv(query: string, limit: number): Promise<ExternalSearchResult[]> {
  // arXiv 不认括号分组,也不认 Crossref 那套写法 —— 先翻译(见 toArxivQuery)。
  const arxivQuery = toArxivQuery(query);
  if (!arxivQuery) return [];
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(
    arxivQuery,
  )}&max_results=${limit}`;
  // arXiv 的限流很紧(约 3 秒一次),用户连着搜两遍就会吃到 429 —— 而 429 的响应里
  // 没有 <entry>,表现就是「这个源永远抓不到东西」。所以失败/空结果时**等一会儿重试
  // 一次**:对用户是几秒钟的事,少一个源却是实打实的召回损失。
  let entries: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await fetchText(url);
    entries = text?.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    if (entries.length > 0) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  if (entries.length === 0) return [];
  return entries.map((e) => {
    const m = parseArxivEntry(e);
    return {
      source: "arxiv" as const,
      arxivId: m.arxivId,
      title: m.title ?? "(无标题)",
      authors: m.authors ?? [],
      year: m.year,
      abstract: m.abstract,
      url: m.url,
      // arXiv 的条目天然有 PDF —— 让用户优先看到能直接下的
      hasOpenAccessPdf: true,
    };
  });
}

/* ──────────────────────────── Europe PMC ────────────────────────────
 *
 * 为什么加这一源:一份索引同时覆盖 PubMed + PMC + 预印本(bioRxiv/medRxiv 也在
 * 里面),**完全不需要密钥**,并且直接给**被引数**和开放获取直链。生物医学是它的
 * 主场,但物理/工程/计算类也收了不少,而且它把预印本和正式版放在同一个索引里,
 * 这点比 arXiv 单干要全。
 *
 * 这个源本来就在 searchExternal 的 sources 类型里声明着,却一直没有实现 ——
 * 调用方勾了它只会被静默跳过,表现为「勾了五个源还是只有四个源的结果」。
 *
 * ⚠️ 两个坑:`isOpenAccess` / `hasPDF` 是 **"Y"/"N" 字符串**,不是布尔值
 * (直接拿来做真值判断的话 "N" 也是真);PDF 直链要从 fullTextUrlList 里按
 * `documentStyle == "pdf"` 挑,且要避开 `availability: "Subscription"` 那些。
 */

/** Europe PMC 的检索式语法支持 AND/OR/NOT 与括号,并被支持短语引号 ——
 *  我们的 `(a OR b) AND ("c" OR "d")` 可以直接透传,不需要像 arXiv 那样降级翻译。 */
interface EpmcResult {
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  citedByCount?: number;
  isOpenAccess?: string;
  hasPDF?: string;
  fullTextUrlList?: {
    fullTextUrl?: Array<{ documentStyle?: string; availability?: string; url?: string }>;
  };
}

/** 从 fullTextUrlList 里挑一个**真正开放**的 PDF 直链。挑不到返回 undefined ——
 *  把订阅墙后面的 pdf 链接标成"可下载"会让下载那步白跑一次。 */
function epmcPdfUrl(r: EpmcResult): string | undefined {
  const pdfs = (r.fullTextUrlList?.fullTextUrl ?? []).filter(
    (u) => u.documentStyle?.toLowerCase() === "pdf" && u.url,
  );
  const open = pdfs.find((u) => !/subscription/i.test(u.availability ?? ""));
  return (open ?? (r.isOpenAccess === "Y" ? pdfs[0] : undefined))?.url;
}

async function searchEuropePmc(
  query: string,
  limit: number,
  yearFrom?: number,
  yearTo?: number,
): Promise<ExternalSearchResult[]> {
  // 年份用 Europe PMC 自己的字段检索语法,不是独立的 filter 参数。
  let q = query;
  if (yearFrom || yearTo) {
    q = `(${q}) AND PUB_YEAR:[${yearFrom ?? 1000} TO ${yearTo ?? 2999}]`;
  }
  const params = new URLSearchParams({
    query: q,
    format: "json",
    // core 才带 fullTextUrlList / citedByCount;默认的 lite 没有这两样
    resultType: "core",
    pageSize: String(limit),
  });
  const res = await fetchJson<{ resultList?: { result?: EpmcResult[] } }>(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`,
    { headers: { "User-Agent": UA } },
  );
  // 无密钥共享池,偶尔会被限流 —— 静默跳过,其余源照常返回
  if (!res.ok) return [];

  return (res.data?.resultList?.result ?? [])
    .map((r): ExternalSearchResult | null => {
      if (!r.title) return null;
      const pdf = epmcPdfUrl(r);
      const year = r.pubYear ? Number(r.pubYear) : undefined;
      return {
        source: "europepmc" as const,
        doi: r.doi || undefined,
        title: r.title.replace(/\.$/, ""),
        // authorString 是 "Smith J, Doe A" 形式 —— **姓在前**,与 arXiv 的
        // "Jane Doe" 恰好相反,所以不能套用那边的切分启发式,整体存 literal。
        authors: (r.authorString ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => ({ literal: s })),
        year: Number.isFinite(year) ? year : undefined,
        venue: r.journalTitle || undefined,
        abstract: r.abstractText || undefined,
        citationCount: r.citedByCount ?? undefined,
        hasOpenAccessPdf: Boolean(pdf),
        url: pdf ?? (r.doi ? `https://doi.org/${r.doi}` : undefined),
      };
    })
    .filter((r): r is ExternalSearchResult => r !== null);
}

/* ──────────────────── 从 DOI 里认出 arXiv / 找 OA 直链 ──────────────────── */

/**
 * 从 DOI 里认出 arXiv。
 *
 * arXiv 给每篇预印本注册的 DOI 形如 `10.48550/arXiv.2302.01934` —— 它**就是** arXiv
 * 上的那一篇。检索结果里这种很多(OpenAlex 与 Semantic Scholar 常常只给 DOI、不给
 * arxivId),不认它有两个后果:
 *   ① 和「以 arxivId 入库的同一条」变成两条重复记录;
 *   ② 下载器看不出这是 arXiv,只好去 doi.org 的落地页 —— 那是网页不是 PDF,下不了。
 * (实测:用户的检索结果里就同时出现了 `arxiv:2302.01934` 和 `10.48550/arxiv.2302.01934`
 * 两条,一条超时、一条报"缺少 arXiv ID"。)
 */
/* ───────────────────────── 找 PDF 直链 ─────────────────────────
 *
 * 整条多源解析链(`arxivIdFromDoi` / 出版商直链模板 / OpenAlex / Unpaywall /
 * Europe PMC / Semantic Scholar / OpenAIRE)都在 `oaResolvers.ts` —— 它与
 * "检索"是两件事,这里只留一个入口给导入流程用。 */

/**
 * 按 DOI 找 PDF 直链(第一个候选)。找不到返回 null —— 那只是"这一篇没有现成的
 * 公开版本",不是错误。
 *
 * 为什么需要它:检索和导入拿到的 `url` 大多是 `https://doi.org/...` —— 那是**落地页**,
 * 不是 PDF。而下载器只认 PDF 直链,于是表现成「导入成功了,但全都下载失败」。
 *
 * ⚠️ 返回的地址**不保证能下**(出版商那条要订阅)。真正下载的是内嵌浏览器那个会话
 * (见 `downloadViaBrowser`),用户登录过机构账号时 cookie 就在里面 —— 那时这类直链
 * 往往是能下的。下载器还会拿**整张候选表**逐个试到通过校验为止(见 downloader.ts),
 * 这里只取第一个是因为导入流程只需要一个"这页能下吗"的信号。
 */
export async function findOpenAccessPdfUrl(doi: string): Promise<string | null> {
  const candidates = await resolvePdfCandidates(doi);
  return candidates[0]?.url ?? null;
}

/* ─────────────────────────── OpenAlex ───────────────────────────
 *
 * 为什么加这一源:它覆盖最广(2.5 亿+ 作品,含期刊、会议、预印本、学位论文),
 * **免费且不需要 key**,而且同时给出 DOI、开放获取 PDF、被引数 —— 前两项正是
 * 「检索 → 入库 → 下载」整条链要的东西。Crossref 只覆盖注册了 DOI 的正式出版物,
 * arXiv 只有预印本,两个合起来仍然漏掉相当一部分会议论文。
 *
 * 礼貌池:`mailto=` 不是必须的,但带上能把限速放宽(与 Crossref 用的同一个邮箱)。
 */

interface OpenalexWork {
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null }> | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  biblio?: {
    volume?: string | null;
    issue?: string | null;
    first_page?: string | null;
    last_page?: string | null;
  } | null;
  /** 摘要是**倒排索引**(词 → 位置数组),不是原文。要自己拼回去。 */
  abstract_inverted_index?: Record<string, number[]> | null;
  open_access?: { is_oa?: boolean | null; oa_url?: string | null } | null;
  best_oa_location?: { pdf_url?: string | null } | null;
}

/** 倒排索引 → 摘要原文。OpenAlex 为了省体积才这么存。 */
function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined;
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) slots.push([p, word]);
  }
  if (slots.length === 0) return undefined;
  slots.sort((a, b) => a[0] - b[0]);
  return slots.map(([, w]) => w).join(" ");
}

async function searchOpenalex(
  query: string,
  limit: number,
  yearFrom?: number,
  yearTo?: number,
): Promise<ExternalSearchResult[]> {
  const params = new URLSearchParams({
    search: query,
    // ⚠️ 是 `per-page`(连字符),不是 `per_page` —— 写错不会报错,会被静默忽略。
    "per-page": String(limit),
    mailto: CROSSREF_MAILTO,
  });
  // 免费 key 有 10 倍额度。带了就是带认证的那一档,不带照常跑。
  if (OPENALEX_API_KEY) params.set("api_key", OPENALEX_API_KEY);
  const filters: string[] = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));

  const res = await fetchJson<{ results?: OpenalexWork[] }>(
    `https://api.openalex.org/works?${params.toString()}`,
    { headers: { "User-Agent": UA } },
  );
  // 429 分两种:额度用尽(要等隔天 UTC 零点,重试没有意义)与瞬时突发限制。
  // 两种都不在这里重试 —— 一个源被限流不该拖慢另外四个源,静默降级即可。
  if (!res.ok) return [];

  return (res.data?.results ?? [])
    .map((w): ExternalSearchResult | null => {
      const title = w.display_name ?? w.title;
      if (!title) return null;
      // OpenAlex 的 DOI 是完整 URL 形式,库里存的是裸 DOI
      const doi = w.doi?.replace(/^https?:\/\/doi\.org\//i, "");
      const biblio = w.biblio;
      const page =
        biblio?.first_page && biblio?.last_page
          ? `${biblio.first_page}-${biblio.last_page}`
          : (biblio?.first_page ?? undefined);
      const oa = w.best_oa_location?.pdf_url ?? (w.open_access?.is_oa ? w.open_access.oa_url : null);
      return {
        source: "openalex" as const,
        doi: doi || undefined,
        title,
        authors: (w.authorships ?? [])
          .map((a) => a?.author?.display_name)
          .filter((n): n is string => Boolean(n))
          .map((n) => ({ literal: n })),
        year: w.publication_year ?? undefined,
        venue: w.primary_location?.source?.display_name ?? undefined,
        volume: biblio?.volume ?? undefined,
        issue: biblio?.issue ?? undefined,
        page,
        abstract: reconstructAbstract(w.abstract_inverted_index),
        citationCount: w.cited_by_count ?? undefined,
        hasOpenAccessPdf: Boolean(oa),
        url: oa ?? (doi ? `https://doi.org/${doi}` : undefined),
      };
    })
    .filter((r): r is ExternalSearchResult => r !== null);
}
