/**
 * 屏蔽规则 —— **哪些资料不给 AI 看**。
 *
 * ## 只管给 AI 看的(2026-09-26 用户定的规矩)
 *
 * 「只要是给 AI 看的东西才需要屏蔽,用户看的不需要」—— 屏蔽是为**引用**设计的:挂进
 * 对话的清单、AI 的翻库工具、`library.py`。用户自己在界面里搜、预览(看 PDF)不过这道门;
 * 下载、转录、挂回转录这类**干活**的动作(包括自动化)也不过 —— 屏蔽了 pdf 要的正是
 * 「只给模型看转录后的 md」,不转录就没有那份 md。
 *
 * 两层:
 *   - **整条挡**(`suppressionReasonOfItem`):所在分类/大类被屏蔽,或者它名下的文件
 *     **全部**被按文件类型屏蔽;
 *   - **按份去掉**(`isFileSuppressed`):没被整条挡的条目,给 AI 的文件里去掉被屏蔽
 *     类型的那几份(清单、翻库结果、`library.py` 都按这一层,见 `fileImport.ts` 的
 *     `aiVisibleFilesOf`)。
 *
 * ## 判定要查祖先链,所以住在主进程
 *
 * 「屏蔽一个节点 = 它自己以及它下面的一切都不进上下文」这句话的落实,要把一条条目
 * 的**祖先链**整条查出来:
 *
 *     条目 → 它所属的集合 → 沿 parentId 往上的每一级父分类 → 各级挂着的大类
 *
 * 逐段比对该不该挡住。链上任一段命中就挡住。链的每一段都有现成的查询(`CollectionRepo`
 * 的成员关系、`LibraryCollection.groupId`),契约那一层拿不到这些(它没有 DB),所以
 * 形状与校验在 `@contracts/libraryTypes`,算法在这儿。
 *
 * ## 硬过滤
 *
 * 用户的原话:「就算是我手动挂的一个文件,只要是屏蔽状态,也挂不上去」。所以**入口和
 * 每个关联都过同一道判定**,入口不被特殊对待 —— 那正是"平级"的另一面。
 *
 * 整条挡的判定只导出**一个**入口:`suppressionReasonOfItem`(下面)。从前还有一个
 * 返回布尔值的 `isItemSuppressed`,但**全仓库没有任何调用方** —— 调用方要的从来不是
 * "是不是被挡了"这一个比特,而是"被挡了、因为哪一条"(仓规:坏东西显式报出来)。
 * 于是它被删掉了:留着的话,下一个人会挑它("布尔值更顺手"),然后拿一个说不清原因的
 * `false` 去回应用户。要布尔值请自己判 `!== null`。
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
import { loadLibraryGroups } from "./groupRegistry.js";
import { log } from "@main/lib/logger.js";
import { extname } from "node:path";

/**
 * 「去哪改屏蔽规则」那句话里的**设置页名** —— 给 AI 的话(清单、翻库工具、`library.py`)
 * 里,凡是让用户自己去解除屏蔽的地方,都引用这一份。
 *
 * ## 为什么单拎出来
 *
 * 这个页面改过名:从前叫「资料库类型」,现在界面上是「文档管理」(`settings.nav.
 * libraryTypes` / `settings.libraryTypes.title` 都是「文档管理」)。而主进程这边
 * 前后有**五处**逐字写着旧名(`manifest.ts` / `libraryServer.ts` ×3 /
 * `sandboxReadPolicy.ts` ×2 / `assets.ts` 里的 python 镜像)—— 改一处漏一处,模型就会
 * 指给用户一个**不存在**的设置页。
 *
 * 主进程没有 i18n(那是渲染端的事),所以这里只能是一份中文常量;界面那侧对应的
 * 提示走 `library.attach.blockedHint` 的 `{page}`(值取自 `settings.nav.libraryTypes`)。
 * 改设置页名时,**这两处**(渲染端 i18n + 本常量)都要跟着改,以及 `assets.ts` 里
 * python 镜像的那份。
 */
export const LIBRARY_BLOCK_SETTINGS_PAGE = "文档管理";

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
 * 两种都可能出现,顺序从近到远(集合 → 大类),但**顺序不影响判定** ——
 * 调用方只关心"有没有命中"。之所以把整条链一次算完而不是逐层短路,是因为查集合
 * 那一步本来就要把全部集合取出来,再省一点反而把代码绕乱。
 *
 * > 集合那一层取的是**条目所属的全部集合**(一个条目可以同时在多个集合里),并且
 * > **沿 `parentId` 一路收到顶**:左栏允许把分类拖成父子(`CollectionContextMenu`
 * > 的「移动到…」),而设置页承诺的是「勾一个……它下面的全部内容都跟着被挡」——
 * > 只看直属集合的话,屏蔽了父分类,子分类里的条目会从缝里漏过去(2026-09-26 修)。
 * > 链上任一个集合被屏蔽都算 —— 用户屏蔽「精读队列」时不会预期"这篇因为同时在别处,
 * > 就从精读队列里漏过来了"。
 *
 * 导出是为了让 smoke 能直接验链条本身,而不必每次都摆一套完整的挂载场景。
 */
export function suppressKeysOfItem(itemId: string): string[] {
  const keys: string[] = [];
  // 条目 → 直属集合 → 沿 parentId 往上的每一级父分类;链上每一级挂着的大类
  // （kind 退役后大类经 group_id 直挂）也都收 —— 子分类挪过窝之后 groupId 可能
  // 与父分类不一致,哪一级的大类被屏蔽都该挡。
  const groupIds = new Set<string>();
  const byId = new Map(CollectionRepo.list().map((c) => [c.id, c] as const));
  const seen = new Set<string>();
  const pending = CollectionRepo.collectionsOfItem(itemId);
  while (pending.length > 0) {
    const id = pending.pop();
    // `seen` 顺带挡住父链上的环:数据上理论能把 A 挪进 B、B 又挪进 A,判定不该死循环。
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const collection = byId.get(id);
    if (!collection) continue;
    keys.push(suppressNodeKey("collection", collection.id));
    if (collection.groupId) groupIds.add(collection.groupId);
    if (collection.parentId) pending.push(collection.parentId);
  }
  for (const gid of groupIds) keys.push(suppressNodeKey("group", gid));
  return keys;
}

/**
 * 挡住的**原因** —— 给用户看的一句话,而不是一个布尔值。
 *
 * 两把筛子,**任一命中即挡住**:
 *
 *   1. **节点**:祖先链上任一节点在 `nodes` 里(见 `suppressKeysOfItem`);
 *   2. **扩展名**:它名下的文件(转录 / PDF / 通用文件)**全部**被屏蔽。
 *
 * 扩展名按**份**算:一条条目的原件和它的 Markdown 转录是一起给 AI 的,屏蔽 `.pdf` 时
 * 转录过的那条照样挂得上、只是清单里只剩转录(见 `isFileSuppressed`);只有 PDF 的那条
 * 一份都不剩,才整条挡。同一天早些时候改成过「任一份命中就整条挡」,与用户的设计正相反。
 * 没有文件的条目(只有元数据)不受扩展名影响。
 * `library.py` 里的 `suppress_reason` 是同一条规则的 Python 版,改这里要一起改。
 *
 * 挂不上必须说清为什么(仓库纪律:坏清单要显式报出来,不静默跳过)。只说"被屏蔽了"
 * 用户还得自己去设置里翻是哪一条,所以这里尽力把命中的那个节点/扩展名说出来。
 * 返回 null = 没被挡;**条目不存在时也返回 null(不挡)** —— 找不到的东西由调用方
 * 按"找不到"报错,不该在这儿被说成"被屏蔽了",那是两句不同的话。
 *
 * **这是本模块唯一的判定入口**(那个返回布尔的 `isItemSuppressed` 因为没人用已删)。
 * 调用方一律写成 `if (reason) …`,顺带就有了要说出口的那句话。
 */
export function suppressionReasonOfItem(itemId: string): string | null {
  const rule = loadSuppress();
  if (rule.nodes.length === 0 && rule.extensions.length === 0) return null;

  const item = LibraryRepo.get(itemId);
  if (!item) return null;

  const nodeSet = new Set(rule.nodes);
  for (const key of suppressKeysOfItem(itemId)) {
    if (nodeSet.has(key)) return describeNodeKey(key);
  }

  const files = [item.mdPath, item.pdfPath, item.filePath].filter((p): p is string => Boolean(p));
  if (files.length > 0 && files.every((p) => isFileSuppressed(p))) {
    const exts = [...new Set(files.map((p) => extname(p).toLowerCase()))];
    return `${exts.join("、")} 文件`;
  }
  return null;
}

/**
 * 这一份文件**按文件类型**被屏蔽了没有 —— 「按份去掉」那一层。
 *
 * 只看扩展名(小写、带点);没有扩展名的(目录、怪名字)不算。分类那一层不在这里:
 * 分类屏蔽是整条挡,见 `suppressionReasonOfItem`。
 */
export function isFileSuppressed(p: string | null | undefined): boolean {
  if (!p) return false;
  const ext = extname(p).toLowerCase();
  return ext.length > 0 && loadSuppress().extensions.includes(ext);
}

/**
 * 一个节点键 → 用户看得懂的名字。
 *
 * 集合查得到名字(那是用户起的),大类查分组表。都查不到就退回键本身
 * —— 那说明这一条指向的东西已经被删了,说清"是哪一条"比说一个空字符串有用。
 */
function describeNodeKey(key: string): string {
  const parsed = parseSuppressNodeKey(key);
  if (!parsed) return key;
  if (parsed.level === "collection") {
    const c = CollectionRepo.list().find((x) => x.id === parsed.id);
    return c ? `「${c.name}」` : `已删除的分类(${parsed.id})`;
  }
  const g = loadLibraryGroups().find((x) => x.id === parsed.id);
  return g ? `「${g.name}」` : `已删除的大类(${parsed.id})`;
}

/** 重新导出契约里那几个纯函数 —— 调用方(IPC / 界面)不必再多 import 一处。 */
export { EMPTY_LIBRARY_SUPPRESS, parseSuppressNodeKey };
