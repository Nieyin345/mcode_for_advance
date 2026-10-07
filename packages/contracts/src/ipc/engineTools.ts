/**
 * **按引擎的内置工具禁用** —— IPC 契约（设置 → 引擎工具）。
 *
 * 三个引擎各自带一套内置工具（Claude 的 Bash/Read/Edit…、Pi 的 read/edit/bash…、
 * Codex 的壳命令）。用户在这里选择"关掉某个引擎的哪些内置工具"，用于把基础工具收敛到
 * 一份统一实现上（例如关掉原生 Read，强制走统一的文档读取工具）。
 *
 * 存储与语义见 `apps/desktop/src/main/lib/engineToolPolicy.ts`：缺省 = 不禁用；
 * 只持久化非空的 exclude。
 */
import { z } from "zod";

export const ENGINE_TOOL_ENGINE_IDS = ["claude", "pi", "codex"] as const;
export type EngineToolEngineId = (typeof ENGINE_TOOL_ENGINE_IDS)[number];

/** 单个引擎在该策略下的状态。 */
export interface EngineToolEngineState {
  /** 该引擎当前**不可用**的内置工具名（已规范、去重、升序）。 */
  exclude: string[];
  /** 该引擎能否**真正**按名删内置工具。Codex 为 false —— 它只有沙箱/审批档，
   *  UI 据此如实提示"环境限制，无法按名禁用"，不要把"设置了"当"生效了"。 */
  supported: boolean;
  /** 该引擎**已知**的内置工具名（只读，供 UI 列出来勾选）。可能为空 —— 该引擎的
   *  内置工具随 SDK 版本变化，这里只列可静态确定的常见那几个。 */
  known: string[];
}

/** `engineTools.get` 的完整快照（三个引擎各一份状态）。 */
export interface EngineToolsSnapshot {
  engines: Record<EngineToolEngineId, EngineToolEngineState>;
}

/** 无参 get（保持 schema 一致，避免"空 object schema"那类坑）。 */
export const EngineToolsGetInputSchema = z.object({});
export type EngineToolsGetInput = z.infer<typeof EngineToolsGetInputSchema>;

/** 写入某个引擎的禁用列表（全量替换该引擎的 exclude）。 */
export const EngineToolsSetInputSchema = z.object({
  engine: z.enum(ENGINE_TOOL_ENGINE_IDS),
  /** 工具名列表；空数组 = 该引擎不设限。非法名由主进程逐项剔除。 */
  exclude: z.array(z.string()),
});
export type EngineToolsSetInput = z.infer<typeof EngineToolsSetInputSchema>;
