/**
 * 「引擎工具」设置面板的 IPC —— 按引擎禁用内置工具（见 `lib/engineToolPolicy.ts`）。
 *
 * 纯文件策略，不碰数据库、不起引擎。两个 handler：
 *   - `get`：返回当前策略 + 每个引擎的 `supported`/`known`（UI 据此渲染勾选与提示）。
 *   - `set`：全量替换某引擎的 exclude 列表（非法名由策略层逐项剔除）。
 *
 * 生效时机：下次开跑那一轮（provider 在 `startTurn` 里读策略传给 SDK）。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import {
  EngineToolsSetInputSchema,
  ENGINE_TOOL_ENGINE_IDS,
  type EngineToolEngineId,
  type EngineToolsSnapshot,
} from "@contracts/ipc/engineTools";
import {
  engineSupportsToolExclusion,
  excludedToolsForEngine,
  readEngineToolPolicy,
  readEngineToolPolicyStatus,
  writeEngineToolPolicy,
  type EngineToolPolicy,
  type EngineToolPolicyRead,
} from "@main/lib/engineToolPolicy.js";
import { log } from "@main/lib/logger.js";
import { errText } from "@main/lib/ipcError.js";

/** 每个引擎**已知**的内置工具名，供 UI 列出来勾选。
 *
 *  ⚠️ 这些是**只读提示**，不是权威清单 —— 各引擎的内置工具随 SDK 版本变化。这里只列
 *  能静态确定的常见那几个；用户仍可手填任意名字（策略层只校验字符集，不校验"是否真是
 *  某引擎的工具"）。删减**不依赖**这份清单，它只影响 UI 勾选体验。 */
export const KNOWN_BUILTIN_TOOLS: Record<EngineToolEngineId, string[]> = {
  // Claude Code 的常见内置工具（见 SDK 的 `Options.tools` 说明与 canUseTool）。
  claude: [
    "Bash", "BashOutput", "KillShell",
    "Read", "Edit", "Write", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "Task", "TodoWrite",
    "WebFetch", "WebSearch",
  ],
  // Pi coding-agent 的内置工具（见 `@earendil-works/pi-coding-agent` 的 create*ToolDefinition）。
  pi: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  // Codex 的内置工具**无法按名禁用**（见 engineSupportsToolExclusion），故不列。
  codex: [],
};

/** 把当前策略 + 能力/已知清单拼成给 UI 的快照。 */
function snapshotOf(policy: EngineToolPolicy, read?: EngineToolPolicyRead): EngineToolsSnapshot {
  const engines = {} as EngineToolsSnapshot["engines"];
  for (const engine of ENGINE_TOOL_ENGINE_IDS) {
    engines[engine] = {
      exclude: excludedToolsForEngine(policy, engine),
      supported: engineSupportsToolExclusion(engine),
      known: KNOWN_BUILTIN_TOOLS[engine],
    };
  }
  // 【MC-071】带出策略文件的状态 —— 损坏时 UI 显式告警,而不是把 fail-open 当成用户主动启用。
  const snap: EngineToolsSnapshot = { engines };
  if (read) {
    snap.status = read.status;
    if (read.recovered) snap.recovered = true;
    if (read.status === "INVALID") snap.warning = `工具禁用配置损坏,${read.recovered ? "已回退到最后一份确认过的策略" : "当前按不设限处理"}:${read.error ?? "未知原因"}`;
  }
  return snap;
}

export function registerEngineToolHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ENGINE_TOOLS_GET, async () => {
    try {
      const read = readEngineToolPolicyStatus();
      return snapshotOf(read.policy, read);
    } catch (err) {
      // 读策略失败不该让面板崩 —— 返回"都不设限"的空策略。
      log.warn(`engineTools.get failed: ${(err as Error).message}`);
      return snapshotOf({});
    }
  });

  ipcMain.handle(IPC.ENGINE_TOOLS_SET, async (_evt, raw) => {
    // 校验放 try 里:zod 失败要翻成人话给面板(`EngineToolsPanel` 显示 `err.message`),
    // 而不是把裸 `ZodError`(整段 JSON)冒出去 —— 与下方 catch 用 errText 一致。
    let input;
    try {
      input = EngineToolsSetInputSchema.parse(raw);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
    try {
      const policy = readEngineToolPolicy();
      // 全量替换该引擎的 exclude（空数组 = 不设限，条目会被 minimize 掉）。
      const next: EngineToolPolicy = { ...policy, [input.engine]: { exclude: input.exclude } };
      writeEngineToolPolicy(next);
      const read = readEngineToolPolicyStatus();
      return { ok: true, snapshot: snapshotOf(read.policy, read) };
    } catch (err) {
      log.warn(`engineTools.set failed: ${errText(err)}`);
      return { ok: false, error: errText(err) };
    }
  });
}
