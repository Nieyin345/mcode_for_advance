import type { IpcMain } from "electron";
import {
  IPC,
  CreateProjectSchema,
  DeleteProjectSchema,
  ArchiveProjectSchema,
  SetProjectGroupSchema,
  ReorderProjectsSchema,
  PinProjectSchema,
  RenameProjectSchema,
  DeleteSessionSchema,
  ArchiveSessionSchema,
  PinSessionSchema,
  ProjectSessionsSchema,
  SessionListAllSchema,
  RenameSessionSchema,
  SessionSearchSchema,
  BookmarkSearchSchema,
  UpdateBookmarksSchema,
} from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged, broadcastSessionDeleted } from "@main/lib/sessionSync.js";
import { cancelWorkflowRun } from "@main/orchestration/runner.js";
import { dropBackflow } from "@main/lib/pendingBackflow.js";
import { log } from "@main/lib/logger.js";

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PROJECT_CREATE, (_evt, raw) => {
    const input = CreateProjectSchema.parse(raw);
    const now = Date.now();
    const project: Project = {
      id: uid("proj_"),
      name: input.name,
      path: input.path,
      archived: false,
      pinnedAt: null,
      // Placeholder — ProjectRepo.create overwrites this with MAX+1; the
      // re-read below returns the authoritative row (with the real sort_order).
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    ProjectRepo.create(project);
    const created = ProjectRepo.get(project.id);
    if (!created) throw new Error(`project not found after create: ${project.id}`);
    log.info(`project created: ${created.name} (${created.path})`);
    return { project: created };
  });

  ipcMain.handle(IPC.PROJECT_LIST, () => {
    return { projects: ProjectRepo.list() };
  });

  ipcMain.handle(IPC.PROJECT_SESSIONS, (_evt, raw) => {
    const input = ProjectSessionsSchema.parse(raw);
    const archived = input.archived;
    // The archived bin lists every archived item (no pagination); the active
    // thread list paginates with a default page size of 5.
    const limit = input.limit ?? (archived ? undefined : 5);
    const offset = input.offset ?? 0;
    // `worktree` narrows both the page and the count — the count MUST mirror
    // the list's filter or hasMore counts rows the list never returns.
    const sessions = SessionRepo.listByProject(input.projectId, {
      limit,
      offset,
      archived,
      worktree: input.worktree,
    });
    const total = SessionRepo.countByProject(input.projectId, archived, input.worktree);
    const hasMore = limit !== undefined ? offset + sessions.length < total : false;
    return { sessions, hasMore, total };
  });

  // Cross-project session title search (Ctrl+K unified search palette).
  ipcMain.handle(IPC.SESSION_SEARCH, (_evt, raw) => {
    const input = SessionSearchSchema.parse(raw);
    const sessions = SessionRepo.searchByTitle(input.query, { limit: input.limit });
    return { sessions };
  });

  // Cross-session bookmark search (Ctrl+K unified search palette).
  ipcMain.handle(IPC.SESSION_SEARCH_BOOKMARKS, (_evt, raw) => {
    const input = BookmarkSearchSchema.parse(raw);
    const results = SessionRepo.searchBookmarks(input.query, { limit: input.limit });
    return { results };
  });

  // Hard-delete a project (cascades to its sessions + messages via DB FKs).
  ipcMain.handle(IPC.PROJECT_DELETE, (_evt, raw) => {
    const input = DeleteProjectSchema.parse(raw);
    // ⚠️ 级联会把这个项目下的会话**全部**带走,所以每个会话都欠一遍收尾 ——
    // 和 `SESSION_DELETE` 上那两句注释说的完全是同一件事,不能因为"不是逐条点的"
    // 就省掉:
    //
    //   - `cancelWorkflowRun` —— 图跑到一半时通常正卡在某个节点的问题上(那个问题是以
    //     这个会话的名义问的)。会话被级联删掉之后,答案再也回不来,节点一直阻塞在审批池
    //     的 promise 上,**整张图连同它的 node 会话永远不结束**;
    //   - `dropBackflow` —— 还没被带进下一轮的那段「并回主对话」的内容永远等不到取用
    //     它的那个人。
    //
    // 必须**先**取 id 再删:删完 `ON DELETE CASCADE` 已经把行带走了,那时候再想问
    // "这个项目下原来有哪些会话"就没地方问了(所以加了 `listIdsByProject`)。
    //
    // ⚠️ 循环体里那两句是**分别**被测的:`projects-ipc-smoke` §2 里"只停甲不停乙"
    // 和"乙的待并回内容也在"是两条独立断言,拿掉其中一句只红对应那条。别指望
    // 套件能抓"整块删掉"—— 那要另外加断言,而且循环体删掉时下一句会 SyntaxError,
    // 那是**崩掉**不是**静默变绿**,读起来完全不一样。
    const doomed = SessionRepo.listIdsByProject(input.id);
    let stopped = 0;
    for (const id of doomed) {
      // 返回值这里**不再丢掉**了 —— 它说的正是"这个会话上真有一张图被掐掉"。
      if (cancelWorkflowRun(id)) stopped += 1;
      dropBackflow(id);
    }
    ProjectRepo.delete(input.id);
    // 手机端那边这几条会话也是"刚才还在列表里"的,一条一条告诉它 —— 和
    // `SESSION_DELETE` 同一个做法(那里逐条 `broadcastSessionDeleted`)。
    for (const id of doomed) broadcastSessionDeleted(id);
    // 收尾结果进日志:删项目是一次性把整个项目连带几十条会话抹掉,事后想查
    // "当时有几张图是被从这个项目里掐掉的"只能指望这一行。
    log.info(`project deleted: ${input.id} (${doomed.length} sessions, ${stopped} runs stopped)`);
  });

  // Set a project's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.PROJECT_ARCHIVE, (_evt, raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after archive: ${input.id}`);
    log.info(`project ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { project };
  });

  // Assign a project to a group (left-bar "grouped" view). null removes it.
  ipcMain.handle(IPC.PROJECT_SET_GROUP, (_evt, raw) => {
    const input = SetProjectGroupSchema.parse(raw);
    ProjectRepo.setGroup(input.id, input.group);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after setGroup: ${input.id}`);
    log.info(`project group set: ${input.id} -> ${input.group ?? "(none)"}`);
    return { project };
  });

  // Persist a drag-to-reorder: writes sort_order = index for each id.
  ipcMain.handle(IPC.PROJECT_REORDER, (_evt, raw) => {
    const input = ReorderProjectsSchema.parse(raw);
    ProjectRepo.reorder(input.orderedIds);
    log.info(`projects reordered: ${input.orderedIds.length} items`);
  });

  // Pin/unpin a project. Pinned projects leave the flat list / their group
  // and render in the left bar's pinned section above the project tree
  // (most recent pin first). Mirrors the session pin handler's shape.
  ipcMain.handle(IPC.PROJECT_PIN, (_evt, raw) => {
    const input = PinProjectSchema.parse(raw);
    ProjectRepo.setPinned(input.id, input.pinned);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after pin: ${input.id}`);
    log.info(`project ${input.pinned ? "pinned" : "unpinned"}: ${input.id}`);
    return { project };
  });

  // Rename a project (display-only; the path — the functional key for cwd /
  // path guards — is never touched).
  ipcMain.handle(IPC.PROJECT_RENAME, (_evt, raw) => {
    const input = RenameProjectSchema.parse(raw);
    ProjectRepo.rename(input.id, input.name);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after rename: ${input.id}`);
    log.info(`project renamed: ${input.id} -> "${input.name}"`);
    return { project };
  });

  // Hard-delete a session (cascades to its messages via DB FK).
  ipcMain.handle(IPC.SESSION_DELETE, (_evt, raw) => {
    const input = DeleteSessionSchema.parse(raw);
    // 先把可能还在跑的图停掉。**不能省**:图跑到一半时通常正卡在某个节点的问题上
    // (那个问题是以这个会话的名义问的),会话一删,答案就再也回不来 —— 节点会一直
    // 阻塞在审批池的 promise 上,整张图连同它的 node 会话永远不结束。
    cancelWorkflowRun(input.id);
    // 还没被带进下一轮的那段「并回主对话」的内容也一起清掉 —— 会话都没了,它永远等不到
    // 那个取用它的人(见 `lib/pendingBackflow.ts`)。
    dropBackflow(input.id);
    SessionRepo.delete(input.id);
    // Keep connected mobile clients' session lists in sync.
    broadcastSessionDeleted(input.id);
    log.info(`session deleted: ${input.id}`);
  });

  // Set a session's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.SESSION_ARCHIVE, (_evt, raw) => {
    const input = ArchiveSessionSchema.parse(raw);
    SessionRepo.setArchived(input.id, input.archived);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after archive: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { session };
  });

  // Rename a session (persist a user-edited title).
  ipcMain.handle(IPC.SESSION_RENAME, (_evt, raw) => {
    const input = RenameSessionSchema.parse(raw);
    SessionRepo.updateTitle(input.id, input.title);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after rename: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session renamed: ${input.id} -> "${input.title}"`);
    return { session };
  });

  // Pin/unpin a session. Pinned sessions LEAVE their project's active list
  // and render in the left bar's global pinned section above the project
  // tree (cross-project, most recent pin first). Mirrors the archive
  // handler's shape.
  ipcMain.handle(IPC.SESSION_PIN, (_evt, raw) => {
    const input = PinSessionSchema.parse(raw);
    SessionRepo.setPinned(input.id, input.pinned);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after pin: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session ${input.pinned ? "pinned" : "unpinned"}: ${input.id}`);
    return { session };
  });

  // Replace a session's bookmark list (full-array write from the renderer).
  // The mutating renderer patches its cached row from the returned full
  // session; other clients only get the slim session.changed broadcast (the
  // desktop is single-window, so no other renderer holds the bookmark bucket).
  ipcMain.handle(IPC.SESSION_UPDATE_BOOKMARKS, (_evt, raw) => {
    const input = UpdateBookmarksSchema.parse(raw);
    // `title` is optional in the schema (pre-rename rows parse unchanged);
    // normalize absent → null so the stored domain type stays strict.
    const bookmarks = input.bookmarks.map((b) => ({ ...b, title: b.title ?? null }));
    SessionRepo.updateBookmarks(input.id, bookmarks);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after updateBookmarks: ${input.id}`);
    broadcastSessionChanged(session);
    return { session };
  });

  // All pinned sessions across projects — feeds the left bar's pinned section.
  ipcMain.handle(IPC.SESSION_LIST_PINNED, () => {
    return { sessions: SessionRepo.listPinned() };
  });

  // Cross-project aggregate (stream sidebar's flat "全部项目" list). Same
  // paging contract as PROJECT_SESSIONS: default page 5, hasMore/total. The
  // optional scope filters make a scoped view's hasMore/total count ITS set
  // — without them the bottom "显示更多" button keeps the unfiltered
  // aggregate's count after a project switch.
  ipcMain.handle(IPC.SESSION_LIST_ALL, (_evt, raw) => {
    const input = SessionListAllSchema.parse(raw);
    const limit = input.limit ?? 10;
    const offset = input.offset ?? 0;
    const scope = { projectIds: input.projectIds, worktreeKey: input.worktreeKey };
    const sessions = SessionRepo.listAll({ limit, offset, ...scope });
    const total = SessionRepo.countAll(scope);
    const hasMore = offset + sessions.length < total;
    return { sessions, hasMore, total };
  });
}
