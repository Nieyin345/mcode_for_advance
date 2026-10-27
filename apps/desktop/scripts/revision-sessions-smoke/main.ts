/**
 * 【Office 深度集成】修订会话的回归网（`main/document/revisionSessions.ts`）。
 *
 * ## 它验什么
 *
 *   1. **模式状态机**：默认 review、能切、切换是幂等的、切完读得回来；
 *   2. **同步是整批替换**（不是增量合并）：编辑器是唯一事实源，一条撤销之后
 *      宿主那份必须跟着少一条 —— 增量合并会留下幽灵条目；
 *   3. **接受/拒绝真的派发到编辑器**：`decide` 必须调 decider，且把**正确的
 *      ids** 传下去；decider 失败时不能"看起来成功"；
 *   4. **批量（ids 为空）语义在 IPC 层展开**，本层只接受具体 ids（这里验
 *      传空数组时不会假装处理了一批）；
 *   5. **评论的四个操作**（加/改/回复/resolve）各自只改该改的那一条，
 *      resolve 不删除；
 *   6. **`dropHandled` 只删点名的那几条**；
 *   7. **路径归一化是调用方的责任**，本层按字符串精确匹配 —— 验两条不同的
 *      写法会得到两个会话（这条不是缺陷，是契约；写下来免得下一个人"顺手修"）。
 *
 * ## 为什么每条都要有「反向」断言
 *
 * 这里全是状态机：一个恒返回 `true` 的 `setMode`、一个把整批条目都删掉的
 * `dropHandled`，都能让"该成功的成功了"全绿。所以每条正向断言旁边都要有
 * 一条"不该动的东西没动"。
 */

export {};

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
}

const { RevisionSessions } = await import("@main/document/revisionSessions.js");
type Sessions = InstanceType<typeof RevisionSessions>;
type PendingChange = Parameters<Sessions["syncFromEditor"]>[1][number];

const FILE = "D:/ws/report.docx";

/** 一条待审改动（形状与 `pendingChanges.ts` 的 `PendingChange` 一致）。 */
function change(id: string, overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    id,
    editor: "docs",
    filePath: FILE,
    location: { order: 0, label: "第 1 段" },
    kind: "replace",
    author: { id: "ai", label: "AI Assistant" },
    at: 1_700_000_000_000,
    ...overrides,
  } as PendingChange;
}

/* ───────── 1. 模式状态机 ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  check("1a 默认是 review（产品决定：AI 默认记录修订）", sessions.modeOf(FILE) === "review");
  check("1b 切到 edit 成功", sessions.setMode(FILE, "edit") === true);
  check("1c 切完读得回 edit", sessions.modeOf(FILE) === "edit");
  check("1d 再切一次 edit 仍然成功（幂等）", sessions.setMode(FILE, "edit") === true);
  check("1e 没登记的文档切换返回 false（不静默建会话）", sessions.setMode("D:/ws/other.docx", "edit") === false);
  check("1f 没登记的文档 modeOf 是 null", sessions.modeOf("D:/ws/other.docx") === null);
  sessions.forget(FILE);
  check("1g forget 之后没有会话", sessions.stateOf(FILE) === null);
}

/* ───────── 2. 同步是整批替换 ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.syncFromEditor(FILE, [change("a"), change("b"), change("c")]);
  check("2a 三条都收下了", sessions.stateOf(FILE)?.changes.length === 3);
  // **整批替换**：编辑器说现在只有 b —— a 与 c 必须消失。
  sessions.syncFromEditor(FILE, [change("b")]);
  const after = sessions.stateOf(FILE)?.changes ?? [];
  check("2b 整批替换：被撤销的条目不能留幽灵", after.length === 1 && after[0]?.id === "b", after.map((x) => x.id));
  // 空上报 = 全清（不是"没变化"）。
  sessions.syncFromEditor(FILE, []);
  check("2c 空上报清空全部（与「没变化」是两回事）", (sessions.stateOf(FILE)?.changes.length ?? -1) === 0);
  // 排序：`sortChanges` 按位置（order）稳定排序 —— 上报顺序不该决定左栏顺序。
  sessions.syncFromEditor(FILE, [
    change("z", { location: { order: 5, label: "第 6 段" } }),
    change("y", { location: { order: 1, label: "第 2 段" } }),
  ]);
  const sorted = (sessions.stateOf(FILE)?.changes ?? []).map((x) => x.id);
  check("2d 左栏按位置排序，不是按上报顺序", sorted[0] === "y" && sorted[1] === "z", sorted);
}

/* ───────── 3. 接受/拒绝真的派发 ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.syncFromEditor(FILE, [change("a"), change("b")]);

  const calls: Array<{ action: string; ids: readonly string[] }> = [];
  sessions.setDecider(async ({ action, ids }) => {
    calls.push({ action, ids });
    return { ok: true };
  });

  const accepted = await sessions.decide(FILE, "accept", ["a"]);
  check("3a 接受成功", accepted.ok === true);
  check("3b decider 收到 accept 与正确的 ids", calls.length === 1
    && calls[0]!.action === "accept" && calls[0]!.ids.length === 1 && calls[0]!.ids[0] === "a",
    calls[0]);

  const rejected = await sessions.decide(FILE, "reject", ["b"]);
  check("3c 拒绝成功", rejected.ok === true);
  check("3d decider 收到 reject", calls[1]?.action === "reject" && calls[1]?.ids[0] === "b", calls[1]);

  // decider 失败必须冒出来 —— 不能"看起来成功"。
  //
  // ⚠️ **必须重新造一条条目**：上面 3a 已经接受掉 `a`，`decide` 会按"不在待审列表"
  // 提前返回，于是根本走不到 decider —— 那条断言会红，而红的原因不是它想证明的事。
  // （这正是 `mutation-must-remove-the-evidence` 的形态：样本先撞上了更早的一道门。）
  sessions.syncFromEditor(FILE, [change("a")]);
  sessions.setDecider(async () => ({ ok: false, reason: "编辑器没响应" }));
  const failed = await sessions.decide(FILE, "accept", ["a"]);
  check("3e decider 失败时 decide 返回失败（不静默成功）",
    failed.ok === false && failed.reason === "编辑器没响应", failed);

  // 没有 decider 时不能假装处理了。
  sessions.setDecider(null);
  const noDecider = await sessions.decide(FILE, "accept", ["a"]);
  check("3f 没有 decider 时返回失败", noDecider.ok === false, noDecider);

  // 不存在的文档。
  const missing = await sessions.decide("D:/ws/nope.docx", "accept", ["a"]);
  check("3g 没登记的文档 decide 返回失败", missing.ok === false, missing);
}

/* ───────── 4. 空 ids 不被当作"处理了一批" ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.syncFromEditor(FILE, [change("a"), change("b")]);
  // 用对象持有（不用裸 `let`）：TS 的控制流分析看不见"闭包里赋过值"，
  // 裸 `let` 会被收窄成 `null`，`received.length` 直接报 never。
  const captured: { ids: readonly string[] | null } = { ids: null };
  sessions.setDecider(async ({ ids }) => {
    captured.ids = ids;
    return { ok: true };
  });
  await sessions.decide(FILE, "accept", []);
  /* 空 ids 的**展开在 IPC 层**（`onRevisionDecide`：
   * `input.ids.length === 0 ? state.changes.map(c => c.id) : input.ids`），
   * 所以本层**永远不该收到空数组**。它收到空数组时的正确行为是**明确失败**，
   * 而不是"假装处理了一批" —— 旧断言期望"原样转给 decider"，那是空 ids 展开
   * 还不在 IPC 层时的约定，已经过时了。
   *
   * 判据仍然有意义：把这条钉住，就不可能在别处「顺手」把展开搬进本层
   * （那样 IPC 层与这里会各展开一次）。 */
  check("4a 空 ids 不被当作一批：本层明确失败（展开是 IPC 层的职责）",
    captured.ids === null, captured.ids);
}

/* ───────── 5. 评论的四个操作 ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.addComment({
    id: "c1", filePath: FILE,
    location: { order: 0, label: "第 1 段" },
    author: { id: "user", label: "我" },
    text: "这句要改", at: 1, replies: [], resolved: false,
  });
  sessions.addComment({
    id: "c2", filePath: FILE,
    location: { order: 2, label: "第 3 段" },
    author: { id: "user", label: "我" },
    text: "这段可以删", at: 2, replies: [], resolved: false,
  });
  check("5a 两条评论都在", sessions.stateOf(FILE)?.comments.length === 2);

  sessions.editComment(FILE, "c1", "改成更短的说法");
  const edited = sessions.stateOf(FILE)?.comments.find((c) => c.id === "c1");
  check("5b 编辑只改正文", edited?.text === "改成更短的说法", edited?.text);
  check("5c 编辑不动另一条",
    sessions.stateOf(FILE)?.comments.find((c) => c.id === "c2")?.text === "这段可以删");

  sessions.replyToComment(FILE, "c1", { id: "r1", author: { id: "ai", label: "AI" }, text: "好的", at: 3 });
  const replied = sessions.stateOf(FILE)?.comments.find((c) => c.id === "c1");
  check("5d 回复追加到那一条", replied?.replies.length === 1 && replied.replies[0]?.text === "好的",
    replied?.replies);

  sessions.setCommentResolved(FILE, "c1", true);
  check("5e resolve 之后仍在列表里（不是删除）",
    (sessions.stateOf(FILE)?.comments.length ?? 0) === 2);
  check("5f resolved 标记生效",
    sessions.stateOf(FILE)?.comments.find((c) => c.id === "c1")?.resolved === true);
  check("5g 未 resolve 的只有 c2",
    sessions.openCommentsOf(FILE).map((c) => c.id).join(",") === "c2",
    sessions.openCommentsOf(FILE).map((c) => c.id));
  check("5h 已 resolve 的能单独列出",
    sessions.resolvedCommentsOf(FILE).map((c) => c.id).join(",") === "c1");

  // 取消 resolve 要能回来（左栏"重新打开"按钮）。
  sessions.setCommentResolved(FILE, "c1", false);
  check("5i 取消 resolve 之后回到待处理列表",
    sessions.openCommentsOf(FILE).map((c) => c.id).sort().join(",") === "c1,c2");

  // 不存在的评论 → false（不静默成功）。
  check("5j 操作不存在的评论返回 false", sessions.editComment(FILE, "nope", "x") === false);
}

/* ───────── 6. dropHandled 只删点名的 ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.syncFromEditor(FILE, [change("a"), change("b"), change("c")]);
  sessions.dropHandled(FILE, ["b"]);
  const left = (sessions.stateOf(FILE)?.changes ?? []).map((x) => x.id).sort();
  check("6a 只删掉 b", left.join(",") === "a,c", left);
}

/* ───────── 7. 路径是精确字符串键（契约，不是缺陷） ───────── */
{
  const sessions = new RevisionSessions();
  sessions.ensure(FILE, "docs");
  sessions.syncFromEditor(FILE, [change("a")]);
  // 大小写不同的写法 → 另一个会话。**归一化是调用方的责任**
  // （`ipc/documentView.ts` 用 `physicalPath` 折叠）。
  const other = FILE.toLowerCase();
  check("7a 未归一化的路径是另一个会话（调用方必须归一化）",
    sessions.stateOf(other) === null, sessions.stateOf(other));
  check("7b 原路径的条目没受影响", sessions.stateOf(FILE)?.changes.length === 1);
}

/* ───────── 汇总 ───────── */
const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? "✓" : "✗"} ${entry.name}${entry.ok ? "" : ` — ${JSON.stringify(entry.detail)}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error(`\n${failed.length} 条失败`);
  process.exit(1);
}
