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
 * 读工具(自动放行,不弹审批):collections / search / items / links。
 * 写工具(需要用户点头;用户可以在审批时勾"始终允许"):create_collection /
 * import_files / attach_pdf / convert / **adopt_markdown** / move / remove / rename /
 * write_note / link_add / link_remove。
 *
 * `import_files` / `attach_pdf` 是**外部下载器接进来的口子**:核心不再自己下载任何东西,
 * 外部 MCP 服务 / 自动化把文件弄到本地之后,靠这两条交给库(前者建新条目,后者把 PDF
 * 挂到已有条目上并发 `library.item.downloaded`,让「下载完转 Markdown」那条自动化接手)。
 *
 * **学术那一段(search_online / journal_rank / add_paper / import / download)已退役**
 * (2026-09-27):外部检索、按 DOI/arXiv 导入、PDF 自动下载、期刊分区整体搬出核心,
 * 由外部 MCP 服务 + 自动化/工作流承担。核心的 library_* 只管"库里有什么、怎么归类、
 * 怎么挂到对话上、怎么把 PDF 变成模型能读的 Markdown"。
 *
 * **模版库那一段(templates_list / templates_attach_to_chat / templates_add)已退役**
 * (2026-09-27):独立的模版库入口在 `d8db783` 收进了统一资料库,旧模版目录被迁成
 * 库里的 linked 条目 —— 模型要"找模版 / 挂模版"走的就是同一套 library_* 工具,
 * 再留一套只会把它引去一个界面上已经不存在的地方。
 *
 * `adopt_markdown` 是**外部转录那条路的终点**:软件自己不认识任何转录服务,高质量转录
 * 由用户装的工具做(用 code / 命令节点跑),转出来的 md 靠这条挂回库 —— 配图一起搬。
 *
 * 刻意**不提供硬删除**:remove 是把条目移出所有分类、落进回收站,用户随时能捞回来。
 * AI 的"删除"是它自己判断出来的动作,判断错了用户得有得救。
 */
import { z } from "zod";
import type { LibraryItem } from "@contracts/library";
import { LibraryRepo, CollectionRepo, NoteRepo, LibraryLinkRepo } from "@main/store/repositories.js";
import {
  assignToCollection,
  removeItemsToTrash,
  renameItem,
  searchItems,
} from "@main/library/operations.js";
import { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";
import { importAnyFiles } from "@main/library/importDispatch.js";
import { attachPdfToItem } from "@main/library/pdfImport.js";
import { aiVisibleFilesOf } from "@main/library/fileImport.js";
import { attachToChat } from "@main/library/manifest.js";
import { loadLibraryGroups } from "@main/library/groupRegistry.js";
import { trashedItemIds } from "@main/library/trash.js";
import { MCP_LIBRARY_SERVER } from "@contracts/ipc";
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
  "library_items",
  // 看关联是只读的(增删是另外两条写工具)
  "library_links",
]);

/**
 * 一条条目在工具输出里的一行 —— 一定要带 id(后续 move/note 都要用它)。
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
  const bits = [i.url ?? ""].filter(Boolean);
  // 按文件类型屏蔽的那份不列(`aiVisibleFilesOf`,见 `library/suppress.ts`):屏蔽 pdf 时
  // 转录过的只给转录路径。整条被挡的条目调用方已经筛掉了,到不了这里。
  const files = aiVisibleFilesOf(i);
  const state = [
    files.markdown
      ? "已转 Markdown"
      : files.original
        ? files.hasTranscript ? "有原件" : i.pdfPath && !i.filePath ? "有 PDF,未转 Markdown" : "有文件,未转 Markdown"
        : "无文件",
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
 * 「翻库」两条路(`library_search` / `library_items`)共用的可见性筛子。
 *
 * 两道硬过滤,与所有其它面向 AI 的出口**同一套规则**(「共享实现只有一份」):
 *
 *   - **回收站里的条目**(`library/trash.ts` 的 `trashedItemIds`)—— 用户丢进回收站
 *     的意思就是"我不要它了",它不该进上下文。清单三处、`attachToChat`、系统提示词
 *     (`envPrompt`)、自定义 UI 展开(`runAutomation`)全都剔它;这两条从前漏了。
 *   - **被屏蔽的条目**(`library/suppress.ts` 的 `suppressionReasonOfItem`)—— 判定
 *     只有一份,这里不重写它。
 *
 * 两样**分开数**:一个是用户自己设的规矩("进不了上下文"),一个是"我不要它了"，
 * 说的话不一样。返回剔掉了各几条,调用方据此如实回报(仓规:少列了东西要说出来)。
 */
function visibleLibraryItems(items: readonly LibraryItem[]): {
  items: LibraryItem[];
  suppressed: number;
  trashed: number;
} {
  const trash = trashedItemIds();
  const kept: LibraryItem[] = [];
  let suppressed = 0;
  let trashed = 0;
  for (const item of items) {
    if (trash.has(item.id)) {
      trashed += 1;
      continue;
    }
    if (suppressionReasonOfItem(item.id)) {
      suppressed += 1;
      continue;
    }
    kept.push(item);
  }
  return { items: kept, suppressed, trashed };
}

/** 「哪些条目没列出来、为什么」的一句话 —— 两条路共用,免得各写一份措辞。 */
function hiddenNote(trashed: number, suppressed: number): string {
  const bits: string[] = [];
  if (suppressed > 0) bits.push(`${suppressed} 条被屏蔽规则挡住`);
  if (trashed > 0) bits.push(`${trashed} 条在回收站里`);
  return bits.join("、");
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
          "在资料库里按关键词搜索条目(搜标题、摘要、来源地址、文件路径)。" +
          "判断「库里有没有某一篇」时用它 —— 不要凭记忆回答用户。返回的每条都带 id。",
        inputSchema: {
          query: z.string().describe("关键词;留空则列出全部"),
        },
        handler: async (args: { query: string }) => {
          const items = searchItems(args.query ?? "");
          // **两道硬过滤都要过**(回收站 + 屏蔽),判定各有唯一一份(见
          // `visibleLibraryItems`)。`searchItems` 是纯仓储查询(纯 SQL,见
          // `library/operations.ts`),它两样都不看 —— 而这一条是模型"翻库"的主要出口,
          // 工具说明里还写着"判断库里有没有某一篇时用它"。不过这道门,条目会照常列出
          // 来,而且 `itemLine` 顺手带上 PDF 的**绝对路径**:模型拿着它 Read / shell
          // 一下就绕过去了,用户设的屏蔽、丢进回收站的东西都等于白设。
          const { items: kept, suppressed, trashed } = visibleLibraryItems(items);
          const hidden = suppressed + trashed;
          if (kept.length === 0) {
            // 挡掉的和"库里没有"必须分开说 —— 前者是用户自己设的规矩在管事,模型
            // 不该据此回答"库里没有这一篇"(那是 `library_search` 最要紧的那个用途,
            // 见工具说明)。
            if (hidden > 0) {
              return text(
                `匹配「${args.query}」的 ${hidden} 条都不可见(${hiddenNote(trashed, suppressed)};` +
                  `屏蔽在设置 → 资料库类型,回收站里的可在左栏还原)。` +
                  `如实告诉用户,不要当不存在,也不要凭空引用。`,
              );
            }
            return text(`库里没有匹配「${args.query}」的条目。不要因此凭空引用 —— 如实告诉用户库里没有。`);
          }
          const note = hiddenNote(trashed, suppressed);
          const tail = note ? `\n\n(另有 ${note},没有列出来。)` : "";
          // ⚠️ **列不完必须写出来。** 只摆前 60 条(免得一次把上下文撑爆),而抬头那句
          // 是**匹配总数** —— 不注明的话,模型会把"我看到 60 条"当成"库里就 60 条"。
          // 仓库的既定口径是"少列了东西模型看不出来,比慢一点糟得多"(见
          // `listAllItems` 注释;`envPromptFormat` 与 `library.py` 遇到截断都会显式写一句)。
          const SHOWN = 60;
          const shown = kept.slice(0, SHOWN);
          const more =
            kept.length > shown.length
              ? `\n\n(上面只列了前 ${shown.length} 条,还有 ${kept.length - shown.length} 条没列出 —— ` +
                `要精确找某一篇,把关键词收窄一点再用 library_search。)`
              : "";
          return text(`匹配 ${kept.length} 条:\n\n${shown.map(itemLine).join("\n")}${tail}${more}`);
        },
      },
      {
        name: "library_items",
        description: "列出某个分类里的全部条目。返回的每条都带 id。",
        inputSchema: { collectionId: z.string().describe("分类 id,来自 library_collections") },
        handler: async (args: { collectionId: string }) => {
          const all = LibraryRepo.listByCollection(args.collectionId);
          // 同 `library_search`:这两道硬过滤都要过(回收站 + 屏蔽),判定各有唯一一份
          // (见 `visibleLibraryItems`)。
          const { items, suppressed, trashed } = visibleLibraryItems(all);
          const hidden = suppressed + trashed;
          if (items.length === 0) {
            if (hidden > 0) {
              return text(
                `这个分类里的 ${hidden} 条都不可见(${hiddenNote(trashed, suppressed)};` +
                  `屏蔽在设置 → 资料库类型,回收站里的可在左栏还原)。如实告诉用户。`,
              );
            }
            return text("(这个分类里还没有条目)");
          }
          const note = hiddenNote(trashed, suppressed);
          const tail = note ? `\n\n(另有 ${note},没有列出来。)` : "";
          return text(`${items.length} 条:\n\n${items.map(itemLine).join("\n")}${tail}`);
        },
      },
      {
        name: "library_create_collection",
        description:
          "新建一个分类。用户没有指定要把东西放哪儿时,先问他要叫什么名字,再用这个工具建出来。" +
          "返回新分类的 id —— 后面的 library_move 要用它。",
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
          // **新建的分类必须挂进一个大类**,否则它在左栏里永远看不见 —— 左栏按
          // `group_id` 过滤(`LibrarySection.tsx` 的 `collections.filter(c => c.groupId === group.id)`),
          // 大类清单也按它收(`manifest.ts` 的 `writeGroupManifest`)。NULL 就是一条
          // "建成功了却谁也不认"的幽灵分类。
          //
          // 与 IPC 那条路**同一份规矩**(用户原话:AI 的操作要和 UI 的一样):契约允许
          // 省略 groupId,两条路都兜底到第一个大类 —— 见 `ipc/library.ts` 的
          // `LIBRARY_CREATE_COLLECTION`(`loadLibraryGroups()[0].id`)。MCP 工具的表没有
          // groupId 入参,所以它永远是"省略"那一档,必须在这里补上默认值。
          const groupId = loadLibraryGroups()[0]?.id;
          if (!groupId) return fail("还没有任何大类,请先在资料库设置里建一个大类");
          const c = CollectionRepo.create(name, args.parentId ?? null, groupId);
          notifyLibraryChanged(`create_collection:${c.name}`);
          return text(`已新建分类「${c.name}」  id=${c.id}`);
        },
      },
      {
        name: "library_attach_to_chat",
        description:
          "**把一个分类挂到这次对话上** —— 效果和你让用户自己点「+ → 添加资料库到上下文」完全一样:" +
          "对话里会多出一个附件,而且**用户界面上会立刻显示出来**。挂上之后你就能按它读这些资料," +
          "下一条消息会把它作为清单路径一起发出去。\n" +
          "挂单独一篇(itemId)时,**这一篇关联的东西会一起挂上** —— 用户给条目建过关联," +
          "引用一条就意味着连它直接带的那几条一起读。\n" +
          "用户没有挂任何分类、但你确实需要看某个库时用它;挂之前先问用户要挂哪个(用 library_collections 列出候选)," +
          "不要自作主张挂一堆。挂重复了不会重复显示。",
        inputSchema: {
          // ⚠️ **`collectionId` 必须可选。** 说明与 handler 都写着"与 itemId 二选一"
          // (`args.itemId ? i: : c:`),而 schema 里它是 required 的话,只有 `itemId`
          // 的调用会被 zod **在校验那一步**就拒掉 —— handler 根本进不去。走真正校验
          // 入参的两条路(Claude 的 SDK、Pi/Codex 的 engine bridge 用同一个 zod shape),
          // "挂单独一篇"这个能力就整体用不了,而直接调 handler 的调用方看不出这件事。
          // 至少给一个由 handler 自己判(它会 `return fail`),这里不做 required。
          collectionId: z.string().optional().describe("要挂的分类 id;与 itemId 二选一"),
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
          "给某一条条目写笔记。笔记显示在这一条的详情页(右栏「笔记」),用户和后续对话都看得到。" +
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
        name: "library_import_files",
        description:
          "把**本地文件 / 目录**收进资料库,建成新条目(PDF、Word、图片、任何文件都行;目录可以整个作为一条 linked 条目收进)。\n" +
          "外部检索 / 下载工具把文件弄到本地之后,用这条交给库 —— 每一条入库都会发 `library.item.imported` 事件,用户配的自动化会接手。\n" +
          "同一份内容(按哈希)已经在库里的会跳过,不会重复建条目。返回每一条的 id。",
        inputSchema: {
          paths: z.array(z.string().min(1)).min(1).max(200).describe("要导入的文件 / 目录的**绝对路径**"),
          collectionIds: z.array(z.string()).optional().describe("一并归入哪些分类(id 来自 library_collections);省略则只进总库"),
          mode: z
            .enum(["files", "folder", "explode"])
            .optional()
            .describe("目录怎么收:files(默认,逐个文件)/ folder(整个目录作为一条)/ explode(目录里的文件拆开逐个导)"),
        },
        handler: async (args: { paths: string[]; collectionIds?: string[]; mode?: "files" | "folder" | "explode" }) => {
          const res = await importAnyFiles(args.paths, {
            collectionIds: args.collectionIds,
            mode: args.mode,
          });
          notifyLibraryChanged(`mcp-import:${res.added}`);
          const lines = res.items.map((i) => `- ${i.title}\n  id=${i.id}`);
          const errs = res.errors.map((e) => `- ${e.path}:${e.error}`);
          return text(
            `导入 ${res.added} 条,跳过 ${res.skipped} 条重复。` +
              (lines.length ? `\n\n${lines.join("\n")}` : "") +
              (errs.length ? `\n\n⚠️ 没能导入的:\n${errs.join("\n")}` : ""),
          );
        },
      },
      {
        name: "library_attach_pdf",
        description:
          "把一份**本地 PDF 挂到已有条目**上(条目先有、文件后到的那条路)。外部下载工具把 PDF 下到本地之后用这条交回来:\n" +
          "文件按内容哈希收进库,条目状态变成「已有 PDF」,并发 `library.item.downloaded` 事件 —— 用户配的「下载完转 Markdown」自动化会接手。\n" +
          "已经有 PDF 的条目默认拒绝,要换掉就把 force 打开。",
        inputSchema: {
          itemId: z.string().describe("挂到哪一条,来自 library_search / library_items"),
          path: z.string().min(1).describe("PDF 的**绝对路径**"),
          force: z.boolean().optional().describe("已经有 PDF 也换掉(默认关)"),
        },
        handler: async (args: { itemId: string; path: string; force?: boolean }) => {
          const res = attachPdfToItem(args.itemId, args.path, { force: args.force });
          if (!res.ok) return fail(`没能挂上:${res.error}`);
          notifyLibraryChanged(`attach-pdf:${args.itemId}`);
          return text(
            `${res.replaced ? "已换掉" : "已挂上"}《${res.item.title}》的 PDF。\n` +
              `落点:${res.item.pdfPath}\n\n` +
              "已发出 library.item.downloaded 事件;在线转录由用户配置的自动化处理，软件不直接转录。",
          );
        },
      },
      {
        name: "library_adopt_markdown",
        description:
          "把**一份现成的 Markdown 挂到某一条条目上**(跳过转录)。给外部工具转好的产物用:\n" +
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
      "Mcode 资料库的操作工具:分类树(大类 → 分类)与回收站;" +
      "条目用 id 标识,要操作某一条先用 library_search / library_items 拿到它的 id。" +
      "模版也是库里的条目(大类「模版」),同一套工具找、同一个 library_attach_to_chat 挂进对话。",
    alwaysLoad: true,
    tools: toSdkTools(libraryMcpTools(), { sessionId: opts.sessionId }),
  });
}
