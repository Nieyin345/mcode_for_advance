/**
 * `@main/mcp/libraryServer.js` 的替身(见 run.sh 的 `--alias`)。
 *
 * ## 为什么换掉它
 *
 * 真的那份在模块顶层 import 了 `LibraryRepo / CollectionRepo / NoteRepo / SettingRepo`,
 * 而仓库桩(`mcode-admin-smoke/stubs/repositories.ts`)只实现了工作流那几个 —— 无头
 * 环境里给不出真的库。这一套要验的是 **webToolHost 的派发与闸门**(会话缺失要不要拒、
 * 参数校验、只读放行 / 写操作弹卡 / 拒绝后不执行),不是文献库那十几个 handler 本身
 * (它们有自己那条路的覆盖)。
 *
 * 所以这里造三张**形状各异**的声明,把它们真正需要的东西都压出来:
 *
 *   - 必填参数(校验不走会不会被放过);
 *   - 嵌套数组 + 可选字段(JSON Schema 里会不会冒出 `$ref`,那是 MCP 客户端读不懂的);
 *   - 一个只读、一个写(闸门的两档都踩到)。
 *
 * ⚠️ `LIBRARY_READONLY_TOOLS` 也跟着换成这里的名字 —— `toolGate.ts` 的清单就是从
 * 各 server 的文件里读的,别名一换,闸门认的就是这一份。写工具(`library_write`)
 * **刻意不在**里面,它是用来验"写操作会弹卡"的。
 */
import { z } from "zod";
import type { McpToolSpec } from "@main/mcp/sdk.js";
import { text } from "@main/mcp/sdk.js";

export const LIBRARY_MCP_SERVER = "mcode-library";
export const LIBRARY_MCP_PREFIX = `mcp__${LIBRARY_MCP_SERVER}__`;

export const LIBRARY_READONLY_TOOLS = new Set(["library_probe", "library_nested"]);

/** 每个 handler 被调到的次数 —— 断言用的"这个工具到底跑了没有"。 */
export const __handlerCalls: string[] = [];

export function libraryMcpTools(): McpToolSpec[] {
  return [
    {
      name: "library_probe",
      description: "只读:回显一个查询词。",
      inputSchema: { query: z.string().min(1).describe("查询词") },
      handler: (args: { query: string }) => {
        __handlerCalls.push(`library_probe:${args.query}`);
        return text(`probe:${args.query}`);
      },
    },
    {
      name: "library_nested",
      description: "只读:嵌套数组 + 可选字段,用来验 JSON Schema 的形状。",
      inputSchema: {
        journals: z
          .array(z.object({ name: z.string(), year: z.number().optional() }))
          .optional()
          .describe("期刊清单"),
      },
      handler: () => {
        __handlerCalls.push("library_nested");
        return text("nested ok");
      },
    },
    {
      name: "library_write",
      description: "写:需要用户点头。",
      inputSchema: { id: z.string().min(1).describe("条目 id"), note: z.string().optional() },
      handler: (args: { id: string }) => {
        __handlerCalls.push(`library_write:${args.id}`);
        return text(`written:${args.id}`);
      },
    },
  ];
}