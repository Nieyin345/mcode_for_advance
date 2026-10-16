// 左栏会话树的**渲染网** —— `LeftBar` 拆出 `LeftBarParts` 时立的。
//
// 拆分的风险是「搬错的函数体引用了不存在的符号 / 漏了 import / 渲染期才炸」：
// typecheck 能抓名字，抓不到运行期。这里用 `renderToString` 真把每个子单元跑一遍，
// 断言它们真渲染、真输出预期的标题文本。
//
// 判据立在**用户看到的那行字**上（项目名 / 会话标题 / 分组名），不是立在机制上。
// 变异验证：把 `GroupNode` 的 `{groupName}` 改成一个常量，本套必须红。
import "./globals.js";
import { renderToString } from "react-dom/server";
import type { Project, Session } from "@contracts/session";
import {
  ProjectNode,
  SessionRow,
  WorktreeContextMenu,
  GroupNode,
  SortableProjectNode,
  ProjectContextMenu,
  GroupDialog,
} from "../../src/renderer/components/layout/LeftBarParts.js";
import { LeftBar } from "../../src/renderer/components/layout/LeftBar.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// ── 夹具 ──────────────────────────────────────────────────────────────
const project = {
  id: "p1",
  name: "研究项目",
  path: "D:/ws/p1",
  rootPath: "D:/ws/p1",
  color: "a",
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  pinned: false,
  pinnedAt: null,
  sortOrder: 0,
} as unknown as Project;
const session = {
  id: "s1",
  projectId: "p1",
  title: "会话一",
  providerId: "claude",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  archived: false,
  pinned: false,
  worktreePath: null,
  contextSnapshot: null,
} as unknown as Session;
const noop = () => {};

const projectNodeProps = {
  project,
  sessions: [session],
  hasMore: false,
  total: 1,
  expanded: true,
  isActiveProject: true,
  activeSessionId: null,
  runningBySession: {},
  unreadBySession: {},
  onToggleExpand: noop,
  onNewSession: noop,
  onLoadMore: noop,
  onSelectSession: noop,
  onDelete: noop,
  onArchiveSession: noop,
  onDeleteSession: noop,
  onTogglePinSession: noop,
  onNewWorktreeHere: noop,
  worktreeNames: {},
  expandedWorktrees: {},
  onToggleWorktree: noop,
  onNewSessionInWorktree: noop,
  onRemoveWorktree: noop,
  onMergeWorktree: noop,
  onContextWorktree: noop,
  registerNode: noop,
  onContextSession: noop,
  onContextProject: noop,
};

function mustRender(name: string, node: import("react").ReactElement, expectSubstring?: string): string {
  let html = "";
  let err: unknown = null;
  try {
    html = renderToString(node);
  } catch (e) {
    err = e;
  }
  check(
    `${name} 真渲染成功`,
    err === null,
    err ? String(err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : err) : undefined,
  );
  if (err === null && expectSubstring !== undefined) {
    check(`${name} 渲染出预期标记`, html.includes(expectSubstring), html.slice(0, 200));
  }
  return html;
}

console.log("\n[1] LeftBar 主组件（现在 import Parts 里的子块）");
mustRender("LeftBar", <LeftBar />);

console.log("\n[2] 拆出去的子单元逐个真渲染");
mustRender("ProjectNode", <ProjectNode {...projectNodeProps} />, "研究项目");
mustRender(
  "SessionRow",
  <SessionRow
    session={session}
    active={false}
    isRunning={false}
    unreadCount={0}
    onSelect={noop}
    onTogglePin={noop}
    onArchive={noop}
    onDelete={noop}
    onNewWorktreeSession={noop}
    hideWorktreeBadge={false}
    registerNode={noop}
    onContext={noop}
  />,
  "会话一",
);
mustRender(
  "WorktreeContextMenu",
  <WorktreeContextMenu
    ctxMenu={{ worktreePath: "D:/ws/p1/.worktrees/wt1", x: 10, y: 20 }}
    onClose={noop}
    onNewSession={noop}
    onMergeBack={noop}
    onRename={noop}
    onRemove={noop}
  />,
);
mustRender(
  "GroupNode",
  <GroupNode
    groupName="分组一"
    projects={[project]}
    groupColor={null}
    collapsed={false}
    onToggle={noop}
    onRenameGroup={noop}
    onDeleteGroup={noop}
    onSetColor={noop}
    renderProject={(p) => <ProjectNode key={p.id} {...projectNodeProps} project={p} />}
  />,
  "分组一",
);
mustRender(
  "SortableProjectNode",
  <SortableProjectNode projectId="p1">
    <ProjectNode {...projectNodeProps} />
  </SortableProjectNode>,
);
mustRender(
  "ProjectContextMenu",
  <ProjectContextMenu
    ctxMenu={{ project, x: 10, y: 20 }}
    knownGroups={[]}
    onClose={noop}
    onTogglePin={noop}
    onRename={noop}
    onMoveToGroup={noop}
    onCreateGroup={noop}
    onRemoveFromGroup={noop}
    onOpenFolder={noop}
  />,
);
mustRender(
  "GroupDialog",
  <GroupDialog state={{ mode: "create", projectId: "p1" }} onClose={noop} onSubmit={async () => {}} />,
);

console.log(`\nleftbar-render-smoke:${total - failures}/${total} 通过`);
if (failures) process.exit(1);
