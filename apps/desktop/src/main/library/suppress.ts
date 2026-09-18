/**
 * 屏蔽规则 —— **哪些资料不进上下文**。
 *
 * ## 判定要查祖先链,所以住在主进程
 *
 * 「屏蔽一个节点 = 它自己以及它下面的一切都不进上下文」这句话的落实,要把一条条目
 * 的**祖先链**整条查出来:
 *
 *     条目 → 它所属的集合 → 集合的类型 → 类型的组
 *
 * 逐段比对该不该挡住。链上任一段命中就挡住。链的每一段都有现成的查询(`CollectionRepo`
 * 的成员关系、`LibraryCollection.kind`、`kindRegistry` 的 `LibraryGroupMeta.kinds` 反查),
 * 契约那一层拿不到这些(它没有 DB),所以形状与校验在 `@contracts/libraryTypes`,
 * 算法在这儿。
 *
 * ## 硬过滤
 *
 * 用户的原话:「就算是我手动挂的一个文件,只要是屏蔽状态,也挂不上去」。所以调用方
 * **入口和每个关联都过同一个 `isItemSuppressed`**,入口不被特殊对待 —— 那正是"平级"
 * 的另一面。
 *
 * ## 与注册表的两个表同一种存法
 *
 * 一个设置键、值是一份 JSON、读的时候走纯校验函数:与 `library.types` / `library.groups`
 * 一致。同样带缓存(设置页保存后立刻生效,不等 DB 重开),同样在存坏时**退回空规则
 * 而不是炸** —— 空规则 = 什么都不挡,与"这个功能还没配过"是同一个行为,是这里唯一
 * 安全的退路(反过来,坏数据退回"全挡"会让用户的东西凭空消失)。
 */
import {
  EMPTY_LIBRARY_SUPPRESS,
  LIBRARY_SUPPRESS_SETTING_KEY,
  parseSuppressJson,
  parseSuppressNodeKey,
  suppressNodeKey,
  type LibrarySuppressRule,
} from "@contracts/libraryTypes";
import { CollectionRepo, LibraryRepo, SettingRepo } from "@main/store/repositories.js";
import { loadLibraryGroups } from "./kindRegistry.js";
import { log } from "@main/lib/logger.js";
import { extname } from "node:path";

let cache: LibrarySuppressRule | null = null;

/** 读当前规则。没存过 / 存坏了 → 空规则(什么都不挡)。 */
export function loadSuppress(): LibrarySuppressRule {
  if (cache) return cache;
  const raw = SettingRepo.get(LIBRARY_SUPPRESS_SETTING_KEY);
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`[library] 屏蔽规则不是合法 JSON,按"什么都没屏蔽"处理(键 ${LIBRARY_SUPPRESS_SETTING_KEY})`);
    }
  }
  if (parsed === null) {
    cache = { nodes: [], extensions: [] };
    return cache;
  }
  const res = parseSuppressJson(parsed);
  if (!res.ok) {
    log.warn(`[library] 屏蔽规则校验失败(${res.error}),按"什么都没屏蔽"处理`);
    cache = { nodes: [], extensions: [] };
    return cache;
  }
  cache = res.rule;
  return cache;
}

/** 整表替换。校验失败原样交回说人话的错误,且**缓存不动**(同注册表那边的处置)。 */
export function saveSuppress(raw: unknown): { ok: true } | { ok: false; error: string } {
  const res = parseSuppressJson(raw);
  if (!res.ok) return res;
  SettingRepo.set(LIBRARY_SUPPRESS_SETTING_KEY, JSON.stringify(res.rule));
  cache = res.rule;
  return { ok: true };
}

/** 测试用:把缓存丢掉,逼下一次 load 重新读 DB。 */
export function resetSuppressCacheForTest(): void {
  cache = null;
}

/**
 * 这条条目的祖先链上有哪些**节点键**(可与 `rule.nodes` 直接比对)。
 *
 * 三种都可能出现,顺序从近到远(集合 → 类型 → 组),但**顺序不影响判定** ——
 * 调用方只关心"有没有命中"。之所以把整条链一次算完而不是逐层短路,是因为查集合
 * 那一步本来就要把全部集合取出来,再省一点反而把代码绕乱。
 *
 * > 集合那一层取的是**条目所属的全部集合**(一个条目可以同时在多个集合里)。链上任
 * > 一个集合被屏蔽都算 —— 用户屏蔽「精读队列」时不会预期"这篇因为同时在别处,
 * > 就从精读队列里漏过来了"。
 *
 * 导出是为了让 smoke 能直接验链条本身,而不必每次都摆一套完整的挂载场景。
 */
export function suppressKeysOfItem(itemId: string, kind: string): string[] {
  const keys: string[] = [];
  // 条目 → 它所属的集合
  for (const collectionId of CollectionRepo.collectionsOfItem(itemId)) {
    keys.push(suppressNodeKey("collection", collectionId));
  }
  // 集合 → 类型:集合自己记着 kind;条目本身也有 kind(不在任何集合里的条目靠它)。
  keys.push(suppressNodeKey("type", kind));
  // 类型 → 组:反查哪个大类的 kinds 里有它。没进任何组的类型就到这儿为止。
  for (const group of loadLibraryGroups()) {
    if (group.kinds.includes(kind)) keys.push(suppressNodeKey("group", group.id));
  }
  return keys;
}

/**
 * 这条条目该不该被挡在上下文之外。
 *
 * 两把筛子,**任一命中即挡住**:
 *
 *   1. **节点**:祖先链上任一节点在 `nodes` 里(见 `suppressKeysOfItem`);
 *   2. **扩展名**:它的文件后缀在 `extensions` 里。
 *
 * 扩展名看的是**条目实际会被读的那个文件** —— 与清单里给 agent 的路径同源:
 * 有 markdown 就按 markdown(md 转换产物才是 agent 读的),否则 PDF,否则通用文件
 * 路径。这样"屏蔽 .md"挡住的正是 agent 会去读的那份,而不是一份它根本不会碰的。
 *
 * 条目不存在时返回 false(不挡)—— 找不到的东西由调用方按"找不到"报错,
 * 不该在这儿被说成"被屏蔽了",那是两句不同的话。
 */
export function isItemSuppressed(itemId: string): boolean {
  const rule = loadSuppress();
  if (rule.nodes.length === 0 && rule.extensions.length === 0) return false;

  const item = LibraryRepo.get(itemId);
  if (!item) return false;

  const nodeSet = new Set(rule.nodes);
  for (const key of suppressKeysOfItem(itemId, item.kind)) {
    if (nodeSet.has(key)) return true;
  }

  if (rule.extensions.length > 0) {
    // 与清单给 agent 的路径同源:优先 markdown(那才是 agent 读的),再 PDF,
    // 再通用文件路径。都不存在 = 这条还没有文件,扩展名这一筛子无从命中。
    const p = item.mdPath ?? item.pdfPath ?? item.filePath;
    if (p) {
      const ext = extname(p).toLowerCase();
      if (ext.length > 0 && rule.extensions.includes(ext)) return true;
    }
  }
  return false;
}

/**
 * 挡住的**原因** —— 给用户看的一句话,而不是一个布尔值。
 *
 * 挂不上必须说清为什么(仓库纪律:坏清单要显式报出来,不静默跳过)。只说"被屏蔽了"
 * 用户还得自己去设置里翻是哪一条,所以这里尽力把命中的那个节点/扩展名说出来。
 * 返回 null = 没被挡。
 */
export function suppressionReasonOfItem(itemId: string): string | null {
  const rule = loadSuppress();
  if (rule.nodes.length === 0 && rule.extensions.length === 0) return null;

  const item = LibraryRepo.get(itemId);
  if (!item) return null;

  const nodeSet = new Set(rule.nodes);
  for (const key of suppressKeysOfItem(itemId, item.kind)) {
    if (nodeSet.has(key)) return describeNodeKey(key);
  }

  const p = item.mdPath ?? item.pdfPath ?? item.filePath;
  if (p) {
    const ext = extname(p).toLowerCase();
    if (ext.length > 0 && rule.extensions.includes(ext)) return `${ext} 文件`;
  }
  return null;
}

/**
 * 一个节点键 → 用户看得懂的名字。
 *
 * 集合查得到名字(那是用户起的);类型与大类查注册表/分组表。都查不到就退回键本身
 * —— 那说明这一条指向的东西已经被删了,说清"是哪一条"比说一个空字符串有用。
 */
function describeNodeKey(key: string): string {
  const parsed = parseSuppressNodeKey(key);
  if (!parsed) return key;
  if (parsed.level === "collection") {
    const c = CollectionRepo.list().find((x) => x.id === parsed.id);
    return c ? `「${c.name}」` : `已删除的分类(${parsed.id})`;
  }
  if (parsed.level === "type") {
    return `类型「${parsed.id}」`;
  }
  const g = loadLibraryGroups().find((x) => x.id === parsed.id);
  return g ? `「${g.name}」` : `已删除的大类(${parsed.id})`;
}

/** 重新导出契约里那几个纯函数 —— 调用方(IPC / 界面)不必再多 import 一处。 */
export { EMPTY_LIBRARY_SUPPRESS, parseSuppressNodeKey };
