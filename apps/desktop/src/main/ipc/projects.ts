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
  SessionListNodesSchema,
  SessionHasNodesSchema,
  RenameSessionSchema,
  SessionSearchSchema,
  BookmarkSearchSchema,
  UpdateBookmarksSchema,
} from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastProjectsChanged, broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { deleteProjectEverywhere, deleteSessionEverywhere } from "@main/lib/rowDeletion.js";
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
    // 项目行的每一种变动都广播一条 projects.changed,另一端(手机 / 桌面)重拉列表。
    broadcastProjectsChanged();
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
    // 收尾顺序(系统项目守卫 → 逐会话停图 / 清待并回 → 释放运行时 → 删 → 广播)
    // 住在 `lib/rowDeletion.ts`,手机 RPC 调的是同一份。
    const { sessions, stopped } = deleteProjectEverywhere(input.id);
    // 收尾结果进日志:删项目是一次性把整个项目连带几十条会话抹掉,事后想查
    // "当时有几张图是被从这个项目里掐掉的"只能指望这一行。
    log.info(`project deleted: ${input.id} (${sessions} sessions, ${stopped} runs stopped)`);
  });

  // Set a project's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.PROJECT_ARCHIVE, (_evt, raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after archive: ${input.id}`);
    log.info(`project ${input.archived ? "archived" : "restored"}: ${input.id}`);
    broadcastProjectsChanged();
    return { project };
  });

  // Assign a project to a group (left-bar "grouped" view). null removes it.
  ipcMain.handle(IPC.PROJECT_SET_GROUP, (_evt, raw) => {
    const input = SetProjectGroupSchema.parse(raw);
    ProjectRepo.setGroup(input.id, input.group);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after setGroup: ${input.id}`);
    log.info(`project group set: ${input.id} -> ${input.group ?? "(none)"}`);
    broadcastProjectsChanged();
    return { project };
  });

  // Persist a drag-to-reorder: writes sort_order = index for each id.
  ipcMain.handle(IPC.PROJECT_REORDER, (_evt, raw) => {
    const input = ReorderProjectsSchema.parse(raw);
    ProjectRepo.reorder(input.orderedIds);
    log.info(`projects reordered: ${input.orderedIds.length} items`);
    broadcastProjectsChanged();
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
    broadcastProjectsChanged();
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
    broadcastProjectsChanged();
    return { project };
  });

  // Hard-delete a session (cascades to its messages via DB FK).
  ipcMain.handle(IPC.SESSION_DELETE, (_evt, raw) => {
    const input = DeleteSessionSchema.parse(raw);
    // 停图 → 清待并回 → 释放运行时 → 删行 → 广播,顺序与理由见 `lib/rowDeletion.ts`
    // (手机 RPC 调的是同一份)。
    deleteSessionEverywhere(input.id);
    log.info(`session deleted: ${input.id}`);
  });

  // Set a session's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.SESSION_ARCHIVE, (_evt, raw) => {
    const input = ArchiveSessionSchema.parse(raw);
    SessionRepo.setArchived(input.id, input.archived);
    // Archiving puts the thread away: release its runtime too (same leak as
    // delete). Restoring re-binds lazily — the next send calls bindSession
    // with the fresh row, and bind rehydrates the persisted subagent state,
    // so unarchive → reopen → send just works.
    if (input.archived) runtimeManager.dispose(input.id);
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
    // ⚠️ `?? {}` 不是可有可无的。这个 schema 的**入参全是可选的** —— 于是它是
    // `app_api_call` 里的**无参方法**(说明明写「无参方法省略 input」),模型会整个
    // 不传 `raw`。而 `SessionListAllSchema.parse(undefined)` 会报根级
    // `[{path: [], message: "Required"}]`(zod 3.25 对 undefined 输入的空对象),
    // 报错里没有一个字提示"它其实不需要参数"。补空对象:全可选 schema 照常过,与
    // 各 handler 里 `parse(raw ?? {})` 同一条约定(见 ipc/context.ts / ipc/mcp.ts /
    // ipc/library.ts)。渲染端两条调用都显式传 `{offset, limit, ...}` 所以不受影响,
    // 但 `app_api_call`(经 appControl/tools.ts 的 `invokeAppTool`)走的是同一条 handler。
    const input = SessionListAllSchema.parse(raw ?? {});
    const limit = input.limit ?? 10;
    const offset = input.offset ?? 0;
    const scope = { projectIds: input.projectIds, worktreeKey: input.worktreeKey };
    const sessions = SessionRepo.listAll({ limit, offset, ...scope });
    const total = SessionRepo.countAll(scope);
    const hasMore = offset + sessions.length < total;
    return { sessions, hasMore, total };
  });

  // 一个对话里**跑过的工作流步骤**各自的会话("哪一步有会话、它叫什么")。
  //
  // 只读、只按 `parent_session_id` 收口 —— 这是节点会话**唯一**会被列出来的地方
  // (别的查询一律钉 `kind = 'chat'`,所以节点会话不会漏进左边栏)。分页没必要:
  // 一张图是几十格,不是几千。
  ipcMain.handle(IPC.SESSION_LIST_NODES, (_evt, raw) => {
    const input = SessionListNodesSchema.parse(raw);
    return { sessions: SessionRepo.listNodesByParent(input.sessionId) };
  });

  // 这个对话里**有没有一格留下过会话** —— 看板那句"重启之后还回得去"的是非题。
  // 口径与上面那条一字不差(`SessionRepo.hasNodeSessions` 里是同一个 `kind` 收窄)。
  ipcMain.handle(IPC.SESSION_HAS_NODES, (_evt, raw) => {
    const input = SessionHasNodesSchema.parse(raw);
    return { has: SessionRepo.hasNodeSessions(input.sessionId) };
  });
}
