import type { ProviderContext } from "@contracts/provider";
import { memoryProjectForSession, memoryWriteOrigin, requireMemoryAccess } from "@main/memory/access.js";
import { visibleMemory } from "@main/memory/paths.js";
/**
 * **mcode-memory** —— 让模型自己**记**东西的进程内 MCP server。
 *
 * ## 它补的是记忆系统的**另一半**
 *
 * 记忆有三件事:存储、检索注入、**写入**。前两件早就做完了
 * (`memory/store.ts` + `memory/retrieval.ts`,注入挂在 `nodeInputBuilders` 与
 * `sessionAgentProfile` 两处)—— 可**写入那一半一直没人**:
 * `saveMemoryFile` 的唯一调用者是渲染端的记忆面板,也就是"记什么全靠用户自己去面板里
 * 手打"。用过一次就知道没人会这么干 —— 记忆库永远是空的,注入的那段快照永远是空串,
 * 整套机制等于不存在。
 *
 * 用户的原话是「**不用重复说第二遍**」。模型听得见那句话,但没有任何工具把它写下来。
 *
 * ## 走的是面板那**同一个**函数(硬规矩 2)
 *
 * `saveMemoryFile` / `deleteMemoryFile` / `listMemoryFiles` / `searchMemory` 一份实现,
 * 面板和模型共用。所以"AI 记的"和"用户手打的"在磁盘上**长得一模一样** —— 同一套
 * frontmatter、同一套六类目录、同一个路径校验。用户打开面板就能改、就能删,
 * 也能用编辑器直接打开那个 `.md`(那是存储层的硬要求)。
 *
 * ## 分档:读自动放行,写要用户点头
 *
 * 与 `mcodeServer` 同构(那里解释了为什么钩子/插件/MCP 安装**不在**工具面上)。
 * `memory_list` / `memory_search` / `memory_read` 是只读的 —— 放行。
 * `memory_write` / `memory_forget` 改的是**用户自己的记录**,要点头。
 *
 * 判据不是"重不重要",是"改坏了能不能看出来":记忆是一堆纯文本文件,写坏了用户
 * 打开面板就看得见、删得掉,危害上限和"工作流被画坏"同一档。所以这一档该给。
 *
 * ## 为什么**不**写 `alwaysLoad`
 *
 * 同 `mcodeServer` 那段:这一项等于"这几份工具的说明每轮都重发一遍"。记忆是**偶尔**
 * 才写的(用户说一句"以后都用 APA"),为它让每次提问都多付一份说明不值。
 * 不写 = 交给 CLI 的工具检索,真要记的时候按需拉进来。
 */
import { z } from "zod";

/** 本地日期 YYYY-MM-DD。不用 `toISOString().slice(0, 10)` —— 那是 UTC 日期,
 *  东八区凌晨 0–8 点会显示成"昨天"。 */
function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
import {
  MemoryRevisionSchema,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory,
} from "@contracts/memory";
import { MCP_MEMORY_SERVER } from "@contracts/ipc";
import {
  deleteMemoryFile,
  listMemoryFiles,
  readMemoryFile,
  saveMemoryFile,
} from "@main/memory/store.js";
import { BODY_CAP, searchMemory } from "@main/memory/retrieval.js";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
import { fail, loadCreateMcpServer, text, toSdkTools, type McpToolSpec } from "./sdk.js";

/** MCP server 名。SDK 把工具暴露成 `mcp__<这个名字>__<工具名>`。 */
export const MEMORY_MCP_SERVER = MCP_MEMORY_SERVER;

/**
 * 只读工具 —— 在 `shouldAutoApprove` 里自动放行(见 `toolRules.ts` 的清单)。
 * 它们改不了任何东西:列的、搜的、读的都是用户已有的记录。
 *
 * ⚠️ **这份清单同时导出给 `toolRules.ts` 用**,而那个文件必须是**叶子** —— 它一被引
 * 就顺着 `memory/broadcast` → `window.js` 把 electron 拖进来(见 `toolRules` 文件头)。
 * 所以这个文件**不许**在模块顶层引任何重东西:SDK 是惰性载入的,`memory/store` 与
 * `memory/retrieval` 只碰 node:fs。
 */
export const MEMORY_READONLY_TOOLS = new Set(["memory_list", "memory_search", "memory_read"]);

/** 六个类目拼成一句给模型看的话(带中文标签,它照着挑就行)。 */
function categoryMenu(): string {
  return MEMORY_CATEGORIES.map((c) => `${c}(${MEMORY_CATEGORY_LABELS[c]})`).join(" / ");
}

/**
 * 文件名 slug —— 从标题推一个稳定的文件名。
 *
 * ⚠️ **必须过 `saveMemoryFile` 那道路径闸**:文件名不许带路径分隔符、不许以点开头、
 * 不许超长,否则整条写入会被拒(而拒的理由是"路径不合法",看着完全不像"标题里有斜杠")。
 * 所以这里主动把危险字符换掉,而不是让模型自己猜。
 *
 * 中文**保留** —— 记忆文件名是给人看的(`rules/引用规范.md` 比 `rules/cite.md` 好认),
 * 而存储层的路径校验对非 ASCII 是放行的。
 */
function slugify(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "-") // 路径分隔符 + 常见保留字符
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "") // 开头不许是点(存储层会拒),首尾的连字符没意义
    .trim();
  // 截到 80 字:给 `.md` 后缀和可能的去重后缀留出余量(存储层上限 120)
  const cut = cleaned.slice(0, 80);
  if (cut.length === 0) return `note-${Date.now().toString(36)}`;
  // Windows 保留设备名(CON / NUL / COM1……,带 .md 也算)不能当文件名:加个后缀避开。
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cut) ? `${cut}_` : cut;
}

/**
 * 标题 → 一条稳定候选路径(碰撞由存储层的版本检查拒绝)(`<类目>/<文件名>.md`)。
 *
 * 同名的处理是**沿用**而不是新建一个 `-2`:模型的意图多半是"把这条记忆更新一下",
 * 而不是"再记一条一模一样的"。所以撞上已有文件名时直接用那个路径 —— 必须先读取并携带版本才能更新,
 * 而 `saveMemoryFile` 会保留旧标题(除非这次明确给了新的)。
 *
 * 真正的去重判断留给调用方:**先 `memory_search` 看看有没有**,再决定 write 还是忘掉。
 *
 * ⚠️ **这里不再去列已有文件。** 从前这里先 `listMemoryFiles` 建一个 Set、再判
 * `if (!existing.has(...)) return candidate; return candidate;` —— 两个分支返回的是**同一个**
 * 东西,那个 Set 对结果毫无影响(而且每次 `memory_write` 都白读一遍磁盘)。路径**恒等于**
 * `slugify` 的结果;要"避免覆盖别人"是存储层版本检查的职责,不是这里的。
 */
function pathFor(category: MemoryCategory, title: string): string {
  return `${category}/${slugify(title)}.md`;
}

/**
 * 工具表。读 / 写分两段,与 `mcodeServer` 同一个形状。
 */
function rawMemoryMcpTools(): McpToolSpec[] {
  return [
    /* ─────────────── 读(自动放行)─────────────── */
    {
      name: "memory_list",
      description:
        "列出记忆库里已有的记录(标题 + 路径 + 最后更新时间),按类目分组。" +
        "**记东西之前先看一眼这里** —— 一条记忆该更新就用同一个路径覆盖,而不是再写一条新的。",
      inputSchema: {
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .describe(`只列这一类。省略 = 六类全列(${categoryMenu()})`),
      },
      handler: (args: { category?: MemoryCategory }, ctx) => {
        const projectId = memoryProjectForSession(ctx.sessionId);
        const metas = listMemoryFiles(args.category === undefined ? undefined : { category: args.category }).filter(meta => visibleMemory(meta.path, projectId));
        if (metas.length === 0) {
          return text(
            args.category
              ? `「${MEMORY_CATEGORY_LABELS[args.category]}」这一类还是空的。`
              : "记忆库还是空的 —— 用户还没让你记过任何东西。",
          );
        }
        const out: string[] = [];
        for (const category of MEMORY_CATEGORIES) {
          const bucket = metas.filter((m) => m.category === category);
          if (bucket.length === 0) continue;
          out.push(`## ${MEMORY_CATEGORY_LABELS[category]}(${category})`);
          for (const m of bucket) {
            out.push(`- 【${m.title}】  \`${m.path}\`  (${localDate(m.updatedAt)})`);
          }
          out.push("");
        }
        return text(`共 ${metas.length} 条:\n\n${out.join("\n").trimEnd()}`);
      },
    },
    {
      name: "memory_search",
      description:
        "**按相关度**在记忆库里找 —— 不是按时间。想确认「这件事以前记过没有」就用它:" +
        "命中会带正文片段和分数,分数高的更该看。" +
        "⚠️ 空查询会退回「按时间列最近几条」;一条都没命中就照实说没找到,别拿不相关的凑数。",
      inputSchema: {
        query: z.string().describe("要找什么。中文按双字切词,所以「引用格式」这种短语比单字好"),
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .describe(`限定类目(${categoryMenu()})。省略 = 六类都搜`),
        limit: z.number().int().min(1).max(50).optional().describe("最多几条,默认 12"),
      },
      handler: (args: { query: string; category?: MemoryCategory; limit?: number }, ctx) => {
        const hits = searchMemory(args.query, {
          projectId: memoryProjectForSession(ctx.sessionId),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.category === undefined ? {} : { category: args.category }),
        });
        if (hits.length === 0) {
          return text(
            args.query.trim().length === 0
              ? "记忆库是空的(或这一类是空的)。"
              : `没有一条记忆和「${args.query}」对得上 —— 本次检索未命中，不代表从未记录。`,
          );
        }
        const lines = hits.map(
          (h) =>
            `- 【${h.meta.title}】 \`${h.meta.path}\`  (相关度 ${h.score})\n` +
            h.body
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n"),
        );
        return text(`找到 ${hits.length} 条:\n\n${lines.join("\n")}`);
      },
    },
    {
      name: "memory_read",
      description: "读一条记忆的完整正文(不含 frontmatter)。路径从 memory_list / memory_search 拿。",
      inputSchema: { path: z.string().describe("形如 `rules/引用规范.md`(memory 根下的相对路径)") },
      handler: (args: { path: string }, ctx) => {
        requireMemoryAccess(args.path, memoryProjectForSession(ctx.sessionId));
        try {
          const { content, revision } = readMemoryFile(args.path);
          // ⚠️ **去掉正文首尾的换行,读出来的才是能原样存回去的。** 存储层写盘时是
          // `---\n…\n---\n\n<正文>`,所以 `readMemoryFile` 吐回的正文前面带着分隔行留下的
          // 那个换行;而 `saveMemoryFile` 只 `\\s+$` 收尾(不收首)。模型照「先读 → 改 →
          // 用同一个 path 覆盖」这条被工具说明写死的流程走一遍,那个前导换行就被原样写回,
          // 每读存一轮文件多一个空行、正文越漂越远(实测 `"A"`→`"\nA"`→`"\n\nA"`)。
          // 面板那条读通路(`main/ipc/memory.ts` 的 `memory:read`)早就按同一条判据收口了
          // —— 这里漏了,于是同一个「读→存」不动点在 MCP 这条路上不成立。硬规矩 2:同一份
          // 规则两处各写一遍必漂。这里照抄那处,只去换行(不吃正文里故意的空格/制表符)。
          const body = content.replace(/^\n+|\n+$/g, "");
          return text(`revision: ${revision}\n\n${body.length === 0 ? "(这条记忆是空的)" : body}`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    },

    /* ─────────────── 写(需要用户点头)─────────────── */
    {
      name: "memory_write",
      description:
        "**记下一条长期记忆**(更新已有文件必须提供读取时的 expectedRevision)。\n" +
        "## 什么时候该记 —— 判据是「下次还会用到、而且从代码里读不出来」\n" +
        "该记:用户是谁、他的偏好、项目背景、外部系统在哪、他纠正过你的做法、" +
        "做过的决定和理由。\n" +
        "**不该记**:代码怎么写、函数叫什么(去读代码)、git 历史(去查 git)、" +
        "这一次任务的临时状态(做完就过期了)。\n" +
        "**绝不记敏感信息**:密码、API Key、token、secret、私钥、cookie/session 凭据。" +
        "用户要求记访问方式时,只记它放在哪、由哪个密钥管理器/配置项管理、怎么读;绝不记值本身。\n" +
        "## 记之前先搜\n" +
        "同一件事记两遍比不记更坏 —— 用户下次会看到两条互相矛盾的记录。" +
        "**先 `memory_search` 一下**,有对得上的就用**同一个 path** 覆盖它(而不是新建)。\n" +
        "## 措辞\n" +
        "写给**未来的自己**看:一句话说清「是什么、为什么」。别写「用户刚才说的话」这种" +
        "带时间语境的句子 —— 三个月后读到它,「刚才」就什么都不是了。",
      inputSchema: {
        category: z.enum(MEMORY_CATEGORIES).describe(`归到哪一类:${categoryMenu()}`),
        title: z.string().describe("一句话标题,也是界面上的那一行。同一个标题会落到同一个文件上"),
        content: z.string().describe("正文(markdown)。写清「是什么 + 为什么」,别写流水账"),
        scope: z.enum(["project", "global"]).optional().describe("默认当前项目；仅用户明确要求跨项目共享时选 global"),
        expectedRevision: MemoryRevisionSchema.nullable().optional().describe("更新时必须填 memory_read 返回的 revision；省略或 null 仅允许新建。冲突后重新读取、合并，不得盲目覆盖。"),
        path: z
          .string()
          .trim()
          // Normalize before both the approval description and the write handler.
          // Empty paths use the same explicit scope/default path in both places.
          .transform((path) => path || undefined)
          .optional()
          .describe(
            "**更新已有记录时填它并携带 expectedRevision**(从 memory_list / memory_search 拿到的那个路径)。" +
              "省略则按类目 + 标题现推一个文件名。",
          ),
      },
      handler: (args: { category: MemoryCategory; title: string; content: string; path?: string; expectedRevision?: string | null; scope?: "project" | "global" }, ctx) => {
        const projectId = memoryProjectForSession(ctx.sessionId);
        const title = args.title.trim();
        if (title.length === 0) return fail("标题不能为空 —— 那是用户在面板里看到的那一行。");
        if (args.content.trim().length === 0) {
          return fail("正文是空的。一条什么都没有的记忆只会在快照里占位置。");
        }
        const path = args.path || `${args.scope === "global" ? "global" : `projects/${projectId}`}/${pathFor(args.category, title)}`;
        requireMemoryAccess(path, projectId);
        try {
          const { updatedAt, revision } = saveMemoryFile({ path, content: args.content, title, expectedRevision: args.expectedRevision }, memoryWriteOrigin(ctx.sessionId));
          // 界面上要能看见它在记 —— 面板与快照都靠这个广播刷新
          notifyMemoryChanged(`write:${path}`);
          return text(
            `已记下「${title}」 → \`${path}\`(${MEMORY_CATEGORY_LABELS[args.category]},${localDate(updatedAt)})\n` +
              `用户打开记忆面板就能看到、也能改。\nrevision: ${revision}`,
          );
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    },
    {
      name: "memory_forget",
      description:
        "**删掉一条记忆**。只在它确实过时、或用户明确说「忘掉这个」时用 —— 删除是幂等的,不存在的路径也算成功。\n" +
        "⚠️ 删之前先 `memory_read` 确认删的是哪一条:路径是一个 slug,看着像不代表内容就是你以为的那条。",
      inputSchema: { path: z.string().describe("要删的路径,来自 memory_list / memory_search"), expectedRevision: MemoryRevisionSchema.describe("必须是确认要删除时 memory_read 返回的 revision；过期则拒绝删除") },
      handler: (args: { path: string; expectedRevision: string }, ctx) => {
        requireMemoryAccess(args.path, memoryProjectForSession(ctx.sessionId));
        try {
          // 先读一次拿正文预览;**读不到不等于失败**。存储层对不存在的路径直接回
          // `{ ok: true }`(删除是幂等的),工具说明也写着"不存在的路径也算成功"、
          // 面板那条删除同样幂等 —— 从前这里却拿**会抛的** `readMemoryFile` 当前置,
          // 于是"幂等"只停在说明里:删一条本来就不在的路径变成 `fail`,回的还是一句
          // 英文 `ENOENT: no such file...`,与兄弟路径的说辞对不上。
          let preview = "";
          let previewElided = false;
          try {
            const { content } = readMemoryFile(args.path);
            const body = content.trim();
            preview = body.slice(0, 60);
            previewElided = body.length > 60;
          } catch {
            /* 不存在(或读不到)—— 删除本身幂等,不当作失败;下面照常删、照常报成功 */
          }
          deleteMemoryFile(args.path, args.expectedRevision);
          notifyMemoryChanged(`forget:${args.path}`);
          return text(`已删掉 \`${args.path}\`${preview ? `(原内容是「${preview}${previewElided ? "…" : ""}」)` : ""}。`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    },
  ];
}

/**
 * 构建这个 MCP server。与库 / 工作流那两个同构:惰性 import SDK(那个模块很大,
 * 不能挂在启动路径上),一次性构造,按需挂到 `options.mcpServers`。
 */
/** A shared, schema-validated and scope-checked table for all local engines. */
export function memoryMcpTools(): McpToolSpec[] {
  return rawMemoryMcpTools().map(spec => ({ ...spec, handler: async (args, ctx) => {
    try { return await spec.handler(z.object(spec.inputSchema).parse(args), ctx); }
    catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
  } }));
}

export async function buildMemoryMcpServer(opts: { sessionId: string; context?: ProviderContext }) {
  const createSdkMcpServer = await loadCreateMcpServer();

  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 长期记忆库的读写工具。记忆是**跨对话**的:这次记下的,用户下次开新对话时" +
      "会自动作为背景出现在上下文里(`## 长期记忆` 那一节),所以他不用重复说第二遍。\n" +
      `六个类目:${categoryMenu()}。\n` +
      "记之前先 `memory_search`(同一件事记两遍比不记更坏);" +
      "该记的是「下次还会用到、而且从代码/文件里读不出来」的东西 —— 用户是谁、他的偏好、" +
      "项目背景、外部系统在哪、他纠正过你的做法。**不记**代码怎么写的、git 历史、" +
      "这次任务的临时状态。**绝不记密码、API Key、token、secret、私钥或会话凭据**;" +
      "若要记访问机制,只记它放在哪、由谁管理、怎么读,不记值本身。\n" +
      "`memory_write` 与 `memory_forget` 都要用户点头才生效。",
    tools: toSdkTools(memoryMcpTools().map(spec => ({ ...spec, handler: async (args) => {
      const { invokeMemoryTool } = await import("@main/memory/engineTools.js");
      return invokeMemoryTool(spec.name, args, opts.sessionId, opts.context ?? {} as ProviderContext);
    } })), { sessionId: opts.sessionId }),
  });
}
