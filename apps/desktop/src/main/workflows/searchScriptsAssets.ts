/**
 * 检索脚本的正文,以 **Vite `?raw` 导入**随应用发布(与 `paperFetchAssets.ts` 同一套做法)。
 *
 * 磁盘上的文件**逐字不动** —— 由 Vite 负责把它们变成字符串常量,所以搬的是原文件
 * 本身,不是改写版。这一点对这两个来源尤其要紧:
 *
 *   - `research-clients/` 来自 **academic-research-skills**(CC-BY-NC-4.0,见该目录下的
 *     LICENSE / NOTICE)。它是按 API 协议文档逐条实现的检索客户端,每个源的限速、
 *     退避、标题比对规则都写在里面,还带一个 1865 行的**中文文献解析器**
 *     (ISTIC/CNKI 注册的 DOI 在 Crossref 里查不到,之前正是我们的盲区)。
 *   - `paper-lookup/` `citation-management/` `literature-review/` 来自
 *     **scientific-agent-skills**(MIT,见 `lookup-tools-LICENSE.md`)。
 *
 * 两组都是**纯标准库**(urllib / xml / json),不需要 pip 装任何东西。
 *
 * 这个文件由 `.scholar_tmp/gen_assets.py` 生成,不要手写 —— 加文件请重新生成。
 */
import f0 from "./search-scripts/citation-management/_common.py?raw";
import f1 from "./search-scripts/citation-management/doi_to_bibtex.py?raw";
import f2 from "./search-scripts/citation-management/extract_metadata.py?raw";
import f3 from "./search-scripts/citation-management/format_bibtex.py?raw";
import f4 from "./search-scripts/citation-management/search_openalex.py?raw";
import f5 from "./search-scripts/citation-management/search_pubmed.py?raw";
import f6 from "./search-scripts/citation-management/validate_citations.py?raw";
import f7 from "./search-scripts/literature-review/search_databases.py?raw";
import f8 from "./search-scripts/literature-review/verify_citations.py?raw";
import f9 from "./search-scripts/lookup-tools-LICENSE.md?raw";
import f10 from "./search-scripts/paper-lookup/_common.py?raw";
import f11 from "./search-scripts/paper-lookup/arxiv_atom.py?raw";
import f12 from "./search-scripts/paper-lookup/jats_to_text.py?raw";
import f13 from "./search-scripts/paper-lookup/openalex_abstract.py?raw";
import f14 from "./search-scripts/paper-lookup/paginate.py?raw";
import f15 from "./search-scripts/research-clients/_text_similarity.py?raw";
import f16 from "./search-scripts/research-clients/ars_query.py?raw";
import f17 from "./search-scripts/research-clients/arxiv_client.py?raw";
import f18 from "./search-scripts/research-clients/chinese_literature_client.py?raw";
import f19 from "./search-scripts/research-clients/crossref_client.py?raw";
import f20 from "./search-scripts/research-clients/LICENSE?raw";
import f21 from "./search-scripts/research-clients/NOTICE.md?raw";
import f22 from "./search-scripts/research-clients/openalex_client.py?raw";
import f23 from "./search-scripts/research-clients/semantic_scholar_client.py?raw";

/** 相对 `<数据根>/workflows/scripts/search-scripts/` 的路径 → 正文。 */
export const SEARCH_SCRIPT_FILES: ReadonlyArray<[path: string, body: string]> = [
  ["citation-management/_common.py", f0],
  ["citation-management/doi_to_bibtex.py", f1],
  ["citation-management/extract_metadata.py", f2],
  ["citation-management/format_bibtex.py", f3],
  ["citation-management/search_openalex.py", f4],
  ["citation-management/search_pubmed.py", f5],
  ["citation-management/validate_citations.py", f6],
  ["literature-review/search_databases.py", f7],
  ["literature-review/verify_citations.py", f8],
  ["lookup-tools-LICENSE.md", f9],
  ["paper-lookup/_common.py", f10],
  ["paper-lookup/arxiv_atom.py", f11],
  ["paper-lookup/jats_to_text.py", f12],
  ["paper-lookup/openalex_abstract.py", f13],
  ["paper-lookup/paginate.py", f14],
  ["research-clients/_text_similarity.py", f15],
  ["research-clients/ars_query.py", f16],
  ["research-clients/arxiv_client.py", f17],
  ["research-clients/chinese_literature_client.py", f18],
  ["research-clients/crossref_client.py", f19],
  ["research-clients/LICENSE", f20],
  ["research-clients/NOTICE.md", f21],
  ["research-clients/openalex_client.py", f22],
  ["research-clients/semantic_scholar_client.py", f23],
];
