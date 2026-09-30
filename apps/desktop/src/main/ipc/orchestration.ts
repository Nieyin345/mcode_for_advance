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
import type { AutomationRunEntry, AutomationTriggerFacts, PersistedWorkflowRunLite, WatchCommandTemplate } from "@contracts/ipc";
import {
  AgentProfileRemoveSchema,
  AgentProfileSaveSchema,
  AutomationRunsSchema,
  AutomationRunSchema,
  AutomationSessionsSchema,
  IPC,
  RunsHistorySchema,
  WatchCommandTemplateSchema,
  WatchStartSchema,
  WatchStatusSchema,
  WatchTemplatesSaveSchema,
  WorkflowChooseSchema,
  WorkflowRetrySchema,
  WorkflowExportSchema,
  WorkflowApproveSchema,
  WorkflowGetSchema,
  WorkflowImportSchema,
  WorkflowPinDefaultSchema,
  WorkflowRemoveSchema,
  WorkflowRestoreDefaultSchema,
  WorkflowSaveSchema,
  WorkflowShippedUpdateSchema,
} from "@contracts/ipc";
import { readAgentProfiles, removeAgentProfile, saveAgentProfile } from "@main/orchestration/agentProfiles.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { CustomUiRunAutomationSchema } from "@contracts/customUi";
import { runCustomUiAutomation } from "@main/customUi/runAutomation.js";
import { log } from "@main/lib/logger.js";
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
import { requestWorkflowReload } from "@main/orchestration/reloadRequest.js";
import { approveWorkflowRevision, workflowReviewOf } from "@main/orchestration/workflowTrust.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { ensureLocalNodeTypesDir } from "@main/orchestration/nodeTypesSeed.js";
import { hasActiveRun, resolveWorkflowChoice, resolveWorkflowRetry } from "@main/orchestration/runner.js";
import { exportWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { SessionRepo, SettingRepo, WorkflowRunRepo } from "@main/store/repositories.js";

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
  return cleaned.length > 0 ? cleaned : fallback;
}

export function registerWorkflowHandlers(ipcMain: IpcMain): void {
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
    const res = await saveWorkflow(input.workflow, { expectedRevision: input.expectedRevision ?? null });
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
      title: "导出工作流",
      defaultPath: `${base}.json`,
      filters: [{ name: "工作流 JSON", extensions: ["json"] }],
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
  ): { ok: true; id: string; name: string } | { ok: false; errors: string[]; warnings: string[] } => {
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
      title: "导入工作流",
      properties: ["openFile"],
      filters: [{ name: "工作流 JSON", extensions: ["json"] }],
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
  ipcMain.handle(IPC.AUTOMATION_STATUS_ALL, async () => {
    const facts: AutomationTriggerFacts[] = automationRunner.statusAll();
    // **直接返回数组**(不包 `{ facts }`)—— preload 的 api 面与渲染端都按裸数组消费,
    // 包一层只会让每一处调用点多一次解构。
    return facts;
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
    ).map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      workflowId: run.workflowId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nodeCount: run.snapshot?.state.outcomes.length ?? 0,
    }));
    // **直接返回数组**(不包 `{ runs }`)—— 同 statusAll,渲染端按裸数组消费。
    return runs;
  });

  // ── 守望(会话输入区那颗「守望」按钮,D3/D4)──
  //
  // 起跑、查活跃、命令模板三件事。起跑有**可见的副作用**(command / message 会写进
  // 内置模板的节点参数,见 `automationRunner.startWatch` 的说明);模板存 setting,
  // **不单开设置页**(D4)—— 面板里管。

  ipcMain.handle(IPC.AUTOMATION_WATCH, async (_evt, raw) => {
    const input = WatchStartSchema.parse(raw);
    return automationRunner.startWatch({
      originSessionId: input.sessionId,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
  });

  ipcMain.handle(IPC.AUTOMATION_WATCH_STATUS, async (_evt, raw) => {
    const input = WatchStatusSchema.parse(raw);
    return { active: automationRunner.activeWatchOf(input.sessionId) };
  });

  // 无参 handler,同 `WORKFLOW_AGENT_PROFILES`。
  ipcMain.handle(IPC.AUTOMATION_WATCH_TEMPLATES, async () => ({ templates: loadWatchTemplates() }));

  ipcMain.handle(IPC.AUTOMATION_WATCH_TEMPLATES_SAVE, async (_evt, raw) => {
    const input = WatchTemplatesSaveSchema.parse(raw);
    SettingRepo.set(WATCH_TEMPLATES_KEY, JSON.stringify(input.templates));
    return { ok: true };
  });
}

/* ── 命令模板的存取(D4:名字 + 命令的数组,存 setting)── */

const WATCH_TEMPLATES_KEY = "automation.watch.templates";

/** 读出来时**逐条过一遍 schema**:setting 是用户数据,手改坏了一条不该把整个面板
 *  弄挂 —— 坏的丢掉,好的照常显示。
 *
 *  ⚠️ **丢掉的那几条要说话。** 以前这里只有 `catch` 那条坏 JSON 打了日志,逐条被
 *  `safeParse` 挡下的**一声不响** —— 用户看到的现象是"我在 setting 里加的那条模板不见
 *  了",而日志里一个线索都没有(硬规矩第 3 条,同 `nodeTypes.ts` 的 `problems`)。
 *  返回值那一层没有 `problems` 这个通道(契约 `automation.watchTemplates` 只声明了
 *  `{ templates }`,加字段要动 `@contracts`,不在这次改的范围里),所以至少**日志里要有**。 */
function loadWatchTemplates(): WatchCommandTemplate[] {
  const raw = SettingRepo.get(WATCH_TEMPLATES_KEY);
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn(`[workflow] 命令模板存的不是数组,当没有模板处理:${raw.slice(0, 80)}`);
      return [];
    }
    const out: WatchCommandTemplate[] = [];
    const dropped: string[] = [];
    for (const item of parsed) {
      const check = WatchCommandTemplateSchema.safeParse(item);
      if (check.success) out.push(check.data);
      else dropped.push(check.error.issues[0]?.message ?? "形状不对");
    }
    if (dropped.length > 0) {
      log.warn(
        `[workflow] 命令模板里有 ${dropped.length} 条读不了,已跳过(好的照常显示):${dropped.join(" / ")}`,
      );
    }
    return out;
  } catch {
    log.warn(`[workflow] 命令模板存的是坏 JSON,当没有模板处理:${raw.slice(0, 80)}`);
    return [];
  }
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
    return {
      runId: row.id,
      // 这一行赋值就是那两个类型的"对表":哪边多一个状态,这里就编译不过。
      status: row.status,
      startedAt: row.createdAt,
      updatedAt: row.updatedAt,
      steps: (snapshot?.state.outcomes ?? []).map(([nodeId, outcome]) => ({
        nodeId,
        title: titleOf(nodeId),
        status: outcome.status,
        summary: firstLine(outcome.summary),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      })),
    };
  });
}

/** 摘要在历史里只留**首行**,再长的截断 —— 列表里要的是"它做了什么",不是全文。 */
function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  const line = (nl < 0 ? text : text.slice(0, nl)).trim();
  return line.length > RUN_SUMMARY_MAX ? `${line.slice(0, RUN_SUMMARY_MAX)}…` : line;
}
