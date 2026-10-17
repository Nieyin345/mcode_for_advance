/**
 * **GenOffice 无头 MCP server 的规范接线** —— 只产出"交给现有 MCP 登记表"的配置,
 * 不新造 MCP 客户端。
 *
 * ## 为什么是配置,不是第二个客户端
 *
 * `genoffice mcp` 自己就是一个标准 stdio MCP server（initialize / tools/list /
 * tools/call，换行分隔的 JSON-RPC）。Mcode 的 MCP 登记表（`lib/mcpConfig.ts` 的真相层
 * `userServers` + 引擎派生视图）本来就支持任意 stdio 条目：
 *
 *   - Claude：真相层物化进 `~/.mcode/.claude.json` 的 `mcpServers`，二进制按 "user"
 *     设置源自己装载；
 *   - Codex：物化进 `<CODEX_HOME>/config.toml` 的 `[mcp_servers.<名>]`；
 *   - 面板：`MCP_SAVE` / `MCP_TOGGLE` / `MCP_ENGINES_SET` 负责新增、开关与按引擎分配，
 *     `deriveMcpEngineView` 把"启用 ∧ 分配给该引擎"写回两个派生视图。
 *
 * 所以这里**不**实现工具代理、不读 GenOffice 的 tools/list、不转发 JSON-RPC —— 那会是
 * 第二套 MCP 客户端，且会让工具调用绕开引擎自己的审批闸门。本模块只做一件事：给出
 * **唯一一份正确的条目形状**（含下面那条围栏环境变量），供设置面板/自动化/回归网引用。
 *
 * ## 三个不可省的字段
 *
 *   - `command = process.execPath` + `ELECTRON_RUN_AS_NODE=1`：Mcode 的进程是 Electron，
 *     把 Electron 当 Node 跑固定快照的 CLI bundle（与 `document/genofficeCli.ts` 的
 *     `invoke`、GenOffice 自己的 Windows 安装片段同一条做法）。用户机器上不需要有
 *     PATH 里的 node。
 *   - `GENOFFICE_ALLOWED_ROOTS`：**没有它就不生成配置**。GenOffice 对"未设置"的语义是
 *     **不限制**（`packages/cli/src/fs.ts` 的 `allowedRoots()`：unset → null → 放行），
 *     而 MCP 拉起的子进程里**没有** Mcode 的 `findContainingWorkspaceRoot` 闸门 ——
 *     围栏只能落在 GenOffice 自己的 `assertAllowed` 上，由这个环境变量喂根集合。
 *     `allowedRoots` 必须由调用方用 Mcode 的同一批根算出来（项目 ∪ 会话工作树 ∪
 *     资料库/模版库，见 `lib/pathGuard.ts` 的 `userDocRootsForGuard`）；空数组一律拒绝，
 *     因为空/未设 = 不设防，那才是真正的旁路。
 *   - 条目名 `GENOFFICE_MCP_SERVER_NAME`：`genoffice` 不以 `mcode-` 开头，能通过
 *     `MCP_NAME_RE` 与 `isReservedMcpServerName`，不会被当成内置身份。
 *
 * ## 边界（如实写明,不是"已解决"）
 *
 *   1. **围栏是快照**：环境变量在条目保存时算一次。之后新建的项目/工作树不在其中
 *      （fail-closed：会被 GenOffice 拒绝），被删项目的路径仍会放行到下次重存为止。
 *      需要"活性围栏"的调用走 `document.*` IPC —— 那里每条 handler 现算
 *      `findContainingWorkspaceRoot`。MCP 条目是跨引擎的便利通道，不是替代品。
 *   2. **Pi**：`PiAgentSdkProvider.supportsMcp = false`，Pi 不装载任何 MCP server；
 *      这条配置对 Pi 无效（Pi 的文档读取走 `agent_read_document`）。
 *   3. **环境继承**：引擎拉起的 MCP 子进程继承引擎进程环境（SDK/Codex 的行为），
 *      与 `genofficeCli.invoke` 刻意"只给 PATH + ELECTRON_RUN_AS_NODE"不同。
 *   4. **工具面**：`genoffice mcp` 暴露的是完整的文档工具表（含 GenOffice 自己配置的
 *      `search`/`image`/`media` 云能力），但**不含**它的 agent 对话 —— agent loop 在
 *      `packages/agent-core`，`mcp` 命令不加载它。需要"只给本地编辑能力"时仍走
 *      `document.*`（`genofficeCli` 那一层不暴露云能力）。
 *
 * 纯模块：只依赖 node:path 与契约类型，可被无头套件直接打包。
 */
import { delimiter, isAbsolute, resolve } from "node:path";
import type { McpServerConfig } from "@contracts/ipc";

/** 面板/派生视图里的条目名。**不是**内置身份（不以 `mcode-` 开头）。 */
export const GENOFFICE_MCP_SERVER_NAME = "genoffice";

/** GenOffice 自己的路径围栏环境变量（`packages/cli/src/fs.ts`）。 */
export const GENOFFICE_ALLOWED_ROOTS_ENV = "GENOFFICE_ALLOWED_ROOTS";

export interface GenofficeMcpConfigInput {
  /** 固定快照 CLI bundle 的绝对路径（见 `document/genofficeCli.resolveGenofficeCliPath`）。 */
  cliPath: string;
  /** Mcode 的工作区根（绝对路径）。空数组会被拒绝 —— 见文件头第 2 条。 */
  allowedRoots: readonly string[];
  /** 跑 CLI 的解释器，默认 `process.execPath`（Electron-as-Node）。测试可注入。 */
  execPath?: string;
}

export type GenofficeMcpConfigResult =
  | { ok: true; config: McpServerConfig }
  | { ok: false; reason: string };

/**
 * 生成交给 MCP 登记表的 stdio 配置。任何一条前提不成立就**拒绝生成**（fail-closed），
 * 绝不产出一个没有围栏的条目。
 */
export function buildGenofficeMcpConfig(input: GenofficeMcpConfigInput): GenofficeMcpConfigResult {
  const execPath = input.execPath ?? process.execPath;
  if (!isAbsolute(input.cliPath)) {
    return { ok: false, reason: `GenOffice CLI 路径必须是绝对路径:${input.cliPath}` };
  }
  if (!isAbsolute(execPath)) {
    return { ok: false, reason: `解释器路径必须是绝对路径:${execPath}` };
  }
  const roots = [...new Set(input.allowedRoots.map((r) => r.trim()).filter(Boolean))];
  if (roots.length === 0) {
    // GenOffice 对未设置的语义是"不限制" —— 空集合生成出来的条目等于拆掉围栏。
    return {
      ok: false,
      reason: "allowedRoots 为空等于不设围栏（GenOffice 对未设置 GENOFFICE_ALLOWED_ROOTS 的语义是不限制），拒绝生成配置",
    };
  }
  const relative = roots.find((r) => !isAbsolute(r));
  if (relative !== undefined) {
    return { ok: false, reason: `工作区根必须是绝对路径:${relative}` };
  }
  const config: McpServerConfig = {
    type: "stdio",
    command: execPath,
    args: [input.cliPath, "mcp"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      [GENOFFICE_ALLOWED_ROOTS_ENV]: roots.map((r) => resolve(r)).join(delimiter),
    },
  };
  return { ok: true, config };
}
