/**
 * 各上游的假响应 —— 形状从**真实响应**里抄(`.tmp/libcap/` 那次抓取),不是编的。
 *
 * 每条上面写明它对应真实的哪一次响应、以及那个形状本身在告诉我们什么。
 */

/* ─────────────────────────── Crossref ─────────────────────────── */

/** `GET api.crossref.org/works/10.1038/nature12373`(真响应的字段形状)。
 *
 *  这里刻意做了一条真实记录**不会同时有**的组合:`issued` 缺失、只有
 *  `published-print` 与 `published-online` —— 那正是 `crossrefYear` 的三级回退
 *  存在的理由(老印刷版期刊、部分会议记录就是这样)。年份缺了会连带影响筛选,
 *  所以这条必须能读出来。 */
export const crossrefWork = {
  status: "ok",
  message: {
    DOI: "10.1000/EXAMPLE.2020.001",
    title: ["Metasurface Holography with $\\lambda$/200 Resolution"],
    author: [
      { given: "Jane A.", family: "Doe" },
      { given: "Wei-Min", family: "Huang-Lee" },
      { name: "European Optical Society" },
    ],
    // 只有印刷版与线上版,没有 issued
    "published-print": { "date-parts": [[2020, 3]] },
    "published-online": { "date-parts": [[2019, 12]] },
    "container-title": ["Nature Photonics"],
    volume: "14",
    issue: "3",
    page: "170-176",
    publisher: "Springer Nature",
    abstract: "<jats:p>We report 100% &amp; 200nm resolution.</jats:p>",
    URL: "https://doi.org/10.1000/EXAMPLE.2020.001",
    "is-referenced-by-count": 42,
  },
};

/** Crossref 查不到(中文期刊的 DOI 大多注册在 ISTIC / CNKI 名下,Crossref 一律 404)。 */
export const crossrefNotFound = { ok: false, status: 404, error: "HTTP 404: Not Found" };

/** `GET doi.org/<doi>` + `Accept: ...csl+json` 的内容协商结果。
 *
 *  CSL 的形状比 Crossref **宽松**:`title` 可能是字符串也可能是单元素数组,
 *  作者常常整段塞在 `literal` 里,`container-title` 同理。 */
export const cslItem = {
  DOI: "10.1000/CJK.2021.001",
  title: ["基于深度学习的图像超分辨率重建综述"],
  author: [
    { literal: "张三" },
    { literal: "李四" },
    { given: "John", family: "Smith" },
  ],
  issued: { "date-parts": [[2021]] },
  "container-title": ["计算机学报"],
  volume: "44",
  issue: "5",
  page: "900-915",
  publisher: "科学出版社",
};

/** doi.org 转发到一个第三方站点、回了 HTML(实测见过明文 HTTP + 裸 IP 的跳转)。
 *  `fetchJson` 的语义是「响应不是合法 JSON」—— 解析不出就当内容协商也失败。 */
export const cslNotJson = { ok: false, error: "响应不是合法 JSON:<html><head>…" };

/* ─────────────────────────── Europe PMC ─────────────────────────── */

/** `GET ebi.ac.uk/europepmc/webservices/rest/search?...&resultType=core`。
 *
 *  ⚠️ **这两条是同一个问题的活证据**:同一篇文章,`lite` 给出 `journalTitle: "Nature"`,
 *  而 `core` 把它挪进了 `journalInfo.journal.title` 并把顶层 `journalTitle` 置空。
 *  代码只读顶层的 `r.journalTitle` —— 于是 core 那次拿到的 `venue` 是 undefined。
 *
 *  URL 与 `pdf=render` 那两条直链、`availability: "Open access"` 与 "Subscription
 *  required" 的并存,都是真实形状。 */
export const epmcCoreModern = {
  version: "6.9",
  hitCount: 1,
  resultList: {
    result: [
      {
        id: "1",
        source: "MED",
        pmcid: "PMC13581855",
        doi: "10.3389/fpls.2025.1655585",
        title: "Anatomical, biochemical and gene expression studies.",
        authorString: "Qiao Q, Wang C, Li J, Liu K, Tang H, Wang J, Gao Y.",
        pubYear: "2025",
        journalTitle: null,
        journalInfo: {
          issue: null,
          volume: "16",
          journal: { title: "Frontiers in Plant Science", medlineAbbreviation: "Front Plant Sci" },
        },
        fullTextUrlList: {
          fullTextUrl: [
            { availability: "Subscription required", availabilityCode: "S", documentStyle: "doi", url: "https://doi.org/10.3389/fpls.2025.1655585" },
            { availability: "Open access", availabilityCode: "OA", documentStyle: "html", url: "https://europepmc.org/articles/PMC13581855" },
            { availability: "Open access", availabilityCode: "OA", documentStyle: "pdf", url: "https://europepmc.org/articles/PMC13581855?pdf=render" },
          ],
        },
        citedByCount: 0,
        isOpenAccess: "Y",
        hasPDF: "Y",
      },
    ],
  },
};

/** 老记录(`resultType=core`,抓到 2026-09 那一次的真实形状):**顶层有**
 *  `journalTitle`,没有 `journalInfo`。`title` 以句点收尾(Europe PMC 的惯例),
 *  代码里那句 `replace(/\.$/, "")` 就是为它写的。 */
export const epmcCoreLegacy = {
  version: "6.9",
  hitCount: 1,
  resultList: {
    result: [
      {
        id: "23903748",
        source: "MED",
        pmcid: "PMC4221854",
        doi: "10.1038/nature12373",
        title: "Nanometre-scale thermometry in a living cell.",
        authorString: "Kucsko G, Maurer PC, Yao NY, Kubo M, Noh HJ, Lo PK, Park H, Lukin MD.",
        pubYear: "2013",
        journalTitle: "Nature",
        fullTextUrlList: {
          fullTextUrl: [
            { availability: "Subscription required", availabilityCode: "S", documentStyle: "doi", url: "https://doi.org/10.1038/nature12373" },
            { availability: "Free", availabilityCode: "F", documentStyle: "html", url: "https://europepmc.org/articles/PMC4221854" },
            { availability: "Free", availabilityCode: "F", documentStyle: "pdf", url: "https://europepmc.org/articles/PMC4221854?pdf=render" },
          ],
        },
        citedByCount: 701,
        isOpenAccess: "N",
        hasPDF: "Y",
      },
    ],
  },
};

/* ─────────────────────────── OpenAlex ─────────────────────────── */

/** `GET api.openalex.org/works?search=…`。
 *
 *  `abstract_inverted_index` 是**倒排索引**:词 → 出现位置数组。这一条故意让
 *  位置**不按词序出现**(真实响应里 Object.entries 的顺序就是 JSON 里的顺序,
 *  与位置无关)—— 不按位置重排的话拼出来的摘要是乱的。 */
export const openalexSearch = {
  meta: { count: 1 },
  results: [
    {
      doi: "https://doi.org/10.1000/EXAMPLE.2020.001",
      display_name: "Metasurface Holography with $\\lambda$/200 Resolution",
      publication_year: 2020,
      cited_by_count: 42,
      authorships: [{ author: { display_name: "Jane A. Doe" } }, { author: { display_name: "Wei-Min Huang-Lee" } }],
      primary_location: { source: { display_name: "Nature Photonics" } },
      biblio: { volume: "14", issue: "3", first_page: "170", last_page: "176" },
      abstract_inverted_index: { world: [1], Hello: [0], again: [2] },
      open_access: { is_oa: true, oa_url: "https://example.org/landing" },
      best_oa_location: { pdf_url: "https://example.org/paper.pdf" },
    },
  ],
};

/** `GET api.openalex.org/works/doi:<doi>`(OA 直链解析链里那一跳)。 */
export const openalexWork = {
  doi: "https://doi.org/10.1000/EXAMPLE.2020.001",
  open_access: { oa_url: "https://example.org/landing" },
  best_oa_location: { pdf_url: null },
  locations: [{ pdf_url: "https://example.org/repo/bitstream/1234/paper.pdf" }, { pdf_url: null }],
};

/* ─────────────────────── Semantic Scholar ─────────────────────── */

/** `GET api.semanticscholar.org/graph/v1/paper/DOI:<doi>?fields=openAccessPdf,externalIds`
 *  (抄自 10.1038/nature12373 的真实响应)。 */
export const s2Graph = {
  paperId: "a5de30adc5c22bc86e8cfabe7fbd07c052d196a8",
  externalIds: {
    ArXiv: "1304.1068",
    PubMedCentral: "4221854",
    DOI: "10.1038/nature12373",
    PubMed: "23903748",
  },
  openAccessPdf: { url: "https://www.nature.com/articles/nature12373.pdf" },
};

/* ─────────────────────────── arXiv Atom ─────────────────────────── */

export const arxivIdList = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: search_query=&amp;id_list=2302.01934&amp;start=0&amp;max_results=10</title>
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2302.01934v2</id>
    <updated>2023-06-01T00:00:00Z</updated>
    <published>2023-02-03T18:00:00Z</published>
    <title>Deep Learning for Metasurface
  Inverse Design</title>
    <summary>  We propose a method.  </summary>
    <author><name>Jane A. Doe</name></author>
    <author><name>Wei-Min Huang</name></author>
    <author><name>张三</name></author>
    <author><name>Madonna</name></author>
  </entry>
</feed>`;

/** 不存在的 id:feed 里**一条 entry 都没有**(真实响应就是这样,`totalResults` 为 0)。 */
export const arxivEmptyFeed = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: search_query=&amp;id_list=2401.999999&amp;start=0&amp;max_results=10</title>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

/** 格式不对的 id:arXiv **不会**返回空 feed,而是返回一条标题为 `Error`、
 *  `id` 指向 `arxiv.org/api/errors#…` 的 entry(实测 `id_list=abc` 的真实响应)。
 *  `parseArxivEntry` 不看 `id` 里的 errors 段,于是这条会被当成一篇论文读出来 ——
 *  标题是 "Error"、作者是 "arXiv api core"。 */
export const arxivErrorEntry = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Search Results</title>
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/api/errors#incorrect_id_format_for_abc</id>
    <title>Error</title>
    <updated>2026-09-19T18:17:14Z</updated>
    <link href="https://arxiv.org/api/errors#incorrect_id_format_for_abc" rel="alternate" type="text/html"/>
    <summary>incorrect id format for abc</summary>
    <author><name>arXiv api core</name></author>
  </entry>
</feed>`;
