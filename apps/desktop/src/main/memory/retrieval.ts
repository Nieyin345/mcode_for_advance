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
  let budget = SNAPSHOT_CAP;
  let ranOut = false;
  for (const meta of picked) {
    if (budget <= 0) {
      ranOut = true; // 整段额度用完,剩下的不读了
      break;
    }
    let body = "";
    try {
      body = readMemoryFile(meta.path).content.trim();
    } catch {
      continue; // 列表和磁盘之间隔了一个窗口;读不到的那条跳过
    }
    if (body.length === 0) continue; // 空条目进快照只是噪音
    if (body.length > BODY_CAP) body = `${body.slice(0, BODY_CAP)}…(已截断)`;
    const text = [`- 【${meta.title}】${formatMinute(meta.updatedAt)}`, ...body.split("\n").map((l) => `  ${l}`)].join("\n");
    blocks.push({ meta, text });
    budget -= text.length;
  }
  const out: string[] = [];
  for (const category of MEMORY_CATEGORIES) {
    const bucket = blocks.filter((b) => b.meta.category === category);
    if (bucket.length === 0) continue;
    out.push(`## 记忆 · ${MEMORY_CATEGORY_LABELS[category]}`, "", ...bucket.map((b) => b.text), "");
  }
  if (ranOut) out.push("(记忆快照过长,以上只保留最先的若干条 —— 其余已截断)");
  return out.join("\n").trimEnd();
}

/** `YYYY-MM-DD HH:mm`,**本地时间** —— 同 automationPayload 的理由:用户对的是自己的表。 */
function formatMinute(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
