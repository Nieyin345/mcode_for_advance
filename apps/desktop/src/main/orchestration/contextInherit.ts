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
import { isLibraryKind, type LibraryKind } from "@contracts/library";
import { isTemplateKind } from "@contracts/templates";
import type { NodeContextKind } from "@contracts/nodeType";

/** 外面要给的三样东西:两个根,和两次按 id 查类目。 */
export interface ContextLookup {
  /** 文献库根(`<数据根>/library`)。 */
  libraryRoot: string;
  /** 模版库根。 */
  templatesRoot: string;
  /** 一个分类属于哪个库。查不到返回 `undefined`。 */
  collectionKind(id: string): LibraryKind | undefined;
  /** 一条文献/教材/笔记属于哪个库。查不到返回 `undefined`。 */
  itemKind(id: string): LibraryKind | undefined;
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
 *
 * 判据是现成的、而且是**结构上**成立的:`NodeContextKind` 本来就是
 * `LibraryKind | TemplateKind` 两个不相交的集合拼出来的(见 `NODE_CONTEXT_KINDS`),
 * 两个库连根目录都不是同一个。所以这不是一条要维护的规则,是两个库本来就有的区别。
 */
export function contextPurposeOf(kind: NodeContextKind): "material" | "format" {
  return isLibraryKind(kind) ? "material" : "format";
}

/**
 * 一条附件行指的东西是什么。认不出来返回 `null`。
 *
 * 三条路,对应清单的三种落点:
 *
 * | 路径 | 是什么 |
 * |---|---|
 * | `<库根>/collections/kind-<库>.md` | 整库(「全部文献」那一行) |
 * | `<库根>/collections/<id>.md` | 一个分类,或单独一篇 |
 * | `<模版根>/.manifests/<类目>[/<名字>].md` | 模版的整个类目,或一条模版 |
 *
 * 前两条里 `kind-<库>` 直接读得出来;**其余的靠查库**,不靠文件名猜 —— 分类和条目的
 * id 都是不透明的(条目的文件名甚至是 sha256),"从名字看出它是文献还是笔记"必然猜错。
 * 第三条不用查:模版清单的**目录名就是类目本身**。
 *
 * "一个分类"和"单独一篇"是**两次不同的查询**(`collectionKind` / `itemKind`)——
 * 它们查到的东西不在同一张表里,所以这里分得出来,而模型也正需要知道这个区别:
 * 前者是一组,后者是一个。
 */
export function contextRefOfPath(path: string, lookup: ContextLookup): ContextRef | null {
  const abs = slash(path);

  const libPrefix = `${slash(lookup.libraryRoot)}/collections/`;
  if (abs.startsWith(libPrefix)) {
    const stem = basename(abs).replace(/\.md$/i, "");
    // 整库:`kind-paper.md`。**先试这条**,因为一个 id 恰好叫 `kind-paper` 的概率远小于
    // 把整库清单误当成某个分类。
    if (stem.startsWith("kind-")) {
      const kind = stem.slice("kind-".length);
      if (isLibraryKind(kind)) return { kind, level: "all" };
    }
    const asCollection = lookup.collectionKind(stem);
    if (asCollection !== undefined) return { kind: asCollection, level: "collection" };
    const asItem = lookup.itemKind(stem);
    if (asItem !== undefined) return { kind: asItem, level: "item" };
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
    return { kind: head, level: rest.length > 1 ? "template" : "category" };
  }

  return null;
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
    const ref = contextRefOfPath(path, lookup);
    if (ref === null || !wanted.has(ref.kind)) continue;
    const key = slash(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, path });
  }
  return out;
}

/**
 * 库类目 → 中文名。
 *
 * ⚠️ **这不是界面文案**(界面那份走 i18n,见 `nodeTypes.ts` 的 `CONTEXT_LABEL_ZH`):
 * 提示词从头到尾是中文的,而它拼进去的是**给人看的那几个词** —— 拿 i18n 的 key 拼,
 * 模型只会读到 `paper`。两处因此各有一份,那是它们服务的东西不同,不是重复。
 *
 * **模版那几个带「模版」二字**:一来和 `CONTEXT_LABEL_ZH`(用户在下拉里勾选时看到的那份)
 * 逐字一致 —— 模型读到的词和用户选的时候看到的是同一个,排查时对得上;二来光写
 * `【Word·类目】` 有歧义(是 Word 这个软件,还是 Word 那一类模版)。多 6 个字节换掉
 * 这个歧义,值。(分组标题已经说了"当格式仿",那是**用法**;这个抬头说的是**它是什么**,
 * 两件事,不重复。)
 */
export const KIND_LABEL: Record<NodeContextKind, string> = {
  paper: "文献",
  textbook: "教材",
  note: "笔记",
  ppt: "PPT 模版",
  latex: "LaTeX 模版",
  word: "Word 模版",
  code: "代码模版",
  image: "配图模版",
};

/** 一条清单覆盖的范围 → 提示词里那个词。见 {@link ContextLevel}。 */
export const LEVEL_LABEL: Record<ContextLevel, string> = {
  all: "整库",
  collection: "分类",
  item: "单篇",
  category: "类目",
  template: "单条",
};
