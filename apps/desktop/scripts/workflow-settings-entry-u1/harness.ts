/**
 * W26 —— 「设置 → 工作流 → 看到 Node-RED 画布」真 Electron 旅程的**主进程装配层**。
 *
 * ## 它与 T8 的 `assembleHarness` 有什么不同（以及为什么不复用它）
 *
 * T8 的 harness 装配的东西是**同一批生产实现**（`ProductionWorkflowEngineRegistry`、
 * 生产 `DocumentViewHost` 单例、生产凭据 broker、生产 `documentView` IPC），这一点
 * 本套件照抄 —— 本卡要证明的「视图真的开了」只有真宿主说得清。
 *
 * 不一样的是**页面**：T8 的旅程 `window:false`，页面是它的 `launch.setup` 返回的
 * 编辑器 `WebContents`；本套件的页面是**真 `App.tsx`**（`electron-u1/build.mjs`
 * 打的那个 bundle），也就是「用户看到的那一屏」。所以：
 *
 *  - 宿主窗口必须 `window:true`，且 `documentViewHost` 的 `getMainWindow()` 要拿到
 *    **这一个**窗口 —— 这正是 `window-holder.ts` 的作用；
 *  - 渲染端用**产品真 preload**（`preload: "product"`，`window.api` 是真的），
 *    于是 `EngineRuntimePanel` 的 `api.documentView.open(...)` 会真的到主进程；
 *  - `workflowEngine.*` 走**生产 handler**（`registerWorkflowEngineHandlers`），
 *    于是「启动」按钮背后的 `api.workflowEngine.start` 走的是与生产完全同一条链。
 *
 * ⚠️ **不 import T8 的 harness**：`t8-node-red-u1/` 是 W23 正在改的目录（卡上边界
 * 明写「不许碰」），而且它把 `engineDir` 与夹具工作流写死在 T8 的语义里。重写一份
 * 装配（逐项对齐、注释写明取舍）比跨套件耦合更安全。
 *
 * ## 隔离（逐条，都是**隔离**不是判据放松）
 *
 *  1. **数据根**：启动器 mktemp 出来的 `MCODE_U1_DATA`（`electron-host.cjs` 已经
 *     写好了 `userData/data-root.json` 指针）。生产是用户主目录下的 `Mcode`。
 *  2. **Node-RED 安装**：生产按 `process.resourcesPath` 找 vendor；这里把
 *     `process.resourcesPath` 指向 `<runDir>/resources`（只含一个链回仓库
 *     `node-red/` 的 junction）。**完全走生产的 `resolveNodeRedPackage`**。
 *  3. **窗口**：`@main/window.js` 别名到 `window-holder.ts`（T7/T8 同一取舍）。
 *  4. **文档视图 preload**：`resolveViewPreload()` 从 `__dirname` 取同名文件；
 *     `prebuild.mjs` 把生产源码的产物放在构建目录（同 T7/T8）。
 *  5. **`genoffice` 相关的两个 seam**：`--esbuild=` 的 alias 指到仓库自带的
 *     fail-closed stub（与没装 vendor 时的生产构建**同源**）。本卡判据不涉及任何
 *     GenOffice 编辑器。
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain, session } from "electron";

import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
import type { OwnedNodeRedRuntime } from "@main/workflowEngines/registry.js";
import { EngineRuntime } from "@main/workflowEngines/runtimeSupervisor.js";
import {
  DocumentViewCredentialBroker,
  readEngineAdminToken,
} from "@main/document/documentViewCredentialBroker.js";
import { documentViewHost } from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { registerWorkflowEngineHandlers } from "@main/ipc/workflowEngine.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { listWorkflows, getWorkflow } from "@main/orchestration/library.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { EngineNodeRegistry } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";
import { setMainWindowForU1 } from "./window-holder.js";
import { registerFillerHandlers } from "./filler-ipc.js";

/** 本套件的 SQL 项目 id（夹具行；`file:*` 之类守卫要它才放行）。 */
export const PROJECT_ID = "proj_w26_fixture";

export interface W26Harness {
  win: BrowserWindow | null;
  registry: ProductionWorkflowEngineRegistry;
  engineDir: string;
  /** 引擎运行面（生产 `OwnedNodeRedRuntime`）。 */
  runtime(): OwnedNodeRedRuntime;
  engineState(): string;
  enginePort(): number | null;
  /** 生产 `documentViewHost.list()` 的快照（判据 5 读它，不读 DOM）。 */
  viewSnapshots(): ReturnType<typeof documentViewHost.list>;
  /** 编辑器视图的 webContents（判据 6 的 URL 端口从这里读）。 */
  editorWebContents(): import("electron").WebContents | null;
  /** 填充层实际注册了哪些通道（证据）。 */
  fillerChannels: string[];
  dispose(): void;
}

/**
 * 装配的**全局前置**：资源根、注册表、宿主凭据、**全部 IPC handler**、真数据库。
 *
 * ## 为什么必须在 `beforeReady()` 里调（不能等 `launch.setup`）
 *
 * `electron-u1/driver/runner.ts` 的顺序是 `createWindow`（页面开始加载、React
 * 挂载、`App` 的 `init()` 立刻发 first-paint RPC）**然后**才跑 `launch.setup`。
 * 实测（W26 第二次跑）：`setting:getMany` / `project:list` / `theme:get` …
 * 在 handler 注册之前就发出去了 → 渲染端收到一串
 * `No handler registered for '…'`，`sessionStore.init()` 走进 `project.list failed`
 * 的降级分支。界面仍能渲染，但**那不是用户真的会看到的启动状态**。
 *
 * `electron-host.cjs` 在建窗口之前同步调用注册表的 `beforeReady()` —— 那时
 * `ipcMain` 已可用（Electron 允许 ready 之前注册 handler），数据根指针也已由
 * `electron-host` 写好。于是 handler 在**窗口出现之前**全部就位。
 *
 * **同步主体 + 一个异步尾巴**：`initDb()` 是 async，它的结果只被 `workflow:*`
 * 那几条真 handler 需要（`listWorkflows` 要 SQL 行）。所以本函数**同步**装好一切
 * 会注册 handler 的东西，把 `initDb` 挂成 promise；那几条 handler 自己 await 它。
 * 这样「handler 注册时机」是同步确定的，不靠运气。
 */
export interface W26Prepared {
  registry: ProductionWorkflowEngineRegistry;
  engineDir: string;
  fillerChannels: string[];
  originalResources: PropertyDescriptor | undefined;
  /** `initDb()` 的完成信号（`workflow:*` 真 handler 用）。 */
  dbReady: Promise<void>;
}

let prepared: W26Prepared | null = null;

export function prepareEnvironment(options: { repoRoot: string }): void {
  if (prepared !== null) return;
  const { repoRoot } = options;

  // ── 1. vendor → resources 根（生产唯一解析入口读它）──
  const vendor = join(repoRoot, "node-red");
  const vendorPkg = join(vendor, "packages", "node_modules", "node-red", "package.json");
  if (!existsSync(vendorPkg)) throw new Error(`W26 harness: vendor Node-RED 缺失（${vendorPkg}）`);
  const vendorVersion = (JSON.parse(readFileSync(vendorPkg, "utf8")) as { version?: string }).version;
  if (vendorVersion !== "5.0.8") {
    throw new Error(`W26 harness: vendor 版本不是 5.0.8（实际 ${String(vendorVersion)}）`);
  }
  const runDir = process.env.MCODE_U1_RUN ?? "";
  if (runDir === "") throw new Error("W26 harness: MCODE_U1_RUN 未设置");
  const resources = join(runDir, "resources");
  mkdirSync(resources, { recursive: true });
  const staged = join(resources, "node-red");
  if (!existsSync(staged)) {
    symlinkSync(vendor, staged, process.platform === "win32" ? "junction" : "dir");
  }
  const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });

  // ── 2. 生产注册表（**唯一**实例，与生产 `ipc/index.ts` 的 `workflowEngineRegistry` 同角色）──
  const registry = new ProductionWorkflowEngineRegistry();
  const engineDir = registry.dataDirOf("node-red");

  // ── 3. 生产宿主单例 + 生产凭据注入（与 `ipc/index.ts` 同一份闭包形状）──
  // ⚠️ `session.defaultSession` **不能**在 ready 之前取；broker 的 ports 是惰性
  // 回调，这里传箭头函数（取 session 发生在 bind 时 = ready 之后）。
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

  registerDocumentViewHandlers(
    ipcMain,
    host,
    (p) => findContainingWorkspaceRoot(p) !== null,
    undefined,
    // 生产 `isApprovedDocumentViewOpen` 的 `workflowEngineId` 分支同义。
    (input) => input.workflowEngineId !== undefined && /^https?:/i.test(input.url),
  );

  // ── 4. 生产 workflowEngine handler（「启动」按钮背后的那条链）──
  const engineNodeRegistry = new EngineNodeRegistry({ dataDir: engineDir, engineId: "node-red" });
  registerWorkflowEngineHandlers(ipcMain, {
    registry,
    launchSpec: (engineId) => registry.launchSpec(engineId),
    beforeStart: async (engineId) => {
      if (engineId === "node-red") await ensureEngineNodeReady(engineNodeRegistry);
    },
    nodes: {
      list: async () => {
        const state = await engineNodeRegistry.readState();
        if (state.kind === "corrupt") return { corrupt: state.reason, nodes: [] };
        return {
          corrupt: null,
          nodes: state.entries.map((entry) => ({
            name: entry.name, version: entry.version, source: entry.source,
            sha256: entry.sha256, license: entry.license,
            capabilities: [...entry.capabilities], installedAt: entry.installedAt,
            approvedByUser: entry.approvedByUser,
          })),
        };
      },
      // 安装面不在本卡判据里。**fail-closed**：回答「没有审批通道」，不假装能装。
      install: async () => ({ ok: false, code: "approval_unavailable", reason: "W26 套件不提供节点包安装面" }),
      respond: () => false,
    },
  });

  // ── 5. 其余只读域的填充层（真 App 启动水合要它们；撞上真实现会抛错）──
  const taken = new Set<string>([
    ...[
      "documentView:open", "documentView:openPath", "documentView:bounds", "documentView:show",
      "documentView:hide", "documentView:focus", "documentView:close", "documentView:list",
    ],
    ...[
      "workflowEngine:start", "workflowEngine:stop", "workflowEngine:status", "workflowEngine:list",
      "workflowEngine:load", "workflowEngine:nodesList", "workflowEngine:nodeInstall",
      "workflowEngine:respondNodeInstallApproval",
    ],
    ...[
      "workflow:nodeTypes", "workflow:agentProfiles", "workflow:list", "workflow:get",
    ],
  ]);
  const filler = registerFillerHandlers(ipcMain, taken);

  // ── 6. 真数据库（异步尾巴）+ 工作流域的**真**只读口 ──
  //
  // 为什么这几条是真实现而不是填充：`WorkflowsPanel` 打开时就读 `workflow.nodeTypes`
  // 与 `workflow.agentProfiles`（`useRpc`），它们的消费方会把 null/坏形状渲染成
  // 「加载失败」。用真实现（真读仓库内置节点类型、真读临时数据根下的档案目录）比
  // 造一份形状正确的假清单更接近用户看到的东西，而且它们**不拖入聊天运行时**。
  const dbReady = (async () => {
    await initDb();
    if (!ProjectRepo.get(PROJECT_ID)) {
      const now = Date.now();
      ProjectRepo.create({
        id: PROJECT_ID,
        name: "W26 设置入口夹具项目",
        path: process.env.MCODE_U1_PROJECT ?? "",
        archived: false,
        pinnedAt: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  })();
  const { readAgentProfiles } = require("@main/orchestration/agentProfiles.js") as
    typeof import("@main/orchestration/agentProfiles.js");
  ipcMain.handle("workflow:nodeTypes", async () => await loadNodeTypes());
  ipcMain.handle("workflow:agentProfiles", async () => readAgentProfiles());
  ipcMain.handle("workflow:list", async () => {
    await dbReady;
    return { workflows: listWorkflows() };
  });
  ipcMain.handle("workflow:get", async (_evt: unknown, raw: unknown) => {
    await dbReady;
    const input = raw as { id?: unknown } | null;
    const id = typeof input?.id === "string" ? input.id : "";
    const workflow = getWorkflow(id);
    return {
      workflow,
      revision: workflow === null ? null : workflowSaveVersion(workflow),
      review: null,
    };
  });

  prepared = { registry, engineDir, fillerChannels: filler, originalResources, dbReady };
}

/**
 * 每趟旅程的**窗口级**装配（`launch.setup` 里调）：把宿主窗口交给生产单例。
 * 其余（handler / 注册表 / 凭据 / 数据库）已在 {@link prepareEnvironment} 完成。
 */
export async function assembleHarness(options: {
  win: BrowserWindow | null;
  projectDir: string;
  repoRoot: string;
}): Promise<W26Harness> {
  const { win, repoRoot } = options;
  prepareEnvironment({ repoRoot });
  if (prepared === null) throw new Error("W26 harness: prepareEnvironment 没有建立装配");
  const { registry, engineDir, fillerChannels, originalResources, dbReady } = prepared;
  await dbReady.catch(() => undefined); // 旅程优先：数据库失败由 workflow:* handler 自己报
  const host = documentViewHost;
  setMainWindowForU1(win);

  return {
    win,
    registry,
    engineDir,
    runtime: () => registry.get("node-red") as OwnedNodeRedRuntime,
    engineState: () => registry.statusOf("node-red")?.state ?? "absent",
    enginePort: () => {
      const status = registry.statusOf("node-red");
      return status?.state === "running" ? status.port : null;
    },
    viewSnapshots: () => host.list(),
    editorWebContents: () => {
      const wc = host.webContentsOf("workflow-engine-node-red") as unknown as import("electron").WebContents | null;
      return wc !== null && wc.isDestroyed() ? null : wc;
    },
    fillerChannels,
    dispose() {
      setMainWindowForU1(null);
      try { host.closeAll(); } catch { /* 已释放 */ }
      void (registry.get("node-red") as EngineRuntime | null)?.stop().catch(() => undefined);
      if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
      else Reflect.deleteProperty(process, "resourcesPath");
      prepared = null;
    },
  };
}
