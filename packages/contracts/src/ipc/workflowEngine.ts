/**
 * 【ARC-006 WF-INT】**第三方工作流引擎**的 IPC 契约。
 *
 * ## 它是什么
 *
 * 用户要求像集成 GenOffice 一样集成成熟工作流引擎（Node-RED 为首选）。这类引擎
 * 是**独立进程 + 自己的 HTTP 编辑器**：Mcode 负责起停、端口、数据目录与治理，
 * 引擎负责流执行。这一份是那条边界的**唯一**形状来源。
 *
 * ## 为什么状态里没有命令与凭据
 *
 * `EngineStatus` 只回引擎 id、状态、端口与失败原因 —— **不回启动命令、env、
 * 数据目录的绝对路径**。渲染端只需要知道"能不能打开、监听在哪"；把完整命令摆到
 * 渲染端等于把宿主的进程拼装细节（可能含用户路径）暴露给页面与 Agent。
 *
 * ## 端口为什么恒为回环
 *
 * 编辑器 UI 由 Mcode 的 `WebContentsView` 加载，URL 是 `http://127.0.0.1:<port>/`；
 * 与文档视图同一条 URL 围栏（只放行本机回环）。契约里**没有** host 字段 ——
 * 调用方没有"绑 0.0.0.0"的表达能力。
 */
import { z } from "zod";

/* ── 通道常量 ── */
export const WORKFLOW_ENGINE_START_CHANNEL = "workflowEngine:start";
export const WORKFLOW_ENGINE_STOP_CHANNEL = "workflowEngine:stop";
export const WORKFLOW_ENGINE_STATUS_CHANNEL = "workflowEngine:status";
export const WORKFLOW_ENGINE_LIST_CHANNEL = "workflowEngine:list";

/** 引擎 id：稳定、小写、连字符分词（"node-red"）。 */
const EngineIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "引擎 id 只能是小写字母、数字与连字符");

export const WorkflowEngineStartSchema = z.object({
  engineId: EngineIdSchema,
}).strict();
export type WorkflowEngineStartInput = z.infer<typeof WorkflowEngineStartSchema>;

export const WorkflowEngineStopSchema = z.object({
  engineId: EngineIdSchema,
}).strict();
export type WorkflowEngineStopInput = z.infer<typeof WorkflowEngineStopSchema>;

export const WorkflowEngineStatusSchema = z.object({
  engineId: EngineIdSchema,
}).strict();
export type WorkflowEngineStatusInput = z.infer<typeof WorkflowEngineStatusSchema>;

/**
 * 一次引擎操作的统一结果。
 *
 * `reason` 是**给人看的句子**（引擎没装、就绪超时、进程崩溃……），不是异常原文 ——
 * 与 `DocViewResult` 同一条取向。`status` 是操作后的真实状态（失败时也能看到
 * 停在哪一步）。
 */
export interface WorkflowEngineStatusView {
  engineId: string;
  state: "stopped" | "starting" | "running" | "failed";
  /** 监听端口；未启动时为 null。恒在 127.0.0.1 上。 */
  port: number | null;
  /** 失败原因（人话）；其它状态为 null。 */
  reason: string | null;
  /** 能不能打开编辑器（running 才有地址）。 */
  editorUrl: string | null;
}

export type WorkflowEngineResult =
  | { ok: true; status: WorkflowEngineStatusView }
  | { ok: false; reason: string; status: WorkflowEngineStatusView | null };

export interface WorkflowEngineListResult {
  engines: WorkflowEngineStatusView[];
}
