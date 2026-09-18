/**
 * 清单文件的生成 —— 「把库挂进对话」这条链路的落点。
 *
 * 机制**刻意与文件附件一致**:提示词里只放一行 `@<清单路径>`,正文由 agent 用 Read
 * 工具自己去读。这样加十个库进上下文也不会把提示词撑爆,而且库改了之后清单是**当场
 * 重写**的,不会读到过期内容。
 *
 * ## 为什么要单独一个模块
 *
 * 以前这两段写在 `ipc/library.ts` 的 handler 里 —— 只有渲染端调得到。现在 **AI 也要
 * 挂库**(它得能说"我把这个分类加到上下文里了",而且用户界面上要真的多出那个附件),
 * 走的是 MCP 工具,不经过 IPC。实现放这里,两边共用一份,免得"用户挂的清单"和
 * "AI 挂的清单"慢慢长出两种格式。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "@contracts/ipc";
import {
  formatAuthorList,
  type LibraryItem,
  type LibraryKind,
} from "@contracts/library";
import { trashCollectionId } from "./trash.js";
import { kindDisplayName, kindGroupPromptOf, kindMeta } from "./kindRegistry.js";
import { CollectionRepo, LibraryLinkRepo, LibraryRepo, NoteRepo } from "@main/store/repositories.js";
import { importGenericFiles } from "./fileImport.js";
import { suppressionReasonOfItem } from "./suppress.js";
import { sendToRenderer } from "@main/window.js";
import { libraryRoot, fromLibraryRelative } from "./paths.js";

export interface ManifestResult {
  /** 写好的清单文件绝对路径。找不到对象时是空串。 */
  path: string;
  /** 清单里有几条(分类) / 恒为 1(单篇)。 */
  count: number;
  /** 展示名 —— AI 挂库时要用它做 chip 上的字。 */
  name: string;
}

/** 清单的落点。与 `collections/**` 同处库根下,用户翻得到。 */
function manifestDir(): string {
  const dir = join(libraryRoot(), "collections");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 单独一篇的清单 —— 用户在「+」菜单里展开分类、只挑了一篇时用它。
 *
 * 与整库清单刻意长得不一样:整库那张表是**索引**(让模型知道库里有什么),这一份
 * 是**这一篇该怎么读**(读哪个文件、元数据够不够、我自己在上面记了什么)。
 */
export function writeItemManifest(itemId: string): ManifestResult {
  const item = LibraryRepo.get(itemId);
  if (!item) return { path: "", count: 0, name: "" };

  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push("");
  const meta = [
    item.authors.length > 0 ? formatAuthorList(item.authors, 6) : undefined,
    item.year ? String(item.year) : undefined,
    item.venue,
    item.doi ? `DOI: ${item.doi}` : undefined,
  ].filter((x): x is string => Boolean(x));
  if (meta.length > 0) {
    lines.push(meta.join(" · "));
    lines.push("");
  }

  lines.push("## 文件");
  lines.push("");
  if (item.mdPath) {
    lines.push(`Markdown(读这个):\`${fromLibraryRelative(item.mdPath)}\``);
  } else if (item.pdfPath) {
    lines.push(`PDF(尚未转 Markdown,按 PDF 处理):\`${fromLibraryRelative(item.pdfPath)}\``);
  } else {
    lines.push("(这一条还没有文件 —— 既没有 PDF 也没有 Markdown。)");
  }

  const notes = NoteRepo.listByItem(item.id);
  if (notes.length > 0) {
    lines.push("");
    lines.push("## 我的笔记");
    lines.push("");
    // 多行笔记压成一行 —— 清单是给模型看的列表,换行会把一条拆成几条
    for (const n of notes) lines.push(`- ${n.content.replace(/\s+/g, " ")}`);
  }

  const file = join(manifestDir(), `item-${item.id}.md`);
  writeFileSync(file, lines.join("\n"), "utf8");
  return { path: file, count: 1, name: item.title };
}

/**
 * 清单正文 —— **分类清单与整库清单共用同一份排版**。
 *
 * 抽出来的理由很直接:这两份清单的差别只有"范围"和标题,正文(文献表格 + 摘要 +
 * 我的笔记)一个字都不该不一样。各写一份的话,以后给表格加一列只会加到一边。
 */
function renderItemsManifest(items: LibraryItem[]): string[] {
  // 超过这个条数就不再附摘要 —— 否则清单会长到把 agent 的上下文吃掉
  const INCLUDE_ABSTRACT_UNDER = 50;
  const withAbstract = items.length <= INCLUDE_ABSTRACT_UNDER;

  const lines: string[] = [];
  if (items.length === 0) {
    lines.push("(这里还是空的。可以用文献检索、DOI/BibTeX 导入,或在内嵌浏览器里手动下载。)");
  } else {
    lines.push("## 文献清单");
    lines.push("");
    lines.push("| # | 标题 | 作者 | 年份 | 期刊/会议 | 文件 |");
    lines.push("|---|------|------|------|-----------|-----|");
    items.forEach((item, i) => {
      const authors = formatAuthorList(item.authors, 3).replace(/\|/g, "\\|");
      const title = item.title.replace(/\|/g, "\\|");
      const venue = (item.venue ?? "").replace(/\|/g, "\\|");
      // 优先给 **Markdown 的绝对路径** —— 那才是让 agent 读的格式(排版、公式、
      // 表格都在里头,而且比 PDF 便宜得多)。没有转换产物才退回 PDF,并**显式
      // 标明这是 PDF**,免得 agent 以为手上是 Markdown 而按纯文本去引用。
      const file = item.mdPath
        ? `\`${fromLibraryRelative(item.mdPath)}\``
        : item.pdfPath
          ? `\`${fromLibraryRelative(item.pdfPath)}\`(PDF,尚未转 Markdown)`
          : "（未下载）";
      lines.push(`| ${i + 1} | ${title} | ${authors} | ${item.year ?? ""} | ${venue} | ${file} |`);
    });

    if (withAbstract) {
      lines.push("");
      lines.push("## 摘要");
      items.forEach((item, i) => {
        if (!item.abstract) return;
        lines.push("");
        lines.push(`### ${i + 1}. ${item.title}`);
        const meta = [formatAuthorList(item.authors, 4), item.year, item.venue]
          .filter(Boolean)
          .join(" · ");
        if (meta) lines.push(meta);
        lines.push("");
        lines.push(item.abstract);
      });
    }
  }

  // ── 我的笔记 ──
  // 用户读这篇时随手记的"重点在这""这里没看懂"对模型是最直接的信号,而清单是它
  // 读文献时唯一会看的东西。只列**有笔记的**条目,免得整段都是空标题。
  const withNotes = items
    .map((item) => ({ item, notes: NoteRepo.listByItem(item.id) }))
    .filter((x) => x.notes.length > 0);
  if (withNotes.length > 0) {
    lines.push("");
    lines.push("## 我的笔记");
    lines.push("");
    for (const { item, notes } of withNotes) {
      lines.push(`### ${item.title}`);
      for (const n of notes) lines.push(`- ${n.content.replace(/\s+/g, " ")}`);
      lines.push("");
    }
  }
  return lines;
}

/** 清单落盘。文件名由调用方给(分类用 id,整库用 kind)。 */
function writeManifest(fileName: string, lines: string[], count: number, name: string): ManifestResult {
  const file = join(manifestDir(), fileName);
  writeFileSync(file, lines.join("\n"), "utf8");
  return { path: file, count, name };
}

/**
 * 整库清单 —— 一个分类一份。每次调用都重写:库的内容随时在变(新下载了 PDF、
 * 改了元数据),缓存清单只会让 agent 读到过期信息。写一个几百 KB 的 Markdown 是
 * 毫秒级的,不值得省。
 */
export function writeCollectionManifest(collectionId: string): ManifestResult {
  const collection = CollectionRepo.list().find((c) => c.id === collectionId);
  const all = LibraryRepo.listByCollection(collectionId);
  const { items, suppressed } = dropSuppressed(all);
  const name = collection?.name ?? collectionId;
  const lines = [`# 文献库:${name}`, "", `共 ${items.length} 篇。`, ""];
  // 提示词**三层叠加,从大到小**:大类(组)→ 类型 → 集合。有大类/类型说明时,集合
  // 的行写在最前 —— 集合的说明最具体,最后读到的东西权重最高。哪层没写就跳过。
  const groupPrompt = items[0] ? kindGroupPromptOf(items[0].kind) : undefined;
  const typePrompt = items[0] ? kindMeta(items[0].kind)?.prompt : undefined;
  for (const p of [groupPrompt, typePrompt]) {
    const text = p?.trim();
    if (text) lines.push(`> ${text}`, "");
  }
  // **这一组的说明**(用户按集合写的)紧跟其后 —— 模型一打开清单就先读到"这组东西
  // 该怎么处理"。没有就不注这一段。
  const prompt = collection?.prompt?.trim();
  if (prompt) {
    lines.push(`> 处理这一组时:${prompt}`, "");
  }
  if (suppressed > 0) {
    lines.push(`(屏蔽规则挡掉了 ${suppressed} 篇,不在这次范围内。)`, "");
  }
  lines.push(...renderItemsManifest(items));
  return writeManifest(`${collectionId}.md`, lines, items.length, name);
}

/**
 * 从一批条目里剔掉被屏蔽的。
 *
 * **整库与分类清单也要过这道筛子** —— 否则"屏蔽了某个集合"只在挂单篇时生效,
 * 用户挂一次「全部文献」就把它整份带进来了。硬过滤的意思是**所有进上下文的路**,
 * 不是"我能想到的那一条"。
 *
 * 返回剔掉了多少:调用方要把这个数写进清单开头 —— 少列了东西而模型不知道,
 * 它会以为"库里就这些"。
 */
function dropSuppressed(items: LibraryItem[]): { items: LibraryItem[]; suppressed: number } {
  const kept: LibraryItem[] = [];
  let suppressed = 0;
  for (const item of items) {
    if (suppressionReasonOfItem(item.id)) suppressed += 1;
    else kept.push(item);
  }
  return { items: kept, suppressed };
}

/** 三个库各自的中文名 —— 清单是给模型读的中文内容,不是界面文案,所以不走 i18n。
 *  ⚠️ 统一资料库后 kind 开放注册,这里不再穷举:显示名一律走注册表
 *  (`kindDisplayName`,内置 8 类的出厂名与这张表一致)。保留为空占位会被误用,删。 */

/**
 * 整库清单 —— 「全部文献 / 全部教材 / 全部笔记」那一行挂进对话时用的。
 *
 * 与分类清单同一份排版,三处不同:
 *
 *  1. 范围是整个库(`LibraryRepo.listByKind`,**不分页**) —— 那 200 条的默认上限是
 *     给左栏那棵树用的,清单必须全量,否则模型以为库里就这些;
 *  2. **回收站里的不算**。挂"全部文献"是要 AI 读用户留着的那些,把被丢进回收站的
 *     也塞给它,它就可能去引用一篇用户已经不要了的东西。剔掉多少如实写在开头;
 *  3. **屏蔽规则挡掉的不算** —— 同一条道理,而且用户明确要求屏蔽是硬过滤(见
 *     `main/library/suppress.ts`)。这一条与上一条**都是"不该进来的东西不进来"**,
 *     所以剔掉的数合在一处说;
 *  4. **类型说明跟着清单走** —— 标题用注册表的显示名(统一资料库后 kind 是开放的,
 *     用户自建的类型同样有中文名),`prompt` 有内容就注在开头:模型一打开就知道
 *     "这一类东西是什么、该怎么处理"。
 */
export function writeKindManifest(kind: LibraryKind): ManifestResult {
  const all = LibraryRepo.listByKind(kind);
  const trashId = trashCollectionId(kind);
  const trashed = new Set(trashId ? LibraryRepo.listByCollection(trashId).map((i) => i.id) : []);
  const { items, suppressed } = dropSuppressed(all.filter((i) => !trashed.has(i.id)));

  const label = kindDisplayName(kind);
  const lines = [`# 全部${label}`, "", `共 ${items.length} 篇。`, ""];
  // 大类(组)说明在最外层,类型说明其次 —— 哪层写了就注,没写就跳过。
  const groupPrompt = kindGroupPromptOf(kind);
  if (groupPrompt) {
    lines.push(`> ${groupPrompt.trim()}`, "");
  }
  const prompt = kindMeta(kind)?.prompt;
  if (prompt) {
    lines.push(`> 关于「${label}」这类资料:${prompt}`, "");
  }
  if (trashed.size > 0) {
    lines.push(`(回收站里另有 ${trashed.size} 篇,不在这次范围内。)`, "");
  }
  if (suppressed > 0) {
    lines.push(`(屏蔽规则挡掉了 ${suppressed} 篇,不在这次范围内。)`, "");
  }
  lines.push(...renderItemsManifest(items));
  return writeManifest(`kind-${kind}.md`, lines, items.length, `全部${label}`);
}

/**
 * 把一条附件挂到某个会话的**输入框**上。
 *
 * ## 实现只有这一份
 *
 * 两个调用方:IPC 的 `library.attachToChat`(用户在左栏右键「添加到当前对话」)与
 * MCP 的 `library_attach_to_chat`(AI 自己挂)。**必须共用** —— 用户的原话是
 * 「他对文件系统的操作要和用户在 ui 的操作一样」,而这条链路连"效果一样"都不够,
 * 它俩本来就该是同一件事:挂上去之后界面上多出同一个附件 chip,下一条消息带上
 * 同一份清单。各写一份迟早分叉。
 *
 * ## 为什么绕主进程
 *
 * 左栏和输入框不是同一棵组件树,而附件要发给**指定会话**的输入框。所以:主进程先生成
 * 清单(每次调用重写,保证不过期),再用 `composer:attach` 广播;那个会话的 ChatPane
 * 认领后往输入框里加 chip。这正是 AI 挂库走的同一条路。
 *
 * ## 附件键的词汇表
 *
 * 三个前缀,与渲染端 `contentTag.ts` 里那份**必须一致**(算出来不一样的话,同一份
 * 东西会被当成两样,去重就失效了):
 *
 *   `c:<分类 id>`   一个分类(清单是"这个库里有什么")
 *   `i:<条目 id>`   单独一篇(清单是"这一篇该怎么读")
 *   `k:<库>`        整个库(「全部文献 / 全部教材 / 全部笔记」那一行)
 *
 * ## 挂一条条目时会**连它关联的一起挂上**(一跳)
 *
 * 见 `expandLinks`。用户的原话:「只要是引用的存在关联,就把关联的也挂上去,本身引用的
 * 也要挂上去」—— 而且「所有的这些文件,包括最开始的都是平级的」:入口不被特殊对待,
 * 它和它关联的东西各自写一份自己的清单、各推一次 attach,界面上就是多出几个平级的 chip。
 */
export function attachToChat(
  sessionId: string,
  key: string,
): { ok: boolean; name?: string; count?: number; error?: string } {
  const prefix = key.slice(0, 2);
  const id = key.slice(2);

  // **屏蔽是硬过滤,而且入口第一个过。** 用户的原话:「就算是我手动挂的一个文件,
  // 只要是屏蔽状态,也挂不上去」—— 所以这道门在解析出目标之后、写清单之前,入口
  // 与关联走的是同一个 `checkSuppressed`。不能等挂完再挑:写清单会把文件路径算出来,
  // 那已经是"读了"。
  //
  // 只对 `i:` 判 —— 分类与整库没有"自己所属的集合/类型",它们是一组东西的入口,
  // 组里的条目各自在展开时被判(见 `writeCollectionManifest` 那边?没有 —— 分类
  // 清单整份就是给 agent 的索引,逐条过滤是下一步的事)。
  if (prefix === "i:" && id) {
    const reason = suppressionReasonOfItem(id);
    if (reason) {
      return { ok: false, error: `${reason}被屏蔽了(设置 → 资料库类型)` };
    }
  }

  let res: ManifestResult;
  if (prefix === "i:" && id) res = writeItemManifest(id);
  else if (prefix === "c:" && id) res = writeCollectionManifest(id);
  else if (prefix === "k:" && kindMeta(id) !== undefined) res = writeKindManifest(id);
  else return { ok: false, error: `无法识别的附件键:${key}` };

  if (!res.path) {
    const what = prefix === "i:" ? `条目 ${id}` : prefix === "c:" ? `分类 ${id}` : `库 ${id}`;
    return { ok: false, error: `找不到${what}` };
  }

  // 关联的展开凑在**入口那一条先推出去之后**:入口一定是第一个 chip,后面才是它带来
  // 的那一串。挂在别处(比如先算完再一起推)会让"哪个是用户点的"在界面上看不出来。
  const attached = pushAttach(sessionId, key, res);
  if (!attached.ok) return attached;

  const extras = prefix === "i:" && id ? expandLinks(id) : { itemIds: [], failed: 0 };
  let extraFailed = extras.failed;
  // 挡掉了几条 —— 与"挂不上"分开数:一个是用户自己设的规矩生效了,一个是出了问题。
  // 都值得说,但话不一样。
  let extraSuppressed = 0;
  for (const extraId of extras.itemIds) {
    // **关联过的是同一道门** —— 入口与关联在这里完全平级,没有任何一条享有豁免。
    if (suppressionReasonOfItem(extraId)) {
      extraSuppressed += 1;
      continue;
    }
    const extraRes = writeItemManifest(extraId);
    if (!extraRes.path) {
      extraFailed += 1;
      continue;
    }
    // 关联来的条目用 `i:<id>` 键 —— **与用户自己挂的完全同一种 chip**、同样参与
    // 去重。这正是用户要的"平级":入口与关联走同一条路,界面分不出也不必分。
    if (!pushAttach(sessionId, `i:${extraId}`, extraRes).ok) extraFailed += 1;
  }

  // 两种"少挂了"都如实说。用户设了屏蔽就该看见它真的起了作用(否则他会怀疑没生效),
  // 而真的挂不上更要看见 —— 少挂几条而用户不知道,是"AI 到底读了什么"说不清的开端。
  const notes: string[] = [];
  if (extraSuppressed > 0) notes.push(`另有 ${extraSuppressed} 条关联被屏蔽规则挡下`);
  if (extraFailed > 0) notes.push(`另有 ${extraFailed} 条关联没能挂上`);
  if (notes.length > 0) {
    return { ok: true, name: res.name, count: res.count, error: notes.join(";") };
  }
  return { ok: true, name: res.name, count: res.count };
}

/** 推一条 attach 给渲染端。窗口没了就返回 ok:false,调用方自己决定怎么报。 */
function pushAttach(
  sessionId: string,
  key: string,
  res: ManifestResult,
): { ok: boolean; name?: string; count?: number; error?: string } {
  try {
    sendToRenderer(IPC.COMPOSER_ATTACH, {
      channel: IPC.COMPOSER_ATTACH,
      sessionId,
      // 渲染端据此选 appendUniqueLibraryTags / appendUniqueTemplateTags ——
      // 模版那条路走的是 `attachTemplateToChat`(见 templates/store.ts)
      kind: "library",
      key,
      name: res.name,
      manifestPath: res.path,
    });
  } catch {
    // sendToRenderer 自己会对"窗口已经没了"做好防护(见 window.ts),所以这里正常
    // 情况下不会走到。留着纯粹是兜底:挂附件失败不该把整条调用链(IPC / MCP 工具)
    // 一起带崩 —— 调用方看 ok 就够了。
    return { ok: false, error: "窗口没开着,挂不上去" };
  }
  return { ok: true, name: res.name, count: res.count };
}

/**
 * 一条条目**直接关联的**条目 id —— 展开一跳的全部结果。
 *
 * ## 只展开一跳
 *
 * 关联可以成网,递归展开会在几张图之间无限绕,也会一次挂上几十条。一跳是
 * 「我引用的东西,连同它直接依赖的东西」,符合直觉且可控。用户要的也正是这个:
 * A→B→C 时引用 A 只该挂上 A 和 B。
 *
 * ## 库外路径**先导入成条目**
 *
 * 关联的目标可以是库外的一个绝对路径(用户桌面上的参考资料)。挂载时不把它当一条
 * 裸路径塞进上下文,而是**先导入成 `linked` 条目**再按条目挂 —— 用户定的就是这个
 * (「自动导入成 linked 条目」),而且这样 chip 只有一种形态、去重走的那套键也只有
 * 一套,不必为"库外的"单开一路。`importGenericFiles` 按 `filePath` 去重,所以反复
 * 引用同一个文件不会长出第二条。
 *
 * ## 目标没了就**数出来**,不抛也不吞
 *
 * 写关联时目标可能还在,读的时候已经不在(条目被删、库外文件被移走 —— 那是文件系统
 * 的事,见 db.ts 里那张表的注释:库外路径不做级联)。这里不抛:一条关联坏掉不该让
 * 整个挂载失败。但也**不静默吞掉** —— `failed` 数出来交给调用方,由它并进 `error`
 * 报给用户。少挂几条而用户不知道,是"AI 到底读了什么"说不清的开端。
 */
function expandLinks(itemId: string): { itemIds: string[]; failed: number } {
  const itemIds: string[] = [];
  let failed = 0;
  for (const link of LibraryLinkRepo.linksOf(itemId)) {
    // **只看正向**。`linksOf` 把"谁关联了我"也一并返回(界面要双向展示),但挂载
    // 只跟这个条目**自己指出去**的东西 —— 否则 A 引用了 B,挂 B 的时候会把 A 也带上,
    // 那是"反向爆炸",用户要的不是这个。
    if (link.direction !== "out") continue;
    if (link.targetItemId) {
      itemIds.push(link.targetItemId);
      continue;
    }
    if (!link.targetPath) continue;
    // 库外路径 → 导入成 linked 条目。**此处不建关联**(导入器不管关联)。
    // 文件已经不在了的话导入器会把它记进 errors(不作抛),于是这里数成一条失败。
    const imported = importGenericFiles({ paths: [link.targetPath], mode: "linked" });
    const fresh = imported.items[0]?.id;
    if (fresh) itemIds.push(fresh);
    else failed += 1;
  }
  return { itemIds, failed };
}
