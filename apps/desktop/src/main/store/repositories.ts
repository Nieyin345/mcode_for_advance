/**
 * Repository 层的**唯一入口** —— 每个实体一张表的读写，全在这里转出去。
 *
 * ## 为什么拆了
 *
 * 这个文件从前是 3277 行、13 张表挤在一块儿（`LibraryLinkRepo` 和 `ProjectRepo`
 * 中间隔着两千行）。按实体拆进 `./repositories/<实体>.ts` 之后，每个文件只管一张表；
 * **本文件保持原来的导出面一个不少**，所以 90 个消费方（`import { XxxRepo } from
 * "@main/store/repositories.js"`）一行都不用改。
 *
 * ## 改了东西放哪
 *
 * 改某张表 → 去 `./repositories/<实体>.ts`。加新表 → 新文件 + 这里加一行转发。
 *
 * ## 别把逻辑搬进来
 *
 * 本文件只做转发和那一条 `SYSTEM_AUTOMATION_PROJECT_ID`。任何实现都不该住这儿，
 * 否则又会攒回一个大文件。
 */


export { SYSTEM_AUTOMATION_PROJECT_ID } from "./repositories/project.js";

// ── 项目（project）──
export { ProjectRepo } from "./repositories/project.js";

// ── 会话（session）──
export { SessionRepo } from "./repositories/session.js";

// ── 消息（message）──
export { MessageRepo } from "./repositories/message.js";

// ── 设置（setting）──
export { SettingRepo } from "./repositories/setting.js";

// ── 工作流文档（workflow）──
export { WorkflowRepo } from "./repositories/workflow.js";
export type { WorkflowRow } from "./repositories/workflow.js";

// ── 工作流运行存档（workflowRun）──
export { WorkflowRunRepo } from "./repositories/workflowRun.js";
export type { WorkflowRunStatus, WorkflowRunRow } from "./repositories/workflowRun.js";

// ── 场景部署（scene）──
export { SceneDeploymentRepo } from "./repositories/scene.js";
export type { SceneDeploymentRow } from "./repositories/scene.js";

// ── Hook 运行审计（hookRun）──
export { HOOK_RUNS_RETAIN, HookRunRepo } from "./repositories/hookRun.js";
export type { HookRunRow } from "./repositories/hookRun.js";

// ── 资料库条目（library）──
export { LibraryRepo } from "./repositories/library.js";
export type { LibraryListFilter } from "./repositories/library.js";

// ── 资料库集合（collection）──
export { CollectionRepo } from "./repositories/collection.js";

// ── 资料库笔记（note）──
export { NoteRepo } from "./repositories/note.js";

// ── 资料库链接（libraryLink）──
export { LibraryLinkRepo } from "./repositories/libraryLink.js";
