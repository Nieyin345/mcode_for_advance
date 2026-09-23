/**
 * 记忆的检索注入(MEM-02)—— 把记忆库聚合成**一段可以直接拼进提示词的文本**。
 *
 * ## 为什么是"快照"而不是逐条引用
 *
 * 模型节点的输入是**一段话**:`@路径` 那套附件引用是给"读文件工具"用的,而记忆的意义
 * 在于**不用任何工具就在场**。所以这里把选中类目下的记忆压成一个文本块:分组标题 +
 * 每条「标题 + 正文」,新的在前 —— 拼进提示词后,它就是模型直接读得到的背景。
 *
 * ## 截断是保护,不是功能
 *
 * 记忆库会越长越大,而提示词的预算是硬的。三道闸:单条正文截到 {@link BODY_CAP}
 * 字、总条数默认 {@link DEFAULT_LIMIT} 条、整段累计到 {@link SNAPSHOT_CAP} 字就收手
 * 并注明"已截断"。截断**必须说出口** —— 静默丢内容会让模型以为"没写"等于"没有"。
 *
 * 库是空的就返回空串:调用方(注入那一侧)看到空串就**整节不出现**,不该凭空多一个
 * 只有标题的空段落。
 */
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, type MemoryCategory, type MemoryFileMeta } from "@contracts/memory";
import { listMemoryFiles, readMemoryFile } from "./store.js";

/** 默认取最近多少条。够当一个背景板,又不至于把提示词吃穿。 */
export const DEFAULT_LIMIT = 12;

/** 单条正文的上限(字符)。记忆条目应是"记下来的话",不是整篇文章。 */
export const BODY_CAP = 600;

/** 整段快照的上限(字符)。 */
export const SNAPSHOT_CAP = 6000;

/**
 * 聚合一条记忆快照。
 *
 * @param categories 想要的类目;不给 = 全部六类。传了但一个都不在白名单里 → 空串
 *   (调用方拼错类目名时,"安静的空"比"猜一个近义类目"诚实)。
 * @param limit 最多几条,按 `updatedAt` 新的优先。
 */
export function memorySnapshotFor(categories?: readonly string[], limit: number = DEFAULT_LIMIT): string {
  const wanted =
    categories === undefined
      ? [...MEMORY_CATEGORIES]
      : categories.filter((c): c is MemoryCategory => (MEMORY_CATEGORIES as readonly string[]).includes(c));
  if (wanted.length === 0 || limit <= 0) return "";

  // 先排序、后取条数,**再**读正文 —— 正文要过磁盘,只读选中的那几条。
  const picked = listMemoryFiles()
    .filter((m) => wanted.includes(m.category as MemoryCategory))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  const blocks: Array<{ meta: MemoryFileMeta; text: string }> = [];
  for (const meta of picked) {
    let body = "";
    try {
      body = readMemoryFile(meta.path).content.trim();
    } catch {
      continue; // 列表和磁盘之间隔了一个窗口;读不到的那条跳过
    }
    if (body.length === 0) continue; // 空条目进快照只是噪音
    body = bodyPreview(body);
    const text = [`- 【${meta.title}】${formatMinute(meta.updatedAt)}`, ...body.split("\n").map((l) => `  ${l}`)].join("\n");
    blocks.push({ meta, text });
  }

  const renderBlocks = (items: typeof blocks): string => {
    const out: string[] = [];
    for (const category of MEMORY_CATEGORIES) {
      const bucket = items.filter((b) => b.meta.category === category);
      if (bucket.length === 0) continue;
      out.push(`## 记忆 · ${MEMORY_CATEGORY_LABELS[category]}`, "", ...bucket.map((b) => b.text), "");
    }
    return out.join("\n").trimEnd();
  };

  const rendered = renderBlocks(blocks);
  if (rendered.length <= SNAPSHOT_CAP) return rendered;

  // 超限时只在“完整条目”之间裁剪，绝不从一条记忆正文中间硬切。
  // blocks 保持 picked 的全局新→旧顺序，所以从尾部删除 = 优先丢最旧的条目。
  const notice = "(记忆快照过长,以上只保留最先的若干条 —— 其余已截断)";
  const kept = [...blocks];
  while (kept.length > 0) {
    const candidate = `${renderBlocks(kept)}\n\n${notice}`;
    if (candidate.length <= SNAPSHOT_CAP) return candidate;
    kept.pop();
  }
  return notice.slice(0, SNAPSHOT_CAP);
}

/** `YYYY-MM-DD HH:mm`,**本地时间** —— 同 automationPayload 的理由:用户对的是自己的表。 */
function formatMinute(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── 按相关度检索(MEM-04) ── */

/**
 * 检索命中。`score` 是**可比的相对值**,不是"百分比" —— 只在同一次检索内部比大小。
 */
export interface MemorySearchHit {
  meta: MemoryFileMeta;
  /** 去掉 frontmatter 的正文预览,严格不超过 {@link BODY_CAP};正文命中时会尽量把命中附近放进窗口。 */
  body: string;
  score: number;
}

/**
 * 把查询串切成词。
 *
 * ## 为什么中文要按**双字**切
 *
 * 中文没有空格,整句当一个词(「引用格式用 APA」)去 `indexOf` 只能命中一字不差的整句。
 * 而按**单字**切会把噪音放进来(「的」「用」在任何一段里都有)。双字组是个折中:
 * 「引用」「格式」「APA」各自可命中,又不至于被虚词淹没。单字查询(用户就输一个字)才退回单字。
 *
 * 英文/数字按非字母数字切,统一小写。
 */
export function queryTerms(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const terms = new Set<string>();
  // 西文:按非字母数字切
  for (const word of q.split(/[^a-z0-9_]+/)) {
    if (word.length >= 2) terms.add(word);
  }
  // 中文:连续汉字段按双字滑窗
  for (const run of q.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/** 标题里的命中比正文里的**值钱** —— 标题是这条记忆的自我描述。 */
const TITLE_WEIGHT = 3;

/**
 * 按相关度检索记忆(MEM-04)。
 *
 * ## 为什么不是 `updatedAt` 倒序
 *
 * 从前唯一的取法是"最近 12 条"(见 {@link memorySnapshotFor})。记忆库一大,
 * 「用户三年前说过引用用 APA」这条**永远不会**出现在前 12 条里 —— 而它恰恰是最该看的那条。
 * 记忆的价值在"不用重复说第二遍",按时间取等于把这句话作废。
 *
 * ## 为什么不开一个 ripgrep 子进程
 *
 * 记忆库的形状和"一个代码仓库"正相反:六个体量很小的 markdown 目录,同一次检索要把
 * 候选**整篇**读进来才能排序 —— 而 rg 给的是**行级**匹配,拿回来还得自己聚合成文件分。
 * 多一个子进程、多一层"rg 没装怎么办"的兜底,换不到任何东西。
 *
 * 所以这里直接读文件、在 JS 里打分:纯函数式的评分,无头 smoke 也喂得进去。
 * (库真长到几万条的规模再说 —— 那一天 `listMemoryFiles` 本身就该先换掉。)
 *
 * 查询为空 → 退回**按时间**(与改造前的行为一致);有查询但一条都不命中 → **空数组**,
 * 调用方照实说"没找到",不要假装那几条无关的就是结果。
 */
export function searchMemory(
  query: string,
  opts: { limit?: number; category?: string } = {},
): MemorySearchHit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];
  const metas = listMemoryFiles(opts.category === undefined ? undefined : { category: opts.category });
  const terms = queryTerms(query);

  // 查询为空:按时间取最近若干条。先读、再占 limit —— 空正文或列表/磁盘竞态读不到的
  // 条目不能白白吃掉名额，否则明明还有更旧的有效记忆也会少返回。
  if (terms.length === 0) {
    const recent: MemorySearchHit[] = [];
    for (const meta of metas.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const candidate = readCandidate(meta);
      if (!candidate) continue;
      recent.push(candidate.hit);
      if (recent.length >= limit) break;
    }
    return recent;
  }

  const scored: MemorySearchHit[] = [];
  for (const meta of metas) {
    const candidate = readCandidate(meta, terms);
    if (!candidate) continue;
    const hay = candidate.searchBody.toLowerCase();
    const title = meta.title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += TITLE_WEIGHT;
      // 最多只关心前 5 次命中。用 indexOf 逐次走，避免 `split` 为长正文创建整组临时字符串。
      score += countOccurrencesUpTo(hay, term, 5);
    }
    if (score > 0) scored.push({ ...candidate.hit, score });
  }
  // 分数相同按时间新的在前 —— 让"最近提过"在同分时胜出
  return scored.sort((a, b) => b.score - a.score || b.meta.updatedAt - a.meta.updatedAt).slice(0, limit);
}

/** Read once: score against the full body, but expose only the capped preview to callers. */
interface MemorySearchCandidate {
  hit: MemorySearchHit;
  searchBody: string;
}

function readCandidate(meta: MemoryFileMeta, terms: readonly string[] = []): MemorySearchCandidate | null {
  try {
    const searchBody = readMemoryFile(meta.path).content.trim();
    if (searchBody.length === 0) return null;
    return { hit: { meta, body: bodyPreview(searchBody, terms), score: 0 }, searchBody };
  } catch {
    return null;
  }
}

const TRUNCATED_BEFORE = "…(前文已截断)\n";
const TRUNCATED_AFTER = "\n…(后文已截断)";
const TRUNCATED_AFTER_ONLY = "…(已截断)";

/**
 * 返回真正不超过 BODY_CAP 的正文预览。有查询且命中落在长正文深处时，把窗口移到首次命中附近，
 * 避免 `memory_search` 明明说“命中”却只展示一段完全看不到关键词的开头。
 */
function bodyPreview(body: string, terms: readonly string[] = []): string {
  if (body.length <= BODY_CAP) return body;

  const hay = body.toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const at = hay.indexOf(term);
    if (at >= 0 && (firstMatch < 0 || at < firstMatch)) firstMatch = at;
  }

  // 没有正文命中(例如只命中标题),或命中就在开头窗口里:保持“从头读”的旧语义。
  const headRoom = BODY_CAP - TRUNCATED_AFTER_ONLY.length;
  if (firstMatch < 0 || firstMatch < headRoom) {
    return `${body.slice(0, headRoom)}${TRUNCATED_AFTER_ONLY}`;
  }

  const room = BODY_CAP - TRUNCATED_BEFORE.length - TRUNCATED_AFTER.length;
  // 给关键词前约 1/3 窗口作上下文，其余留给命中之后；靠近尾部时再向前补齐。
  let start = Math.max(0, firstMatch - Math.floor(room / 3));
  if (start + room > body.length) start = Math.max(0, body.length - room);
  return `${TRUNCATED_BEFORE}${body.slice(start, start + room)}${TRUNCATED_AFTER}`;
}

/** 与旧的 `split(term).length - 1` 一样数非重叠命中，但达到 cap 就立刻停。 */
function countOccurrencesUpTo(hay: string, needle: string, cap: number): number {
  if (needle.length === 0 || cap <= 0) return 0;
  let count = 0;
  let from = 0;
  while (count < cap) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}
