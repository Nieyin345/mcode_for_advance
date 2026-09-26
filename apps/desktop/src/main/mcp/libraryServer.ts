/**
 * **mcode-library** —— 库操作的进程内 MCP server,给模型一套"命令集"。
 *
 * ## 为什么是 MCP 工具,而不是一个脚本
 *
 * 用户在「+」菜单挂的附件、左栏的库、右栏的详情,读的都是**内存里那个 sql.js 实例**;
 * 磁盘上的 `mcode.db` 只是它每次变更后整份重写的产物。所以:
 *
 *   - 让 Python 脚本**读** `mcode.db` 是安全的(`<数据根>/workflows/scripts/` 下那些
 *     就是这么干的,快且不弹审批);
 *   - 让 Python 脚本**写**是错的 —— 应用下一次保存会把整份文件覆盖掉,AI 以为建好了
 *     分类,界面上什么都没有。
 *
 * 写操作必须回到主进程,和界面共用同一份 repos。进程内 MCP 是这条路子在本项目里
 * 既有的形态(浏览器工具 `mcode-browser` 就是这么做的),模型看到的是
 * `mcp__mcode-library__<名字>`。
 *
 * ## 工具的分工
 *
 * 读工具(自动放行,不弹审批):collections / search / items / links / templates_list。
 * 写工具(需要用户点头;用户可以在审批时勾"始终允许"):create_collection /
 * import / download / convert / **adopt_markdown** / move / remove / rename /
 * write_note / link_add / link_remove / templates_attach_to_chat / templates_add。
 *
 * `adopt_markdown` 是**外部转录那条路的终点**:软件自己不认识任何转录服务,高质量转录
 * 由用户装的工具做(用 code / 命令节点跑),转出来的 md 靠这条挂回库 —— 配图一起搬。
 *
 * 刻意**不提供硬删除**:remove 是把条目移出所有分类、落进回收站,用户随时能捞回来。
 * AI 的"删除"是它自己判断出来的动作,判断错了用户得有得救。
 */
import { z } from "zod";
import { SEARCH_LIMIT_SETTING_KEY } from "@contracts/ipc";
import type { LibraryItem } from "@contracts/library";
import { LibraryRepo, CollectionRepo, NoteRepo, SettingRepo, DownloadJobRepo, LibraryLinkRepo } from "@main/store/repositories.js";
import {
  assignToCollection,
  importIdentifiers,
  removeItemsToTrash,
  renameItem,
  searchItems,
} from "@main/library/operations.js";
import { enqueueDownloads } from "@main/library/downloader.js";
import { convertItemToMarkdown } from "@main/library/convert.js";
import { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";
import { aiVisibleFilesOf } from "@main/library/fileImport.js";
import { attachToChat } from "@main/library/manifest.js";
import {
  addTemplate,
  attachTemplateToChat,
  listTemplates,
  notifyTemplatesChanged,
} from "@main/templates/store.js";
import { TEMPLATE_KINDS, type TemplateKind } from "@contracts/templates";
import { MCP_LIBRARY_SERVER } from "@contracts/ipc";
import { searchExternal } from "@main/library/metadata.js";
import { rankJournals } from "@main/library/journalRank.js";
import { notifyLibraryChanged } from "@main/library/broadcast.js";
import { suppressionReasonOfItem } from "@main/library/suppress.js";
import { fail, loadCreateMcpServer, text, toSdkTools, type McpToolContext, type McpToolSpec } from "./sdk.js";

/** MCP server 名。SDK 把工具暴露成 `mcp__<这个名字>__<工具名>`。
 *
 *  字面量定义在 `@contracts/ipc` —— 渲染端也要认这个名字(工作流节点的 MCP 候选表
 *  要把它滤掉,见 `NODE_MCP_PARAM_KEY`)。这里只是沿用主进程这一侧一直在用的名字。 */
export const LIBRARY_MCP_SERVER = MCP_LIBRARY_SERVER;
export const LIBRARY_MCP_PREFIX = `mcp__${LIBRARY_MCP_SERVER}__`;

/**
 * 只读工具 —— 在 `shouldAutoApprove` 里自动放行。
 * 与浏览器的只读集合同一个道理:它们改不了任何东西,没理由每次都问用户。
 */
export const LIBRARY_READONLY_TOOLS = new Set([
  "library_collections",
  "library_search",
  "library_search_online",
  "library_journal_rank",
  "library_items",
  // 看关联是只读的(增删是另外两条写工具)
  "library_links",
  // 模版库那一段(与文献库同级别的另一段,见文件头)
  "templates_list",
]);

/**
 * 一条文献在工具输出里的一行 —— 一定要带 id(后续 move/note 都要用它)。
 *
 * ## 为什么把 PDF 的**绝对路径**给出来
 *
 * 这条路径是外部转录接得上的唯一入口:模型要"拿这篇的 PDF 去转",它得先知道文件在
 * 哪儿。不给的话它只能去猜(库根 + 内容哈希的拼法),而猜错的后果是把一份不存在的
 * 路径喂给外部工具。
 *
 * 给绝对路径而不是库内相对路径,是因为**外部工具在库外运行** —— `mineru x.pdf` 要的
 * 是一个当下就能打开的路径,而相对路径是相对谁的,从工具的视角根本无从判断。
 *
 * ⚠️ 路径走 `aiVisibleFilesOf`(库根拼法只有 `fromLibraryRelative` 那一处说了算;按文件类型
 * 屏蔽的那份不给 —— 屏蔽了 pdf,模型就拿不到 PDF 路径,只拿到转录)。
 */
function itemLine(i: LibraryItem): string {
  const authors = i.authors
    .map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(" "))
    .slice(0, 3)
    .join(", ");
  const bits = [authors, i.year ? String(i.year) : "", i.venue ?? ""].filter(Boolean);
  // 按文件类型屏蔽的那份不列(`aiVisibleFilesOf`,见 `library/suppress.ts`):屏蔽 pdf 时
  // 转录过的只给转录路径。整条被挡的条目调用方已经筛掉了,到不了这里。
  const files = aiVisibleFilesOf(i);
  const state = [
    files.markdown
      ? "已转 Markdown"
      : files.original
        ? files.hasTranscript ? "有原件" : i.pdfPath && !i.filePath ? "有 PDF,未转 Markdown" : "有文件,未转 Markdown"
        : "无文件",
    i.doi ? `DOI ${i.doi}` : i.arxivId ? `arXiv ${i.arxivId}` : "",
  ]
    .filter(Boolean)
    .join(";");
  // 路径各占一行 —— 它们长、而且还可能带空格,混在状态那行里读不清。
  const pathLines =
    (files.markdown ? `\n  Markdown: ${files.markdown}` : "") + (files.original ? `\n  ${files.original.toLowerCase().endsWith(".pdf") ? "PDF" : "原件"}: ${files.original}` : "");
  return `- ${i.title}\n  id=${i.id}${bits.length ? `\n  ${bits.join(" · ")}` : ""}\n  ${state}${pathLines}`;
}

/** 分类树的一行。缩进表示层级,永远带 id —— 后续 assign 要用。 */
function collectionLines(): string[] {
  const all = CollectionRepo.list();
  const byParent = new Map<string | null, typeof all>();
  for (const c of all) {
    const key = c.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      out.push(`${"  ".repeat(depth)}- ${c.name}  id=${c.id}`);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}


/**
 * 被屏蔽的条目在按条点名的工具里说的**同一句话**(现在只剩 `library_write_note` —— 下载 /
 * 转换 / 挂转录是干活、不是给 AI 看东西,2026-09-26 起不过屏蔽那道门)。
 *
 * 读工具(`library_search` / `library_items`)挡掉之后是**数**着说("另有 N 条被屏蔽
 * 规则挡住了"),因为那几条本来就是一整批;按 id 点名的,按条说。
 *
 * 措辞与 `library/manifest.ts` 里 `attachToChat` 那句**一字不差** —— 同一个规矩在
 * 模型那里应该是同一句话,不该因为它这次是"挂载"还是"写笔记"就换一种说法。
 *
 * ⚠️ 判据本身只有一份(`library/suppress.ts` 的 `suppressionReasonOfItem`),
 * 这里只负责把原因拼成一句人话,不重写判定。
 */
function suppressedNote(reason: string): string {
  return `${reason}被屏蔽了(设置 → 资料库类型)`;
}

/**
 * 这个 server 的工具表 —— **只有声明,不碰 SDK**。
 *
 * 抽出来的原因见 `./sdk.ts` 的 `McpToolSpec`:同一份表还要给网页端那条通路用
 * (浏览器里的扩展直接向主进程要工具,不经过 SDK)。所以这里返回声明,
 * {@link buildLibraryMcpServer} 与 `main/mcp/webToolHost.ts` 各自 map 一次。
 */
export function libraryMcpTools(): McpToolSpec[] {
  return [
      {
        name: "library_collections",
        description:
          "列出资料库的分类树。返回每个分类的名称与 id。" +
          "要往某个分类里放东西、或想知道用户有哪些分类时先调它。",
        inputSchema: {},
        handler: async () => {
          const lines = collectionLines();
          return text(lines.length > 0 ? lines.join("\n") : "  (还没有分类)");
        },
      },
      {
        name: "library_search",
        description:
          "在资料库里按关键词搜索条目(搜标题、作者、期刊、摘要、DOI、arXiv ID、年份)。" +
          "判断「库里有没有某一篇」时用它 —— 不要凭记忆回答用户。返回的每条都带 id。",
        inputSchema: {
          query: z.string().describe("关键词;留空则列出全部"),
        },
        handler: async (args: { query: string }) => {
          const items = searchItems(args.query ?? "");
          // **屏蔽是硬过滤,这里也必须过。** `searchItems` 是纯仓储查询(纯 SQL,
          // 见 `library/operations.ts`),它不看屏蔽规则 —— 而这一条是模型"翻库"的
          // 主要出口,工具说明里还写着"判断库里有没有某一篇时用它"。不过这道门,
          // 被屏蔽的条目会照常列出来,而且 `itemLine` 顺手带上 PDF 的**绝对路径**:
          // 模型拿着它 Read / shell 一下就绕过去了,用户在设置里设的屏蔽等于白设。
          //
          // 判定只有一份(`library/suppress.ts`),这里不重写它。
          const kept = items.filter((i) => !suppressionReasonOfItem(i.id));
          const dropped = items.length - kept.length;
          if (kept.length === 0) {
            // 挡掉的和"库里没有"必须分开说 —— 前者是用户自己设的规矩在管事,模型
            // 不该据此回答"库里没有这一篇"(那是 `library_search` 最要紧的那个用途,
            // 见工具说明)。
            if (dropped > 0) {
              return text(
                `匹配「${args.query}」的 ${dropped} 条都在屏蔽列表里(设置 → 资料库类型)。` +
                  `如实告诉用户"被屏蔽了",不要当不存在,也不要凭空引用。`,
              );
            }
            return text(`库里没有匹配「${args.query}」的条目。不要因此凭空引用 —— 如实告诉用户库里没有。`);
          }
          const tail =
            dropped > 0 ? `\n\n(另有 ${dropped} 条被屏蔽规则挡住了,没有列出来。)` : "";
          return text(`匹配 ${kept.length} 条:\n\n${kept.slice(0, 60).map(itemLine).join("\n")}${tail}`);
        },
      },
      {
        name: "library_search_online",
        description:
          "联网检索文献(**Crossref + arXiv + OpenAlex** 三源合并去重)。**这是找文献的正路** —— 不要把用户的整句中文丢进来," +
          "英文元数据源匹配不到中文。做法:先把研究方向拆成概念块,每个概念块给出英文同义词组," +
          "再用 AND 把概念块连起来(例如 'quantum key distribution' AND ('satellite' OR 'free-space') AND 'wavelength')。" +
          "中文里没法翻译的专有词(如具体算法名)保留拉丁拼写。\n" +
          "返回的是**候选**,还没入库;挑中的用 library_add_paper 逐条导入。",
        inputSchema: {
          query: z.string().describe("英文检索式:概念块之间用 AND,块内同义词用 OR,短语加引号"),
          limit: z.number().optional().describe("每个源取多少条,默认 20"),
          yearFrom: z.number().optional().describe("起始年份"),
          yearTo: z.number().optional().describe("截止年份"),
        },
        handler: async (args: { query: string; limit?: number; yearFrom?: number; yearTo?: number }) => {
          const q = (args.query ?? "").trim();
          if (!q) return fail("检索式不能为空");
          // 每源条数默认取用户在筛选条上设的那个 —— 不接上的话那个选择框就是个摆设,
          // 界面上写着"50 条"、实际永远拿 20 条。
          const configured = Number.parseInt(
            SettingRepo.get(SEARCH_LIMIT_SETTING_KEY) ?? "",
            10,
          );
          const limit = args.limit ?? (Number.isFinite(configured) && configured > 0 ? configured : 20);
          const results = await searchExternal({
            query: q,
            limit,
            yearFrom: args.yearFrom,
            yearTo: args.yearTo,
          });
          if (results.length === 0) {
            return text(
              `没检索到结果。\n\n用过的检索式:${q}\n` +
                "可以试试:减少概念块(先用最核心的一两个)、把窄词换成更通用的同义词、去掉年份限制。",
            );
          }
          const lines = results.map((r, i) => {
            const authors = r.authors
              .map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(" "))
              .slice(0, 3)
              .join(", ");
            const bits = [authors, r.year ? String(r.year) : "", r.venue ?? ""].filter(Boolean);
            const id = r.doi ? `DOI ${r.doi}` : r.arxivId ? `arXiv ${r.arxivId}` : "(无 DOI / arXiv ID)";
            const head = `[${i + 1}] ${r.title}\n    ${bits.join(" · ")}\n    ${id}   来源:${r.source}${
              r.hasOpenAccessPdf ? "   [有开放获取 PDF]" : ""
            }`;
            return r.abstract ? `${head}\n    摘要:${r.abstract.slice(0, 400)}` : head;
          });
          return text(
            `检索式:${q}\n命中 ${results.length} 条(合并去重后):\n\n${lines.join("\n\n")}\n\n` +
              "逐条看:合适的立刻用 library_add_paper 导入并写总结,不要等全部挑完。",
          );
        },
      },
      {
        name: "library_journal_rank",
        description:
          "查期刊档次:**JCR 分区 / 影响因子 / 中科院分区 / Top / CCF / 预警名单**,并给出分档" +
          "(T1 = Q1 或中科院 1 区或 Top;T2 = Q2 或 2 区;T3 = 其余;EXCLUDE = 预警名单)。\n" +
          "筛选检索结果时**必须用它**来判断期刊好不好 —— 绝不要凭印象说某个刊影响因子多少。\n" +
          "一次可以传多个刊名(检索结果里的 venue 直接抄进来)。",
        inputSchema: {
          journals: z.array(z.string()).min(1).describe("期刊/会议名,可多个"),
        },
        handler: async (args: { journals: string[] }) => {
          const { dbPath, ranks } = await rankJournals(args.journals);
          if (!dbPath) {
            return text(
              "期刊数据不可用(jcr.db 没找到),所以**这次查不了期刊档次**。\n" +
                "如实告诉用户这一点,不要凭印象编影响因子或分区。\n" +
                "数据放在 Mcode 数据根的 workflows/jcr.db 下即可启用。",
            );
          }
          const lines = ranks.map((r) => {
            const bits = [
              r.impactFactor != null ? `IF ${r.impactFactor}` : "",
              r.jcrQuartile ? `JCR ${r.jcrQuartile}` : "",
              r.casZone ? `中科院 ${r.casZone} 区` : "",
              r.casTop === "是" ? "Top" : "",
              r.ccf ? `CCF ${r.ccf}` : "",
            ].filter(Boolean);
            const warn = r.warn ? `\n    ⚠️ 预警名单(${r.warn})—— 不要收这一篇` : "";
            return `- ${r.journal}\n    ${bits.length ? bits.join(" · ") : "(库里没有这个刊)"}    **分档:${r.tier}**${warn}`;
          });
          return text(`按 ${dbPath} 查:\n\n${lines.join("\n")}`);
        },
      },
      {
        name: "library_items",
        description: "列出某个分类里的全部条目。返回的每条都带 id。",
        inputSchema: { collectionId: z.string().describe("分类 id,来自 library_collections") },
        handler: async (args: { collectionId: string }) => {
          const all = LibraryRepo.listByCollection(args.collectionId);
          // 同 `library_search`:这条也是直连仓储,而它给出的每一条同样带着 PDF 绝对
          // 路径。屏蔽判定只有一份(见 `library/suppress.ts`)。
          const items = all.filter((i) => !suppressionReasonOfItem(i.id));
          const dropped = all.length - items.length;
          if (items.length === 0) {
            if (dropped > 0) {
              return text(
                `这个分类里的 ${dropped} 条都在屏蔽列表里(设置 → 资料库类型)。如实告诉用户。`,
              );
            }
            return text("(这个分类里还没有条目)");
          }
          const tail = dropped > 0 ? `\n\n(另有 ${dropped} 条被屏蔽规则挡住了,没有列出来。)` : "";
          return text(`${items.length} 条:\n\n${items.map(itemLine).join("\n")}${tail}`);
        },
      },
      {
        name: "library_create_collection",
        description:
          "新建一个分类。用户没有指定要把检索结果放哪儿时,先问他要叫什么名字,再用这个工具建出来。" +
          "返回新分类的 id —— 后面的 library_import 要用它。",
        inputSchema: {
          name: z.string().describe("分类名(就是用户在左栏看到的名字)"),
          parentId: z.string().optional().describe("建成子分类时给父分类 id;省略则建在顶层"),
        },
        handler: async (args: { name: string; parentId?: string }) => {
          const name = (args.name ?? "").trim();
          if (!name) return fail("分类名不能为空");
          if (CollectionRepo.isNameTaken(name, undefined)) {
            // 重名会让用户分不清两个同名分类 —— 让模型换个名字再试,而不是静默建出来
            return fail(`已经有一个叫「${name}」的分类了。换一个名字,或直接用现成的那个。`);
          }
          const c = CollectionRepo.create(name, args.parentId ?? null);
          notifyLibraryChanged(`create_collection:${c.name}`);
          return text(`已新建分类「${c.name}」  id=${c.id}`);
        },
      },
      {
        name: "library_attach_to_chat",
        description:
          "**把一个分类挂到这次对话上** —— 效果和你让用户自己点「+ → 添加文献库到上下文」完全一样:" +
          "对话里会多出一个附件,而且**用户界面上会立刻显示出来**。挂上之后你就能按它读这些文献," +
          "下一条消息会把它作为清单路径一起发出去。\n" +
          "挂单独一篇(itemId)时,**这一篇关联的东西会一起挂上** —— 用户给条目建过关联," +
          "引用一条就意味着连它直接带的那几条一起读。\n" +
          "用户没有挂任何分类、但你确实需要看某个库时用它;挂之前先问用户要挂哪个(用 library_collections 列出候选)," +
          "不要自作主张挂一堆。挂重复了不会重复显示。",
        inputSchema: {
          collectionId: z.string().describe("要挂的分类 id;挂单独一篇时用 itemId"),
          itemId: z.string().optional().describe("改挂单独一篇时给条目 id,与 collectionId 二选一"),
        },
        handler: async (args: { collectionId?: string; itemId?: string }, ctx: McpToolContext) => {
          if (!args.itemId && !args.collectionId) return fail("要给 collectionId 或 itemId");
          // 实现只有一份(见 library/manifest.ts 的 attachToChat)—— 与左栏右键
          // 「添加到当前对话」调的是同一个函数,所以 AI 挂的和你自己挂的必然一样。
          const res = attachToChat(
            ctx.sessionId,
            args.itemId ? `i:${args.itemId}` : `c:${args.collectionId}`,
          );
          if (!res.ok) return fail(res.error ?? "挂不上去");
          // 挂单篇时会**连它关联的一起挂上**(见 library/manifest.ts 的一跳展开)。
          // 少挂了几条的话 `res.error` 里说着 —— 一并转述给模型,免得它以为都挂上了。
          const caveat = res.error ? `\n注意:${res.error}` : "";
          return args.itemId
            ? text(`已把《${res.name}》挂到这次对话的附件里(界面上应该已经出现)。${caveat}`)
            : text(
                `已把分类「${res.name}」挂到这次对话的附件里(共 ${res.count} 篇,界面上应该已经出现)。\n` +
                  `清单路径会随下一条消息一起发出去;要现在就读,直接 Read 那个清单文件。${caveat}`,
              );
        },
      },
      /* ────────────────────── 模版库(与文献库同级别的另一段)──────────────────────
       *
       * 「模版和文档是同级别的,只不过给 AI 的提示词不一样,只有这个区别」——
       * 所以这一段也给 AI 一套和文献库对得上的工具:能列、能挂进对话、能把工作区里的
       * 文件存成一条。**实现与用户界面走的是同几个函数**(templates/store.ts),
       * 所以"AI 挂的"和"用户自己点「添加到当前对话」挂的"必然是同一种东西。 */
      {
        name: "templates_list",
        description:
          "**列出模版库里的模版**。模版库与文献库是同级的两段,分五个类目:" +
          "ppt / latex / word / code / image;一条模版就是一个文件夹(目录名即名字)。" +
          "要挂进对话、或者要看某一条里到底有什么文件,先用它拿到 类目 + 目录名。",
        inputSchema: {
          kind: z
            .enum(TEMPLATE_KINDS)
            .optional()
            .describe("只看某个类目(ppt / latex / word / code / image);不给就全部"),
          query: z.string().optional().describe("按名字过滤(不区分大小写)"),
        },
        handler: async (args: { kind?: TemplateKind; query?: string }) => {
          const all = listTemplates(args.kind);
          const q = args.query?.trim().toLowerCase();
          const rows = q ? all.filter((e) => e.dirName.toLowerCase().includes(q)) : all;
          if (rows.length === 0) {
            return text(
              all.length === 0
                ? "模版库里还没有模版(用户可以在左栏「模版」那一段或设置里添加,也可以直接往模版文件夹里丢文件)。"
                : `没有匹配「${args.query}」的模版(这一类目下共 ${all.length} 条)。`,
            );
          }
          const lines = [`共 ${rows.length} 条模版:`, ""];
          for (const e of rows) {
            lines.push(
              `- [${e.kind}] ${e.dirName} —— ${e.files.length} 个文件;位置 \`${e.path}\``,
            );
          }
          lines.push("");
          lines.push("要把它挂到这次对话上就用 templates_attach_to_chat(会生成一份清单给模型读)。");
          return text(lines.join("\n"));
        },
      },
      {
        name: "templates_attach_to_chat",
        description:
          "**把一条模版(或某一整个类目)挂到这次对话上** —— 效果和用户自己点「添加到当前对话」" +
          "完全一样:对话框里会多出一个附件,而且**用户界面上会立刻显示出来**。\n" +
          "挂单条时会生成一份清单(文件列表 + 小文件的正文),挂整个类目时生成的是一份**索引**" +
          "(这一类目下有哪些模版、各自那份清单在哪)。挂重复了不会重复显示。",
        inputSchema: {
          kind: z.enum(TEMPLATE_KINDS).describe("类目"),
          dirName: z
            .string()
            .optional()
            .describe("要挂的那一条的目录名;省略 = 挂整个类目(给的是索引)"),
        },
        handler: async (args: { kind: TemplateKind; dirName?: string }, ctx: McpToolContext) => {
          // 实现只有一份(见 templates/store.ts 的 attachTemplateToChat)—— 与左栏
          // 右键「添加到当前对话」、设置页那个气泡调的是同一个函数。
          const res = attachTemplateToChat(ctx.sessionId, args.kind, args.dirName);
          if (!res.ok) return fail(res.error ?? "挂不上去");
          return args.dirName
            ? text(
                `已把模版「${res.name}」挂到这次对话的附件里(共 ${res.fileCount} 个文件,界面上应该已经出现)。\n` +
                  "清单路径会随下一条消息一起发出去;要现在就读,直接 Read 那个清单文件 —— 里面已经把每个文件的绝对路径和小文件的正文都给全了。",
              )
            : text(
                `已把「${res.name}」这一类模版挂到这次对话的附件里(${res.fileCount} 条,界面上应该已经出现)。\n` +
                  "它给的是一份**索引**:先看有哪些模版,再按里面的路径去 Read 你真正需要的那一份清单。",
              );
        },
      },
      {
        name: "templates_add",
        description:
          "**把工作区里的文件 / 文件夹存成一条模版**(复制进模版库,原文件留在原处)。" +
          "适合「我把这套写作格式/模版存下来」这类请求:先在工作区里把文件写好,再整包存进来。" +
          "一条模版 = 一个文件夹,所以改的名字会成为文件夹名(非法字符会被替换)。",
        inputSchema: {
          kind: z.enum(TEMPLATE_KINDS).describe("存进哪个类目"),
          name: z.string().describe("模版名(会成为文件夹名)"),
          sourcePaths: z
            .array(z.string())
            .min(1)
            .describe("要收进来的文件 / 文件夹**绝对路径**;文件夹会整包复制"),
        },
        handler: async (args: { kind: TemplateKind; name: string; sourcePaths: string[] }) => {
          const res = addTemplate(args.kind, args.name, args.sourcePaths);
          if (!res.ok) return fail(res.error ?? "存不进去");
          // 用户的左栏/设置页各有缓存 —— 与界面自己的新建走同一条广播
          notifyTemplatesChanged(`agent_add:${args.kind}/${res.dirName}`);
          const entry = res.entries.find((e) => e.dirName === res.dirName);
          return text(
            `已把「${res.dirName}」存进模版库的 ${args.kind} 类目(${entry?.files.length ?? 0} 个文件)。` +
              "用户在左栏「模版」那一段就能看到它。",
          );
        },
      },
      {
        name: "library_add_paper",
        description:
          "**导入一篇文献,并顺手把总结写进它的笔记**。检索流程里用这个:找到一个合适的就立刻导入," +
          "不要等全部找完再一次性导入。\n" +
          "给它一个 DOI 或 arXiv ID;元数据自动从 Crossref / arXiv 补齐;导入后应用会自动排队下载 PDF," +
          "不需要你再管下载。summary 会显示在这一条的详情页笔记里。" +
          "必须给 collectionId:导入的条目要有个归处,否则会掉进回收站。",
        inputSchema: {
          identifier: z.string().describe("一个 DOI 或 arXiv ID,不要带解释文字"),
          collectionId: z.string().describe("放进哪个分类,来自 library_collections 或 library_create_collection"),
          summary: z
            .string()
            .optional()
            .describe("这篇的总结(为什么值得收进来、讲了什么、和用户的方向什么关系)。写上它,用户之后翻库时能一眼看懂。"),
        },
        handler: async (args: { identifier: string; collectionId: string; summary?: string }) => {
          if (!CollectionRepo.list().some((c) => c.id === args.collectionId)) {
            return fail(
              `分类 ${args.collectionId} 不存在。先用 library_create_collection 建一个,或用 library_collections 看看有哪些。`,
            );
          }
          const { items, failed } = await importIdentifiers(args.identifier, {
            collectionIds: [args.collectionId],
            queueDownload: true,
          });
          if (items.length === 0) {
            return fail(failed[0]?.reason ?? "这一条没能解析成 DOI / arXiv ID");
          }
          const item = items[0]!;
          const summary = (args.summary ?? "").trim();
          if (summary) {
            // 与"导入"同一次调用里写进去 —— 用户要的就是"导入的时候顺便把总结也写进去",
            // 拆成两步会让模型在找到下一篇时忘掉上一篇的总结。
            NoteRepo.save({ itemId: item.id, content: summary, origin: "ai" });
          }
          // 界面上要立刻多出这一条(左栏、右栏列表都读的是渲染端缓存)
          notifyLibraryChanged(`add_paper:${item.title}`);
          return text(
            `已导入并排队下载:\n\n${itemLine(item)}` +
              (summary ? `\n\n已写入总结(${summary.length} 字),显示在这一条的笔记里。` : ""),
          );        },
      },
      {
        name: "library_import",
        description:
          "**批量**导入:一次给多个 DOI / arXiv ID(每个元素一条),或一整段 BibTeX。" +
          "只在用户一次就给了一串标识符时用它 —— 检索流程请用 library_add_paper,一次一篇。" +
          "同样会自动下载,不需要你管。必须给 collectionId。",
        inputSchema: {
          identifiers: z
            .array(z.string())
            .min(1)
            .describe("DOI / arXiv ID 的列表(每个元素一行,不要带解释文字)"),
          collectionId: z.string().describe("放进哪个分类"),
        },
        handler: async (args: { identifiers: string[]; collectionId: string }) => {
          if (!CollectionRepo.list().some((c) => c.id === args.collectionId)) {
            return fail(
              `分类 ${args.collectionId} 不存在。先用 library_create_collection 建一个,或用 library_collections 看看有哪些。`,
            );
          }
          const { items, failed } = await importIdentifiers(args.identifiers.join("\n"), {
            collectionIds: [args.collectionId],
            queueDownload: true,
          });
          const parts = [`已导入 ${items.length} 条,已排队下载 PDF:`];
          if (items.length > 0) parts.push(items.map(itemLine).join("\n"));
          if (failed.length > 0) {
            parts.push(`\n有 ${failed.length} 条没能导入:`);
            for (const f of failed) parts.push(`- ${f.raw.slice(0, 120)} —— ${f.reason}`);
          }
          parts.push("\n下载由应用自动排队,不需要你再操作。");
          notifyLibraryChanged(`import:${items.length}`);
          return text(parts.join("\n"));
        },
      },
      {
        name: "library_download",
        description:
          "给排好队的条目**下载 PDF**(应用的下载管道:内嵌浏览器带登录态)。" +
          "要求条目有 DOI / arXiv ID 或可用的 PDF 链接,两条都没有的会以「没有可用来源」收场。\n" +
          "library_add_paper / library_import 已经自动排队,**检索导入的流程不要调它**;" +
          "它用于「把之前导入但还没下到 PDF 的那几条再试一次」。",
        inputSchema: {
          ids: z.array(z.string()).min(1).describe("条目 id 列表,来自 library_search / library_items"),
        },
        handler: async (args: { ids: string[] }) => {
          const lines: string[] = [];
          // **不过屏蔽那道门**(2026-09-26 用户定的规矩):屏蔽只管给 AI 看的,下载是干活。
          // 屏蔽了 pdf 的条目照样要下 PDF —— 转录出的 md 才是给模型看的那份。
          const allowed: string[] = [];
          for (const id of args.ids) {
            const item = LibraryRepo.get(id);
            if (!item) {
              lines.push(`- ${id} —— 库里没有这个 id`);
              continue;
            }
            allowed.push(id);
          }
          // 排队本身是同步的(任务行当场落库),下载在后台慢慢跑 —— 这里只回报
          // "排上了没有、现在什么状态",不等着它下完。
          enqueueDownloads(allowed);
          const jobs = DownloadJobRepo.list();
          for (const id of allowed) {
            const item = LibraryRepo.get(id)!;
            if (item.pdfPath) {
              // enqueueDownloads 对已有 PDF 的条目直接跳过(force 才重下)—— 如实说,
              // 别让用户以为又下了一遍。
              lines.push(`- ${item.title}\n  id=${id}\n  已有 PDF,没有重复排队`);
              continue;
            }
            const job = jobs.find((j) => j.itemId === id);
            lines.push(
              `- ${item.title}\n  id=${id}\n  下载任务:${
                job ? `${job.id}(${job.status})` : "未能排队 —— 缺 DOI / arXiv ID,也没有可用链接"
              }`,
            );
          }
          return text(
            `已处理 ${args.ids.length} 条:\n\n${lines.join("\n")}\n\n` +
              "下载由应用自动排队,不需要你再操作;下不了的(缺来源)如实转告用户。",
          );
        },
      },
      {
        name: "library_move",
        description: "把条目移到某个分类。会顺手把它从回收站里摘出来。",
        inputSchema: {
          itemIds: z.array(z.string()).min(1),
          collectionId: z.string().describe("目标分类 id"),
        },
        handler: async (args: { itemIds: string[]; collectionId: string }) => {
          if (!CollectionRepo.list().some((c) => c.id === args.collectionId)) {
            return fail(`分类 ${args.collectionId} 不存在`);
          }
          assignToCollection(args.collectionId, args.itemIds, true);
          notifyLibraryChanged("move");
          return text(`已把 ${args.itemIds.length} 条移到该分类。`);
        },
      },
      {
        name: "library_remove",
        description:
          "把条目从库里拿走 —— 移出所有分类,落进**回收站**(不是永久删除,用户随时能捞回来)。" +
          "用户说「删掉/不要了」时用它。",
        inputSchema: { itemIds: z.array(z.string()).min(1) },
        handler: async (args: { itemIds: string[] }) => {
          const moved = removeItemsToTrash(args.itemIds);
          if (moved.length === 0) return fail("这些 id 一条都没找到");
          notifyLibraryChanged("remove");
          return text(`已把 ${moved.length} 条移进回收站(可在左栏的「回收站」分类里找回)。`);
        },
      },
      {
        name: "library_rename",
        description: "改条目或分类的名字。",
        inputSchema: {
          target: z.enum(["item", "collection"]),
          id: z.string(),
          name: z.string().describe("新名字"),
        },
        handler: async (args: { target: "item" | "collection"; id: string; name: string }) => {
          const name = (args.name ?? "").trim();
          if (!name) return fail("新名字不能为空");
          if (args.target === "item") {
            if (!renameItem(args.id, name)) return fail(`找不到条目 ${args.id}`);
            notifyLibraryChanged("rename:item");
            return text(`已改名为「${name}」`);
          }
          const ok = CollectionRepo.rename(args.id, name);
          if (!ok) return fail("改不了 —— 分类不存在,或同一个库里已经有同名分类");
          notifyLibraryChanged("rename:collection");
          return text(`分类已改名为「${name}」`);
        },
      },
      {
        name: "library_write_note",
        description:
          "给某一条文献写笔记。笔记显示在这一条的详情页(右栏「笔记」),用户和后续对话都看得到。" +
          "**写摘要、写读完的要点、记下留待确认的问题,都用它** —— 直接给正文,不要写\"我可以帮你总结\"。",
        inputSchema: {
          itemId: z.string(),
          content: z.string().describe("笔记正文,Markdown"),
          origin: z.enum(["user", "ai"]).optional().describe("谁写的;AI 自动写时传 ai,默认 user"),
        },
        handler: async (args: { itemId: string; content: string; origin?: "user" | "ai" }) => {
          const item = LibraryRepo.get(args.itemId);
          if (!item) return fail(`找不到条目 ${args.itemId}`);
          // **屏蔽是硬过滤。** 写笔记是"往库里加东西",被屏蔽的条目照写的话,用户
          // 下次翻到它就会以为屏蔽规则失灵了 —— 而且模型写完会向用户汇报"已写好
          // 笔记",那句话本身是错的(他并不想在这条上留东西)。
          //
          // 与"条目不存在"分开说:那是两句不同的话(判据只有一份,见
          // `library/suppress.ts`)。
          const reason = suppressionReasonOfItem(args.itemId);
          if (reason) return fail(`没能给《${item.title}》写笔记:${suppressedNote(reason)}`);
          const content = (args.content ?? "").trim();
          if (!content) return fail("笔记内容不能为空");
          NoteRepo.save({ itemId: args.itemId, content, origin: args.origin ?? "user" });
          notifyLibraryChanged("write_note");
          return text(`已给《${item.title}》写好笔记(${content.length} 字)。`);
        },
      },
      {
        name: "library_convert",
        description:
          "把文献的 PDF 转成 Markdown —— **本地抽取,只有纯文本**(排版、公式、表格都不保留)。\n" +
          "要高质量的转录(公式 / 多栏 / 表格)不走这条:用 code 节点调你自己装的外部工具转出 `full.md`,\n" +
          "再拿 `library_adopt_markdown` 挂回库 —— 那条路才认图床。\n" +
          "**已经有 Markdown 的会跳过**;确实要重转才把 force 打开。\n" +
          "⚠️ 它**不下载** PDF:`library_add_paper` / `library_import` 导入时已经自动排队下载,这条只管「已经在本地的 PDF → Markdown」。条目还没有 PDF 时如实转告用户,别自己去抓。",
        inputSchema: {
          ids: z.array(z.string()).min(1).describe("要转的条目 id,来自 library_search / library_items"),
          force: z.boolean().optional().describe("已经有 Markdown 也重转(默认关)"),
        },
        handler: async (args: { ids: string[]; force?: boolean }) => {
          const lines: string[] = [];
          let converted = 0;
          for (const id of args.ids) {
            const item = LibraryRepo.get(id);
            if (!item) {
              lines.push(`- ${id} —— 库里没有这个 id`);
              continue;
            }
            // **不过屏蔽那道门**(2026-09-26):屏蔽只管给 AI 看的,转换是干活 —— 屏蔽了 pdf
            // 要的正是「只给模型看转录后的 md」,不转就没有那份 md。
            const res = await convertItemToMarkdown(item, { force: args.force });
            if (res.ok) {
              converted += 1;
              // 已经有 md 时是 `alreadyDone`,别把它说成"这次转了一遍"。
              lines.push(
                res.alreadyDone
                  ? `- 《${item.title}》\n  id=${id}\n  已有 Markdown,没有重转`
                  : `- 《${item.title}》\n  id=${id}\n  已转好(本地抽取${res.chars ? `,${res.chars} 字节` : ""})`,
              );
              continue;
            }
            lines.push(`- 《${item.title}》\n  id=${id}\n  没转成:${res.error}`);
          }
          if (converted > 0) notifyLibraryChanged(`convert:${converted}`);
          return text(
            `已处理 ${args.ids.length} 条:\n\n${lines.join("\n")}\n\n` +
              "转好的条目这一条的详情页就能读到 Markdown,右栏的全文检索也找得到它。",
          );
        },
      },
      {
        name: "library_adopt_markdown",
        description:
          "把**一份现成的 Markdown 挂到某一条文献上**(跳过转录)。给外部工具转好的产物用:\n" +
          "用 code / 命令节点调你自己装的工具(OCR、mineru CLI、任何东西)转出 `full.md`,\n" +
          "再拿这条把它挂回库里 —— 挂上之后条目详情页读得到、右栏全文检索也搜得到。\n" +
          "**配图会一起搬**:`full.md` 同级/下级目录里的图片(不管目录叫什么)都跟着复制过来,\n" +
          "所以 `![](figures/x.png)` 这类相对引用挂完仍然成立 —— 只搬 md 的话预览里全是断图。\n" +
          "⚠️ 这是**覆盖**:同一条再挂一次会把上一次那整包换掉。不转格式、不改内容,原样搬。",
        inputSchema: {
          itemId: z.string().describe("挂到哪一条,来自 library_search / library_items"),
          path: z
            .string()
            .describe(
              "那份 Markdown 的**绝对路径**(`.md` / `.markdown`)。转录产物是 `full.md` 加同级配图目录时,给 `full.md` 的路径。",
            ),
        },
        handler: async (args: { itemId: string; path: string }) => {
          const item = LibraryRepo.get(args.itemId);
          if (!item) return fail(`库里没有这个 id:${args.itemId}`);
          // **不过屏蔽那道门**(2026-09-26):屏蔽只管给 AI 看的,挂回转录是干活。自动化
          // 「下载完转 Markdown」最后一步走的就是这条;从前被屏蔽的条目在这里被拒,整条白跑。
          const res = adoptMarkdownFile(args.itemId, args.path);
          if (!res.ok) {
            // **逐种情况说人话** —— "失败"两个字让模型和用户都无从下手。
            return fail(`没能挂上《${item.title}》:${res.error}`);
          }
          notifyLibraryChanged(`adopt:${args.itemId}`);
          const imgs = res.imageCount > 0 ? `,连同 ${res.imageCount} 张图` : "(这份没有配图)";
          // **引用不到的要报出来**(仓规:坏东西显式报出来,不静默跳过)。不报的话
          // 用户看到的是一份断图的 md,而软件什么也没说过。
          const missLine =
            res.missing.length > 0
              ? `\n⚠️ 有 ${res.missing.length} 处配图在源目录里找不到,那几处预览会是断图:` +
                res.missing.slice(0, 10).map((m) => `\n  - ${m}`).join("") +
                (res.missing.length > 10 ? `\n  (还有 ${res.missing.length - 10} 处)` : "")
              : "";
          return text(
            `已挂上《${item.title}》${imgs}。\n` +
              `落点:markdown/imported/${args.itemId}/\n\n` +
              "这条的详情页现在读得到它,右栏的全文检索也找得到。" +
              missLine,
          );
        },
      },
      {
        name: "library_links",
        description:
          "看某一条**关联了谁、又被谁关联**。关联是双向展示、单向存的 —— 打开 B 的时候看得到「A 关联了我」。\n" +
          "每行带 `linkId`,要解除就用 library_link_remove 给这个 id。",
        inputSchema: {
          itemId: z.string().describe("看哪一条的关联,来自 library_search / library_items"),
        },
        handler: async (args: { itemId: string }) => {
          const item = LibraryRepo.get(args.itemId);
          if (!item) return fail(`库里没有条目 ${args.itemId}`);
          const links = LibraryLinkRepo.viewsOf(args.itemId);
          if (links.length === 0) return text(`《${item.title}》还没有任何关联。`);
          const rows = links.map((l) => {
            const who = l.otherItemId ? `《${l.title}》` : `${l.title}(库外文件)`;
            const dir = l.direction === "out" ? "→ 它关联的" : "← 关联它的";
            // **被屏蔽的要当场说**。仓储那一层不看屏蔽(`viewsOf` 是纯查询),而这件事
            // 对模型是有用的:它看到"这一条被屏蔽了"就不会白试一次挂载 —— 挂载那道门
            // 是硬过滤,屏蔽的挂不上(`library/manifest.ts` 的 `attachToChat`,判据是
            // `library/suppress.ts` 的 `suppressionReasonOfItem`)。界面上那句
            // 灰字也是同一个原因(`ipc/library.ts` 的 handler 补的是同一个字段)。
            const reason = l.otherItemId ? suppressionReasonOfItem(l.otherItemId) : null;
            return `- ${dir}:${who}\n  linkId=${l.id}${l.otherItemId ? `  条目 id=${l.otherItemId}` : ""}${
              reason ? `\n  ⚠️ ${reason}被屏蔽了 —— 它进不了上下文,挂到对话上也挂不上` : ""
            }`;
          });
          return text(`《${item.title}》的关联(${links.length} 条):\n\n${rows.join("\n")}`);
        },
      },
      {
        name: "library_link_add",
        description:
          "给一条条目挂一条关联。**目标二选一**:库内条目给 `targetItemId`;用户桌面/别处的文件给 `targetPath`(绝对路径)。\n" +
          "这个关联在界面上是看得见的(详情页的「关联」区),而且**用户把 A 挂进对话时会连它关联的一起挂上** —— 所以只挂真的相关的。\n" +
          "已经存在的同一条关联不会重复建(幂等),给回的是原来那一条。",
        inputSchema: {
          itemId: z.string().describe("从哪一条挂出去"),
          targetItemId: z.string().optional().describe("库内条目 id"),
          targetPath: z.string().optional().describe("库外文件的绝对路径"),
        },
        handler: async (args: { itemId: string; targetItemId?: string; targetPath?: string }) => {
          const item = LibraryRepo.get(args.itemId);
          if (!item) return fail(`库里没有条目 ${args.itemId}`);
          const hasItem = args.targetItemId !== undefined;
          const hasPath = args.targetPath !== undefined;
          if (hasItem === hasPath) {
            return fail("关联的目标要么是库内条目(targetItemId)、要么是库外路径(targetPath),不能两个都给或都不给");
          }
          if (hasItem && !LibraryRepo.get(args.targetItemId!)) {
            return fail(`库里没有条目 ${args.targetItemId} —— 关联的目标必须已经在库里`);
          }
          const link = LibraryLinkRepo.add(
            args.itemId,
            hasItem ? { targetItemId: args.targetItemId! } : { targetPath: args.targetPath! },
          );
          notifyLibraryChanged(`link_add:${args.itemId}`);
          const other = hasItem ? `《${LibraryRepo.get(args.targetItemId!)!.title}》` : args.targetPath!;
          return text(`已让《${item.title}》关联 ${other}。\nlinkId=${link.id}`);
        },
      },
      {
        name: "library_link_remove",
        description: "解除一条关联(按关联行自己的 id,先从 library_links 拿到)。**只解除关联,两边的条目都还在。**",
        inputSchema: {
          linkId: z.string().describe("关联行 id,来自 library_links"),
        },
        handler: async (args: { linkId: string }) => {
          const ok = LibraryLinkRepo.remove(args.linkId);
          if (!ok) return fail(`没有这条关联:${args.linkId}`);
          notifyLibraryChanged(`link_remove:${args.linkId}`);
          return text("已解除这条关联(两边的条目都还在)。");
        },
      },
  ];
}

/**
 * 构建这个 MCP server。与浏览器那个同构:惰性 import SDK(那个模块很大,不能挂在
 * 启动路径上),一次性构造,按需挂到 `options.mcpServers`。
 */
export async function buildLibraryMcpServer(opts: { sessionId: string }) {
  const createSdkMcpServer = await loadCreateMcpServer();

  return createSdkMcpServer({
    name: LIBRARY_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 资料库的操作工具,分**同级的两段**:资料库与模版库。\n" +
      "资料库:分类树(大类 → 分类)与回收站;" +
      "条目用 id 标识,要操作某一条先用 library_search / library_items 拿到它的 id。\n" +
      "模版库:五个类目 ppt / latex / word / code / image,一条模版是一个文件夹(目录名即名字)," +
      "用 templates_list 列出、templates_attach_to_chat 挂进对话。",
    alwaysLoad: true,
    tools: toSdkTools(libraryMcpTools(), { sessionId: opts.sessionId }),
  });
}
