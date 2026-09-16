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
import {
  AgentProfileRemoveSchema,
  AgentProfileSaveSchema,
  IPC,
  WorkflowChooseSchema,
  WorkflowGetSchema,
  WorkflowRemoveSchema,
  WorkflowSaveSchema,
} from "@contracts/ipc";
import { readAgentProfiles, removeAgentProfile, saveAgentProfile } from "@main/orchestration/agentProfiles.js";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "@main/orchestration/library.js";
import { notifyWorkflowsChanged } from "@main/orchestration/broadcast.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { ensureLocalNodeTypesDir } from "@main/orchestration/nodeTypesSeed.js";
import { resolveWorkflowChoice } from "@main/orchestration/runner.js";

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
    return { workflow: getWorkflow(input.id) };
  });

  // 画布"添加节点"菜单要的是**当前可用**的节点类型(内置 + 已启用插件 + 用户自写),
  // 以及读不进来的那些文件的问题 —— 不返回 problems 的话,用户写错一个清单,界面上
  // 只会看到自己的类型凭空消失,没有任何线索。
  ipcMain.handle(IPC.WORKFLOW_NODE_TYPES, async () => loadNodeTypes());

  ipcMain.handle(IPC.WORKFLOW_SAVE, async (_evt, raw) => {
    const input = WorkflowSaveSchema.parse(raw);
    const res = await saveWorkflow(input.workflow);
    // 存成功了才广播。**用户这条路上其实不靠它**(渲染端自己会在 RPC 返回后重拉列表),
    // 广播在这里是为了另一半:AI 走 MCP 时改的是同一个落点,而界面上可能还开着另一个
    // 面板/窗口。两边都发才谈得上"谁改了另一边都知道"(同 `library/broadcast.ts`)。
    if (res.ok) notifyWorkflowsChanged(`ipc:workflow_save:${input.workflow.id}`);
    return res;
  });

  ipcMain.handle(IPC.WORKFLOW_REMOVE, async (_evt, raw) => {
    const input = WorkflowRemoveSchema.parse(raw);
    const res = removeWorkflow(input.id);
    notifyWorkflowsChanged(`ipc:workflow_remove:${input.id}`);
    return res;
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
    return { ok: resolveWorkflowChoice(input) };
  });
}
