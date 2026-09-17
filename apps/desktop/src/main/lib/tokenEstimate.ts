/**
 * 工具上下文占用的静态估算(设置面板「工具占用」节)。
 *
 * 公式:`ceil(JSON.stringify({ name, description, inputSchema }).length / 4)` ——
 * 工具表进模型上下文的形态就是这一段 JSON(tools/list 的逐工具条目),
 * 4 chars/token 是常用的粗折算,够用来比较"哪组工具吃上下文"。
 *
 * 纯核心(无 electron):给出已收集的工具描述,算一行估算。枚举哪些工具、
 * 按引擎怎么分组,是 main/ipc/context.ts 的事 —— 那里拿得到进程内工具表、
 * 用户配置与插件清单。
 *
 * 估算的**边界**:外部 stdio/http MCP 服务器在连接前拿不到工具清单,只能列
 * 服务器行(estTokens: null);引擎自带工具由 CLI 注入、Mcode 不可控,不进估算。
 */

/** 参与估算的一个工具的静态描述。 */
export interface EstimableTool {
  name: string;
  description?: string;
  /** 线上形态的 JSON Schema(zod 侧先转好再进来)。缺省按无入参估。 */
  inputSchema?: unknown;
}

/** 单工具估算:工具条目 JSON 的字符数 ÷ 4,向上取整。 */
export function estimateToolTokens(tool: EstimableTool): number {
  const json = JSON.stringify({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  });
  return Math.ceil(json.length / 4);
}
