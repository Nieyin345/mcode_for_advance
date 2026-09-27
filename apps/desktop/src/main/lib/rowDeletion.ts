/**
 * 删会话 / 删项目的**唯一一份**收尾顺序 —— 桌面 IPC(`main/ipc/projects.ts`)与
 * 手机 RPC(`main/mobile/mobileRpc.ts`)都调这里。
 *
 * 为什么抽出来:两边原先各写一份,手机那份悄悄漂掉了 —— `project:delete` 没挡系统
 * 项目、没停图、没清待并回内容、也没逐条广播会话删除;`session:delete` 没清待并回
 * 内容。手机上删掉一个正在跑图的项目,那张图就永远卡在节点的问题上不结束。
 * 顺序本身的理由写在各步旁边,改之前先读完。
 */
import { ProjectRepo, SessionRepo, SYSTEM_AUTOMATION_PROJECT_ID } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastProjectsChanged, broadcastSessionDeleted } from "@main/lib/sessionSync.js";
import { cancelWorkflowRun } from "@main/orchestration/runner.js";
import { dropBackflow } from "@main/lib/pendingBackflow.js";

/** 系统项目(后台自动化的外键归属)不能删 —— 调用方据此给出各自的错误形态。 */
export class SystemProjectDeleteError extends Error {
  constructor() {
    super("后台自动化使用的系统项目不能删除");
  }
}

/** Hard-delete one session (messages cascade via FK) and tell every client. */
export function deleteSessionEverywhere(id: string): void {
  // 先把可能还在跑的图停掉。**不能省**:图跑到一半时通常正卡在某个节点的问题上
  // (那个问题是以这个会话的名义问的),会话一删,答案就再也回不来 —— 节点会一直
  // 阻塞在审批池的 promise 上,整张图连同它的 node 会话永远不结束。
  //
  // ⚠️ 这两句必须排在下面 `runtimeManager.dispose` **之前**:dispose 会清掉审批池,
  // 那时候节点还挂在 promise 上,顺序反了就是"图永远不结束"那个 bug 本身。
  cancelWorkflowRun(id);
  // 还没被带进下一轮的那段「并回主对话」的内容也一起清掉 —— 会话都没了,它永远等不到
  // 那个取用它的人(见 `lib/pendingBackflow.ts`)。
  dropBackflow(id);
  // Release the runtime (interrupt + approval/bridge/snapshot cleanup)
  // BEFORE the row goes. Without this the runtime entry leaked for the
  // app's lifetime, and a running turn kept streaming into the dead
  // session, re-inserting orphaned message rows. bindSession re-binds from
  // the fresh row on any future send, so this is safe at any point.
  runtimeManager.dispose(id);
  SessionRepo.delete(id);
  broadcastSessionDeleted(id);
}

/**
 * Hard-delete a project (cascades to its sessions + messages via DB FKs) and
 * tell every client. Returns how many sessions went with it and how many
 * workflow runs were stopped (for the caller's log line).
 */
export function deleteProjectEverywhere(id: string): { sessions: number; stopped: number } {
  // This internal FK owner is not in the project list. Reject even a forged
  // id BEFORE cancelling runs / dropping backflow / disposing runtime state.
  if (id === SYSTEM_AUTOMATION_PROJECT_ID) throw new SystemProjectDeleteError();
  // ⚠️ 级联会把这个项目下的会话**全部**带走,所以每个会话都欠一遍收尾 ——
  // 和 `deleteSessionEverywhere` 上那两句注释说的完全是同一件事,不能因为"不是逐条
  // 点的"就省掉(`cancelWorkflowRun` / `dropBackflow`)。
  //
  // 必须**先**取 id 再删:删完 `ON DELETE CASCADE` 已经把行带走了,那时候再想问
  // "这个项目下原来有哪些会话"就没地方问了(所以加了 `listIdsByProject`)。
  //
  // ⚠️ 循环体里那两句是**分别**被测的:`projects-ipc-smoke` §2 里"只停甲不停乙"
  // 和"乙的待并回内容也在"是两条独立断言,拿掉其中一句只红对应那条。
  const doomed = SessionRepo.listIdsByProject(id);
  let stopped = 0;
  for (const sid of doomed) {
    // 返回值说的正是"这个会话上真有一张图被掐掉"。
    if (cancelWorkflowRun(sid)) stopped += 1;
    dropBackflow(sid);
  }
  // Release every session runtime BEFORE the SQL cascade removes the rows
  // (disposeProject reads them to know what to dispose). Also interrupts a
  // running turn instead of letting it stream into a deleted project.
  runtimeManager.disposeProject(id);
  ProjectRepo.delete(id);
  // 另一端这几条会话也是"刚才还在列表里"的,逐条告诉它;项目列表本身另发一条。
  for (const sid of doomed) broadcastSessionDeleted(sid);
  broadcastProjectsChanged();
  return { sessions: doomed.length, stopped };
}
