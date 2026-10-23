/**
 * T8 —— Node-RED 原生画布的**真 Electron 装配层**（跑在探针主进程里）。
 *
 * ## 装配的是生产代码，不是仿制品
 *
 *  - `ProductionWorkflowEngineRegistry`：生产注册表（真 `createEngineLaunchSpec`、
 *    真 vendor 解析、真 `EngineRuntime` spawn、真 owner 预领取、真 Deploy 对账）；
 *  - `DocumentViewHost` 单例 + `registerDocumentViewHandlers`：生产宿主与生产 IPC；
 *  - `DocumentViewCredentialBroker`：生产凭据注入（令牌只从引擎数据目录读，经
 *    `session.webRequest.onBeforeSendHeaders` 按 webContentsId + 回环 origin 附加）；
 *  - `loadWorkflowIntoNative`：生产「库 → 原生画布」装载入口（`ipc/index.ts` 的
 *    `load` 端口就是它）；
 *  - `automationRunner`：生产旧自动化执行器（T3 的触发器归属门禁在它里面）。
 *
 * ## 与生产 `ipc/index.ts` 的差异（逐条，都是**隔离**，不是判据放松）
 *
 *  1. **数据根**：启动器给的 mktemp 目录（`electron-host.cjs` 写 data-root.json）。
 *     生产是用户主目录下的 `Mcode`。
 *  2. **Node-RED 安装**：生产按 `process.resourcesPath` / `app.getAppPath()` 找 vendor；
 *     探针把 `process.resourcesPath` 指向一棵**只含 `node-red` junction 的 resources
 *     根**，链回仓库 `node-red/`（gitignored vendor checkout，5.0.8）。完全走生产的
 *     `resolveNodeRedPackage`，不手拼 NODE_PATH。
 *  3. **窗口**：`@main/window.js` 别名到 `window-holder.ts`（与 T7 同一取舍）。
 *  4. **文档视图 preload**：`resolveViewPreload()` 从 `__dirname` 取
 *     `documentViewPreload.js`；探针 bundle 的 `__dirname` 是构建目录，所以
 *     `prebuild.mjs` 在那里放一份生产源码的产物（与 T7 同一做法）。
 *  5. **窗口必须在屏上且足够宽**：`WebContentsView` 的 `sendInputEvent` 只在
 *     宿主窗口真实可见时投递；Node-RED 的节点编辑托盘比窄窗口宽 —— 窗口取
 *     1920×1040、视图占满。判据只读 DOM/磁盘，窗口只在旅程期间存在。
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { ipcMain, session } from "electron";

import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
import { EngineRuntime } from "@main/workflowEngines/runtimeSupervisor.js";
import { DocumentViewCredentialBroker, readEngineAdminToken } from "@main/document/documentViewCredentialBroker.js";
import { documentViewHost } from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { saveWorkflow, getWorkflow } from "@main/orchestration/library.js";
import { workflowReviewOf } from "@main/orchestration/workflowTrust.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { loadWorkflowIntoNative } from "@main/workflowEngines/nativeLibraryLoad.js";
import { sharedExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import {
  readNativeDeployReconciliation,
  type NativeDeployReconciliation,
} from "@main/workflowEngines/nativeLibrarySync.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";
import { EngineNodeRegistry } from "@main/workflowEngines/engineNodeRegistry.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import type { AutomationTriggerFacts } from "@main/orchestration/automationStatus.js";
import { setMainWindowForU1 } from "./window-holder.js";

/** 本套件的 SQL 项目 id（夹具行）。 */
export const PROJECT_ID = "proj_t8_fixture";

/** 引擎编辑器视图的 docId（与生产 `EngineRuntimePanel.engineDocId` 同形）。 */
export const ENGINE_DOC_ID = "workflow-engine-node-red";

export interface NativeLoadOutcome {
  ok: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

export interface T8Harness {
  win: BrowserWindow | null;
  registry: ProductionWorkflowEngineRegistry;
  engineDir: string;
  /** 引擎运行面（生产 `OwnedNodeRedRuntime`：状态、启动、Deploy 对账状态都在它上面）。 */
  runtime(): import("@main/workflowEngines/registry.js").OwnedNodeRedRuntime;
  /** `running` / `stopped` / `starting` / `failed` / `absent`。 */
  engineState(): string;
  enginePort(): number | null;
  startEngine(): Promise<{ ok: boolean; reason?: string; port: number | null }>;
  stopEngine(): Promise<void>;
  /** 生产「库 → 原生画布」装载（`ipc/index.ts` 的同一组 ports）。 */
  loadWorkflow(workflowId: string, confirmReplace: boolean): Promise<NativeLoadOutcome>;
  /** 生产 `documentView:open`（同一个函数对象，带引擎凭据身份）。 */
  openEngineEditor(): Promise<{ ok: boolean; reason?: string }>;
  editorWebContents(): WebContents | null;
  closeEditor(): void;
  /** 原生 flows.json（解析后的数组；缺失/坏档 → null）。 */
  nativeFlows(): unknown[] | null;
  /** 原生 flows.json 的原始字节（不存在 → null）。 */
  nativeFlowsBytes(): Buffer | null;
  reconcileLedger(): NativeDeployReconciliation;
  /** 旧自动化执行器的事实表（T3 的读口）。 */
  triggerFacts(): AutomationTriggerFacts[];
  startAutomation(): Promise<void>;
  stopAutomation(): void;
  /** 引擎数据目录里的 owner 账本（新起一个只读 store 看盘上事实）。 */
  ownershipRecords(): Array<{ flowId: string; owner: string }>;
  dispose(): void;
}

/**
 * 装配一次。**可重入**：relaunch 之后新进程会再次调用（同一数据根、同一 engineDir）。
 */
export async function assembleHarness(options: {
  win: BrowserWindow | null;
  projectDir: string;
  repoRoot: string;
}): Promise<T8Harness> {
  const { win, projectDir, repoRoot } = options;

  // ── 1. 真数据库 + 真项目行 ──
  await initDb();
  if (!ProjectRepo.get(PROJECT_ID)) {
    const now = Date.now();
    ProjectRepo.create({
      id: PROJECT_ID,
      name: "T8 Node-RED 夹具项目",
      path: projectDir,
      archived: false,
      pinnedAt: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ── 2. vendor → resources 根（生产唯一解析入口读它）──
  const vendor = join(repoRoot, "node-red");
  const vendorPkg = join(vendor, "packages", "node_modules", "node-red", "package.json");
  if (!existsSync(vendorPkg)) throw new Error(`T8 harness: vendor Node-RED 缺失（${vendorPkg}）`);
  const vendorVersion = (JSON.parse(readFileSync(vendorPkg, "utf8")) as { version?: string }).version;
  if (vendorVersion !== "5.0.8") {
    throw new Error(`T8 harness: vendor 版本不是 5.0.8（实际 ${String(vendorVersion)}）`);
  }
  const runDir = process.env.MCODE_U1_RUN ?? "";
  if (runDir === "") throw new Error("T8 harness: MCODE_U1_RUN 未设置");
  const resources = join(runDir, "resources");
  mkdirSync(resources, { recursive: true });
  const staged = join(resources, "node-red");
  if (!existsSync(staged)) {
    symlinkSync(vendor, staged, process.platform === "win32" ? "junction" : "dir");
  }
  const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });

  // ── 3. 生产注册表（**唯一**实例）──
  const registry = new ProductionWorkflowEngineRegistry();
  const engineDir = registry.dataDirOf("node-red");

  // ── 4. 生产宿主单例 + 生产凭据注入（`ipc/index.ts` 同一份闭包形状）──
  setMainWindowForU1(win);
  const host = documentViewHost;
  host.setEditorCredentials(new DocumentViewCredentialBroker({
    readToken: (engineId) => {
      try { return readEngineAdminToken(registry.dataDirOf(engineId)); } catch { return null; }
    },
    runningPort: (engineId) => {
      const status = registry.statusOf(engineId);
      return status?.state === "running" ? status.port : null;
    },
    getSession: () => session.defaultSession,
  }));

  const recorder = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const recordingIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      recorder.set(channel, listener);
      (ipcMain as unknown as IpcMain).handle(channel, (event, raw) => listener(event, raw));
    },
    on(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      (ipcMain as unknown as IpcMain).on(channel, listener as never);
    },
    removeHandler(channel: string): void {
      recorder.delete(channel);
      ipcMain.removeHandler(channel);
    },
  } as unknown as IpcMain;
  registerDocumentViewHandlers(
    recordingIpc,
    host,
    (p) => findContainingWorkspaceRoot(p) !== null,
    undefined,
    // 生产 `isApprovedDocumentViewOpen` 的 `workflowEngineId` 分支同义：带引擎身份
    // 且是 http(s) 即进入 Host 的凭据预检；URL/端口/令牌由 Host 与 broker 复核。
    (input) => input.workflowEngineId !== undefined && /^https?:/i.test(input.url),
  );

  const engineNodeRegistry = new EngineNodeRegistry({ dataDir: engineDir, engineId: "node-red" });

  return {
    win,
    registry,
    engineDir,
    runtime: () => registry.get("node-red") as import("@main/workflowEngines/registry.js").OwnedNodeRedRuntime,
    engineState: () => registry.statusOf("node-red")?.state ?? "absent",
    enginePort: () => {
      const status = registry.statusOf("node-red");
      return status?.state === "running" ? status.port : null;
    },
    async startEngine() {
      const spec = registry.launchSpec("node-red");
      if (spec === null) return { ok: false, reason: "启动参数不可用（vendor 或节点包未就绪）", port: null };
      const runtime = registry.get("node-red") as EngineRuntime | null;
      if (runtime === null) return { ok: false, reason: "Node-RED 引擎未注册", port: null };
      try { await ensureEngineNodeReady(engineNodeRegistry); }
      catch (err) { return { ok: false, reason: err instanceof Error ? err.message : String(err), port: null }; }
      const status = await runtime.start({
        engineId: "node-red",
        dataDir: spec.dataDir,
        command: spec.command,
        args: spec.args,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        ...(spec.probeIdentity !== undefined ? { probeIdentity: spec.probeIdentity } : {}),
      });
      return status.state === "running"
        ? { ok: true, port: status.port }
        : { ok: false, reason: status.reason ?? "引擎未就绪", port: status.port };
    },
    async stopEngine() {
      const runtime = registry.get("node-red");
      if (runtime !== null) await runtime.stop();
    },
    async loadWorkflow(workflowId, confirmReplace) {
      const runtime = registry.get("node-red");
      if (runtime === null) return { ok: false, reason: "Node-RED 引擎未注册" };
      return await loadWorkflowIntoNative(workflowId, {
        get: getWorkflow,
        types: async () => new Map((await loadNodeTypes()).entries.map((entry) => [entry.id, entry.manifest])),
        dataDir: () => registry.dataDirOf("node-red"),
        migrationFacts: (doc) => ({
          review: workflowReviewOf(doc),
          inFlightWorkflowIds: sharedExecutorOwnership.runningFlowIds(),
        }),
        runtime,
        beforeStart: () => ensureEngineNodeReady(engineNodeRegistry),
        launchSpec: () => registry.launchSpec("node-red"),
      }, confirmReplace);
    },
    async openEngineEditor() {
      const status = registry.statusOf("node-red");
      if (status?.state !== "running" || status.port === null) return { ok: false, reason: "Node-RED 不在运行" };
      const result = host.open({
        docId: ENGINE_DOC_ID,
        url: `http://127.0.0.1:${status.port}/`,
        bounds: { x: 0, y: 0, width: win?.getContentBounds().width ?? 1900, height: win?.getContentBounds().height ?? 1000 },
        visible: true,
        workflowEngineId: "node-red",
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    editorWebContents() {
      const wc = host.webContentsOf(ENGINE_DOC_ID) as unknown as WebContents | null;
      return wc !== null && !wc.isDestroyed() ? wc : null;
    },
    closeEditor() {
      try { host.close(ENGINE_DOC_ID); } catch { /* 已关 */ }
    },
    nativeFlows() {
      const bytes = readNativeBytes(engineDir);
      if (bytes === null) return null;
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        return Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    },
    nativeFlowsBytes() {
      return readNativeBytes(engineDir);
    },
    reconcileLedger: () => readNativeDeployReconciliation(engineDir),
    triggerFacts() {
      const { automationRunner } = require("@main/orchestration/automationRunner.js") as
        typeof import("@main/orchestration/automationRunner.js");
      return automationRunner.statusAll();
    },
    async startAutomation() {
      const { automationRunner } = require("@main/orchestration/automationRunner.js") as
        typeof import("@main/orchestration/automationRunner.js");
      await automationRunner.start();
    },
    stopAutomation() {
      const { automationRunner } = require("@main/orchestration/automationRunner.js") as
        typeof import("@main/orchestration/automationRunner.js");
      automationRunner.dispose();
    },
    ownershipRecords() {
      const { FileExecutorOwnershipStore } = require("@main/workflowEngines/fileExecutorOwnershipStore.js") as
        typeof import("@main/workflowEngines/fileExecutorOwnershipStore.js");
      // 另一个只读实例（T4 的跨进程 CAS 保证读到的就是盘上事实）。
      return new FileExecutorOwnershipStore(engineDir).list().map((r) => ({ flowId: r.flowId, owner: r.owner }));
    },
    dispose() {
      try { host.dispose(); } catch { /* 已释放 */ }
      void registry.get("node-red")?.stop().catch(() => undefined);
      if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
      else Reflect.deleteProperty(process, "resourcesPath");
    },
  };
}

/** 建/更新一份夹具工作流（首次 expectedRevision=null，之后用当前版本）。 */
export async function saveFixture(doc: Parameters<typeof saveWorkflow>[0]): Promise<{ ok: boolean; error?: string }> {
  const previous = getWorkflow(doc.id);
  const expected = previous === null ? null : workflowSaveVersion(previous);
  return await saveWorkflow(doc, { expectedRevision: expected });
}

/** 原生 flows.json 的原始字节（缺失 → null）。ENGINE 数据目录由 harness 持有。 */
function readNativeBytes(engineDir: string): Buffer | null {
  try { return readFileSync(join(engineDir, "flows.json")); } catch { return null; }
}
