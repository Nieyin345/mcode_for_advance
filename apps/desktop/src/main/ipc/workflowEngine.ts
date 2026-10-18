/**
 * 【ARC-006 WF-INT】**第三方工作流引擎的 IPC 接线**。
 *
 * ## 与其它域同一条纪律
 *
 *   - 入参先过 zod（`@contracts/ipc/workflowEngine`），校验失败**不碰引擎**；
 *   - handler 不向渲染端抛异常 —— 一切失败都落在 `{ ok:false, reason }` 上；
 *   - 每条 handler 都过 `recordRpcHandler`，于是"桌面点按钮"与"Agent 经
 *     `app_api_call`"够到的是同一个函数。
 *
 * ## 引擎注册表由调用方注入
 *
 * 本模块不 import 生产单例 —— 套件注入自己的 `EngineRuntime`（假进程/真 HTTP 服务），
 * 生产装配传仓库级注册表。这样"起停状态机"可以在纯 node 里验。
 *
 * ## 数据目录
 *
 * 引擎自己的 `flows.json` / creds 落在 `<dataRoot>/workflow-engines/<engineId>/`。
 * 目录由**调用方**创建并传入（handler 不自己拼 dataRoot —— 那是宿主装配的事，
 * 也避免这一层把 electron 的 `app.getPath` 拖进来）。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  WorkflowEngineStartSchema,
  WorkflowEngineStopSchema,
  WorkflowEngineStatusSchema,
  WorkflowEngineNodeInstallSchema,
  WorkflowEngineNodeInstallRespondSchema,
  type WorkflowEngineListResult,
  type WorkflowEngineResult,
  type WorkflowEngineStatusView,
  type WorkflowEngineNodesListResult,
  type WorkflowEngineNodeInstallInput,
  type WorkflowEngineNodeInstallResult,
  type WorkflowEngineNodeInstallRespondInput,
} from "@contracts/ipc";
import { recordRpcHandler } from "@main/appControl/registry.js";
import { errText } from "@main/lib/ipcError.js";
import { log } from "@main/lib/logger.js";
import type { EngineRuntime, EngineRuntimeStatus } from "@main/workflowEngines/runtimeSupervisor.js";

/** 引擎注册表 —— 调用方注入。 */
export interface WorkflowEngineRegistry {
  /** 取或建一个引擎实例；未注册的 engineId 返回 null。 */
  get(engineId: string): EngineRuntime | null;
  /** 列出所有已知引擎 id。 */
  ids(): string[];
}

/** 引擎的启动参数（命令/参数/数据目录）也由装配层给 —— handler 不猜。 */
export interface WorkflowEngineLaunchSpec {
  command: string;
  args: (port: number, dataDir: string) => string[];
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** 宿主签发的控制面身份 —— 就绪探针据此确认「这是我们自己的引擎」（P1-3）。 */
  probeIdentity?: { adminToken: string };
}

export interface WorkflowEngineHandlerPorts {
  registry: WorkflowEngineRegistry;
  /** 取某个引擎的启动参数；未配置返回 null。 */
  launchSpec(engineId: string): WorkflowEngineLaunchSpec | null;
  /** 【ARC-006 Gate E】节点包清单（`engineNodeRegistry.ts` 的实例）。缺省 = 不提供
   *  安装面（`nodesList` 回空 + `nodeInstall` 显式拒绝，fail-closed）。 */
  nodes?: {
    /** 列已装节点（读清单；corrupt 带原因）。 */
    list(): Promise<WorkflowEngineNodesListResult>;
    /** 安装（调 `installEngineNode`，审批端口已由装配层接好）。 */
    /** 绑定本次操作来源的真实 webContents id；缺失身份拒绝安装。 */
    install(input: WorkflowEngineNodeInstallInput, senderId: number): Promise<WorkflowEngineNodeInstallResult>;
    /** 必须核对回答者就是申请窗口，而非只信 requestId。 */
    respond(input: WorkflowEngineNodeInstallRespondInput, senderId: number): boolean;
  };
}

function failed(err: unknown, status: WorkflowEngineStatusView | null = null): WorkflowEngineResult {
  return { ok: false, reason: errText(err), status };
}

/** 把内部状态翻成契约视图：地址只在 running 时给出，且恒为回环。 */
export function toStatusView(status: EngineRuntimeStatus): WorkflowEngineStatusView {
  return {
    engineId: status.engineId,
    state: status.state,
    port: status.port,
    reason: status.reason,
    editorUrl: status.state === "running" && status.port !== null
      ? `http://127.0.0.1:${status.port}/`
      : null,
  };
}

export function registerWorkflowEngineHandlers(ipc: IpcMain, ports: WorkflowEngineHandlerPorts): void {
  const onStart = async (_evt: unknown, raw: unknown): Promise<WorkflowEngineResult> => {
    let status: WorkflowEngineStatusView | null = null;
    try {
      const input = WorkflowEngineStartSchema.parse(raw);
      const runtime = ports.registry.get(input.engineId);
      if (runtime === null) return failed(`未知工作流引擎：${input.engineId}`, null);
      const spec = ports.launchSpec(input.engineId);
      if (spec === null) return failed(`引擎 ${input.engineId} 没有配置启动命令`, toStatusView(runtime.status()));
      const result = await runtime.start({
        engineId: input.engineId,
        dataDir: spec.dataDir,
        command: spec.command,
        args: spec.args,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        ...(spec.probeIdentity !== undefined ? { probeIdentity: spec.probeIdentity } : {}),
      });
      status = toStatusView(result);
      if (result.state === "failed") {
        // 失败也回 ok:false + 当前状态 —— 调用方能看到"停在哪一步"。
        return { ok: false, reason: result.reason ?? "引擎启动失败", status };
      }
      log.info(`[workflow-engine:${input.engineId}] start → ${result.state}`);
      return { ok: true, status };
    } catch (err) {
      return failed(err, status);
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_START, onStart);
  ipc.handle(IPC.WORKFLOW_ENGINE_START, onStart);

  const onStop = async (_evt: unknown, raw: unknown): Promise<WorkflowEngineResult> => {
    try {
      const input = WorkflowEngineStopSchema.parse(raw);
      const runtime = ports.registry.get(input.engineId);
      if (runtime === null) return failed(`未知工作流引擎：${input.engineId}`, null);
      const result = await runtime.stop();
      return { ok: true, status: toStatusView(result) };
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_STOP, onStop);
  ipc.handle(IPC.WORKFLOW_ENGINE_STOP, onStop);

  const onStatus = async (_evt: unknown, raw: unknown): Promise<WorkflowEngineResult> => {
    try {
      const input = WorkflowEngineStatusSchema.parse(raw);
      const runtime = ports.registry.get(input.engineId);
      if (runtime === null) return failed(`未知工作流引擎：${input.engineId}`, null);
      return { ok: true, status: toStatusView(runtime.status()) };
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_STATUS, onStatus);
  ipc.handle(IPC.WORKFLOW_ENGINE_STATUS, onStatus);

  const onList = (): WorkflowEngineListResult => {
    const engines: WorkflowEngineStatusView[] = [];
    for (const id of ports.registry.ids()) {
      const runtime = ports.registry.get(id);
      if (runtime !== null) engines.push(toStatusView(runtime.status()));
    }
    return { engines };
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_LIST, onList);
  ipc.handle(IPC.WORKFLOW_ENGINE_LIST, onList);

  // 【ARC-006 Gate E】节点包：列表只读、安装走审批硬前置、respond 只兑现一次请求。
  // 三条都过 `recordRpcHandler`（与其它域同一条纪律）；安装的审批由 `nodes.install`
  // 背后的路由完成 —— handler 这一层**不接受**任何 approvedByUser 字段。
  const onNodesList = async (): Promise<WorkflowEngineNodesListResult> => {
    if (ports.nodes === undefined) return { corrupt: null, nodes: [] };
    try {
      return await ports.nodes.list();
    } catch (err) {
      return { corrupt: errText(err), nodes: [] };
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_NODES_LIST, onNodesList);
  ipc.handle(IPC.WORKFLOW_ENGINE_NODES_LIST, onNodesList);

  const senderIdOf = (evt: unknown): number | null => {
    const id = (evt as { sender?: { id?: unknown } } | null)?.sender?.id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const onNodeInstall = async (evt: unknown, raw: unknown): Promise<WorkflowEngineNodeInstallResult> => {
    try {
      const input = WorkflowEngineNodeInstallSchema.parse(raw);
      if (ports.nodes === undefined) {
        return { ok: false, code: "approval_unavailable", reason: "当前宿主没有配置节点包安装通道，已拒绝安装" };
      }
      const senderId = senderIdOf(evt);
      if (senderId === null) return { ok: false, code: "approval_unavailable", reason: "没有可信安装发起窗口，已拒绝" };
      return await ports.nodes.install(input, senderId);
    } catch (err) {
      return { ok: false, code: "invalid", reason: errText(err) };
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_NODE_INSTALL, onNodeInstall);
  ipc.handle(IPC.WORKFLOW_ENGINE_NODE_INSTALL, onNodeInstall);

  const onNodeInstallRespond = async (evt: unknown, raw: unknown): Promise<{ ok: boolean }> => {
    try {
      const input = WorkflowEngineNodeInstallRespondSchema.parse(raw);
      if (ports.nodes === undefined) return { ok: false };
      const senderId = senderIdOf(evt);
      return { ok: senderId !== null && ports.nodes.respond(input, senderId) };
    } catch {
      // 形状非法 / 迟到应答：`ok:false`（不抛 —— 与其它 handler 同一条取向）。
      return { ok: false };
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_NODE_INSTALL_RESPOND, onNodeInstallRespond);
  ipc.handle(IPC.WORKFLOW_ENGINE_NODE_INSTALL_RESPOND, onNodeInstallRespond);
}
