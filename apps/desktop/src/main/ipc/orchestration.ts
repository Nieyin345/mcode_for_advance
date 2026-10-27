/**
 * 工作流的 IPC handler(设置 → 工作流)。
 *
 * 这一层很薄:**校验入参 → 调 `main/orchestration/library.ts` → 返回**。合并内置
 * 默认版、DAG 校验、「恢复默认」的语义都在那边,这里不重复实现 —— 否则同一套
 * 规则有两个地方会漂移。
 *
 * ## 与 `main/workflows/` 的区别(名字像,是两件事)
 *
 * `main/workflows/`(复数)是**数据根下那套 Python 研究脚本**的落盘器
 * (`seed.ts` / `assets.ts` → `<数据根>/workflows/scripts/`),和这里的工作流无关。
 * 这里管的是用户画的**流程图**。两条硬规矩:`main/orchestration/` 下不 import
 * `@main/workflows/*`,反之亦然。
 */
import type { IpcMain } from "electron";
import { dialog } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AutomationRunEntry, AutomationRunStep, AutomationTriggerFacts, PersistedWorkflowRunLite } from "@contracts/ipc";
import { diagnoseTriggerFacts } from "@contracts/ipc";
import { shouldRetryOutcome } from "@contracts/nodeType";
import {
  AgentProfileRemoveSchema,
  AgentProfileSaveSchema,
  AutomationPreflightSchema,
  AutomationRunsSchema,
  AutomationRunSchema,
  AutomationSessionsSchema,
  IPC,
  RunsHistorySchema,
  WorkflowChooseSchema,
  WorkflowRetrySchema,
  WorkflowExportSchema,
  WorkflowApproveSchema,
  WorkflowConfirmMigrationSchema,
  WorkflowGetSchema,
  WorkflowImportSchema,
  WorkflowImportPresetSchema,
  WorkflowPinDefaultSchema,
  WorkflowRemoveSchema,
  WorkflowRestoreDefaultSchema,
  WorkflowSaveSchema,
  WorkflowShippedUpdateSchema,
} from "@contracts/ipc";
import { readAgentProfiles, removeAgentProfile, saveAgentProfile, agentProfileContentHash } from "@main/orchestration/agentProfiles.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { CustomUiRunAutomationSchema } from "@contracts/customUi";
import { runCustomUiAutomation } from "@main/customUi/runAutomation.js";
import { log } from "@main/lib/logger.js";
import { dialogText } from "@main/lib/dialogText.js";
import { mergeUnknownWorkflowFields } from "@contracts/workflow";
import {
  getWorkflow,
  importWorkflowInto,
  listWorkflows,
  pinWorkflowDefault,
  removeWorkflow,
  restoreWorkflowDefault,
  saveWorkflow,
  applyShippedWorkflowUpdate,
  dismissShippedWorkflowUpdate,
} from "@main/orchestration/library.js";
import { notifyWorkflowsChanged } from "@main/orchestration/broadcast.js";
import { decodeSnapshot, runHistory } from "@main/orchestration/runStore.js";
import { configDrift, resolveConfigBinding, runStartBindings, staleBindings } from "@contracts/configBinding";
import { requestWorkflowReload } from "@main/orchestration/reloadRequest.js";
import { approveWorkflowRevision, setWorkflowReviewChangeListener, workflowReviewOf } from "@main/orchestration/workflowTrust.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { ensureLocalNodeTypesDir } from "@main/orchestration/nodeTypesSeed.js";
import { hasActiveRun, resolveWorkflowChoice, resolveWorkflowRetry } from "@main/orchestration/runner.js";
import { exportWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { automationPreflight } from "@main/appServices/automationPreflight.js";
import {
  HOST_CAPABILITY_DECLARATIONS,
  collectCapabilityInventory,
} from "@main/orchestration/capabilityResolver.js";
import { executionEngine } from "@main/orchestration/executionEngine.js";
import { refreshEngineTrustMarker } from "@main/workflowEngines/engineTrustMarker.js";
import { providerRegistry } from "@main/providers/registry.js";
import { getEnabledPlugins } from "@main/plugins/pluginManager.js";
import { decoratePresetCatalog, readPresetCatalog, readPresetWorkflow } from "@main/orchestration/presetWorkflows.js";
import { SessionRepo, SettingRepo, WorkflowRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import { duplicateWorkflowDoc } from "@main/orchestration/workflowDuplicate.js";
import { requireWorkflowReview } from "@main/orchestration/workflowTrust.js";
import { uniqueWorkflowName, WorkflowDuplicateSchema } from "@contracts/workflow";

/**
 * 把「建议的文件名」洗成一个能落盘的名字。
 *
 * 用户可见的名字里可以有任何东西(工作流叫「文献综述 / 第一版」很正常),而它们在
 * Windows 上是**非法路径字符**、在别的系统上至少是个换行。洗不出来的话退回 `fallback`
 * —— 文件名不该是"名字里有个斜杠就导不出来"的东西。
 *
 * 只洗**文件名那一层**:分隔符、控制字符、Windows 保留字符、结尾的点与空格。
 */
export function sanitizeFileBase(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  if (cleaned.length === 0) return fallback;
  // Windows 保留设备名(CON / NUL / COM1……,带扩展名也算)不能当文件名:加个后缀避开。
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned) ? `${cleaned}_` : cleaned;
}

/**
 * @param workflowEngineDataDir 引擎数据目录（信任标记的落点）。省略时**不写**信任标记
 *   —— 无头套件与单元测试不该因为一次工作流 CRUD 就在磁盘上留下引擎级的信任状态。
 *   生产装配（`ipc/index.ts`）必须传，否则用户批准后引擎重启仍是 safeMode。
 */
export function registerWorkflowHandlers(ipcMain: IpcMain, workflowEngineDataDir?: () => string): void {
  // 【Q8】审批账本 → 引擎信任标记的唯一翻译点。
  //
  // `engine-trust.json` 是**进程级**开关（`safeMode` 作用于整个 Node-RED 子进程），
  // 所以判据不能是"刚批准的这份"，而是"库里全部 node-red 图都通过" —— 见
  // `engineTrustMarker.ts` 文件头的粒度说明。账本有四个写入口（保存/审批/恢复默认/
  // 出厂更新），逐个调用必漏；`workflowTrust` 在每次写入后广播一次，这里集中算。
  setWorkflowReviewChangeListener(() => {
    // 未装配 dataDir = 无头/单元环境：不落信任标记（见参数说明）。
    if (workflowEngineDataDir === undefined) return;
    try {
      const nativeFlows = listWorkflows()
        .filter((entry) => entry.engine === "node-red")
        .map((entry) => {
          const doc = getWorkflow(entry.id);
          // 图读不到（并发删除）= 没有可执行的文档，按"不在库里"处理而不是待审。
          if (doc === null || doc.nodes.length === 0) return null;
          return { id: entry.id, pending: workflowReviewOf(doc)?.pending === true };
        })
        .filter((item): item is { id: string; pending: boolean } => item !== null);
      const result = refreshEngineTrustMarker(workflowEngineDataDir(), { nativeFlows: () => nativeFlows });
      if (!result.ok) log.info(`[workflow-engine:node-red] 信任标记未放开：${result.reason}`);
    } catch (err) {
      // 写标记失败**不能**让保存/审批失败（账本已经落盘），但必须留痕：
      // 静默的话用户会以为批准生效了，而重启后引擎仍 safeMode。
      log.error(`[workflow-engine:node-red] 信任标记刷新失败：${(err as Error).message}`);
    }
  });

  // 用户自写的节点类型目录 + 它的规范,随启动铺一次(已存在就跳过,不覆盖用户改过的)。
  // 放在注册函数里而不是 `main/orchestration` 的模块顶层,是因为**它是副作用**;注册
  // 函数是启动路径上一个明确的落点 —— 与 `registerLibraryHandlers` 里那句
  // `ensureWorkflows()` 同一个做法。
  ensureLocalNodeTypesDir();

  // **无参 handler 不接 raw、也不 parse** —— 与 `runtimes.list` / `toolchain.check`
  // 同一个写法。不带参数 invoke 时 handler 收到的就是 `undefined`,而
  // `z.object({}).parse(undefined)` 会报 `invalid_type`(toolchain 那边真踩过,
  // 面板一打开就红)。空 schema 的用处只是给 RpcMap 那条签名一个输入类型。
  ipcMain.handle(IPC.WORKFLOW_LIST, async () => ({ workflows: listWorkflows() }));

  ipcMain.handle(IPC.WORKFLOW_GET, async (_evt, raw) => {
    const input = WorkflowGetSchema.parse(raw);
    const workflow = getWorkflow(input.id);
    return { workflow, revision: workflow === null ? null : workflowSaveVersion(workflow),
      review: workflow === null ? null : workflowReviewOf(workflow) };
  });

  ipcMain.handle(IPC.WORKFLOW_APPROVE, async (_evt, raw) => {
    const input = WorkflowApproveSchema.parse(raw);
    const doc = getWorkflow(input.id);
    if (doc === null) return { ok: false, error: "工作流已经不在了，请刷新列表" };
    const result = approveWorkflowRevision(doc, input.revision);
    if (result.ok) {
      requestWorkflowReload(doc.id);
      notifyWorkflowsChanged(`ipc:workflow_approve:${doc.id}`);
    }
    return result;
  });

  // 画布"添加节点"菜单要的是**当前可用**的节点类型(内置 + 已启用插件 + 用户自写),
  // 以及读不进来的那些文件的问题 —— 不返回 problems 的话,用户写错一个清单,界面上
  // 只会看到自己的类型凭空消失,没有任何线索。
  ipcMain.handle(IPC.WORKFLOW_NODE_TYPES, async () => loadNodeTypes());

  ipcMain.handle(IPC.WORKFLOW_SAVE, async (_evt, raw) => {
    const input = WorkflowSaveSchema.parse(raw);
    // 【WF-05 字段保真】`WorkflowSaveSchema` 走的是 `WorkflowDocSchema`,它对契约外的
    // 键默认 **strip** —— 渲染端从 `workflow.get` 拿到的那份文档里如果带着这一版还不
    // 认识的字段(更新版本写出的档案、第三方节点自附的元数据),一次普通保存就会把它们
    // 悄悄抹掉,而用户什么都没做。保存是**改写已有行**,不是从零重建:把入参原文里契约
    // 不认识的键按身份贴回去再交给 `saveWorkflow`(存储层整份 JSON.stringify,贴回来
    // 的字段原样落盘)。校验不受影响 —— 未知键本来就不参与 `validateWorkflowDoc`。
    const workflow = mergeUnknownWorkflowFields(input.workflow, (raw as { workflow?: unknown } | null)?.workflow);
    const res = await saveWorkflow(workflow, { expectedRevision: input.expectedRevision ?? null });
    // 存成功了才广播。**用户这条路上其实不靠它**(渲染端自己会在 RPC 返回后重拉列表),
    // 广播在这里是为了另一半:AI 走 MCP 时改的是同一个落点,而界面上可能还开着另一个
    // 面板/窗口。两边都发才谈得上"谁改了另一边都知道"(同 `library/broadcast.ts`)。
    if (res.ok) notifyWorkflowsChanged(`ipc:workflow_save:${input.workflow.id}`);
    // 触发器是**后台**在跑的:`library.ts` 改完磁盘,`automationRunner` 手里那份还是旧的
    // —— 用户刚把触发方式从"定时"改成"文件变化",后台却还在按老规矩起运行,而界面上
    // 看不到任何异常。所以每次写成功都让它重读这一份。
    //
    // 走 `reloadRequest` 那条**纯函数**缝而不是直接调 `automationRunner`:另一半写者是
    // MCP(`main/mcp/mcodeServer.ts`),而那个模块**无头也会被 import 并真被调用**
    // (见 `scripts/mcode-admin-smoke`),直接 import 执行器会把 electron 拖进那套冒烟。
    if (res.ok) requestWorkflowReload(input.workflow.id);
    return res;
  });

  // A distinct renderer-only channel: ordinary workflow.save (including
  // scene commands and agent calls) cannot acknowledge executor migration.
  // The endpoint accepts only an existing mcode-owned doc -> Node-RED and
  // requires the exact saved revision shown in the UI.
  ipcMain.handle(IPC.WORKFLOW_CONFIRM_MIGRATION, async (_evt, raw) => {
    const input = WorkflowConfirmMigrationSchema.parse(raw);
    if (!input.expectedRevision) {
      return { ok: false, error: "迁移确认缺少当前保存版本，拒绝覆盖可能已变化的工作流" };
    }
    const current = getWorkflow(input.workflow.id);
    if (!current || current.engine === "node-red" || input.workflow.engine !== "node-red") {
      return { ok: false, error: "迁移确认只允许把现有旧工作流显式切换到 Node-RED" };
    }
    const workflow = mergeUnknownWorkflowFields(input.workflow, (raw as { workflow?: unknown } | null)?.workflow);
    const res = await saveWorkflow(workflow, {
      expectedRevision: input.expectedRevision,
      confirmEngineMigration: true,
    });
    if (res.ok) {
      notifyWorkflowsChanged(`ipc:workflow_confirm_migration:${input.workflow.id}`);
      requestWorkflowReload(input.workflow.id);
    }
    return res;
  });

  /* 【WF-09】复制一份工作流。
   *
   * 与「导出再导入」的区别：复制留在本机，engine/trigger/提示词原样保留。
   * 副本按**新导入**处理（要重新过审查）—— 原图审过不代表副本审过。 */
  ipcMain.handle(IPC.WORKFLOW_DUPLICATE, async (_evt, raw) => {
    const input = WorkflowDuplicateSchema.parse(raw);
    const source = getWorkflow(input.id);
    if (source === null) return { ok: false as const, error: `找不到这份工作流` };
    const { doc } = duplicateWorkflowDoc(source, {
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
    const others = listWorkflows().map((entry) => entry.name);
    const saved = { ...doc, name: uniqueWorkflowName(doc.name, others) };
    // **审查标记先写**：与导入同一条纪律（`requireWorkflowReview`），
    // 副本在用户确认之前不可执行。
    requireWorkflowReview(saved.id, `duplicate`);
    WorkflowRepo.save(saved);
    notifyWorkflowsChanged(`ipc:workflow_duplicate:` + saved.id);
    return { ok: true as const, id: saved.id, name: saved.name };
  });

  ipcMain.handle(IPC.WORKFLOW_REMOVE, async (_evt, raw) => {
    const input = WorkflowRemoveSchema.parse(raw);
    const res = removeWorkflow(input.id);
    notifyWorkflowsChanged(`ipc:workflow_remove:${input.id}`);
    // 删掉/恢复默认之后同理 —— 执行器读不到这一份就把它的触发器撤掉(见 `apply`)。
    requestWorkflowReload(input.id);
    return res;
  });

  ipcMain.handle(IPC.WORKFLOW_PIN_DEFAULT, async (_evt, raw) => {
    const input = WorkflowPinDefaultSchema.parse(raw);
    // 写设置表 + 列表的 pinned 标记变了 —— 广播让界面重拉;执行器不用重读(文档没变)。
    const res = pinWorkflowDefault(input.id);
    if (res.ok) notifyWorkflowsChanged(`ipc:workflow_pin:${input.id}`);
    return res;
  });

  ipcMain.handle(IPC.WORKFLOW_RESTORE_DEFAULT, async (_evt, raw) => {
    const input = WorkflowRestoreDefaultSchema.parse(raw);
    const res = restoreWorkflowDefault(input.id);
    if (res.ok) {
      notifyWorkflowsChanged(`ipc:workflow_restore:${input.id}`);
      // 文档真的换了一版 —— 执行器要重读(同 save 那条路)。
      requestWorkflowReload(input.id);
    }
    return res;
  });

  // 自带工作流的出厂版更新:应用 = 文档换成出厂版(执行器要重读);忽略 = 只改设置表
  // 里的已看记录(列表标记变了,执行器不用重读)。
  ipcMain.handle(IPC.WORKFLOW_APPLY_SHIPPED_UPDATE, async (_evt, raw) => {
    const input = WorkflowShippedUpdateSchema.parse(raw);
    const res = applyShippedWorkflowUpdate(input.id);
    if (res.ok) {
      notifyWorkflowsChanged(`ipc:workflow_shipped_update:${input.id}`);
      requestWorkflowReload(input.id);
    }
    return res;
  });

  ipcMain.handle(IPC.WORKFLOW_DISMISS_SHIPPED_UPDATE, async (_evt, raw) => {
    const input = WorkflowShippedUpdateSchema.parse(raw);
    const res = dismissShippedWorkflowUpdate(input.id);
    if (res.ok) notifyWorkflowsChanged(`ipc:workflow_shipped_dismiss:${input.id}`);
    return res;
  });

  // ── 导出 / 导入(WF-08)──
  //
  // **两个文件对话框都在主进程**:渲染端读不了任意路径(读文件那条 `file.readFile`
  // 被项目根闸门挡着,而用户挑的文件多半在项目外),也没有保存框那一层 API。所以
  // 渲染端只给 id / 文本,挑路径和读写都由这里做。
  ipcMain.handle(IPC.WORKFLOW_EXPORT, async (_evt, raw) => {
    const input = WorkflowExportSchema.parse(raw);
    // **导的是磁盘上那一份**,不是界面上那份可能带未保存改动的草稿(见契约里那条
    // 注释)。读不到就直说 —— 静默写一个空文件比报错更坏。
    const doc = getWorkflow(input.id);
    if (doc === null) return { ok: false, error: `找不到 id 为「${input.id}」的工作流` };

    const base = sanitizeFileBase(input.suggestedName ?? doc.name, doc.id);
    const result = await dialog.showSaveDialog({
      title: dialogText("common.dialog.exportWorkflow"),
      defaultPath: `${base}.json`,
      filters: [{ name: dialogText("common.dialog.workflowJsonFilter"), extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      await writeFile(result.filePath, exportWorkflowDoc(doc), "utf8");
    } catch (err) {
      log.warn(`workflow.export failed for ${result.filePath}: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true, path: result.filePath };
  });

  /**
   * 导入的两种入口共用这一段收尾:写成功就广播 + 让执行器重读。
   *
   * 与「保存」那颗按钮走的是同一对通知(见上面的 `WORKFLOW_SAVE`)—— 导入在存储层
   * 就是一次保存,漏掉通知的话,后台的触发器还按旧图跑。
   */
  const finishImport = (
    res: Awaited<ReturnType<typeof importWorkflowInto>>,
  ): { ok: true; id: string; name: string; warnings?: string[] } | { ok: false; errors: string[]; warnings: string[] } => {
    if (!res.ok) return res;
    notifyWorkflowsChanged(`ipc:workflow_import:${res.id}`);
    requestWorkflowReload(res.id);
    return res;
  };

  ipcMain.handle(IPC.WORKFLOW_IMPORT, async (_evt, raw) => {
    const input = WorkflowImportSchema.parse(raw);
    return finishImport(await importWorkflowInto(input.text, input.id ? { id: input.id } : {}));
  });

  // 从文件导入:挑文件 + 读文本都在这里,读完就交给上面同一个函数 —— 两条路只有
  // "文本从哪来"不同,解析/校验/落库一份都不重复。
  ipcMain.handle(IPC.WORKFLOW_IMPORT_FROM_FILE, async (_evt, raw) => {
    const input = WorkflowImportSchema.pick({ id: true }).parse(raw ?? {});
    const picked = await dialog.showOpenDialog({
      title: dialogText("common.dialog.importWorkflow"),
      properties: ["openFile"],
      filters: [{ name: dialogText("common.dialog.workflowJsonFilter"), extensions: ["json"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };

    let text: string;
    try {
      text = await readFile(picked.filePaths[0], "utf8");
    } catch (err) {
      log.warn(`workflow.importFromFile failed for ${picked.filePaths[0]}: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
    return finishImport(await importWorkflowInto(text, input.id ? { id: input.id } : {}));
  });

  // ── 出厂预置(【MC-007】)──
  //
  // 这两条把 `resources/presets/workflows.json` 从"仓库里的一份文件"变成**用户与
  // Agent 都可发现、可导入**的内容。路径解析在 `presetWorkflows.ts`(打包/开发两套
  // 布局),这里只补上需要 DB 的那一半(同名提示)与导入执行 —— 导入走**同一个**
  // `importWorkflowInto`,不另写解析/校验/落库。
  ipcMain.handle(IPC.WORKFLOW_LIST_PRESETS, async () => {
    const existing = listWorkflows().map((w) => w.name);
    return decoratePresetCatalog(readPresetCatalog(), existing);
  });

  ipcMain.handle(IPC.WORKFLOW_IMPORT_PRESET, async (_evt, raw) => {
    const input = WorkflowImportPresetSchema.parse(raw);
    const found = readPresetWorkflow(input.id);
    if ("error" in found) return { ok: false, errors: [found.error], warnings: [] };
    // **永远新建**(不给 opts.id):出厂预设的语义是"要一份新的",重名由
    // `importWorkflowInto` 自动加后缀。要覆盖请走 `workflow.import`。
    return finishImport(await importWorkflowInto(exportWorkflowDoc(found.doc)));
  });

  // ── 代理档案 ──
  // 无参 handler,同 `workflow.list`。
  ipcMain.handle(IPC.WORKFLOW_AGENT_PROFILES, async () => readAgentProfiles());

  ipcMain.handle(IPC.WORKFLOW_SAVE_AGENT_PROFILE, async (_evt, raw) => {
    const input = AgentProfileSaveSchema.parse(raw);
    const res = saveAgentProfile(input.profile);
    if (res.ok) notifyWorkflowsChanged(`ipc:agent_profile_save:${input.profile.id}`);
    return res;
  });

  ipcMain.handle(IPC.WORKFLOW_REMOVE_AGENT_PROFILE, async (_evt, raw) => {
    const input = AgentProfileRemoveSchema.parse(raw);
    const res = removeAgentProfile(input.id);
    if (res.ok) notifyWorkflowsChanged(`ipc:agent_profile_remove:${input.id}`);
    return res;
  });

  // ── 岔路口 ──
  //
  // 用户在对话里那张卡片上选了一条路。**它是"回答",不是"发消息"** —— 那次运行还
  // 挂在调度器的一个 promise 上等着(见 `scheduler.ts` 的 `RunPorts.choose`),这一下
  // 把它唤醒,图从那个节点接着往下跑,**不重跑整张图**。
  //
  // `ok: false` 不抛错:点一张过期的卡片(运行早结束了)是正常会发生的事,给用户弹
  // 一个错误框只会让他以为自己做错了什么。
  ipcMain.handle(IPC.WORKFLOW_CHOOSE, async (_evt, raw) => {
    const input = WorkflowChooseSchema.parse(raw);
    return resolveWorkflowChoice(input);
  });

  // ── 失败重试 ──
  //
  // 用户在失败卡片上点了「再试一次」、写了句"上次哪里不对"。**与上面那条是同一类**:
  // 它回答的是一次已经停在那儿的运行,只是岔路口那一步是"选一条出路",而这一步是
  // "从这儿重新跑一遍"(连同它的全部下游,见 `WorkflowRetrySchema`)。
  //
  // `ok: false` 的四种原因(找不到 / 不是 failed / 存档坏了 / 正有运行在跑)全都不是
  // 错误 —— 界面上是一句"这张卡不适用了",不是红框。
  ipcMain.handle(IPC.WORKFLOW_RETRY, async (_evt, raw) => {
    const input = WorkflowRetrySchema.parse(raw);
    // 【WF-06】原生 Node-RED 运行的重试走自己的入口。
    //
    // 判据是 sessionId 的**命名空间前缀**（`@node-red-runboard:`），不是"库里这张图
    // 是不是 node-red" —— 后者会让一张刚切过引擎的图的旧卡片被送进错误的执行器。
    // 前缀由 `nativeRunHistory.nativeRunboardSessionId` 统一生成，两边逐字一致。
    const NATIVE_RUNBOARD_PREFIX = "@node-red-runboard:";
    if (input.sessionId.startsWith(NATIVE_RUNBOARD_PREFIX)) {
      const workflowId = input.sessionId.slice(NATIVE_RUNBOARD_PREFIX.length);
      if (workflowId.length === 0) return { ok: false, error: "这条运行记录没有对应的工作流" };
      const { workflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
      const runtime = workflowEngineRegistry.get("node-red");
      if (runtime === null) return { ok: false, error: "Node-RED 引擎未注册" };
      if (typeof (runtime as { retryNativeFlow?: unknown }).retryNativeFlow !== "function") {
        return { ok: false, error: "当前引擎不支持重跑原生工作流" };
      }
      return (runtime as unknown as { retryNativeFlow(id: string): Promise<{ ok: boolean; error?: string }> })
        .retryNativeFlow(workflowId);
    }
    return resolveWorkflowRetry(input);
  });

  // ─ 自动化 ──
  //
  // 触发器节点在**后台**起运行(见 `main/orchestration/automationRunner.ts`)。这一栏只
  // 需要三件事:立刻跑一次、看它跑过什么、以及那条后台会话在哪儿(点进去看全过程)。

  // 手动跑一次走的就是 `manual` 那条路,和它定时跑起来是同一件事 —— 用户可以先试一遍
  // 再改成定时。`ok: false` 不是异常:点一个还没存过的触发器,该得到一句解释。
  ipcMain.handle(IPC.AUTOMATION_RUN, async (_evt, raw) => {
    const input = AutomationRunSchema.parse(raw);
    return automationRunner.runNow(input.workflowId, input.triggerNodeId);
  });

  // **触发前只读预检** —— 与 `automation.run` 同形入参,但**什么都不执行**:不建会话、
  // 不写运行记录、不派发。三类问题(坏档 / 缺执行器 / 需审查)共用调度器那一份能力
  // 判据(见 `appServices/automationPreflight.ts` 的宿主注入)。Agent 经 `app_api_call`
  // 拿到的是同一段 handler 的返回。
  ipcMain.handle(IPC.AUTOMATION_PREFLIGHT, async (_evt, raw) => {
    const input = AutomationPreflightSchema.parse(raw);
    return automationPreflight(input, {
      getWorkflow: (id) => {
        // 行不存在 → missing;行在但文档键都对不上(坏 JSON 被存储层退化成空文档、
        // 或外部改库) → corrupt。**不把读不出来当成不存在** —— 那会让预检谎报
        // "工作流不存在",而用户明明看着它在列表里。
        const row = WorkflowRepo.get(id);
        if (row === null) return { kind: "missing" };
        const doc = row.doc;
        if (doc.id !== id || doc.name.trim().length === 0) {
          return { kind: "corrupt", reason: "工作流存档无法解析或关键字段缺失(文档内容损坏)" };
        }
        return { kind: "ok", doc };
      },
      loadManifests: async () =>
        new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest])),
      loadCapabilityInventory: async () => {
        try {
          const plugins = (await getEnabledPlugins()).map((p) => ({
            name: p.name,
            manifest: p.manifest,
            compatibleProviderIds: p.compatibleProviderIds,
            componentReports: p.componentReports,
          }));
          const executorKinds = [...executionEngine.kinds()];
          return {
            inventory: collectCapabilityInventory({
              providers: providerRegistry.list(),
              plugins,
              executorKinds,
              hostCapabilities: [...HOST_CAPABILITY_DECLARATIONS],
            }),
            executorKinds,
          };
        } catch (err) {
          // 清单装配失败 → 返回 undefined,预检如实报"查不了"而不是假装通过。
          log.warn(`[automation] 预检能力清单装配失败:${(err as Error).message}`);
          return undefined;
        }
      },
      reviewErrorOf: (doc) => workflowReviewOf(doc)?.pending === true
        ? `工作流「${doc.name}」来自导入或 AI 修改，当前版本尚未审查；请到设置 → 工作流/自动化检查内容并明确启用`
        : null,
    });
  });

  // 自定义 UI 的「运行自动化」:右键的目标(条目 / 分类 / 大类 / 文件)当载荷,手动跑一次。
  // 展开与校验在 `main/customUi/runAutomation.ts`;`ok: false` 同样是给人看的句子。
  ipcMain.handle(IPC.CUSTOM_UI_RUN_AUTOMATION, async (_evt, raw) => {
    const input = CustomUiRunAutomationSchema.parse(raw);
    return runCustomUiAutomation(input);
  });

  ipcMain.handle(IPC.AUTOMATION_RUNS, async (_evt, raw) => {
    const input = AutomationRunsSchema.parse(raw);
    return { runs: automationRunsOf(input.workflowId, input.limit ?? AUTOMATION_RUNS_LIMIT) };
  });

  // 还没跑过的自动化**没有会话** —— 那时返回 null,界面该显示"它还没跑过",而不是
  // 现建一条空会话(那会在会话列表里凭空多出一个没人用过的对话)。
  ipcMain.handle(IPC.AUTOMATION_SESSIONS, async (_evt, raw) => {
    const input = AutomationSessionsSchema.parse(raw);
    const sessions = SessionRepo.listAutomationsByWorkflow(input.workflowId);
    // Prefer the active project for controls; otherwise open the most recently used one.
    return { sessionId: (sessions.find((s) => hasActiveRun(s.id)) ?? sessions[0])?.id ?? null, sessionIds: sessions.map((s) => s.id) };
  });

  // ── 触发器事实状态(AUTO-09)──
  //
  // 全部触发器的"挂没挂上 / 为什么 / 最近一次跑"。**无参 handler**,同
  // `workflow.list`。返回值注成 contracts 的镜像类型(见 `AutomationTriggerFacts`):
  // 主进程那份事实在 `automationStatus.ts`,哪边形状漂了,这一行赋值就编译不过。
  //
  // **判定后诊断随返回:** 原始 `lastError` 是只增不改的旧账;「现在还算不算失败 /
  // 该不该提示错过」的判据在 `@contracts/ipc` 的 `latestFailureOf` / `missedNoticeOf`
  // (界面用的同一份)。这里对每条事实调 `diagnoseTriggerFacts` 把结论叠上去 ——
  // Agent 经 `app_api_call` 拿到的是**同一段代码**的返回,不必(也无法)自己重判。
  ipcMain.handle(IPC.AUTOMATION_STATUS_ALL, async () => {
    const facts: AutomationTriggerFacts[] = automationRunner.statusAll();
    // **直接返回数组**(不包 `{ facts }`)—— preload 的 api 面与渲染端都按裸数组消费,
    // 包一层只会让每一处调用点多一次解构。
    return facts.map(diagnoseTriggerFacts);
  });

  // ── 运行历史(某个对话的所有图运行)──
  //
  // 从存档折出来(见 `runStore.runHistory`,那份快照是唯一真相),丢掉 snapshot 本体、
  // 换成 nodeCount —— 一行列表不该拖着整份快照过 IPC。存档读不回来的老运行照样列出,
  // nodeCount 按 0 算。
  ipcMain.handle(IPC.RUNS_HISTORY, async (_evt, raw) => {
    const input = RunsHistorySchema.parse(raw);
    const runs: PersistedWorkflowRunLite[] = runHistory(
      input.sessionId,
      input.limit ?? AUTOMATION_RUNS_LIMIT,
    ).map((run) => {
      // ARC-016 readback:「这一轮实际用了哪一版档案指令、现在还一样吗」。拿运行**当时**
      // 记下的档案哈希,与**现在**源档案的哈希比 —— 只把落后项带过 IPC(哈希差异,不含正文)。
      // 存档读不回来 / 该轮没绑档案 → 没有 configSnapshot.profiles → 不带这个字段。
      const lockedProfiles = run.snapshot?.configSnapshot?.profiles;
      const current: Record<string, string | null> = {};
      if (lockedProfiles) {
        for (const id of Object.keys(lockedProfiles)) current[id] = agentProfileContentHash(id);
      }
      const drift = lockedProfiles ? configDrift(lockedProfiles, current) : [];
      // ARC-016 变更计划:同一条运行,走**声明式锁版**判定的口径 —— 把当时锁下的哈希
      // 当成一批 `PINNED`/`RUN_START` 的绑定,逐条 `resolveConfigBinding` 解析出**当时生效
      // 的那一版**(effectiveHash = 锁定值)与它是否已落后,再 `staleBindings` 挑出落后项。
      // 这是台账点名的「源档案比声明的 lock 新」的变更计划,也是 `resolveConfigBinding` /
      // `staleBindings` / `ConfigEffectiveAt=RUN_START` 唯一一处真实生产调用端。只挑落后项,
      // 没落后不给字段(同 configDrift 的口径)。
      const bindings = lockedProfiles ? runStartBindings(lockedProfiles) : [];
      const changePlan = staleBindings(
        bindings.map((b) => resolveConfigBinding(b, current[b.assetId] ?? null)),
      );
      return {
        runId: run.runId,
        sessionId: run.sessionId,
        workflowId: run.workflowId,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        nodeCount: run.snapshot?.state.outcomes.length ?? 0,
        ...(drift.length > 0 ? { configDrift: drift } : {}),
        ...(changePlan.length > 0 ? { configChangePlan: changePlan } : {}),
      };
    });
    // **直接返回数组**(不包 `{ runs }`)—— 同 statusAll,渲染端按裸数组消费。
    return runs;
  });

  // ── 长任务守望已移除（2026-10-27）──
  //
  // 它是"用户能用工作流自己搭出来"的东西，做成内置模板等于把一种做法锁死在宿主里。
  // 这里的起跑 / 状态两个 handler 与契约一并删除；命令模板库
  // （`automation.watchTemplates*`）是它的配套，同批移除。

  /* 命令模板库随长任务守望一并移除（2026-10-27）。 */
}

/** 一次给界面看几条历史。窗口里只有一条列表,给多了也是滚 —— 二十条够看出"它在按时跑"。 */
const AUTOMATION_RUNS_LIMIT = 20;

/** 历史里那行摘要最多显示多少字。摘要可能是**整段文本**(它就是节点那句话的产出),
 *  原样塞进一行列表里会把列表撑成一屏。 */
const RUN_SUMMARY_MAX = 200;

/**
 * 一条自动化跑过什么。**从存档折出来**(见 `runStore.decodeSnapshot`),不是另存的一份
 * —— 运行状态本来就写在 `workflow_runs.payload` 里,再存一份就得维护两个真相。
 *
 * 折不出来的一次运行(存档是更老的版本写的、或者被手改坏了)**照样列出这一条**,
 * 只是没有步骤 —— 它跑过这件事本身仍然是真的,而"历史里凭空少了一次"更让人看不懂。
 */
function automationRunsOf(workflowId: string, limit: number): AutomationRunEntry[] {
  const doc = getWorkflow(workflowId);
  const titleOf = (nodeId: string): string => {
    const node = doc?.nodes.find((n) => n.id === nodeId);
    if (node === undefined) return nodeId;
    // 与调度器的 `titleOf` 同一个规矩:有标题就用标题,没有就用 id —— 只给 id 的话
    // 历史里没人认得出那是哪一步。
    return node.title.trim().length > 0 ? node.title : nodeId;
  };
  return WorkflowRunRepo.listForAutomationWorkflow(workflowId, limit).map((row) => {
    const snapshot = decodeSnapshot(row.payload);
    const steps: AutomationRunStep[] = (snapshot?.state.outcomes ?? []).map(([nodeId, outcome]) => ({
      nodeId,
      title: titleOf(nodeId),
      status: outcome.status,
      summary: firstLine(outcome.summary),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    }));
    // 【Agent 可读面】失败分类与耗时从**同一份存档**折出来,不另存:
    //  - 分类取第一个 failed 步骤,判据与调度器重试同一份(`retryable` 优先,
    //    缺席才 `isTransientError` 猜文本 —— 见 `@contracts/nodeType`);
    //  - 耗时只在收尾态给(running 的 `updatedAt` 是最后一次落盘时刻,不是结束)。
    const firstFailed = (snapshot?.state.outcomes ?? [])
      .find(([, outcome]) => outcome.status === "failed")?.[1];
    const failureClass = row.status !== "failed" || firstFailed === undefined
      ? undefined
      : shouldRetryOutcome(firstFailed) ? "transient" as const : "terminal" as const;
    const endedAt = row.status === "running" ? undefined : row.updatedAt;
    return {
      runId: row.id,
      // 这一行赋值就是那两个类型的"对表":哪边多一个状态,这里就编译不过。
      status: row.status,
      startedAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(endedAt !== undefined ? { durationMs: Math.max(0, endedAt - row.createdAt) } : {}),
      ...(snapshot?.state.entry?.nodeId !== undefined
        ? { triggerKey: `${workflowId}:${snapshot.state.entry.nodeId}` }
        : {}),
      ...(failureClass !== undefined ? { failureClass } : {}),
      ...(failureClass !== undefined && firstFailed?.error !== undefined ? { error: firstFailed.error } : {}),
      steps,
    };
  });
}

/** 摘要在历史里只留**首行**,再长的截断 —— 列表里要的是"它做了什么",不是全文。 */
function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  const line = (nl < 0 ? text : text.slice(0, nl)).trim();
  return line.length > RUN_SUMMARY_MAX ? `${line.slice(0, RUN_SUMMARY_MAX)}…` : line;
}
