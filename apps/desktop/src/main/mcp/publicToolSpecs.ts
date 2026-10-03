import { z } from "zod";
import type { McpToolSpec, ToolResult } from "@main/mcp/sdk.js";
import { fail } from "@main/mcp/sdk.js";
import { discoverPublicSkills } from "@main/mcp/publicSkills.js";

export const PUBLIC_TOOL_MIGRATIONS: Record<string, string> = {
  agent_process_sessions: "agent_process_read（不传 process_id）",
  agent_read_files: "agent_read_file（传 paths）",
  agent_skill_list: "agent_skill（action=list）",
  agent_skill_read: "agent_skill（action=read）",
  library_collections: "library_query（action=collections）",
  library_search: "library_query（action=search）",
  library_items: "library_query（action=items）",
  library_links: "library_query（action=links）",
};
const result = (data: Record<string, unknown>, text = JSON.stringify(data)): ToolResult => ({ content: [{ type: "text", text }], structuredContent: data });

/** An adapter, not a replacement for desktop tools. Invoke original read and
 * library handlers with the same context; never forward plugins or mutations. */
export function compactPublicTools(agents: McpToolSpec[], libraries: McpToolSpec[], projectFor: (sessionId: string) => string | null): McpToolSpec[] {
  const read = agents.find(s => s.name === "agent_read_file");
  if (!read) throw new Error("Missing agent_read_file");
  const pageShape = { ...read.inputSchema };
  delete pageShape.path;
  const pageInput = z.object({ path: z.string().min(1), ...pageShape });
  const mergedRead: McpToolSpec = {
    ...read,
    description: read.description + " 单文件传 path；批量传 paths（1–20 个路径或含独立分页/哈希参数的对象），二者只能选一个。批量逐项保留错误和无损分页元数据，总正文预算 80000 字符；pending_files 须另次提交。",
    inputSchema: { ...read.inputSchema, path: read.inputSchema.path!.optional(), paths: z.array(z.union([z.string().min(1), pageInput])).min(1).max(20).optional() },
    outputSchema: { ...read.outputSchema, files: z.array(z.record(z.unknown())).optional(), pending_files: z.array(z.record(z.unknown())).optional() },
    handler: async (args, ctx) => {
      if ((args.path !== undefined) === (args.paths !== undefined)) return fail("path 与 paths 必须且只能提供一个");
      if (args.path !== undefined) return read.handler(args, ctx);
      const { paths, path: _path, ...defaults } = args;
      const requests: Record<string, any>[] = paths.map((item: string | Record<string, unknown>) => ({ ...defaults, ...(typeof item === "string" ? { path: item } : item) }));
      const files: Record<string, unknown>[] = [], texts: string[] = [];
      let remaining = 80000;
      for (const request of requests) {
        if (remaining < 1000) break;
        let out: ToolResult;
        try { out = await read.handler({ ...request, max_chars: Math.min(request.max_chars ?? 30000, remaining) }, ctx); }
        catch (error) { out = fail(error instanceof Error ? error.message : String(error)); }
        files.push({ path: request.path, ...out.structuredContent, isError: out.isError === true, ...(out.isError ? { error: out.content.filter(c => c.type === "text").map(c => c.text).join("\n") } : {}) });
        texts.push(out.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
        remaining -= typeof out.structuredContent?.content === "string" ? out.structuredContent.content.length : 0;
      }
      const pending_files = requests.slice(files.length);
      const out = result({ files, pending_files }, texts.join("\n\n") + (pending_files.length ? `\n预算已用尽，另次提交 pending_files（${pending_files.length} 项）` : ""));
      if (files.length && files.every(f => f.isError)) out.isError = true;
      return out;
    },
  };
  const skill: McpToolSpec = {
    name: "agent_skill",
    description: "只发现当前链接绑定项目 .claude/skills 的技能，不继承全局、其他项目或插件。开始相关任务时以 query 关键词搜索轻量名称/描述索引；选中后 action=read 按需读取 SKILL.md。是否适用由模型判断，读取不代表自动执行或授权其中的命令。",
    inputSchema: { action: z.enum(["list", "read"]).default("list"), query: z.string().max(200).optional(), name: z.string().min(1).max(200).optional(), offset: z.number().int().min(0).optional().describe("list 的记录偏移"), limit: z.number().int().min(1).max(100).optional().describe("list 的页长，默认 30"), page: z.object(pageShape).optional().describe("read 的无损文本分页/版本参数") },
    outputSchema: { ...read.outputSchema, project: z.string().optional(), scope: z.literal("project").optional(), skills: z.array(z.object({ name: z.string(), description: z.string(), path: z.string(), scope: z.literal("project") })).optional(), total: z.number().optional(), scan_truncated: z.boolean().optional() },
    handler: async (args, ctx) => {
      const project = projectFor(ctx.sessionId);
      if (!project) return fail("链接尚未绑定项目，不能回退到全局技能或缓存工作目录");
      const index = discoverPublicSkills(project);
      if (args.action === "read") {
        if (!args.name || args.query !== undefined || args.offset !== undefined || args.limit !== undefined) return fail("read 需要 name，可选 page；不接受 query/offset/limit");
        const entry = index.skills.find(s => s.name === args.name);
        if (!entry) return fail("当前项目中没有可读取的同名技能（不回退全局）；请先 list 查询");
        return read.handler({ ...args.page, path: entry.path }, ctx);
      }
      if (args.name !== undefined || args.page !== undefined) return fail("list 不接受 name/page；读取技能请用 action=read");
      const words = (args.query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = index.skills.filter(s => words.every((word: string) => `${s.name} ${s.description}`.toLocaleLowerCase().includes(word)));
      const offset = args.offset ?? 0, limit = args.limit ?? 30;
      const skills = matches.slice(offset, offset + limit), has_more = offset + skills.length < matches.length;
      return result({ project, scope: "project", skills, total: matches.length, has_more, ...(has_more ? { next_offset: offset + skills.length } : {}), scan_truncated: index.scan_truncated });
    },
  };
  const actionNames: Record<string, string> = { collections: "library_collections", search: "library_search", items: "library_items", links: "library_links" };
  const library: McpToolSpec = {
    name: "library_query",
    description: "资料库只读查询；任务确实需要资料库时才调用。action=collections 列集合；search 需要 query；items 需要 collectionId；links 需要 itemId。保持原有屏蔽和只读边界，无写入动作。",
    inputSchema: { action: z.enum(["collections", "search", "items", "links"]), query: z.string().min(1).optional(), collectionId: z.string().min(1).optional(), itemId: z.string().min(1).optional() },
    handler: async (args, ctx) => {
      const required: Record<string, string | null> = { collections: null, search: "query", items: "collectionId", links: "itemId" };
      const field = required[args.action];
      if ((field && args[field] === undefined) || ["query", "collectionId", "itemId"].some(k => k !== field && args[k] !== undefined)) return fail("参数与 action 不匹配：search→query，items→collectionId，links→itemId，collections 不接受这些参数");
      const spec = libraries.find(s => s.name === actionNames[args.action]);
      if (!spec) return fail("资料库查询暂不可用");
      const parsed = z.object(spec.inputSchema).safeParse(field ? { [field]: args[field] } : {});
      if (!parsed.success) return fail(parsed.error.message);
      return spec.handler(parsed.data, ctx);
    },
  };
  const context = agents.find(s => s.name === "agent_context");
  const publicContext = context ? {
    ...context,
    description: context.description + " 同时返回当前绑定项目的轻量技能索引（最多 30 条）；相关任务用 agent_skill query 筛选，再按需 read，不自动执行。",
    outputSchema: { ...context.outputSchema, project_skills: z.record(z.unknown()).optional() },
    handler: async (args: any, ctx: Parameters<McpToolSpec["handler"]>[1]) => {
      const out = await context.handler(args, ctx);
      if (out.isError) return out;
      const index = discoverPublicSkills(projectFor(ctx.sessionId));
      const project_skills = { scope: "project", skills: index.skills.slice(0, 30), total: index.skills.length, has_more: index.skills.length > 30, scan_truncated: index.scan_truncated };
      return { ...out, content: [...out.content, { type: "text" as const, text: "项目技能索引（任务相关时用 agent_skill 的 query 搜索，再 action=read；不自动执行）：\n" + JSON.stringify(project_skills) }], structuredContent: { ...out.structuredContent, project_skills } };
    },
  } : undefined;
  return [...agents.filter(s => !Object.hasOwn(PUBLIC_TOOL_MIGRATIONS, s.name)).map(s => s.name === read.name ? mergedRead : s.name === "agent_context" && publicContext ? publicContext : s), skill, library];
}
