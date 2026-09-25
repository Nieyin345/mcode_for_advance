/**
 * 上下文继承 —— 「这一步要文献」具体给了它什么。
 *
 * ## 机制:筛,不是找
 *
 * 一次运行开始时,提示词里已经带了发起这次对话挂上的东西 —— 每个附件就是一行
 * `@<清单路径>`(见 `@contracts/library` 的附件机制)。这个模块**只做一件事**:把那些
 * 行按类目筛一遍,把属于节点选中的那几类的**原样**交出去 —— 交出去的是**事实**
 * ({@link ContextLine}:类目、层级、路径),**怎么排版不归它管**(见 `scheduler.ts` 的
 * `composeNodePrompt`)。
 *
 * 它**不去库里翻**,也**不生成新清单**。所以「子代理的上下文和主代理一样」是结构上
 * 成立的,而不是靠两边各自拼出差不多的东西:同一批文件、同一份说明,只是子集。
 *
 * ## 为什么不交给模型判断
 *
 * 「这一步能不能拿到那篇文献」是**确定性**的事。让模型去决定"我要不要去找文献",
 * 得到的答案会随措辞、随上下文长度、随模型版本变 —— 而工作流的意义正是把这类判断
 * 固化下来。能算的就算,算不了的才让模型判断。
 *
 * ## 一个类目都认不出来时**什么都不给**
 *
 * 路径解析不出来(用户自己打了一行以 `@` 开头的字、清单被删了、库搬走了)就当它不
 * 属于任何类目。宁可少给,不要猜着给 —— 猜错的话,子代理会读到一份不属于这一步的
 * 材料,而它没有能力分辨。
 *
 * ## 这个文件**不 import 主进程的任何东西**
 *
 * 三个根路径和两次"按 id 查类目"都从外面传进来(见 {@link ContextLookup})。理由和
 * 调度器那个 `RunPorts` 是同一条:**可验证** —— "一条路径属于哪个类目"是这段代码里
 * 最容易写错的地方(前缀比较、`kind-` 前缀、id 是不透明的),而只有不依赖 electron
 * 和数据库,它才喂得进无头脚本(见 `scripts/scheduler-smoke`)。
 */
import { basename, resolve, sep } from "node:path";
import { isTemplateKind } from "@contracts/templates";
import type { NodeContextKind } from "@contracts/nodeType";

/** 外面要给的东西:两个根,加上两次"这条清单挂着哪个大类"。 */
export interface ContextLookup {
  /** 文献库根(`<数据根>/library`)。 */
  libraryRoot: string;
  /** 模版库根。 */
  templatesRoot: string;
  /**
   * 一个**分类**挂着的大类 id。**返回 `undefined` = 库里没有这个分类**(那是"这不是
   * 一条分类清单"的信号,本模块据此继续往下试条目);返回 `[]` = 有,但它还没挂大类。
   *
   * ⚠️ **必须是查库,不能从文件名猜。** 分类 id 是不透明的,而且 kind 退役后"它属于
   * 哪一类"这件事本身就是用户自己摆的(`library_collections.group_id`)—— 没有任何
   * 可以从 id 推出来的规律。这是本模块唯一一处外来的知识(见文件头"不 import 主进程")。
   */
  groupsOfCollection(collectionId: string): string[] | undefined;
  /**
   * 一条**条目**挂着的大类 id —— 取它所属那些分类的大类,**去重**。语义同
   * {@link groupsOfCollection}。返回 `undefined` = 库里没有这个条目。
   *
   * 一个条目可以同时在好几个分类里,而那些分类可以不挂在同一个大类下(用户把一篇论文
   * 同时收进「文献」和「要精读」两个大类是允许的)。返回 `[]` = 它不属于任何大类
   * (还没归类、或只在回收站里)—— 那时**选任何大类都拿不到它**,因为"它在哪个大类里"
   * 这个问题对它没有答案。宁可拿不到,也不要把它算进一个它并不属于的大类。
   */
  groupsOfItem(itemId: string): string[] | undefined;
}

/** 把路径统一成 `/` 分隔,好在两套前缀之间比较(`relative` 在 Windows 上给的是 `\`)。 */
function slash(path: string): string {
  return resolve(path).split(sep).join("/");
}

/**
 * 提示词里带的所有附件路径。
 *
 * 按**行**取而不是用正则扫全文:一个 tag 的 `content` 就是一行 `@<绝对路径>`
 * (`contentTag.composePromptWithTags` 保证的),而路径里可以有空格 —— 用正则去匹
 * "`@` 后面跟一段路径"会在第一个空格处断掉。
 *
 * 用户自己打的一行 `@随便什么` 也会被取出来,但那没关系:它解析不出类目,下一道就
 * 被丢掉了(这正是"解析不出来什么都不给"那条)。
 */
export function attachmentPathsIn(prompt: string): string[] {
  const out: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    if (!line.startsWith("@")) continue;
    const path = line.slice(1).trim();
    if (path.length > 0) out.push(path);
  }
  return out;
}

/**
 * 一条清单**是什么** —— 类目 + 它在库里占哪一层。
 *
 * 两个字段都是**已经算出来过的**:认类目本来就是这段代码的活,而"整库 / 一个分类 /
 * 单篇"在查表时就已经分开了(`lookup.collectionKind` 和 `lookup.itemKind` 是两次
 * 不同的查询)。早先只把裸路径交出去,于是模型拿到
 * `@D:/…/collections/9f8e7d6c.md` —— **是文献还是笔记?是一整库还是单独一篇?** 两样
 * 都看不出来,只能先读一遍才知道,而它多半会按上下文猜一个(用户实测反馈:资料这一块
 * 得把"是什么类型"一并告诉它)。
 */
export interface ContextRef {
  kind: NodeContextKind;
  level: ContextLevel;
  /**
   * 拿来**查内容**还是**仿格式** —— 由 {@link purposeOfPath} 在认出这条路径的那一刻
   * 一起算好(那时 `lookup` 就在手上),不是后面按类目名反推。
   *
   * 早先这个判断是 `contextPurposeOf(kind)` 一个纯函数,靠"类目名属不属于文献库那八类"
   * 分。kind 退役后资料库那侧的类目换成了用户自己起的大类名,那个判据就再也不成立了 ——
   * 详见 {@link purposeOfPath}。
   */
  purpose: ContextPurpose;
}

/**
 * 一条清单覆盖的范围。
 *
 * | 值 | 是什么 |
 * |---|---|
 * | `all` | 整库(「全部文献」那一行) |
 * | `collection` | 用户自己分的一个分类 |
 * | `item` | 单独一篇/一本/一条 |
 * | `category` | 模版的整个类目 |
 * | `template` | 单条模版 |
 */
export type ContextLevel = "all" | "collection" | "item" | "category" | "template";

/**
 * 交给一个节点的一条资料。
 *
 * **形状是"事实",不是拼好的字符串** —— 怎么排版是提示词那一层的事(见
 * `scheduler.ts` 的 `composeNodePrompt`)。早先这里是 `【文献·单篇】@…` 这样一条拼好
 * 的行,于是"两类东西要分开摆"这个要求就没地方落了:字符串里再也分不出哪条是模版。
 */
export interface ContextLine extends ContextRef {
  /** 清单文件的绝对路径。**原样**交出去 —— 子代理读到的就是主代理读到的那一份。 */
  path: string;
}

/**
 * 一条资料**拿来干什么**。
 *
 * 这两类的用法根本不同,所以提示词里要分开说 —— 用户提这条时说的原话:
 * 「模版的话是仿写,借鉴格式这种;文献、教材、笔记这些是用来查询资料的」。
 *
 * - `material`(**查资料**):文献 / 教材 / 笔记。事实、方法、数据在这些里面,用它
 *   是**从里面找东西**。
 * - `format`(**仿格式**):PPT / LaTeX / Word / 代码 / 配图模版。要的是**样子** ——
 *   排版、章节结构、措辞口吻。照着它写,写这一步自己的内容。
 */
export type ContextPurpose = "material" | "format";

/**
 * 这条清单**是资料还是格式** —— 判据是**它在哪个库里**,不是它的类目叫什么。
 *
 * kind 退役(2026-09-24)之前,这件事靠 `isLibraryKind(kind)` 一眼判出来;kind 没了之后
 * 资料库那侧的类目换成**用户自己的大类**,而大类 id 是用户起的 —— 靠名字猜必然猜错
 * (他完全可以把一个大类叫 `latex`)。两个库**连根目录都不是同一个**,那才是结构上
 * 成立的区别。
 *
 * 认不出来的(库和模版之外的自定义路径)按资料处理 —— 宁可多摆一组,不要因为一个路径
 * 形状没料到就把用户挂的东西整个藏掉。
 */
function purposeOfPath(abs: string, lookup: ContextLookup): ContextPurpose {
  return abs.startsWith(`${slash(lookup.templatesRoot)}/`) ? "format" : "material";
}

/**
 * 一条附件行指的东西是什么。认不出来返回 `null`。
 *
 * 三条路,对应清单的三种落点:
 *
 * | 路径 | 是什么 | `kinds` |
 * |---|---|---|
 * | `<库根>/collections/group-<大类 id>.md` | 整个大类 | 那个大类自己 |
 * | `<库根>/collections/<分类 id>.md` | 一个分类 | 它挂着的大类 |
 * | `<库根>/collections/<条目 id>.md` | 单独一篇 | 它所属分类挂着的大类(去重) |
 * | `<模版根>/.manifests/<类目>[/<名字>].md` | 模版的类目/单条 | 那个类目 |
 *
 * ## `kinds` 是**数组**,不是单个
 *
 * 用户可以把一篇同时收进两个分类,而那两个分类挂在**不同的大类**下 —— 那时这一篇
 * 确实同时属于两个类目,而节点只要勾了其中一个就该拿到它。做成单个字段的话得在两个
 * 里挑一个扔一个,而"扔"的那个方向没有任何依据。
 *
 * ## 前三条的 id 一律**靠查库**,不靠文件名猜
 *
 * 分类与条目的 id 都是不透明的(条目文件名甚至是 sha256),"从名字看出它是文献还是
 * 笔记"必然猜错 —— 而且 kind 退役之后"它属于哪一类"本身就是用户自己摆的
 * (`library_collections.group_id`),推不出来。第四条不用查:模版清单的**目录名就是
 * 类目本身**。
 *
 * ⚠️ **`kind-<库>.md` 这个老形状没有了**(kind 退役,2026-09-24):整库清单改名成
 * `group-<大类 id>.md`。老库里存着的 `kind-paper.md` 这种挂载记录**落到最后那条
 * `return null`** —— 它认不出来,于是这一步少一份资料,而不是拿到一份错类目的。
 */
function resolveRef(path: string, lookup: ContextLookup): Omit<ContextRef, "kind"> & { kinds: string[] } | null {
  const abs = slash(path);

  const libPrefix = `${slash(lookup.libraryRoot)}/collections/`;
  if (abs.startsWith(libPrefix)) {
    const stem = basename(abs).replace(/\.md$/i, "");
    // 大类清单:`group-<大类 id>.md`,整个大类一次挂上。**这一条先试** —— 一个分类的
    // id 恰好叫 `group-docs` 的概率远小于把整大类清单误当成某个分类。
    if (stem.startsWith("group-")) {
      return { kinds: [stem.slice("group-".length)], level: "all", purpose: purposeOfPath(abs, lookup) };
    }
    // 分类清单:`<分类 id>.md`。查得到就是分类(哪怕它还没挂大类 —— 那时 `kinds` 空,
    // 于是任何类目都匹配不上,与它"不属于任何一个大类"的事实一致)。
    const byCollection = lookup.groupsOfCollection(stem);
    if (byCollection !== undefined) {
      return { kinds: byCollection, level: "collection", purpose: purposeOfPath(abs, lookup) };
    }
    // 条目清单:`<条目 id>.md`,取它所属分类挂着的大类。
    const byItem = lookup.groupsOfItem(stem);
    if (byItem !== undefined) {
      return { kinds: byItem, level: "item", purpose: purposeOfPath(abs, lookup) };
    }
    return null;
  }

  const tplPrefix = `${slash(lookup.templatesRoot)}/.manifests/`;
  if (abs.startsWith(tplPrefix)) {
    // 整个类目那份清单的文件名**带 `.md`**(`latex.md`),单条模版那份是个子目录
    // (`latex/某模板.md`)—— 两处都要把 `.md` 剥掉才比得到类目名。
    const rest = abs.slice(tplPrefix.length).split("/");
    const head = (rest[0] ?? "").replace(/\.md$/i, "");
    if (!isTemplateKind(head)) return null;
    // 目录里还有一层 = 单条模版;只有一层 = 整个类目的清单。
    return { kinds: [head], level: rest.length > 1 ? "template" : "category", purpose: purposeOfPath(abs, lookup) };
  }

  return null;
}

/**
 * 一个附件路径是什么 —— 类目(`kinds` 里**与 `wanted` 相交的**那个)+ 层级 + 用途。
 *
 * 认不出来返回 `null`。`wanted` 不给时取 `kinds` 的第一个(冒烟那组"路径→类目"的断言
 * 就是这么用的:它问的是"这条路径认得出什么",不问"某个节点要不要它")。
 *
 * 传了 `wanted` 时**取交集里那个** —— 显示出来的类目就是用户勾选时看到的那个词,而不是
 * "它恰好也属于"的另一个。一篇同时挂在两个大类下时,`【文献】` 还是 `【模版】` 取决于
 * 这一步要的是哪个,这才是模型该看到的。
 */
export function contextRefOfPath(
  path: string,
  lookup: ContextLookup,
  wanted?: readonly NodeContextKind[],
): ContextRef | null {
  const base = resolveRef(path, lookup);
  if (base === null) return null;
  const { kinds, ...rest } = base;
  const pick =
    wanted === undefined ? kinds[0] : wanted.find((w) => kinds.includes(w)) ?? kinds[0];
  if (pick === undefined) return null;
  return { ...rest, kind: pick };
}

/**
 * 一个附件路径属于哪个类目。认不出来返回 `null`。
 *
 * 只要类目、不要层级的调用方用这个(冒烟里那组路径→类目的断言就是)。
 */
export function contextKindOfPath(path: string, lookup: ContextLookup): NodeContextKind | null {
  return contextRefOfPath(path, lookup)?.kind ?? null;
}

/**
 * 这次运行该交给某个节点的资料 —— 从主对话带着的那些里,挑出节点选中的那几类。
 *
 * 返回的是**事实**(类目 / 层级 / 路径),不是拼好的行:怎么摆由提示词那一层决定
 * (见 {@link ContextLine})。顺序和它们在主提示词里出现的顺序一致 —— 这一步看到的
 * 东西和主对话看到的顺序一样,排查时对得上。去重按**路径** —— 同一条清单被挂了两次
 * (用户挂一次、AI 又挂一次)只给一条。
 */
export function inheritContextLines(
  prompt: string,
  kinds: readonly NodeContextKind[],
  lookup: ContextLookup,
): ContextLine[] {
  if (kinds.length === 0) return [];
  const wanted = new Set<string>(kinds);
  const out: ContextLine[] = [];
  const seen = new Set<string>();
  for (const path of attachmentPathsIn(prompt)) {
    const base = resolveRef(path, lookup);
    if (base === null) continue;
    // **任一命中就收** —— 这一条可能同时属于几个类目(见 `resolveRef`),节点勾了其中
    // 一个就该拿到它。不收的话要挑一个"它主要属于"的,而那个方向没有依据。
    const hit = base.kinds.find((k) => wanted.has(k));
    if (hit === undefined) continue;
    const key = slash(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const { kinds: _all, ...rest } = base;
    out.push({ ...rest, kind: hit, path });
  }
  return out;
}

/**
 * 类目 id → 提示词里那个词。
 *
 * ⚠️ **这不是界面文案**(界面那份走 i18n):提示词从头到尾是中文的,而它拼进去的是
 * **给人看的那几个词** —— 拿 i18n 的 key 拼,模型只会读到 `latex`。两处各有一份,那是
 * 它们服务的东西不同,不是重复。
 *
 * **模版那几个带「模版」二字**:一来和用户在下拉里看到的那些逐字一致 —— 模型读到的词
 * 和用户选的时候看到的是同一个,排查时对得上;二来光写 `【Word·类目】` 有歧义(是 Word
 * 这个软件,还是 Word 那一类模版)。多 6 个字节换掉这个歧义,值。(分组标题已经说了
 * "当格式仿",那是**用法**;这个抬头说的是**它是什么**,两件事,不重复。)
 *
 * ## kind 退役:资料库那半边现在**认不出名字**
 *
 * 从前这里还有 `paper` / `textbook` / `note` 三个词,因为那时类目是固定的八个。现在
 * 资料侧的类目是**用户自己的大类**(`group-<id>.md` 那个 id),名字只有库知道 —— 而本
 * 模块是纯件、不 import 主进程(见文件头)。所以走到下面那条回落:抬头显示类目 id 原文。
 *
 * 那是**刻意接受的**:大类 id 通常是用户看得懂的词(`docs`、`latex`),而且**分组标题已经
 * 说清了它拿来干什么**("当资料查" / "当格式仿")—— 模型缺的从来不是"它叫什么",是"拿它
 * 干嘛"。要让它精确显示大类名,得由宿主注入一份 id→name 的映射(见 `ContextLookup`),
 * 那一步等真的有人抱怨了再做。
 */
export const KIND_LABEL: Record<string, string> = {
  ppt: "PPT 模版",
  latex: "LaTeX 模版",
  word: "Word 模版",
  code: "代码模版",
  image: "配图模版",
};

/** 一类在提示词里的显示名:内置表兜底,**最后退回类目 id 原文** ——
 *  显示一个没见过的 id 也比显示 undefined 强。 */
export function kindLabel(kind: NodeContextKind): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 一条清单覆盖的范围 → 提示词里那个词。见 {@link ContextLevel}。 */
export const LEVEL_LABEL: Record<ContextLevel, string> = {
  all: "整库",
  collection: "分类",
  item: "单篇",
  category: "类目",
  template: "单条",
};
