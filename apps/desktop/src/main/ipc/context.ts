/**
 * IPC handlers for the settings panel's context-hosting section:
 * global instructions (read/save + materialize) and tool usage estimates.
 *
 * 路径装配都在这一层 —— lib/appContext.ts 是纯核心(不 import electron),
 * 无头 smoke 直接 bundle 它。事实源 `<dataRoot>/context/instructions.md`;
 * claude 消费点 `~/.mcode/CLAUDE.md`;codex/pi 的消费走各自的会话启动组装链,
 * 不在这里物化。GET 时惰性补物化(修复漂移),不动 index.ts。
 */
import type { IpcMain } from "electron";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  IPC,
  ContextGetSchema,
  ContextSaveSchema,
  ToolsUsageGetSchema,
  type ToolUsageGroup,
  type ToolUsageItem,
  type ToolsUsageResult,
} from "@contracts/ipc";
import type { McpToolSpec } from "@main/mcp/sdk.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { estimateToolTokens } from "@main/lib/tokenEstimate.js";
import { workflowMcpTools } from "@main/mcp/mcodeServer.js";
import { libraryMcpTools } from "@main/mcp/libraryServer.js";
import { BROWSER_TOOL_SPECS } from "@main/browser/agentBrowserTools.js";
import {
  getMcpManagement,
  readUserClaudeJson,
  mcpServersOf,
  parseMcpConfig,
  describeMcpConfig,
} from "@main/lib/mcpConfig.js";
import { listPluginMcpPanelEntries } from "@main/plugins/pluginManager.js";
import {
  instructionsSourcePath,
  ensureMaterialized,
  readInstructionsState,
  readInstructionsSource,
  writeInstructionsAt,
} from "@main/lib/appContext.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";

/** claude 的消费点:CLAUDE_CONFIG_DIR 钉在 ~/.mcode,CLI 在 settingSources=
 *  ["user"] 下唯一会读的用户级记忆文件。 */
const CLAUDE_MD = path.join(MCODE_CONFIG_DIR, "CLAUDE.md");

/** 收养候选(依序):目前只有 claude 的 CLAUDE.md —— 它是唯一可能装着用户
 *  手写指令的消费点。codex 的 AGENTS.md 是组装产物,不收养。 */
const ADOPT_TARGETS = [CLAUDE_MD];

export function registerContextHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CONTEXT_GET, (_evt, raw) => {
    // `?? {}`(同 `outputStyle.list` / `library.*` / `memory.list` 的写法):无参
    // invoke 时 handler 收到的是 `undefined`,`z.object({})` 不接受它("Required")。
    // 渲染端走 `api.context.get({})` 没事,但 `app_api_call` 那条 AI 通路**明确
    // 让人对无参方法省略 input**(见 `appControl/tools.ts` 的 `app_api_call` 描述)→
    // 收到 `undefined` 就抛,AI 拿到的是一句 "参数不对:undefined Required" 而不是内容。
    ContextGetSchema.parse(raw ?? {});
    const source = instructionsSourcePath(dataRoot());
    // 惰性补物化:面板打开即修复漂移(消费点被手删/内容过期),不动 index.ts
    ensureMaterialized(source, [CLAUDE_MD]);
    const state = readInstructionsState(source, ADOPT_TARGETS);
    return { content: state.content };
  });

  ipcMain.handle(IPC.CONTEXT_SAVE, (_evt, raw) => {
    const input = ContextSaveSchema.parse(raw);
    // force=true:用户在面板里显式按了保存 —— 面板即管理者,覆盖无标记的
    // 手写消费点(收养流程已保证用户在编辑器里见过它的原内容)。
    return writeInstructionsAt(
      instructionsSourcePath(dataRoot()),
      [CLAUDE_MD],
      input.content,
      { force: true },
    );
  });

  ipcMain.handle(IPC.TOOLS_USAGE, async (_evt, raw) => {
    const input = ToolsUsageGetSchema.parse(raw);
    const groups: ToolUsageGroup[] = [];

    // ── 进程内工具(工作流 + 文献库):specs 就是线上形态的声明,直接估。
    // 各引擎经各自通路消费同一份表(claude 走 SDK MCP,codex/pi 走桥),静态
    // 开销一致 —— 所以这里不做引擎区分。
    const inSpecs = (specs: McpToolSpec[]): ToolUsageItem[] =>
      specs.map((spec) => {
        const jsonSchema = zodToJsonSchema(z.object(spec.inputSchema), {
          target: "jsonSchema7",
          $refStrategy: "none",
        }) as Record<string, unknown>;
        delete jsonSchema.$schema;
        return {
          name: spec.name,
          description: spec.description,
          estTokens: estimateToolTokens({ name: spec.name, description: spec.description, inputSchema: jsonSchema }),
        };
      });
    const inprocess = [...inSpecs(workflowMcpTools()), ...inSpecs(libraryMcpTools())];
    if (inprocess.length > 0) {
      groups.push({
        source: "inprocess",
        items: inprocess,
        totalEstTokens: inprocess.reduce((s, it) => s + (it.estTokens ?? 0), 0),
      });
    }

    // ── 内置浏览器工具:BROWSER_TOOL_SPECS 是各 provider 工具注册的同一份
    // 声明(描述齐、入参 schema 在各 provider 内联),按名字+描述估,会略低估。
    // 面板的开关(MCP 表 builtin 行)关掉时这一组不存在。
    const mgmt = await getMcpManagement();
    if (!mgmt.browserDisabled) {
      const items: ToolUsageItem[] = Object.values(BROWSER_TOOL_SPECS).map((spec) => ({
        name: spec.name,
        description: spec.description,
        estTokens: estimateToolTokens({ name: spec.name, description: spec.description }),
      }));
      groups.push({
        source: "builtin",
        items,
        totalEstTokens: items.reduce((s, it) => s + (it.estTokens ?? 0), 0),
      });
    }

    // ── 用户配置的 MCP:启用 = 配置在 ~/.mcode/.claude.json 里(文件即启用
    // 机制)。连接前拿不到工具清单,只列服务器行(estTokens: null)。
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const userItems: ToolUsageItem[] = Object.entries(fileServers).map(([name, rawConfig]) => {
      const config = parseMcpConfig(rawConfig);
      return {
        name,
        description: config ? describeMcpConfig(config).detail : "(配置无法解析,CLI 原样加载)",
        estTokens: null,
      };
    });
    if (userItems.length > 0) {
      groups.push({
        source: "userMcp",
        items: userItems,
        totalEstTokens: 0,
        note: "外部服务器需连接后才能统计工具级占用;此处仅列出服务器。",
      });
    }

    // ── 插件自带的 MCP(`<plugin>__<server>` 命名空间):同上,列服务器。
    const pluginEntries = await listPluginMcpPanelEntries();
    const pluginItems: ToolUsageItem[] = pluginEntries
      .filter((e) => e.scope === "plugin")
      .map((e) => ({ name: e.name, description: e.detail, estTokens: null }));
    if (pluginItems.length > 0) {
      groups.push({
        source: "pluginMcp",
        items: pluginItems,
        totalEstTokens: 0,
        note: "插件服务器的工具清单同样需连接后才能统计。",
      });
    }

    const result: ToolsUsageResult = {
      engine: input.engine,
      groups,
      totalEstTokens: groups.reduce((s, g) => s + g.totalEstTokens, 0),
    };
    return result;
  });
}

/** 供 codex/pi 的会话启动组装链读事实源(不带收养语义)。 */
export function globalInstructionsForEngines(): string {
  return readInstructionsSource(instructionsSourcePath(dataRoot()));
}
