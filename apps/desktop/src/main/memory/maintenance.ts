/**
 * 记忆的维护(MEM-03)—— **纯函数**:给它条目,给它"现在",它给你建议;不碰磁盘、
 * 不碰时钟。真要删、真要合并是人的决定(界面按这些建议出候选),这里只负责把候选算
 * 出来、算得可断言(所以冒烟能直接喂条目)。
 *
 * ## 两件维护的事,判据都不"聪明"
 *
 *  - **过期**(`findStale`):`updatedAt` 距今超过 N 天。记忆没有"访问计数"那种埋点,
 *    而一个从没被更新过的"项目现状"多半已经是谎言 —— 用时间当代理量,错了也比
 *    "永远留在库里"强。
 *  - **重复**(`suggestDedup`):标题(归一化后)一样,或正文足够像。判据是确定性的
 *    (字符二元组 Jaccard),不引分词、不引模型 —— 建议给错了,人一眼看得出来;
 *    判据本身说不清,人就只能全盘信它。
 */
import type { MemoryFileMeta } from "@contracts/memory";

/** 一天的毫秒数(过期判据的单位)。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 挑出**过期**的条目:`updatedAt` 距 `now` 超过 `days` 天。
 * `updatedAt` 缺失(0)的按"最老"算 —— 没有时间的记忆谈不上新鲜。
 */
export function findStale(items: readonly MemoryFileMeta[], now: number, days = 90): MemoryFileMeta[] {
  const threshold = days * DAY_MS;
  return items.filter((m) => now - (m.updatedAt || 0) > threshold);
}

/** 重复检查的一条输入:元信息 + 正文(维护入口把两样一起喂进来)。 */
export interface DedupCandidate {
  path: string;
  title: string;
  content: string;
}

/** 一对疑似重复:`a` / `b` 是两条的 path(与传入顺序一致,保证 a 在 b 前),score 是相似度。 */
export interface DedupPair {
  a: string;
  b: string;
  score: number;
}

/** 正文相似度的门槛。实测 0.85 对"同一句话换个标点"和"同主题两段话"分得开。 */
const DEDUP_THRESHOLD = 0.85;

/** 标题或正文近似的条目对。`path` 两两不重、按传入顺序(a 先 b),score 高的在前。 */
export function suggestDedup(items: readonly DedupCandidate[], threshold = DEDUP_THRESHOLD): DedupPair[] {
  const norm = items.map((it) => ({
    path: it.path,
    title: normalize(it.title),
    grams: bigrams(normalize(it.content)),
  }));
  const out: DedupPair[] = [];
  for (let i = 0; i < norm.length; i += 1) {
    for (let j = i + 1; j < norm.length; j += 1) {
      const a = norm[i]!;
      const b = norm[j]!;
      // 标题一样(且不是空的)直接判重复;否则看正文的二元组重合度。
      const score = a.title.length > 0 && a.title === b.title ? 1 : jaccard(a.grams, b.grams);
      if (score >= threshold) out.push({ a: a.path, b: b.path, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** 归一化:小写、去掉空白与标点 —— "引用规范!" 和 "引用规范" 是同一个标题。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符二元组集合(不足两字的串给空集 —— 单字标题交给标题相等那条判)。 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/** Jaccard:交并比。两边都空(正文归一化后什么都没剩)按 0 算,不判重。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}
