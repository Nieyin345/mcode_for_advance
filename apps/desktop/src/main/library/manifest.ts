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
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "@contracts/ipc";
import type { LibraryItem } from "@contracts/library";
import { trashedItemIds } from "./trash.js";
import { groupPromptOf, loadLibraryGroups } from "./groupRegistry.js";
import { CollectionRepo, LibraryLinkRepo, LibraryRepo, NoteRepo } from "@main/store/repositories.js";
import { aiVisibleFilesOf, extOf, importGenericFiles } from "./fileImport.js";
import { suppressionReasonOfItem } from "./suppress.js";
import { sendToRenderer } from "@main/window.js";
import { libraryRoot } from "./paths.js";

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
  // IPC 的「+」菜单可直接调用这里，不经过 attachToChat 的入口过滤。
  if (!item || trashedItemIds().has(itemId)) return { path: "", count: 0, name: "" };

  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push("");
  if (item.url) {
    lines.push(`来源:${item.url}`);
    lines.push("");
  }

  // 转录与原件**一起**给(见 `readableFilesOf`):先读转录,拿不准再对照原件。
  // 按文件类型屏蔽的那份不给(`aiVisibleFilesOf`):屏蔽 pdf → 只剩转录。
  lines.push("## 文件");
  lines.push("");
  const files = aiVisibleFilesOf(item);
  if (files.markdown) {
    lines.push(`Markdown 转录(先读这个):\`${files.markdown}\``);
    if (files.original) {
      lines.push(`原件(转录里的图表、公式、版式拿不准时再对照):\`${files.original}\``);
    }
  } else if (files.original) {
    lines.push(`${originalLabel(files.original, files.hasTranscript)}:\`${files.original}\``);
  } else {
    lines.push("(这一条还没有文件 —— 既没有原件也没有 Markdown。)");
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
 * 只给原件时,那一行的说法:PDF / 目录 / 其它文件各有各的读法。
 *
 * `hasTranscript`:转录其实是有的、只是按屏蔽设置不给 —— 那就**不说**「尚未转 Markdown」
 * (那句是假话,还会引着模型去要一份转录)。
 */
function originalLabel(abs: string, hasTranscript: boolean): string {
  if (extOf(abs) === ".pdf") return hasTranscript ? "PDF" : "PDF(尚未转 Markdown,按 PDF 处理)";
  try {
    if (statSync(abs).isDirectory()) return "目录(先列出里面的文件再读)";
  } catch {
    /* 文件不在了:仍按文件说,路径照给 —— 读的时候自然会报缺 */
  }
  return hasTranscript ? "文件(按原格式读)" : "文件(没有 Markdown 转录,按原格式读)";
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
    lines.push("(这里还是空的。可以从本地导入文件,或让 AI 用 library_* 工具往里加。)");
  } else {
    lines.push("## 条目清单");
    lines.push("");
    lines.push("| # | 标题 | 文件 |");
    lines.push("|---|------|-----|");
    items.forEach((item, i) => {
      const title = item.title.replace(/\|/g, "\\|");
      // 优先给 **Markdown 转录的绝对路径** —— 那才是让 agent 读的格式(排版、公式、
      // 表格都在里头,而且比 PDF 便宜得多),括号里一起给原件(见 `readableFilesOf`)。
      // 没有转录才退回原件;是 PDF 就**显式标明**,免得 agent 以为手上是 Markdown。
      // 按文件类型屏蔽的那份不给(`aiVisibleFilesOf`)。
      const f = aiVisibleFilesOf(item);
      const file = f.markdown
        ? `\`${f.markdown}\`` + (f.original ? `(原件 \`${f.original}\`)` : "")
        : f.original
          ? `\`${f.original}\`` + (extOf(f.original) === ".pdf" && !f.hasTranscript ? "(PDF,尚未转 Markdown)" : "")
          : "（未下载）";
      lines.push(`| ${i + 1} | ${title} | ${file} |`);
    });

    if (withAbstract) {
      lines.push("");
      lines.push("## 摘要");
      items.forEach((item, i) => {
        if (!item.abstract) return;
        lines.push("");
        lines.push(`### ${i + 1}. ${item.title}`);
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
  const trashed = trashedItemIds();
  const trashedCount = all.filter((i) => trashed.has(i.id)).length;
  const { items, suppressed } = dropSuppressed(all.filter((i) => !trashed.has(i.id)));
  const name = collection?.name ?? collectionId;
  const lines = [`# 资料库:${name}`, "", `共 ${items.length} 条。`, ""];
  // 提示词**两层叠加,从大到小**:大类(组)→ 集合。大类说明经 `collection.groupId`
  // 查（kind 退役,不再是"从条目反查类型"）。哪层没写就跳过。
  const groupPrompt = collection?.groupId ? groupPromptOf(collection.groupId) : undefined;
  if (groupPrompt?.trim()) lines.push(`> ${groupPrompt.trim()}`, "");
  // **这一组的说明**(用户按集合写的)紧跟其后 —— 模型一打开清单就先读到"这组东西
  // 该怎么处理"。没有就不注这一段。
  const prompt = collection?.prompt?.trim();
  if (prompt) {
    lines.push(`> 处理这一组时:${prompt}`, "");
  }
  if (trashedCount > 0) {
    lines.push(`(回收站里另有 ${trashedCount} 篇,不在这次范围内。)`, "");
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

/**
 * 整个**大类**的清单 —— 左栏右键大类标题「添加到当前对话」时用的。
 *
 * 用户的要求是「每一级右键都可以选择加入到当前对话」。大类是**最外那一级**,它的
 * 范围是"这个大类下注册着的每个小类"(用户自己的组表说了算,见 `loadLibraryGroups`)。
 *
 * 与整库清单同一套规矩(那是这条路的最近亲,只差一个范围):
 *
 *  1. 逐个分类取全量(`listByCollection`,不分页);
 *  2. **回收站里的不算** —— 回收站全库共用,按条目 id 剔;
 *  3. **屏蔽规则挡掉的不算**,剔掉的数如实写在开头;
 *  4. 大类自己的 `prompt` 排在最前(它是这一层最外层的说明),各分类的说明跟在
 *     对应小节的标题下 —— 模型读到哪一组就看到哪一组的处理方式。
 *
 * ## 为什么按小类**分节**,而不是把所有条目混成一长串
 *
 * 大类底下的东西本来就不止一类(「文档」下面有论文 / 教材 / 笔记…),而每类各有各的
 * 说明与用途(`purpose`)。混成一串的话,模型分不出哪几篇是"照着写的格式"、哪几篇是
 * "读的资料"。分节也不额外花什么 —— 标题本来就只是一行。
 */
export function writeGroupManifest(groupId: string): ManifestResult {
  const group = loadLibraryGroups().find((g) => g.id === groupId);
  if (!group) return { path: "", count: 0, name: "" };

  const lines: string[] = [`# ${group.name}`, ""];
  const groupPrompt = group.prompt?.trim();
  if (groupPrompt) lines.push(`> ${groupPrompt}`, "");

  // 回收站**全库共用一个** —— 这道筛子按**条目 id** 过(`trashedItemIds`)。
  const trashed = trashedItemIds();
  let total = 0;
  let trashedTotal = 0;
  let suppressedTotal = 0;
  // 挂在这个大类下的**全部分类**（group_id 直挂，kind 退役）。
  for (const c of CollectionRepo.list().filter((c) => c.groupId === groupId)) {
    const all = LibraryRepo.listByCollection(c.id);
    if (all.length === 0) continue;
    const inGroup = all.filter((i) => trashed.has(i.id));
    const { items, suppressed } = dropSuppressed(all.filter((i) => !trashed.has(i.id)));
    trashedTotal += inGroup.length;
    suppressedTotal += suppressed;
    if (items.length === 0) continue;

    lines.push(`## ${c.name}`, "");
    const prompt = c.prompt?.trim();
    if (prompt) lines.push(`> ${prompt}`, "");
    lines.push(...renderItemsManifest(items));
    total += items.length;
  }

  // 少列了东西而模型不知道,它会以为"库里就这些" —— 与另两条清单一句话都不差。
  if (trashedTotal > 0) {
    lines.push("", `(回收站里另有 ${trashedTotal} 篇,不在这次范围内。)`);
  }
  if (suppressedTotal > 0) {
    lines.push("", `(屏蔽规则挡掉了 ${suppressedTotal} 篇,不在这次范围内。)`);
  }
  // 一件都没有:标题下面如实说,而不是给一份只有标题的空清单
  if (total === 0 && trashedTotal === 0 && suppressedTotal === 0) {
    lines.push("(这个大类下还没有资料。)");
  }
  return writeManifest(`group-${groupId}.md`, lines, total, group.name);
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
 * 四个前缀,与渲染端 `contentTag.ts` 里那份**必须一致**(算出来不一样的话,同一份
 * 东西会被当成两样,去重就失效了):
 *
 *   `c:<分类 id>`   一个分类(清单是"这个分类里有什么")
 *   `i:<条目 id>`   单独一篇(清单是"这一篇该怎么读")
 *   `g:<大类 id>`   整个大类(左栏那一**段**,含段下所有分类的资料)
 *   （`k:<库>` 是 kind 时代的键,已随 kind 退役删除。）
 *
 * 四级前缀与左栏那四级一一对应 —— 用户的要求是「每一级右键都可以选择加入到当前对话」,
 * 所以每一级都得有一个键。`g:` 是最后补上的那一级(它范围最大:一个大类下所有小类)。
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
  // 与关联走的是**同一道判定**(`suppress.ts` 的 `suppressionReasonOfItem`)。不能等
  // 挂完再挑:写清单会把文件路径算出来,那已经是"读了"。
  //
  // 只对 `i:` 判 —— 分类与整库没有"自己所属的集合/类型",它们是一组东西的入口。
  // **组里的条目各自在展开时被判**:分类清单走 `dropSuppressed`(见它上面那段),
  // 整库 / 大类清单同样走它(回收站与屏蔽在那里一起剔,剔掉的数写在清单开头)。也就是说
  // 这里不判**不是**漏了 —— 那三处有它们自己的一道门,而且是逐条的。
  if (prefix === "i:" && id) {
    const reason = suppressionReasonOfItem(id);
    if (reason) {
      return { ok: false, error: `${reason}被屏蔽了(设置 → 资料库类型)` };
    }
    // **回收站里的挂不上**，与屏蔽同一条理由：用户在左栏把一篇丢进回收站，意思就是
    // "我不要它了"。挂进上下文是"让 AI 读它"，两件事直接冲突 —— 而它比屏蔽更隐蔽：
    // 回收站里的条目在左栏是**看得见**的（它就摆在回收站那一行下面），所以没有任何
    // 视觉提示告诉用户"这一条挂不上"。分类 / 整库 / 大类那三条路则由清单生成时的
    // `trashedItemIds()` 逐条剔掉（剔掉的数写在清单开头）。逐条挂的那条路没有清单
    // 可剔，所以这道门必须在这里。
    if (trashedItemIds().has(id)) {
      return { ok: false, error: "它在回收站里 —— 先还原出来再挂到对话上" };
    }
  }

  let res: ManifestResult;
  if (prefix === "i:" && id) res = writeItemManifest(id);
  else if (prefix === "c:" && id) res = writeCollectionManifest(id);
  else if (prefix === "g:" && id) res = writeGroupManifest(id);
  else return { ok: false, error: `无法识别的附件键:${key}` };

  if (!res.path) {
    const what =
      prefix === "i:"
        ? `条目 ${id}`
        : prefix === "c:"
          ? `分类 ${id}`
          : `大类 ${id}`;
    return { ok: false, error: `找不到${what}` };
  }

  // 关联的展开凑在**入口那一条先推出去之后**:入口一定是第一个 chip,后面才是它带来
  // 的那一串。挂在别处(比如先算完再一起推)会让"哪个是用户点的"在界面上看不出来。
  const attached = pushAttach(sessionId, key, res);
  if (!attached.ok) return attached;

  const extras = prefix === "i:" && id ? expandLinks(id) : { itemIds: [], failed: 0 };
  let extraFailed = extras.failed;
  const trashedExtras = extras.itemIds.length > 0 ? trashedItemIds() : null;
  // 挡掉了几条 —— 与"挂不上"分开数:一个是用户自己设的规矩生效了,一个是出了问题。
  // 都值得说,但话不一样。
  let extraSuppressed = 0;
  let extraTrashed = 0;
  for (const extraId of extras.itemIds) {
    // **关联过的是同一道门** —— 入口与关联在这里完全平级,没有任何一条享有豁免。
    if (suppressionReasonOfItem(extraId)) {
      extraSuppressed += 1;
      continue;
    }
    // 关联与入口平级:用户丢进回收站的条目不能借关联绕过入口的拒挂规则。
    if (trashedExtras?.has(extraId)) {
      extraTrashed += 1;
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
  if (extraTrashed > 0) notes.push(`另有 ${extraTrashed} 条关联在回收站里,未挂到对话`);
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
      // 渲染端据此选 appendUniqueLibraryTags(独立模版库退役后只剩这一种)
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
