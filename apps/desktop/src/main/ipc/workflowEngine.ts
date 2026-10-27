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
  WorkflowEngineLoadSchema,
  type WorkflowEngineLoadResult,
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
  /** T59: one host-controlled entry shared by UI and Agent app_api. */
  load?(workflowId: string, confirmReplace: boolean): Promise<WorkflowEngineLoadResult>;
  /** 【ARC-006 Gate E】启动前验证可执行节点清单、处理可信的崩溃备份并恢复撤权。
   *  抛错必须阻断 spawn；纯状态机测试可不装配。 */
  beforeStart?(engineId: string): Promise<void>;
  /**
   * 【Q9e】**用户打开工作流界面时按需启动引擎。**
   *
   * 与启动期的 `startEngineIfNeeded`（有 node-red 图才起）不同：这里的判据是
   * **用户已经走到要用它的地方**。全新用户库里一张图都没有，启动期那条会静默跳过，
   * 于是第一次点开工作流看到「引擎未就绪」，必须先按一次「启动」才能画 ——
   * 那不是"下载就能用"。
   *
   * **可选**：纯状态机套件不装配时，`onList` 仍是纯读（不给测试带来进程启动）。
   * 失败**不影响列表返回** —— 界面要能看到状态与原因，而不是整页炸掉。
   */
  ensureStarted?(engineId: string): Promise<{ started: boolean; reason: string | null }>;
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

/**
 * 【Q5】迁移待办的事实来源 —— 由装配层注入（`ipc/index.ts` 读设置）。
 *
 * 做成注入而不是在这里 import `SettingRepo`：本模块被多个无头套件用桩替代仓储层，
 * 顶层 import 会在打包期就失败（同一个理由见 `nativeRunHistory.ts` 顶部那段）。
 */
let pendingMigrationProvider: (() => WorkflowEngineStatusView["pendingMigration"]) | null = null;

export function setPendingMigrationProvider(
  provider: (() => WorkflowEngineStatusView["pendingMigration"]) | null,
): void {
  pendingMigrationProvider = provider;
}

/** 把内部状态翻成契约视图：地址只在 running 时给出，且恒为回环。 */
export function toStatusView(status: EngineRuntimeStatus): WorkflowEngineStatusView {
  return {
    engineId: status.engineId,
    state: status.state,
    port: status.port,
    reason: status.reason,
    ...(status.deploymentState === undefined ? {} : { deploymentState: status.deploymentState }),
    ...(status.libraryMirrorPending === undefined ? {} : { libraryMirrorPending: status.libraryMirrorPending }),
    ...(status.libraryMirrorError === undefined ? {} : { libraryMirrorError: status.libraryMirrorError }),
    ...(status.trustedAtStart === undefined ? {} : { trustedAtStart: status.trustedAtStart }),
    ...(() => {
      // 迁移待办与引擎是否在跑无关 —— 引擎停着也要能告诉用户"这几张图没迁"。
      const pending = pendingMigrationProvider?.() ?? null;
      return pending === null ? {} : { pendingMigration: pending };
    })(),
    editorUrl: status.state === "running" && status.port !== null
      ? `http://127.0.0.1:${status.port}/`
      : null,
  };
}

/**
 * **启动一个引擎 —— UI 按钮与应用自启共用的唯一实现。**
 *
 * 抽出来是因为两条入口（`workflowEngine.start` IPC 与
 * `engineAutostart.startEngineIfNeeded`）必须走**同一串**前置校验：
 * `beforeStart`（可执行节点清单/崩溃备份/撤权恢复）→ `launchSpec`（bootstrap 完整性、
 * 节点包校验、vendor 解析、Node 版本门槛）。少了任何一步，自启就会绕过一道安全门。
 *
 * 返回的 `ok:false` 不是异常 —— 它带着"停在哪一步"的状态，调用方据此记账。
 */
export async function startWorkflowEngine(
  ports: Pick<WorkflowEngineHandlerPorts, "registry" | "launchSpec" | "beforeStart">,
  engineId: string,
): Promise<WorkflowEngineResult> {
  let status: WorkflowEngineStatusView | null = null;
  try {
    const runtime = ports.registry.get(engineId);
    if (runtime === null) return failed(`未知工作流引擎：${engineId}`, null);
    // 清单/备份存在争议时绝不能先执行第三方 Node-RED 代码再报错。
    status = toStatusView(runtime.status());
    // Already running: this is a status request, not another launch.
    // Avoid regenerating bootstrap, verifying/installing the node pack,
    // and reading admin-token material on every repeated Start click.
    // The runtime is already owned/probed; EngineRuntime.start is
    // idempotent, but launchSpec() has disk work before it is called.
    if (status.state === "running") return { ok: true, status };
    await ports.beforeStart?.(engineId);
    const spec = ports.launchSpec(engineId);
    if (spec === null) return failed(`引擎 ${engineId} 没有配置启动命令`, toStatusView(runtime.status()));
    const result = await runtime.start({
      engineId,
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
    log.info(`[workflow-engine:${engineId}] start → ${result.state}`);
    return { ok: true, status };
  } catch (err) {
    return failed(err, status);
  }
}

export function registerWorkflowEngineHandlers(ipc: IpcMain, ports: WorkflowEngineHandlerPorts): void {
  const onStart = async (_evt: unknown, raw: unknown): Promise<WorkflowEngineResult> => {
    try {
      const input = WorkflowEngineStartSchema.parse(raw);
      return await startWorkflowEngine(ports, input.engineId);
    } catch (err) {
      return failed(err);
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

  const onList = async (): Promise<WorkflowEngineListResult> => {
    /* 【Q9e】用户打开了工作流界面 —— 这是明确的使用信号，引擎该在跑。
     *
     * 放在 `list` 而不是渲染端另调一个 start：面板一打开就会 list，用户看到的
     * 第一个状态就已经是"启动中"，不需要一个一闪而过的「未就绪 + 请点启动」。
     *
     * **失败不抛**：起不来的原因要经由下面的 status 如实透出（`state: "failed"` +
     * `reason`），而不是让整页变成一条异常。 */
    if (ports.ensureStarted !== undefined) {
      try {
        const result = await ports.ensureStarted("node-red");
        if (result.reason !== null) log.warn(`[workflow-engine:node-red] 打开工作流界面时启动失败：${result.reason}`);
      } catch (err) {
        log.warn(`[workflow-engine:node-red] 打开工作流界面时启动抛错：${(err as Error).message}`);
      }
    }
    const engines: WorkflowEngineStatusView[] = [];
    for (const id of ports.registry.ids()) {
      const runtime = ports.registry.get(id);
      if (runtime !== null) engines.push(toStatusView(runtime.status()));
    }
    return { engines };
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_LIST, onList);
  ipc.handle(IPC.WORKFLOW_ENGINE_LIST, onList);

  const onLoad = async (_evt: unknown, raw: unknown): Promise<WorkflowEngineLoadResult> => {
    try {
      const input = WorkflowEngineLoadSchema.parse(raw);
      if (!ports.load) return { ok: false, reason: "工作流原生装载未配置" };
      return await ports.load(input.workflowId, input.confirmReplace);
    } catch (err) {
      return { ok: false, reason: errText(err) };
    }
  };
  recordRpcHandler(IPC.WORKFLOW_ENGINE_LOAD, onLoad);
  ipc.handle(IPC.WORKFLOW_ENGINE_LOAD, onLoad);

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
    const event = evt as {
      sender?: { id?: unknown; mainFrame?: unknown };
      senderFrame?: unknown;
    } | null;
    // MC-057：id 只标识 WebContents，不标识其中哪个 frame。
    // 子 frame 与主窗口共享 sender.id；即使拿到了 requestId，也不能代答真人审批。
    // 缺 frame 证据（Agent/合成 IPC/销毁中的 frame）必须 fail-closed。
    if (event?.senderFrame == null || event.sender?.mainFrame == null || event.senderFrame !== event.sender.mainFrame) {
      return null;
    }
    const id = event.sender.id;
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
