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
/** T59: explicitly load a library document into the native editor canvas. */
export const WORKFLOW_ENGINE_LOAD_CHANNEL = "workflowEngine:load";
/** 【ARC-006 Gate E】已装节点包（只读）。 */
export const WORKFLOW_ENGINE_NODES_LIST_CHANNEL = "workflowEngine:nodesList";
/** 【ARC-006 Gate E】安装一个节点包（主进程路由 `installEngineNode`，审批硬前置）。 */
export const WORKFLOW_ENGINE_NODE_INSTALL_CHANNEL = "workflowEngine:nodeInstall";
/** 【ARC-006 Gate E】渲染端对「安装审批」的回答（主→渲染推送审批请求之后的应答）。
 *  不是"批准位"：它只回答**这一次**的审批请求，主进程不把它存成任何常驻状态。 */
export const WORKFLOW_ENGINE_NODE_INSTALL_RESPOND_CHANNEL = "workflowEngine:respondNodeInstallApproval";

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

export const WorkflowEngineLoadSchema = z.object({
  workflowId: z.string().min(1).max(200),
  confirmReplace: z.boolean().default(false),
}).strict();
export type WorkflowEngineLoadInput = z.input<typeof WorkflowEngineLoadSchema>;
export type WorkflowEngineLoadResult =
  | { ok: true }
  | { ok: false; reason: string; requiresConfirmation?: boolean };

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
  /** Current engine process only; not evidence of persistent restart authorization. */
  deploymentState?: "not-deployed" | "deployed" | "unknown";
}

export type WorkflowEngineResult =
  | { ok: true; status: WorkflowEngineStatusView }
  | { ok: false; reason: string; status: WorkflowEngineStatusView | null };

export interface WorkflowEngineListResult {
  engines: WorkflowEngineStatusView[];
}

/* ──────────────────── 【ARC-006 Gate E】节点包安装 ──────────────────── */

/** 一个已装节点包（对渲染端/Agent 的只读视图；**不含**包体路径以外的内部句柄）。 */
export interface WorkflowEngineNodeView {
  name: string;
  version: string;
  source: string;
  sha256: string;
  license: string;
  capabilities: string[];
  installedAt: number;
  approvedByUser: boolean;
}

export interface WorkflowEngineNodesListResult {
  /** 清单损坏时的显式诊断（`null` = 清单可读）。 */
  corrupt: string | null;
  nodes: WorkflowEngineNodeView[];
}

/** 安装请求的元数据。⚠️ **刻意没有 `approvedByUser`** —— 批准只能来自审批端口
 *  （见 `engineNodeInstallRoute.ts` 的防自授权说明）。 */
export const WorkflowEngineNodeMetaSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  source: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  license: z.string().min(1).max(200),
  capabilities: z.array(z.string().min(1).max(64)).max(16),
}).strict();
export type WorkflowEngineNodeMeta = z.infer<typeof WorkflowEngineNodeMetaSchema>;

export const WorkflowEngineNodeInstallSchema = z.object({
  /** 本地目录（已下载/解包后的节点包）。 */
  sourceDir: z.string().min(1).max(4096),
  meta: WorkflowEngineNodeMetaSchema,
}).strict();
export type WorkflowEngineNodeInstallInput = z.infer<typeof WorkflowEngineNodeInstallSchema>;

export type WorkflowEngineNodeInstallResult =
  | { ok: true; node: WorkflowEngineNodeView }
  | { ok: false; reason: string; code: "invalid" | "approval_denied" | "approval_unavailable" | "duplicate" | "install_failed" };

/** 渲染端对安装审批的回答。`requestId` 由主进程生成并随审批请求推送。 */
export const WorkflowEngineNodeInstallRespondSchema = z.object({
  requestId: z.string().min(1).max(200),
  /** 用户是否批准**这一次**安装。 */
  approved: z.boolean(),
}).strict();
export type WorkflowEngineNodeInstallRespondInput = z.infer<typeof WorkflowEngineNodeInstallRespondSchema>;

/** 主 → 渲染：一张安装审批卡。字段来自 `describeEngineNodeInstall`（与路由共用一份），
 *  渲染端只负责画。`network` 是给卡片选警示色的标记（与 `allowNetwork` 同一判据）。 */
export interface WorkflowEngineNodeInstallApprovalMessage {
  channel: "workflowEngine:nodeInstallApproval";
  requestId: string;
  name: string;
  version: string;
  source: string;
  license: string;
  capabilities: string[];
  network: boolean;
  sha256: string;
  intent: "install" | "upgrade";
}
